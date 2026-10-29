---
type: investigation
symptom: "im not looking for cleanup logs, I'm looking to why we need to transmit many attention stuff that is probably well outdated or already dismissed"
slug: attention-transmissions
date: 2026-10-28T23:00:00-03:00
investigator: Foad Kesheh
git_commit: ebd108eb1628d261339891cb683d0a2b16ae8d62
branch: fix/attention-polling-noise
repository: fmktech/ftown
status: resolved
hypotheses_formed: 4
hypotheses_rejected: 1
hypotheses_proven: 1
related:
  - docs/investigations/2026-10-28-attention-polling.md
  - docs/investigations/2026-10-24-attention-refresh.md
---

# Excess attention reads

## Symptom and limits
User corrected the goal: “im not looking for cleanup logs, I'm looking to why we need to transmit many attention stuff that is probably well outdated or already dismissed”. Their earlier transcript showed approximately 80 `get_session_attention` receipt lines with distinct UUIDs, no timestamps or session IDs. The lines establish many commands reached a bridge; they do not establish payload contents, whether the 80 target the same session, event ordering, deployed UI build, or which lifecycle caused the burst. Suppressing logging does not reduce transmissions; the prior logging-only patch should be removed from the PR unless separately requested.

## Reproduction and source evidence
The actual running bridge artifact is 0.19.58; the original checkout is old and unrelated, per preceding investigation. No production UI code or broker traces have been captured. These bounded test recipes can prove the mechanisms without a real bridge:

1. Mount `useAllSessionEvents` with one running session, actual `LocalSubscription` behavior (synchronous subscribed state; queued `subscribed` event), and a successful RPC mock. Baseline source guarantees one `sendCommand` from the immediate check and another from the queued subscription callback. Assert one after fix and check snapshot survives mount/reconnect. Real implementation: `ui/src/lib/local-browser-client.ts:69-72`, hook `ui/src/hooks/useAllSessionEvents.ts:193-199`.
2. In existing `durableSetup`, leave first read unresolved, publish 80 `UserPromptSubmit` and/or `beforeSubmitPrompt` callbacks synchronously, inspect mock calls: baseline makes one initial plus 80 reads. Resolve requests and prove only the latest eligible response applies. Follow-up regression should assert bounded requests, that a read taken after the last prompt can still resolve/preserve attention correctly, and that failures eventually allow a later retry.
3. Trigger command-channel reconnect while session event subscription also reconnects. Both callbacks call `hydrate` per running session (`useAllSessionEvents.ts:193-195,223-226`), so they can produce concurrent duplicate reads. Control timing explicitly; require a fresh read after an actual reconnect, not an unconditional skip.
4. Secure reconnect test `ui/src/lib/secure-message-client.test.ts:87-107` simulates epoch change but `RawClient` has no `state` property, so the trust-observer branch checking `raw.state === 'connected'` does not run. A new test with connected raw client and controlled delayed welcome should count `subscribed` callbacks; `SecureEndpointRuntime.receive:189-192` calls `disconnected`, the `onChange` callback in `secure-message-client.ts:70-76` starts a handshake, and `observe:196` calls `recoverEpoch:174-179`, whose continuation emits another global subscription signal after the same pending handshake. Each signal drives an all-running-session sweep through `useBridgeRpc.ts:253-256` and `useAllSessionEvents.ts:223-225`. Validate exact count and lifecycle before implementation; do not claim this was the user's burst.

Root installed UI dependencies; `npm test -- src/hooks/useAllSessionEvents.test.ts` passed all 29 existing tests on Node 24.22.1. New RED on unchanged source: `npx vitest run src/hooks/useAllSessionEvents.test.ts -t 'bounds eighty overlapping prompts'` failed with `expected ... 1 times, but got 81 times`. Combined focused tests also showed duplicate startup 2 vs 1 and connected secure epoch recovery 2 notifications vs 1. These are isolated reproductions, not attribution of the user's live burst.

## Hypotheses

