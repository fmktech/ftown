# PR status badges verification

## CI repair verification

After main added HTML previews in c5d955d, the PR had adjacent merge conflicts. The resolved union preserves both features and bumps bridge version to0.19.62. Independent integration review approved;38focused bridge and76UItests plus both typechecks passed. Root reran all3visual viewport checks and then real Linux focused session-tools+session-preview E2E:4passed in38.3s, all prerequisite suites/builds passed and cleanup succeeded. A first fresh-environment attempt stopped before application tests because PostgreSQL's initialization socket briefly satisfied Docker health before its final TCP server; the root-only launcher now performs bounded TCP SELECT1 readiness before unchanged schema setup. No production CI workflow, assertions or browser retry/timeouts were changed.

The initial CI run exposed a missing inert status-service dependency in the startup test harness. Root reproduced four failures locally; repaired harness preserves all startup assertions and verifies dependency forwarding. Isolated readiness tests now pass5/5, full bridge suite1102passed/4skipped. Repair commit1429fec.

The subsequent full CI browser run passed70, skipped2 and failed both session-tools viewport cases: a wider badge covered the parent expand control, and an exact neutral accessible-name selector became stale when status arrived. Root reproduced the overlap at260px before repair. Rows now reserve space for the tree/name and constrain badge width with ellipsis; complete status remains accessible in title/aria-label. Tests select stable PR identity while preserving href/target/rel, normal navigation and expand/collapse checks.

Root's strengthened visual harness passed210px/260px desktop sidebars and390px mobile, including >=30px visible parent-name width, nested row geometry, matching placeholder width, ordinary tree clicks and zero selection callbacks from badge clicks. Screenshots inspected; independent review approved. Focused UI41tests and typecheck passed.

Root executed the real `session-tools.spec.ts --project=chromium --workers=1` in a fresh no-secret Linux Boat development sandbox, using existing CI preflight, isolated localhost PostgreSQL, builds and cleanup. Both desktop/mobile tests passed in13.8seconds on2026-10-30. All prerequisite checks/builds passed. Services, disposable browser homes, containers and database volume were removed by cleanup. No full CI rerun was used to debug the UI repair.

Validated on 2026-10-30 in the isolated task checkout with Node 24.22.1.

- Bridge focused tests: 21 passed (`node --import tsx --test src/pull-request-status.test.ts src/command-rpc.test.ts src/security/bridge/permissions.test.ts`). Covers authentication, cache bounds, request budgets, batch fairness, partial GraphQL errors and status classification.
- UI focused and adjacent tests: 41 passed (`npx vitest run src/hooks/usePullRequestStatuses.test.tsx src/components/PullRequestLink.test.tsx src/components/session-pull-request.test.ts`). Covers scheduling, visibility, stale states, labels and existing link accessibility.
- Bridge and UI TypeScript checks passed. Both production builds passed. UI build used a temporary command-scoped synthetic AUTH_SECRET; existing Next.js themeColor metadata warnings remain.
- Root executed `node --import tsx ../docs/investigations/pr-ci-status/runtime-smoke.ts` from bridge: encrypted RPC, two callers sharing one fake gh process, unauthorized caller rejection, local harness readiness, and cleanup passed. No production data used.
- Root executed `node --experimental-strip-types docs/investigations/pr-ci-status/visual-smoke.ts`: actual SessionList and badge components at 1280x900 and 390x844 passed placeholder width, overflow, keyboard focus, link navigation and menu checks. Screenshots were visually reviewed. UI RPC was simulated.
- One live schema query and one production adapter query against an existing merged PR verified GitHub compatibility. A second adapter read reused the cache. No repeated live polling was used.
- Independent review approved the final production changes; no remaining findings. `git diff --check` passed.

Root owned both runtime/browser runs and all temporary servers. Runtime port closed and temporary runtime directories removed; browser/server cleanup completed. No deployment, database migration or full application E2E suite was performed. The request budget is per bridge process, not an account-wide quota, and GraphQL point cost can vary.
