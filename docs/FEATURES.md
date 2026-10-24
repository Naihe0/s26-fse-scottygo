# ScottyGo features and current screens

ScottyGo combines Pittsburgh Regional Transit (PRT) buses and CMU shuttles in one map. The current personal deployment is [scottygo-ningrui.onrender.com](https://scottygo-ningrui.onrender.com/). This guide describes the implemented app; [ARCHITECTURE.md](ARCHITECTURE.md) covers development and operations, and [API.md](API.md) describes its interfaces.

## Five-iteration rider experience release

This release is developed and accepted in five rounds. Each row contains five independently usable additions. Acceptance includes behavior tests and browser checks at phone and desktop sizes; release evidence is recorded below as rounds ship.

| Round | Rider goal and features | Acceptance target |
| --- | --- | --- |
| 1 — Read and select the map | Unified bus/stop/route overlap chooser; shared-stop deduplication; zoom-aware stop density; route emphasis; selected-stop halo | Every overlapping object can be selected; hidden objects are excluded; the same stop is drawn once; selected context stays visible. |
| 2 — Find a place to board | Nearby stop list; search the map area; 5/10/15-minute walking range; current-route filter; next-arrival comparison | Distance-sorted stops respect range and route; area search preserves GPS; independent prediction failures remain recoverable. |
| 3 — Explore a route | Route stop browser; current-bus list; nearest boarding stop; explicit bus follow mode; full-route overview | Direction and search work together; lists open the right map object; dragging pauses follow; overview respects visible geometry. |
| 4 — Repeat a journey | Saved stops; named planning places; recently viewed routes/stops; named filter presets; share a stop | Browser-local items survive reload, are account-scoped, and reopen current data; shared stop links survive sign-in. |
| 5 — Read relevant updates | Saved-route alert scope; read/unread tracking; priority/newest sorting; route grouping; share update summaries | Filters compose without losing updates; changed notices become unread again; shared text contains safe public links only. |

### Round 1 — accepted

Shared stops now use one marker with all serving routes; below zoom 14, ordinary stop dots hide while a selected stop retains its halo. Route strokes adapt to zoom and the selected route receives stronger emphasis. Tapping a crowded map point opens **Choose on map**, with separate bus, stop, and route groups. The chooser uses a consistent 24-pixel radius at every zoom and excludes hidden or removed objects.

Acceptance: 547 client tests passed (45 suites), plus lint, TypeScript and production build. A fixed CMU browser fixture at 390 × 760 verified two overlapping buses, one shared stop and two routes; selecting the stop/route invokes the correct action, overview hides ordinary dots, and highlighting retains the stop. Live-map phone acceptance and deployment evidence are recorded with the release commit.

### Round 2 — accepted

**Near me** opens a distance-sorted stop list. Choose an approximate 5, 10 or 15-minute walking range, search the current map center, or return to the current/planned starting point. When a route is selected, switch between that route and all routes. The nearest five stops compare their next arrivals, refreshing every 30 seconds while the panel is visible. Failed predictions remain distinct from a valid empty response; tap any stop to open its full arrival card.

Acceptance: 16 new behavior tests cover range filtering, sorting, cancellation, route scope, independent prediction failures and bounded concurrency. Browser checks at 390 × 760 returned 28 stops for 10 minutes, 3 for 5 minutes, and 2 after filtering to 61C. Area search changed the query center; the original starting point remained available. A stop-row selection centered the map and opened stop 7117. No upcoming arrivals were supplied in this live overnight sample; populated arrivals are covered by deterministic tests.

![Nearby stop comparison on a phone](wireframes/current/nearby-stops-mobile.jpg)

## Map and route discovery

After signing in, the map starts near your location when permission is available, or near CMU campus otherwise. Search by route number, route name, stop name, or stop ID. Selecting a result opens that route or stop without requiring you to find it manually on the map.

### Finding and filtering with fewer interruptions

- Search immediately shows a loading state while a short typing pause groups requests. New input cancels an older request; clearing or closing the list prevents late results from reopening it. Failed searches offer a **Try again** action, and empty results suggest another route number or stop name.
- Results distinguish **Routes** and **Stops**. Use Up/Down and Enter to select while focus stays in the input, or tap a result to close the phone keyboard. Escape closes the results. Composing text with an input method does not submit partial characters.
- The route picker keeps its search input stable as results change. The selection remains visible in a summary; choose **All routes** to remove the route filter, then apply the draft. A search with no matches includes a clear-search action.
- System and direction panels have descriptive headings, full-row toggles, and explicit **Apply** and **Cancel** actions. Closing or pressing Escape cancels the draft and restores the opening control. An empty selection explains what will disappear; loop shuttles remain visible when both directional filters are off.
- Filter inputs use phone-safe text sizes and controls have generous touch targets. Panels stay within the available viewport, with scrollable content and reachable actions.

These interactions cover the main rider flows: find a route or stop, refine the map, revise a draft without losing the current view, and recover from a failed request in place.

| Control or action | What it does |
| --- | --- |
| Route filter | Choose a route and inspect its operating days, first/last trips, directions, alerts, and available detours. |
| PRT / CMU filter | Show either transit system or both. PRT is the default. |
| Direction filter | Show inbound, outbound, or both. CMU loop services may have only one available direction. |
| Shared schedule filters | A shared map URL can carry date/time filters for scheduled service; the current map toolbar exposes route, system, and direction controls. Schedule filters do not simulate future bus positions. |
| Route paths and stops | View colored route geometry, direction cues, stop markers, and available detour overlays. Selected routes receive stronger emphasis. |
| Zoom and recenter | Adjust the view or return to a close view around your location, approximately a 200-meter radius where the viewport allows it. |
| Map key | Explain route, stop, bus, estimated-position, delayed-position, and personal-location symbols. |
| Clear all filters | Restore default route/date/time/system/direction filters and close their panels. A chosen planning location is preserved. |
| Copy view link | Share the current route and filters. Coordinates, planned locations, query strings, and account tokens are excluded. A manual-copy dialog appears if clipboard access fails. |
| Browser Back / Forward | Restore the previous route/filter view. A shared view also survives the sign-in flow. |

### Current desktop map

![Current desktop map with route and tracking controls](wireframes/current/map-desktop.jpg)

### Current phone layout

![Current map at phone width](wireframes/current/map-mobile.jpg)

The screenshots are captures of the current app in a local preview, replacing the historical design mockups. The location is a fixed CMU demonstration point, not a user's personal location. Bus data and agency notices come from public feeds and are snapshots rather than fixed examples.

## Live buses and movement

Each bus has **one circular marker**, containing a bus symbol, with a triangle indicating its heading when known. Tapping it centers and zooms the map to that bus. Its compact card identifies the route/bus and the position state, with **Report** and **Alerts** actions immediately available. Expand **Details** for additional tracking information. The map's tracking banner provides a brief status; tap it to see more information. Keyboard users can open either disclosure and close it with Escape.

Between actual GPS reports, the marker estimates motion along the known route. It uses the trip's shape when available, observed route progress, heading, speed, and stop information. Eligible moving buses continue updating between network refreshes, including when the latest report is already delayed on arrival. New actual reports correct the **same marker** by sliding it toward the updated position. No separate predicted or actual marker is drawn.

Reported, estimated, and delayed states remain distinguishable. A delayed position can remain visible for up to 15 minutes; an authoritative healthy feed can remove a bus that is no longer present. Predicted movement slows near mapped stops, and a reported next stop can trigger a brief dwell before departure. Explicit stopped/zero-speed observations hold position. Prediction also stops when evidence is too weak, a terminal is reached, or its time/distance bounds are exhausted. A provider outage pauses the marker where it is until a distinct report arrives. Animation honors reduced-motion preferences and pauses in hidden tabs.

The moving icon is an estimate, not a new GPS measurement. It does not change the source report time, arrival predictions, or the real coordinates used to check whether a rider is near a bus.

### Selected bus and details

![Selected bus with its compact information card and expandable details](wireframes/current/bus-details.jpg)

## Stops, arrivals, and walking

Select a stop to see the serving routes, upcoming arrivals, delay indicators, and estimated walking time when a starting location is available. Predictions refresh while the stop card remains open. Empty results and unavailable data have separate messages; a scheduled route is not a promise that a live bus or arrival estimate currently exists.

Nearby-stop discovery uses the current or planned starting point and respects the selected filters. A rider can choose **Set a different location** through Places search, then return to **Current Location** later. A planned point helps with route discovery and walking directions, but does not grant GPS access or establish proximity for a bus report.

The Directions action starts walking navigation to a stop, showing its path and step instructions. GPS updates support progress and rerouting. Loading can be cancelled; failed requests time out and restore the map rather than leaving it locked. Exiting directions restores the latest selected map filters.

## Location access and recovery

Your location uses a distinct high-contrast marker and accuracy treatment. Recenter explicitly requests a closer view; ordinary GPS updates do not repeatedly take over your chosen zoom or interrupt a selected stop or active directions.

Location feedback distinguishes blocked permission, timeout, unavailable position, and unsupported browser. The map remains usable. **Try again** restarts location acquisition; the blocked-permission message offers expandable settings help. Browser-level permission and the device's location permission both need to allow access. A successful retry clears the feedback and restores location-dependent actions. The app cannot override a device setting itself.

On phones, controls and sheets use the available viewport and safe-area spacing. Keyboard focus, touch targets, wrapping text, and reduced motion are supported. Desktop browser tests at phone dimensions do not replace acceptance on a physical iPhone.

## Alerts and rider updates

The **Notifications** page offers **All updates**, **Service alerts**, and **Live updates**. Search remains within the selected view. Service alerts come from PRT; live updates are rider reports from the last 30 minutes.

- Agency cards identify affected routes and show supplied effect, cause, severity, and notice dates when available. Missing metadata is not invented. Long descriptions and large route lists expand on demand.
- Explicit HTTP(S) links in agency text and rider comments are clickable. Unsafe link schemes and embedded markup are not executed. Agency-source links open separately; route chips open the affected route on the map.
- Rider cards identify the bus, route, reported changes, and age. They remain distinct from agency alerts. Relative time is accompanied by an accessible absolute timestamp.
- Refresh, foreground polling, and live events update results without clearing the search or expanded details. If one source fails, successful data remains visible with a source-specific message.
- Foreground popups link to the route and update history. They are bounded and deduplicated, pause dismissal while being read or focused, and can be dismissed directly.

### Current alert center

![Current notification center with readable agency notices and route actions](wireframes/current/alerts.jpg)

These are notifications inside the open web app. Background push, lock-screen notifications, an offline map, an installable PWA, and a native iOS app are not implemented.

## Saved routes and reports

The **Subscriptions** page saves up to **10 routes per account**. Add a PRT or CMU route, open its map, remove it, or mute its foreground popups. Saved routes persist on the server. Mute choices are stored in this browser and do not remove the saved route.

The add-route sheet marks successful additions as **Saved**, preserving the current search, scroll position, and focus. Removal uses the explicit action on a saved-route card. Loading, no saved routes, no search matches, and request failure have distinct messages; failed loads can be retried in place. A failed save keeps the route available to try again.

![Add-route sheet with a clear saved state and preserved search](wireframes/current/saved-routes.jpg)

To report bus conditions, select a bus and open its report action. Choose any combination of crowdedness, priority-seat availability, vehicle condition, and an optional comment of up to 200 characters. At least one answer is required. The normal proximity limit is half a mile from the bus's reported location; the browser also requires usable GPS and a recent bus report. Delayed or predicted display coordinates never substitute for measured proximity. Administrators have a server-side proximity exemption, but still use the browser's location/freshness safeguards.

Changed conditions create a live route update. An identical condition report does not create another notification. Comments pass moderation; a flagged comment can be omitted while valid condition answers are accepted. The submission result explains that outcome.

## Accounts and navigation

Registration requires a unique username, a CMU email address, a valid password, and the terms flow. Inline validation explains invalid fields. Sign in, sign out, page navigation, a first-use map tour, and account editing are available from the app shell.

Short feedback uses one dismissible message at a time, with a timeout that pauses while hovered or focused. Map message dialogs move focus to their confirmation button, keep background controls inactive, and return focus when closed with OK or Escape.

| Role / state | Available account actions |
| --- | --- |
| Member or Coordinator | View and edit their own username, CMU email, and password; deactivate their own account. Coordinator currently has the same account-management scope as Member. |
| Administrator | Search/select users, edit accounts, change Active/Inactive status, and assign Member, Coordinator, or Administrator privilege. |
| Inactive account | Cannot authenticate or keep using an active session; an administrator must reactivate it. |

The last active administrator cannot be removed through deactivation or demotion. Password changes revoke previous sessions; account changes are reflected in connected views. Optional account-status emails are sent only when the deployment has email configured. Changing a username preserves the immutable account identity and saved routes.

## Operational visibility and limitations

The [memory dashboard](https://scottygo-ningrui.onrender.com/transit/memory/dashboard) shows process memory, historical samples, peak context, and CSV export. It complements the transit health endpoint described in [API.md](API.md).

Live transit and directions depend on their upstream services and the network. Startup can temporarily show no route data while GTFS and caches load. The app distinguishes readiness, delayed measurements, provider failure, and valid empty results where those signals are available. A Free Render service can sleep; the foreground app cannot guarantee continuous background delivery while its server is asleep.
