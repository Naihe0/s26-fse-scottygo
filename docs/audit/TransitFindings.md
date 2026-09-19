# Transit backend audit — 2026-09-19

## Scope and feature inventory

This audit covers transit controllers/models, static and realtime feed adapters, CMU data/metadata, health, parsing, and the relevant tests. Authentication, notifications/alerts delivery, frontend behavior, dependency upgrades, and deployment changes are covered by the other audit workstreams. No production database, deployment, or service settings were changed by this workstream.

| Feature | Entry point / implementation | Review result |
| --- | --- | --- |
| Combined transit dataset | `GET /transit/bulk`; `TransitModel.getAllTransitData` | In-memory snapshot; startup availability now separately visible in health. |
| PRT/CMU route list | `GET /transit/routes`; GTFS and TripShot services | Preserved both providers; fixed misleading success for unavailable TrueTime colors. |
| Route geometry | `GET /transit/routes/:id`; GTFS shapes / CMU CSVs | Preserved ordering and route/direction joins with streaming fixture tests. |
| Date/time route filtering | `POST /transit/routes/available` | Added real calendar/time validation and removed UTC-to-local day shift. |
| Schedule popup | `GET /transit/routes/:routeId/schedule` | PRT calendars/trip time ranges and CMU timetable/live fallback reviewed. |
| Live buses | `GET /transit/vehicles/:routeId` | Added PRT deadlines and stop/restart guards; checked direction annotation and CMU ID mapping. |
| Stop arrival predictions | `GET /transit/stops/:stopId/predictions` | PRT/CMU UUID dispatch reviewed; PRT elapsed arrivals removed at lookup and minutes recalculated. |
| Stops by route/direction | `GET /transit/stops/:routeId` | Malformed/array direction input now receives HTTP 400 instead of an uncaught async error. |
| Nearby stops | `GET /transit/stops/nearbystops` | Reviewed default/expanded radius, deduplication, distance/order and filters; added input guards. |
| Detours | `GET /transit/detours/:routeId` and `/geometry` | Existing Mongo cache and TrueTime timeout/fallback reviewed; no persistence schema changes. |
| Static GTFS startup | `server/services/gtfs.service.ts` | Streamed download and every CSV table, cooperative event-loop yielding, bounded retries/deadlines and cleanup. |
| Realtime adapters | vehicle positions, trip updates, TripShot live status | Deadline/lifecycle/freshness behavior covered with deterministic tests. |
| Health | `GET /transit/health` | Added `gtfs.ready`; overall readiness requires schedules and fresh successful provider samples. |
| Memory diagnostics | `/transit/memory/samples`, `/summary`, `/dashboard` | Existing bounds, persistence and resource reporting inspected. Access control belongs to the security workstream. |
| CMU static assets/export | CMU CSV loader, metadata, `tools/export-cmu-static-from-tripshot.ts` | Reviewed fallback paths; fixed a malformed-polyline infinite loop in the shared decoder. |

## Findings and implemented fixes

### P1 — Startup blocks the application and duplicates large feed buffers

Evidence: `server/services/gtfs.service.ts` previously downloaded the full archive into an ArrayBuffer/Buffer, used AdmZip to decompress whole CSV strings, and used synchronous CSV parsing for shapes/trips. The observed Render deployment remained without PRT data for over three minutes while startup progressed.

Fix: download directly to a temporary file; use the existing `unzip -p` dependency for all seven tables through a backpressured CSV/Writable pipeline. Consume rows without retaining complete CSV strings or row-object arrays. Yield every 2,048 rows so continuous pipe output cannot starve HTTP/timer callbacks. Route geometry, service calendars, exceptions, trip directions and stop schedules are preserved.

### P1 — A stalled download/table can hold startup indefinitely

Evidence: GTFS download and the stop-times subprocess had no deadline; startup waits for GTFS before starting realtime pollers (`server/app.ts`). The former parser also resolved on CSV EOF without requiring successful unzip exit.

Fix: a 120-second download deadline covers headers and body; each table has a five-minute deadline. Up to three initial attempts use short backoff. Every attempt removes temporary files, kills/awaits failed subprocesses, and clears partial maps. CSV completion and exit code zero are both required. Concurrent callers share one initial load. Once loaded, `load()` returns the ready dataset without clearing or reloading it, so retry failure cannot destroy an established working feed.

### P1 — Hung realtime requests permanently occupy the polling loop

Evidence: PRT vehicle/trip feeds used `fetch` without an abort signal while `fetchInProgress` prevented further polls. Their `stop()` methods only removed timers; late responses and queued poll ticks could still update/restart work.

Fix: PRT requests have a 15-second deadline covering response bodies. All three realtime pollers abort in-flight requests on stop and ignore completions belonging to earlier sessions. CMU retains its 10-second deadline. Shutdown/restart no longer publishes stale responses; the next scheduled request can recover after timeout.

