# Cycle 3 — Understandable alerts and a calmer app

Status: implementation and local acceptance complete; production release in progress. Planned before implementation on 2026-09-19.

The requested cycle focuses on live-notification usability, clickable links, readable service information, and overall visual quality. The user also asks whether an iOS shell would improve the experience. Deployment targets the existing personal Render service; the original project deployment stays intact.

## Findings and plan

- The notifications page initially hides community updates behind search. Its service descriptions are undifferentiated text, including non-clickable URLs; route names cannot lead back to the map. Provide a clear all/agency/community view, safe source links, route actions, information hierarchy, and disclosure for long descriptions.
- The backend discards agency-provided URLs, cause, effect, and severity. Preserve known optional metadata and prefer English translations without inventing urgency. Malformed dates should not discard an entire feed refresh.
- Popups disappear after 30 seconds while a rider may still be reading or using the keyboard, rely on animation events for removal, have no accessible live region or map/history actions, and can accumulate without a bound. Make them actionable, bounded, deduplicated, and persistent while being read.
- App pages use inconsistent headings, surfaces, spacing, and controls. Refine the shared visual language and navigation while preserving the map workspace.
- iOS embedding is an assessment in this cycle, not a native-app release. Compare a Home Screen web app with a native shell using current official docs.

## Use cases and acceptance

1. A rider sees a long agency alert, identifies its route and agency-provided effect, expands the complete text, opens a safe source link, and returns to that route on the map. Text/URLs never execute markup or unsafe schemes.
2. A rider switches among service alerts and community updates or searches a route/bus without stale requests replacing newer results. Loading, partial service failure, reconnect, and empty results remain distinguishable.
3. A live popup communicates reported changes, links to route/history, pauses dismissal on hover/focus/hidden pages, and can always be dismissed even with reduced motion. Bursts/reconnects do not create unbounded duplicate cards.
4. A keyboard or mobile user can operate navigation, controls, and alert content with visible focus, useful touch targets, readable spacing, and no horizontal overflow. Existing map filters, subscriptions, auth, and directions survive.
5. Focused regression tests, repository lint/type checks/build, disposable-Mongo integration checks, desktop/mobile browser QA, production deployment, and hosted smoke acceptance complete before closing the cycle.

## Workstreams

- [Alert center](2026-09-19-alert-center.md)
- [Shared visual design](2026-09-19-app-polish.md)
- [iOS options and recommendation](2026-09-19-ios-options.md)
- Root: agency metadata, popup lifecycle, integration and release verification.

## Implementation and verification

- Backend now preserves explicit known GTFS effect/cause/severity and a validated source URL, prefers an English (then untagged) translation, removes duplicate route IDs, and ignores malformed/reversed communication windows. Missing protobuf fields retain no implied severity; epoch zero remains a valid time. These interpretations follow the [official GTFS alert reference](https://gtfs.org/documentation/realtime/reference/#message-alert).
- Popups now link to route/history, identify rider reports and changed topics, announce politely, and show at most three cards. An in-memory set remembers up to 200 identities to suppress repeat delivery. Timers pause while hovered, focused, or hidden and cancel on dismissal/teardown without relying on CSS animation events. Relative timestamps refresh when reading resumes.
- Page transitions suspend sockets and late arrivals; persisted back/forward restoration resumes the popup component. Root regression review also fixed a route-name formatter that could change a URL containing a CMU route ID.
- Final integrated verification passed **874 tests**: 534 server tests against disposable loopback MongoDB, 320 client tests, and 20 opt-in real-provider tests (50 seconds). Focused workstream runs overlap these totals. Repository lint, server/client type checks, and production build passed on portable Node 24.20.0. No runtime dependency was added.
- Real browser review compared the previous production alerts with the rebuilt local page, including 27 actual agency notices. Source URLs became links, agency effect/cause metadata appeared where supplied, existing line breaks remained readable, and a malformed provider `>Touchatrunk` separator stayed outside the link. Searching Liberty reduced the list, expanding 17 more routes revealed the remaining chips, and a P71 chip opened its map selection.
- Chromium layout checks used local-only same-origin preview frames at **390 × 844** and **320 × 740** because the browser viewport override did not apply. Both alert layouts measured equal client/scroll widths (390 and 320), with no horizontal overflow. Header/menu, account and sign-in cards, and mobile popup placement were reviewed visually. This is layout acceptance, not physical-iPhone/Safari certification; the ignored preview file is not shipped.
- Two test rider reports were submitted only to the disposable local browser database. A real Socket.IO popup showed report topics, a clickable source URL, route/history actions, and a polite live announcement. Read updates opened `route=61C&type=live`; the long report expanded and remained expanded after Refresh. Mobile review led to removing nested body scrolling from popups; only the bounded stack scrolls.
- The local saved-route add flow succeeded, the map menu and controls remained usable, and browser Back from the map restored the route-61C live-update view with two reports and refreshed ages. Independent review found no remaining release blockers after the URL-formatting, focused-dismiss timer, timestamp, and page-lifecycle fixes.

No new external messaging, account permissions, database migration, or paid services were added. Deployment identifier and cleanup will be recorded after hosted acceptance. Rollback target is application commit `21cb07f5651d827098d8535504b864efdc992206`, Render deployment `dep-danddoijnfac738pu6i0`.
