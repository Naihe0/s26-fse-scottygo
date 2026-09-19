# iPhone delivery options for ScottyGo

Assessment date: September 19, 2026. This is a feasibility assessment and future implementation plan. It does not add an iOS project, push delivery, a service worker, or paid infrastructure.

## Recommendation

Yes, ScottyGo can run inside an iOS app. Apple's `WKWebView` embeds interactive HTML, CSS, and JavaScript in a native interface; Capacitor provides a reusable web-to-native runtime built on it. The existing TypeScript client and Render/Atlas backend can therefore be retained. [Apple WKWebView](https://developer.apple.com/documentation/webkit/wkwebview), [Capacitor iOS](https://capacitorjs.com/docs/ios).

My recommendation is to improve the mobile website first, then offer a Home Screen web app with opt-in push. A native app becomes worthwhile when riders need useful integrations such as notification-to-route navigation, native sharing, or a departure widget. Embedding the present website alone would provide easier launching but would not automatically improve map rendering, alert clarity, startup latency, or background delivery. That judgment follows from the architecture below, rather than a claim that web-based apps cannot provide good usability.

## What the repository supports today

| Area | Evidence | Consequence for an iOS version |
| --- | --- | --- |
| Web client | [package.json](../../package.json) builds five Parcel HTML entry points with TypeScript and custom elements. | Most interface code is reusable; it is not currently a single bundled native entry point. |
| API and authentication | [TransitApiService](../../client/scripts/services/transit-api.service.ts) uses relative URLs and a bearer token from browser storage. | A bundled app needs an explicit HTTPS API origin, tested authentication storage/lifecycle, and narrowly configured cross-origin access or a native networking adapter. |
| Live alerts | [live-notifications.ts](../../client/scripts/components/live-notifications.ts) connects Socket.IO to the page origin and joins route rooms. [app.ts](../../server/app.ts) polls transit feeds and broadcasts changes. | These are updates to an active web session. There is no device push registration or server-side Web Push/APNs delivery in the reviewed source. |
| Location and maps | [map.ts](../../client/scripts/map.ts) calls browser `watchPosition`; the [Google provider](../../client/scripts/maps/google-map.provider.ts) draws the map. | Permission denial, background/resume, Google key restrictions, and location prompts require real iPhone testing. An app shell does not create background location support. |
| Routing and sharing | [url-sync.ts](../../client/scripts/state/url-sync.ts) encodes map selections in URL fragments; page navigation also uses server paths. | Native launch/deep-link handling must translate to the existing route state and preserve the web fallback. |
| Installation/offline | No app manifest, service worker, Push API registration, or native iOS project exists in the inspected client/build configuration. | A Home Screen shortcut is possible, but an engineered standalone/offline/push experience remains future work. |
| Mobile layout | The map already uses dynamic viewport units and safe-area offsets. Other pages also need keyboard, enlarged text, and standalone safe-area validation. | Desktop mobile emulation is useful but cannot certify iOS behavior. |

The observations describe the baseline reviewed for this cycle. The accompanying alert and visual improvements retain the web delivery model.

## Delivery choices

| Approach | Rider benefit | Work and limits |
| --- | --- | --- |
| Continue mobile web | Open a shared route immediately; no installation required. | Improve readable alerts, touch targets, empty states, reconnection, and phone layout. All users benefit. |
| Home Screen web app | Dedicated launch icon, standalone presentation, optional system notifications. | Add manifest/icons, a deliberate service-worker strategy, explicit push opt-in, and a server push pipeline. No App Store submission required. |
| Capacitor app with bundled client | Reuse most UI while adding native capabilities and distribution. | Adapt multi-page routing and API origins, implement native permission/push/deep-link bridges, maintain native builds, and test on devices. |
| Direct `WKWebView` loading the hosted site | Small feasibility prototype retaining current same-origin behavior. | Still depends on network/server startup; custom navigation, external links, permissions, and failure handling need work. A prototype is not an App Store release. |

