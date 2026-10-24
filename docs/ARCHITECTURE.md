# ScottyGo code, development, and operations

This is the current implementation guide. [FEATURES.md](FEATURES.md) describes user behavior and screenshots; [API.md](API.md) lists HTTP and Socket.IO contracts. Historical audits, use cases, release logs, and design drafts are retained in Git history rather than duplicated under `docs/`.

## Structure

ScottyGo is one TypeScript application, with an Express server and a Parcel-built browser frontend. It uses standard HTML/CSS and custom elements rather than a frontend framework. Shared interfaces connect the client, server, and tests.

| Path | Responsibility |
| --- | --- |
| `client/pages/` | Six entry pages: map, authentication, account, subscriptions, notifications, and memory dashboard. |
| `client/scripts/components/` | Custom elements and focused UI: navigation, filters, search, location feedback, map key, tracking status, reports, notification popups. |
| `client/scripts/controllers/` | Map filtering, stop predictions, and walking navigation. |
| `client/scripts/state/` | Shared map state, filter controls, URL synchronization, navigation ownership/cancellation. |
| `client/scripts/maps/` and `renderers/` | Google Maps adapter and route drawing. |
| `client/scripts/trackers/` | Polling, one marker per vehicle, popup state, animation scheduling, and cleanup. |
| `client/scripts/services/` | Typed transit requests, geolocation ownership, walking directions, authentication, and pure vehicle-motion estimation. |
| `client/scripts/utils/`, `client/styles/` | Safe text/links, symbols, focus/zoom helpers, shared visual tokens, and page styles. |
| `server/serve.ts`, `server/app.ts` | Composition, HTTP/Socket.IO setup, initialization, feed lifecycle, and static assets. |
| `server/controllers/` | Route registration, validation, authentication/authorization, HTTP envelopes. |
| `server/models/` | Account, transit, and notification use cases; business rules. |
| `server/services/` | Provider adapters, feed polling, session validation, moderation/email, and diagnostics. |
| `server/db/` | `IDatabase` / DAC boundary, MongoDB/Mongoose implementation, test alternatives. |
| `server/search/` | Search strategies and shared text matching. |
| `common/` | Transit, account, map-provider, response, and Socket.IO interfaces; shared geographic helpers and request limits. |
| `assets/` | CMU route metadata and static CSV geometry/stops used by the app. These are runtime data, separate from documentation screenshots. |
| `tests/`, `tools/` | Jest unit/integration/REST suites; build, Windows runtime, path validation, and opt-in transit E2E helpers. |
| `.dist/` | Generated client and server build, ignored by Git. |

```mermaid
flowchart LR
    Browser[Browser pages and map state] -->|REST| Controllers[Express controllers]
    Browser <-->|Socket.IO| Sockets[Authenticated event sessions]
    Controllers --> Models[Models and search strategies]
    Models --> DB[(MongoDB)]
    Models --> Feeds[Cached provider adapters]
    Feeds --> PRT[PRT GTFS, GTFS-RT and TrueTime]
    Feeds --> CMU[CMU TripShot and static CSVs]
    Browser --> Maps[Google Maps, Places and Routes]
    Models --> Optional[Optional moderation and email]
```

Controllers are singletons assembled by `serve.ts`. Search behavior uses strategies; Socket.IO rooms distribute account and route events. Browser map access is wrapped by `IMapProvider` / `IMapMarker`, enabling focused tests without a live Google Maps instance.

### UI interaction ownership

`TransitSearch` owns its debounce, abort controller, request version, and active result. It keeps DOM focus in the combobox for keyboard navigation and invalidates pending work on dismissal or disconnect. `RouteSelectorPanel` and `TogglePanel` maintain separate draft and committed selections, so Cancel and Escape have the same predictable behavior. Stable filter inputs preserve composition and selection during list updates. Their styles are isolated in `transit-search.css` and `route-controls.css`, loaded by the map page.

The subscriptions page tracks loading and mutation state separately. Its add sheet updates a route row in place after saving, and leaves explicit removal to the saved-route cards. `utils/toast.ts` owns one short feedback message and its dismiss timer; `utils/modal.ts` owns the map message dialog's focus and background inert state. These helpers keep page controllers focused on their workflow.

The five rider-experience rounds add the following boundaries:

