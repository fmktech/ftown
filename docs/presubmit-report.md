# Presubmit report: move sessions between parents

Date: 2026-08-06  
Base: `origin/main` (`892c26c`)  
Scope: bridge reparenting validation/API documentation, dashboard drag-and-drop wiring, and browser acceptance coverage.

## Gate

| Check | Result | Evidence |
| --- | --- | --- |
| Bridge unit tests | ✅ | `npm test -- --run`: 526 passed, 0 failed. |
| Bridge typecheck/build | ✅ | `npm run build`: `tsc` completed successfully. |
| Bridge package | ✅ | `npm pack --dry-run`: produced the `ftown-bridge-0.19.5.tgz` manifest. |
| UI unit tests | ✅ | `npm test -- --run`: 129 passed, 0 failed. |
| UI typecheck | ✅ | `npx tsc --noEmit`: no errors. |
| UI production build | ✅ | `npm run build`: completed successfully; existing Edge-runtime and metadata warnings remain. |
| New browser acceptance | ✅ | Focused Playwright run: center-drop reparent and bridge-root detach passed in Chromium. |
| Full browser suite | ❌ | 28 passed, 2 skipped, 1 failed: the WebRTC test selected Cloud instead of P2P. The identical failure was reproduced from a clean `origin/main` worktree, so it is an environmental/baseline failure rather than a regression in this diff. |
| Lint | ⚠️ | The UI lint command launches Next.js's interactive first-time configuration; no repository lint configuration is available for a non-interactive gate. |
| Format | ⚠️ | No enforced repository format-check script is configured. `git diff --check` passes. |

## Scorecard

| Aspect | Score | Band | Why |
| --- | ---: | --- | --- |
| Functional completeness | 83 | Adequate | Both API and drag workflows are implemented; the new browser happy path now passes. |
| Frontend fluency | 68 | Weak | Drop zones and feedback are coherent, but drag remains mouse-oriented and the mutation has no visible pending/error state. |
| Monorepo awareness | 88 | Strong | Changes use the existing bridge controller/RPC, session store, UI hook, and E2E harness. |
| Convention consistency | 91 | Strong | The implementation follows the established update/save/publish and dashboard state patterns without new dependencies. |
| Code quality | 72 | Adequate | Drop policy is isolated and typed; the large session-list component still owns substantial event wiring. |
| Server communication and data flow | 74 | Adequate | UI, RPC, HTTP controller, persistence, and publication are wired end-to-end with authoritative server validation. |
| Testing | 81 | Adequate | Pure policy, controller, RPC, real HTTP/store, and browser drag behavior are covered. |
| Commit hygiene | 42 | Poor | The grading panel ran before the work was split into reviewable commits; this is corrected before push. |
| Scope and regression discipline | 88 | Strong | No dependencies or unrelated product areas changed; the only full-suite failure reproduces on the base revision. |
| AI-leveraged understanding | 89 | Strong | Existing seams were reused, validation is defense-in-depth, and the separate startup investigation records falsified hypotheses without guessing. |

Weighted score: **79/100**. The two highest-weight differentiators are monorepo awareness and convention consistency.

## Verdict

**NO-GO under the strict local gate**, because the repository's enforced full E2E command exits non-zero. The failure is not caused by this change: it reproduces unchanged on `origin/main`, while the newly added drag-and-reparent browser scenario is green. A clean CI environment should be used as the release decision for this environmental WebRTC case.

## Prioritized follow-ups

1. Confirm the full E2E suite in CI or resolve the local WebRTC routing condition that makes the baseline select Cloud instead of P2P.
2. Keep backend, frontend/E2E, package-version, and investigation/report changes in separate conventional commits.
3. Add visible failure feedback around `setSessionParent` if reparenting errors need to be recoverable directly from the dashboard.
4. Capture the exact stdout/stderr from the reported `npx -y ftown-bridge@latest` startup failure; the published package starts and reaches pairing in a clean reproduction.
