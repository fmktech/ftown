# PR status badges verification

Validated on 2026-10-30 in the isolated task checkout with Node 24.22.1.

- Bridge focused tests: 21 passed (`node --import tsx --test src/pull-request-status.test.ts src/command-rpc.test.ts src/security/bridge/permissions.test.ts`). Covers authentication, cache bounds, request budgets, batch fairness, partial GraphQL errors and status classification.
- UI focused and adjacent tests: 41 passed (`npx vitest run src/hooks/usePullRequestStatuses.test.tsx src/components/PullRequestLink.test.tsx src/components/session-pull-request.test.ts`). Covers scheduling, visibility, stale states, labels and existing link accessibility.
- Bridge and UI TypeScript checks passed. Both production builds passed. UI build used a temporary command-scoped synthetic AUTH_SECRET; existing Next.js themeColor metadata warnings remain.
- Root executed `node --import tsx ../docs/investigations/pr-ci-status/runtime-smoke.ts` from bridge: encrypted RPC, two callers sharing one fake gh process, unauthorized caller rejection, local harness readiness, and cleanup passed. No production data used.
- Root executed `node --experimental-strip-types docs/investigations/pr-ci-status/visual-smoke.ts`: actual SessionList and badge components at 1280x900 and 390x844 passed placeholder width, overflow, keyboard focus, link navigation and menu checks. Screenshots were visually reviewed. UI RPC was simulated.
- One live schema query and one production adapter query against an existing merged PR verified GitHub compatibility. A second adapter read reused the cache. No repeated live polling was used.
- Independent review approved the final production changes; no remaining findings. `git diff --check` passed.

Root owned both runtime/browser runs and all temporary servers. Runtime port closed and temporary runtime directories removed; browser/server cleanup completed. No deployment, database migration or full application E2E suite was performed. The request budget is per bridge process, not an account-wide quota, and GraphQL point cost can vary.
