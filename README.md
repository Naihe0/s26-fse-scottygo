# ScottyGo — Real-Time CMU Transit Tracker

ScottyGo is a full-stack web application that helps the Carnegie Mellon community navigate Pittsburgh transit in real time. It unifies **Pittsburgh Regional Transit (PRT) bus data** and **CMU Shuttle data** on a single Google Maps interface, with live vehicle tracking, route visualization, nearby-stop discovery, arrival predictions, and pedestrian navigation.

**Live app:** https://s26-fse-scottygo.onrender.com/

> Built by a 4-person team as the term project for CMU 18-652 _Foundations of Software Engineering_ (Spring 2026). ~33,000 lines of TypeScript with ~12,200 lines of automated test coverage.

---

## What it does

- **Live vehicle tracking** — Real-time positions for PRT buses (via the TrueTime / GTFS-Realtime feeds) and CMU shuttles (via TripShot), refreshed continuously on a Google Map.
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

Requires Node.js `^20.16.0` and npm `>=10.8.0`.

For the Windows setup with a separate, persistent local MongoDB database, see
[Local development on Windows](docs/LocalDevelopmentWindows.md).

Install dependencies:

```bash
npm install
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

```bash
npm test                 # full Jest suite
npm run test:unit        # unit tests
npm run test:integration # integration tests
npm run test:rest        # REST API tests
npm run test:server      # unit + integration + REST
```

## Documentation

Additional design and operations documentation lives in [`docs/`](docs/), including the architecture overview, REST API specifications, the CMU Shuttle integration notes, and a memory-monitoring runbook.

## Development practices

- **Main-branch protection** — all changes reach `main` via pull request with required review and approval.
- **Continuous integration** — GitHub Actions runs linting and the test suite on every PR.
- **Code quality** — Sigrid static analysis informed iterative refactoring.
- **AI-assisted development** — see [`CLAUDE.md`](CLAUDE.md) for how AI tooling was used in building this project.

## License

ScottyGo is released under the BSD 3-Clause License. Copyright (c) 2026 George A Stey, Anthony Ren, Charlie Ai, and Ningrui Yang. See [LICENSE](LICENSE).
