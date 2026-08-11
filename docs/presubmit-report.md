# Presubmit report: Pi wake by ftown mail

Date: 2026-08-11  
Base: `origin/main` (`0cea112`)  
Feature commit: `0640afc`  
Scope: wake idle Pi sessions from durable ftown mail inside the bundled harness extension.

## Gate

| Check | Result | Evidence |
| --- | --- | --- |
| Bridge unit tests | ✅ | `npm test`: 575 passed, 0 failed. |
| Bridge typecheck/build | ✅ | `npm run build`: TypeScript compilation completed successfully. |
| Bridge package | ✅ | `npm pack --dry-run --json`: 0.19.10 includes the Pi extension, API contract, and ftown skill docs. |
| UI unit tests | ✅ | `npm test`: 133 passed, 0 failed across 12 files. |
| UI production build | ✅ | The E2E-environment production build completed successfully. |
| E2E typecheck | ✅ | `npx tsc --noEmit` completed without errors. |
| Full browser suite | ✅ | 31 passed and 2 pre-existing tests were skipped. |
| Live Pi mail smoke | ✅ | An idle Pi received mail without terminal input, started a native turn, and replied `WAKE_BY_MAIL_OK`. |
| Diff integrity | ✅ | `git diff --check` completed successfully. |
| Lint | ⚠️ | `npm run lint` opens the repository's pre-existing interactive Next.js ESLint setup; CI does not enforce it. |

## Scorecard

| Aspect | Score | Band | Why |
| --- | ---: | --- | --- |
| Functional completeness | 94 | Strong | Idle wake, native follow-up, singleton polling, permanent shutdown, no PTY fallback, durable gap handling, and live Pi behavior are complete. |
| Frontend fluency | N/A | N/A | This bridge-local harness change has no frontend surface. |
| Monorepo awareness | 93 | Strong | The change stays in the bridge-owned extension, mail service, package, tests, and installed documentation surfaces. |
| Convention consistency | 91 | Strong | It extends the existing authenticated request, inbox, lifecycle, test-double, and package-release patterns. |
| Code quality | 92 | Strong | Cancellation is end-to-end, listener state has one owner, failures use capped backoff, cleanup handles both task outcomes, and no dependency was added. |
| Server communication and data flow | 92 | Strong | The bridge remains the durable owner; waiter identity and disconnect guards prevent dead clients from consuming mail. |
| Testing | 95 | Strong | Behavioral regressions cover native wake, exact delivery mode, duplicate lifecycle events, shutdown, no PTY fallback, Pi eligibility, and deterministic backoff. |
| Commit hygiene | 96 | Strong | One conventional, reviewer-meaningful feature commit contains the coherent implementation, tests, docs, and patch release bump with an explanatory body. |
| Scope and regression discipline | 94 | Strong | No UI/API/database/dependency churn; bridge, UI, and full browser regression gates pass. |
| AI-leveraged understanding | 96 | Strong | Existing abstractions were reused, live behavior was verified, and review findings became focused safety and retry regressions. |

Weighted score: **94/100 (Strong)**.

## Verdict

**GO.** All enforced gates are green. Pi mail wake-up is native-only, cancellable,
rate-limited on failure, and verified against an actually idle Pi session.

## Findings resolved during presubmit

1. Removed the old Pi terminal-nudge fallback; mail remains durable between native polls.
2. Locked repeated start, `agent_settled`, shutdown, and post-shutdown behavior to one listener and one injection.
3. Replaced fixed failure retries with capped exponential backoff and safe fulfilled/rejected task cleanup.

## Follow-ups

1. Model mail-delivery mode as an explicit harness capability if another native persistent listener is added.
2. Consider a delivery acknowledgment/lease protocol only if crash-safe exactly-once enqueue becomes a requirement.
3. Convert the live Pi smoke into an opt-in automated script when Pi is available in CI.
