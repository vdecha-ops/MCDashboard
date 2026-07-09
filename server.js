/**
 * MobiControl Device Group Viewer (Node.js / Express)
 * -----------------------------------------------------
 * Signs in to the SOTI MobiControl REST API using an API client (Client ID /
 * Client Secret, set via environment variables) plus a MobiControl
 * administrator username/password (entered at login), and lists the
 * server's device groups.
 *
 * Auth flow (SOTI MobiControl REST API, Resource Owner / password grant):
 *   1. POST {server}/MobiControl/api/token
 *        Header: Authorization: Basic base64(client_id:client_secret)
 *        Body:   grant_type=password&username=...&password=...
 *        -> { access_token, token_type, expires_in }
 *   2. GET {server}/MobiControl/api/devicegroups
 *        Header: Authorization: Bearer {access_token}
 *        -> list of device group objects
 *
 * Uses Node's built-in fetch (Node 18+) -- no HTTP client dependency needed.
 */

const path = require('path');
const express = require('express');
const session = require('express-session');
const config = require('./config');

const app = express();

// Render (like Heroku/Railway) terminates TLS at a reverse proxy and forwards
// plain HTTP to the app. Without this, Express never sees the connection as
// secure, so a "secure" session cookie is silently dropped and every login
// appears to succeed but the session never sticks on the next request.
app.set('trust proxy', 1);

// Lightweight request logging so every hit shows up in Render logs, even
// ones that never reach MobiControl (useful for debugging "nothing happens").
app.use((req, res, next) => {
  console.log(`[req] ${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // 'auto' sets Secure only when the (proxy-forwarded) request is HTTPS,
      // which now works correctly thanks to 'trust proxy' above.
      secure: 'auto',
    },
  })
);

function apiBase() {
  return config.MC_SERVER_URL.replace(/\/+$/, '') + '/MobiControl/api';
}

async function getAccessToken(username, password) {
  const basic = Buffer.from(`${config.MC_CLIENT_ID}:${config.MC_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'password', username, password });

  const resp = await fetch(`${apiBase()}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'MobiControl-Device-Groups-Viewer/1.0',
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    const headerDump = Array.from(resp.headers.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    console.error(
      `[token] ${resp.status} ${resp.statusText} from ${apiBase()}/token :: headers[${headerDump}] :: body[${bodyText.slice(0, 500)}]`
    );
    const err = new Error(`Token request failed with status ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

async function fetchDeviceGroups(accessToken) {
  const resp = await fetch(`${apiBase()}/devicegroups`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'MobiControl-Device-Groups-Viewer/1.0',
    },
  });

  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    const headerDump = Array.from(resp.headers.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    console.error(
      `[devicegroups] ${resp.status} ${resp.statusText} from ${apiBase()}/devicegroups :: headers[${headerDump}] :: body[${bodyText.slice(0, 500)}]`
    );
    const err = new Error(`Device groups request failed with status ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

// MobiControl's /devicegroups list doesn't include a device count, and the
// /devices endpoint ignores every "filter by group" query param we tried
// (deviceGroupId, groupId, etc. -- all silently returned the same unfiltered
// list). What DOES work: each device object has its own "Path" field that
// exactly matches its group's Path, and /devices supports real pagination
// via "skip" and "take" (confirmed: skip=50&take=100 returned the remaining
// 84 of 134 total devices). So we page through every device once and count
// them per exact Path match -- far cheaper than one API call per group too.
async function fetchAllDevices(accessToken) {
  const pageSize = 200;
  let skip = 0;
  let total = Infinity;
  const all = [];

  while (skip < total) {
    const resp = await fetch(`${apiBase()}/devices?skip=${skip}&take=${pageSize}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'MobiControl-Device-Groups-Viewer/1.0',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) {
      throw new Error(`devices?skip=${skip}&take=${pageSize} failed with status ${resp.status}`);
    }
    const totalCountHeader = resp.headers.get('x-total-count');
    if (totalCountHeader) total = parseInt(totalCountHeader, 10);

    const data = await resp.json();
    const items = Array.isArray(data) ? data : data.Items || data.items || data.Data || data.data || [];
    all.push(...items);

    if (items.length === 0) break; // safety net against an infinite loop
    skip += items.length;
  }

  return all;
}

// Counts devices per exact group Path (devices directly in that group; does
// not roll up sub-group counts into their parents).
function countDevicesByPath(devices) {
  const counts = new Map();
  for (const device of devices) {
    const p = device && device.Path;
    if (!p) continue;
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  return counts;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return '';
}

// MobiControl field casing/shape can vary by version; normalize to a flat object.
function normalizeGroup(g) {
  if (typeof g !== 'object' || g === null) {
    return { name: String(g), path: '', id: '', parentId: '', deviceCount: '' };
  }
  return {
    name: pick(g, ['Name', 'name', 'GroupName', 'DisplayName']),
    path: pick(g, ['Path', 'path', 'FullPath', 'fullPath']),
    id: pick(g, ['ReferenceId', 'referenceId', 'Id', 'id', 'ID', 'GroupID', 'DeviceGroupId']),
    parentId: pick(g, ['ParentId', 'parentId', 'ParentID', 'ParentGroupId']),
    deviceCount: pick(g, ['DeviceCount', 'deviceCount', 'Count']),
  };
}

function httpErrorMessage(status) {
  if (status === 400 || status === 401) return 'Invalid username, password, or API client credentials.';
  if (status === 403) return 'This account is not authorized to call the MobiControl API.';
  if (status) return `MobiControl server returned an error (HTTP ${status}).`;
  return 'MobiControl server returned an unexpected error.';
}

app.get('/', (req, res) => {
  if (req.session.accessToken) return res.redirect('/groups');
  res.render('index', { error: null, serverUrl: config.MC_SERVER_URL });
});

app.post('/login', async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';

  if (!username || !password) {
    return res.render('index', {
      error: 'Username and password are required.',
      serverUrl: config.MC_SERVER_URL,
    });
  }

  try {
    const tokenData = await getAccessToken(username, password);
    req.session.accessToken = tokenData.access_token;
    req.session.username = username;
    res.redirect('/groups');
  } catch (err) {
    const msg = err.status ? httpErrorMessage(err.status) : `Could not reach MobiControl server: ${err.message}`;
    res.render('index', { error: msg, serverUrl: config.MC_SERVER_URL });
  }
});

app.get('/groups', async (req, res) => {
  if (!req.session.accessToken) return res.redirect('/');

  try {
    const data = await fetchDeviceGroups(req.session.accessToken);
    const items = Array.isArray(data) ? data : data.Items || data.items || data.Data || data.data || [];
    const deviceGroups = items.map(normalizeGroup);

    try {
      const devices = await fetchAllDevices(req.session.accessToken);
      const counts = countDevicesByPath(devices);
      for (const group of deviceGroups) {
        group.deviceCount = group.path ? counts.get(group.path) || 0 : '';
      }
    } catch (err) {
      console.error(`[deviceCount] failed to load device counts: ${err.message}`);
      for (const group of deviceGroups) {
        group.deviceCount = '?';
      }
    }

    res.render('groups', { error: null, deviceGroups, username: req.session.username });
  } catch (err) {
    if (err.status === 401) {
      return req.session.destroy(() => res.redirect('/'));
    }
    const msg = err.status ? httpErrorMessage(err.status) : `Could not reach MobiControl server: ${err.message}`;
    res.render('groups', { error: msg, deviceGroups: [], username: req.session.username });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.listen(config.PORT, () => {
  console.log(`Server running on port ${config.PORT}`);
});

module.exports = { apiBase, normalizeGroup, httpErrorMessage, pick };
