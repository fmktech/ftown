# PR C: multi-account dashboard coordination

## Frozen integration contract

Bridge command `get_accounts` is authenticated and read-only. Request payload is `{ bridgeId }`; success data is `{ accounts: Array<{ id: string; harness: 'claude' | 'codex'; label?: string; isDefault: boolean }> }`. It returns one explicit `{ id: 'default', isDefault: true }` per harness plus registered accounts with `isDefault: false`. These are the only account fields crossing the RPC; never expose configDir paths. Invalid bridge ids follow existing command error conventions. The UI sends account id on session creation and `allowedAccounts` when set. Missing `account` means default. Account choices are filtered by shell harness; a child session's parent `allowedAccounts` limits the account picker and its allowed-accounts choices. Default is available only when explicitly allowed by parent policy.

Quota display reads `ProviderQuota.account`; missing account means `default`. Render one row per provider/account, sorting default first, then accounts alphabetically, provider order stable within each account. Show the account label/id on non-default rows.

## Ownership manifest

Shared checkout: current PR worktree. Root is integration/Git owner, owns dependency installs, E2E execution, screenshots, and PR creation. No shared resource leases for workers.

| Task | Tier / model / effort | Writable files | Dependencies |
| --- | --- | --- | --- |
| Bridge account-list RPC | Tier 1 / `gpt-6.1-terra` / `medium` | `bridge/src/command-rpc.ts`, `bridge/src/command-rpc.test.ts`, `bridge/src/types.ts`, `bridge/src/security/bridge/permissions.ts`, `bridge/src/security/bridge/permissions.test.ts`, `bridge/package.json`, `bridge/package-lock.json` | Contract above; package version 0.30.29; no UI dependency |
| Dashboard multi-account UI | Tier 2 / `gpt-6.1-sol` / `max` | `ui/src/types.ts`, `ui/src/hooks/useSessions.ts`, `ui/src/hooks/useSessions.test.ts`, `ui/src/lib/model-routing.ts`, `ui/src/lib/model-routing.test.ts`, `ui/src/components/NewSessionModal.tsx`, `ui/src/components/NewSessionModal.test.tsx`, `ui/src/components/ModelRoutingDialog.tsx`, `ui/src/components/ModelRoutingDialog.test.tsx`, `ui/src/components/SessionList.tsx`, `ui/src/components/SessionList.test.tsx`, `ui/src/components/Dashboard.tsx`, `ui/src/components/Dashboard.test.tsx`, plus one focused E2E spec under `e2e/` | Frozen RPC contract; parent/child Session fields from `bridge/src/types.ts`; quota `ProviderQuota.account` from `bridge/src/quota/types.ts` |

Before writing, confirm active agents and disjoint ownership. Workers must not edit outside their file list, install dependencies, run E2E/browser/server/database/CI commands, or perform Git operations. Component and isolated unit tests are worker-authorized. Root executes the focused Playwright E2E, checks desktop/mobile screenshots, dependencies, and integration gates after handoff. Do not add references to the brief in the product UI. Each handoff names changed files, checks/results, unresolved items, and releases ownership.

## Acceptance

- Authenticated `get_accounts` returns only account id, harness and optional label; tests prove caller verification/read permission and malformed payload rejection.
- New Session shows Claude/Codex account picker only for matching shell types; default is first. Child picker is constrained by parent `allowedAccounts`. Optional multi-select writes `allowedAccounts`.
- Session create includes selected `account` and `allowedAccounts`; account defaults stay omitted/default when appropriate.
- Non-default account badge appears in sidebar and selected-session header; default/absent has no badge.
- Quota rows are keyed and rendered per provider/account, default first, with readable labels and no collision for same-provider rows.
- Component tests cover picker, badge and quota rows. Focused Playwright creates a non-default account session from dashboard and observes the badge. Root captures desktop/mobile screenshots and attaches them to PR.
- Install `ui/` dependencies once; install `bridge/` dependencies once because the bridge RPC changes. Run focused component tests and bridge test. Root runs only the focused E2E for this feature, then the repository PR gates. Push, open PR using merge commits (never squash), link it to the FTown session, monitor CI without blind retries; do not mark done until green.

## Version decision

The account RPC is a bridge change. Parent supplied version `0.30.29`; both `bridge/package.json` and `bridge/package-lock.json` must match before pushing.

## Review repair round 1

The original UI writer released ownership. Reassign only these files to the Tier 1 repair worker for a bounded repair; reviewer `prc_review` remains read-only.