### H1: The bridge sends old or dismissed attention records as the contents of every response.
- **Layer**: persisted state / wire payload.
- **Prediction**: explicit snapshots return already-resolved or acknowledged records.
- **Verification**: `bridge/src/attention-store.ts:237-245,249-263`; handler `bridge/src/command-rpc.ts:128-141`.
- **Evidence**: `latestExplicit` filters `event.type === 'agent_needs_input' && !event.resolvedAt && !event.acknowledgedAt`; `explicitSnapshot` returns only newest eligible event or null plus watermark. Manual dismissal resolves explicit records through displayed sequence and saves before returning the new snapshot. `record` resolves existing records for prompt hooks at 190-194; `local-api-server.ts:1242-1254` awaits record before event emission when source is authoritative.
- **Verdict**: REJECTED as a statement about current bridge snapshot responses. UI can still send redundant empty-snapshot requests; logs show commands, not their returned content. Workspace-attributed hooks are explicitly non-authoritative and cannot be assumed to have persisted.

### H2: A local session mount sends duplicate attention reads from immediate and deferred subscription notifications.
- **Layer**: UI / local transport lifecycle.
- **Prediction**: One running session causes at least two sends if subscription stays mounted and RPC is available.
- **Evidence**: local subscribe sets `state = 'subscribed'` synchronously then schedules `this.emit('subscribed', undefined)` in a microtask; hook performs a read immediately on that state and again inside the listener. An intervening unmount or unavailable RPC can prevent the second send.
- **Verdict**: INCONCLUSIVE pending isolated test; source demonstrates the two trigger paths, not the user's actual transport or burst.

### H3: Recovered prompt publications drive a separate attention read for each stale prompt.
- **Layer**: UI / broker replay.
- **Prediction**: delivery of N prompt callbacks with ownership still valid calls `hydrate` N times even with no current attention or pending request.
- **Evidence**: `useAllSessionEvents.ts:121-130,177-179` tests only event name and calls `hydrate`; `hydrate:80-90` immediately issues an RPC with no in-flight coalescing. It increments read generation, and `:91-94` rejects old results only after the requests were sent. Hook requests history with `{since:{offset:0,epoch:''}}`; production events namespace retains up to 100 events for one hour (`centrifugo/config.prod.json:68-75`). `secure-message-client.ts:13-23,89-93` forwards options and emits decrypted data without exposing recovery metadata; runtime accepts authenticated historical publication envelopes (`secure-endpoint-runtime.ts:181-188`). Whether broker delivers those 80 events or precise recovery order is not proven.
- **Verdict**: PROVEN for overlapping synthetic prompt callbacks: 80 callbacks produced 80 new commands while one was already outstanding. Actual deployed trace remains unavailable and may have had different triggers.

### H4: Duplicate reconnect signals cause redundant per-session sweeps.
- **Layer**: transport / integration.
- **Prediction**: two subscription notifications, whether from session plus command subscription or duplicate epoch recovery notifications, request two snapshots for each active session even if first is unresolved.
- **Evidence**: both handler paths unconditionally hydrate, with no coalescing. Global command notification sweeps every current subscription. Secure trust observer and `recoverEpoch` have separate `.then` emission sites as described in reproduction 4. Existing epoch test's mock lacks `state` so cannot verify this branch.
- **Verdict**: INCONCLUSIVE until scoped deterministic test verifies event count and sequencing; multiple independent signals clearly result in multiple `hydrate` invocations by source.

## Falsification and safety constraints
A delayed old prompt can arrive after a newer persisted request. Existing `useAllSessionEvents.test.ts:244-255` expects that newer request to remain visible after the post-prompt read; simply clearing on every prompt breaks this invariant. A prompt arriving while the prior snapshot is pending invalidates that prior snapshot (`observations` guard), so merely reusing an in-flight result or skipping all prompt reads can leave stale state or fail to retire canonical replay exceptions. Preserve eventual fresh read after the last relevant prompt, ownership/generation checks across session/client/user switches and unmount, deferred failures and later recovery. A reconnect must still hydrate state after missed changes. No elapsed TTL or timestamp filter can establish ledger ordering from an unstamped prompt.

