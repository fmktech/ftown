---
type: investigation
symptom: "The dashboard get_accounts request returns outcome_unknown for the selected isolated bridge, which never logs receipt of the command."
slug: get-accounts-encrypted-dispatch
date: 2026-11-16T17:54:19-03:00
investigator: Foad Kesheh
git_commit: 2c7b49301cd7601f3479f2489ee2e71dbcff8fe4
branch: feat/accounts-ui
repository: fmktech/ftown
status: resolved
hypotheses_formed: 5
hypotheses_rejected: 4
hypotheses_proven: 1
related:
  - docs/pr-c-accounts-ui-coordination.md
---

# get_accounts is not dispatched through encrypted bridge commands

## Symptom

- **Observed**: The PR #270 direct-transport-e2e shard 1 trace recorded `[get_accounts] bridge:ae722ee4-875d-4763-8a46-ac878215f411 request:79218f94-ce17-4ba9-a215-0d84407660c2 response:outcome_unknown`. The selected isolated bridge log contains startup and `[Bridge] Received command: list_sessions (requestId: fd2ceea0-...)`, but no get_accounts line.
- **Expected**: `get_accounts` reaches the authenticated read-only RPC handler and returns registered plus default account metadata.
- **Delta**: the dashboard's targeted encrypted request is rejected/ends unknown before the command handler logs it, so no accounts are displayed.

## Reproduction

1. CI PR #270 run `43951894787`, direct-transport-e2e shard 1, desktop or mobile.
2. Create the isolated bridge with registered account `coding`, open New Session, select that bridge, and inspect the account-picker options.
3. Inspect the attached `account-test-bridge.log` and `account-lookup-diagnostics.txt`.

Verified in the CI report artifact: both viewport runs reproducibly show only Default account; the target bridge log has no get_accounts handler entry. Per parent instruction, do not run local e2e or touch the local e2e stack.

## Hypotheses

#### H1: The wire command union or route validator rejects get_accounts before encrypted command dispatch.

- **Layer**: code-logic
- **Prediction**: The command type or route schema omits get_accounts, and an encrypted packet using it fails parsing.
- **Verification method**: inspect bridge/UI command unions and the actual secure route schema.
- **Evidence**:
  ```
bridge/src/types.ts:149:  | 'get_model_routing' | 'set_model_routing' | 'get_accounts' | 'handoff_session' | 'list_native_sessions';
ui/src/types.ts:171:  | 'get_accounts'
bridge/src/security/bridge/security.ts:20:  z.object({ kind: z.literal('command'), requestId: token, command: z.string().min(1).max(100), sessionId: token.nullable() }).strict(),
  ```
- **Verdict**: REJECTED
- **Rationale**: Both compile-time unions contain the command and the runtime route schema accepts any bounded command string; this layer does not exclude get_accounts.

#### H2: The security permission table denies get_accounts before dispatch.

- **Layer**: code-logic
- **Prediction**: classifyCommand does not classify get_accounts as a read command, so authenticated admission rejects it before the handler.
- **Verification method**: inspect the permission table and run its focused unit test.
- **Evidence**:
  ```
bridge/src/security/bridge/permissions.ts:8:  'get_model_routing', 'get_accounts', 'get_session_board']);
bridge/src/security/bridge/permissions.test.ts:94:  assert.deepEqual(classifyCommand('get_accounts', { bridgeId: 'bridge' }), { permission: 'read', mutating: false, operation: 'get_accounts', sessionId: null });
  ```
- **Verdict**: REJECTED
- **Rationale**: get_accounts is explicitly read-classified and the existing focused assertion covers it.

#### H3: The encrypted UI target selection sends get_accounts to a different bridge.

- **Layer**: integration
- **Prediction**: The target selected by the picker differs from the bridge UUID captured in the error or server-side bridge log.
- **Verification method**: compare the CI DOM snapshot, sanitized request diagnostic, and per-bridge logs.
- **Evidence**:
  ```
desktop: [get_accounts] bridge:ae722ee4-875d-4763-8a46-ac878215f411 request:79218f94-ce17-4ba9-a215-0d84407660c2 response:outcome_unknown
mobile: [get_accounts] bridge:f3a68824-b8a6-41fd-ae5b-c89e519372c4 request:b2f8989c-5441-4386-8c9d-0e332762cdda response:outcome_unknown
  ```
- **Verdict**: REJECTED
- **Rationale**: The CI modal selected the same isolated bridge whose log is attached; both requests correlate to their intended per-test bridge.

#### H4: The encrypted packet's route/data identity or payload shape differs from the accepted list_sessions command, so BridgeSecurityService rejects it before dispatch.

