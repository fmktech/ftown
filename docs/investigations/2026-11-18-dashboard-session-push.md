---
type: investigation
symptom: "Each visible dashboard reads list_sessions and get_sessions_usage every 15 seconds; push-path delivery of list changes needs proof."
slug: dashboard-session-push
date: 2026-11-18T04:12:45-03:00
investigator: Foad Kesheh
git_commit: 019503f976f7f3643f4321b37ebdc5d677adfdc0
branch: perf/dashboard-polling
repository: fmktech/ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 1
hypotheses_proven: 1
related: []
---

# Dashboard session pushes and safety polling

## Symptom
- **Observed**: "each visible dashboard sends list_sessions + get_sessions_usage every 15s"
- **Expected**: Session list mutations arrive through the sessions subscription; list reads are a recovery safety net.
- **Delta**: The dashboard performs frequent list reads, and delivery reliability has not yet been established experimentally.

## Reproduction
1. Subscribe a dashboard to `sessions:updates` and perform create, status change, rename, and remove while suppressing only its periodic list interval.
2. Verify each displayed state transition before the normal interval; then compare against a subsequent authoritative list snapshot.
3. Environment: repository HEAD `019503f976f7f3643f4321b37ebdc5d677adfdc0`, branch `perf/dashboard-polling`.
4. Verified: UI test `ui/src/hooks/useSessions.test.ts` emits create/status/rename/remove over the subscription, observes each update before clock advance, then advances 60 seconds and sees four periodic list reads at the starting 15-second cadence. This uses a controlled subscription callback rather than a live Centrifugo deployment.

## Hypotheses

#### H1: The UI session subscription applies `session_update` publications directly to session state.
- Layer: code-logic
- Prediction: Delivering a valid update callback adds/updates/removes the matching session without a `list_sessions` response.
- Verification method: inspect subscription callback and exercise hook-level test with polling disabled.
- Evidence:
  ```
  ui/src/hooks/useSessions.ts:290 — callback handles removed via filter; accepted rows merge and insert directly.
  ```
- Verdict: PROVEN
- Rationale: Focused test demonstrated create, status, rename, and remove state changes before time advanced; at the starting cadence, 60 seconds counted four periodic list reads for the test bridge.

#### H2: Bridge CRUD producers publish session changes to the sessions update channel, but cloud transport delivery can fail while disconnected.
- Layer: dependency
- Prediction: create/update/remove flows call `publishSessionUpdate` with the changed session.
- Verification method: inspect producer implementations and existing lifecycle/wire tests.
- Evidence:
  ```
  bridge/src/remove-ftown-session.ts:56 — await deps.centrifugo.publishSessionUpdate(deps.userId, removedSession);
  bridge/src/create-ftown-session.ts:479 — await deps.centrifugo.publishSessionUpdate(deps.userId, session);
  bridge/src/session-controller.ts:394-397 — updateMetadata saves and awaits publishSessionUpdate.
  bridge/src/centrifugo-client.ts:292-302 — publishSessionUpdate awaits channel publish and logs/rethrows failures.
  ```
- Verdict: PROVEN
- Rationale: Mutation paths invoke the channel publisher, and publisher errors are surfaced; if a disconnect rejects a publish, the UI cannot see that mutation until a later authoritative list snapshot. Recovery is configured on reconnect, but periodic reconciliation also covers missed delivery.

#### H3: A publication may be lost during disconnect; reconnect subscription snapshot repairs state.
- Layer: state-data
- Prediction: missed changes are recovered by `onSubscribed`/`subscribed` list snapshots, while changes during a live subscription appear immediately.
- Verification method: inspect reconnect registration and compare a deliberate disconnect interval to list snapshot.
- Evidence:
  ```
  ui/src/hooks/useSessions.ts:286 — onSubscribed(() => requestList(true));
  ui/src/hooks/useSessions.ts:309 — sessionsSub.on("subscribed", () => { if (active) requestList(true); });
  ```
- Verdict: INCONCLUSIVE
- Rationale: Recovery is wired; runtime behavior has not been exercised.

#### H4: The apparent need for list polling is caused by the UI ignoring session_update publications.
- Layer: observation
- Prediction: callback delivery with a valid row leaves rendered session state unchanged.
- Verification method: focused useSessions test with fake subscription and no periodic interval.
- Evidence:
  ```
  ui/src/hooks/useSessions.ts:290-308 — callback updates state directly for removal and accepted rows.
  ```
