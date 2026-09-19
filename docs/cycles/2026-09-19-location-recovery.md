# Safari location error classification and recovery

The user supplied iPhone Safari screenshots showing the site permission set to Allow while ScottyGo displayed “Location Access Denied.” The application incorrectly used that dialog for every geolocation error, including unavailable positioning and a 10-second timeout. The screenshot therefore does not establish that iOS denied the request.

## Findings and use cases

- Distinguish permission denied (code 1), position unavailable (2), timeout (3), and unsupported browsers. A timeout must not tell the rider that permission was denied.
- Retry after changing settings without requiring a full page reload. The old location button only centered the existing fallback, and the Current Location option could persist campus as a deliberate selection instead of requesting GPS.
- Recover from an initial failure to a real position. Automatic campus fallback was incorrectly treated as a custom selection, suppressing later GPS centering/marker replacement.
- Preserve an explicitly chosen starting point, even if its label is “CMU Campus” or “Current Location.” Losing GPS must not silently discard it.
- Own one watch, ignore late callbacks after retry/page exit, resume on Back restoration, and retry failed requests when returning to the page after Settings.
- Invalidate cached GPS in reporting/directions when permission is revoked; do not continue using a denied position as a live origin.

## Implementation

`GeolocationController` owns watch cancellation and attempts, classifies errors, suppresses repeated same-kind errors until success/retry, permits recovery from transient failures, and provides a 20-second acquisition window. There is no automatic retry loop or permission bypass.

Errors now appear in a nonmodal card with Try again, dismissal, and expandable settings guidance for actual denial. The map remains usable. A transient error after a previous fix explicitly labels the last known location. Success removes the card and the automatic fallback marker.

Map state tracks explicit planned-selection provenance independently of display labels. Current Location resets the explicit selection and requests GPS when needed. Recenter preserves a deliberate planned location; otherwise it retries an unavailable GPS fix. Permission loss clears GPS caches, updates fallback/planned origins, and exits active walking guidance instead of rerouting from a stale GPS coordinate. Restoring a current-location view checks for a newer user selection after awaiting map rendering.

The website cannot override iPhone permissions. In addition to the per-site setting, Location Services and Safari Websites must permit access. These layers and error codes are described by [Apple](https://www.apple.com/legal/privacy/data/en/location-services/), [Apple's settings guide](https://support.apple.com/en-us/102647), and the [Geolocation error reference](https://developer.mozilla.org/en-US/docs/Web/API/GeolocationPositionError). Precise Location improves accuracy but is not a prerequisite for obtaining any position.

## Verification

- All 374 client tests passed, including 51 added regressions for watch ownership, error classification, retry/recovery, planned-location provenance, accessible feedback, nullable directions/reporting GPS caches, and map integration. Repository lint, both TypeScript checks, and the production build passed.
- A local-only browser fixture simulated timeout, denial, unavailable positioning, and a successful fixed coordinate against the actual built map. The fixture is ignored under `private/` and `.dist/`, and is never included in the deployment.
- At a 390 × 664 viewport, timeout copy was distinct from permission denial; help expanded with both iPhone permission layers; retry after denial removed the card and campus marker and produced one GPS marker. A transient error after success showed the last-known-location message. Dismissal followed by the map location button successfully started another request.
- Deterministic tests cover changed-settings return, BFCache restore, late callbacks, preserved custom origins, and real report-button eligibility after GPS invalidation/recovery. No production permissions were changed and no production report was submitted.
- The available browser is desktop Chromium. This does not certify physical iPhone permission prompts or establish the exact error code returned on the user's phone; the corrected production message provides that distinction.

## Release

Production deployment verification pending. No server configuration, credentials, database schema, or paid service changes are required.
