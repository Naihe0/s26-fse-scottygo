# Deploy ScottyGo on Render and MongoDB Atlas

This setup uses the `codex/render-atlas-setup` branch of
`Naihe0/s26-fse-scottygo`, a Render Free web service in Virginia, and an Atlas M0
cluster named `ScottyGo` in N. Virginia. The service is
[scottygo-ningrui.onrender.com](https://scottygo-ningrui.onrender.com), managed in
the [Render dashboard](https://dashboard.render.com/web/srv-dan0p6jm8hqs739kant0).
Use `scottygo-ningrui.onrender.com` wherever `<service-hostname>` appears below.

## Database and network access

1. Create the Atlas M0 cluster `ScottyGo` in N. Virginia.
2. Create database user `scottygo-app` with a strong password and the `readWrite`
   role on **`ScottyGoPROD` only**. This is a database user, separate from the Atlas
   account used to manage the cluster.
3. Copy the new Render service's outbound IP ranges from its dashboard into the
   Atlas project's Network Access allowlist. Use all listed ranges so subsequent
   deployments can connect; do not use an unrestricted `0.0.0.0/0` entry.
4. Obtain the Atlas driver connection hostname. The application concatenates
   `DB_URL` and `PROD_DB` exactly, as configured below.

## Render service

Create a Node web service connected to `Naihe0/s26-fse-scottygo`:

| Setting | Value |
| --- | --- |
| Branch | `codex/render-atlas-setup` |
| Region / instance | Virginia / Free |
| Root directory | Repository root (leave blank) |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `npm start` |
| Health check path | `/transit/health` (see readiness checks below) |

The package specifies Node `^20.16.0`. The build needs development dependencies
because Parcel is one of them. Start from the repository root so `assets/` is
available; the GTFS parser also requires the `unzip` executable. `npm start`
already sets the heap limit and enables garbage collection for the small instance.

## Environment variables

Store secrets in Render's environment settings, never in Git.

| Variable | Value or purpose |
| --- | --- |
| `ENV` | `RENDER` |
| `STAGE` | `PROD` |
| `RENDER_HOST` | `https://<service-hostname>` |
| `DB_URL` | `mongodb+srv://scottygo-app:<encoded-password>@<atlas-hostname>` |
| `PROD_DB` | `/ScottyGoPROD?retryWrites=true&w=majority` |
| `JWT_KEY` | A strong, random signing secret |
| `INITIAL_ADMIN_PASSWORD` | A strong, random initial administrator password |
| `GOOGLE_MAPS_KEY` | Google Maps key authorized for the new service hostname |

Encode reserved URI characters in the database password. `DB_URL` must not
already contain a database path or query string. Render supplies `PORT`; leave
`BIND_ADDRESS` unset so the service accepts Render's incoming connections.

**Always use `STAGE=PROD`.** DEV startup clears collections in its configured
database. Set `INITIAL_ADMIN_PASSWORD` before the first successful database
connection: it creates username `admin` only when that account is absent, and
does not reset an existing administrator's password on restart. Unset or empty
values retain the legacy `admin` password fallback for local/test compatibility.

`GOOGLE_MAPS_KEY` is needed for the map interface; the client loads Maps JavaScript
with Places and uses Directions. `TRUETIME_KEY` enables PRT route colors and
detours. PRT live feeds and CMU shuttle feeds do not need keys. Optional settings
are `BREVO_API_KEY` with `EMAIL_USER` for account-status email, and `GEMINI_API_KEY`
for AI moderation (otherwise a keyword filter is used). `JWT_EXP` defaults to
`365d` in production. `EMAIL_APP_PASSWORD` is unused.

## Deploy and verify

Save the environment and deploy the selected branch. Without valid Atlas
credentials or network access, startup fails before administrator creation.

After deployment, check these paths on the new Render hostname:

- `/auth` and its referenced JS/CSS assets return 200; login works with `admin`
  and the configured initial password.
- `/transit/memory/samples?limit=1` returns a current sample, confirming database
  persistence.
- `/transit/routes?system=PRT` and `/transit/routes?system=CMU` return route lists.
- `/transit/health` shows fresh `lastFetched` timestamps and healthy live feeds.
- The browser map renders and shows route geometry and available live vehicles.

The health endpoint always returns HTTP 200 and can report healthy before the
first feed fetch. It is a liveness check, not proof that startup has finished.
Free-service cold starts and redeployments reload the GTFS feed and transit
caches; routes can be briefly empty, and initialization may take a few minutes.
Recheck feed timestamps and route counts after warm-up. Restarting with
`STAGE=PROD` preserves Atlas accounts and data. The local computer does not need
to remain running for this hosted deployment.