### P2 — Health says healthy before any data and while old data is stale

Evidence: each `isHealthy()` returned only `consecutiveFailures === 0`, which is also true at startup before a first sample. The health response lacked GTFS readiness.

Fix: health requires a successful sample within 90 seconds. `/transit/health` includes `gtfs.ready`, and `overall` requires both schedules and all three feeds. The tracking integration fixture now mocks the independent CMU feed explicitly and covers both schedules-loading and no-first-CMU-sample states.

### P2 — Malformed transit input can hang an Express request or select the wrong day

Evidence: array/object `dir`/`direction` query values reached `.toUpperCase()` outside a try/catch in `transit.controller.ts`. `new Date('YYYY-MM-DD')` in the controller/model is midnight UTC, but GTFS calendar access uses local date fields; on an American timezone server this selected the preceding day. `parseFloat` and `parseInt` accepted garbage suffixes, and impossible dates/times were accepted.

Fix: reject nonscalar filters and invalid enum values; validate numeric coordinates and positive radii; validate real calendar dates and HH:MM times. Construct date components locally and reuse the same helper in nearby-stop filtering. Tests cover Pittsburgh daylight-saving transition dates, impossible dates, malformed times, array filters, and numeric garbage.

### P2 — PRT prediction cache returns arrivals that already departed

Evidence: `TripUpdatesService.getPredictions()` returned the unchanged last snapshot, including elapsed ETAs and minutes calculated when the snapshot was fetched.

Fix: filter past arrivals and recalculate remaining minutes when read, including during temporary feed outages.

### P2 — Failed TrueTime colors are falsely marked available

Evidence: upstream error envelopes or empty route lists became an empty successful response in `TrueTimeService.getRoutes()`, causing the model to mark colors available and skip its existing retry path.

Fix: reject unavailable color data with a sanitized upstream error so the existing GTFS fallback colors and retry behavior take effect.

### P2 — Malformed encoded geometry can loop forever

Evidence: `tripshot-api.ts` decoded values with an unbounded loop and read beyond the input string. At EOF, NaN never met the loop's stop condition. The shared decoder is used by the CMU static-data export tool.

Fix: bound character count/bit width and reject truncated or invalid coordinates. The canonical valid encoded route still decodes unchanged.

## Verification

- Node 24.19.0: 49 new tests across GTFS loading, realtime lifecycle, input validation, TrueTime colors and malformed geometry passed before the additional DST case; the final focused rerun includes 50 tests.
- Shared server unit suite at the earlier checkpoint: 15 suites / 241 tests passed.
- Focused tracking integration rerun: 14 tests passed, using only the explicitly disposable loopback test MongoDB on port 27019. No application/Atlas DB tests ran.
- Backend TypeScript no-emit compilation and focused ESLint passed.
- A real tiny ZIP passed the actual download-stream/unzip/seven-table parsing path on Windows with Git's unzip and Node 24.19.0.
- An isolated public PRT feed load with `--max-old-space-size=320` loaded 102 routes, 18,817 trips and 6,388 stops in approximately six seconds on this computer. Sampled peak Node RSS was 273 MB, including ts-node overhead; maximum measured event-loop delay was 40 ms. The first streaming attempt without cooperative yields showed 3,379 ms delay; that finding prompted the explicit yielding fix. These desktop measurements do not predict Render CPU/network timing or include a full running application's memory. Production performance needs a separate deployment observation; none was performed as part of this audit.

## Remaining improvements and limits

1. **Static schedule refresh:** the daily task refreshes transit caches, not the underlying GTFS archive. A long-lived process will retain the startup timetable. Future hot reload should build a separate snapshot and swap atomically; never clear the live maps before a replacement succeeds. This audit intentionally keeps initial loading idempotent instead of introducing unsafe refresh behavior.
2. **CMU date/time filtering:** nearby-stop date/time filtering intersects routes with the PRT GTFS service calendar, excluding CMU routes. CMU needs its own timetable-aware filter (including overnight service windows) before combined date/time filtering is fully correct.
3. **Overnight GTFS service:** time filtering compares a requested day/time only with that day's service. Full after-midnight support should include the preceding service day for GTFS departure values above 24:00.
4. **Bounded retry exhaustion:** after three initial failures, readiness remains false until another explicit load or process restart. A persisted last-known-good snapshot/background retry policy could improve availability during a prolonged provider outage without increasing the startup memory peak.
5. **Stale vehicle display:** health now reports aging data accurately, but vehicle endpoints still retain last-known markers during feed outages. A product-level stale-display/expiry policy should coordinate API responses and frontend labels.
6. **Resource validation:** run one deployment observation of cold-start latency, peak RSS and readiness transitions on the 512 MB Render instance before claiming a production startup speedup. Keep the existing 320 MB V8 heap cap and unzip availability; no paid-tier change is required by these code changes.
