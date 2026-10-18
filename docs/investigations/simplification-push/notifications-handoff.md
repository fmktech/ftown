# Notifications implementation

Worker `/root/npx_review`, explicit `gpt-6.1-sol` / `high`; frozen exact scope
in ownership.json. Others share this checkout; no other files are writable.
Applying design-tests, plan-migration and upgrade-dependency skills.

## Behavioral test plan (before code)

| Taxonomy | Required cases |
| --- | --- |
| Empty/missing | unavailable VAPID, unauthenticated browser, no subscribers, unknown session |
| Boundaries | payload16KB, queue100, five-minute budget, bounded subscription/event fanout |
| Invalid | malformed keys/JSON/date, wrong event key, vendor URL/credential/port attacks |
| Dependency | push410 expiration, transient503/network/timeout, malformed DB/config |
| Concurrency | atomic delivery lease, duplicate event requests, one queue worker |
| Idempotency | same question UUID, once idle per owner/bridge/session, no later-subscriber backlog |
| Unicode/time | emoji messages, sanitized controls, ISO event timestamps, future/replayed events |

Highest risks: cross-account pushes/SSRF; replay and concurrent duplication;
startup idle flood; closed-tab delivery and explicit permission UX. Tests use
real parser/queue/store behavior with network/DB/browser boundaries doubled.
Root alone executes browser/E2E and migration fixture checks.

## Migration plan

All three new tables (subscriptions/events/deliveries) and their indexes are
additive; no existing table/data changes or backfill. Deploy migration0005
before enabling VAPID/new code. Old code ignores these tables and remains
rollback-compatible. New code with missing config remains unavailable and
does not request browser permission. Missing schema returns unavailable.

Postgres CREATE TABLE takes locks only on the new empty relations; indexes
are built on those new cold/empty tables, never on existing hot relations.
There is no table rewrite/backfill or existing-data constraint validation.
Forward-only rollout: roll back code/unset VAPID on failure and leave inert
tables intact; do not delete durable dedup records on code rollback.
Verification before enablement: to_regclass for all three tables must be
non-null; cross-owner send tests and duplicate/no-backlog tests must pass.
No production migration/configuration is executed by this worker. Root owns
fixture migration verification; this is a documented deployment prerequisite.

Status: implementation started; ui dependency/build lease active.


## Implementation handoff

Completed the exact notification ownership scope plus the root-granted
`e2e/scripts/start-services.sh`. Source changes: optional postcommit attention
observer; bounded hosted bridge queue; authenticated config/subscription/event
routes; owner/rate/recipient-snapshot/delivery-lease persistence; explicit sidebar
opt-in/opt-out; service-worker push/click/receipt and active-account privacy
binding; additive migration/schema/fixture; dependency/type additions; focused
unit and browser specs; deployment/limits documentation. Exact paths remain in
ownership.json. No unrelated modified notes were touched.

The old Dashboard native Notification effect is removed. Worker bindings use
SHA256 owner identity, are committed before UI enable/logout transitions, and
are checked before display. Display and owner changes are serialized; clearing
binding also closes existing notifications. API GET bypasses SW caching. The
control is mounted in the sidebar for desktop/mobile, allowing account mismatch
cleanup without opening a menu. Notification links target /dashboard and consume
the session query once, so later polling cannot force selection back.

Checks performed (RTK):
- Focused bridge `attention-store` + `push-notifier`: 8/8 pass.
- Focused UI six test files: 24/24 pass after owner-binding/privacy regressions.
- UI and e2e TypeScript noEmit: pass.
- `bash -n e2e/scripts/start-services.sh`: pass.
- `git diff --check`: pass.
- Actual web-push generateRequestDetails encryption exercise: encrypted payload,
  aes128gcm, POST; no network or secret values printed.
- Tests distinguish wrong owner/browser token, SSRF URL, bad key/date/body,
  concurrent/duplicate SW display, logout/switch late push, no config/schema
  prompt, delayed bridge retry, active lease retry and already-sent no-resend.
  Real SQL recipient/replay/auth invariants are assigned to root browser spec.

No worker E2E/server/browser/CI/npm-publish/migration/configuration actions were
performed. Root owns full integrated build/suites, migration fixture execution,
focused browser execution, rendered screenshot inspection, cleanup and landing.

### Dependency review

