# Local development on Windows

Run these commands in PowerShell from the repository directory:

```powershell
npm run local:start
npm run local:status
npm run local:stop
```

Open <http://localhost:8080>. The helper runs the app and MongoDB in hidden background processes, both bound to `127.0.0.1`. Repeating `start` reuses its running processes. `stop` checks saved process identities before stopping them and preserves the database.

These commands invoke `tools/local.ps1 -Action start|status|stop`. The helper needs Node.js, installed npm dependencies, Git for Windows, and the portable MongoDB runtime in `%LOCALAPPDATA%\ScottyGo\mongodb-*\bin\mongod.exe`. It does not install software. It builds the app only if `.dist/server/serve.js` is missing. After editing application code, rebuild and restart:

```powershell
npm run local:stop
npm run build
npm run local:start
```

Keep `.env` in the repository root. Local settings are:

```dotenv
ENV=LOCAL
STAGE=PROD
BIND_ADDRESS=127.0.0.1
LOCAL_HOST=http://localhost
PORT=8080
DB_URL=mongodb://127.0.0.1:27017
PROD_DB=/ScottyGoLocal
DEV_DB=/ScottyGoTest
TEST_DB_URL=mongodb://127.0.0.1:27017/ScottyGoTest
```

Use a private random `JWT_KEY` in `.env`. A valid `GOOGLE_MAPS_KEY` enables the map; without one, the map will not render. Optional service keys also belong in `.env`. Never commit this file. The helper overrides the local settings above for its child process; other `.env` settings are loaded normally.

`STAGE=PROD` preserves local accounts across restarts. The current DEV startup clears its configured database. Localhost HTTP is supported in PROD mode. A new database seeds the test administrator `admin` / `admin`.

The application database is `mongodb://127.0.0.1:27017/ScottyGoLocal`. Files are stored under `%LOCALAPPDATA%\ScottyGo\data\s26-fse-scottygo`; logs are under `%LOCALAPPDATA%\ScottyGo\logs\s26-fse-scottygo`. `app.stdout.log` shows startup and transit-feed progress, `app.stderr.log` shows app errors, and `mongodb.log` shows database activity. Startup may take a minute while transit data loads. PID state is saved in the ignored `tmp/local-runtime.json` inside this repository. Git's `unzip` is added only to the child process PATH.

Unit tests can run with `npm run test:unit`. Integration and REST tests clear database collections: never point them at the application database or a deployed database. They use `TEST_DB_URL`, falling back to `DB_URL` plus `DEV_DB`. The configuration above puts test data in the separate, disposable `ScottyGoTest` database. Run database-writing suites sequentially so they do not clear each other's data.

This local setup does not change the Render deployment or MongoDB Atlas.
