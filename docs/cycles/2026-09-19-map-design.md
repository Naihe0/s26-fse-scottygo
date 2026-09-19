# Cycle 2 — A clearer, quieter transit map

Status: implementation and automated verification complete; browser acceptance and release in progress. Planned before implementation on 2026-09-19.

The user requested another complete improvement cycle and specifically asked for circular bus icons with directional triangles, a more visible self-location marker, and more refined routes/stops. This cycle prioritizes the map's visual hierarchy and the rendering behavior behind it. Deployment target: the personal `scottygo-ningrui` Render service.

## Findings and design decisions

- Bus illustrations rotate/mirror their entire body and can grow to a 100-pixel canvas, dominating route geometry. Replace them with compact circular badges and an independently rotating heading triangle.
- The GPS dot is only 18 pixels, has no explicit centered anchor, and has no priority above transit markers. Use a larger high-contrast blue marker with a white rim and translucent outer halo, centered at the actual coordinates and drawn above buses/stops. Its halo is a visibility treatment, not a GPS accuracy estimate.
- Integration inspection found a second `location-indicator` dot mounted at `top: 50%; left: 50%` and shown on GPS acquisition, without geographic projection. Remove that duplicate component and its perpetual pulse; only the real geographic marker should represent the rider.
- Mobile integration found the enlarged GPS marker intercepted an adjacent stop's click target. The GPS marker must remain visually above transit symbols but be explicitly noninteractive, allowing stops/buses beneath its halo to receive clicks.
- Every stop uses a 24-by-32-pixel teardrop, producing dense forests of pins along shared corridors. Use small station dots with larger transparent interaction bounds and explicit center anchors. Keep every stop reachable and named.
- Strong base-map POIs compete with app markers; route strokes merge with road details. Quiet the base-map palette and commercial icons, retain geographic context, and separate route colors from roads with restrained white casing.
- Marker animation frames survive newer updates/removal, which can cause obsolete movement and wasted work. Give each marker one cancelable animation and respect reduced-motion preferences.
- PRT/CMU provider adapters replace absent bearings with zero. Zero is a real northward heading, so preserve unknown bearings through the API instead of presenting a misleading pointer. This acceptance was added before that follow-up implementation.
- The new symbol vocabulary needs a discoverable explanation. Add a compact, keyboard-accessible map key with bus heading, stop, current location, planned location, and detour examples. Keep it collapsed initially so it does not cover the map.

## Use cases and acceptance

1. A rider scans a dense corridor: stop dots remain identifiable, route lines remain legible against roads, and buses are visually distinct from stops and the GPS marker.
2. A rider reads a bus direction: north/east/south/west headings rotate only the triangular pointer; the circular badge stays upright. Missing/invalid heading does not invent a direction. Detoured buses retain a distinct amber treatment.
3. A rider recenters or switches between GPS and a planned location: the GPS marker has a clear blue/white halo and correct coordinate anchor; the separate planned-location treatment and existing planning behavior remain intact.
4. A keyboard/mobile user opens the map key, understands the symbols, closes it using Escape or its toggle, and can still use search, filters, zoom, stops, and directions at a 390-pixel viewport.
5. Repeated vehicle updates, marker removal, and reduced-motion settings never leave competing animation frames or update a removed marker.
6. Existing route/filter/history, live-tracking freshness, selected-stop directions, and popups continue to work. Renderer direction/cleanup regressions receive focused coverage.
7. Client tests, repository lint, both type checks, production build, path/whitespace checks, local desktop/mobile browser QA, and hosted smoke/browser verification pass before declaring the cycle complete. No production database migration or settings change is planned.

## Workstreams

- [Bus symbol and heading](2026-09-19-map-buses.md)
- [Route and stop rendering](2026-09-19-map-routes.md)
- [Base map and animation lifecycle](2026-09-19-map-provider.md)
- Root integration: GPS marker, map key, local/browser QA, and production release.

## Execution and release

- The complete local suite passed **776 tests** before final browser/review adjustments. The final complete client rerun passed **262 tests in 27 suites** (six additional regressions), while the unchanged server result remains **520 tests**. The opt-in real-provider suite passed **20 tests** against disposable loopback MongoDB in 54 seconds. The final nonoverlapping totals are **802 passing tests**; focused workstream totals overlap these runs.
- Repository-wide ESLint, server/browser TypeScript checks, and the production build passed on portable Node **24.20.0**. There are no added runtime dependencies.
- Desktop comparison on route 71C confirmed the change from tall repeated stop pins and oversized vehicle illustrations to compact station dots, thin cased lines, circular buses, and a quiet base map. The blue GPS halo remains clearly visible against both roads and route geometry.
- At **390 × 844 CSS pixels**, the page has no horizontal overflow. The collapsed map-key control is 44 pixels high; its open 260-pixel panel fits the viewport, explains the symbols, closes on Escape, and restores button focus. The removed center-screen location dot is absent.
- Pointer targeting under the GPS halo was inspected and tested: after the SDK option plus scoped CSS fix, the hit target is a real nearby stop and its arrivals/directions panel opens. Very close opposite-direction stops may still overlap each other; zooming or direction filters remain available, and clustering is deferred.
- Root review found and fixed hidden directions being revealed during a route-color refresh and malformed detour data aborting subsequent valid overlays. Both have deterministic regression tests.
- A late route-color refresh also updates existing stop rings and their later zoom-sized icons, preserving click listeners and avoiding unnecessary marker replacement.
- Local mobile directions computed a **six-minute walk** to Centre/Millvale, exited cleanly, and left direction controls responsive. Selecting outbound-only route 71C produced **56 stop markers** and the matching URL; browser Back restored the prior filter view.

Production commit, hosted checks, final directions acceptance, and cleanup will be recorded after rollout. Larger backend/account/schedule items remain in the [audit backlog](../audit/README.md).
