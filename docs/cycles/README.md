# Improvement cycles

## 2026-09-19 — Reliable map exploration and live tracking

This cycle follows the [repository audit](../audit/README.md). The user requested one complete discovery → use-case planning → implementation → testing → production release cycle, with freedom to select useful changes. The personal Render service is the release target; the original deployment and its database remain separate.

### Problems and selected scope

| Area | Evidence and user impact | Planned outcome |
| --- | --- | --- |
| Navigation and filter consistency | URL restoration updates state without consistently redrawing the map. Clear all filters leaves the previous search text visible. Asynchronous map changes can overlap. | One coordinated restoration path for filters, history, controls, and graphics; latest user action wins. |
| Shareable views | Existing filter URLs are serializable, but the interface has no clear sharing action. | An accessible Copy view link action with confirmation and a manual-copy fallback. Links contain route/filter selections, never location or credentials. |
| Live tracking confidence | Cached vehicle markers can outlive a failed request. Vehicle polling continues while the page is hidden. | Clear fresh/empty/unavailable status, safe stale-marker handling, and bounded polling that pauses in background tabs and resumes promptly. |
| Detour request efficiency | Concurrent cache misses and repeated geometry reads independently call the same upstream provider. | Coalesce equivalent requests and use a bounded short-lived geometry cache without retaining failures as success. |
| Nearby-stop query bounds | Any positive finite radius is accepted, allowing excessive scanning/serialization for a single request. | Reject radii above 10 km before transit work, preserving the normal 1 km/2 km discovery behavior. |
| Saved-location recovery | The saved planned-location loader checks types but accepts out-of-range coordinates and empty labels. A damaged or old saved value can move the map to an unusable location. | Validate stored coordinates and labels before restoring them; fall back to normal location discovery without crashing or reusing bad data. |

### Use cases and implementation plans

- [Map navigation and sharing](2026-09-19-map-navigation.md)
- [Live tracking and background efficiency](2026-09-19-live-tracking.md)
- [Backend detours and query bounds](2026-09-19-backend.md)

Each workstream records its use cases and acceptance criteria before implementation, followed by the resulting behavior and test evidence. Changes are scoped to this cycle; broader GTFS hot-refresh, account transaction, and report-retention work remains in the original audit backlog.

### Release acceptance

1. Selecting routes/filters, using browser Back/Forward, and clearing filters keeps URL, controls, and rendered map consistent, including rapid changes and directions cancellation.
2. A copied view link opens with the same supported route/filter choices; sharing works without leaking planned/GPS location or authentication data, and clipboard failure has an accessible fallback.
3. Vehicle status distinguishes successful empty data, stale data, and request failure. Hidden pages stop starting vehicle requests; returning to the page refreshes safely.
4. Concurrency tests prove equivalent detour requests share upstream work; TTL, cache bounds, failure retries, and existing geometry behavior remain correct.
5. Oversized nearby queries fail with an explicit validation response before expensive work.
6. Lint, server/browser type checking, production build, relevant regressions, and integration checks pass before release. The production rollout must be observed healthy and its browser flows verified.
7. Valid saved planned locations survive reload. Malformed JSON, out-of-range/nonfinite coordinates, empty/oversized labels, and unavailable browser storage fall back safely; ordinary geographic boundary values remain valid.
8. Custom filter switches retain a real input hit area and show a visible keyboard-focus indicator. Browser inspection found the existing native inputs were zero-sized and their styled sliders had no focus treatment; preserve their appearance while fixing the interactive input.

### Execution record

Implementation and local acceptance are complete. Production verification and completion will be recorded here after the release succeeds.

- Browser baseline: selecting route 61C, then Clear all filters, returned the URL to the bare application path while the search input still displayed `61C`.
- Saved-location recovery: validates parsed structure, finite geographic bounds, and a nonempty label of at most 512 characters. Valid labels are trimmed. Fourteen tests pass for reload, GPS denial, malformed storage, geographic boundaries, and blocked storage.
- Combined server verification: **494 tests passed in 33 suites**, with 20 opt-in real-provider tests excluded from that run. Unit, REST, and integration tests used the disposable loopback database; no production test writes were performed.
- Final integrated client verification: **184 tests passed in 23 suites**. Repository-wide ESLint, server/client TypeScript checking, production build, and Git whitespace checks passed using the official portable Node **24.20.0** runtime. Individual workstream runs overlap these totals.
- Opt-in real-provider verification: **20 tests passed** against a disposable loopback database. The first attempt lacked Git's `unzip` in the test shell PATH and failed GTFS-dependent assertions; after matching the existing local helper's runtime setup, the complete suite passed in 48 seconds. Windows testing documentation now explains this prerequisite. Together with the server/client runs above, **698 tests passed** across the three final runs.
- Local browser acceptance: route 61C → 61D → Back → Forward restored both search and route stop markers. Clear all filters emptied the search and reset the URL; Back restored the previous view. Copy view link generated only the canonical route/filter fragment. Opening a copied `61D` / outbound-only view while signed out preserved those selections through login, including the direction switches.
- Local directions regression: selecting the Forbes/Morewood stop while route 61D was active computed a **21-minute walking route**. Exit restored the route and outbound-only controls; the map remained interactive.
- At a **390 × 844 CSS-pixel** viewport, the page had no horizontal overflow, all five main map controls measured **48 × 48 pixels**, and live-tracking status fit beneath search. The direction switch accepted pointer and Space-key interaction after the hit-area/focus fix.
- Live tracking visibly distinguished fresh bus counts from delayed provider locations during browser checks. Deterministic tests cover failures, partial results, hidden-page pause/resume, timeout, cancellation, and expiry; browser observations do not establish all provider failure states.
- The local HTTP endpoint returned **400 / OutOfBounds** for a 10,001-meter nearby-stop query, matching the shared validation limit.
- Full dependency audit: **zero known vulnerabilities**. This cycle adds no runtime packages.
