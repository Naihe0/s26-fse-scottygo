# ScottyGo repository and application audit

Date: 2026-09-19. Target: `Naihe0/s26-fse-scottygo`, branch `codex/render-atlas-setup`, and the personal [Render application](https://scottygo-ningrui.onrender.com).

This report records a source, dependency, operations, automated-test, and browser review. It is not a claim that every possible runtime state is defect-free. Historical assignment documents and wireframes describe some features that are not mounted in the current interface; the inventory below distinguishes them. The original deployment and its database are outside this change.

## Detailed findings

- [Backend security, accounts, notifications, and persistence](BackendFindings.md)
- [Transit APIs, feed loading, schedules, and reliability](TransitFindings.md)
- [Frontend, usability, rendering, and asynchronous state](FrontendFindings.md)

The detailed reports give evidence paths, severity, implemented behavior, regression coverage, and remaining work. P1 means a serious security, availability, or data-loss issue; P2 is a functional/reliability/accessibility defect; P3 is a maintainability or operational improvement. Priorities reflect this application, not a formal vulnerability scoring exercise.

## How the application works

Parcel builds five browser entry points and one Express server. MongoDB persists accounts, subscriptions, condition reports, notifications, detours, and memory samples. The map combines PRT GTFS schedules and live feeds with CMU TripShot data. Most route and vehicle lookups use process-local caches. Socket.io distributes account changes, report notifications, and autocomplete results. Google Maps provides the map, places, and walking routes. Brevo email and Gemini moderation are optional; moderation has a limited local fallback.

| User capability | Current behavior and verification |
| --- | --- |
| Register, accept terms, log in/out | Field validation and agreement flow, signed sessions, active-account authorization; REST/integration tests and local browser login. Registration/account mutations use disposable test data. |
| Manage accounts | Own profile and administrator search/edit/status/role/password flows; ownership, last-admin sequential rules, token revocation, and socket updates tested. Live administrator form opened/cancelled without changing production users. |
| Explore routes and vehicles | PRT/CMU route/system/direction filters, shapes, detours, vehicle markers and details; live APIs, automated tests, desktop/mobile browser checks. |
| Search and choose stops | Debounced route/stop search, keyboard options, nearby stops, default campus/GPS/planned location; request ordering and arrival refresh regressions. |
| Walk to a stop | Current Google Routes API, instructions/ETA, cancellation, timeout, rerouting and restoration; retained regression suites and real browser walking-route checks. |
| Subscribe and receive alerts | Ten routes per user, add/remove, device-local mute, notification search, service alerts and real-time popups; Mongo concurrency tests, DOM tests, and local add/mute/remove browser flow. |
| Report bus conditions | Multi-step crowding/seating/condition/comment form, server validation/proximity/moderation, change notifications and draft retry; automated tests. No fabricated reports were published to the live service. |
| Onboarding and appearance | Account-based tutorial and responsive layout reviewed. Remaining modal focus and cross-tab behavior are listed in the frontend report. |
| Date/time filtering and dark mode | API/state and legacy components exist. Calendar/time/dark controls are not mounted on the shipped map. CMU and overnight schedule limitations remain explicit follow-ups. |
| Operations | Feed health, memory dashboard/history, admin bootstrap, local runtime helper, Render/Atlas setup and CI reviewed. Health distinguishes initial loading and stale providers. |

## Repository and operations findings fixed

| Priority | Finding | Implemented change |
| --- | --- | --- |
| P1 | DEV startup and tests could clear a database inherited from a real `.env`; CI injected the complete deployment environment. | Explicit opt-in reset, production refusal, Jest setup before imports that only accepts loopback `scottygo_test` databases, provider credentials cleared, sequential Mongo suites, and an isolated CI Mongo service. No production database is used for automated writes. |
| P1 | The initial production dependency audit reported 30 vulnerabilities, including two critical; the full audit reported 59. | Updated compatible packages/lockfile, bcrypt 6 and CSV parser 7; removed unused Resend/UUID and bundled npm dependencies; AdmZip is only a test fixture dependency. Post-update full and production audits report zero known advisories. This is a registry snapshot, not a security guarantee. |
| P2 | Node 20 had reached end of life. | Package/CI/local helper target Node 24 LTS. A portable official Node 24.20.0 runtime was checksum-verified locally; the system Node installation is unchanged. See the [official release schedule](https://github.com/nodejs/Release). |
| P2 | Windows checkout failed on three folder names containing `>`, affecting 39 wireframe PNGs. | Renamed to `Error-correction-success`; verified every image blob is identical. `npm run check:paths` rejects Windows-invalid names, reserved device names, and case collisions in CI/pre-push checks. |
| P2 | Browser TypeScript was excluded from the normal compiler check; aggregate scripts omitted some test suites. | Added `tsconfig.client.json`, a combined `typecheck`, directory-based test discovery, and a complete CI command. Two missing map imports were caught and fixed. |
| P2 | Ordinary tests could try to send real provider email; upstream tests shared general CI secrets. | Removed the real-email test, retained mocked dispatch tests, and separated opt-in live feed tests. The nightly workflow uses only an optional TrueTime key and its own local MongoDB. |
| P3 | Pre-push check rewrote the entire repository and spawned `npm`/`npx` incompatibly on Windows. Shell-specific cleanup/E2E scripts were not portable. | Replaced with non-mutating checks using the current Node/npm runtime; added fixed-path Node cleanup and a portable E2E launcher. Removed aggregate `--forceExit` so leaked handles remain visible. |
| P3 | Local/deployment docs and environment template described destructive DEV behavior and weak/missing production defaults. | Updated Node/setup/testing/reset guidance, blank secret placeholders, explicit production minimums, readiness checks, and subscription migration/rollback instructions. |

## Validation record

Detailed workstream checkpoints remain in the linked reports and should not be added together because suites overlap.

- Baseline combined rerun after initial changes: 499 passing tests, 20 deliberately skipped live tests, one outdated health fixture. The fixture now models all three feeds and explicitly tests not-ready states.
- Combined local run: **530/530 passed in 45 suites**, with 20 opt-in live tests excluded from that run. After the final filter-label and cold-start recovery changes, the complete frontend rerun passed **106/106 tests in 16 suites**, including the retained directions regressions. Jest discovery is restricted to the root `tests` directory so temporary checkout copies cannot duplicate or introduce tests.
- Opt-in real-upstream suite: **20/20 passed** with a disposable loopback MongoDB.
- Repository-wide ESLint, server/browser TypeScript, production build, tracked Windows path checks, and Git whitespace checks pass. Full npm audit reports **zero known vulnerabilities**. A negative test confirms an Atlas-style URL is rejected by test setup before application/database imports.
- Local production build: successful on Node 24.20.0. App initialized real feeds in about six seconds on this computer, with approximately 263 MB startup peak RSS; this does not predict Render timing.
- Browser: live account viewing/cancel, route subscription search, notification filtering, and mobile 390 CSS-pixel map inspection; local login, map rendering, keyboard navigation, and subscription add/mute/remove. The subscription dialog closes on Escape and restores focus to the opener.
- Fault-path regressions: stale JWTs and account demotion, timeout/retry/shutdown, concurrent subscriptions, stored HTML-looking text, reversed network responses, changed search/stop selections, failed report retry, and walking-route recovery.
- Local selected-stop directions computed a four-minute walk; Exit restored the map and the system-filter controls responded. The 390 CSS-pixel map had no horizontal page overflow and its main touch controls measured 48 by 48 pixels.
- Before the subscription storage cutover, a sanitized production inventory confirmed one account and zero subscriptions, so there were no existing subscriptions to reconcile on this personal deployment.
- A fresh Windows clone of the committed deployment branch completed with a clean working tree and no sparse-checkout workaround.
- GitHub Actions is **disabled on this fork** (confirmed in the repository Actions page); no hosted CI run is claimed. The updated workflows are committed, and equivalent local lint/type/build/database tests were executed. Review the inherited default-branch workflows before enabling fork Actions.
- Initial hosted audit build `bdd0db1` deployed successfully using Node 24.21.0 after a clean dependency install. All **14 hosted smoke checks passed**, including all five pages, 13 referenced assets, fresh feeds, 102 PRT routes, 15 CMU routes, Atlas persistence, administrator authentication, and Maps configuration. Startup readiness was observed around 112 seconds of process uptime, with 206.5 MB sampled peak Node RSS at that point (218.1 MB in a later check); these are one deployment's observations, not service guarantees.

## Remaining priorities

1. Make the last-active-administrator invariant atomic across instances; require reauthentication for sensitive profile changes and plan stronger password, mailbox verification, logout/refresh-token policies. The personal deployment already uses seven-day JWTs, whereas the generic server fallback is longer.
2. Add an atomic GTFS hot-refresh snapshot, previous-service-day overnight scheduling, CMU-aware date/time filtering, and an explicit stale-vehicle UI.
3. Coordinate visual map restoration on browser hash changes and finish modal focus handling. Decide whether dormant calendar/time/dark controls should ship.
4. Define report retention/anonymization, persisted per-vehicle report state, distributed report/auth abuse controls, and indexed pagination as usage grows.
5. Consolidate duplicated client request/modal/mute handling and split large account/filter/map modules gradually behind behavior tests. The historical [Sigrid refactoring plan](../Sigrid/Top_20_Refactoring_Candidates.md) remains useful context, but its line numbers/complexity measurements are not current.
6. Review inherited Sigrid workflows tied to the original course organization and the original main-branch Render hook before reusing them for another project. This audit keeps the original service's deployment behavior intact.

Real GPS movement, assistive-technology users, all device/browser combinations, provider billing/quota policies, real email delivery, and live AI moderation are not established by this audit. Production mutation paths are tested locally so the audit does not alter live users or broadcast fabricated transit reports.
