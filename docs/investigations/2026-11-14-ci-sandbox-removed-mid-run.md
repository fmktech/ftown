---
type: investigation
symptom: "direct-transport-e2e jobs fail with 'Remote execution completion unconfirmed' after a sandbox removing operation, with no failing test"
slug: ci-sandbox-removed-mid-run
date: 2026-11-14T11:00:00-03:00
investigator: Foad Kesheh
git_commit: 7db8a2ad34fdab6ad8f067dbdbf2aa2a1bb3761c
branch: fix/ci-sandbox-removed
repository: fmktech/ftown
status: resolved
hypotheses_formed: 5
hypotheses_rejected: 4
hypotheses_proven: 1
related:
  - docs/ci.md
  - docs/investigations/boat-ci-migration/review.md
---

# CI e2e jobs die with "Remote execution completion unconfirmed" and a sandbox removing operation

## Symptom
- **Observed**: PRs #215 (run 43577616707, shard 2/3), #218 (43577625773, 1/3),
  #220 (43577629621, 2/3) at ~2026-11-14T08:57Z and #222 (43579354682, 2/3) at
  09:15Z failed with no failing test. Playwright was passing tests, then the log
  prints `{"operation":{...,"kind":"sandbox","reason":"explicit","stage":"removing",
  "targetId":"bx_..."}}` followed by `Remote execution completion unconfirmed`,
  exit 1.
- **Expected**: The e2e job either reports the remote Playwright result (pass or a
  real test failure) or fails with a reason that says what actually happened.
- **Delta**: A green, mid-suite run is reported as a failure with a message that
  implicates sandbox deletion, which sends investigators toward test flakes and
  external deletion. Neither happened (proven below).

## Workflow step that runs e2e in a remote sandbox
- `.github/workflows/e2e.yml:13-34` — job `direct-transport-e2e` (matrix shards
  1/3, 2/3, 3/3, `timeout-minutes: 45`) calls `./.github/actions/run-ci` with
  `job: e2e`.
- `.github/actions/run-ci/action.yml:41` — runs `node scripts/ci/boat-runner.mjs`.
- `scripts/ci/boat-runner.mjs:246-255` (`create`) — `boat --json new --ttl 2700
  --type default --no-env --no-snapshots`.
- `scripts/ci/boat-runner.mjs:265-284` (`execute`) — `boat --json exec --stream
  --timeout <remoteTimeout> --cwd repo <id> -- env -i ... bash scripts/ci/run-job.sh e2e`;
  stdout/stderr frames are re-printed; an `exit` frame is required.
- `scripts/ci/boat-runner.mjs:304-315` (`cleanup`) — `boat delete --yes <id>` then
  polls `boat info` until the provider returns `not_found`.
- `scripts/ci/run-job.sh` (`e2e` case) — inside the sandbox: unit tests (shard 1),
  builds, then `npx playwright test --shard=<shard>` (65 tests).

## Reproduction
The original failures are historical GitHub runs; the mechanism was reproduced
with the local Boat CLI (account CLI 1.0.97) against disposable sandboxes:

1. Create `bx_prrzdmsw` (small, TTL 300s). Start
   `boat --json exec --stream --timeout 60 <id> -- bash -c 'for i in $(seq 1 30); do echo tick $i; sleep 1; done'`,
   then delete the sandbox from a second shell after 5s.
   ```
   {"data":"tick 6\n","type":"stdout"}
   {"error":"box_direct_failed","message":"ECONNRESET: The socket connection was closed unexpectedly...","retryable":false,"type":"error"}
   (no exit frame; CLI exited 1 ~31s after the delete)
   ```
2. `boat delete` (no `--json`) prints exactly the operation line seen in CI:
   ```
   {"operation":{"attemptCount":0,...,"id":"bdop_d602216cbf5c4a13a60bce659c083771","kind":"sandbox","reason":"explicit","requestedAt":"2026-11-14T10:48:14.645Z","stage":"removing","status":"processing","targetId":"bx_prrzdmsw"}}
   ```
3. Deleting an already-removing/deleted sandbox returns the SAME operation id
   with the ORIGINAL `requestedAt` and exit 0 (probe `bx_mhvgn8hn`). So a cleanup
   delete after an external delete would print the external request time, not
   its own.
   Verified: 2026-11-14 — both probe sandboxes deleted afterwards; confirmed
   absent from `boat list`.

