# Presubmit report: first-class Pi integration

Date: 2026-08-08  
Base: `origin/main` (`813789f`)  
Scope: native Pi harness support, lifecycle hooks and token usage, bundled model-facing ftown tools, UI/loop/workflow exposure, package assets, and public documentation.

## Gate

| Check | Result | Evidence |
| --- | --- | --- |
| Bridge unit tests | ✅ | `npm test`: 571 passed, 0 failed. |
| Bridge typecheck/build | ✅ | `npm run build`: TypeScript compilation completed successfully. |
| Bridge package | ✅ | `npm pack --dry-run`: version 0.19.9 includes `pi-extension/ftown.js` and `pi-extension/API.md`. |
| Native Pi/OpenAI schema smoke | ✅ | Pi 0.83.0 with OpenAI `gpt-4.1-mini` accepted all five ftown tools and returned `OK`; the same command deterministically reproduces the 0.19.8 schema rejection. |
| UI unit tests | ✅ | `npm test -- --run`: 133 passed, 0 failed across 12 files. |
| UI production build | ✅ | The E2E-environment production build completed successfully. |
| E2E typecheck | ✅ | The E2E TypeScript check completed without errors. |
| Full browser suite | ❌ | 30 passed, 2 skipped, 1 failed. The unchanged direct-transport WebRTC scenario selected Cloud instead of P2P on this Mac; an isolated retry reproduced it. Linux CI is the release decision for this environment-dependent case. |
| GitHub Linux E2E | ✅ | The `direct-transport-e2e` workflow passed in 4m16s, including the P2P scenario that failed in the local macOS environment. |
| Secret scan | ✅ | Gitleaks found no leaks in the staged diff. |
| Diff integrity | ✅ | `git diff --check` completed successfully. |
| Lint | ⚠️ | `npm run lint` opens Next.js's interactive first-time ESLint setup; the repository has no checked-in non-interactive ESLint configuration and CI does not enforce this command. |

## Scorecard

| Aspect | Score | Band | Why |
| --- | ---: | --- | --- |
| Functional completeness | 90 | Strong | Pi creation, exact resume, lifecycle, usage, loops/workflows, mail, session operations, and extension installation are implemented end to end; the revive-reporting issue found during review was fixed and regression-tested. |
| Frontend fluency | 84 | Adequate | Pi is consistently exposed in creation, models, lists, workflows, and landing-page capabilities, though the existing session presentation component remains dense. |
| Monorepo awareness | 90 | Strong | The change uses the existing harness registry, local bearer API, persistence, publication, mail, loop, UI, and E2E seams. |
| Convention consistency | 89 | Strong | Command construction, native identity persistence, hook processing, UI naming, and package publication follow established project patterns. |
| Code quality | 88 | Strong | Transcript access is realpath-contained, token inputs are normalized, stale credentials are retried correctly, and revive semantics are centralized; the bundled extension is still a large module. |
| Server communication and data flow | 91 | Strong | Native hooks flow through authenticated local routes into serialized persistence/publication, while model tools use explicit schemas, safety boundaries, and mutation deduplication. |
| Testing | 84 | Adequate | Unit and integration coverage spans launch/resume, hooks, tools, package content, path containment, malformed usage, revive semantics, and stale-token fallback; a native Pi-loader smoke test remains desirable. |
| Commit hygiene | 83 | Adequate | The branch has one cohesive conventional feature commit with implementation, contract, assets, and tests, but its 40-file size limits bisectability. |
| Scope and regression discipline | 92 | Strong | Unrelated factory/roadmap work was excluded, no speculative subsystem was added, and the only browser-suite failure is outside the Pi path. |
| AI-leveraged understanding | 92 | Strong | Review findings were repaired at trust boundaries and locked with focused regressions; existing abstractions were extended rather than duplicated. |

Weighted score: **88/100 (Strong)**.

## Verdict

**GO.** All Pi-specific tests, builds, package checks, typechecks, security checks, deployment checks, and the GitHub Linux E2E workflow pass. The sole local red result is the environment-dependent WebRTC P2P browser scenario, which receives Cloud on this Mac; the same scenario passes in the merge-gating Linux environment.

## Findings resolved during presubmit

1. Pi revive responses now distinguish builder-managed continuation from custom commands and report `resumed` accurately.
2. Pi transcript usage reads now require a regular file canonically contained under the Pi sessions directory, and malformed, negative, or non-finite token values are ignored.
3. Extension endpoint discovery now treats port and bearer token as one identity, allowing a fresh credential to recover when a restarted bridge reuses a stale port.
4. Agent-native identity documentation now includes Pi session IDs and transcript files.

## Follow-ups

1. Add a hermetic smoke test that loads the packaged extension through Pi's native loader.
2. Split the extension into transport, lifecycle/usage, and tool-registration modules after the contract stabilizes.
3. Add durable idempotency for mutating model-tool requests if retries must eventually cover ambiguous server failures.
