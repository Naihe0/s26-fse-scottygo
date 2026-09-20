# Close-up map focus and honest bus movement

The requested cycle adds a closer view around the rider, focuses a selected bus, retains delayed bus markers, and estimates movement between position reports. The release target is the personal ScottyGo Render service.

## Findings and planned rider flows

| Finding | Rider flow and acceptance condition |
| --- | --- |
| GPS centering used fixed zoom 15, which showed too much area on phones. | Opening a current-location view or tapping recenter shows approximately a 200 m radius, adjusted to the viewport. Later GPS updates do not repeatedly change the rider's zoom. |
| Bus selection only opened a popup. | Tapping a bus centers the displayed marker and opens a close street-level view while preserving its information popup. |
| Positions older than 90 seconds, unhealthy feeds, and request errors erased markers. | Keep a clearly marked last report during delays/outages, show its age, stop estimation, and eventually expire it. A successful fresh feed that removes a bus remains authoritative. |
| Polling every 30 seconds plus a five-second slide compounded upstream latency. | Fetch the server's cached positions more promptly and render smoothly between reports using their actual measurement timestamps. |
| Route variants overlap, and Protobuf optional fields can expose defaults that were never reported. | Match the exact GTFS trip shape when available. Preserve unknown speed/status/timestamp values, and decline prediction when evidence is insufficient. |

## Motion design

The estimator is separate from map rendering. It combines source-timestamped observations, route geometry, travel direction, reported speed, and observed progress. It must reject duplicate/out-of-order samples, implausible jumps, ambiguous geometry, and inconsistent direction. Prediction follows route curves and is bounded in time and distance, slows with uncertainty, and respects stopped/approaching-stop information. Missing geometry, detours, and stale reports must not produce unlimited straight-line motion.

There is exactly one marker per bus. The estimator keeps raw feed coordinates and timestamps internally, while the existing marker moves along the estimate and slides into a corrected position when the next GPS report arrives. No extra reported-position marker is drawn. Bus reports, proximity checks, directions, and arrival predictions continue to use their authoritative inputs. Popup wording explains estimates and last reports; delayed markers cannot masquerade as fresh live locations. Hidden tabs and reduced-motion preferences suppress continuous animation.

Route shapes and stops reuse the existing bulk/static caches. A single animation scheduler handles visible buses; geometry is not searched or downloaded on every frame. The upstream polling rate is unchanged.

