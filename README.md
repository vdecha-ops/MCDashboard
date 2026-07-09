# Telecom Data Usage Dashboard (Node.js)

A small Node/Express app that signs in to SOTI MobiControl's REST API, then lets
the signed-in user upload a MobiControl "Telecom Data Usage" report export and
explore data consumption by device and application. The report is parsed
entirely in the browser (PapaParse) — it's never uploaded to this server. Each
device in the report is cross-referenced against live MobiControl data (fetched
once via `/api/device-lookup`) to show the assigned user's email and device
group path instead of the raw device name.

## How it works

MobiControl's API uses OAuth2 with two sets of credentials:

- **API client (Client ID / Client Secret)** — identifies your integration, set once as environment variables.
- **User credentials (username / password)** — a MobiControl administrator account, entered by whoever uses the app.

On login the app calls `POST {server}/MobiControl/api/token` (Basic auth with
the API client, body `grant_type=password&username=...&password=...`) to get
an access token, kept only in the signed session cookie (never written to
disk). The password is never stored or logged.

After login, `/dashboard` renders the upload page. Its client-side script:

1. Calls `GET /api/device-lookup` (server-side, using the session's access
   token) to fetch every device's name, "User Email" custom attribute value,
   and group Path.
2. Parses the uploaded CSV with PapaParse, locates the real header row (the
   MobiControl export has a few title/summary rows above it, and the header's
   columns land at different indices depending on merged cells in the source
   spreadsheet — the app searches for the row containing both "Device Name"
   and "Volume" instead of assuming fixed column positions).
3. Aggregates usage by device and by application, joins each device's rows to
   the `/api/device-lookup` result by name, and renders summary stats, two
   Chart.js charts (top devices by volume, volume by application), a
   multi-select device-group filter, and a table.

## Where the user email comes from

Each device's assigned user email lives in MobiControl as a per-device
**Custom Attribute** (Console > Data > Custom Attributes) named "User Email"
on this deployment — not a built-in device field. `extractCustomAttributeEmail()`
in `server.js` reads the device's `CustomAttributes` array and matches any
attribute whose name contains "email" (case-insensitive), so it isn't tied to
that exact label if a deployment names it differently.

## Report format

Expects a MobiControl "Telecom Data Usage" report export (CSV). Recognized
columns (matched by header text, not position): `Date & Time`, `Device Name`,
`Upload (KB)`, `Download (KB)`, `Volume (KB)`, `Type`, `Roaming`, `Carrier`,
`Application ID`. Only `Device Name` and `Volume` are required to be present.

## Run locally

Requires Node.js 18+ (for built-in `fetch`).

1. In the MobiControl console, go to **Services > API Client** and create a new API client (on-premises servers can alternatively use `MCAdmin.exe APIClientAdd`). Copy the Client ID and Client Secret.
2. Install dependencies:
   ```
   npm install
   ```
3. Copy `.env.example` to `.env` and fill in `MC_SERVER_URL`, `MC_CLIENT_ID`, `MC_CLIENT_SECRET`, and a random `SESSION_SECRET`.
4. Start the app:
   ```
   npm start
   ```
5. Open `http://localhost:3000`, sign in, then upload a Telecom Data Usage CSV export.

## Deploy to Render (free tier)

1. Push this folder to a GitHub (or GitLab) repository.
2. In the Render dashboard, choose **New > Web Service** and connect the repo.
   - Alternatively, if you commit `render.yaml`, use **New > Blueprint** to auto-configure the service below.
3. Configure the service:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Under **Environment**, add these variables (do *not* put real secrets in `.env` in the repo):
   - `MC_SERVER_URL`
   - `MC_CLIENT_ID`
   - `MC_CLIENT_SECRET`
   - `SESSION_SECRET` (any long random string)
5. Deploy. Render assigns a public `https://<your-service>.onrender.com` URL automatically and sets `PORT` for you.

Note: Render's free web services spin down after periods of inactivity and take a few seconds to wake back up on the next request — expected behavior on the free tier, not a bug. Sessions are also in-memory only, so a redeploy or restart signs everyone out.

## Notes

- Device field names can vary slightly between MobiControl versions; `pick()` in `server.js` tries several common variants for device name/path. Extend `DEVICE_NAME_FIELDS` if a server uses a different field.
- If your on-premises server uses a self-signed certificate, the built-in `fetch` will reject it. The simplest (insecure) workaround is setting `NODE_TLS_REJECT_UNAUTHORIZED=0` as an environment variable — only do this if you understand the risk, and prefer fixing the certificate instead.
- `/api/device-lookup` pages through `/devices` using `skip`/`take` (MobiControl's documented pagination params for that endpoint).