| Task | Tier / model / effort | Exclusive writable files | Required behavior |
| --- | --- | --- | --- |
| Correct child account inheritance and routing account changes | Tier 1 / `gpt-6.1-terra` / `medium` | `ui/src/components/NewSessionModal.tsx`, `ui/src/components/NewSessionModal.test.tsx`, `ui/src/components/ModelRoutingDialog.tsx`, `ui/src/components/ModelRoutingDialog.test.tsx` | For a non-Claude/Codex child shell, omit `account` from the create payload so bridge inheritance and its harness validation remain authoritative; still send selected `parentSessionId` and optional `allowedAccounts`. Keep the account picker hidden on other shells, but show the optional child `allowedAccounts` multi-select there too (the bridge policy applies to every shell). When the selected parent itself has a parent, mirror bridge resolution: use the selected session's direct policy intersected with its immediate parent's policy if both exist; inherit the effective account from that immediate parent (fall back to selected session account only if no resolved session is present). Changing CLI provider clears a routing pick's `account`; changing model/effort for the same provider preserves it. Never silently replace a requested non-default clone/parent account with default when account lookup errors, is unsupported, or returns no such id; block creation with a clear retry/update/stale-account message. Add focused component assertions for each case. |

Run only the targeted component tests for the changed files and release ownership. Root reruns the UI build/typecheck and focused E2E if the changed behavior affects its path; no E2E run by the worker.

## Review repair round 2

The first repair writer released all four files; assign the same four files to a Tier 1 Terra/medium follow-up after confirming no active writer.

| Task | Tier / model / effort | Exclusive writable files | Required behavior |
| --- | --- | --- | --- |
| Block incompatible inheritance and preserve explicit replacements/policies | Tier 1 / `gpt-6.1-terra` / `medium` | `ui/src/components/NewSessionModal.tsx`, `ui/src/components/NewSessionModal.test.tsx` | Bridge contract deliberately inherits the resolved parent's stored account (including literal `default`) if `account` is omitted. For an account-aware child shell, the effective account id is `resolvedParent?.account ?? 'default'` (direct session account only if it is the resolved parent/root); parent policy uses the selected session's direct policy intersected with resolved policy if both exist, otherwise whichever exists. For a child shell without a Claude/Codex account harness, the bridge succeeds only when the resolved parent's stored account is absent and the effective policy (if any) permits `default`; otherwise prevent submit with an explanation. If a requested non-default account is absent/unverified, block until lookup succeeds or the user explicitly changes the account picker to another available choice (including Default). Reset explicit-choice marker when bridge/shell/parent/modal defaults change. For cloned sessions carrying `allowedAccounts`, do not filter stored policy against a partial or unavailable registry while loading/error/unsupported; preserve it unchanged or block create until it can be presented faithfully. Never silently submit an empty list. Surface account-list failures and stale policy information for non-Claude/Codex shells too. Add component tests for parent stored-account values of absent/default/non-default against non-account shells and policies that include/exclude default, choosing a valid replacement, and preserving existing child policy during loading/error. |

Run only the targeted modal component tests on Node 24.22.1. Root verifies full combined behavior and the blocked E2E environment; no E2E by workers.

## Contract update after parent direction

Parent selected bridge version `0.30.29` and clarified the RPC response. Do not alter this contract without routing changes through the architect:

```ts
{ accounts: Array<{ id: string; harness: 'claude' | 'codex'; label?: string; isDefault: boolean }> }
```

Return one explicit default row per harness (`id: 'default', isDefault: true`) and every registry entry (`isDefault: false`). The response may contain duplicate `id: 'default'` across the two harnesses; all other ids are globally unique. No other fields, especially no `configDir`, may be returned. The command requires authenticated read permission.

### Contract adaptation tasks

| Task | Tier / model / effort | Exclusive writable files | Acceptance |
| --- | --- | --- | --- |
| Update RPC response and bridge release version | Tier 1 / `gpt-6.1-terra` / `medium` | `bridge/src/command-rpc.ts`, `bridge/src/command-rpc.test.ts`, `bridge/package.json`, `bridge/package-lock.json` | Emit exact fields above, defaults first by canonical harness order then registry entries; test both defaults, registered entry projection, and absence of configDir/extra fields; set package and lock version to 0.30.29 and run focused RPC tests/build. Existing `bridge/src/types.ts` and permissions files are frozen at their current state and read-only for this adaptation. |
| Consume explicit defaults in the modal | Tier 1 / `gpt-6.1-terra` / `medium` | `ui/src/types.ts`, `ui/src/components/NewSessionModal.tsx`, `ui/src/components/NewSessionModal.test.tsx` | Strictly parse `isDefault`; accept exactly one default per harness and allow duplicate `default` IDs across harnesses only; use the selected harness's explicit default row (do not synthesize a second one); preserve existing visible default label and parent-policy filtering. Update fixtures/tests and run focused modal tests. |

Root owns integration, full focused UI tests, E2E, screenshots, commits, push and PR. Workers must not change E2E spec, run E2E, install dependencies or perform Git operations; root already installed UI/bridge/E2E dependencies once.

## PR #270 CI diagnostic repair