New coupled group: web-push3.6.7 (registry/repository verified, MPL-2.0,
Node>=16) and @types/web-push3.6.4 (MIT). Read upstream API docs. No prior API
usage to migrate. Explicit aes128gcm defaults exercised, TTL300/urgency high and
absolute HTTPS AbortSignal timeout5000 supplied. generateRequestDetails encrypts;
our HTTPS request never follows redirects or enables proxy routing.

Lock regenerated by npm, including a clean temporary package-lock-only resolver
check: twelve new entries, no existing version changes; npm pruned the existing
optional hoisted @emnapi/runtime entry while its nested platform entries remain.
No manual lock edits. Audit reports13 existing findings (4moderate/5high/4critical)
in existing auth/Next/protobuf/tooling dependencies; none names the new web-push
or added transitive group. No unrelated dependency upgrades were attempted.
Reverting UI dependency/source changes restores the prior package behavior;
additive database tables should remain inert on rollback as planned above.

### Root execution prerequisites

Use normal isolated e2e Postgres/Neon-shim selectors and fixture setup. The
fixture now applies migration0005 (no production execution). start-services.sh
creates ephemeral VAPID keys in process env with no logs/files, valid contact
mailto:e2e@ftown.test, then starts UI. Explicit bridge setup/start run from its
scratch HOME with both HOME and USERPROFILE set; no real user paths are used.
Run `push-notifications.spec.ts`; no missing-config silent skip exists.

The browser spec supplies valid fake PushManager endpoint/keys, tests real
subscribe/disable/enable, captures notifications-enabled.png, stubs worker
showNotification (no OS notification), closes app pages, dispatches provider-
shaped worker events, checks duplicate display and click target. The second
case uses real DB rows and signed test tokens, no subscribed recipients, checks
idle/question dedup, concurrent replay, later-subscriber no-backlog, browser /
wrong-owner / revoked rejection, then removes its own rows. It never contacts
an external vendor. Synthetic click may require a browser-boundary openWindow
stub if Chromium enforces user activation; root will verify actual harness.

### Independent startup review

Read canonical_start diff and start-commands.ts. Canonical dispatch lazily loads
runBridge after readiness, preserves help-only discovery, uses a fresh Commander
with exitOverride, guards index module execution, and wires hosted notifier to
cached refreshed token plus shutdown stop. No material finding from this
bounded source review. Did not duplicate that worker's test execution.

Status: implementation/source/test writes stopped; ui dependency/build lease and
all notification source leases released to root for integrated gates. Bridge
source was separately frozen/released earlier at root's request. Await only
concrete review/runtime repairs within established ownership.

Final reviewer follow-up: account mismatch now clears worker binding even if
its old browser subscription has disappeared; regression passes. Endpoint
unsubscribe still proceeds when an unavailable worker cannot acknowledge clear,
and worker storage-read failure suppresses display. Final focused UI count24.
All leases released after this repair; root notified.

Late-enable/logout review repair (UI control/test only): shared generation is
invalidated synchronously by detach/unmount/account effect transitions. Enable
and restore check it across asynchronous boundaries, including worker crypto /
message binding; detach aborts active POST, removes the local marker immediately
and stale successful subscription work cleans up only its still-owned endpoint.
Enable starts the user-gesture permission request synchronously and clears the
old worker binding before awaiting permission. A deterministic deferred-POST
regression proves late success after detach+unmount cannot rebind the old owner.
Focused control6/6 and UI tsc passed. Bridge files remain unchanged/frozen.
Source/UI leases released again after repair; no build or runtime run performed.

Browser harness follow-up: root independently reproduced vanilla Chromium
Notification.permission=denied with Permissions API granted on a non-FTown
localhost page, falsifying the earlier origin/timing hypothesis. The focused
browser fixture now explicitly simulates the OS Notification permission/request
boundary alongside PushManager, starting default and counting requests to prove
zero automatic prompts and one request on explicit enable. Real Permissions API
state remains recorded in push-permission.json; authenticated routes, SQL and
service worker behavior remain real. Product permission guards unchanged.
E2E static typecheck and diff whitespace checks pass; root executes rerun.

Root browser rerun proved opt-in/out, closed-page worker push and duplicate
suppression. Its synthetic click hit Chromium's expected user-activation guard
(InvalidAccessError from clients.openWindow). Harness now captures only this
browser boundary, asserts the exact fixed same-origin /dashboard session URL,
then creates/navigates a real context page there. Removed the dangling page
waiter. No production guard changed, no rebuild or worker E2E run performed.
Spec typecheck/diff checks pass; root owns final browser rerun/visual gate.
