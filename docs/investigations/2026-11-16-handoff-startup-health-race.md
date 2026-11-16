---
type: investigation
symptom: "Handoff reports a created replacement as unhealthy and leaves the old session unarchived."
slug: handoff-startup-health-race
date: 2026-11-16T14:40:00-03:00
investigator: session-handoff agent
git_commit: f7c9bbebbaf30adc5399f76f3d851f493b8f1f42
branch: feat/session-handoff
repository: ftown
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

# Handoff startup health check races the replacement launch

## Symptom

- **Observed**: On head `f7c9bbe`, both desktop and mobile handoff E2E cases fail waiting for the replacement workspace. The saved browser context says: `Handoff created 1fe535e7-f9ff-43cd-a171-7b858a472db2 but could not finish moving 98f110a1-967e-45e5-95a7-36ecb84615ea: replacement session 1fe535e7-f9ff-43cd-a171-7b858a472db2 is not healthy`.
- **Expected**: After handoff, the replacement is confirmed running, selected in the workspace, and only then the old session is archived.
- **Delta**: The replacement record and tmux session are created, but the health gate rejects it before selection and archive.

## Reproduction

1. On `f7c9bbebbaf30adc5399f76f3d851f493b8f1f42`, dispatch the repository E2E workflow for `feat/session-handoff`:
   ```sh
   gh workflow run e2e.yml --ref feat/session-handoff
   ```
2. Inspect run `43886003231`, shard 3/3. Both `tests/session-handoff.spec.ts` cases fail at line 96 after 60 seconds waiting for the replacement workspace.
3. Inspect the shard artifact's `error-context.md` and `bridge.log`. The alert reports the immediate `isSessionHealthy` rejection; the bridge log contains both the replacement spawn and tmux attachment.

Verified 2026-11-16: the exact head fails in shard 3/3; shards 1/3 and 2/3 pass.

## Hypotheses

#### H1: The health check samples the replacement before the asynchronous tmux attach registers its PTY.

- **Layer**: state-data
- **Prediction**: A handoff can create the replacement and start tmux, yet the immediate `runner.isRunning` check can be false; the error context will report the health rejection and the bridge log will show the replacement spawn.
- **Verification method**: Inspect the shard's browser error context and bridge log; inspect `ProcessRunner.run` and the handoff health callback.
- **Evidence**:
  ```
  Error context: Handoff created 1fe535e7-f9ff-43cd-a171-7b858a472db2 but could not finish moving 98f110a1-967e-45e5-95a7-36ecb84615ea: replacement session 1fe535e7-f9ff-43cd-a171-7b858a472db2 is not healthy
  Bridge log: [ProcessRunner] Attached to tmux session ftown-1fe535e7-f9ff-43cd-a171-7b858a472db2, client pid: 6089
  Bridge log: [ProcessRunner] Spawning command in the handoff worktree (tmux): '/bin/bash' -l
  bridge/src/claude-runner.ts:107 calls `void this.runTmux(...)` and returns before the async create-and-attach operation completes.
  bridge/src/index.ts:1069 checks `runner.isRunning(id)` immediately after `createSession`; `isRunning` reflects the attached PTY map.
  ```
- **Verdict**: PROVEN
- **Rationale**: The browser error names the new health gate, the bridge proves the replacement launch progressed, and the runner's tmux launch is asynchronous. The check can observe the pre-attach state.

#### H2: The E2E locator uses the wrong accessible name for the replacement workspace.

- **Layer**: observation
- **Prediction**: The replacement should be created and selected, with no application error; only the queried accessible label would differ.
- **Verification method**: Read the saved Playwright error context and sidebar tree.
- **Evidence**:
  ```
  The error context contains an alert saying the handoff failed because the replacement is not healthy.
  It also lists the created replacement in the sidebar, while the selected main region remains the parent workspace.
  ```
- **Verdict**: REJECTED
- **Rationale**: The E2E waits on the right name; the UI never selects the replacement because the handoff command returns the explicit health error.

#### H3: Stopping the old session fails, preventing the replacement launch.

- **Layer**: integration
- **Prediction**: The bridge log should stop before replacement creation or report the old tmux session could not be stopped.
- **Verification method**: Inspect `bridge.log` around the handoff command and the browser alert.
- **Evidence**:
  ```
  Bridge log: [Bridge] Received command: handoff_session
  Bridge log: [ProcessRunner] Spawning command ... '/bin/bash' -l
  Browser alert: Handoff created <replacement-id> but could not finish moving <old-id>: replacement session <replacement-id> is not healthy
  ```
- **Verdict**: REJECTED
- **Rationale**: The old-session stop passed far enough to create the replacement; the reported failure is the later health check.

## 5 Whys

Symptom: Handoff reports the replacement unhealthy and leaves the old session unarchived.

Why 1? The handoff health callback checks `runner.isRunning` immediately after `createSession` returns.
Why 2? `createSession` invokes `runner.run`, which schedules tmux session creation/attach asynchronously and returns before the PTY is attached.
Why 3? The health contract was implemented as an instantaneous snapshot rather than a readiness wait.
Why 4? The handoff path assumed session-record creation and process readiness were synchronous boundaries.
Why 5? The session factory does not expose an awaitable readiness signal, so callers must explicitly wait for the runner's live state.

## Falsification

- **Check performed**: Adjacent-cause and prior-head comparison.
- **Result**: The failed browser context includes an explicit alert from the new health check, and bridge logs show replacement tmux creation. The same E2E suite passed on prior PR head `37ceb2e`, before the health gate was added.
- **Conclusion**: The asynchronous-readiness hypothesis survives; a locator-only issue or old-session stop failure does not explain the observed alert.

## Root Cause

- **Immediate cause**: `runner.isRunning` is false during the asynchronous tmux create/attach window, but handoff treats that transient state as a terminal unhealthy result (`bridge/src/claude-runner.ts:107`, `bridge/src/index.ts:1069`, `bridge/src/session-handoff.ts:379`).
- **Architectural root**: Session creation exposes persistence and launch initiation but not readiness; the handoff caller must wait for the live runner state before archiving the old writer.
- **Rejected hypotheses**: H2 is contradicted by the explicit handoff error in the browser context; H3 is contradicted by replacement-spawn log lines and the later-stage error.
- **Falsification**: The prior head passed the E2E suite, while this head's failed case reports the health check itself and logs replacement creation. This supports the new snapshot check as the cause.

## Fix

- Wait for persisted `running` status and an attached process before declaring the replacement healthy; fail only if the session reaches a terminal/blocked state or the bounded startup deadline expires.
- Add regression coverage for a delayed healthy state so transient startup cannot prematurely abort handoff.

## Resolution

The readiness callback now polls until the replacement has an attached process, returns early if the stored session becomes terminal, and times out after 30 seconds. Regression tests cover delayed attach and terminal-state exit. Bridge build and 117 focused bridge tests pass; the exact-head GitHub E2E validation is pending.