| Module | Responsibility |
| --- | --- |
| `maps/google-map.provider.ts`, `utils/map-hit-test.ts` | Track selectable visible overlays, read a moving marker's current coordinate at tap time, and resolve nearby objects in a 24 CSS-pixel Mercator radius. Shared selection IDs deduplicate route casings and segments. |
| `components/map-selection.ts` | Group ambiguous choices by bus, stop and route; own the responsive chooser, keyboard focus, dismissal and guarded selection callback. |
| `renderers/route-renderer.ts` | Deduplicate physical stop markers across route owners, adapt density and stroke emphasis to zoom, retain the selected-stop halo, and fit visible route geometry. A selected stop outside the rendered route layers receives a temporary owner without a second marker. |
| `components/nearby-stops-panel.ts` | Own the nearby list's origin/area, walking-range and route filters, cancellation, bounded next-arrival requests and visible-panel refresh. |
| `components/route-explorer.ts` | Browse route stops by direction/search, identify the nearest boarding stop, list visible buses and request full-route overview. Stops are alphabetical because the stop API supplies no verified trip sequence. |
| `trackers/vehicle-tracker.ts` | Reuse the same bus-selection path for markers and lists; own explicit follow/pause/resume state, rate-limited centering and follow cleanup. |
| `components/rider-shortcuts.ts`, `utils/rider-shortcuts.ts` | Render My places and validate its bounded browser-local store. Keep naming drafts stable during background changes; separate items by immutable account identity. |
| `utils/stop-link.ts`, `utils/stop-link-navigation.ts` | Build/parse public stop links, reuse clipboard fallback, and resolve the exact current stop through authenticated search with a 15-second deadline and cancellation/session guards. |
| `notification.ts`, `utils/notification-card.ts` | Compose update-type, text, saved-route and unread filters; render explicit read/share actions; preserve expanded details and restore focused card actions across snapshot refreshes. |
| `utils/notification-inbox.ts` | Own bounded account-scoped read receipts, content fingerprints, priority/time sorting, unique route-combination groups, and public share summaries with clipboard/manual fallback. |

`PredictionController` owns Save/Share actions on the stop card and records a recent stop only after mounting its card. Its explicit-selection callback and `VehicleTracker`'s callback let the map entry point cancel an older shared-stop lookup before a marker, list item, or minimized tab becomes the new target. Prediction refreshes and vehicle polling do not emit those selection callbacks. Cached popup HTML is rebound on restore, and pending clipboard state is reset for the restored button.

The shared session module centralizes token/account access, authorization headers, and sign-out. Server feed adapters reuse `polling-feed.ts`; `errors.ts`, `logger.ts`, and `transit-validation.ts` provide consistent boundaries for HTTP validation and diagnostics. The memory dashboard now uses a Parcel browser entry instead of server-embedded scripts and styles.

### Notification inbox state and rendering

`NotificationReadStore` persists at most **500 receipts for 45 days** under `scottygo:notification-inbox:v1:<encoded account scope>`. The scope uses the JWT's immutable `userId`; changing a username or renewing a session preserves the same account's read state. Missing or undecodable account identity keeps receipts in memory only, and changing an opaque session clears that temporary state. Invalid records are discarded; blocked storage leaves the current session usable. A receipt contains only the notice key, content fingerprint and read time. It stores no notice body or location.

The fingerprint includes service-alert text, normalized route membership and active periods, URL, effect, cause and severity; rider-update fingerprints include route, bus, message, changed fields and creation time. Changed content under the same notice ID becomes unread. Expiry is checked when reading, and writes prune expired receipts and enforce the cap. Cross-tab storage events reload the active account's receipts.

`notification.ts` intersects saved-route membership with the existing type/search context and unread state, deduplicates by notice key, then sorts. Priority uses only supplied `SEVERE`, `WARNING` and `INFO` values; missing severity remains unranked. Date order uses report creation or the latest supplied alert-window start, with stable ties. Grouping uses the complete affected-route combination, so multi-route notices retain one card and one total count. Saved-route mode promotes followed routes within a group heading.