## 5 Whys and proven root cause
1. Eighty overlapping prompt callbacks sent eighty extra reads because each callback invokes `hydrate` immediately.
2. `hydrate` starts a request even while a prior snapshot is pending.
3. Read generations fence old results only after the work has been sent.
4. Prompt reconciliation was designed to re-read the authoritative ledger for ordering but lacks a coordinator for overlapping invalidations.
5. The snapshot reconciliation boundary has no per-subscription in-flight and dirty state; a burst therefore becomes unbounded overlapping requests. The no-prompt initial snapshot still sent once, while the 80 subsequent callbacks caused 80 additional calls; the pending read counterexample rules out the existing response fence preventing transmission. This proves the synthetic behavior and does not identify the live transcript's trigger.

## Bounded candidate repair
Propose per-session, per-current-subscription bounded read coordination in `ui/src/hooks/useAllSessionEvents.ts` and behavioral tests in `ui/src/hooks/useAllSessionEvents.test.ts`: enqueue same-turn initial/subscription triggers until one microtask flush so local's queued subscription notification and immediate subscribed-state check share the first read. Permit at most one in-flight snapshot, record whether a fresh result is required after an event/reconnect occurred after that request was issued, and run one trailing read after completion (also after failure if dirtied), rather than emitting one request for every overlap. Preserve prompt-generation fences and never apply a pre-prompt result as if it reflects later state; multiple prompts while busy collapse into one follow-up and a prompt arriving during follow-up schedules another. Prevent late completion from old owner clearing new owner state or sending a follow-up after unmount. Reconnect and new session still get fresh snapshots. This bounds overlapping bursts to one in flight plus one trailing read, but cannot promise all 80 live calls disappear if reads finish between events; it does not establish why the original 80 occurred. Separately test local startup ordering, because pure single-flight plus unconditional dirty marking yields a redundant follow-up for its duplicate subscription notifications. Avoid deduplicating real reconnect signals without a trustworthy generation boundary.

Potential targeted secure recovery fix belongs in `ui/src/lib/secure-message-client.ts` and `.test.ts` only after empirical duplicate reproduction. Do not expand shared interface until root and reviewer settle the contract; ensure epoch recovery emits exactly one refresh while preserving independent bridge recovery, revocation, generation and existing session-list consumers. Cross-bridge global sweep scaling remains a separate design question: currently subscription callbacks carry no bridge identifier, so target-specific sweep changes require an explicit shared interface review.

`bridge/src/command-rpc.ts`, its test, package bump and `docs/bridge-command-logging.md` represent logging-only work: revert task-owned logging edits through the designated worker or landing owner when approved by root; preserve investigation evidence. Avoid unrelated original checkout changes.

## Resolution
Per-subscription snapshot scheduling coalesces same-turn triggers and limits each owner to one in-flight read plus a dirty trailing read. A later prompt or reconnect fences an earlier response, including when the first read fails; unmount and replacement prevent stale owners from sending a follow-up. The secure transport now coordinates observer and epoch recovery per bridge, invalidates cycles on disconnect, and checks cycle identity and generation before signaling. The task-owned logging-only changes were restored to the pre-PR base.

Node 24.22.1 RED showed 81 calls for an initial pending snapshot plus 80 prompt callbacks, two initial subscription reads, and two connected epoch recovery notifications. GREEN `npx vitest run src/hooks/useAllSessionEvents.test.ts src/lib/secure-message-client.test.ts` passed 43/43; `npx tsc --noEmit` passed. Tests cover the 80-event burst, late prompt, failure/trailing read, reconnect fence, unmount and replacement, independent bridge cycles, reentrancy, failed recovery, disconnect/late settlement, revocation and disposal. Actual production trigger remains unverified; non-overlapping prompts still reconcile individually. Root owns runtime/E2E verification.

Review identified a narrower ownership race: a replacement render updates client, user and RPC refs before passive cleanup removes the old subscription. An old queued microtask can then send through the replacement RPC. A controlled layout-effect regression ran the old queued callback during this interval and failed on the existing implementation because the new RPC received one stale request. Repair must fence owner identity before queue dispatch, before send, and before trailing scheduling.

The subscription owner now captures its user as well as its client, and checks both against current refs before dispatch, before RPC send and before a trailing read. The controlled regression passes after repair; the full hook suite passed 35/35 and `npx tsc --noEmit` passed under Node 24.22.1. Independent review and root runtime/CI gates remain pending.
