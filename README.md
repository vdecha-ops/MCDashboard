# MobiControl Device Groups Viewer (Node.js)

A small Node/Express app that signs in to SOTI MobiControl's REST API and
lists the server's device groups. No Python required — built to deploy on
Render's free web service tier.

## How it works

MobiControl's API uses OAuth2 with two sets of credentials:

- **API client (Client ID / Client Secret)** — identifies your integration, set once as environment variables.
- **User credentials (username / password)** — a MobiControl administrator account, entered by whoever uses the app.

On login the app calls:

1. `POST {server}/MobiControl/api/token` with `Authorization: Basic base64(client_id:client_secret)` and body `grant_type=password&username=...&password=...` to get an access token.
2. `GET {server}/MobiControl/api/devicegroups` with `Authorization: Bearer {access_token}` to list device groups.

The access token is kept only in the signed session cookie (server-side), never written to disk. The password is never stored or logged.

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
- If your on-premises server uses a self-signed certificate, the built-in `fetch` will reject it. The simplest (insecure) workaround is setting `NODE_TLS_REJECT_UNAUTHORIZED=0` as an environment variable — only do this if you understand the risk, and prefer fixing the certificate instead.
