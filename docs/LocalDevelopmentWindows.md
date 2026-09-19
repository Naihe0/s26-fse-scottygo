# Local development on Windows

The audited deployment branch contains the Windows-safe wireframe names. Clone it directly:

```powershell
git clone --branch codex/render-atlas-setup https://github.com/Naihe0/s26-fse-scottygo.git
cd s26-fse-scottygo
```

A full checkout of this branch was verified on Windows without sparse exclusions. The original `main` branch retains its historical folder names until these changes are merged there.

Run these commands in PowerShell from the repository directory:

```powershell
npm run local:start
npm run local:status
npm run local:stop
```

Open <http://localhost:8080>. The helper runs the app and MongoDB in hidden background processes, both bound to `127.0.0.1`. Repeating `start` reuses its running processes. `stop` checks saved process identities before stopping them and preserves the database.

These commands invoke `tools/local.ps1 -Action start|status|stop`. The helper needs Node.js 24, installed npm dependencies, Git for Windows, and the portable MongoDB runtime in `%LOCALAPPDATA%\ScottyGo\mongodb-*\bin\mongod.exe`. It prefers the portable Node 24 runtime under `%LOCALAPPDATA%\ScottyGo\node-v24*-win-x64`; otherwise it uses Node on PATH. It does not install software. It builds the app only if `.dist/server/serve.js` is missing. After editing application code, rebuild and restart (run npm with Node 24 on PATH):

```powershell
npm run local:stop
npm run build
npm run local:start
```

Keep `.env` in the repository root. Local settings are:

```dotenv
ENV=LOCAL
STAGE=DEV
ALLOW_DB_RESET=false
BIND_ADDRESS=127.0.0.1
LOCAL_HOST=http://localhost
PORT=8080
DB_URL=mongodb://127.0.0.1:27017
PROD_DB=/ScottyGoLocal
DEV_DB=/ScottyGoLocal
TEST_DB_URL=mongodb://127.0.0.1:27017/scottygo_test_local
```

Use a private random `JWT_KEY` in `.env`. A valid `GOOGLE_MAPS_KEY` enables the map; without one, the map will not render. Optional service keys also belong in `.env`. Never commit this file. The helper overrides the local settings above for its child process; other `.env` settings are loaded normally.

DEV and PROD now preserve accounts across restarts. Database reset requires an explicit `ALLOW_DB_RESET=true` in DEV; it is forbidden in PROD. A new local database seeds username `admin` using `INITIAL_ADMIN_PASSWORD` (the development fallback is `admin`). Production requires private random secrets and rejects missing or placeholder values.

The application database is `mongodb://127.0.0.1:27017/ScottyGoLocal`. Files are stored under `%LOCALAPPDATA%\ScottyGo\data\s26-fse-scottygo`; logs are under `%LOCALAPPDATA%\ScottyGo\logs\s26-fse-scottygo`. `app.stdout.log` shows startup and transit-feed progress, `app.stderr.log` shows app errors, and `mongodb.log` shows database activity. Startup may take a minute while transit data loads. PID state is saved in the ignored `tmp/local-runtime.json` inside this repository. Git's `unzip` is added only to the child process PATH.

Unit tests can run with `npm run test:unit`. Integration and REST tests clear database collections. Jest accepts only a loopback MongoDB URL with database `scottygo_test` or `scottygo_test_*`; remote hosts, credentials, and application database names are refused before any application imports. The default is `mongodb://127.0.0.1:27019/scottygo_test`. To reuse the local MongoDB process, set `$env:TEST_DB_URL='mongodb://127.0.0.1:27017/scottygo_test_local'` in your test shell. Jest runs suites sequentially; do not start multiple test commands against the same test database.

The opt-in real-provider suite downloads and streams the GTFS archive, so its shell also needs Git for Windows' `unzip.exe`. The local startup helper configures only its own child process; it does not update an independently opened test shell. With Node 24 already selected, prepare the test shell and run:

```powershell
$scottyGoGitRoot = Split-Path (Split-Path (Get-Command git.exe).Source)
$env:Path = "$(Join-Path $scottyGoGitRoot 'usr\bin');$env:Path"
npm run test:rest:e2e:transitAPI
```

An `unzip ENOENT` message means that executable is missing from the test process PATH, not that the transit feed is empty. The suite still requires the disposable MongoDB described above and available upstream providers.

This local setup does not change the Render deployment or MongoDB Atlas.
