# Attention transmission: transport investigation

## Finding: one epoch recovery can produce two global refresh signals

`ui/src/lib/secure-endpoint-runtime.ts` receives an authenticated `epoch_changed` response and calls `disconnected(envelope.bridgeId)`, which synchronously marks the bridge offline and notifies all trust listeners. With the raw broker connected, `SecureMessageClient`'s trust observer invokes `ensureReady` and attaches a success callback that emits `subscribed` on the shared commands channel. Once `receive` returns, `SecureSubscription.receiving` passes the normalized response to `observe`, which calls `recoverEpoch`. This joins the same per-bridge handshake but attaches another success callback emitting the same global `subscribed` event. `useBridgeRpc` forwards each event to all subscribed listeners; `useAllSessionEvents` sends a `get_session_attention` for every currently owned running session on every such event. Thus one recovery can send two sweeps despite only one handshake.

Multiple `onChange` calls while that bridge remains offline and a handshake promise is pending can attach more callbacks to the same promise. The ordinary handshake sets the state to `connecting` synchronously, so repeated notifications do **not** generally do this while state remains connecting. The actual frequency and origin of the user's 80 observed requests remains unproven; this demonstrates a concrete amplification path, not that it caused the original burst.

## Isolated reproduction

Ran Node 24.22.1 with the actual `SecureMessageClient` and an in-memory broker/runtime that models the real ordering: initial ready command publishes and registers an expected response, `receive` marks the bridge offline and calls the trust observer before returning `epoch_changed`, and the pending handshake is resolved afterward. No source files, servers, state or Git were changed. Result:

```json
{"applications":1,"handshakes":1,"emissions":2}
```

The existing `secure-message-client.test.ts` epoch-recovery case expects one signal but its `RawClient` has no `state = 'connected'`; the trust observer's connected guard returns early, so that case misses the duplicate path. For production regression, use the real encrypted fixture and a connected raw client, hold the welcome response, then assert one hello and exactly one `subscribed` signal after welcome. Ensure the epoch-changed rejected command is not replayed. Also exercise failure and later retry, disposal/disconnect and revocation before completion, and independent recoveries of two bridges.

## Minimal bounded repair contract

Use one per-bridge recovery coordinator shared by the trust observer and `recoverEpoch`. Acquire its guard synchronously before calling `ensureReady`, and attach exactly one completion notification per successful recovery cycle. An observer-triggered recovery uses non-forced readiness; an epoch-triggered recovery forces a handshake when no cycle is already in progress, and joins the existing cycle otherwise. A failed or cancelled cycle emits no notification and releases its guard for a later external retry. Suppress stale notification after disposal, changed connection generation, or loss of bridge trust; retain genuine raw broker subscription events and reconnect hydration. Do not replay the rejected command or weaken authorization.

The existing synthetic `subscribed` event has no bridge ID: even one successful bridge recovery causes refresh requests for all running sessions across all bridges. Same-turn hook coalescing can reduce overlapping sweeps, but cannot guarantee other bridges receive no redundant reads; that requires a bridge-targeted signal or equivalent interface. Preserve unresolved-attention restoration and actual reconnect recovery if introducing such a change.

No application files were edited. Report lease released; root owns contract and runtime verification.

## Task F pre-freeze review

The scheduled reads and shared recovery design address the proven overlapping-prompt and duplicate-recovery paths while retaining real restoration. Approve with these race clarifications:

1. On broker disconnect, invalidate/remove old recovery coordinators synchronously so a new connection generation can recover without waiting for the old pending handshake timeout. Cleanup must check cycle identity: a late `finally` from the old cycle must not remove a new cycle. Test disconnect/reconnect while the old handshake remains pending, then settle both and verify only the new successful recovery signals.
2. Every relevant trigger while an attention read is pending, including subscription/reconnect triggers, must invalidate the pending result immediately and mark the trailing read dirty. Verify a stale pre-reconnect success cannot restore attention before the trailing snapshot arrives.

The existing event type lacks bridge identity, so one successful recovery still triggers a global reconciliation; the contract accurately retains that limitation. The stated baseline RED, count-based regression, owner teardown, failure and timing checks are appropriate.

## Task G post-change review, first pass

**Finding requiring repair:** `ui/src/hooks/useAllSessionEvents.ts` schedules a microtask and later trailing reads based only on `subsRef` owner identity. The current client, user and RPC refs are changed during render; the effect that tears down old subscriptions runs afterward. A queued microtask or old in-flight completion in that interval can use the replacement `rpcRef` while the previous subscription owner remains in `subsRef`, thereby transmitting a read for an obsolete owner. Existing post-response guards prevent state application but do not prevent this send. Capture user on each owner and validate both current client and user before dispatch and before scheduling a trailing read; test a replacement between render and passive-effect teardown, and old completion in that interval.

Other inspected behavior: read generations fence pending results on new triggers, bounded dirty read survives failure, transport coordinates per-bridge cycles and uses generation plus cycle identity, and the connected encrypted epoch fixture checks the original duplicate notification path. The worker reports 43 focused tests and typecheck passing. Root owns runtime/E2E; this review did not rerun them. Awaiting repair and closure review.

## Task G closure review

**Pass; no remaining blocking findings.** The subscription owner now captures the user and checks client/user identity before queuing, dispatching and scheduling a trailing read. The added regression executes the old queued callback in a layout effect after the replacement render and before passive cleanup; it asserts neither RPC receives the obsolete read, then verifies the new owner hydrates normally. The worker reports that the regression failed before the repair, then passed with 35/35 hook tests and a clean typecheck. The earlier 43/43 combined focused tests and wider suite predate this final hook repair; root owns any final combined verification.

The change still intentionally reconciles sequential prompts and uses a global refresh on successful bridge recovery, as documented. No live traffic attribution is claimed. Source was reviewed read-only; report lease released.
