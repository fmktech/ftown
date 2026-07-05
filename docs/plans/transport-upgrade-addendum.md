# Transport Upgrade — Contract Addendum (FROZEN)

Extends docs/plans/direct-transport-contract.md and
docs/plans/loopback-transport-addendum.md. All prior rules stand.

Problem: today the ladder (loopback → WebRTC → Centrifugo) runs ONCE per
bridge; if it lands on Centrifugo, the session stays on the cloud path until
page reload — even after the blocking condition (VPN toggled off, network
change, bridge restart) clears.

## Rules

T1. While ANY session of a bridge is in mode 'centrifugo' AND the bridge is
    online (present in bridges:presence), the transport periodically re-runs
    the full ladder for that bridge ("upgrade attempts"): backoff 15s → 30s →
    60s → then every 120s (cap), each with ±20% jitter. One retry loop per
    bridge, not per session.
T2. Extra immediate-attempt triggers (each resets the backoff): the browser
    `online` event; `visibilitychange` to visible; a fresh subscribeTerminal
    for that bridge. Attempts never run concurrently (in-flight guard).
T3. A successful upgrade switches ALL of that bridge's centrifugo-mode
    sessions to the new rung, one at a time, preserving R1: attach over the
    new path (bridge replies `screen`, a full resync) → switch input routing →
    unsubscribe the Centrifugo terminal channel → send terminal_unwatch and
    stop heartbeats. Until the attach screen arrives for a session, that
    session keeps consuming the Centrifugo path — no gap, no double-apply
    (output arriving on the old path after the new path's screen is dropped
    by unsubscribing BEFORE processing post-screen output; the screen frame
    is the switch point).
T4. Input during a switch: keep routing to the currently-active path until
    the switch point (the new path's screen), then route to the new path.
    The existing connecting-window buffering is NOT used for upgrades (there
    is always an active path).
T5. Failure of an upgrade attempt is silent: sessions stay on Centrifugo,
    backoff continues. fallbackReason is NOT cleared by a failed attempt;
    a successful upgrade clears it (mode change does this already).
T6. Non-goals: no WebRTC→loopback upgrade (a working direct rung is never
    disturbed); no downgrade except the existing failure paths; no bridge-side
    changes (attach is already accepted at any time).
T7. Retry loops are cancelled when: the bridge's last session unsubscribes,
    dispose(), or the bridge goes offline in presence (resume when it
    returns via the T2 subscribe trigger or next presence advert query).
T8. Badge/tooltip: no new UI states. Sessions flip Cloud → Local/P2P
    when an upgrade lands; onModeChange fires as usual.

## Surface (frozen, additive)

- HybridTerminalTransportOptions gains OPTIONAL `upgradeBackoffMs?: number[]`
  (default [15_000, 30_000, 60_000, 120_000]; last entry repeats) and
  `upgradeJitter?: number` (default 0.2) — injectable for tests.
- No TerminalTransportApi changes. No wire-protocol changes. No bridge changes.
