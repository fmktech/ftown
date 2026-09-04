# Presubmit report: bridge rotating refresh recovery

Date: 2026-09-03
Base: `origin/main` (`c7f6c26`)
Feature commit: `9d6fc6b`
Scope: stop permanent Centrifugo refresh rejection loops and recover stale in-memory state from a newer persisted rotating token.

## Gate

| Check | Result | Evidence |
| --- | --- | --- |
| Bridge unit tests | ✅ | `npm test`: 742 passed, 0 failed. |
| Bridge build/typecheck | ✅ | `npm run build`: TypeScript completed without errors. |
| UI unit tests | ✅ | `npm test`: 226 passed across 28 files. |
| UI production build/typecheck | ✅ | `npm run build`: compiled and generated all routes successfully. |
| E2E typecheck | ✅ | `npx tsc --noEmit` completed without errors. |
| Full browser suite | ✅ | 31 passed; 2 intentional pre-existing skips. |
| Diff integrity | ✅ | `git diff --check origin/main...HEAD` completed successfully. |
| Lint | ⚠️ | The repository's standalone Next.js lint command uses the pre-existing interactive ESLint setup; the production build's integrated lint/type checks passed. |
| Format | ⚠️ | No repository format-check script is defined; diff integrity is clean. |

The full browser suite ran against UI port 3010 because port 3000 was already occupied by an unrelated local process. The temporary test-origin configuration was reverted after the run and is not part of this change.

## Scorecard

| Aspect | Score | Band | Why |
| --- | ---: | --- | --- |
| Functional completeness | 94 | Strong | The repeated 401 loop is stopped, transient failures remain retryable, and restart-like disk recovery happens live. |
| Frontend fluency | N/A | N/A | This bridge-only fix has no user-interface surface. |
| Monorepo awareness | 97 | Strong | The change stays in the bridge workspace, synchronizes the package and lockfile patch version, and avoids API/UI/config churn. |
| Convention consistency | 93 | Strong | The focused service class and Node test-runner coverage follow existing bridge patterns. |
| Code quality | 90 | Strong | Token ownership and single-flight rotation are isolated behind a small typed abstraction. |
| Server communication and data flow | 88 | Strong | Terminal 401 and retryable 5xx semantics match the client contract; persisted-state recovery is bounded to one retry. |
| Testing | 90 | Strong | Regression tests cover status classification, stale-memory recovery, permanent rejection, and concurrent rotation; all repository gates pass. |
| Commit hygiene | 97 | Strong | One conventional, coherent fix commit directly atop `origin/main`, including tests, release version, and investigation evidence. |
| Scope and regression discipline | 97 | Strong | No dependencies or unrelated behavior changed, and the complete regression matrix is green. |
| AI-leveraged understanding | 88 | Strong | The investigation explicitly formed, falsified, and proved hypotheses before translating the causal model into focused tests and code. |

Overall score: **92/100 (Strong)**.

## Verdict

**GO.** Every enforced gate is green. Lint and formatting are advisory because this repository has no non-interactive standalone enforcement for them.

## Non-blocking follow-up opportunities

1. Make refresh-token persistence atomic and coordinate it across processes sharing one data directory.
2. Add a Centrifuge-client integration test that proves `UnauthorizedError` halts the SDK reconnect loop end to end.
3. Factor the persisted-token reader shared by startup and live refresh if that path grows further.