Polling and socket-triggered refresh retain successful source snapshots on independent failure. Render signatures avoid replacing unchanged cards; changed renders restore expanded disclosures and focus by card/action identity, or move focus to a nearby card/filter when the previous item disappears. Sorting and grouping controls live in the More options disclosure. Sharing occurs only from a direct card action: native share, clipboard with a visible toast, then a focus-managed manual-copy dialog. Summaries contain a public title, routes, a bounded description and a validated HTTP(S) agency URL or public notification-page fallback. Cancelling native share ends the action. BFCache restoration refreshes both feed snapshots and followed routes. Account changes cancel outstanding work, disconnect the old socket and reload the page.

## Initialization and transit data

1. Start the HTTP server, memory monitor, GTFS load, and MongoDB connection. Readiness is separate from the listening socket.
2. After MongoDB connects, enable memory persistence and seed `admin` only if absent. A reset requires explicit `ALLOW_DB_RESET=true` in DEV and is forbidden in PROD.
3. Await static GTFS loading, populate transit caches, and release parsing memory before starting live pollers. Downloads/CSV parsing stream with bounded attempts and deadlines to limit startup memory.
4. Poll PRT vehicle positions and TripShot live status every 15 seconds, and PRT trip updates every 30 seconds. Each source has one shared server poller; requests cannot overlap. Repeated failures back off to five minutes and respect longer provider `Retry-After` instructions. Stale data affects health; a repeated measurement retains its GPS timestamp.
5. Poll PRT service alerts every five minutes and broadcast changed snapshots. Initialize the last-known reported bus conditions and refresh transit caches every 24 hours.

PRT static GTFS supplies routes, stops, trip directions, schedules, and exact trip shape IDs. GTFS-RT supplies vehicles, arrivals, and alerts. TrueTime supplements route colors and detours; missing its optional key does not disable public GTFS feeds. CMU uses public TripShot live status and route metadata/geometry with static CSV support; it does **not** require the obsolete `TRIPSHOT_API_KEY` settings from early project drafts. Route IDs prefixed `CMU-` select that adapter. Stop UUIDs select CMU prediction data.

GTFS service dates use Pittsburgh's timezone and handle schedule times extending after midnight. Date/time route filtering represents scheduled availability, not replay or future vehicle simulation. Keep arrival prediction data separate from marker-motion estimates.

`vehicle-snapshot.ts` reconciles each successful fleet snapshot by vehicle ID. Older or unknown-time updates cannot replace a known accepted fix. Equal-timestamp copies retain coordinates and heading while admitting safety information such as a stopped status or zero speed. Invalid coordinates are excluded and future times beyond five seconds do not poison later acceptance. Missing vehicles leave the server snapshot; failed fetches retain the previous snapshot. CMU also validates reported speed/bearing and deduplicates repeated vehicle statuses and active rides.

Vehicle responses include their source's `feed.healthy`, `feed.lastFetched`, and `feed.consecutiveFailures` alongside the original array payload, with `Cache-Control: no-store`. The five-second foreground browser loop consumes this metadata with the vehicles, removing the extra health-request delay. Hidden pages suspend polling; each source still sees one server poller regardless of connected browser count.

## Browser state and live movement

`MapStateManager` stores filters, measured vehicles, GPS, and an optional planned origin. `URLSyncManager` serializes public route/date/time/system/direction filters and keeps an optional selected stop ID in `#/map?...`. `RouteRenderer` owns selected-stop graphics. Passive URL normalization preserves a shared stop; deliberate filter navigation clears it. Copy-view links contain only filters, while Copy-stop links contain only the public stop ID. `MapNavigationCoordinator` gives each navigation ownership of its requests; cancelled or older responses cannot replace a newer view. Directions temporarily own map graphics, then restore current filters on exit.

`SharedStopNavigation` resolves an ID with `GET /search`, accepts only a matching stop with a valid name and finite coordinates, and supplies safe optional arrays. Generation and session-token checks reject older responses. Cancellation aborts transport; the deadline also bounds a stalled response body. Errors expose an explicit retry callback. Startup and history restoration preserve stop IDs through URL normalization and the sign-in handoff.

`FilterController` loads bulk routes/patterns/stops and registers geometry with `VehicleTracker`. Per-route fallbacks fill caches when bulk data is unavailable. `PredictionController` owns stop-card arrivals; `DirectionsController` owns walking navigation and cancellable Google Routes requests. `GeolocationController` owns exactly one watch, distinguishes permission denial from timeout/unavailability, and ignores late callbacks after retry/teardown. A planned point never counts as measured GPS.