Home Screen web apps support Web Push on iOS/iPadOS 16.4 and later. Permission must follow a user action; delivery can appear on the Lock Screen. This requires the Push API, Notifications API, and service-worker handling, and does not require Apple Developer Program membership. Manifest standalone mode provides a separate app presentation. These capabilities belong to the proposed Home Screen implementation, not the current ScottyGo release. [WebKit: Web Push for web apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

For a production Capacitor version, bundle the compiled client and call the hosted API. Capacitor documents `server.url` as a development live-reload option, not its production deployment approach; its `webDir` expects a final `index.html`. ScottyGo's current five-page build therefore needs a packaging/routing adaptation, not just a configuration pointing at Render. [Capacitor configuration](https://capacitorjs.com/docs/config).

## Background notifications are a separate feature

Neither a wrapper nor a Home Screen icon converts the existing socket into reliable background notifications. A future delivery pipeline should persist eligible alert events and per-device subscriptions, deduplicate by event and recipient, retry transient failures, expire stale advisories, and remove revoked endpoints. Route mute preferences must be enforced on the server for background delivery; the current browser-local preference alone is insufficient. Notification taps should open the affected route and clearly show whether the alert has expired.

Provider polling must continue when no rider has a page open. Render Free services can spin down after 15 minutes without inbound traffic. If this deployment remains on that plan, a separately scheduled ingestion/delivery worker or suitable continuously running service is an explicit prerequisite for timely background alerts. No plan upgrade is part of this cycle. [Render Free service lifecycle](https://render.com/docs/free#spinning-down-on-idle).

For native push, Capacitor exposes device registration and notification actions, but requires the iOS Push Notifications capability. Its standard plugin does not support iOS silent push. [Capacitor Push Notifications](https://capacitorjs.com/docs/apis/push-notifications). Apple also treats background refresh notifications as low priority and can delay or throttle them; they cannot be used as a guaranteed continuous transit polling loop. [Apple background notification delivery](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app).

## Staged use cases and acceptance gates

1. **Mobile web polish — a contained web release.** A rider can read an advisory, follow its source, return to the map, and change subscriptions with one hand. Verify 390-pixel layout, larger text, visible focus, keyboard interaction, dark mode, safe areas, reconnect, and denied location. This cycle addresses the alert/visual portion; actual Safari/device certification remains distinct from browser emulation.
2. **Installable web app — a separate client milestone.** A rider adds ScottyGo to the Home Screen and reopens the selected route. Add manifest/icons and a versioned offline shell. Acceptance: standalone launch, stable login and navigation, understandable network failure, and no stale cached arrivals presented as live. Do not cache authenticated responses indiscriminately or claim offline Google Maps support.
3. **Opt-in background route alerts — a backend and delivery milestone.** A rider subscribes to a route, explicitly enables device notifications, and receives an actionable advisory while ScottyGo is closed. Build authenticated endpoint registration, event outbox/delivery, server preferences, expiration, and revocation. Acceptance: denied permission remains usable; route mute/logout prevents inappropriate later delivery; duplicate retries do not create duplicate notices; tapping opens the correct route; expired notices are labeled. Test on a physical iPhone with the app closed and under a locked screen, including network loss and server restart.
4. **Native pilot — only after a useful native feature is selected.** Start with bundled UI, native push, and verified route deep links; defer widgets/background location until separately designed. Acceptance: sign-in and report submission, map permissions, external advisory links, keyboard/safe areas, VoiceOver, cold notification launch, resume/reconnect, and web fallback all pass on real devices. A widget would additionally require bounded stale-data behavior and a native extension. Keep App Store publication as a separate release decision.

These are scope boundaries, not delivery-time estimates. The push milestone changes backend persistence and delivery operations; the native milestone additionally needs Apple tooling and device testing. They should not be folded into a cosmetic web release.

## Tooling and distribution

The current Windows workspace can build the website, but iOS compilation/testing needs access to a Mac with compatible Xcode, locally or through a Mac build service. Current Capacitor v8 documentation requires Xcode 26.0 or newer and lists iOS 15+ runtime support; recheck the selected release's requirements when beginning implementation. [Capacitor environment setup](https://capacitorjs.com/docs/getting-started/environment-setup), [Apple Xcode requirements](https://developer.apple.com/xcode/system-requirements).

Universal links require a website association file plus the native Associated Domains configuration; existing browser hash links alone do not provide that integration. [Capacitor deep-link guide](https://capacitorjs.com/docs/guides/deep-links).

App Store distribution also introduces signing, developer membership, release metadata, review, and continuing native maintenance. Apple's minimum-functionality guideline expects useful features and UI beyond repackaging a website; approval is evaluated for the actual product and cannot be promised for a wrapper. [Apple Developer Program enrollment](https://developer.apple.com/programs/enroll/), [App Review Guideline 4.2](https://developer.apple.com/app-store/review/guidelines/#minimum-functionality).

No iOS build, iPhone test, native push test, or App Store submission was performed for this assessment. Its output is a concrete route to a more useful mobile experience while keeping this cycle focused on the web application.