Head `5b0e1f3bf29f04ab0e9740d408a890df8407c7fb` failed desktop/mobile picker cases in direct-transport-e2e shard 1. CI trace shows the isolated bridge selected, but its log has no `get_accounts` handler invocation. The UI presents the same generic error for a failed response and a rejected/timed-out send, so current evidence does not identify the exact cause. Preserve the authenticated read policy until a concrete code is captured.

| Task | Tier / model / effort | Exclusive writable files | Acceptance |
| --- | --- | --- | --- |
| Capture sanitized get_accounts failure diagnostics | Tier 1 / `gpt-6.1-terra` / `medium` | `ui/src/components/NewSessionModal.tsx`, `e2e/tests/harness-accounts.spec.ts` | Distinguish an RPC failure response from a local send rejection/timeout; capture only a bounded code matching `[a-z0-9_]{1,64}` or generic error category in test failure artifacts. Do not change user-facing copy, auth, account contract, or test stack. Add focused component coverage if appropriate. Run targeted UI component tests and E2E TypeScript check only. Worker must not run E2E/browser/server/stack, CI, or Git operations. Root integrates and uses the new evidence to determine the code fix. |

The first diagnostic commit `8a938d7` did not compile in CI because `CommandResponse.data` is typed as `{}`. Root reproduced this with `npm run build` in `ui/` (same TS error at `NewSessionModal.tsx:433`); E2E did not start. Follow-up: narrow `data` with a runtime object/key guard before reading `code`, preserve the sanitized output, rerun the targeted modal test and `ui` build on Node 24.22.1. Root owns push and CI observation.

CI run `43948763354` then failed both picker viewports with diagnostic `response:outcome_unknown`. The test’s isolated bridge logs contain `list_sessions` but no `get_accounts`; the DOM trace shows the modal selected the isolated bridge ID and then displayed the generic failure. To correlate the request with the captured per-bridge logs without changing the bridge, log only target bridge UUID and random RPC request UUID in test-captured diagnostics and include them in the failure artifact. Worker scope remains the modal and E2E spec. No local E2E, stack, CI rerun, or bridge changes by worker.

Run `43951894787` correlation results: desktop targeted bridge `ae722ee4-875d-4763-8a46-ac878215f411`, request `79218f94-ce17-4ba9-a215-0d84407660c2`, received `response:outcome_unknown`; its isolated log only shows startup and `list_sessions`. Mobile likewise targeted `f3a68824-b8a6-41fd-ae5b-c89e519372c4`, request `b2f8989c-5441-4386-8c9d-0e332762cdda`, with only `list_sessions` in its isolated log. The non-isolated bridge `197f7ffa-dfcd-44fe-88fb-da7296dfa534` did receive its separate request `5ce516b8-e8fd-4158-af1d-2084f4475c1e` as `get_accounts`. This initially suggested a post-admission dispatch failure. Subsequent inspection of the per-test process output and CI trace established that the request races startup readiness; see the investigation and repair sections below.

## PR #270 encrypted get_accounts dispatch investigation

Parent approved further bridge changes in the same unmerged PR at version 0.30.29; package and lock versions remain frozen. Root owns investigation notes, integration, Git operations, CI and E2E policy. The encrypted regression test was implemented in `bridge/src/security/bridge/security.test.ts`. It sends sealed get_accounts and list_sessions packets through a Centrifugo subscription, authenticated admission, local secure dispatch, and the real command handler, then verifies decrypted responses and account metadata. Both commands pass; this rejects a missing command registration explanation.

## PR #270 readiness-race repair

Root investigation proves the failing test sends `get_accounts` before its isolated bridge reaches its ready marker: CI trace has `response:outcome_unknown`; the isolated process output has only startup/pairing lines and no `[Bridge] Ready and listening for commands`; `startIsolatedBridge` returns after pointer/presence only; the secure command subscriber throws `Bridge is starting` before dispatch when `ready` is false. The real encrypted regression test passes both commands when the bridge is initialized. Parent approved bridge 0.30.29 for this unmerged PR; no version bump.

The helper must remain unpaired when it returns, so it exposes a bounded `bridge.waitReady()` method. The account spec calls it immediately after `approvePairLink`, before loading the dashboard. It recognizes the ready log and fails clearly on process exit or timeout; unrelated isolated bridge tests retain their existing helper behavior.

| Task | Tier / model / effort | Exclusive writable files | Acceptance |
| --- | --- | --- | --- |
| Gate account E2E on readiness | Tier 1 / `gpt-6.1-terra` / `medium` | `e2e/helpers/ledger-bridge.ts`, `e2e/scripts/ci-fixtures.test.mjs`, `e2e/tests/harness-accounts.spec.ts` | Add bounded `IsolatedBridge.waitReady()` over captured process output; call it after pairing in the account test before dashboard interaction. Cover delayed readiness, timeout and process exit. Do not alter app command/security behavior or run local E2E/browser/server/stack/CI, install dependencies or perform Git operations. Root owns focused helper tests, CI and Git. |