The distinction between vehicle measurement time and feed creation time, optional Protobuf field presence, and the 90-second freshness guideline follow the [GTFS Realtime reference](https://gtfs.org/documentation/realtime/reference/) and [best practices](https://gtfs.org/documentation/realtime/realtime-best-practices/). Estimation improves continuity but cannot establish an unreported bus position as fact.

## Implementation

`client/scripts/services/vehicle-motion.ts` owns observation history and the display estimate. `VehicleTracker.setRouteGeometry()` receives patterns and stops from the existing filter-controller cache. Geometry is compiled lazily for tracked buses; route projection occurs when measurements arrive, while animation uses cached progress along the matched shape. An exact trip shape takes priority when supplied. Ambiguous variants, incompatible directions, detours, implausible movement, and missing geometry suppress extrapolation. Raw API coordinates and source timestamps remain separate from displayed positions.

| Behavior | Implemented limit or rule |
| --- | --- |
| Observation confidence | Estimator freshness is fresh through 30 seconds, aging through 90 seconds, and stale afterward. The tracker marks positions delayed and disables reporting at 90 seconds, or immediately when the provider/request is unavailable. |
| Forecast movement | Requires credible progress between distinct source-timestamped measurements on a matching route. Model speed is capped at 20 m/s; observations implying over 35 m/s are rejected for motion. A measurement must be within 35 m of the matched path. |
| Forecast horizon | At most 60 seconds of measurement age and 200 m of route progress. Speed decays after the first 10 seconds toward rest at 60 seconds. Estimates stop at the route end or before the next applicable stop, with an 8 m stop buffer. Stopped/near-arriving buses and effectively zero speed do not continue drifting. |
| Reconciliation | The same marker slides from its displayed position toward the corrected, age-aware estimate, or toward the raw fix when no forecast is justified. Corrections take 600–2,000 ms. A shared confident route allows corrections up to 300 m along its curves; without that match, local corrections are limited to 100 m. Larger discontinuities reset rather than animate across the map. No second raw-position marker is created. |
| Delayed retention | Valid live coordinates remain visible for up to 15 minutes from their measurement time. Missing or invalid timestamps show “Update time unavailable” and expire 15 minutes after first observation; repeated payloads do not renew that deadline. Invalid future timestamps do not become fresh merely as the local clock catches up. |
| Authoritative removal | A successful healthy provider response removes absent buses immediately, including a healthy empty response. Request/health failures retain the previous valid raw locations, stop estimation, and show delayed clock badges. Old or duplicate timestamps cannot move a measured position backward; duplicate safety metadata can still stop a forecast. |
| Polling and animation | The next cached-backend poll starts 10 seconds after the previous cycle completes, with a 15-second request deadline and no overlapping cycles. One shared animation loop renders at about 30 fps only while a visible bus is moving. A shared one-second timer updates age and retention; unchanged freshness ticks do not notify raw vehicle-state subscribers. |
| Lifecycle | Hidden tabs, page suspension, and reduced-motion preferences stop continuous motion and show raw positions immediately. Stationary or horizon-limited estimates stop requesting frames. Route changes, removal, logout/session changes, and explicit stop clear owned markers and work; cached route geometry remains reusable. |

Reported, estimated, and delayed states use one circular bus icon, with an estimated ring or a delayed clock cue as appropriate. Accessible marker titles include the position state and report age. The popup distinguishes estimated position from details supplied by the latest report, updates status/speed/next-stop values, and disables Report for delayed or unavailable data. Report proximity is checked against the raw bus coordinates and current rider GPS, including when the displayed marker has moved ahead; administrator proximity bypass does not authorize stale reports or replace missing GPS.

`client/scripts/utils/map-focus.ts` provides a shared approximately 200 m focus radius for explicit rider and bus focus actions. It preserves an already closer zoom and places the selected point in the visible area above search/popup overlays. Bus selection attaches its popup before computing focus so the popup is included in that measurement. Routine position updates move the bus marker without recentering the map.

## Verification

The complete client suite, server unit suite, and transit integration suite passed **811 tests across 61 suites**, with zero failures. Repository ESLint, both TypeScript checks, formatting, and the production build passed. Regressions include 42 estimator cases, a single marker across successive GPS reports and intermediate correction frames, raw-coordinate report proximity, delayed/unknown retention, successful empty removals, mixed provider failures, invalid/duplicate/out-of-order timestamps, popup focus, marker titles, reduced motion, frozen estimates, hidden-page recovery, and rejection of obsolete request/frame callbacks. The integration suite verifies exact trip-shape metadata through the vehicle HTTP endpoint. Test output is kept privately in `private/bus-motion-final-tests.json`.

Local browser preview with the actual Google Maps renderer confirmed one marker per bus. Clicking the bus opened its popup and changed zoom from 16 to 18. A simulated source outage retained the marker with a clock badge and disabled Report; a healthy empty response removed that marker and its popup. A three-minute-old report remained visible and selectable. At 390 × 664, the selected bus stayed above its popup (marker y=147–191, popup starting at y=354), with one bus marker and no horizontal page overflow. In the full application, current-location recenter chose zoom 17 on the phone viewport and zoom 18 on desktop. These are desktop Chromium viewport checks, not physical iPhone certification.

The final full application also displayed four real 61C buses, including reports that became delayed. Selecting a real bus changed the phone map from route overview zoom 11 to zoom 16 and kept its single marker above the popup (marker y=223–267, popup starting at y=374). The local API supplied exact shape IDs for all four 61C vehicles and both observed 71B vehicles.

A private three-minute live-feed replay covered seven snapshots and 56 observations across P1, 61C, and 71B; source reports were approximately 28–87 seconds old on arrival. Fourteen observations produced bounded estimates, and replay processing took about 9 ms. Only one measurement qualified as a strictly future holdout (642 m prediction error versus 680 m holding the previous report). This sample is far too small to establish accuracy improvement; it is recorded transparently as integration/coverage evidence, alongside deterministic regression tests. Files remain ignored under `private/`; no simulation fixture or replay is deployed.

## Release

Released to [ScottyGo](https://scottygo-ningrui.onrender.com) from commit `e3691c10937178cbbd30535db8af6562ee99a4fb` on `codex/render-atlas-setup`. Render deployment `dep-dankbdff3r2c73e4gnbg` is **Live**, with a 55.6-second deployment duration. The original separate deployment was not changed.

After startup, `/transit/health` reported ready GTFS and healthy live feeds. All **14 production smoke checks passed**: five application pages, 14 frontend assets, transit readiness, TrueTime colors, 102 PRT routes, 15 CMU routes, current Atlas persistence, administrator login/authorization, and Maps configuration. The deployed vehicle API supplied exact trip-shape IDs for all four observed 61C buses. The private smoke record is `private/bus-motion-deployment-smoke.jsonl`.

Hosted browser verification confirmed the updated map key and four unique 61C bus markers. Selecting bus 3532 changed zoom 13 to 17, opened its delayed-position age, and disabled stale reporting. At 390 × 664, its single marker occupied y=223–267 above the popup at y=358.4, with no horizontal overflow. The browser's existing location permission also produced the closer initial GPS view at zoom 18; no permission settings were changed. The deployed map was left open at normal browser dimensions.

Local preview/application servers and the disposable test MongoDB were shut down after verification. Temporary browser viewport overrides were reset; ignored fixtures and replay files remain local. No production bus reports, subscriptions, schema changes, credentials, or account settings were changed in this cycle.

Rollback reference: application commit `9064216550f5db909850e0499316083ba78dcf07`, previously live Render deployment `dep-danf3l2jnfac738rgmug` (the prior location-recovery release).
