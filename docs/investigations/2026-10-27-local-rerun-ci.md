---
type: investigation
symptom: "Local rerun CI loses terminal prompt; isolated old-process callbacks delete replacement ownership"
slug: local-rerun-ci
date: 2026-10-27T14:05:56Z
git_commit: 87549bc5d717efbd023e6dbdf8d0c5abec98a63a
branch: codex/navigation-consolidation
repository: fmktech/ftown
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

# Local rerun CI and process-generation ownership

## Scope and distinction
This report proves a separately reproducible ProcessRunner ownership defect exposed while investigating the CI failure. It does **not** prove the exact early prompt erasure in CI is caused solely by that defect. The CI symptom remains unresolved pending another focused runtime observation.

The worker owns only this report and inert /tmp scripts. No application/test source, live bridge, browser/E2E, database, user data, Git or CI was modified/executed.

## Observed CI symptom
CI40515139967, e2ee-security.spec.ts:213: after Stop, authoritative Rerun, then Stop becomes visible again, runMarkerInTerminal waits30seconds for /[$%#>]/ but .xterm-rows stays blank. The test retains one same session ID. The fixture had already rendered/typed through the local encrypted path successfully before the Security layout checks.

Trace times (milliseconds in trace):
-93204 Stop click; completed/Rerun observed by93340.
-93343 Rerun click; running/Stop observed by93473.
-93492 click the same session row;93534 prompt assertion begins.
-Frame~93500 shows shell prompt briefly.
-Frame~94000 and~100000 show blank terminal with cursor.
-123537 prompt assertion fails.

Evidence: /tmp/ftown-navigation-failed/test-results/e2ee-security-an-approved--e8a0b-P-control-and-event-polling-chromium/trace.zip, error-context.md; extracted unchanged trace frames /tmp/ftown-rerun-diagnosis/frame-{93100,93500,94000,100000}.jpeg. Trace contains no decrypted terminal frames to establish whether blanking was a raw repaint or onScreen snapshot.

Bridge log excerpt118–133:
```
[Bridge] Received command: stop_session (requestId: 9510d163-a37a-4484-8b5f-1dc912056d02)
[ProcessRunner] tmux attach client exited, code: 1, signal: 0
[Bridge] Received command: retry_session (requestId: b9836bd3-a97d-4c20-9f1b-10214de48798)
[ProcessRunner] Spawning command in /home/runner/work/ftown/ftown/e2e/.bridge-home (tmux): /bin/zsh -l
[ProcessRunner] Attached to tmux session ftown-fb3f9d58-cc28-471e-a126-d4dc60d734f9, client pid: 13619
```

The shell did spawn; this is not evidence of a missing process. Same-session Dashboard row selection only sets the same selectedSessionId/mobile tab. Terminal has no changing key, xterm initialization deps[], subscription deps[transport,sessionId,bridgeId,subscribe], and useTerminal.subscribe deps have no status/headerActions (Terminal.tsx:375–414; useTerminal.ts:46–60). No source path establishes that the new header itself resets xterm on status changes. Do not weaken the prompt assertion or assume flakiness.

## Independently reproducible ownership symptom
Expected: a replacement process for an existing session remains the active receiver; callbacks belonging to an earlier stopped process cannot delete the replacement mapping or its metadata.
Observed: actual ProcessRunner removes the replacement activeProcesses map entry when either an older stop timer or older onExit callback runs.

## Deterministic reproduction
Safe unit-only scripts import the actual ProcessRunner class and provide inert fake PTYs; getPreferredRuntime is overridden to direct. No process is spawned. global setTimeout is captured so the5second callback is deterministic.

Run from bridge/:
```
rtk proxy node --import tsx /tmp/ftown-rerun-diagnosis/stale-stop-timer.ts
rtk proxy node --import tsx /tmp/ftown-rerun-diagnosis/stale-exit.ts
```

Timer schedule: run old → stop old → fire old exit → run replacement same ID → verify replacement write succeeds → fire old stop timer → replacement write fails. Output:
```
{"beforeReplacementWritable":true,"afterOldTimerWritable":false,"oldKills":["default","SIGKILL"],"replacementKilled":[],"actualReplacementWrites":["first"]}
```

Late-exit schedule: run old → stop old → run replacement same ID → verify registered → fire old exit. Output:
```
{"replacementRegisteredBeforeOldExit":true,"replacementRegisteredAfterOldExit":false,"completes":[]}
PASS: current-generation exit still removes its own registration and emits completion
```

The final control creates a separate current process, invokes its own exit and confirms its own mapping is removed and complete emitted. Baseline commands exit0 because they assert the observed defect, not desired behavior.

## Hypotheses for the isolated ownership defect

### H1: Replacement disappears because its native spawn fails.
- Layer: dependency/integration.
- Prediction: with successful inert spawn and no native subprocess failures, replacement remains registered.
- Verification: actual class with two successful injected fake PTY returns.
- Evidence: replacement registered and write returns true before firing the old timer; after only old timer it returns false.
- Verdict: REJECTED.
- Rationale: no spawn failure is needed; replacement was successfully registered.

### H2: The UI reselects a different or missing session ID and causes the ownership loss.
- Layer: observation/UI.
- Prediction: with no UI and a fixed exact same ID throughout, replacement remains registered.
- Verification: direct actual-class harness with only same-id inputs, no React/browser/transport.
- Evidence: both isolated scripts reproduce deletion with no UI and one exact ID.
- Verdict: REJECTED.
- Rationale: the runner defect is independent of UI selection. This does not determine the exact early CI repaint.

### H3: Old lifecycle callbacks mutate session-keyed state without checking which process currently owns it.
- Layer: code logic / state concurrency.
- Prediction: replacement is writable before an old callback; firing old callback alone deletes ownership. Current process exit should still perform normal cleanup.
- Verification: two deterministic actual-class scripts, controlled timers/exit callbacks and current-generation absence control.
- Evidence: claude-runner.ts:181–184 checks only activeProcesses.has(sessionId) then unconditionally deletes; direct onExit:390–395 and tmux onExit:314–327 delete maps by ID before checking stop state. Both scripts demonstrate lost replacement; current exit control cleans itself and emits completion.
- Verdict: PROVEN.
- Rationale: a stale callback is the sole changed input between active/writable and inactive/unwritable states.

## 5 Whys for proven defect
1. Replacement input/resize ownership can disappear because an earlier process callback deletes the session map entry.
2. The callback deletes by session ID, even though the map now refers to a different PTY.
3. A stopped session can be rerun using the same persisted ID before every asynchronous callback/timer from the previous launch has finished.
4. ProcessRunner stores lifecycle intent and cleanup at session granularity rather than binding it to a concrete launch/process generation.
5. Session identity was treated as equivalent to process lifetime, while the public Rerun contract intentionally preserves session identity across different process lifetimes.

## Falsification
Absence control: before the old callback fires, the replacement is registered and its input writes reach the replacement fake. Firing only the stale callback removes it. Current-process control confirms the normal exit path must still clean its own mapping and emit completion. Isolating all OS, browser, transport and persistent storage dependencies did not remove the defect.

This does not establish why the CI prompt erases~0.3seconds after rerun: the old stop timer fires at5seconds. It can independently break input/resize by5seconds but cannot alone be asserted as the cause of that earlier erase. A stale screen/raw repaint or other overlap remains possible.

## Proposed narrow repair contract
Root must explicitly assign source/test ownership before changes. Suggested exact source/test scope:
-bridge/src/claude-runner.ts
-bridge/src/claude-runner.test.ts

Bind old stop timers and exit cleanup to the actual process/launch generation; stale callbacks must not delete current activeProcesses/runtimes/lastSizes or consume stopping/detach intent belonging to a newer launch. Preserve legitimate current exit completion/error, stop/remove suppression, tmux detach/reattach, and cancellation during async tmux creation. A bare early return must not strand or transfer a session-keyed stopping flag to the new generation. Include direct and tmux fake-process cases if implementation touches both shared paths.

Regression tests should fail baseline and pass repaired code:
-Old5sec timer after old exit + new same-ID launch leaves new process writable and does not kill it.
-Old exit after new same-ID registration leaves new mapping/runtime/size intact and emits no false terminal event for replacement.
-Current exit still cleans current registration and emits proper completion/error.
-Current stop still suppresses lifecycle event and handles its own forced termination.
-Existing async tmux creation cancellation/readiness tests continue to pass.

No broad retry/authority/crypto protocol changes and no E2E test weakening. Root must rerun actual local flow after any accepted repair; early blanking is not declared fixed until that evidence passes.

## Handoff
Diagnostic source and reproduction scripts are complete. No application/test edits. Parent may assign the narrow implementation and independent review; this worker releases report and /tmp authoring leases after handoff.
