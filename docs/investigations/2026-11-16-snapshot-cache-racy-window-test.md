---
type: investigation
symptom: "The macOS unit job failed the snapshot cache racy-window assertion."
slug: snapshot-cache-racy-window-test
date: 2026-11-16T10:43:14-03:00
git_commit: 6cb331a78f1105360c2d9b3b0985cafd8654b8e7
branch: linux/grok-quota-linux
repository: ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

# Snapshot cache racy-window test failed on macOS

## Symptom
- **Observed**: CI reported `does not cache reads taken right after a write (racy window)` failing at `bridge/src/security/bridge/snapshot.test.ts:207` with `1 !== 2`.
- **Expected**: the test expected two parses because it considered the reads to have occurred within 40 ms of the write.
- **Delta**: the snapshot cached after the first parse, so only one parse occurred.

## Reproduction
1. Run the isolated test: `node --import tsx --test --test-name-pattern="does not cache reads taken right after a write" src/security/bridge/snapshot.test.ts` from `bridge/`.
2. On the current macOS host this passed (1 test, 1 pass). CI's recorded failure is the on-demand reproduction: `unit-macos`, run `43876715732`, failed at line 207 with `1 !== 2`.

## Hypotheses

#### H1: The test's wall-clock guard does not measure the file timestamp age used by production code.
- **Layer**: observation
- **Prediction**: A run can satisfy `Date.now() - wrote < 40` while the file's mtime/ctime is already at least 50 ms old, allowing a cache hit and `parses === 1`.
- **Verification method**: compare the test at `snapshot.test.ts:199-207` with the production predicate at `snapshot.ts:30-32` and the CI failure evidence.
- **Evidence**:
  ```
  test: if (Date.now() - wrote >= 40) continue;
  test: assert.equal(parses, 2);
  source: this.cache = Date.now() - newest >= RACY_WINDOW_MS ? { identity: identityOf(fstat), value } : null;
  source: const RACY_WINDOW_MS = 50;
  CI: ✖ does not cache reads taken right after a write (racy window)
  CI: 1 !== 2
  ```
- **Verdict**: PROVEN
- **Rationale**: The test gates on elapsed time since its `wrote` variable, while the code gates on the filesystem's mtime/ctime. The CI assertion outcome is exactly a cache hit despite the test's own 40 ms guard; these are independent clocks and the guard does not establish the production predicate.

#### H2: Slow test scheduling made the reads exceed the test's 40 ms cutoff.
- **Layer**: config-env
- **Prediction**: If scheduling delay were the cause, the elapsed-time guard would continue to another attempt instead of reaching the assertion.
- **Verification method**: inspect the branch and assertion ordering at `snapshot.test.ts:199-207` and CI's failing line.
- **Evidence**:
  ```
  if (Date.now() - wrote >= 40) continue;
  assert.equal(parses, 2);
  ```
- **Verdict**: REJECTED
- **Rationale**: The failure occurred at the assertion after the guard, so the measured elapsed duration was below 40 ms. Scheduling delay alone would take the `continue` path.

#### H3: The Grok change altered snapshot cache behavior.
- **Layer**: code-logic
- **Prediction**: If the Grok change caused this failure, the snapshot implementation or its test would differ in this branch.
- **Verification method**: inspect the branch diff for the snapshot files.
- **Evidence**:
  ```
  Changed files: bridge/src/quota/grok.test.ts, bridge/src/quota/grok.ts, bridge/package.json, bridge/package-lock.json, docs/platform-support-analysis.md
  ```
- **Verdict**: REJECTED
- **Rationale**: Neither snapshot file was changed; the failure is in an existing timing-based test.

## 5 Whys
Symptom: the macOS test asserted two parses but observed one.
Why 1? The test's elapsed-time guard admitted a file whose metadata made it cacheable.
Why 2? The test used `Date.now() - wrote` while production uses filesystem mtime/ctime age.
Why 3? The test encoded a timing window using wall-clock elapsed time rather than controlling the metadata input.
Why 4? The test depended on real filesystem clocks and scheduling for a boundary condition.
Why 5? The test had no deterministic fixture for the cache-age boundary.

## Falsification
- **Check performed**: adjacent-cause check and isolated reproduction.
- **Result**: Slow scheduling alone is incompatible with reaching the assertion because elapsed times at or above 40 ms continue the loop. The isolated test passed on this host, consistent with an environment-sensitive test; the CI failure's `parses === 1` after the guard is explained by the mismatch between the test clock and metadata age.
- **Conclusion**: H1 survived; H2 and H3 are rejected.

## Root Cause
- **Immediate cause**: the racy-window test uses a wall-clock guard that does not control the mtime/ctime age used by the cache predicate (`snapshot.test.ts:199-207`, `snapshot.ts:30-32`).
- **Architectural root**: a boundary test relied on nondeterministic host filesystem timing instead of setting deterministic timestamps.
- **Rejected H2**: CI reached the assertion after the `<40 ms` guard, so read scheduling over that bound was not the asserted failure.
- **Rejected H3**: the snapshot files were untouched in this branch diff.
- **Falsification check**: the isolated test passed locally; CI independently failed with the exact result predicted when metadata is already outside the cache-protection window despite the wall-clock guard.

## Fix
- `bridge/src/security/bridge/snapshot.test.ts` — set mtime/ctime explicitly into the future so they remain within the no-cache window for the entire test, regardless of host timestamp precision or load.
- Regression test: `bridge/src/security/bridge/snapshot.test.ts`.

## Resolution
- **Diff summary**: Replaced the 40 ms wall-clock retry loop with a deterministic future-timestamp fixture. The future timestamp also exercises the clock-skew case handled by the same age predicate.
- **Verification**: The isolated regression test passed 10 consecutive runs and 20 additional runs in four parallel workers. The snapshot test file passed (16/16), Grok quota tests passed (51/51), and `npm run build` passed.
- **Follow-up**: None.
