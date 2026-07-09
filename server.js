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
const multer = require('multer');
const config = require('./config');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

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

// Every device id-ish field we've seen across MobiControl versions, in the
// order we prefer to display/match on. The CSV import matches a row's device
// id against ALL of these fields (whichever one the customer's CSV happens
// to use), so we don't have to guess a single "correct" field up front.
const DEVICE_ID_FIELDS = [
  'DeviceId', 'deviceId', 'DeviceID', 'Id', 'id', 'ID',
  'Udid', 'udid', 'UDID', 'ReferenceId', 'referenceId',
  'SerialNumber', 'serialNumber', 'Imei', 'imei', 'IMEI',
];

const DEVICE_NAME_FIELDS = [
  'Alias', 'alias', 'DeviceName', 'deviceName', 'Name', 'name', 'FriendlyName', 'friendlyName',
];

// This MobiControl server stores the assigned user's email as a per-device
// Custom Attribute (Console > Data > Custom Attributes), not a built-in
// field -- confirmed via a raw /devices dump: each device has a
// "CustomAttributes" array of { Name, Value, DataType } entries, one of
// which is named "User Email". Custom attribute names are configurable per
// deployment, so we match loosely (case-insensitive, "email" anywhere in
// the name) rather than hardcoding the exact label.
function extractCustomAttributeEmail(d) {
  const attrs = Array.isArray(d.CustomAttributes)
    ? d.CustomAttributes
    : Array.isArray(d.customAttributes)
      ? d.customAttributes
      : [];
  for (const attr of attrs) {
    if (!attr) continue;
    const name = String(attr.Name || attr.name || '').toLowerCase();
    if (name.includes('email') || name.includes('e-mail')) {
      const value = attr.Value !== undefined ? attr.Value : attr.value;
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return String(value).trim();
      }
    }
  }
  return null;
}

// MobiControl field casing/shape can vary by version; normalize to a flat object.
function normalizeDevice(d) {
  if (typeof d !== 'object' || d === null) {
    return { name: String(d), path: '', ids: {}, attributeEmail: null };
  }
  const ids = {};
  for (const field of DEVICE_ID_FIELDS) {
    if (d[field] !== undefined && d[field] !== null && d[field] !== '') {
      ids[field] = String(d[field]);
    }
  }
  return {
    name: pick(d, DEVICE_NAME_FIELDS) || '(unnamed device)',
    path: pick(d, ['Path', 'path', 'FullPath', 'fullPath']),
    ids,
    attributeEmail: extractCustomAttributeEmail(d),
  };
}

