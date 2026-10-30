---
type: investigation
symptom: "Attention pending and MCP session completion checks fail under CI timing"
slug: ci-test-deadlines
date: 2026-10-30T15:48:22-03:00
investigator: Foad Kesheh
git_commit: 229607d
branch: fix/update-dialog-layout
repository: fmktech/ftown
status: investigating
hypotheses_formed: 3
hypotheses_rejected: 0
hypotheses_proven: 0
---

# CI bridge deadline failures

## Symptom and evidence
Run 41108803523, Node 24.22.1 Linux, `attention-store.test.ts:124`: `true !== false` after an intended pending wait with a one-second deadline; test took 2487ms. `mcp.test.ts:260`: `false !== true` for `sessions_wait` with `timeoutSeconds: 1`; whole integration test took 48366ms. Root ran exact named tests isolated: Mac Node24.22.1 both pass (83ms attention, 1540ms MCP); Linux sandbox Node24.22.1 both pass (455ms attention, 12514ms MCP). Sandbox IO pressure was observed but is not a measurement of CI host pressure. Failing CI log does not contain the MCP result's observations or whether its bounded transport failed, so its proximate cause is not proven.

## Deterministic deadline diagnostic
Scratch `/tmp/ftown-attention-deadline-diagnostic.ts` uses the real AttentionStore, fake `Date.now`, no eligible event and a wait of 1 second; advances the clock to the deadline during the initial asynchronous read. Under Node24.22.1 `node --import tsx --test /tmp/ftown-attention-deadline-diagnostic.ts` produced:
```
elapsed deadline, completed=true, eligible events=0
✔ deadline returns without an eligible event
```
`AttentionStore.wait` deliberately returns an empty page when `Date.now() >= deadline`; it may therefore complete without a notification. The original test's assertion `completed === false` after several awaited fsync-backed writes and `delay(20)` conflates no notification with elapsed deadline. This diagnostic establishes a possible exact symptom, not the timing of the individual CI event.

## Hypotheses

#### H1: Attention wait completes due to its one-second deadline during test filesystem work.
- **Layer**: test timing / observation.
- **Prediction**: advancing time to deadline with no eligible event yields `completed=true`, empty page; freezing deadline prevents this false signal while preserving event behavior.
- **Verification**: actual-store fake-clock diagnostic above; inspect store `wait` deadline path.
- **Evidence**: diagnostic outcome; CI test 2487ms; isolated tests pass faster.
- **Verdict**: PROVEN as a sufficient mechanism, not proven as the specific CI ordering.
- **Rationale**: deadline termination matches the assertion and does not require a wake event.

#### H2: A duplicate, acknowledgement, or unrelated tool event actually wakes the wait with an eligible event.
- **Layer**: code/state.
- **Prediction**: wait returns a nonempty page before its deadline with the same operations under a controlled unexpired clock.
- **Verification**: proposed controlled-time pending test and distinct-creation positive control; pending approval and execution.
- **Evidence**: existing CI assertion does not inspect returned page; isolated test passes. Diagnostic establishes timeout can yield the observed flag.
- **Verdict**: INCONCLUSIVE; no claim it is rejected without a controlled test.

#### H3: MCP failure is solely an assertion issue and no transport observation completes within one second under CI load.
- **Layer**: integration/timing.
- **Prediction**: a valid completed status cannot be obtained before one-second deadline in the failing run; a longer bounded window will permit real observation.
- **Verification**: inspect CI result observations or reproduce under the same environment. CI records matched=false only; exact Linux test passed in isolation, so cause unproven.
- **Evidence**: default `sessions_wait` schema budget is 20 seconds, max 30; its per-target real encrypted request is bounded by the supplied deadline, and catches request failures into unmatched observations.
- **Verdict**: INCONCLUSIVE; 1-second wait is a fragile test boundary, not proven cause of this run.

## Proposed narrow test-only changes for root review

