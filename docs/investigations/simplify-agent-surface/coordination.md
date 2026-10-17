# Simplify ftown's agent surface

## Scope and contract

User authorized all five proposed simplifications on 2026-10-17. Work against current main including PR #113. Preserve the original dirty checkout. All task workers share `/Users/fkesheh/projects/ftown-simplify-all`; no per-worker checkouts.

1. Stop bundling/installing fticket with ftown. Remove only provably ftown-managed installed assets on upgrade; preserve independently installed skills, custom paths, and user data.
2. Retire the workflow runner, CLI entrypoint/dispatcher routing, installer, bundled reference and examples. Remove source/runtime dependencies unique to it. Existing workflow run data must survive. Do not remove CI workflows or unrelated uses of the word workflow.
3. Child briefing carries child/parent identity and result/escalation reporting only. No automatic self-removal mandate. Cleanup is an explicit user/orchestrator action documented in the skill; no new lifecycle flag needed. Preserve task delivery and briefing suppression.
4. The ftown skill and its focused session reference are authoritative. Generated harness-agent.md becomes a short pointer. Orchestrator reference links to the common reference and contains only unique coordination guidance. Preserve an obvious command-discovery path.
5. User/agent command examples use `ftown sessions`, `ftown harness`, and `ftown env`. Existing session/harness/env launchers remain compatible. Internal hook invocations can retain exact stable wrapper paths; do not expand this into a transport/API redesign.

Acceptance: no automatic fticket install or workflow feature in packaged output; upgrade cleanup preserves custom skills and workflow data; short briefing retains identity/reporting and task; canonical commands work through real installed dispatchers in a temporary HOME; old nonworkflow launchers still work; docs have one authoritative route; required build/unit checks and root-run focused E2E pass; independent review; PR, no merge.

## Ownership and resources

Architect/root owns this file, scope decisions, all E2E execution and task server/process setup/cleanup.
Implementation/integration worker `/root/simplify_all`: explicit `gpt-6.1-sol`, `high`; setup and Git lease; implementation file manifest pending discovery and review. Sole implementation writer. May write `worker.md` and proposed smoke scripts after scope freeze.
Reviewer `/root/review_all`: explicit `gpt-6.1-sol`, `high`, same checkout, read-only code and uniquely owned `review.md` only.
Original checkout `/Users/fkesheh/projects/ftown` is read-only for this task.
No E2E server, browser, database, or CI execution by workers. No live HOME installation by any worker. Dependency install/build output and Git operations serialized to implementation worker. Root E2E begins after worker releases resources.

## Gates

Discovery → exact ownership manifest and independent contract review → implementation/unit/build → independent review/fixes → root focused E2E → landing PR. Reuse valid evidence. No extra user approval needed within this scope.

Pre-freeze review accepted: preserve customized/foreign assets and symlink roots/parents; exact known shipped-tree recognition required for legacy directory removal (otherwise skip). Preserve `~/.ftown/workflows` data and shared runtime modules. Ensure deleted workflow JS cannot survive incremental build/package. Validate actual installed dispatcher argv/exit propagation, old launcher compatibility, and `ftown --help` discovery. Reviewer completed contract review before implementation.

## Frozen implementation wave

The exact Modify/Delete/Add manifest in `worker.md` (discovery handoff) is approved. Mechanically checked unique paths, overlapping parent/child paths, and root/reviewer exclusions before writes; one application writer covers all changes. Worker owns generated `bridge/node_modules/` and `bridge/dist/` resources and Git lease; no E2E lease. Source Claude-trust helper may be removed only if workflow-exclusive; installed shared modules remain untouched. Package build may clean generated dist before compilation. No other source files without architect approval. Reviewer owns only `review.md`; root owns this file and runtime evidence it appends.

## Validation and landing gate

Root owns `bridge-tests.log` and `package-check.json` execution evidence in this directory. Worker released build/dependency resources before root validation. Initial installed CLI smoke exposed a real symlink entry guard failure; same worker fixed the already-owned dispatcher and env CLI, with 32 passing regression checks. Reviewer accepted repair; original failing noncanonical path retained in smoke.

- Clean build passed; worker pure checks passed (205 before guard repair, 32 guard-related checks after).
- Root installed-command smoke passed: real copied launchers, temporary HOME, sanitized child env, ephemeral loopback fixture API, six requests. Verified upgrade cleanup, custom skill/run-data preservation, canonical and old commands, argv/exit propagation, retired workflow rejection. No real bridge/native agent used for smoke. Fixture closed and temporary HOME deletion independently checked.
- Root full bridge suite passed in disposable HOME/USERPROFILE/FTOWN_DATA_DIR with no deployment/database environment inherited: 772 passed, 4 skipped, 0 failed (776 tests, 183 suites). Skips: three Windows PTY tests and optional real-relay test.
- Root package dry-run passed: 0.19.40, 243 packaged files, no retired workflow/fticket assets or workflow bin.
- Required harness status passed read-only against existing user bridge pid 89716; never restarted or modified it.
- Independent reviewer accepted complete diff and symlink guard repair. No outstanding findings.

Landing authorized: implementation worker is sole Git/commit/push/PR owner. Include concise coordination/review/worker evidence and reproducible smoke; omit raw full-suite log if bulky. Preserve original checkout. Open PR against main; do not merge. No need to repeat valid checks absent a relevant code change.