- **Layer**: dependency/integration
- **Prediction**: A real encrypted dispatch of the two command types through the same bridge security and dispatch wrapper will show list_sessions admitted and get_accounts rejected (or vice versa), with a concrete rejection code.
- **Verification method**: add a focused unit test using real packet sealing, BridgeSecurityService admission, and the actual command handler; assert the decrypted response and whether the handler is invoked. Compare route, requestId, payload.bridgeId, permission, and handler response.
- **Evidence**:
  ```
  encrypted browser read commands dispatch account metadata and session lists: both real sealed commands reached the handler and succeeded
  ```
  Focused test: `node --import tsx --test --test-name-pattern='encrypted browser read commands' src/security/bridge/security.test.ts` (passed); test now covers `CentrifugoClient.subscribeSecureCommands`, encrypted admission, local API dispatch, and real `createCommandHandler`.
- **Verdict**: REJECTED
- **Rationale**: The same route/data identity and security path accept both commands with a registered account. No wire, validator, permission or command handler mismatch reproduces the CI error.

#### H5: The account lookup races the isolated bridge's startup readiness; the command subscriber throws before local API / command handler dispatch.

- **Layer**: config-env / integration
- **Prediction**: On a failing run the selected bridge's output will not yet contain its ready marker, while the page shows the encrypted dispatch's `outcome_unknown`; the helper only waits for presence, which is published before readiness.
- **Verification method**: inspect exact Playwright trace and per-test bridge output, then compare `startIsolatedBridge` completion conditions and secure command subscription readiness guard.
- **Evidence**:
  ```
  trace console: [get_accounts] bridge:ae722ee4-875d-4763-8a46-ac878215f411 request:79218f94-ce17-4ba9-a215-0d84407660c2 response:outcome_unknown
  trace snapshot: New Session shows “Could not load accounts from this computer.”
  account-test-bridge.log: only LocalApiServer startup and pairing prompt; no “[Bridge] Ready and listening for commands” marker
  e2e/helpers/ledger-bridge.ts: startIsolatedBridge awaits waitForBridgePresence(...) and returns; it does not wait for ready
  bridge/src/index.ts:1130: if (!ready) throw new Error('Bridge is starting');
  bridge/src/security/bridge/execute.ts:37: dispatch exceptions after admission become code 'outcome_unknown'
  ```
- **Verdict**: PROVEN
- **Rationale**: CI trace and bridge output show the picker request occurs before the isolated process reaches its own ready marker. The secure command callback explicitly throws before `LocalApiServer.dispatchSecure`, producing the exact encrypted error code and no command-handler log. The list_sessions entry in the isolated log is a later request after readiness; it does not prove readiness at modal-open time.

## Root Cause

The test's isolated bridge is considered available when relay presence and its pointer appear, but these are published before startup completes. The account-picker fetch starts immediately after pairing/bridge-row visibility; when it lands during that window, `bridge/src/index.ts`'s secure-command subscriber throws `Bridge is starting` before `LocalApiServer.dispatchSecure` and `createCommandHandler`. `executeSecurePacket` maps that post-admission dispatch exception to `outcome_unknown`. This is a test fixture readiness contract gap, not a missing command-type registration.

### 5 Whys

1. Why does the picker only show the default account? Its one-shot request gets an encrypted `outcome_unknown` before the handler runs.
2. Why does dispatch return `outcome_unknown`? The subscriber callback throws `Bridge is starting` while the bridge's `ready` flag is false.
3. Why can the test send then? `startIsolatedBridge` returns after presence appears, which precedes the ready flag.
4. Why does presence precede ready? The bridge publishes its identity/presence while startup resurrection and coordination restoration are still completing.
5. Why did the feature test expose this? Its fixture treated discoverability as command readiness; the helper had no ready barrier, and account lookup is a one-shot read at modal open.

Rejected alternatives: H1 command unions/route schema accept get_accounts; H2 read permission is explicit; H3 trace target equals selected isolated bridge; H4 a real Centrifugo encrypted comparison dispatches both commands successfully.

## Falsification

The independent encrypted-path test exercises both `list_sessions` and `get_accounts` through a Centrifugo subscription, authenticated admission, dispatch and the actual handler with a registered account; both succeed and the account metadata is returned. This would falsify a missing command registration or account file parser explanation. It does not falsify the startup race because the fixture dispatches only after constructing an initialized security object and has no asynchronous bridge startup phase. The CI trace's absent ready marker plus the explicit pre-dispatch guard remains the better fit.

## Resolution

Added `IsolatedBridge.waitReady()` with a bounded wait and process-exit handling, and made the account E2E await it after bridge pairing and before dashboard commands. Added focused helper tests for delayed readiness, timeout, and process exit. This preserves the helper's unpaired return behavior for other tests while preventing account reads during startup.

Regression coverage: `bridge/src/security/bridge/security.test.ts` sends both `list_sessions` and `get_accounts` over a real Centrifugo secure-command subscription and verifies the encrypted replies and account metadata. It passed 19/19. `node --test e2e/scripts/ci-fixtures.test.mjs` passed 10/10. `npx tsc --noEmit` in `e2e/` passed. No local E2E or stack was started. CI E2E is the remaining verification gate.


