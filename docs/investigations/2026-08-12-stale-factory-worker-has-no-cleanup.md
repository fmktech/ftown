---
type: investigation
symptom: "A factory worker remains shown as running after completing its ticket, and its nested row has no cleanup action"
slug: stale-factory-worker-has-no-cleanup
date: 2026-08-12T05:30:51-03:00
investigator: Foad Kesheh
git_commit: ef71fdf9bf0485c27326780f993e99f31e5d4303
branch: fix/factory-stale-worker-cleanup
repository: fmktech/ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related: []
---

# Stale factory worker has no cleanup control

## Symptom

- **Observed**: "I have this stale worker there, what caused it and I dont have any means to clean it up." The screenshot shows `aurea-retail-t6-rca` with a green status dot and age `18h ago`; its terminal shows a successful `fts complete` command.
- **Expected**: A completed factory worker should normally self-close or be reaped; if either automatic path misses, the nested worker row must let the user stop and archive it.
- **Delta**: FTS ticket completion succeeded while the ftown session remained `running`, and `FactoryList` exposes only row selection for workers.

## Reproduction

1. Supply `FactoryList` a factory and a matching session named `<project>-t<ticket>-<stage>`.
2. Render the expanded worker section.
3. Inspect the worker row controls.

Verified 2026-08-12: `WorkerRow` is one selection button and accepts only `session`, `selected`, and `onOpenSession` (`ui/src/components/factory/FactoryList.tsx:46-113`). `FactoryListProps` has no removal callback (`ui/src/components/factory/types.ts:318-339`), and Dashboard does not pass its existing `handleRemoveSession` to `FactoryList` (`ui/src/components/Dashboard.tsx:1133-1146`). There is therefore no worker-row cleanup path.

## Hypotheses

#### H1: The green worker is only a factory-view status rendering artifact

- **Layer**: observation
- **Prediction**: If H1 is true, the factory row would synthesize a green state independently of the session and the selected session would not expose the global Stop action.
- **Verification method**: Read the worker status rendering and Dashboard selection controls; compare with the screenshot.
- **Evidence**:
  ```text
  <StatusDot kind={session.status} />
  {selectedSession?.status === "running" && (
    <button className="btn-danger" onClick={handleStopSession}>Stop</button>
  )}
  ```
- **Verdict**: REJECTED
- **Rationale**: The factory row renders the bridge session's actual status, and the screenshot also shows the global Stop button. Two independent UI surfaces agree that the session is running.

#### H2: `fts complete` is intended to terminate the ftown terminal, so the bridge failed to process a built-in close

- **Layer**: dependency / integration
- **Prediction**: If H2 is true, there would be no separate self-close instruction or dispatcher reaper; ticket completion itself would own the session lifecycle.
- **Verification method**: Read the factory protocol and dispatcher lifecycle code.
- **Evidence**:
  ```text
  fts complete ...
  ~/.ftown/ftown-sessions remove "$FTOWN_SESSION_ID"   # self-close; your session ends here

  REAP_EVENTS = (... EventType.TICKET_COMPLETED, ...)
  ```
- **Verdict**: REJECTED
- **Rationale**: Ticket state and terminal state are intentionally separate. The protocol requires a second removal command and the dispatcher keeps a worker-to-session map as a backstop.

#### H3: Factory worker rows cannot invoke the already-existing remove-session capability

- **Layer**: code logic / UI contract
- **Prediction**: If H3 is true, normal session rows will receive `onRemoveSession`, while `FactoryList` and `WorkerRow` will have no equivalent callback or control.
- **Verification method**: Trace `handleRemoveSession` from Dashboard into both sidebar branches.
- **Evidence**:
  ```text
  <FactoryList ... onOpenSession={handleOpenFactorySession} ... />
  <SessionList ... onRemoveSession={handleRemoveSession} ... />

  function WorkerRow({ session, selected, onOpenSession })
  ```
- **Verdict**: PROVEN
- **Rationale**: The remove operation exists and is wired to regular sessions, but the factory branch drops it before the nested worker row.

## 5 Whys

Symptom: The stale factory worker cannot be cleaned up from its row.

1. **Why?** The row has no cleanup control.
2. **Why?** `FactoryListProps` carries only worker selection, not removal.
3. **Why?** Factory workers were moved out of `SessionList` into a specialized nested list without carrying over session lifecycle actions.
4. **Why?** The factory view assumed worker self-close plus dispatcher reaping would always succeed.
5. **Why?** Automatic cleanup was treated as a guarantee even though it crosses an LLM-compliance boundary and a separate dispatcher/event mapping boundary.

## Falsification

- **Check performed**: Adjacent-cause search. Checked whether the global Stop button already removes the record, and whether completed workers fall back into `SessionList` where removal is available.
- **Result**: `handleStopSession` calls `stopSession`, not `removeSession`; `factoryWorkerOf` matches by bridge and name regardless of status, and Dashboard filters all matching workers out of `SessionList`.
- **Conclusion**: H3 survives. No existing path archives the nested worker from the factory sidebar.

## Root Cause

- **Immediate cause**: The specialized factory-worker UI omitted the existing session removal callback and control.
- **Architectural root**: Factory nesting replaced the general session lifecycle surface while relying exclusively on two fallible automatic cleanup mechanisms.
- **Rejected H1**: Both `StatusDot` and the selected-session Stop control consume the real session status.
- **Rejected H2**: FTS and ftown lifecycles are explicitly separate in the worker protocol and dispatcher.
- **Automatic-cleanup open question**: The screenshot proves the worker did not self-remove and was not reaped, but distinguishing worker non-compliance from a missing/lost `.ffactory/workers.json` mapping requires the remote Aurea factory's dispatcher stderr and runtime files.

## Fix

- Add `onRemoveSession` to `FactoryListProps` and pass Dashboard's existing bridge-aware handler.
- Add an accessible worker cleanup button that stops and tombstone-archives the session; it must not trigger row selection.
- Regression test: render the public `FactoryList` seam and assert the nested worker exposes `Stop and archive <name>`.

## Resolution

- **Diff summary**: `FactoryListProps` now carries the existing removal operation; every nested worker renders separate open and cleanup buttons; Dashboard routes cleanup through its bridge-aware `handleRemoveSession`.
- **Regression test**: `ui/src/components/factory/FactoryList.test.ts` failed before the fix because no accessible cleanup control was rendered, then passed after the callback/control was added.
- **Verification**: all 140 UI tests pass; the Next.js production build passes.
- **Follow-up**: inspect the Aurea factory's `.ffactory/workers.json` and dispatcher run stderr if the exact missed automatic-cleanup path needs attribution. The UI no longer depends on that attribution for recovery.
