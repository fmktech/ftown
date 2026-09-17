# Cloud outage recovery

The dashboard keeps existing Local/P2P terminals available while Centrifugo is
unreachable. The connection status indicator opens a hover/focus/click panel instead of
printing an outage notice over the terminal. Diagnostics can be dismissed without reloading.
Centrifuge continues its existing reconnect/resubscribe cycle. Once connected,
the indicator updates and cloud subscriptions resume without replacing healthy
direct terminal connections.

The terminal transport remembers bridge loopback advertisements learned through
authenticated cloud presence. If presence subsequently fails, times out, or loses
the bridge, the normal retry loop can still attempt a nonce-authenticated localhost
connection. A successful presence response refreshes advertisements, including
rotated credentials. Output switches paths only after receiving the new terminal
screen, using the existing transport switchover logic.

Advertisements remain in memory within the authenticated transport instance and
are cleared on disposal. They are not written to browser storage. This supports
outages in an already-loaded dashboard, not cold offline startup or page reloads.
A bridge restarted with a different port/nonce needs cloud discovery again.

Session creation, loops, and other management RPCs still require Centrifugo.
Local terminal input, output, and resize use the direct connection. A remote bridge
without a reachable direct path remains unavailable until a path recovers.

Coverage: `CloudConnectionNotice.test.ts` checks nonblocking/dismissible diagnostics
and recovery; `hybrid-terminal-transport.test.ts` checks reconnection during rejected,
hanging, and empty presence responses, continued terminal I/O, and refreshed
credentials after cloud recovery.

## Incident diagnostics

The status panel remains available after recovery. It shows the sanitized WebSocket
endpoint, browser online hint, current direct bridge count, and recent UTC events.
A per-tab, 100-event in-memory history records cloud event/error codes, browser
online/offline and visibility changes, direct reachability counts, token-refresh
HTTP status, and observed outage duration. Account changes clear the history.

During cloud unavailability, bounded WebSocket-open and same-origin website probes
run at most once every 30 seconds. Each records start time, result, and duration.
Diagnostic sockets close on completion, timeout, or cancellation. Manual network
checks are available while connected as well. Download report exports JSON without
JWTs, nonces, user IDs, raw error payloads, or URL credentials/query parameters.
Reports are downloaded locally; there is no telemetry upload.

A browser WebSocket failure does not reveal whether DNS, TCP, TLS, a proxy, or an
ISP failed. The browser online flag is a hint, not an internet reachability check.
Website probes can be answered by a service worker. These limits are included in
the report. History does not survive reloads or a new tab.
