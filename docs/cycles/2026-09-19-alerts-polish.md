# Cycle 3 — Understandable alerts and a calmer app

Status: complete — implemented, tested, deployed, and verified in production on 2026-09-19. Planned before implementation on the same date.

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
- Final integrated verification passed **877 tests**: 534 server tests against disposable loopback MongoDB, 323 client tests, and 20 opt-in real-provider tests (50 seconds). Focused workstream runs overlap these totals. Repository lint, server/client type checks, and production build passed on portable Node 24.20.0. No runtime dependency was added.
- Real browser review compared the previous production alerts with the rebuilt local page, including 27 actual agency notices. Source URLs became links, agency effect/cause metadata appeared where supplied, existing line breaks remained readable, and a malformed provider `>Touchatrunk` separator stayed outside the link. Searching Liberty reduced the list, expanding 17 more routes revealed the remaining chips, and a P71 chip opened its map selection.
- Chromium layout checks used local-only same-origin preview frames at **390 × 844** and **320 × 740** because the browser viewport override did not apply. Both alert layouts measured equal client/scroll widths (390 and 320), with no horizontal overflow. Header/menu, account and sign-in cards, and mobile popup placement were reviewed visually. This is layout acceptance, not physical-iPhone/Safari certification; the ignored preview file is not shipped.
- Two test rider reports were submitted only to the disposable local browser database. A real Socket.IO popup showed report topics, a clickable source URL, route/history actions, and a polite live announcement. Read updates opened `route=61C&type=live`; the long report expanded and remained expanded after Refresh. Mobile review led to removing nested body scrolling from popups; only the bounded stack scrolls.
- The local saved-route add flow succeeded, the map menu and controls remained usable, and browser Back from the map restored the route-61C live-update view with two reports and refreshed ages. Independent review found no remaining release blockers after the URL-formatting, focused-dismiss timer, timestamp, and page-lifecycle fixes.
- Hosted cold-start review found an ambiguous empty state when one feed was unavailable and the other was empty. The follow-up now explains that only available results are empty, while a healthy selected Live or Service view retains its specific message. Three regression cases cover both failed-source directions, search, and healthy Live-only filtering; independent review confirmed the source relevance and branch ordering.

## Production release

- Final application commit: `2efa90ecfa368a6d159c2fd77c1d0c718e95ca5d`, pushed to `codex/render-atlas-setup`. The initial feature release was `adcf0f273164782014bc315a5ce11a1806a789e9`; the follow-up corrects the partial-outage empty state identified during hosted acceptance.
- Final Render deployment `dep-dane2lnf3r2c73dvkl7g` reached **Live** after a 46.5-second automatic deployment on the [personal service](https://scottygo-ningrui.onrender.com/notifications). Feed initialization continued after Live; hosted acceptance waited for readiness rather than treating Live as proof of loaded transit data.
- All **16 hosted checks passed** after final deployment: five pages, their 14 referenced frontend assets, three healthy/fresh transit feeds, TrueTime colors, 102 PRT routes, 15 CMU routes, Atlas persistence, admin authentication/authorization, Maps configuration, and both alert APIs. The agency API returned 27 notices, nine with metadata and source URLs; rider updates returned a valid empty array. Checks created no production reports or subscriptions.
- Hosted browser acceptance observed the corrected partial-feed message during real startup, the distinct healthy Live-only empty message, and the Service-only unavailable message. After initialization, All recovered to 27 notices, searching Garfield found its detour/construction notice, and its Route 89 link opened the map selection. The initial feature release also verified that Agency details opened the corresponding official PRT advisory in a separate tab.
- Local app PID 18196 and disposable MongoDB PID 28828 were verified and stopped (MongoDB gracefully). No listeners remain on 8080, 8180, 8383, 27017, or 27019.
- No new external messaging, account permissions, database migration, or paid services were added. Rollback target: application `21cb07f5651d827098d8535504b864efdc992206`, Render deployment `dep-danddoijnfac738pu6i0`.

## Limits and next steps

This release improves foreground web alerts. It does not implement background push, an installable PWA, or a native iOS application. The [iOS assessment](2026-09-19-ios-options.md) recommends mobile web/PWA improvements first, with an always-running or scheduled server delivery pipeline before reliable background push. Native packaging is justified by selected native features and real-device acceptance, not by a wrapper alone.

Agency text is preserved, including provider spelling/abbreviations; classifications come only from supplied metadata. External links are validated as web URLs, not guaranteed safe editorial content. The center retrieves the existing 30-minute rider-report window; large-scale pagination and server-side preferences for push remain future work. Snapshot failure behavior, popup bursts, hidden-tab pauses, and reduced-motion dismissal have deterministic regression coverage; production outages and notification spam were not induced.
