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


## Follow-up: CI40532133664 at f5b137e5
The independently proven generation defect was repaired, but the exact local prompt assertion still fails. That repair must not be represented as the explanation for early screen loss.

Second trace evidence (0-trace.trace in /tmp/ftown-navigation-second/test-results/e2ee-security-an-approved--e8a0b-P-control-and-event-polling-chromium/trace.zip):
-489312 Stop click; Rerun observed by489460.
-489463 Rerun click; running/Stop observed by489562.
-Frame489540 contains literal `[lost tty]`; frame489607 is blank; by489694 the cursor is at column15 with blank cells.
-489580 same session row click;489655 prompt assertion starts, fails519657.
-The same xterm-dom-renderer-owner-1 survives throughout. There is no observed remount, nor a demonstrated fresh shell prompt in this second run.
-bridge.log137–152 records create/attach22029, Stop/old exit, retry/new attach22179, and no replacement exit until test cleanup.

Artifact inventory:150 files, comprising bridge/UI logs, browser traces/videos/screenshots and report assets. No session terminal.log or rendered bridge screen was uploaded. Trace event metadata contains no WebSocket payload events; encrypted HTTP response bodies do not expose terminal bytes. These artifacts cannot determine whether the blanking is native PTY output, headless serialization, a transport delivery issue, or browser parsing.

## Separate phone failure: readiness race proven
The two-isolated-browser failure belongs to the phone context, not the default page screenshot. In its 1-trace.trace, call4586 checks hamburger isVisible at306443 and immediately receives false. The snapshot still shows `Opening this browser's encryption identity…`. call4588 then waits for Open security. By306469 Dashboard has mounted with a collapsed hamburger, which the helper never opens. Phone screenshot test-failed-2.png confirms the collapsed menu; test-failed-1.png belongs to the unrelated desktop page.

This proves a helper readiness race: a one-shot visibility decision occurred before Dashboard mounted. Root assigned the bounded helper repair separately; no application behavior or approval assertion needs weakening.

## Geometry hypothesis and falsification
Source observation: relaunchFtownSession calls runner.run without cols/rows, so the replacement attaches at120x40. The mounted browser in the failed trace is80x37. Terminal's subscription effect does not depend on isRunning, so the same-ID status change alone does not force a new subscribe/resize. This is a concrete geometry difference, but was a hypothesis, not a proved cause of blanking.

Root executed the isolated native diagnostic after its pane-target/prompt fixes. Evidence: /tmp/ftown-rerun-native-UGuf3v/{summary.json,timeline.json,*raw.log,*json}. Platform darwin, tmux3.6a. A unique task-owned -L socket and fresh HOME/ZDOTDIR/TMUX_TMPDIR were used; only fixed test marker commands ran. Cleanup confirms no sessions remain on that socket.

Observed results:
-Initial sized80x37: prompt visible in native pane, browser-sized headless emulator, bridge headless emulator and serialized-screen replay.
-Same-ID replacement120x40 without resize: prompt visible in all four views.
-Corrective79→80x37 resize: prompt remains visible in all views.
-Separate immediate-correct-resize scenario: all prompt checks pass.

Verdict: geometry difference ALONE is REJECTED in this isolated macOS/tmux setup. It neither proves Ubuntu's complete transport path healthy nor licenses a speculative resize fix. The driver bypasses encryption, transport and DOM; the real CI raw bytes remain necessary.

## Proposed bounded CI diagnostic; no source changes in this report
Exact proposed writer scope: e2e/tests/e2ee-security.spec.ts only. Root remains sole E2E/CI executor. Reuse the existing test's Page/TestInfo, BRIDGE_HOME/E2E_DIR constants, owned sessionId and before-session set.