## Hypotheses

#### H1: An external actor deleted the sandboxes mid-run (concurrency cancel, another PR's cleanup, a human/automation sweep, or a platform quota reaper)
- **Layer**: dependency
- **Prediction**: If an external client deleted sandbox `bx_...` at time T, the
  job's own cleanup delete (which runs after `execute` throws) would print the
  same operation with `requestedAt` = T, minutes/seconds BEFORE the log print
  time; and the exec stream would first receive a `box_direct_failed` error
  frame (probe 1). Conversely, if the job's cleanup was the first deleter,
  `requestedAt` would be ~100ms before the log line (one local CLI round-trip).
- **Verification method**: Compare `requestedAt` vs log timestamps in all four
  failed runs; probe external-delete and double-delete behavior with the real CLI.
- **Evidence**:
  ```
  PR215 bx_te9h7r6s requestedAt 08:57:26.694Z, log line 08:57:26.797Z (Δ103ms)
  PR218 bx_n25kg6cp requestedAt 08:57:32.775Z, log line 08:57:32.979Z (Δ204ms)
  PR220 bx_a94cqrm9 requestedAt 08:57:36.790Z, log line 08:57:36.884Z (Δ94ms)
  PR222 bx_afcvenrp requestedAt 09:15:42.754Z, log line 09:15:42.845Z (Δ91ms)
  ```
  All four deltas are one local CLI request latency. No `Sandbox deletion
  failed; TTL remains active` warning appears in any failed log (grep count 0
  in all four runs), and `boat deletion status` shows each operation completed
  normally. In-repo, the only `delete` call site is `boat-runner.mjs:305`, which
  deletes only the job's own validated ID (`idPattern` at `boat-runner.mjs:10`);
  no list/delete-all exists anywhere in the repo.
- **Verdict**: REJECTED
- **Rationale**: The deleting client was the failing job's own cleanup in all
  four runs. The sandboxes were still alive when their jobs ended.

#### H2: A GitHub concurrency cancel, job timeout, or cancellation signal killed the jobs
- **Layer**: config-env
- **Prediction**: If GitHub cancelled the run/job, sibling shards would also
  stop, the conclusion would be `cancelled`, and the runner's signal handler
  (`boat-runner.mjs:317-327`) would produce `Cancelled` (exit 130).
- **Verification method**: Read `.github/workflows/e2e.yml`; inspect job
  conclusions/timings via `gh run view --json jobs`.
- **Evidence**:
  ```
  e2e.yml has no `concurrency:` block (only `timeout-minutes: 45`).
  PR222: shard 2/3 died 09:15:42; shard 3/3 kept running to 09:18:08 and
  shard 1/3 to 09:19:57, both SUCCESS. All four runs: run_attempt = 1,
  failing job conclusion = failure (not cancelled).
  No "Cancelled" line in any failed log.
  ```
- **Verdict**: REJECTED
- **Rationale**: Nothing on the GitHub side cancelled anything; siblings in the
  same run outlived each failure by minutes.

#### H3: Sandbox TTL expiry or an account quota removed the sandboxes
- **Layer**: config-env
- **Prediction**: TTL kills would arrive ~2700s after creation with a non-explicit
  reason; quota kills would need the active-sandbox ceiling approached.
- **Verification method**: Sandbox ages from `Boat sandbox:` log lines vs removal
  times; `boat limits` for the account ceilings and start-window semantics.
- **Evidence**:
  ```
  bx_te9h7r6s created 08:51:22, removed 08:57:26 (age 364s)
  bx_n25kg6cp created 08:57:00, removed 08:57:32 (age 32s)
  bx_a94cqrm9 created 08:54:07, removed 08:57:36 (age 209s)
  bx_afcvenrp created 09:11:31, removed 09:15:42 (age 251s)
  TTL is 2700s (boat-runner.mjs:248). Reason is "explicit", not TTL.
  boat limits: maxActiveSandboxes 100; start-window help states "Your running
  sandboxes keep running" when the window is full. At 09:15Z only PR222's
  three e2e sandboxes were active, yet one still died.
  ```
- **Verdict**: REJECTED
- **Rationale**: Ages are 32s–6min against a 45min TTL, and the 09:15 kill
  happened at minimal concurrency. Quota/TTL cannot be the cause.

