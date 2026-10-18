# Agent push notifications

Hosted FTown can notify your browser when an agent asks a distinct question or
first becomes idle. Enable push notifications at the bottom of the session
sidebar. This is an explicit opt-in; loading the dashboard never requests
permission. Disable it there to unsubscribe. Signing out detaches the browser
subscription; switching accounts discards a subscription owned by the prior
account. A blocked browser permission must be changed in browser settings.

Push works while the dashboard tab is closed, subject to browser/OS delivery
and network availability. HTTPS (or localhost) is required. iPhone/iPad support
requires installing the web app to the Home Screen and enabling notifications
from that app. Local/solo mode does not contact the hosted push service.

One idle notification is keyed to the authenticated owner, bridge and FTown
session for that session's lifetime. It requires an observed thinking/tool-use
to idle transition; initial or restored idle snapshots never generate it.
Questions use persisted attention UUIDs, so repeats of that attention do not
resend. New subscribers receive future events only. Clicking a notification
opens/focuses FTown and selects its session when available.

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
provider fanout and timeouts are bounded. Payloads contain only sanitized short
agent names/question excerpts; raw hook payloads and credentials are excluded.
Notification excerpts can appear on your lock screen when you opt in.

Cloud event and delivery deduplication survives bridge restart/reconnect.
Transient provider delivery retries are bounded to five minutes, successful
endpoints are not resent, and expired endpoints are removed. The bridge queue
is intentionally in memory: a bridge crash can lose an unsent notification.
A provider acknowledgement followed by a server crash can also lead to retry;
the service worker stores notification receipts to suppress repeated display.
Clearing browser site data clears those local receipts. Push is best-effort,
not a guaranteed exactly-once message channel; in-app attention stays available.

## Verification

Unit checks cover authentication/owner guards, endpoint restriction, immutable
identity, finite bridge retry, recipient/delivery boundaries, permission UX and
service-worker duplicate display/click behavior. The main assistant alone runs
`e2e/tests/push-notifications.spec.ts` after the normal fixture build/start.
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
real database owner/revoked/browser-token rejection and duplicate idle/question
records with zero recipients. No external push vendor is contacted by it.