1. Immediately before Stop, record the owned terminal.log file byte size and browser terminal geometry. No terminal input or repaint is added.
2. Wrap only the final runMarkerInTerminal assertion after Rerun in catch. Before the existing outer finally deletes the session, await best-effort diagnostic collection, then rethrow the original assertion. Do not move deletion earlier, run collection in an unawaited callback, replace the assertion, type Enter to repair the terminal, or broaden retries/timeouts.
3. Confine disk access to this newly created UUID (not in the preexisting before set). Require canonical BRIDGE_HOME to equal E2E_DIR/.bridge-home, matching start-services.sh15/86/88; reject symlink/path escapes. Read only .ftown/data/sessions/<owned-id>/terminal.log through a bounded file descriptor read, at most128KiB. Record original byte length, selected offset, truncation, pre-Stop byte boundary and exact captured bytes as base64 inside JSON. That preserves control bytes for replay without interpreting active ANSI; it is encoding, not a claim of cryptographic redaction. The shell is the test-owned marker fixture.
4. Capture GET /api/sessions/<owned-id>/screen?offset=0&limit=120 using the same built cli-client.apiResponse dynamic-import pattern as bridge-api.ts. Pass the fresh pointer only in memory and AbortSignal.timeout(5000) to apiResponse's existing signal parameter. The shared bridgeApiFetch helper currently lacks a signal option; no helper change is needed for this failure-only collector. This uses the existing encrypted authenticated local application path, without raw HTTP/bearer bypasses.
5. Attach only allowlisted screen status/totalLines/offset/limit and capped lines, plus current xterm rows text/cursor element position/screen bounds/viewport and selected-session action text. Keep the aggregate attachment bounded. Record collector failure as a short diagnostic outcome; never attach response/request headers, pointer contents, session.json/env, process.env, cookies, browser identity/key stores, packet arrays, invitations or account material.
6. Await collectors and attachments within catch before cleanup, close the file descriptor in finally, and preserve the original test failure even when diagnostic collection fails. The test owns this session until its existing finally DELETE; other fixture sessions remain untouched.

Falsifiable next interpretations: raw log containing a correct prompt while bridge screen lacks it implicates bridge parsing/state; bridge screen correct while browser DOM blank narrows to screen/output delivery or browser parsing; raw log itself lacks a prompt or contains a subsequent erase narrows to native shell/tmux output. Raw-tail truncation or a changed platform must be reported rather than treated as a complete replay. No exact cause is yet proved.

## Follow-up handoff
Phone trace diagnosis and native geometry falsification are complete. Only this report and the isolated /tmp driver were authored by this worker; no application/test edits or runtime/CI/Git execution. Proposed diagnostic implementation must receive its own exact file lease. STOP; report and authoring leases released.


## CI40538246849: loss exists in the bridge screen
Only the failure-specific non-content attachment was extracted from the target test trace: test.attach@133 references resources/cc9d932e5a5d767c942ff0bc21faa4d9a6129cba. Local copy: /tmp/ftown-rerun-diagnosis/third-local-rerun-diagnostics.json. No other embedded content or credentials were extracted.

Observed diagnostic:
-Complete6761-byte terminal.log, not truncated or shrunk; pre-Stop boundary5144, so1617 bytes follow it.
-After boundary:2 full clears,7 cursor homes,1 alternate-screen enter,1 alternate-screen exit,1 lost-tty notice, no original known marker.
-Authenticated bridge screen HTTP200:37 lines,0 nonblank, no prompt character or marker.
-Browser:37 rows,0 nonblank rows,16 spaces, viewport900x760, terminal bounds640x666.

Conclusion: the empty state already exists in the authoritative bridge headless emulator. Browser-only navigation/layout or transport loss cannot by itself explain these two matching empty views. The pump writes each PTY chunk to TerminalManager before buffering/appending the same bytes to terminal.log (terminal-pump.ts79–104). Stop/retry do not explicitly replay/reset/destroy this headless terminal; retry rewires terminal input while the persistent emulator receives the new tmux client's ANSI stream. The replacement process remains attached in the earlier trace/log evidence. This narrows investigation to native shell/tmux output and persistent-emulator control/state, without proving either one.