#### H4: The Boat exec stream ended without an exit frame while the sandbox stayed alive (platform/API stream drop or in-sandbox exec-agent failure); the runner then misreported it and its own cleanup produced the "explicit removal" line
- **Layer**: dependency
- **Prediction**: If the stream died first, the runner code path at
  `boat-runner.mjs:282` (`remoteExit === undefined`) throws exactly
  `Remote execution completion unconfirmed`; `orchestrate` then runs cleanup,
  whose delete prints the removing operation ~100ms after requesting it.
  Tests would be passing at the drop, and times would cluster across runs
  sharing the platform.
- **Verification method**: Trace `boat-runner.mjs` print paths (execute uses
  `stream: false`, so its CLI cannot print the operation line; cleanup at
  `boat-runner.mjs:305` uses the default `stream: true` and does); align log
  timestamps; CLI probes above.
- **Evidence**:
  ```
  PR215: last test ✓ 08:57:23.735 -> operation 08:57:26.797 -> "Remote execution completion unconfirmed" 08:57:27.010
  PR220: last test ✓ 08:57:36.664 -> operation 08:57:36.884 -> unconfirmed 08:57:37.073
  PR222: last test ✓ 09:15:42.624 -> operation 09:15:42.845 -> unconfirmed 09:15:43.049
  PR218: sandbox created 08:57:00, still in setup/apt output at 08:57:32.380,
         operation 08:57:32.979 -> unconfirmed.
  boat-runner.mjs:282: if (remoteExit === undefined || result.code !== remoteExit)
    throw new Error("Remote execution completion unconfirmed");
  ```
  Three deaths land at 08:57:26/32/36 (shared platform), each in a different
  run/sandbox; siblings on the same platform survived, so the drop hit a subset
  of streams (e.g. one API/exec node), not every stream.
- **Verdict**: PROVEN
- **Rationale**: Every observable — passing tests at death, the ~100ms
  delete-print delta, cleanup success with no warning, the exact error string's
  code path, and the cross-run cluster — matches a stream that ended without an
  exit frame on a live sandbox. Which platform component dropped the streams
  (API gateway vs in-sandbox exec agent) is not observable from the repo or the
  CLI; both are Boat-platform side.

#### H5: The remote job itself (Playwright/run-job.sh) crashed and the sandbox died with it
- **Layer**: code-logic
- **Prediction**: A crashed remote command still yields an `exit` frame (the
  migration probes propagated remote exit 42 and streaming exit 23 exactly —
  `docs/investigations/boat-ci-migration/coordination.md:41`), so the runner
  would report `Remote job failed (<code>)`, not "completion unconfirmed", and
  one run's crash would not cluster with two others within 10 seconds.
- **Verification method**: Compare error strings in logs; check test progress at death.
- **Evidence**:
  ```
  All four logs end mid-suite on a ✓ line (e.g. PR215 test 29 ✓ at
  08:57:23.735 of 65) with no test failure, no exit frame, and the
  "completion unconfirmed" string that only boat-runner.mjs:282 produces.
  ```
- **Verdict**: REJECTED
- **Rationale**: A remote crash produces an exit code through this runner; a
  silent stream end on a live sandbox does not.

## 5 Whys
Symptom:    Passing e2e jobs fail with "Remote execution completion unconfirmed" next to a sandbox removing operation.
Why 1?      Because the Boat `exec --stream` stream ended without an `exit` frame, so `boat-runner.mjs:282` threw the generic unconfirmed error.
Why 2?      Because a Boat platform component dropped those exec streams while the sandboxes stayed alive (three within 10s across runs at 08:57Z, one at 09:15Z).
Why 3?      Because the runner's contract with the platform assumed a stream always terminates with an exit frame (or its local timeout); it records no platform error frame and checks no sandbox state when that assumption breaks.
Why 4?      Because the failure was therefore undiagnosable from the job log: the next line is the job's own cleanup delete, which reads as "the sandbox was removed mid-run" and points at tests, quotas, and other PRs.
Why 5?      Because the CI boundary had no classification for platform stream failures — no sandbox naming, no liveness check, no actionable message — so a vendor-side drop became a misleading PR failure. Root cause at our boundary: unclassified platform failure at the exec-stream edge; the drop itself is Boat-platform side and outside this repo.

