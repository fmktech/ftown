---
type: investigation
symptom: "index-readiness tests fail after F2 fix: extra '[Bridge] Startup readiness failed:' log and 'Readiness did not complete' timeouts"
slug: index-readiness-startup-failures
date: 2026-11-14T23:01:17-03:00
investigator: Foad Kesheh
git_commit: e76f03b3b7974ea6b3748c3a07de5c02f17f97ed
branch: fix/escalate-on-resurrection-dead-parent
repository: fmktech/ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related: []
---

# index-readiness tests fail after F2 fix

## Symptom
- **Observed**: Full bridge suite (`npm test` in `bridge/`) fails in `src/index-readiness.test.ts`:
  ```
  actual: [ '[Bridge] Failed to write bridge pointer:', '[Bridge] Startup readiness failed:' ],
  expected: [ '[Bridge] Failed to write bridge pointer:' ],
  test at src/index-readiness.test.ts:92:1451
  ✖ update restart holds the actual command gate until private readiness completes
    Error: Readiness did not complete
  test at src/index-readiness.test.ts:92:1823
  ✖ failed private readiness leaves the command gate and admission closed
    Error: Readiness did not complete
  ```
- **Expected**: The readiness flows complete exactly as on `origin/main`; the only new startup log/behavior from the F2 change is the orphan escalation sweep.
- **Delta**: An extra `Startup readiness failed:` error is logged during the pointer-failure case, and two update-restart readiness cases never complete within their timeout.

## Reproduction
1. On branch `fix/escalate-on-resurrection-dead-parent` with the F2 diff applied, run:
   ```
   cd bridge && npm test 2>&1 | tail -n 30
   ```
   Verified: 2026-11-14 — symptom reproduced (failures listed above).

## Hypotheses

#### H1: The extracted-startup harness's coordination double lacks `escalateOrphanedParentItems`, so the new unconditional sweep call throws inside the startup try and is logged as `Startup readiness failed`
- **Layer**: code-logic
- **Prediction**: If H1 is true, `index-readiness.test.ts` builds its coordination from an extracted/fake harness without the new method; calling it throws `TypeError: coordination.escalateOrphanedParentItems is not a function`, caught by index.ts's startup `catch` which logs `Startup readiness failed:`. The update-restart cases, which require readiness to finish, then time out with `Readiness did not complete`.
  Conversely, if H1 is false, the harness coordination will show the method present (or the sweep guarded), and the error will have a different text/cause.
- **Verification method**: read `bridge/src/index-readiness.test.ts` harness construction and `bridge/src/index.ts` startup block; run the single test file and capture the verbatim error.
- **Evidence**:
  ```
  index-readiness.test.ts:31-32 extracts the real setTimeout startup statement from index.ts:
    const timer = one(node => ts.isExpressionStatement(node) && node.getText(indexTree).startsWith('setTimeout(')
      && node.getText(indexTree).includes('ready = true;'));
  index-readiness.test.ts:95-104 defines inert doubles for store, attentionStore, resurrection — no `coordination` binding exists in the harness scope.
  index.ts (F2 diff) inside that extracted statement:
          await resurrection.resurrectSessions();
          resurrectionComplete = true;
          await coordination.escalateOrphanedParentItems();   // ReferenceError in harness scope
  Single-file run on F2 code: 4 fail — 'startup keeps its command gate closed...' (startupSteps/order),
  'failed pointer publication...' gains '[Bridge] Startup readiness failed:', both update-restart
  cases fail with 'Error: Readiness did not complete' after ~2007ms/~2026ms (the harness waitBounded 2000ms deadline, index-readiness.test.ts:59-62), because the throw precedes finishUpdateRestartAdmission/reportUpdateReady.
  ```
- **Verdict**: PROVEN
- **Rationale**: The harness evals the real startup block without a `coordination` binding; the new unconditional call throws, index.ts's startup catch logs `Startup readiness failed:`, and the update-restart report is never reached. Every observed failure is a downstream consequence of that single throw.

#### H2: The index-readiness failures pre-date the F2 diff (broken or flaky on origin/main in this environment)
- **Layer**: observation
- **Prediction**: If H2 is true, stashing the F2 diff and running `src/index-readiness.test.ts` on the base commit reproduces the same failures.
  Conversely, if H2 is false, the base run is green.
