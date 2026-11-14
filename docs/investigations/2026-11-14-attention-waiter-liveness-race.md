---
type: investigation
symptom: "unit-tests CI: 'waitForItem abort rejects as cancelled and clears liveness when no waits remain' fails false !== true at attention-store.test.ts:678"
slug: attention-waiter-liveness-race
date: 2026-11-14T17:45:00-03:00
investigator: Foad Kesheh
git_commit: bb4032652209d3a37d89bf981b128c362b0fb90e
branch: feat/require-green-pr
repository: fmktech/ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-11-14-preview-scroll-target-closed.md
---

# Attention waiter liveness race under load

## Symptom
- **Observed**: run 43622056931 (`unit-tests`, head bb40326): `✖ waitForItem abort rejects as cancelled and clears liveness when no waits remain (28ms)` — `AssertionError: false !== true at attention-store.test.ts:678`, plus `Attention history could not be persisted` async activity after test end. All other checks green.
- **Expected**: after aborting one of two waiters on the same item, `hasLiveWaiter(item.id)` stays `true` (test line 678).
- **Delta**: liveness reads `false` while the second `waitForItem` call is still in flight.

## Reproduction
Standalone `node --import tsx --test src/attention-store.test.ts`: 44/44 pass, 3 consecutive runs (local). Main-branch `unit` push runs (43621856811, 43621850496) green. Failure appears only in the full-suite PR run — load/timing dependent. Load reproduction in progress below.

## Hypotheses

#### H1: First waiter's abort cleanup deletes the shared poller before the second waiter registers (registration happens after async `readItem`)
- **Layer**: state-data (race/ordering)
- **Prediction**: in `attention-store.ts`, poller registration (lines 566-572) happens after `await this.readItem(...)` (line 564), while abort cleanup (line 589) deletes the poller when `active === 0`; if waiter B is still in its first `readItem` when waiter A aborts, A's cleanup sees active drop to 0 and deletes the poller, so `hasLiveWaiter` (lines 133-137) returns false at test line 678. Under load, B's disk-backed first read exceeds the test's 10ms delay.
- **Verification method**: read store + test source; reproduce under CPU/disk load.
- **Evidence**: load repro (8 CPU hogs, single-test pattern, 12 runs): 4/12 FAIL on unpatched code with the identical CI signature (`false !== true` at test line 678 plus `Attention history could not be persisted` after-test activity); 0/12 after the fix. Standalone file: 44/44 pass.
- **Verdict**: PROVEN

#### H2: Product semantics changed by recent merges (#218/#224) broke liveness
- **Layer**: code-logic
- **Prediction**: failure reproduces standalone on this head and/or on origin/main.
- **Evidence**: standalone passes 3/3 on this head; main `unit` runs green on the same merged code. `git log` shows no attention-store change in the recent merges.
- **Verdict**: REJECTED

#### H3: Pure runner slowness; test's fixed 10ms delay is the only defect (test artifact)
- **Layer**: observation
- **Prediction**: with explicit synchronisation (wait until both waiters registered) the test passes under the same load, with no store change.
- **Evidence**: the store already tracks in-flight waits synchronously (`itemWaiters`, line 554-556); the defect is the poller cleanup ignoring that set, so a test-only sync would mask a real bookkeeping gap that also affects `hasLiveWaiter` callers (line 429).
- **Verdict**: REJECTED (test delay widens the window; the store cleanup is the defect)

## 5 Whys
Symptom: aborting one of two waiters clears liveness while the second wait is in flight, under load.
Why 1? The first waiter's abort cleanup deletes the shared poller when `active === 0`.
Why 2? The second waiter registers its poller only after its first async `readItem`, which load can delay past the abort.
Why 3? Cleanup consults only the poller refcount, not the synchronously-maintained `itemWaiters` set that records every in-flight `waitForItem` call.
Why 4? Liveness bookkeeping grew two tracks (wake set + poller map) without an invariant tying their lifetimes.
Why 5? No load/parallel regression coverage exercised overlapping wait startup + abort, so the ordering gap stayed latent until full-suite CI load.

## Falsification
- Absence test: without load (standalone, main CI) the race does not manifest — consistent with a timing ordering defect, not a semantics change (H2 rejected).
- Counterfactual: reverting the one-line guard returns 4/12 failures under identical load; with the guard, 0/12. Hypothesis survived.

## Root Cause
- Immediate cause: `AttentionStore.waitForItem` finally-block (`bridge/src/attention-store.ts:589`) deletes the item's poller on abort whenever `active === 0`, even when another `waitForItem` for the session has already registered in `itemWaiters` but has not yet finished its first `readItem` to join the poller.
- Architectural root: two liveness tracks (`itemWaiters` wake set, `pollers` map) with no lifetime invariant between them.
- Rejected H2: no semantics change; green standalone and on main. Rejected H3: test delay only widens the window.

## Fix
- File `bridge/src/attention-store.ts:589` — only delete the poller on abort when `waiters.size === 0` (no other wait in flight for the session). Stale entries remain bounded by the existing TTL check in `hasLiveWaiter` and the prune at line 569.
- Regression test: existing `waitForItem abort rejects as cancelled and clears liveness when no waits remain` — fails 4/12 under load before, passes 12/12 after (plus full file 44/44).

## Resolution
- Load repro: 4/12 fail before fix, 0/12 after; `attention-store.test.ts` 44/44; bridge build green. CI verification on the fix head pending at time of writing.
