# Deploy ScottyGo on Render and MongoDB Atlas

This setup uses the `codex/render-atlas-setup` branch of `Naihe0/s26-fse-scottygo`, a Render Free web service in Virginia, and an Atlas M0 cluster named `ScottyGo` in N. Virginia. The service is [scottygo-ningrui.onrender.com](https://scottygo-ningrui.onrender.com), managed in the [Render dashboard](https://dashboard.render.com/web/srv-dan0p6jm8hqs739kant0). Use `scottygo-ningrui.onrender.com` wherever `<service-hostname>` appears below.

## Database and network access

1. Create the Atlas M0 cluster `ScottyGo` in N. Virginia.
2. Create database user `scottygo-app` with a strong password and the `readWrite` role on **`ScottyGoPROD` only**. This is a database user, separate from the Atlas account used to manage the cluster.
3. Copy the new Render service's outbound IP ranges from its dashboard into the Atlas project's Network Access allowlist. Use all listed ranges so subsequent deployments can connect; do not use an unrestricted `0.0.0.0/0` entry.
4. Obtain the Atlas driver connection hostname. The application concatenates `DB_URL` and `PROD_DB` exactly, as configured below.

## Render service

Create a Node web service connected to `Naihe0/s26-fse-scottygo`:

| Setting           | Value                                          |
| ----------------- | ---------------------------------------------- |
| Branch            | `codex/render-atlas-setup`                     |
| Region / instance | Virginia / Free                                |
| Root directory    | Repository root (leave blank)                  |
| Build command     | `npm ci --include=dev && npm run build`        |
| Start command     | `npm start`                                    |
| Health check path | `/transit/health` (see readiness checks below) |

The package specifies Node `^24.19.0`. The build needs development dependencies because Parcel is one of them. Start from the repository root so `assets/` is available; the GTFS parser also requires the `unzip` executable. `npm start` already sets the heap limit and enables garbage collection for the small instance.

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

Encode reserved URI characters in the database password. `DB_URL` must not already contain a database path or query string. Render supplies `PORT`; leave `BIND_ADDRESS` unset so the service accepts Render's incoming connections.

**Always use `STAGE=PROD` on Render.** Database reset is forbidden in PROD and requires explicit `ALLOW_DB_RESET=true` in DEV. Set `INITIAL_ADMIN_PASSWORD` before the first successful database connection: it creates username `admin` only when that account is absent, and does not reset an existing administrator's password on restart. Production refuses missing/placeholder credentials, JWT keys shorter than 32 characters, and initial administrator passwords shorter than 12 characters. The `admin` fallback is only available in development/tests.

`GOOGLE_MAPS_KEY` is needed for the map interface; enable Maps JavaScript API, Places, and Routes API for its Google Cloud project and authorize the service hostname. Walking directions use the current Routes library (`Route.computeRoutes`) because new projects cannot activate the legacy Directions service. Requests time out after 15 seconds and restore the map on failure; they can also be cancelled from the loading panel. `TRUETIME_KEY` enables PRT route colors and detours. PRT live feeds and CMU shuttle feeds do not need keys. Optional settings are `BREVO_API_KEY` with `EMAIL_USER` for account-status email, and `GEMINI_API_KEY` for AI moderation (otherwise a keyword filter is used). `JWT_EXP` defaults to `365d` in production; this deployment explicitly uses `7d`. `EMAIL_APP_PASSWORD` is unused.

## Deploy and verify

The September 2026 audit adds an atomic `SubscriptionSet` document per user. Existing individual subscription records are copied lazily on first access and retained for recovery. Once a set exists, it is authoritative. Use a single writer during this first cutover: do not run an old service against the same database while the updated service accepts subscription changes. Before rolling back to old code, reconcile the sets back into individual records (including removals). An ordinary code rollback alone will not undo the data migration. The original ScottyGo deployment uses its own database and is unaffected.

Save the environment and deploy the selected branch. Without valid Atlas credentials or network access, startup fails before administrator creation.

After deployment, check these paths on the new Render hostname:

- `/auth` and its referenced JS/CSS assets return 200; login works with `admin` and the configured initial password.
- `/transit/memory/samples?limit=1` returns a current sample, confirming database persistence.
- `/transit/routes?system=PRT` and `/transit/routes?system=CMU` return route lists.
- `/transit/health` shows fresh `lastFetched` timestamps and healthy live feeds.
- The browser map renders and shows route geometry and available live vehicles.

The health endpoint returns HTTP 200 for liveness. Inspect the JSON `overall`, `gtfs.ready`, and live-feed timestamps for readiness: feeds remain unhealthy until their first successful fetch and become unhealthy when stale. Free-service cold starts and redeployments reload the GTFS feed and transit caches; routes can be briefly empty during initialization. GTFS downloads and all CSV tables now stream with bounded deadlines and retries to reduce memory spikes and avoid blocking startup indefinitely. Recheck feed timestamps and route counts after warm-up. Restarting with `STAGE=PROD` preserves Atlas accounts and data. The local computer does not need to remain running for this hosted deployment.
