# ScottyGo API reference

Base URL: [https://scottygo-ningrui.onrender.com](https://scottygo-ningrui.onrender.com). Local examples use `http://localhost:8080`. Paths below are registered by `server/serve.ts` and the current controllers; older `/map/...` prefixes in historical design documents are not the current HTTP routes. See [ARCHITECTURE.md](ARCHITECTURE.md) for configuration and provider behavior.

## Conventions

Send JSON bodies with `Content-Type: application/json`. Protected endpoints require `Authorization: Bearer <token>` from login. The server validates the active account and session version, not only the JWT signature. URL-encode usernames, route IDs, stop IDs, and search text.

Most successful responses use:

```json
{
  "name": "RoutesRetrieved",
  "message": "Found routes",
  "payload": [],
  "metadata": { "totalItems": 0 }
}
```

`message`, `metadata`, and `authorizedUser` are optional. `payload` contains the actual result, sometimes `null`. Standard application errors use:

```json
{
  "type": "ClientError",
  "name": "MissingParameter",
  "message": "A required parameter is missing"
}
```

Error `type` is `ClientError`, `ServerError`, or `UnknownError`. Check HTTP status and `name`; do not parse human-readable messages. Common statuses are 400 validation/business-rule failure, 401 missing/invalid/inactive session, 403 denied permission/proximity, 404 missing route/stop/subscription, 409 duplicate/limit conflict, 429 authentication throttling, 500 unexpected failure, and 503 unavailable alert feed. Some legacy business errors use 400 instead of 404/409; route-specific exceptions are noted below.

Exceptions to the success/error envelope:

- HTML pages and the memory dashboard return HTML; `/favicon.ico` returns 204.
- `POST /auth/validate` returns `{ "name": "ValidationPassed", "message": "Valid" }`, without `payload`.
- `GET /transit/health` returns a raw health object.
- Production non-HTTPS rejection returns 403 `{ "error": "HTTPS Required", "message": "..." }`. Hosted clients must use HTTPS.

HTML shells are public at `/`, `/auth`, `/account`, `/subscriptions`, and `/notifications`; their protected browser flows require sign-in. Map filters after `#` are browser state, not API query parameters. There is no REST logout endpoint: the client clears its session and disconnects sockets. Password change/deactivation revoke prior server sessions.

## Authentication

These endpoints do not require a bearer token.

| Method and path | Request | Success |
| --- | --- | --- |
| `POST /auth/validate` | `{field, value}`; field is `username`, `email`, or `password`, value a string | 200 `ValidationPassed`; format validation only, not uniqueness. |
| `POST /auth/users` | `{credentials: {username, password}, email, agreed: boolean}` | 201 `UserRegistered`, sanitized user; `Location` points to `/auth/users/:username`. |
| `POST /auth/tokens/:username` | `{password}` | 200 `UserAuthenticated`, `{user, token}`. |
| `PATCH /auth/users/:username` | `{password}` | 200 `UserAgreed`, sanitized user with terms accepted; this is password-backed terms acceptance. |

Registration checks a 4–64 character username containing letters, digits, `.`, `_`, or `-`, rejects reserved names, and enforces uniqueness. Email must be a CMU address (`@cmu.edu` or a subdomain). Current account-password validation requires at least four characters, one letter, one digit, and one of `$%#@!*&~^-+`; only those letters/digits/symbols are allowed and the bcrypt input is capped at 72 UTF-8 bytes. Production bootstrap secrets have stronger minimum lengths, documented separately in [ARCHITECTURE.md](ARCHITECTURE.md).

An inactive account returns 403 `InactiveAccount` at login. A user who has not accepted terms returns 401 `UnauthorizedRequest`; successful password-backed acceptance precedes login. Login and terms acceptance share a process-local budget of 30 failed requests per IP per 15 minutes. Registration permits 30 requests per IP per hour. A 429 includes `Retry-After` in seconds.

Passwords in successful user responses are obfuscated; clients must not interpret that placeholder as a new password.

## Accounts

All account APIs below require a valid active session. Own-account checks use immutable identity; changing a username does not change the account ID.

| Method and path | Permission / request | Success payload |
| --- | --- | --- |
| `GET /account/users` | Administrator | `UsersRetrieved`: username strings. |
| `GET /account/users/search?q=...` | Administrator; optional case-insensitive username substring | `UsersSearchCompleted`: sorted username strings. Empty `q` returns all; a legacy `field` query is not used. |
| `GET /account/users/:username` | Own account or Administrator | `AccountRetrieved`: sanitized account. |
| `PATCH /account/users/:username/status` | Own account or Administrator; `{status: "Active" \| "Inactive"}` | `StatusUpdated`: account. Inactive accounts cannot self-authenticate to reactivate. |
| `PATCH /account/users/:username/privilege` | Administrator; `{privilegeLevel: "Administrator" \| "Coordinator" \| "Member"}` | `PrivilegeUpdated`: account. |
| `PATCH /account/users/:username/username` | Own account or Administrator; `{newUsername}` | `UsernameUpdated`: account. |
| `PATCH /account/users/:username/email` | Own account or Administrator; `{email}` | `EmailUpdated`: account. |
| `PATCH /account/users/:username/password` | Own account or Administrator; `{newPassword}` | `PasswordUpdated`: account; revokes previous sessions. |
| `PATCH /account/onboarding` | Current account; no fields required | `OnboardingCompleted`: `null`. |
| `GET /users/:username` | Own account or Administrator | `UserFound`: sanitized basic user. |

Successful account mutations return 200 and can include `authorizedUser`. `IUserAccount` includes `_id`, `credentials.username`, obfuscated `credentials.password`, `email`, `agreed`, `status`, `privilegeLevel`, `onboardingComplete`, and optional `tokenVersion`. The last active administrator is protected from deactivation/demotion (`LastAdministrator`). Connected views receive account events; deactivation/password change sends `forceLogout` and disconnects relevant sockets.

## Map configuration and search

These endpoints require a session.

| Method and path | Request | Success payload |
| --- | --- | --- |
| `GET /config` | None | `ConfigFound`: `{apiKey, lat, lon, defaultZoom}`. The browser Maps key is intentionally public to authenticated clients; protect it with Google origin/API restrictions. |
| `GET /routes/search?q=...` | Nonempty query | `SearchTransitCompleted`: up to five PRT `IRoute` matches. |
| `GET /search?q=...` | Nonempty query | `SearchTransitCompleted`: `{routes, stops}`, up to five each, combining PRT and CMU; optional `metadata.totalItems`. |

Search matches route IDs/names and stop IDs/names case-insensitively. Natural-language search filters stop words. The combined search includes stop route membership. Use `/search` when both systems are required; `/routes/search` remains the narrower PRT route search.

## Transit

Transit and diagnostic endpoints are currently public. They read cached provider data rather than fetching a fresh GPS fix per request. Empty arrays may be valid (no active bus/arrival) or appear during initialization; inspect `/transit/health` separately. CMU IDs begin with `CMU-`; do not assume the route list, fleet, or route count is fixed.

| Method and path | Parameters / body | Success name and payload |
| --- | --- | --- |
| `GET /transit/bulk` | None | `BulkDataRetrieved`: `{routes, patterns, stops}`. Patterns keyed by route ID; stops keyed by `routeId:DIRECTION`. |
| `GET /transit/routes` | Optional `system=PRT` or `CMU`; omitted means both | `RoutesRetrieved`: `IRoute[]`. |
| `POST /transit/routes/available` | `{date: "YYYY-MM-DD", time?: "HH:MM"}` | `RoutesRetrieved`: scheduled PRT routes from GTFS. This endpoint does not add CMU routes. |
| `GET /transit/routes/:id` | Route ID | `PathGenerated`: `IPattern[]`. |
| `GET /transit/routes/:routeId/schedule` | Route ID | `RouteScheduleRetrieved`: `IRouteSchedule`. |
| `GET /transit/vehicles/:routeId` | Route ID | `VehiclesLocated`: measured `IVehicle[]`; an inactive/unknown route can return an empty list. |
| `GET /transit/stops/:routeId` | Required `dir=INBOUND` or `OUTBOUND`, case-normalized | `StopsRetrieved`: `IStop[]`. |
| `GET /transit/stops/nearbystops` | See nearby-stop parameters below | `NearbyStopsRetrieved`: `INearbyStopsPayload`. |
| `GET /transit/stops/:stopId/predictions` | Optional exact `routeId` filter | `PredictionsRetrieved`: `IPrediction[]`. |
| `GET /transit/detours/:routeId` | Route ID | `DetoursRetrieved`: `IDetour[]`. |
| `GET /transit/detours/:routeId/geometry` | Route ID | `DetoursRetrieved`: detours having geometry. |

Missing route geometry/schedule returns 404 `RouteNotFound`; no stops for a requested route/direction returns 404 `StopNotFound`. An unconfigured CMU geometry adapter retains the legacy status **451** with `ServiceUnavailable`. CMU schedules currently return empty `alerts` and `detours` arrays. Not all systems provide both directions or every optional field.

### Nearby stops

Required: finite `lat` in `[-90, 90]` and `lon` in `[-180, 180]`. Optional parameters:

| Parameter | Meaning |
| --- | --- |
| `radiusMeters` | Positive number up to 10,000; default 1,000. |
| `routeId` | Limit to a route. |
| `system` | `PRT` or `CMU`. |
| `direction` | `INBOUND` or `OUTBOUND` (case-normalized). |
| `date`, `time` | Valid calendar `YYYY-MM-DD`, 24-hour `HH:MM`. |
| `includeRoutes` | Defaults true; string `false` suppresses route membership in result entries. |

Results sort by straight-line distance. `walkMinutesEstimate = ceil(distanceMeters / 1000 × 15)` is a heuristic, not a routed walking ETA. If the 1,000-meter search finds nothing, it expands to 2,000 meters and sets `expandedRadiusApplied: true`.

```json
{
  "name": "NearbyStopsRetrieved",
  "payload": {
    "center": { "lat": 40.4433, "lon": -79.9436 },
    "radiusMeters": 1000,
    "expandedRadiusApplied": false,
    "stops": [
      {
        "stop": {
          "stopId": "example",
          "stopName": "Example stop",
          "lat": 40.444,
          "lon": -79.944,
          "dtradd": [],
          "dtrrem": []
        },
        "distanceMeters": 85,
        "walkMinutesEstimate": 2,
        "routesServingStop": ["61C"]
      }
    ]
  }
}
```

This is a schema example, not current transit data. Walking navigation itself calls Google's browser Routes library; ScottyGo has no REST directions endpoint.

### Transit payload fields

The authoritative TypeScript definitions are in `common/transit.interface.ts`.

| Type | Fields and units |
| --- | --- |
| `IRoute` | `id`, `name`, `system`, hex `color`, `directions[]`, `activeStatus`, `operatingDays[]` (0 Sunday through 6 Saturday). |
| `IPattern` | `direction`, ordered `path: {lat, lng}[]`, optional exact `shapeId`. |
| `IStop` | `stopId`, `stopName`, `lat`, `lon`, optional `routes[]`, added/removed detour references `dtradd[]`, `dtrrem[]`. |
| `IVehicle` | `vid`, `routeId`, `lat`, `lon`, `source: "live" \| "static"`, `lastUpdate`, `isDetoured`; optional `heading` (compass degrees), `speed` (m/s), `delay`, `tripId`, `shapeId`, `direction`, `currentStatus`, `currentStopSequence`, `currentStopId`. |
| `IPrediction` | `stopId`, `routeId`, optional `vid`, `predictedArrivalTime` (Unix milliseconds), `minutes`, `isDelayed`. |
| `IDetour` | `id`, `description`, `startdt`, `enddt`, optional `routeIds[]`, `geometry[]`; each geometry has `detourId`, `direction`, `detourPath[]`, optional `originalPath[]`, using `{lat, lng}`. |
| `IRouteSchedule` | `routeId`, `routeName`, `system`, `operatingDays[]`, `directions[]` with `direction`, `firstTrip`, `lastTrip`, optional `headsign`; plus `alerts[]`, `detours[]`. |

`IVehicle.lastUpdate` is the measurement's ISO timestamp, **not HTTP receipt time**; an empty string means unknown/invalid observation time. Optional speed, bearing, or status must not be treated as zero or inferred from protobuf defaults. Status, when present, is `INCOMING_AT`, `STOPPED_AT`, or `IN_TRANSIT_TO`. PRT `shapeId` and direction come from the scheduled trip. A repeated observation can be older than the latest successful feed fetch. The API returns measurements; client movement estimates never overwrite this payload.

## Subscriptions, reports, and alerts

All `/notifications/...` APIs require a session. `/subscriptions` is an HTML page, not the subscriptions API.

| Method and path | Parameters / body | Success |
| --- | --- | --- |
| `GET /notifications/subscriptions` | Current account | 200 `SubscriptionsRetrieved`: `ISubscription[]`. |
| `POST /notifications/subscriptions` | `{routeId}` | 201 `RouteSubscribed`: subscription. |
| `DELETE /notifications/subscriptions/:routeId` | Route ID | 200 `RouteUnsubscribed`: `null`. |
| `POST /notifications/reports` | Bus report body below | 201 `ReportSubmitted`: accepted `IBusReport`; message explains any omitted moderated comment. |
| `GET /notifications/notifications` | Optional `route`, `bus`, `q` | 200 `NotificationsRetrieved`: newest recent rider notifications. |
| `GET /notifications/alerts` | None | 200 `AlertsRetrieved`: `IServiceAlert[]`; 503 `AlertFeedUnavailable` if the agency feed is unhealthy. |

Saved routes accept PRT and CMU IDs. Each user has at most ten distinct routes, enforced atomically. Duplicate or over-limit additions return 409 `DuplicateSubscription` / `SubscriptionLimitReached`; invalid routes return 404, and removing an unsaved route returns 404 `SubscriptionNotFound`. A subscription contains `_id`, `userId`, `routeId`, `createdAt`. Browser mute state is not a server subscription field.

### Report body

```json
{
  "vid": "example-bus",
  "routeId": "61C",
  "lat": 40.4433,
  "lon": -79.9436,
  "crowdedness": "Few Seats Taken",
  "prioritySeating": "Available",
  "condition": "Clean",
  "comment": "Optional rider observation"
}
```

Required: nonempty `vid`/`routeId` strings of at most 128 characters and numeric valid coordinates. At least one condition answer or nonblank comment is required. Fields:

- `crowdedness`: `Empty`, `Few Seats Taken`, `Standing Room`, `Packed`.
- `prioritySeating`: `Available`, `Occupied`.
- `condition`: `Clean`, `Dirty`, `Average`.
- `comment`: optional string, at most 200 characters.

The server must find the bus on the supplied route. It checks measured bus/user proximity (half a mile), with an administrator distance exemption derived from the authenticated account; clients cannot supply a bypass flag. Report responses add `_id`, `userId`, `createdAt`. Invalid fields/empty report return 400, absent bus 404, and excessive distance 403 `ProximityViolation`.

Only changed conditions publish a new `INotification`; an accepted identical report may have no broadcast. Notifications contain `_id`, `routeId`, `vid`, `message`, `changedFields[]`, `reportId`, `createdAt`. Queries return the last 30 minutes; `route` and `bus` narrow the stored records, while `q` filters message text. There is no pagination or public notification-delete endpoint.

### Agency alert payload

`IServiceAlert` contains `id`, `headerText`, `descriptionText`, `routeIds[]`, and `activePeriods: {start, end}[]`. Optional fields are `url`, `effect`, `cause`, and `severityLevel` (`INFO`, `WARNING`, `SEVERE`). Missing/open period endpoints and unknown metadata must remain unknown. The adapter selects English text where available and validates dates and URLs; clients still render text safely. Communication windows do not necessarily describe the full disruption duration.

## Health and memory

| Method and path | Parameters | Result |
| --- | --- | --- |
| `GET /transit/health` | None | Raw live process/feed summary; always 200 for liveness. |
| `GET /transit/memory/samples` | `limit` default 120, clamped 1–2,000 | `MemorySamplesRetrieved`: recent samples, newest first. |
| `GET /transit/memory/summary` | `limit` default 720, clamped 1–5,000 | `MemorySummaryRetrieved`: time range, RSS/heap trends/peaks, warning/critical counts, diagnostic guidance. |
| `GET /transit/memory/dashboard` | None | HTML diagnostics dashboard. |

Health includes `gtfs.ready`, `vehiclePositions`, `tripUpdates`, `tripshotLiveStatus`, `trueTimeColors.available`, `memory`, and `overall`. Each live-feed object reports `healthy`, `lastFetched`, `consecutiveFailures`, and `error`. `overall` requires loaded GTFS plus the three healthy live feeds; it does **not** include agency-alert health or require TrueTime colors. Check `/notifications/alerts` independently when testing alerts.

Do not treat HTTP 200 or Render Live as proof that transit has loaded. Compare successful feed timestamps with current time and distinguish feed fetch freshness from individual GPS measurement age. Memory samples include timestamp, capture reason, RSS/heap/external/array-buffer MB, uptime, peak values, and warning/critical flags.

## Socket.IO

Connect to the same origin with Socket.IO and `auth: {token}`. A legacy query-token fallback is accepted, but avoid putting tokens in URLs. The server rejects invalid/inactive sessions on connection, revalidates inbound events, and disconnects expired sessions. REST subscription persistence and Socket.IO room membership are distinct operations.

| Client → server event | Arguments / behavior |
| --- | --- |
| `subscribeAccount` | `username` string; join own account room, or another account's room if Administrator. |
| `unsubscribeAccount` | `username` string; leave that account room. |
| `subscribeRoute` | `{routeId}`; join foreground updates for that route. Does not create a persisted saved route. |
| `unsubscribeRoute` | `{routeId}`; leave the route room. Does not delete a saved route. |
| `searchAutocomplete` | Positional `query`, `context`; context `transit` or `notifications`, query at most 500 characters. |

Account/route identifiers in these events are bounded to 128 characters. Reconnect clients must restore desired room memberships. Account rooms use lowercase usernames; route rooms use `route:<routeId>`. Account rename moves existing listeners; losing Administrator privilege removes other-account permissions.

| Server → client event | Payload |
| --- | --- |
| `accountUpdated` | Sanitized `IUserAccount`. |
| `usernameChanged` | Positional `oldUsername`, `newUsername`; sent to administrator username listeners. |
| `forceLogout` | Human-readable reason string; discard session and reconnect only after authentication. |
| `liveNotification` | One `INotification` for a route room. |
| `alertUpdate` | Full `IServiceAlert[]` snapshot, broadcast to connected authenticated clients. |
| `searchSuggestions` | Transit context currently emits up to five strings; notification context emits up to eight `{label, type, routeId?, vid?}` objects. `type` is `route`, `vehicle`, `alert`, or `notification`. Empty/invalid queries can return `[]`. |

The shared socket interface still declares an application `ping` event, but no handler is registered for it. Use Socket.IO's built-in connection lifecycle for liveness. There is no background push protocol, replay cursor, delivery acknowledgement, or durable event queue; the UI refreshes REST snapshots to recover current data after reconnect.
