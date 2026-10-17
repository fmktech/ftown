# Independent setup/CLI lifecycle review

Reviewer: `/root/review_all`, explicit `gpt-6.1-sol` / `high`.
Checkout: `/Users/fkesheh/projects/ftown-simplify-all`.
Only writable scope: this report. No application/Git/build/runtime leases.

## Pre-freeze review

Proposed contract accepted. Carry these concrete checks into the bounded implementation:

1. **Fresh package bootstrap.** Show an executable package command for setup when `~/.ftown/ftown` does not exist. Keep package entrypoints working without preinstalled assets. Installed canonical/legacy commands and stable hook aliases must not depend on an ephemeral npm/npx cache path; copy all transitive modules and needed runtime dependencies.
2. **Early read-only readiness gate.** Guard before `resolveDefaultDataDir()` (currently performs legacy `./data` migration), bridge identity writes, listeners, solo downloads and network/auth. Normal runtime pointer/session state remains permitted. Review imported modules for top-level global writes as well as the removed installer block. Preserve custom `--data-dir` isolation and data-path compatibility when moving legacy migration to setup.
3. **Durable success semantics.** Package-version setup readiness and immutable cleanup migration IDs are separate concerns: routine upgrades may update integrations without repeatedly replaying old cleanup; `--repair` deliberately repeats safe repair. Record completion atomically only after all required work succeeds, and do not swallow installer failures into a success marker. A failed/interrupted setup is retryable. Explicitly handle missing optional harness binaries and new integrations added after initial setup. Avoid marking a newer setup as an older successful version during concurrent runs or stale package execution.
4. **In-process command safety.** Command imports cannot parse argv, run a command, write files, resolve bridge pointers or capture a stale HOME. Export shared execution functions; aliases delegate without spawning sibling Node processes. Build a fresh Commander tree for each harness invocation. Preserve stdout/stderr, exit status, arguments, exact stable hook paths, and import safety through physical and symlinked package paths. Ensure setup/help work with no bridge pointer.
5. **Role removal compatibility.** Ignore legacy orchestrator flags/fields across CLI/API/RPC/Pi/MCP/UI producers without special briefing, injected environment or advertised UI behavior. Preserve parent/child links, suppression, task content and explicit user-provided environment (including a user-provided variable with the old role name). Ordinary parent/child grouping in session lists is not itself a role mode.

Evidence: read root contract, current bridge instructions and RTK guidance; Semble located startup integrations, package/install entrypoints, dispatcher/harness modules and role behavior. Inspected startup ordering and role/session injection points directly. No E2E, servers, browser, CI, databases or Git mutation executed. Final implementation review pending root handoff.

## Initial core implementation review (in progress)

Three concrete findings sent to architect and implementation worker before final source handoff:

- Startup still invokes `resolveDefaultDataDir()`, which renames legacy `./data` into global `~/.ftown/data`. This contradicts setup-only migration semantics even though it now follows the readiness gate.
- Readiness checks only five assets. Missing shared command modules, Commander dependency, stable hook alias or generated guide can leave setup reported current and startup accepted while commands/hooks fail. Derive required readiness from the installation/runtime inventory.
- Setup has atomic marker replacement but no exclusive setup lock or newer-version protection. Two setup processes can interleave runtime writes and success records; invoking stale package setup can overwrite a newer runtime/state. Serialize machine setup and prevent unintended stale-version rollback.

Command body comparison against base: sessions/harness/env retain their existing behavior with expected role removal and in-process returns. Shared HTTP/pointer/session/mail helpers replace duplication; harness Commander tree is fresh per call. Package aliases delegate to common dispatch and copied runtime supports later repair independent of the package cache. Final code and runtime gates still pending.

## Final application review and closure

Reviewed the final shared CLI runners, aliases, setup/runtime installer, readiness/state/lock code, stable migrations, startup diff, role removal across producers/consumers, installer failure returns, regression tests, Docker/docs changes and root-owned smoke source.

The three core findings are fixed: default resolution is read-only and legacy migration is setup-owned; readiness checks the central runtime inventory plus aliases/dependency/assets; setup is serialized by an atomic-directory lock and rejects stale package versions before invalidating state. Lock reclamation requires a regular marker whose pid/token match its filename and a provably dead process. A fourth small finding (JSON null state crashing setup/repair) is fixed with invalid-root regression coverage. Existing strict cleanup ownership checks and user env preservation remain intact. No application correctness findings remain.

One final docs clarification sent to architect/worker: copied installed `ftown setup` cannot discover a newer npm package by itself. Upgrade instructions should invoke the new package's entrypoint (`npm exec --yes --package ftown-bridge@<new-version> -- ftown setup`), as the Docker instructions already do; installed `ftown setup --repair` repairs its copied current runtime.

Worker reports final clean bridge build and 171 focused pure tests passed, plus 7 final lock/state cases. Root reports UI suite 282 passed and landing setup command rendered correctly. Reviewer did not rerun checks or start runtime resources. Root's real local-only bridge smoke/full final gates remain pending.

## Final documentation and fixture closure

Upgrade instructions now explicitly invoke the new package version and explain that the copied alias does not discover package upgrades; docs finding closed.

Root's first full bridge run reported 776 passed, 1 failed, 4 skipped, with an intermittent EPIPE in unchanged Muse test-fixture stdin handling; its isolated rerun passed 11/11. Reviewed the subsequently authorized test-only repair: attach a stdin error listener before sending input, ignore only expected EPIPE from an inert child closing its pipe, preserve other stdin errors and await actual execFile exit status. Added regressions use queued input with exit 0 and exit 7, preventing masking of child failure. Implementation worker reports listener-free focused fixture checks 3/3. No plugin/runtime behavior changed. Independent review approves this bounded repair.

Root reports real local-only bridge smoke PASS across fresh/current/upgrade/repair/failure-retry/stale-version/cache-independence and two startup global snapshots, plus package .41 inventory PASS. UI suite 282 passed and rendered setup command checked. Full bridge rerun remains root-owned/pending. No unresolved code/docs findings.

## Accepted final handoff

Root final evidence after the fixture repair:

- Clean bridge build PASS; full bridge suite 779 passed, 4 skipped, 0 failed (783 tests, 178 suites).
- UI build and 282/282 tests PASS; native landing render verified the explicit setup command. Task-owned UI server/tab closed.
- Real local-only bridge smoke PASS: two starts preserve global integration snapshots; fresh/current/upgrade/repair/failure-retry/stale-version behavior, canonical/legacy aliases, parent/mail behavior, inert role input and copied-runtime cache independence verified. Temporary data/process cleanup confirmed. No cloud service, database or native agent harness used.
- Package inventory: 261 files at 0.19.41; required modules present and retired feature assets absent.
- Docker .41 setup configuration reviewed; image not built because the pinned package must first be published.

Independent review accepted by architect. No unresolved findings. Reviewer stopped writing and releases the sole `review.md` lease; no other resource leases held. Prior task report preserved. Ready for task-owned reviewer retirement; reopen only on actual landing drift or a new concrete failure.
