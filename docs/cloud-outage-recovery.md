# Cloud outage recovery

The dashboard keeps existing Local/P2P terminals available while Centrifugo is
unreachable. A nonblocking notice replaces the automatic full-screen error panel;
diagnostics are available on demand and can be dismissed without reloading.
Centrifuge continues its existing reconnect/resubscribe cycle. Once connected,
the notice disappears and cloud subscriptions resume without replacing healthy
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
