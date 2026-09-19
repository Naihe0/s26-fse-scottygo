# Backend audit — 2026-09-19

Scope: authentication, accounts, permissions, sockets, subscriptions, bus reports, notifications, email/moderation, database startup, and alerts polling. Transit feed logic and browser rendering are covered by the other audit reports. No production database records or cloud settings were changed for this audit.

## Feature inventory

| Flow | Implementation | Assessment |
| --- | --- | --- |
| Register, validate fields, accept terms, log in | `auth.controller.ts`, `user.model.ts`, `user.validation.ts` | Password hashing and explicit field assignment are present; malformed input and unsafe new usernames now rejected. |
| Account list/search/read, status/role changes | `account.controller.ts`, `user.admin-rules.ts` | Admin/member ownership rules checked against current account; concurrent last-admin protection still needs work. |
| Rename, email/password change, onboarding | `account.controller.ts`, `mongo.db.ts` | Immutable identity survives rename; reset/deactivation now invalidate existing sessions. |
| Map account/config APIs | `map.controller.ts` | Arbitrary other-account lookup closed. Maps key is intentionally a browser credential; Google API/referrer restrictions remain an operational setting. |
| Live account/route subscriptions and autocomplete | `app.ts`, `socket-session.service.ts` | Socket identity, active status, session version, payload types, expiry, and role-room permissions enforced. |
| Route subscriptions | `notification.model.ts`, `notification.controller.ts`, `mongo.db.ts` | Owned by authenticated immutable user ID; Mongo enforces route uniqueness and the ten-route limit atomically in one per-user document. |
| Bus reports and live notifications | `notification.model.ts`, `mongo.db.ts` | Required answers, enums, proximity, moderation, change detection, route broadcasts, and 30-minute TTL; numeric/comment validation hardened. |
| Account emails and comment moderation | `email.service.ts`, `moderation.service.ts` | Optional providers, bounded requests, local moderation fallback; legacy usernames escaped in email HTML. |
| PRT service alerts | `alerts.service.ts` | Deadline/recovery added and duplicate change broadcasts fixed. |
| Admin bootstrap / database initialization | `env.ts`, `serve.ts`, `mongo.db.ts` | Production secrets validated, existing administrator preserved, destructive reset requires explicit opt-in. |

Paths in this table are under `server/controllers`, `server/models`, `server/services`, or `server/db` as appropriate.

## Confirmed fixes

| Severity | Finding and evidence | Fix / regression evidence |
| --- | --- | --- |
| P1 | REST and socket authentication previously verified only JWT signatures; a disabled/deleted account retained signed-token access. `controller.ts`, `app.ts`. | Shared `authentication.service.ts` resolves current account by immutable ID, requires active/agreed account, validates claims and HS256. Tests cover active, missing, disabled, malformed, and expired sessions. |
| P1 | Password reset/deactivation could not revoke a previously issued token, including after reactivation. `mongo.db.ts`, `auth.controller.ts`. | Account/JWT `tokenVersion`, incremented atomically with password reset/deactivation and checked on every request/event. Legacy version-zero sessions remain valid until revoked. REST/integration tests assert old tokens fail and fresh logins work. |
| P1 | `GET /users/:username` returned any member's account/email to any authenticated user. `map.controller.ts#getUser`. | Current owner or administrator required before target lookup; negative IDOR and positive owner/obfuscation tests. |
| P1 | Socket account subscriptions trusted a mutable token username; old tokens after rename could resolve another user's privileges. Demoted administrators also retained account rooms. `app.ts`, `account.controller.ts`. | Identity resolves by ID; current username/role controls rooms. Demotion removes admin/other-account rooms, deactivation/password reset disconnect by ID, passive sockets expire. Focused rename, room, expiry, and revalidation tests. |
| P1 | Production could issue JWTs with `someDefaultKey` and seed `admin/admin` if environment values were missing. | `env.ts` rejects missing, short, or known placeholder production secrets. Minimum JWT key 32 characters; bootstrap password 12. Existing administrator passwords are never reset. Config regression tests cover defaults/placeholders. |
| P1 | Development startup implicitly dropped collections; a mistaken development DB setting could erase data. `serve.ts`, `MongoDB.init`. | Startup preserves data unless `ALLOW_DB_RESET=true`; `init()` itself checks this flag and forbids production resets. Offline regression verifies refusal occurs before connecting. Root also isolated all automated tests to a validated loopback test database. |
| P2 | Markup/oversized usernames and non-string auth fields were accepted or produced internal errors. `auth.controller.ts`, `user.validation.ts`. | New/renamed usernames allow 4–64 letters/numbers/periods/underscores/hyphens. Existing names can still log in. Typed credentials/email/agreement; password maximum 72 bytes avoids bcrypt truncation. Frontend output escaping remains necessary for legacy/user-generated data. |
| P2 | Non-string socket unsubscribe/search arguments could throw before error handling. `app.ts`. | Type/length checks precede string operations. Account subscription helper explicitly tested with invalid values. |
| P2 | Reports accepted non-finite/out-of-range/string coordinates and unbounded/non-string comments, causing invalid proximity arithmetic or downstream errors. `notification.model.ts`. | Finite numeric latitude/longitude with valid ranges, bounded nonempty string IDs, 200-character string comments, stricter enum validation. Seven malformed-report regression cases stop before upstream lookup/persistence. |
| P2 | Notification status cache advanced before saving its notification, suppressing future retries after a DB error. `notification.model.ts#submitReport`. | Cache advances after successful notification persistence. Existing status-change tests still pass. |
| P2 | Alerts fetch had no deadline, potentially locking its poller indefinitely. Email/moderation also waited indefinitely. | Alerts abort after 15 seconds; provider email/moderation use 10-second signals. Alerts test proves timeout clears the lock and a following poll recovers. |
| P2 | Login/registration had no abuse budget and Express trusted arbitrary forwarded-IP chains. | Thirty failed/pending login attempts per IP per 15 minutes (successful responses refunded), thirty registration attempts/hour, generic 429 and Retry-After. Terms-password verification shares the login budget. Ten-thousand-entry caps and periodic request-driven expiry cleanup bound memory. Hosted environments trust one ingress hop, local environments ignore forwarding. Five regression tests cover limits, successful requests, expiry/capacity, late completion, and spoofed forwarded IPs. |
| P2 | Subscription count/duplicate checks ran separately from insertion, so concurrent adds could exceed ten or return unhandled duplicate-key failures. | `SubscriptionSet` stores each user's list in one document; conditional Mongo `$push` atomically enforces route uniqueness and capacity. `$pull` removes entries. Existing duplicate requests retain the 409 response and never create another record. Four Mongo integration tests cover parallel distinct/duplicate adds, removal freeing a slot, and legacy migration. |
| P3 | Alerts compared new data to the penultimate feed, duplicating broadcasts and occasionally missing a reversal. `alerts.service.ts#applyFetchedAlerts`. | Compare against current alerts; repeated identical feed test emits one event. |
| P3 | Bootstrap keyed only on username `admin`, recreating it after an administrator rename. `mongo.db.ts#seedDefaultAdmin`. | Any existing administrator prevents reseeding; never overwrite an existing `admin` account. |
| P3 | Automated account tests deliberately attempted one real provider email. | Removed this test and actual-service import; mocked dispatch tests retained. |

