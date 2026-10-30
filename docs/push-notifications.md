# Agent push notifications

Hosted FTown can notify your browser when an agent asks a distinct question.
Enable push notifications at the bottom of the session sidebar. This is an
explicit opt-in; loading the dashboard never requests permission. Disable it
there to unsubscribe. Signing out detaches the browser subscription; switching
accounts discards a subscription owned by the prior account. A blocked browser
permission must be changed in browser settings.

Push works while the dashboard tab is closed, subject to browser/OS delivery
and network availability. HTTPS (or localhost) is required. iPhone/iPad support
requires installing the web app to the Home Screen and enabling notifications
from that app. Local/solo mode does not contact the hosted push service. Idle
sessions do not generate human push notifications.

Questions are immediate and use persisted attention UUIDs, so repeats of the
same attention do not resend. New subscribers receive future events only.
Notifications use the generic title “FTown attention” and body “Open FTown to
view details.” Clicking one opens or focuses FTown and selects its session when
available.

## Child idle messages

A running child session can send its parent an in-app mail message after an
authoritative thinking/tool-use to idle transition remains idle for 120 seconds.
The parent must be the child's recorded parent on the same bridge; native
provider subagent inventories do not establish this relationship. Both sessions
must still be running and eligible for mail when delivery is attempted. This
works in cloud, local and solo modes without human push opt-in.

Repeated idle observations do not reset the deadline, and an initial or legacy
idle snapshot alone does not start a cycle. Resumed activity, session end or
removal, and bridge shutdown cancel a pending timer. Once enqueue begins, later activity cannot retract mail that is accepted
into the durable queue. A later busy-to-idle
transition can start a new cycle.

Each cycle makes at most one best-effort mail attempt. The attempt is recorded
before delivery, so a crash or delivery failure can lose the message; an
uncertain attempt is not retried. Pending cycles for live sessions resume after
bridge restart. On upgrade, legacy ten-minute cycles are migrated to 120 seconds from
their original start, including cycles already marked as having sent a human
idle notification. Already-attempted 120-second cycles do
not replay.

## Deployment

1. Apply `ui/migrations/0005_web_push.sql` using the existing migration runner
   against the explicitly intended database. This adds three new tables and
   does not alter existing data. Do not enable the feature before migration.
2. Generate a VAPID key pair once using the installed web-push library. Set
   server-only `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (an
   externally valid mailto: contact or HTTPS URL). Keep the private key secret
   and stable; key rotation requires browser resubscription.
3. Deploy the hosted UI and updated bridge. GET `/api/push` reports unavailable
   if configuration or schema is absent, before asking for browser permission.

The additive migration creates only empty new relations/indexes. Old code
ignores them and may be redeployed for rollback. Roll back application code or
unset VAPID to disable; leave tables/dedup records intact (forward-only schema
rollout). Verify `to_regclass('push_subscriptions')`, `to_regclass('push_events')`
and `to_regclass('push_deliveries')` are non-null before enablement. There is no
backfill, existing-table rewrite or production migration performed by this PR.

## Delivery and privacy limits

Subscriptions are owner-scoped and limited to ten browser endpoints. Events
require a signed active paired bridge identity. HTTPS push endpoints are
restricted to Google/Apple/Mozilla/Microsoft browser push vendors; redirects
and arbitrary/internal endpoints are rejected. Requests, event rate, queue,
provider fanout and timeouts are bounded. Push notifications contain generic
text rather than agent names or question excerpts; raw hook payloads and
credentials are excluded. The generic notification can appear on a lock screen.

Question event and delivery deduplication survives bridge restart/reconnect.
Transient provider delivery retries are bounded to five minutes, successful
endpoints are not resent, and expired endpoints are removed. The bridge queue
is intentionally in memory: a bridge crash can lose an unsent notification.
A provider acknowledgement followed by a server crash can also lead to retry;
the service worker stores notification receipts to suppress repeated display.
Clearing browser site data clears those local receipts. Push is best-effort,
not a guaranteed exactly-once message channel; in-app attention stays available.

## Verification

Unit checks cover authentication/owner guards, endpoint restriction, immutable
identity, fake-clock child idle boundary/rearm/recovery/cancellation, finite
bridge retry, recipient/delivery boundaries, permission UX and service-worker
duplicate display/click behavior. Authenticated legacy idle push events are
accepted without creating a push event or contacting a provider. The main
assistant alone runs `e2e/tests/push-notifications.spec.ts` after the normal
fixture build/start.
`e2e/scripts/start-services.sh` generates ephemeral VAPID keys in its process
environment without logging/persisting them. The browser spec fakes OS Notification permission/requestPermission together
with PushManager/provider delivery and stubs showNotification to avoid real OS
notifications. The local vanilla Chromium build was independently observed to
report Notification.permission denied while its Permissions API reported granted;
this platform boundary is simulated explicitly, never bypassed in product code.
Permission prompting/denied/unavailable behavior is covered in component tests. It verifies UI subscribe/unsubscribe through real authenticated
routes, closes app pages and dispatches worker push/click events. Synthetic clicks
lack OS user activation, so the worker browser clients.openWindow boundary is
captured, its fixed same-origin session URL asserted, and a real test-context
page navigates that URL. Production window-opening behavior is unchanged. It checks
real database owner/revoked/browser-token rejection, ignored idle events and
duplicate questions with zero recipients. No external push vendor is contacted by it.
