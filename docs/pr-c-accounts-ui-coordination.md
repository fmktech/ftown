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