function normalizeKey(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

// Looks up an email for a device by checking every id-ish field the device
// has against the imported CSV map (keyed by normalized device id string).
function findMappedEmail(device, emailMap) {
  if (!emailMap || emailMap.size === 0) return null;
  for (const field of DEVICE_ID_FIELDS) {
    const raw = device.ids[field];
    if (!raw) continue;
    const hit = emailMap.get(normalizeKey(raw));
    if (hit) return hit;
  }
  return null;
}

// --- CSV import (device id -> user email) --------------------------------
// Kept in memory only (mirrors the existing in-memory session store): simple,
// no extra storage/dependency, and easy to re-import after a restart. A
// dedicated persistence layer (DB/file) could replace this if needed later.
let deviceEmailMap = new Map();
let lastImport = null; // { filename, rowCount, mappedCount, importedAt }

// Very small CSV line splitter: handles plain commas and "quoted, fields".
// Good enough for a two-column DeviceId/Email export; not a full RFC 4180
// parser (no embedded newlines inside quotes).
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function parseDeviceEmailCsv(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { map: new Map(), rowCount: 0 };

  let idCol = 0;
  let emailCol = 1;
  let startRow = 0;

  const firstCells = parseCsvLine(lines[0]).map((c) => c.toLowerCase().replace(/[\s_]/g, ''));
  const idHeaderIdx = firstCells.findIndex((c) => /(deviceid|device|udid|serial|imei)/.test(c) && !/mail/.test(c));
  const emailHeaderIdx = firstCells.findIndex((c) => /mail/.test(c));
  if (idHeaderIdx !== -1 && emailHeaderIdx !== -1) {
    idCol = idHeaderIdx;
    emailCol = emailHeaderIdx;
    startRow = 1; // first line was a real header row, skip it
  }

  const map = new Map();
  let rowCount = 0;
  for (let i = startRow; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const id = cells[idCol];
    const email = cells[emailCol];
    if (!id || !email) continue;
    map.set(normalizeKey(id), email.trim());
    rowCount++;
  }
  return { map, rowCount };
}

function httpErrorMessage(status) {
  if (status === 400 || status === 401) return 'Invalid username, password, or API client credentials.';
  if (status === 403) return 'This account is not authorized to call the MobiControl API.';
  if (status) return `MobiControl server returned an error (HTTP ${status}).`;
  return 'MobiControl server returned an unexpected error.';
}

function requireLogin(req, res, next) {
  if (!req.session.accessToken) return res.redirect('/');
  next();
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

app.get('/groups', requireLogin, async (req, res) => {
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

// All devices on the MobiControl server, with an optional multi-select
// filter by device group (matched on the group's exact Path, same approach
// used for the per-group counts on /groups) and the device's display name
// swapped for its user email when one is available. Email source priority:
// 1) the device's own "User Email" custom attribute (live from MobiControl),
// 2) the imported CSV mapping (fallback, for devices missing that attribute),
// 3) the MobiControl device name (last resort).
app.get('/devices', requireLogin, async (req, res) => {
  const selectedGroups = req.query.groups
    ? (Array.isArray(req.query.groups) ? req.query.groups : [req.query.groups])
    : [];

  try {
    const groupData = await fetchDeviceGroups(req.session.accessToken);
    const groupItems = Array.isArray(groupData)
      ? groupData
      : groupData.Items || groupData.items || groupData.Data || groupData.data || [];
    const deviceGroups = groupItems.map(normalizeGroup).filter((g) => g.path);

    const rawDevices = await fetchAllDevices(req.session.accessToken);
    let devices = rawDevices.map((d) => {
      const norm = normalizeDevice(d);
      const csvEmail = findMappedEmail(norm, deviceEmailMap);
      const email = norm.attributeEmail || csvEmail;
      return {
        display: email || norm.name,
        mapped: Boolean(email),
        source: norm.attributeEmail ? 'attribute' : csvEmail ? 'csv' : null,
        name: norm.name,
        path: norm.path,
        id: norm.ids.DeviceId || norm.ids.Id || norm.ids.Udid || norm.ids.ReferenceId || Object.values(norm.ids)[0] || '',
      };
    });

    if (selectedGroups.length > 0) {
      const selectedSet = new Set(selectedGroups);
      devices = devices.filter((d) => selectedSet.has(d.path));
    }

    res.render('devices', {
      error: null,
      devices,
      deviceGroups,
      selectedGroups,
      username: req.session.username,
      lastImport,
    });
  } catch (err) {
    if (err.status === 401) {
      return req.session.destroy(() => res.redirect('/'));
    }
    const msg = err.status ? httpErrorMessage(err.status) : `Could not reach MobiControl server: ${err.message}`;
    res.render('devices', {
      error: msg,
      devices: [],
      deviceGroups: [],
      selectedGroups,
      username: req.session.username,
      lastImport,
    });
  }
});

app.get('/devices/import', requireLogin, (req, res) => {
  res.render('import', { error: null, success: null, lastImport, username: req.session.username });
});

function uploadErrorMessage(err) {
  if (err.code === 'LIMIT_FILE_SIZE') return 'That file is too large (max 25 MB). Export a smaller CSV or split it into parts.';
  if (err.code === 'LIMIT_UNEXPECTED_FILE') return 'Unexpected upload field. Please use the file picker on this page.';
  return `Could not process the uploaded file: ${err.message}`;
}

app.post('/devices/import', requireLogin, (req, res) => {
  upload.single('csvFile')(req, res, (err) => {
    if (err) {
      console.error(`[import] upload failed: ${err.message}`);
      return res.render('import', {
        error: uploadErrorMessage(err),
        success: null,
        lastImport,
        username: req.session.username,
      });
    }
    handleCsvImport(req, res);
  });
});

function handleCsvImport(req, res) {
  if (!req.file) {
    return res.render('import', {
      error: 'Please choose a CSV file to upload.',
      success: null,
      lastImport,
      username: req.session.username,
    });
  }

  try {
    const text = req.file.buffer.toString('utf-8');
    const { map, rowCount } = parseDeviceEmailCsv(text);
    if (map.size === 0) {
      return res.render('import', {
        error: 'No valid rows found. Expect a CSV with a device ID column and an email column.',
        success: null,
        lastImport,
        username: req.session.username,
      });
    }

    deviceEmailMap = map;
    lastImport = {
      filename: req.file.originalname,
      rowCount,
      mappedCount: map.size,
      importedAt: new Date().toISOString(),
    };

    res.render('import', {
      error: null,
      success: `Imported ${map.size} device-to-email mapping(s) from "${req.file.originalname}".`,
      lastImport,
      username: req.session.username,
    });
  } catch (err) {
    res.render('import', {
      error: `Could not parse CSV: ${err.message}`,
      success: null,
      lastImport,
      username: req.session.username,
    });
  }
}

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.listen(config.PORT, () => {
  console.log(`Server running on port ${config.PORT}`);
});

module.exports = { apiBase, normalizeGroup, normalizeDevice, findMappedEmail, parseDeviceEmailCsv, httpErrorMessage, pick };
