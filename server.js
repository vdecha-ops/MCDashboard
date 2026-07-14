/**
 * MobiControl Telecom Data Usage Dashboard (Node.js / Express)
 * -----------------------------------------------------
 * Signs in to the SOTI MobiControl REST API using an API client (Client ID /
 * Client Secret, set via environment variables) plus a MobiControl
 * administrator username/password (entered at login), then lets the signed-in
 * user upload a MobiControl "Telecom Data Usage" report export. The report is
 * parsed entirely client-side (nothing is uploaded to this server) and cross-
 * referenced against live device data -- pulled once via GET /api/device-lookup
 * -- to show each device's assigned user email (from a "User Email" custom
 * attribute) and device group path alongside its data usage.
 *
 * Auth flow (SOTI MobiControl REST API, Resource Owner / password grant):
 *   1. POST {server}/MobiControl/api/token
 *        Header: Authorization: Basic base64(client_id:client_secret)
 *        Body:   grant_type=password&username=...&password=...
 *        -> { access_token, token_type, expires_in }
 *   2. GET {server}/MobiControl/api/devices
 *        Header: Authorization: Bearer {access_token}
 *        -> paginated list of device objects (includes CustomAttributes)
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
                'User-Agent': 'MobiControl-Telecom-Usage-Dashboard/1.0',
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

// Pages through every device once (confirmed pagination params: skip/take;
// MobiControl's "filter by group" query params on /devices don't actually
// filter server-side, so we always fetch the full list).
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
                          'User-Agent': 'MobiControl-Telecom-Usage-Dashboard/1.0',
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

function pick(obj, keys) {
    for (const k of keys) {
          if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    }
    return '';
}

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

const PHONE_FIELD_CANDIDATES = [
    'PhoneNumber', 'phoneNumber', 'CellularPhoneNumber', 'cellularPhoneNumber',
    'SimPhoneNumber', 'simPhoneNumber', 'MobileNumber', 'mobileNumber',
    'MSISDN', 'msisdn', 'PhoneNo', 'phoneNo',
  ];

// Best-effort phone number extraction, mirroring extractCustomAttributeEmail
// above: try common built-in field names first, then fall back to any
// custom attribute whose name suggests a phone number (English or Thai
// label). Not confirmed present on every MobiControl deployment -- used by
// the "AIS Data Usage Report Analysis" page to cross-reference devices
// against the AIS billing report, which only has phone numbers, not device
// names or emails. Returns null (rendered as "--") if nothing matches.
function extractCustomAttributePhone(d) {
    const direct = pick(d, PHONE_FIELD_CANDIDATES);
    if (direct) return String(direct).trim();

  const attrs = Array.isArray(d.CustomAttributes)
      ? d.CustomAttributes
        : Array.isArray(d.customAttributes)
        ? d.customAttributes
          : [];
    for (const attr of attrs) {
          if (!attr) continue;
          const name = String(attr.Name || attr.name || '');
          const nameLower = name.toLowerCase();
          if (
                  nameLower.includes('phone') ||
                  name.includes('เบอร์') ||
                  name.includes('โทรศัพท์') ||
                  name.includes('มือถือ')
                ) {
                  const value = attr.Value !== undefined ? attr.Value : attr.value;
                  if (value !== undefined && value !== null && String(value).trim() !== '') {
                            return String(value).trim();
                  }
          }
    }
    return null;
}

// Flat, JSON-friendly shape used by /api/device-lookup for client-side
// enrichment of an uploaded usage report (matched there by device name).
function normalizeDeviceForLookup(d) {
    if (typeof d !== 'object' || d === null) return null;
    const name = pick(d, DEVICE_NAME_FIELDS);
    if (!name) return null;
    return {
          name,
          email: extractCustomAttributeEmail(d),
          path: pick(d, ['Path', 'path', 'FullPath', 'fullPath']),
    };
}

// Extended shape used by /api/device-status (the "AIS Data Usage Report
// Analysis" page). CellularCarrier / CellularSignalStrength /
// CellularTechnology / InRoaming were confirmed present on this MobiControl
// server's device objects during an earlier live API walkthrough. The
// remaining status fields (connection/last-seen, battery, model, OS, phone
// number) are not confirmed for this deployment -- they're looked up
// defensively across the common MobiControl field-name variants via pick(),
// and simply render as "--" on the page if none of the candidate names
// exist.
function normalizeDeviceForStatus(d) {
    if (typeof d !== 'object' || d === null) return null;
    const name = pick(d, DEVICE_NAME_FIELDS);
    if (!name) return null;

  const lastSeenRaw = pick(d, [
        'LastConnectionTime', 'lastConnectionTime',
        'LastConnectionUtc', 'lastConnectionUtc',
        'LastCheckInTime', 'lastCheckInTime',
        'LastSeen', 'lastSeen',
        'LastCommunicationTime', 'lastCommunicationTime',
      ]);
    const connectedRaw = pick(d, ['IsConnected', 'isConnected', 'Connected', 'connected']);

  return {
        name,
        email: extractCustomAttributeEmail(d),
        phone: extractCustomAttributePhone(d),
        path: pick(d, ['Path', 'path', 'FullPath', 'fullPath']),
        model: pick(d, ['Model', 'model', 'DeviceModel', 'deviceModel']),
        os: pick(d, ['OSVersion', 'osVersion', 'OperatingSystem', 'operatingSystem', 'Platform', 'platform']),
        battery: pick(d, ['BatteryLevel', 'batteryLevel', 'Battery', 'battery']),
        connected: connectedRaw === true || connectedRaw === 'true' || connectedRaw === 1 ? true
                : (connectedRaw === false || connectedRaw === 'false' || connectedRaw === 0 ? false : null),
        lastSeen: lastSeenRaw || null,
        carrier: pick(d, ['CellularCarrier', 'cellularCarrier']),
        signal: pick(d, ['CellularSignalStrength', 'cellularSignalStrength']),
        technology: pick(d, ['CellularTechnology', 'cellularTechnology']),
        roaming: pick(d, ['InRoaming', 'inRoaming']),
  };
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
    if (req.session.accessToken) return res.redirect('/menu');
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
                 res.redirect('/menu');
           } catch (err) {
                 const msg = err.status ? httpErrorMessage(err.status) : `Could not reach MobiControl server: ${err.message}`;
                 res.render('index', { error: msg, serverUrl: config.MC_SERVER_URL });
           }
});

// Landing page after login: card-based menu picking which tool to open.
app.get('/menu', requireLogin, (req, res) => {
    res.render('menu', { username: req.session.username });
});

app.get('/dashboard', requireLogin, (req, res) => {
    res.render('dashboard', { username: req.session.username });
});

app.get('/device-status', requireLogin, (req, res) => {
    res.render('device-status', { username: req.session.username });
});

// JSON lookup of { name, email, path } per device, fetched by the dashboard
// page's client-side script once on load and used to enrich the uploaded
// report (which only has Device Name) with user email and group path. The
// report itself never reaches this server -- it's parsed in the browser.
app.get('/api/device-lookup', requireLogin, async (req, res) => {
    try {
          const rawDevices = await fetchAllDevices(req.session.accessToken);
          const devices = rawDevices.map(normalizeDeviceForLookup).filter(Boolean);
          res.json({ devices });
    } catch (err) {
          if (err.status === 401) {
                  return res.status(401).json({ error: 'Session expired. Please sign in again.' });
          }
          res.status(500).json({ error: err.message });
    }
});

// JSON lookup of extended per-device status (email/phone/path/model/OS/
// battery/connection/cellular fields), used by the AIS Data Usage Report
// Analysis page. Same once-per-page-load fetch pattern as
// /api/device-lookup.
app.get('/api/device-status', requireLogin, async (req, res) => {
    try {
          const rawDevices = await fetchAllDevices(req.session.accessToken);
          const devices = rawDevices.map(normalizeDeviceForStatus).filter(Boolean);
          res.json({ devices });
    } catch (err) {
          if (err.status === 401) {
                  return res.status(401).json({ error: 'Session expired. Please sign in again.' });
          }
          res.status(500).json({ error: err.message });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

app.listen(config.PORT, () => {
    console.log(`Server running on port ${config.PORT}`);
});

module.exports = {
    apiBase,
    normalizeDeviceForLookup,
    normalizeDeviceForStatus,
    extractCustomAttributeEmail,
    extractCustomAttributePhone,
    httpErrorMessage,
    pick,
};