The movement pipeline is:

```text
Provider GPS + source timestamp
  → immutable measured vehicle state
  → trip-shape/heading/continuity matching
  → observed speed and route-progress estimate
  → time/stop/distance confidence limits
  → one existing marker's display position
  → smooth correction when a newer GPS measurement arrives
```

The pure `vehicle-motion.ts` estimator has no Google Maps or timer dependency. It rejects duplicate/out-of-order observations as new motion evidence, quarantines an impossible jump until a second physically consistent report confirms relocation, resets on trip changes, and favors exact shape identity. Geometry compiles lazily; distance-along-path lookup avoids scanning the full route every frame. Repeated identical stop metadata leaves motion untouched; changed stops reuse compiled shapes and velocity history while replanning smoothly from the displayed point. Replacement shapes re-match the measured fix and reconcile from the displayed point, preserving source time. Correction and prediction update a single marker; raw positions remain available for report proximity and timestamps.

The model estimates unique source-report cadence rather than assuming every HTTP poll is a new GPS observation. A delayed measurement can still support motion. Generic mapped stops slow passage; a feed-announced next stop creates an approach, six-second dwell, and departure phase when movement evidence supports it. Explicit `STOPPED_AT` or zero-speed evidence holds position. Missing/ambiguous geometry, invalid time, detours, terminals, and off-route fixes constrain extrapolation. A provider outage freezes the displayed point until a distinct source report arrives, avoiding a jump back to the old raw fix.

| Motion safeguard | Current behavior |
| --- | --- |
| Start from delayed data | At most 120 seconds old when received; older data can be shown but does not start a forecast. |
| First-report forecast | Requires exact shape, fix within 15 meters, heading within 35°, and reported speed above 0.7 through 25 m/s; starts at 85% of reported speed, capped at 20 m/s. Otherwise wait for source-to-source progress evidence. |
| Adaptive continuation | Starts with a 60-second cadence; the first observed interval replaces that prior, and later intervals use a 0.6 previous / 0.4 new weighted average, bounded to 10–60 seconds. Motion spans the expected next unique update, normally 30–90 seconds after receipt, then decays over 20–45 seconds. |
| Absolute limits | No extrapolation beyond 180 seconds of source age or 3 km of route progress; earlier confidence/stop/terminal limits still apply. |
| Freshness | Fresh through 30 seconds, aging through 90 seconds, stale afterward. Stale classification alone does not disable a still-supported estimate. |
| Corrections | Slide the same marker, usually for 600–4,000 ms and bounded to 3 km; use the shared shape when matched. Small forward-motion overshoots can converge more slowly without reversing along a cruise segment. Larger corrections retain an explicit correcting state. |
| Duplicate polls | Never renew source age, velocity evidence, or the forecast deadline. |
| GPS jitter | Repeated confirmed-stop fixes within 12 meters retain a stable resting point. Source travel pace constrains speed; slow traffic uses recent samples and positive slow-speed evidence to avoid alternating movement and freezes. |

`VehicleTracker` owns polling, retention, source-health handling, accessible marker labels, and a shared animation loop. It does not create a second marker for predictions. Visible moving markers animate; hidden pages, reduced-motion mode, stationary vehicles, and exhausted estimates avoid unnecessary animation. Delayed markers have a 15-minute retention bound measured from the source timestamp, or first observation when the timestamp is unknown. Healthy authoritative removal clears the marker and its card. The UI keeps technical tracking information behind an explicit disclosure.

Never refresh measurement age from receipt time, use a predicted coordinate to authorize a report, or infer missing protobuf speed/status/bearing as zero. Optional feed fields are decoded only when present and valid; unknown observation time is an empty string. The estimator's confidence is an internal heuristic, not a calibrated probability or a promise of location accuracy.

### Prediction approach and evaluation

The selected approach combines route matching, recent measured travel pace, reported speed, stop-aware phases, bounded extrapolation, and smooth reconciliation. It runs in the browser and requires no model service or online server training. A learned predictor would need representative historical trajectories with independently measured current-position ground truth and held-out routes/times; the available delayed GPS samples cannot establish that it predicts better. Local training remains a possible later experiment once that dataset exists.