Critical measurement limitation: summarize.hasPromptCharacter applies /[$%#>]/ to RAW terminal bytes. Capability queries such as ESC[>c contain `>` and return true even with no visible prompt. Therefore the attachment does not prove that a printable shell prompt was emitted after Stop. Control counts omit order and positions, so they also cannot prove an erase occurred after a prompt. No speculative terminal reset/resize repair is justified by these counters.

### Smallest decisive additional diagnostic
Keep the existing single-test failure collector and ownership/path guards; no application edit. Before its current finally DELETE, await two non-content additions:

1. Use node:util stripVTControlCharacters on afterPreStop bytes before counting printable non-whitespace and prompt characters. Add ordered offsets/types for the known full-clear/home/alternate enter/exit controls only (maximum128 records), plus printable-run lengths if needed; never include printable values or OSC/DCS payloads. This corrects the false-positive prompt measurement without exposing contents.
2. Read the exact test-owned native tmux pane, then retain only dimensions/cursor/dead/nonblank/prompt/marker booleans. With the already-validated new UUID and isolated current bridge pointer, run read-only `tmux -L ftown list-panes -t ftown-<owned-uuid>: -F` with format session_name,pane_id,pane_width,pane_height,cursor_x,cursor_y,pane_dead. Require exactly one result, exact session_name equality to ftown-<owned-uuid>, and a validated %<digits> pane ID; otherwise record unavailable. Then `tmux -L ftown capture-pane -p -t %<validated-id>` with2second timeout and64KiB maxBuffer. Summarize entirely in memory; attach no pane text, arbitrary process args, environment, pointer, or command stderr. No attach/resize/send-keys/kill commands, no default socket, no global session query. Use the current E2E environment only to resolve the same ftown socket, without serializing it.

The pane target must be resolved as a pane ID: the earlier isolated driver proved that supplying a bare exact-session target to capture-pane failed. Preserve all existing ownership/symlink guards and the original assertion; collectors complete before the existing session deletion.

Decisive interpretations: native pane nonblank/prompt true while bridge blank means the live shell has text and the bridge PTY/headless route loses it; native pane empty plus stripped after-Stop output lacking text means the bridge mirrors the native shell/tmux state, directing work to startup/terminal negotiation. Native prompt plus stripped output lacking prompt distinguishes tmux attach output from the underlying pane. Native and raw both contain printable prompt but headless remains blank directs a deterministic ANSI/state replay. The next change should follow one of these observations, not a guessed reset.

STOP: third-CI bounded diagnosis complete; report lease released. No source/test edits, runtime, E2E, browser, server, database, CI or Git operations by this worker.


## CI40541613241: fourth non-content diagnostic
Extracted only the named local-rerun-diagnostics.json attachment into /tmp/ftown-rerun-diagnosis/fourth-local-rerun-diagnostics.json. The complete6676-byte log has pre-Stop boundary5057; no truncation/shrink. Both authenticated bridge screen and browser remain37 blank rows. The VT-stripped after-Stop slice contains493 characters and a prompt-pattern character; this count includes whitespace and is not an ordered proof of a visible prompt.

Recorded control order relative to pre-Stop: old home20/clear23, alternate exit103, lost tty120, new alternate enter132/home156/clear159, then homes535/823/957/1065/1384. There is no later recorded full-clear, but unrecorded erase-line/overwrite controls can still erase content. Native pane comparison is unavailable, so it cannot establish whether native shell text exists.

The collector catches list-panes failure, strict seven-field parse failure, revalidation failure and capture-pane failure into the same unavailable flag. Its exact-session plus trailing-colon target syntax is supported by the installed tmux manual; no target bug is proved. A possible parsing hazard is trimEnd removing a trailing empty pane_dead field; explicit format #{?pane_dead,1,0} would remove that ambiguity, but actual failing stage is unknown. Future instrumentation should record only stage/code, not arbitrary stderr/content.

A synthetic prompt-then-erase TerminalManager replay would not prove the missing CI byte order. If diagnosis resumes, a bounded in-memory replay of this test-owned full log and post-Stop slice at80x37 versus120x40, retaining only nonblank/prompt/cursor/buffer counts, could discriminate actual stream geometry from live manager state without attaching text. Native comparison remains useful after stage reporting. No source fix is justified yet.

Root stopped this investigation to prioritize the user's back/refresh work. PR remains draft with the known local-rerun failure. No further diagnostic execution authorized by this handoff. STOP; report and temporary authoring leases released. No application/test edits or runtime/CI/Git execution by this worker.


## CI40545214003: fifth diagnostic unchanged in material respects
Read the root coordination section `CI40545214003 pairing test locator repair`; the independent pairing error-selector collision has its own one-file repair and does not explain terminal blanking. Extracted only local-rerun-diagnostics.json into /tmp/ftown-rerun-diagnosis/fifth-local-rerun-diagnostics.json.

Complete6697-byte log, pre-Stop5080, after-Stop1617 bytes. VT-stripped post-Stop length491/prompt-pattern true. Ordered controls are identical to the fourth run through offset823; remaining homes differ by only2 bytes (955/1063/1382 versus957/1065/1384). Both authenticated bridge screen and browser remain37 blank rows with no marker/prompt. Native pane remains unavailable, with no error-stage information.

The repeat supports the same stable PTY/headless sequence; it does not establish native pane contents or justify a guessed application fix. The unchanged collector cannot distinguish the remaining hypotheses. If investigation resumes, use the bounded replay/native-stage discriminators already documented; another broad run with identical instrumentation adds little evidence. PR remains draft with the known local-rerun failure.

STOP; report/temp authoring leases released. No application/test changes or runtime/browser/E2E/server/database/CI/Git execution by this worker.