UUID generation now uses Node's `crypto.randomUUID`; dependency updates are owned by the root audit. All user/account Mongo queries already returned lean/plain objects and response/event serializers already obfuscated passwords. The early suspected nested Mongoose `_doc` password leak was investigated and **not confirmed**.

## Remaining improvements

| Priority | Evidence / remaining limitation | Suggested work |
| --- | --- | --- |
| P2 | `user.admin-rules.ts` counts active admins separately from the update. Two simultaneous demotions/deactivations can both pass. | Serialize this invariant in a Mongo transaction with a shared invariant document/lock; test concurrent administrators. A process-only mutex would not protect multiple instances. |
| P2 | Login/registration limits are process-local and reset on restart; reports have no abuse limit. Old password policy permits four characters. Authentication errors distinguish nonexistent users, wrong passwords, and inactive accounts. | Move limits to a shared store when scaling, add report throttling, and decide a stronger password/identity-verification policy with migration. |
| P2 | A valid session can change its own password/email without re-entering the current password; email checks syntax/domain only. `account.controller.ts`, `user.validation.ts`. | Require reauthentication for sensitive changes and verify mailbox ownership; preserve admin reset workflow. |
| P2 | Logout removes the browser token; another copy remains usable until expiry, reset, or deactivation. PROD default JWT lifetime remains 365 days. | Shorter access-token lifetime with rotating refresh sessions and server-side logout/revocation. |
| P2 | Bus report locations are client supplied; syntactically valid spoofed coordinates cannot prove physical proximity. Admin proximity bypass is intentional. | Document trust model; add abuse monitoring and report throttles rather than claim GPS is verified. |
| P2 | `NotificationModel.initialize` does not actually reconstruct prior status, despite its comment. In-memory state is process-local and unbounded by age; report/notification writes are not transactional. | Persist per-vehicle status, scope by system/route where IDs can overlap, add retention/atomic reporting; test restart and concurrent reports. |
| P2 | Raw bus reports retain account ID, comment, and precise coordinates indefinitely; notifications alone have a 30-minute TTL. `BusReportSchema`, `NotificationSchema`. | Define report retention/anonymization and add a corresponding TTL or cleanup policy. |
| P3 | User listing and recent-notification queries have no pagination; substring search loads matching windows in memory. | Bound response sizes and implement indexed pagination. |
| P3 | Email and AI moderation are optional. Without keys, account emails are skipped and moderation uses a basic profanity/threat blocklist; relevance is not checked by the fallback. | Expose provider availability in operational checks; configure verified sender/key if those features are required. |
| P3 | Socket handshake still accepts token query parameters for older clients. | Migrate all clients to `handshake.auth.token`, then remove query support to reduce URL-log exposure. |

## Validation

Offline focused run: six backend suites, 98 tests passed, followed by seven new deadline/production-configuration tests. `npx tsc --noEmit` and ESLint on all changed backend sources passed. Root coordinates the complete suite, local Mongo-backed integration/REST checks, and browser flows. No live production account mutations were used for this audit.

Follow-up throttling/atomic-subscription work: three focused suites / 58 tests and TypeScript passed. The four new Mongo concurrency tests are included for root's coordinated complete run; they use only generated test identities in the validated loopback test database.

## Subscription migration and proxy operations

The first subscription access copies that user's existing `Subscription` records into a `SubscriptionSet` using an atomic insert-if-absent operation. Legacy records are retained; the new set becomes authoritative and removed entries are never re-imported. Existing over-limit legacy lists are preserved but cannot grow until they have fewer than ten entries. Deploy as one writer version: do not leave an old application instance writing legacy records during migration or roll back to the old writer without a reverse migration. No production migration was run by this audit.

The proxy setting follows Express's bounded-hop model instead of trusting all forwarded entries. If the ingress topology changes, verify the trusted hop count before changing it; see the [official Express proxy guide](https://expressjs.com/en/guide/behind-proxies/).