- **Verification method**: `git stash` the F2 changes, run the single test file, restore.
- **Evidence**:
  ```
  git stash push -m "f2-wip" -- bridge/src/index.ts bridge/src/session-resurrection.ts ... (F2 diff stashed)
  node --import tsx --test src/index-readiness.test.ts
  ✔ invite advice is emitted only when its actual encrypted CLI command can dispatch
  ✔ startup keeps its command gate closed until the existing readiness timer
  ✔ failed pointer publication does not advertise the local invitation command
  ✔ update restart holds the actual command gate until private readiness completes
  ✔ failed private readiness leaves the command gate and admission closed
  ℹ pass 5  ℹ fail 0
  git stash pop (F2 diff restored)
  ```
- **Verdict**: REJECTED
- **Rationale**: The untouched base is green (5/5); the failures arrive only with the F2 diff.

#### H3: The sweep adds awaited startup latency (store list + attention reads) that pushes update-restart readiness past the test's fixed completion timeout
- **Layer**: state-data
- **Prediction**: If H3 is true, the harness coordination HAS the new method (or a real coordination), no `Startup readiness failed` error text appears for the timeout cases, and readiness merely arrives late; the pointer-failure case would not gain the extra error log.
  Conversely, if H3 is false, the timeout cases will show an exception (per H1) rather than slow completion.
- **Verification method**: capture the full error output of the two timeout cases; check whether an exception precedes the timeout.
- **Evidence**:
  ```
  'failed pointer publication' case (no timing involved) gains the exception log:
    actual: [ '[Bridge] Failed to write bridge pointer:', '[Bridge] Startup readiness failed:' ],
    expected: [ '[Bridge] Failed to write bridge pointer:' ]
  An exception inside the startup try is therefore present; pure added latency cannot produce that log line.
  ```
- **Verdict**: REJECTED
- **Rationale**: The extra `Startup readiness failed:` log proves a thrown exception, not slow completion; the timeouts are its downstream effect (report never called).

## 5 Whys
```
Symptom:    index-readiness tests fail after the F2 fix (extra readiness error log; update-restart readiness timeouts).
Why 1?      Because `await coordination.escalateOrphanedParentItems()` throws inside the harness's eval of the startup timer block.
Why 2?      Because index-readiness.test.ts executes the real setTimeout startup statement against inert doubles, and its scope defines no `coordination` binding (ReferenceError).
Why 3?      Because the harness doubles enumerate the startup sequence's dependencies one by one (resurrection, store, attentionStore), and a new startup step adds a new free variable the harness must supply.
Why 4?      Because the F2 change added a startup step in index.ts without updating the extracted-source harness that mirrors the startup composition.
Why 5?      Root: source-extracting harnesses couple tests to the composition root's free variables; any new startup dependency must be added to the harness in the same change (test maintenance is part of the feature change).
```

## Falsification
- Check performed: absence test — the base commit (proven cause absent: no sweep call in index.ts) was run through the same test file.
- Result: base is green 5/5 (evidence under H2); with the sweep call present and no harness double, 4/5 fail with the predicted signature.
- Adjacent-cause search: a store/attention double failure would log the same catch line, but those doubles succeed on base and are unchanged; the only new free variable in the extracted block is `coordination`.
- Conclusion: hypothesis survived.

## Root Cause
- Immediate cause: `bridge/src/index.ts` startup block calls `coordination.escalateOrphanedParentItems()`; `bridge/src/index-readiness.test.ts` evals that exact block with inert doubles that lack a `coordination` binding, so the call throws, the startup catch logs `Startup readiness failed:`, and update-restart readiness never completes.
- Architectural root: the extracted-source readiness harness mirrors the composition root's dependencies; new startup steps must ship with their harness double (5 Whys, Why 5).
- Rejected H2: base commit is green 5/5 in the same environment.
- Rejected H3: the exception log line in a non-timing case proves a throw, not latency.

## Fix
- File `bridge/src/index-readiness.test.ts` — add an inert `coordination` double (`escalateOrphanedParentItems` records a `sweep` startup step and asserts resurrection completed first), and extend the expected startup sequence to `['resurrect', 'sweep', 'list', 'restore']`. No production change: real `createCoordination` provides the method, and the wiring implementation already fails soft.
- Regression coverage: the F2 tests in `session-resurrection.test.ts`, `coordination/attention-routing.test.ts`, `coordination/wiring.test.ts` (fail before, pass after) plus this harness update proving sweep ordering at startup.

## Resolution
- Diff summary: `bridge/src/index-readiness.test.ts` only — inert `coordination` double recording a `sweep` step after resurrection, expected startup sequence `['resurrect', 'sweep', 'list', 'restore']`. No production-source change for this failure.
- Verification: `node --import tsx --test src/index-readiness.test.ts` — 5 pass, 0 fail (was 1 pass, 4 fail). Full bridge suite re-run follows in the F2 change.
- Follow-up: none; the sweep's own behavior is covered by the F2 regression tests.