- Verdict: REJECTED
- Rationale: The callback explicitly mutates state for valid publication events; whether the publisher delivers them remains a separate question.

## 5 Whys
Symptom: Session mutations can be absent from the dashboard until a periodic list snapshot.
Why 1? Because an update publication can fail when the client transport is disconnected (`bridge/src/centrifugo-client.ts:297-302`).
Why 2? Because the bridge cannot deliver a channel publication without a connected Centrifugo transport.
Why 3? Because session state is persisted locally while the UI's incremental state is remote and event-driven.
Why 4? Because the push stream is an optimization over an authoritative command read, not a durable session event log.
Why 5? The architecture deliberately favors low-latency ephemeral pushes and requires snapshot reconciliation to recover missed delivery.

## Falsification
- Check performed: isolation test and adjacent-cause check.
- Result: With no list timer firing, injected session update publications changed rendered hook state for creation, status, rename, and removal; counterfactual clock advance produced four list reads.
- Conclusion: Push is sufficient for these live transitions. Transient transport failures remain an architectural gap covered by snapshots; no evidence indicates a missing normal producer/reducer path.

## Root Cause
- Immediate cause: a failed/disconnected transient Centrifugo publication leaves persisted session state ahead of the browser until reconciliation; publisher throws on failure (`bridge/src/centrifugo-client.ts:292-302`).
- Architectural root: session pushes are ephemeral hints, with snapshots providing convergence (`ui/src/hooks/useSessions.ts:286,309`).
- Rejected H4: valid `session_update` callbacks mutate the hook's session list (`ui/src/hooks/useSessions.ts:290-308`).
- Falsification: callback reducer and producer calls exist across add/update/remove paths, so missing reducer wiring does not explain gaps; transport loss does.

## Fix
- No source fix required for the primary push path: it passed the focused no-poll mutation test.
- The planned 60-second snapshot safety net addresses the request-rate delta while retaining explicit reconnect/visibility reconciliation.
- Batched attention reads and visible selected-terminal usage are the requested optimization changes.

## Resolution
- Part A result: add/status/rename/remove all reached hook state through `session_update` before any periodic tick; at the starting 15-second cadence, advancing 60 seconds issued four list reads; this confirms timer cadence caused recurring list traffic, independently of immediate push application.
- Limitation: local UI test injects the Centrifugo subscription publication callback (not a live cloud bridge); actual transport's disconnect loss is transient and recovers via subscription snapshots.
- Regression: `ui/src/hooks/useSessions.test.ts` — `applies create, status, rename, and remove publications without periodic list reads`.
- Verification: focused UI suites pass (175 tests): `src/hooks/useAllSessionEvents.test.ts`, `src/hooks/useSessions.test.ts`, and `src/hooks/useSessionBoard.test.ts`. Bridge tests and build checks are run separately.
- Idle visible dashboard with one bridge and no usage view: starting rate was 4 `list_sessions`/min and 4 `get_sessions_usage`/min; after change it is 1 `list_sessions`/min and 0 usage reads/min. An enabled board snapshot similarly drops from 4/min to 1/min. Event-triggered startup, visibility-return and resubscribe refreshes are excluded.
- Attention hydration: one `get_attention_summary` command per bridge, with only attention-bearing sessions in the summary object; unsupported/malformed responses fall back to old per-session reads.

## Expanded board-push coordination brief

Parent scope extension: remove `get_session_board` interval reads and make Overview snapshots push-driven and recoverable. Publish a complete `BoardSnapshot` on the account-scoped `session-board:updates` channel after a tree event changes the root's status cards, events, plan, or attention summary. Keep `get_session_board` for initial subscription, unrecovered resubscription, and visibility return only. Subscription uses Centrifugo positioned recovery and carries the last `{offset, epoch}`; mismatched/missing recovery requests an authoritative snapshot. The browser applies only snapshots matching its active bridge/root. Centrifugo history config must enable recovery for this channel too. Verify no interval with fake timers, and test publication from each board-changing event category plus recovery fallback.