The [GTFS Realtime best practices](https://gtfs.org/documentation/realtime/realtime-best-practices/) recommend frequently refreshed feeds and vehicle observations no older than 90 seconds. [GTFS VehiclePosition definitions](https://gtfs.org/documentation/realtime/reference/#message-vehicleposition) distinguish the observation timestamp from feed creation time. These support separate transport health and per-bus GPS age; they do not establish per-second GPS availability from PRT or CMU.

Run deterministic trajectory replay against the previous release with:

```text
node tools/vehicle-motion-replay.mjs --baseline 17a0421
```

The fixtures cover delayed reports, noisy slow traffic, isolated bad fixes, stops/restarts, turns and feed gaps. They compare position error, unwanted reverse travel and long frozen periods using known synthetic trajectories. Results measure behavior on those scenarios; they are not field-measured location accuracy. Unit tests additionally cover lifecycle, duplicate/out-of-order updates, outage handling and background restoration.

## Accounts, persistence, and events

JWTs carry immutable `userId` and `tokenVersion`; server authorization reloads the active account. Password changes and deactivation invalidate old sessions. Passwords use bcrypt and are obfuscated in responses. Login and password-backed terms acceptance share an IP failure limit. Socket sessions authenticate on connect and inbound events, expire on time, and lose account rooms when privileges change.

My places uses the `scottygo:rider-shortcuts:v2:` browser-storage namespace keyed by the JWT's immutable `userId`. Reading that claim chooses a local namespace; it does not authorize a server request. Earlier username-scoped prototype keys are neither read nor migrated, preventing a later account from inheriting a former username's places. Opaque or malformed sessions receive separate memory-only stores. Payload validation strips unknown fields, deduplicates entries and enforces limits of 20 stops, 8 places, 8 views and 8 recent selections. Filter presets omit credentials, GPS and schedule dates/times. Storage failures fall back to memory, and a cross-tab account change closes an open shortcut dialog. These shortcuts are separate from MongoDB route subscriptions. The active planned origin also uses an immutable-account namespace (`scottygo:planned-location:v2:`); legacy global location records are ignored. Map tabs reload when another tab changes accounts, clearing the previous account's private marker and dialogs.

| MongoDB model | Purpose and retention |
| --- | --- |
| `User` | Account identity, hashed password, terms, status, role, onboarding and session version. |
| `TransitCache` | Routes/stops/patterns/detours with unique keys and expiry TTL. |
| `SubscriptionSet` | One atomic bounded list per user; uniqueness and maximum ten routes enforced in the same update. |
| `Subscription` | Legacy individual records retained for migration/recovery. |
| `BusReport` | Submitted conditions and coordinates; indexed by bus/time. No automatic TTL currently. |
| `Notification` | Changed-condition events; 30-minute expiry and explicit recent-time filtering. |
| `MemorySample` | Runtime and startup-phase diagnostics; seven-day TTL. |

Existing individual subscriptions migrate lazily to a user's `SubscriptionSet`. Once present, the set is authoritative. Do not concurrently run an old writer against the same database. Rolling back to code predating this migration requires reconciling sets back into legacy records, including deletions; reverting application code alone does not revert persisted data.

Reports validate enums, numeric coordinates, nonempty answers, and comment length. Normal report submission requires a bus within half a mile; administrators have a server-side distance exemption. The frontend additionally blocks submission without usable GPS or sufficiently recent bus data. Moderation uses configured Gemini or a keyword fallback. Only changed condition fields publish a notification; identical answers still persist as reports without another event. Subscriptions persist in MongoDB, while mute preferences stay in browser storage.

Alert rendering preserves agency text as text nodes and creates only validated HTTP(S) links. Known cause/effect/severity metadata is retained without guessing urgency. Alert snapshots, local search, disclosures, focus, and partial failures are independently managed. Popup queues are bounded/deduplicated and pause while read, focused, or hidden. Page/BFCache lifecycle handlers clean up requests, timers, and sockets.

## Run locally

Use **Node.js `^24.19.0`**, npm `>=10.8.0`, MongoDB, and `unzip` on PATH. The deployment branch is Windows-safe; the historical main branch may contain filenames Windows cannot check out.

```powershell
git clone --branch codex/render-atlas-setup https://github.com/Naihe0/s26-fse-scottygo.git
cd s26-fse-scottygo
npm ci
Copy-Item .env.template .env
```

Configure `.env` privately. The application concatenates `DB_URL` and the selected database suffix exactly:

```dotenv
ENV=LOCAL
STAGE=DEV
ALLOW_DB_RESET=false
BIND_ADDRESS=127.0.0.1
LOCAL_HOST=http://localhost
PORT=8080
DB_URL=mongodb://127.0.0.1:27017
DEV_DB=/ScottyGoLocal
PROD_DB=/ScottyGoLocal
```

Add a private `JWT_KEY`, `INITIAL_ADMIN_PASSWORD`, and a Google Maps key. Never commit `.env` or credentials. Optional keys are described below. With MongoDB running, `npm run build` then `npm start` serves [localhost:8080](http://localhost:8080); `npm run watch` rebuilds/restarts on source changes.

### Windows background helper

```powershell
npm run local:start
npm run local:status
npm run local:stop
```

`tools/local.ps1` runs the app and MongoDB in hidden processes bound to loopback, reuses its own running instances, verifies identities before stopping, and preserves data. It requires installed npm dependencies, Git for Windows, and a portable MongoDB at `%LOCALAPPDATA%\ScottyGo\mongodb-*\bin\mongod.exe`. It prefers portable Node 24 under `%LOCALAPPDATA%\ScottyGo\node-v24*-win-x64`, falling back to PATH. The helper does not install runtimes.

Local persistent data is under `%LOCALAPPDATA%\ScottyGo\data\s26-fse-scottygo`; logs are under `%LOCALAPPDATA%\ScottyGo\logs\s26-fse-scottygo`. PID state is in ignored `tmp/local-runtime.json`. The helper sets local database/binding variables for its children and adds Git's `unzip` to their PATH. It builds only if the server build is absent; after editing source, **stop → build → start** explicitly. A separate test shell must add `unzip` itself if testing real GTFS downloads.

An initial DEV database can use the legacy `admin` password fallback; set a private initial password before use. Existing accounts are never reset by changing `INITIAL_ADMIN_PASSWORD`. Local MongoDB and the hosted Atlas database are separate.

## Render and Atlas

The personal service is [scottygo-ningrui](https://dashboard.render.com/web/srv-dan0p6jm8hqs739kant0), connected to `Naihe0/s26-fse-scottygo`, branch `codex/render-atlas-setup`. The original project service uses its own deployment/database.

| Render setting                    | Value                                   |
| --------------------------------- | --------------------------------------- |
| Runtime / root                    | Node, repository root                   |
| Build                             | `npm ci --include=dev && npm run build` |
| Start                             | `npm start`                             |
| Health path                       | `/transit/health`                       |
| Current deployment region / class | Virginia / Free                         |

Development dependencies are needed to build Parcel. Runtime uses a 320 MB heap cap and exposed GC for the small instance. Keep `assets/` available and `unzip` installed. On stale-install failures, clear Render's build cache before redeploying.

Create an Atlas database user with `readWrite` on `ScottyGoPROD` only. Allow the outbound IP ranges shown by this Render service in Atlas Network Access; use the dashboard's current ranges. Keep the database password and service secrets in Render environment settings.

| Environment variable | Purpose |
| --- | --- |
| `ENV=RENDER`, `STAGE=PROD` | Hosted mode and production protection. |
| `RENDER_HOST` | `https://scottygo-ningrui.onrender.com` for this deployment. |
| `DB_URL` | `mongodb+srv://<db-user>:<encoded-password>@<atlas-host>` without database path/query. |
| `PROD_DB` | `/ScottyGoPROD?retryWrites=true&w=majority`. |
| `JWT_KEY` | Private random signing key, at least 32 characters in PROD. |
| `INITIAL_ADMIN_PASSWORD` | Private bootstrap password, at least 12 characters in PROD. Seeds only an absent `admin`. |
| `JWT_EXP` | Production token lifetime; this deployment uses `7d`. Code default is `365d`; DEV uses nonexpiring tokens. |
| `GOOGLE_MAPS_KEY` | Browser key restricted to approved service/local origins with Maps JavaScript, Places, and Routes enabled. It is intentionally delivered to the authenticated browser, so origin/API restrictions matter. |
| `TRUETIME_KEY` | Optional PRT colors/detours integration. |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Optional moderation provider/configuration. |
| `BREVO_API_KEY`, `EMAIL_USER`, `EMAIL_FROM_NAME` | Optional account-status email and sender. `EMAIL_APP_PASSWORD` is unused. |

Render provides `PORT`; leave `BIND_ADDRESS` unset there. Encode reserved characters in an Atlas password before constructing its URI. PROD rejects missing/placeholder JWT and bootstrap secrets, and never permits database reset.

## Verification and release

```text
npm run lint
npm run typecheck
npm run build
npm run test:unit
npm run test:integration
npm run test:rest
npm run check:paths
```

`npm run prepush:check` runs lint, type checks, production build, and unit checks without rewriting files. Unit tests need no database. Integration/REST suites use **disposable loopback MongoDB only**: default `mongodb://127.0.0.1:27019/scottygo_test`. An override must name `scottygo_test` or `scottygo_test_*`, with no remote hosts or credentials. Tests clear collections, unset external email/AI credentials, and run DB suites sequentially. Never run concurrent commands against the same test database.

`npm run test:rest:e2e:transitAPI` explicitly opts into real provider downloads and requires `unzip`, disposable MongoDB, and working upstream services. Use focused deterministic tests for estimator time, out-of-order reports, route branches, stops, correction continuity, one-marker ownership, request cancellation, and progressive disclosure. Browser acceptance should cover desktop and phone layouts, actual map focus/selection, keyboard controls, permission recovery, details expansion, and alert links. Keep synthetic bus/location/report scenarios on a local test origin and database.

After pushing application changes, verify Render's deployed commit and Live status, then separately check readiness:

- `/transit/health` is HTTP 200 for liveness. Require `overall: true`, `gtfs.ready: true`, and fresh feed timestamps before calling transit ready. GTFS/caches can need several minutes after a cold start.
- Verify `/auth`, `/`, `/account`, `/subscriptions`, `/notifications`, and their referenced JS/CSS assets; sign in and inspect map configuration without logging tokens/keys.
- Check PRT/CMU route catalogs, geometry, live vehicles, arrival/alert sources, and a current persisted memory sample.
- Review the deployed browser at desktop and phone width. Do not submit production reports or alter user subscriptions merely for a smoke test.
- Stop temporary local app/test database processes after verification and reset browser viewport overrides.

Record the current release's commits and acceptance in [FEATURES.md](FEATURES.md), and verify deployed identity in Render. Keep older release history in Git. If replacing screenshots, capture the implemented UI and avoid credentials, personal location, or fabricated production reports.

## Diagnostics and constraints

The memory monitor samples every five seconds, tracks RSS/heap/external memory and startup phases, warns at 420 MB RSS, and flags critical at 460 MB. `/transit/memory/dashboard` provides a graph, peak/critical drilldowns, reload, and CSV export. Samples persist for seven days. Examine startup phases and sustained slope rather than treating a single RSS peak as a leak. These diagnostic endpoints are currently public.

| Symptom | Check |
| --- | --- |
| Windows clone fails on invalid filenames | Clone the Windows-safe deployment branch above. Do not weaken Git path protection. |
| Routes absent immediately after deployment | Read GTFS readiness, feed health/timestamps, and startup logs; wait for initialization. |
| Server cannot connect to Atlas | Database user/role, URI encoding, database suffix, and Render outbound allowlist. |
| Map or walking route fails | Authorized Maps origin and enabled APIs; browser error feedback; network timeout. |
| iPhone location unavailable despite site Allow | Device Location Services, browser-level access, actual error type, then Try again. |
| `unzip ENOENT` | Add Git for Windows' `usr\bin` to the process PATH; this is not an empty feed. |
| UI still shows old code locally | Rebuild, restart the correct process, and refresh; use `npm run clean:build` if generated artifacts are stale. |
| Prediction stops | Inspect report age, stop/status/speed evidence, shape ambiguity, limits, and source health. Do not force arbitrary movement to hide an outage. |

Known boundaries: a single Render process and in-memory feed state, no background push/native application/offline support, no pagination for the short notification window, no automatic bus-report retention policy, and provider-limited observation cadence. Any future horizontal scaling must coordinate Socket.IO rooms, caches, rate limits, and subscription/report writers. Browser authentication currently stores bearer tokens in local storage, making safe text rendering and avoidance of script injection especially important.
