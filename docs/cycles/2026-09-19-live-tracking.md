# Live tracking freshness and background work — 2026-09-19

## Use cases and acceptance criteria (written before implementation)

1. A rider selects a PRT route or CMU shuttle: show a quiet, accessible map status while loading, then distinguish fresh live buses, a healthy feed with no active buses, delayed positions, and unavailable tracking. Failures must never say there are no buses.
2. A provider stops updating: consult the existing provider-specific health response and each vehicle's `lastUpdate`; positions older than 90 seconds, invalid/far-future timestamps, and scheduled positions cannot appear as live. Remove expired markers even between network polls, including their live popup.
3. Directions track several routes: fetch each selected route once per cycle, use one shared health check, and retain fresh buses from working providers while explaining partial availability. A failed route must not leave its old markers behind.
4. A rider switches tabs or leaves the page: stop scheduled requests, cancel the current cycle, and remove live markers. Returning to the page immediately refreshes the same selected route(s). Stopping or switching routes must reject late responses and clear timers/status.
5. A slow endpoint: only one cycle runs at a time, bounded by 15 seconds, followed by the existing 30-second polling cadence. Cancellation and account/route session guards prevent delayed updates from repopulating a changed map.

## Evidence and bounded implementation plan

`server/controllers/transit.controller.ts` returns cached positions without provider health in the vehicle envelope. `/transit/health` already exposes independent PRT and CMU health and last-fetch times; no backend changes are needed. Both live feed services consider data older than 90 seconds unhealthy. The existing tracker uses intervals, retains single-route markers on errors, and reports an empty result with a toast regardless of provider status.

Implement a self-mounting status component with a polite live region and compact map styling; replace tracker intervals with one cancellable cycle plus scheduled refresh; validate freshness and expire markers locally; add optional cancellation/deadline support to `getVehicles`. Keep existing popup/report interactions and route filters. Coordinate navigation integration with the map/filter owner. No production settings, databases, dependency changes, or deployment are in scope.

Verification: focused fake-timer tracker regressions for fresh/empty/unavailable/stale/partial data, expiry, slow requests, hidden-page pause/resume, cancellation and route/account races; API contract tests; client TypeScript and focused ESLint. Record results and limitations below after implementation.

## Results

Implemented in `vehicle-tracker.ts`, `live-tracking-status.ts`, `live-tracking.css`, and the vehicle API request. The status identifies loading, live buses on the selected route(s), a healthy empty result, delayed positions, provider/network failure, partial multi-route availability, and background suspension. It uses a polite live region and avoids repeating unchanged announcements. Direction visibility remains separate from route-wide bus counts.

Each cycle shares one health request, deduplicates route requests, runs at most 15 seconds, and schedules the next cycle 30 seconds after completion. Requests receive an abort signal and timeout. The tracker removes cached markers after provider/network failure and removes any vehicle at 90 seconds of age, even while a request is pending. It permits up to 30 seconds of future clock skew; invalid positions and non-live records are excluded. Hidden tabs and pagehide cancel requests, timers, and markers; visibility/pageshow resume the selected routes immediately. Obsolete route/account sessions cannot apply results.

Popup cleanup now calls `dismissPopup('bus')`: clearing tracking no longer closes an unrelated route or stop popup, and a stale bus popup/docked tab cannot survive cleanup.

Focused agent validation used the bundled Node 24.19.0 runtime (version rechecked from the exact executable), separate from the newer local app runtime used for the main task's final checks: **29 focused tests passed** (24 tracker/lifecycle cases, 5 API cases), client TypeScript passed, focused ESLint passed, and changed-file whitespace checks passed. Tests cover provider failures versus healthy empty results, invalid/expired/future/scheduled positions, automatic expiry, partial providers, repeated routes, request deadlines, hidden-page and bfcache lifecycle, cancellation/account changes, and actual popup utility preservation. All network calls were mocked; no database or production changes were made.

Integrated browser layout checks at narrow and wide viewports, complete-suite results, and production acceptance are recorded in the [cycle execution record](README.md). The separate filter-controller health poll is outside this change; selected-route and directions vehicle polling is paused in the background. Provider freshness remains based on the existing backend health contract plus browser comparison of vehicle timestamps; no new backend endpoint or data migration was introduced.