Ownership proposal: one implementation writer owns bridge publication/snapshot assembly and board UI hookup; no parallel writes until the bridge/UI contract and exact file manifest are reviewed. Existing root-owned edits include `bridge/src/command-rpc.ts`, `bridge/src/command-rpc.test.ts`, `bridge/src/security/bridge/permissions.ts`, `bridge/src/security/bridge/permissions.test.ts`, `bridge/src/security/bridge/security.ts`, `bridge/src/security/bridge/security.test.ts`, `bridge/src/types.ts`, `bridge/package.json`, `bridge/package-lock.json`, `ui/src/hooks/useSessions.ts`, `ui/src/hooks/useSessions.test.ts`, `ui/src/hooks/useAllSessionEvents.ts`, `ui/src/hooks/useAllSessionEvents.test.ts`, `ui/src/components/Dashboard.tsx`, `ui/src/types.ts`, and all three `centrifugo/config*.json` files. Any worker must avoid those paths until ownership is explicitly transferred.

### Frozen board channel contract (approved by parent)

- Account-scoped channel: `session-board:updates#{userId}`. Add `session-board:updates` to `ChannelKind`; use the existing E2EE `SecureMessageClient` subscription and bridge `CentrifugoClient.publish` path.
- Payloads: `{ type: "session_board_snapshot", bridgeId, rootId, snapshot: BoardSnapshot }` or `{ type: "session_board_changed", bridgeId, rootId }`. The marker is used only when the complete snapshot is larger than the encrypted-publication bound; the UI then requests `get_session_board` for that root. Snapshot and marker must be strictly parsed and filtered by active `bridgeId` and root session ID.
- Bridge behavior: after any change affecting a board's cards/status, event log, plan, or open-attention set, debounce per root by about one second, build the newest full snapshot, and skip publishing when the serialized snapshot is byte-for-byte unchanged. For an oversized snapshot publish only the marker. Keep publication on the shared encrypted outbound path and respect its bounded queue.
- UI behavior: subscribe only while Overview is enabled; apply pushed snapshots immediately. Fetch through `get_session_board` only on initial subscribe, `recovered !== true`/position loss, visibility return, and the oversized marker. Persist `{offset, epoch}` and request positioned/recoverable subscription. If the relay rejects or lacks the new channel config, keep the subscription non-fatal and retain initial/visibility reads.
- Centrifugo config: add a dedicated namespace with recovery enabled, `history_size` 5 and `history_ttl` `60s` (or equivalent supported short TTL). Keep the existing sessions history for session-list recovery. Config files are deployment changes only: list each in the PR body; do not deploy the relay.
- Tests: bridge snapshot payload and byte-cap marker; one-second debounce and unchanged suppression; each relevant board-changing source schedules publication; strict UI parse/active-root filtering; positioned recovery updates snapshot and avoids extra reads when recovered; initial/unrecovered/visibility/oversized-marker reads; no interval at idle.

### Ownership manifest

Task `board-push` is assigned to one implementation worker, Tier 3, `gpt-6-astra` / `high`, in this shared checkout. Worker writable paths: `bridge/src/centrifugo-client.ts`, `bridge/src/centrifugo-client.test.ts`, `bridge/src/coordination/wiring.ts`, `bridge/src/coordination/wiring.test.ts`, `bridge/src/index.ts`, `bridge/src/security/ledger/channels.ts`, `bridge/src/security/ledger/channels.test.ts`, `bridge/src/command-rpc.ts`, `bridge/src/command-rpc.test.ts`, `bridge/src/session-board-snapshot.ts` (new), `ui/src/hooks/useSessionBoard.ts`, `ui/src/hooks/useSessionBoard.test.ts`, `ui/src/components/SessionWorkspace.tsx`, `ui/src/components/SessionWorkspace.test.tsx`, and `centrifugo/config.json`, `centrifugo/config.prod.json`, `centrifugo/config.fly.json`. Root transfers these board files now and will not write them until handoff; its own active writes remain limited to the other previously listed paths. No generated files, lockfiles, Git operations, test services, or E2E resources are assigned. Worker consumes the frozen payload above and existing `BoardSnapshot`, `accountChannel`, secure subscription, and RPC contracts. Root owns integration, deployment-config PR explanation, all E2E/runtime execution, and landing. Worker may run only assigned bridge unit/static checks. Do not change `contract.ts` (frozen) or edit outside this manifest. Handoff must list changed files, checks, findings, and release all file leases.
