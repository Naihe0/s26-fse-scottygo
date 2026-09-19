# Alert center: readable, actionable transit updates

Status: implementation and focused automated verification complete; integrated browser acceptance and release are recorded in the parent cycle report.

## Findings

The notification page initially shows only service alerts, while typing silently changes the data source. Live updates have no direct browse view. Feed URLs are displayed as plain text. Dense, unstructured descriptions and route IDs make it hard to understand an alert or return to the affected route. Active windows exist in the API but are hidden. Failed searches can look like empty results, and socket refreshes ignore searches.

## Use cases and acceptance plan

1. A rider opens Notifications and chooses All, Service alerts, or Live updates with clearly labeled filter buttons. Search stays within the chosen view and updates immediately from the current snapshots.
2. A rider reads an agency alert, identifies its affected routes and available effect/severity metadata, expands a long description, and opens a safe HTTP(S) source link. Source text remains plain text: HTML, scripts, unsafe protocols, and malformed URL content never execute.
3. A rider opens an affected route on the existing map using an encoded route link. Long route names, URLs, and text wrap without horizontal overflow.
4. A rider can distinguish live rider reports from agency alerts. Report topics come from actual changed fields, dates have an accessible absolute timestamp, and open-ended service windows are labeled without invented dates or severity.
5. Loading, no-match, unavailable, and partially stale states are distinct. Refresh keeps the last successful snapshot if one source fails, and older requests cannot overwrite a newer refresh or current search. Socket updates refresh the current view without clearing the user's query.
6. Keyboard users can operate filters, search, refresh, links, and native details controls; focus styles, adequate hit areas, and reduced-motion behavior are included.

## Implementation boundaries

Own the notification page, its styles, and focused helpers/tests. Share safe text-link formatting with live popups. No new dependency, database migration, or changes to subscription permissions. Parent cycle owns upstream alert metadata, live popups, shared app styling, browser acceptance, deployment, and release documentation.

## Implemented behavior

- The default All updates view presents current PRT service alerts and the existing API's last 30 minutes of rider reports. Service alerts and Live updates are explicit filter buttons; text search stays inside the selected view, operates immediately over the current snapshots, and avoids per-keystroke network requests.
- Links from feed titles, descriptions, and rider comments are created with DOM text nodes and anchors. Only explicit HTTP(S) URLs pass validation; script/data/relative/credential-bearing/control-character/backslash URLs are rejected. Trailing prose punctuation and malformed `>Touchatrunk` feed separators remain literal text outside links. External links use `noopener noreferrer`.
- Route chips open the existing encoded map route URL. Six chips are initially visible, with a native disclosure for any additional affected routes. URL route/bus prefills keep exact ID matching until the rider edits or clears search; `type=live` and `type=service` select the requested view.
- Cards distinguish PRT alerts from rider reports. Recognized effect, cause, and severity labels are shown only if supplied. Rider topics derive from actual changed fields. Absolute report timestamps remain available alongside human-readable relative ages.
- Long descriptions use native details/summary controls. Alert windows show valid local dates, explain missing ends, and explicitly distinguish the agency's communication window from disruption duration. IB/OB shorthand is explained without rewriting the agency's actual notice.
- Parallel data snapshots are bounded by a 20-second timeout. Refresh retains a successful previous source if that source later fails and names the stale/unavailable source. Current query/filter state always applies when responses arrive; request versions prevent a superseded refresh from changing the list.
- Manual Refresh, coalesced agency/rider socket events, and a 60-second visible-page refresh keep results current. Hidden tabs skip polling. BFCache suspension disconnects the page's alert socket and aborts pending work; restoration reconnects the same socket and refreshes without duplicate listeners. Normal page exit cancels timers and listeners.
- Unchanged snapshots retain their DOM and update relative times. Changed snapshots preserve expanded card disclosures and focused route/source/text links. Responsive cards, readable line spacing, wrapping URLs, focus outlines, and mobile route-link hit targets complete the visual treatment.

## Verification

With portable Node 24.20.0, the focused `alert-content.test.ts` and `notification-rendering.test.ts` suites passed **34 tests**. They cover unsafe content/protocols, punctuation and provider separator cases, encoded route actions, recognized metadata, date handling, long-description disclosures, exact prefills, local filtering, partial failure, older-response ownership, focus/disclosure preservation, time updates, hidden-page polling, and BFCache restoration. Owned TypeScript ESLint checks and the full client TypeScript check passed.

The parent cycle owns real browser acceptance, the integrated test/build results, production deployment, and remaining broader work. This feature does not add background push notifications or infer disruption urgency from keywords. Polling and service availability remain dependent on the existing provider feeds and application connection.
