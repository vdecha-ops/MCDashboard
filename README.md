# MobiControl Device Groups Viewer (Node.js)

A small Node/Express app that signs in to SOTI MobiControl's REST API and
lists the server's device groups and devices. No Python required — built to
deploy on Render's free web service tier.

## How it works

MobiControl's API uses OAuth2 with two sets of credentials:

- **API client (Client ID / Client Secret)** — identifies your integration, set once as environment variables.
- **User credentials (username / password)** — a MobiControl administrator account, entered by whoever uses the app.

On login the app calls:

1. `POST {server}/MobiControl/api/token` with `Authorization: Basic base64(client_id:client_secret)` and body `grant_type=password&username=...&password=...` to get an access token.
2. `GET {server}/MobiControl/api/devicegroups` with `Authorization: Bearer {access_token}` to list device groups.

The access token is kept only in the signed session cookie (server-side), never written to disk. The password is never stored or logged.

## Pages

- **`/groups`** — device groups with a per-group device count.
- **`/devices`** — every device on the server. Supports filtering by one or more device groups (checkboxes, multi-select) via `?groups=<path>&groups=<path>...`. Each row shows the mapped user email (from the imported CSV) if one exists for that device, otherwise falls back to the device's MobiControl name/alias, tagged "unmapped".
- **`/devices/import`** — upload a CSV mapping device ID to user email (see below).

## Device &rarr; email CSV import

Upload a two-column CSV at `/devices/import`:

- A device identifier column (`DeviceId`, `Udid`, `SerialNumber`, `IMEI`, etc. — any of these).
- An email column.

A header row is auto-detected if present (matched by column names containing "device"/"udid"/"serial"/"imei" and "mail"); otherwise the first column is treated as the device ID and the second as the email. On `/devices`, each device is matched against the imported map by checking every id-like field MobiControl returns for that device (Device ID, UDID, Serial Number, IMEI, ReferenceId), so the CSV doesn't need to target one specific field.

The mapping is kept in memory only (same approach as the session store) — it resets on a server restart/redeploy, so re-upload the CSV after those. This keeps the app dependency-free; swap in a real datastore later if the mapping needs to persist longer.

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
5. Open `http://localhost:3000` and sign in with a MobiControl administrator username and password.

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

Note: Render's free web services spin down after periods of inactivity and take a few seconds to wake back up on the next request — expected behavior on the free tier, not a bug.

## Notes

- Device group field names can vary slightly between MobiControl versions; the app normalizes common variants (`Name`/`name`, `Id`/`ID`, `Path`/`FullPath`, etc.) in `normalizeGroup()` in `server.js`. Adjust there if your server uses different field names.
- Device field names are normalized the same way in `normalizeDevice()`/`DEVICE_ID_FIELDS`/`DEVICE_NAME_FIELDS` — extend those lists if a server exposes different field names for device id/name.
- If your on-premises server uses a self-signed certificate, the built-in `fetch` will reject it. The simplest (insecure) workaround is setting `NODE_TLS_REJECT_UNAUTHORIZED=0` as an environment variable — only do this if you understand the risk, and prefer fixing the certificate instead.
- Device counting/listing pages through `/devices` using `skip`/`take` (confirmed pagination params) and match a device to its group by exact `Path` string, since MobiControl's group-filter query params on `/devices` don't actually filter server-side.