## Falsification
- Check performed: absence + adjacent-cause. I tried to prove the sandboxes were
  deleted externally (H1): if so, cleanup would have printed an operation whose
  `requestedAt` predates the log line by the exec CLI's post-delete hang
  (measured ~31s in probe 1) and/or cleanup would have warned. All four runs
  show a ~100–200ms request-to-print delta and no warning, so the external-delete
  reading fails and H4 survives. Sandbox liveness after each failure is also
  implied by each cleanup delete completing as a first-class operation
  (`boat deletion status`: completed, attemptCount 1).
- Result: hypothesis survived; the platform sub-component (API vs in-sandbox
  agent) remains a named gap that only Boat-side logs can close.

## Root Cause
- Immediate cause: The Boat exec stream for four e2e jobs ended without an exit
  frame on still-living sandboxes (`scripts/ci/boat-runner.mjs:282`); each job's
  own cleanup then deleted its sandbox, printing the `reason:"explicit"`
  removing operation that made it look like a mid-run removal.
- Architectural root: The runner does not classify platform stream failures: it
  drops Boat `error` frames (`parseExecFrame` rejects them), never checks
  sandbox state when the stream ends abnormally, and creates anonymous
  sandboxes, so a platform drop is indistinguishable from a test failure or an
  external deletion.
- Rejected H1: cleanup was the first deleter in all 4 runs (Δ91–204ms ×4; no cleanup warning).
- Rejected H2: no concurrency config; attempt 1; siblings outlived each failure.
- Rejected H3: ages 32s–6min vs 2700s TTL; explicit reason; kill at ~3 active sandboxes.
- Rejected H5: remote crashes propagate an exit code through this runner; logs end on passing tests.

## Fix
- `scripts/ci/boat-runner.mjs` — accept Boat `error` exec frames in
  `parseExecFrame`; in `execute`, when the stream fails or ends without an exit
  frame, query `boat info` for the sandbox state before cleanup deletes it and
  throw a clear, actionable error naming the sandbox, its state, and that no
  test result was reported (platform failure, re-run the job). Traced to Why 3/4.
- `scripts/ci/boat-runner.mjs` — create sandboxes with
  `--name ci-<job>-<runId>-<attempt>[-<shard>]` so CI boxes are identifiable in
  `boat list` and never mistaken for stale session boxes. Traced to Why 5.
- Regression test: `scripts/ci/boat-runner.test.mjs` — drive the real `main()`
  with a fake Boat CLI whose exec stream ends without an exit frame (silent
  drop and platform error frame) while `boat info` still reports the sandbox
  ready; assert the failure names the sandbox/state and is not the bare
  "completion unconfirmed" string. Fails before, passes after.
- Justification (symptom-level for the drop itself): the stream drop is in the
  Boat platform, outside this repo's control; the repo-side root cause is the
  unclassified failure at our boundary, which this fix removes. A platform
  incident report with the four sandbox IDs/timestamps is the follow-up.

## Resolution
- Diff summary: `scripts/ci/boat-runner.mjs` (error-frame parsing, sandbox-state
  diagnosis on unconfirmed streams, `--name ci-*` on sandbox creation),
  `scripts/ci/boat-runner.test.mjs` (3 new tests driving the real `main()`),
  `docs/ci.md` (naming + failure classification), this log.
- Verification: new tests fail on the unpatched runner with the exact CI
  strings (`Remote execution completion unconfirmed`, `Invalid execution
  frame`) and pass after the fix; full suite
  `node --test scripts/ci/boat-runner.test.mjs scripts/ci/bridge-version.test.mjs`
  green (29 pass). One pre-existing 1s-timeout bootstrap test failed once under
  concurrent local load during development and passed alone and in the full
  suite re-run; the untouched tree passes the same suite (24 pass).
- Follow-up: report sandbox IDs bx_te9h7r6s, bx_n25kg6cp, bx_a94cqrm9 and
  bx_afcvenrp with deletion-operation IDs bdop_f2a8fd926b884f4892bd07d6240299c7,
  bdop_259714dfb4784ba8940c8911793a94de, bdop_663e0d07eea2424ea1d142a7eadc1371 and
  bdop_1da779fada7843fea65efcf8403c35fe to the Boat platform operator and ask
  which component dropped the exec streams at 2026-11-14T08:57:26–36Z and
  09:15:42Z.
