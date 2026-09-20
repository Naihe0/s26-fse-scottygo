# ScottyGo — Real-Time CMU Transit Tracker

ScottyGo is a full-stack web application that helps the Carnegie Mellon community navigate Pittsburgh transit in real time. It unifies **Pittsburgh Regional Transit (PRT) bus data** and **CMU Shuttle data** on a single Google Maps interface, with live vehicle tracking, route visualization, nearby-stop discovery, arrival predictions, and pedestrian navigation.

**Live app:** [scottygo-ningrui.onrender.com](https://scottygo-ningrui.onrender.com/)

Originally built by a four-person team for CMU 18-652 _Foundations of Software Engineering_ (Spring 2026), then maintained and extended on `codex/render-atlas-setup`.

---

## What it does

- **Live vehicle tracking** — PRT and CMU positions with one directional marker per bus, route-aware movement between GPS reports, smooth corrections, and visible delayed-data states.
- **Route visualization** — Renders route paths with detour overlays, plus filtering by route, system, direction, date, and time.
- **Discover Stops & Schedules** — Finds nearby stops within a walking radius of the user's location, shows arrival predictions and estimated walking time, and provides turn-by-turn **pedestrian navigation** with real-time GPS tracking and automatic rerouting.
- **Live notifications** — User-submitted bus condition reports (crowdedness, priority seating, vehicle condition) plus route subscriptions, delivered in real time over WebSockets.
- **Contextual search** — Keyword search across multiple contexts (routes, stops, users, subscriptions, notifications) with stop-word filtering and real-time autocomplete.
- **Accounts** — Registration, login/logout, and account management with token-based authentication.

## Architecture

ScottyGo is a single TypeScript codebase split into three workspaces:

- **`client/`** — Browser frontend (HTML/CSS/TypeScript), bundled with Parcel. Organized into pages, components, renderers, services, state, and trackers.
- **`server/`** — Node.js / Express backend exposing a REST API and a Socket.io real-time layer. Controllers for accounts, auth, map, transit, notifications, and subscriptions; a service layer wrapping the external transit feeds (TrueTime, GTFS-RT, TripShot) with caching; and supporting services for alerts, moderation, email, and memory monitoring.
- **`common/`** — Shared TypeScript interfaces used by both client and server (transit, map, socket, and domain types).

**Design patterns:** the contextual search system uses the **Strategy** pattern; the live-notification system uses the **Observer** pattern; and server-side controllers use the **Singleton** pattern.

## Tech stack

| Layer | Technologies |
| --- | --- |
| Frontend | TypeScript, HTML, CSS, Parcel, jQuery, Google Maps API |
| Backend | Node.js, Express, Socket.io |
| Data | MongoDB (Mongoose ODM) |
| Auth | JWT, bcrypt |
| External feeds | PRT TrueTime / GTFS-Realtime, CMU Shuttle (TripShot) |
| Testing | Jest (unit, integration, REST) |
| Tooling | ESLint, Prettier, GitHub Actions (CI/CD), Sigrid (code quality), Render (hosting) |

## Running locally

Requires Node.js `^24.19.0` and npm `>=10.8.0`.

For cloning the Windows-safe branch, configuring local MongoDB, and using the background start/stop helper, see [Local development](docs/ARCHITECTURE.md#run-locally).

Install dependencies:

```bash
npm ci
```

Create your environment file by copying the template, then fill in the values:

```bash
cp .env.template .env
```

See `.env.template` for the full list of required variables (MongoDB connection, JWT secret, Google Maps API key, transit-feed credentials, and Brevo API key for email).

Build and run with auto-reload:

```bash
npm run watch
```

## Testing

Unit tests need no database. Integration and REST suites require MongoDB on `127.0.0.1:27019`, using the disposable `scottygo_test` database. Jest refuses remote databases and application database names, clears external email/AI keys, and serializes database suites. Override `TEST_DB_URL` only with a loopback URL whose database is `scottygo_test` or `scottygo_test_*`. Live transit E2E tests are opt-in (`npm run test:rest:e2e:transitAPI`) and depend on upstream availability.

```bash
npm test                 # full Jest suite
npm run test:unit        # unit tests
npm run test:integration # integration tests
npm run test:rest        # REST API tests
npm run test:server      # unit + integration + REST
npm run typecheck       # server and browser TypeScript
npm run prepush:check   # lint, types, production build, unit tests; no file rewrites
```

## Documentation

The documentation has three maintained guides and current UI screenshots:

- [Features and current screens](docs/FEATURES.md) — all user flows, map behavior, alerts, accounts, and visual references.
- [Code architecture and operations](docs/ARCHITECTURE.md) — structure, data flow, local setup, Render/Atlas, tests, and troubleshooting.
- [API reference](docs/API.md) — HTTP routes, payloads, authentication, errors, and Socket.IO events.

Historical design drafts, audits, wireframes, and cycle logs remain available in Git history.

## Development practices

- **Release validation** — run lint, server/browser type checks, a production build, appropriate isolated MongoDB tests, and browser acceptance before deployment. Verify the deployed commit and feed readiness separately.
- **Continuous integration** — inherited workflows contain checks and deployment integrations; review them before enabling GitHub Actions for a fork.
- **Code quality** — Sigrid static analysis informed iterative refactoring.
- **AI-assisted development** — see [`CLAUDE.md`](CLAUDE.md) for how AI tooling was used in building this project.

## License

ScottyGo is released under the BSD 3-Clause License. Copyright (c) 2026 George A Stey, Anthony Ren, Charlie Ai, and Ningrui Yang. See [LICENSE](LICENSE).