1. In the attention test, preserve initial read/listener race, eligible-creation positive check, cursor/no-fresh result, and abort assertions. For the second wait, use `t.mock.timers` for global `Date` and `setTimeout` with fixed current time and do not advance the clock while performing duplicate, ack and PostToolUse writes. Replace wall-time `delay(20)` with an awaited `store.list` barrier (store serializes session operations) plus a real `setImmediate` turn, then assert wait still pending and abort it. Explicitly exercise each non-eligible operation with a pending assertion and retain cleanup on test completion. Demonstrate controlled clock behavior in a new unit test or in the same test, and run focused attention unit under Node24. No production timers or global test settings change.
2. In MCP lifecycle test omit `timeoutSeconds: 1` and use the existing production schema default 20 seconds for the actual real-transport completed-session observation, preserving `matched === true`, stop, completed-status and all other assertions. This is a bounded integration budget, not retries or sleep; error details remain visible on failure. It does not prove the original CI failure was a timeout rather than another per-target error. Root alone runs the real MCP integration after approval.

No source or test edits yet. Root must approve proposal. No CI reruns, service runs, package changes or production edits by worker.

## Approved test-only changes and checks

Root approved controlled `Date` and `setTimeout` for the second pending attention wait; no internal read-count spy. The test checks pending after each duplicate notification, acknowledgement, and PostToolUse via serialized `store.list` and a real `setImmediate` turn, then verifies abort; clocks reset before wait-zero and distinct-creation checks. Initial read/listener race and actual eligible wake remain intact. MCP test omits its one-second override and uses the existing 20-second default while retaining the `matched === true` real-transport assertion. No production, package, retry or CI setting changed.

Node24.22.1 `cd bridge && node --import tsx --test src/attention-store.test.ts` passed 16/16; expected existing recovery warnings for intentionally missing/unreadable ledgers appeared. Root owns MCP integration/Linux execution and will review that result. The clock diagnostic establishes a sufficient failure mechanism only; the actual CI wait completion reason and MCP observation error remain unproven. No MCP/server, browser, CI or Git execution by worker.

## R4 independent review

The MCP change keeps the real transport and `matched === true` check and uses the established 20-second default; it adds no retry or production change. The attention pending assertions now use a serialized barrier and fixed clock after each noneligible operation, preserving the existing pre-clock eligible creation, abort and zero-wait checks. Two frozen-contract gaps remain before approval: timer reset occurs only on the successful path, so add a `finally` that resets the mock clock and aborts/settles any outstanding wait even if an assertion throws; and add a distinct eligible creation that resolves a waiter while the clock remains frozen. This positive control proves that mocked timers do not suppress the event-delivery path tested by the negative checks. Root owns MCP and runtime execution. No test or production edits by R4.

### R4 closure changes

The attention test now aborts and settles both pending waiters and resets mocked timers in `finally`, including assertion failure. After the negative wait abort, a distinct eligible notification wakes a fresh wait with the frozen clock unchanged; an unmocked 10-second watchdog only bounds a broken wake and is cleared in cleanup. Wait-zero and initial positive race assertions remain. The complete attention test file passed again 16/16 on Node24.22.1. MCP test remains as reviewed; no MCP/servers or CI executed by worker.

### R4 refinement review

`finally` now aborts and settles both waiters and resets mocked timers; real watchdog bounds the positive check. One remaining refinement: the positive waiter is followed immediately by event creation, so an initial read can observe the event and pass without proving a parked wait is notified under the mocked clock. Insert the same serialized `store.list` plus `setImmediate` barrier after creating the positive waiter and before the distinct notification. Approval pending this adjustment and root's final focused checks.

R4 follow-up adds a serialized read and real event-loop turn after starting the positive waiter and before creating its event, so the assertion exercises a parked listener wake rather than only the initial read. Full attention test file passed again 16/16 on Node24.22.1; root to repeat final candidate on Linux.

### R4 closure

The final positive check now waits for the serialized initial read and an event-loop turn before creating the eligible event, so it exercises notification of an established waiter under the frozen clock. The prior cleanup and real watchdog remain intact. The worker reports 16/16 attention tests passed; root's prior Mac and Linux focused runs passed 22 tests before this last test-only barrier, and the final Linux rerun remains in progress under observed IO pressure. Both test diffs are approved; the runtime result remains root-owned. R4 report lease released.
