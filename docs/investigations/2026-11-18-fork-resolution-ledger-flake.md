---
type: investigation
symptom: "ForkResolution suite fails during fixture setup with invalid_ledger"
slug: fork-resolution-ledger-flake
date: 2026-11-18T11:00:00Z
git_commit: 4c3283e
branch: fix/fork-resolution-ledger-flake
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

## Symptom
Observed in release run 44287088372, release-panel / release:
```
LedgerError: Account ledger could not be verified.
verifyAll ../bridge/src/security/ledger/ledger.ts:471:103
append src/components/ForkResolution.test.tsx:32:40
src/components/ForkResolution.test.tsx:63:16
Test Files 1 failed | 129 passed (130)
```
Expected: valid signed fixture loads and the UI tests execute. Delta: setup rejects genesis before the first transition.

## Scope and ownership
Assigned repair worker owns this report, `ui/src/components/ForkResolution.test.tsx`, and the bridge package manifest/lock version bump in the shared task checkout. Existing ledger contracts remain frozen; no runtime validation changes. No E2E services or shared databases are needed. Acceptance: deterministic failure before repair, passing advancing-clock regression after repair, sibling fixture audit, full UI unit suite, bridge build, PR checks green. Git operations are serialized by this task owner. No other writers dispatched.

## Reproduction
Verified experiment: temporary Vitest setup/config files install a Date.now spy advancing by one millisecond per read, with real cryptography and isolated file execution. These scratch files are removed after recording results.

## Hypotheses
### H1: Separate wall-clock reads make authority.addedAt later than genesis.createdAt.
- Layer: state-data / observation.
- Prediction: an advancing clock reproduces the exact guard failure; a frozen clock passes.
- Verification method: isolated ForkResolution suite with controlled Date.now, real signing.
- Evidence: fixture lines 58–59 call Date.now() - 5000 twice; ledger.ts:471 rejects root.authority.addedAt > root.createdAt.
- Verdict: PROVEN.

### H2: Async cryptography or a verification runtime budget rejects valid signatures under load.
- Layer: dependency / code-logic.
- Prediction: failure occurs at signature verification or a budget check, rather than before either operation.
- Verification method: inspect failed guard and run controlled-clock reproduction with real signing.
- Evidence: `verifyAll` line 471 checks timestamps before key import or signature verification; isolated advancing-clock run fails at exactly `verifyAll ... ledger.ts:471:103`, whereas the frozen-clock run with identical real cryptography passes all 25 tests.
- Verdict: REJECTED.

### H3: Another test file leaks fake timers or module state into this suite.
- Layer: tooling-build.
- Prediction: the failure requires another suite; isolated execution with real timers cannot reproduce it.
- Verification method: isolated file execution with only Date.now controlled.
- Evidence: `npx vitest run src/components/ForkResolution.test.tsx --config vitest.ledger-repro.config.ts` runs one file and fails with `Test Files 1 failed (1)` at the same guard. Setup spies only on Date.now; real timers remain enabled.
- Verdict: REJECTED.

### Controlled reproduction results
Temporary setup registers a beforeAll hook before the suite hook:
```ts
let now = Date.now();
vi.spyOn(Date, "now").mockImplementation(() => now++);
```
Command: `cd ui && npx vitest run src/components/ForkResolution.test.tsx --config vitest.ledger-repro.config.ts`
```
LedgerError: Account ledger could not be verified.
verifyAll ../bridge/src/security/ledger/ledger.ts:471:103
append src/components/ForkResolution.test.tsx:32:40
src/components/ForkResolution.test.tsx:63:16
Test Files 1 failed (1)
Tests 25 skipped (25)
```
Control: same command with `LEDGER_REPRO_FROZEN=1` returns the same captured timestamp on every read:
```
Test Files 1 passed (1)
Tests 25 passed (25)
```

## 5 Whys
1. Setup rejects genesis because authority.addedAt exceeds createdAt.
2. The fixture samples Date.now separately for the two timestamps, with the same offset.
3. It assumes consecutive reads return the same millisecond; scheduling and clock boundaries violate that assumption.
4. Fixture construction encodes one event using independently sampled times rather than one shared event time.
5. Tests did not exercise fixture construction across a clock tick, so a wall-clock-dependent precondition escaped coverage.

## Falsification
Absence test: keep all signing, asynchronous work and data identical but freeze only Date.now. All 25 tests pass. Isolation test: advance only Date.now in a single-suite process, without fake timers or other test files. Exact CI stack reproduced. The conclusion survives both controls.

## Root Cause
The fixture at ForkResolution.test.tsx:58–59 can create authority.addedAt = createdAt + 1. ledger.ts:471 correctly rejects it before crypto verification. The invariant couples these values to one event; independently sampling the wall clock violates it nondeterministically. A controlled advancing-clock fixture regression is missing. H2 rejected by pre-crypto failure and passing same-crypto control; H3 rejected by single-file reproduction.

## Fix
Capture one createdAt value for both genesis fields in a local fixture builder. Test that builder with Date.now advancing on every read, restore the spy in finally, assert the invariant and verify the signed genesis through the real verifier. Do not weaken runtime validation or freeze the whole suite.

## Sibling audit
All occurrences of literal `createdAt: Date.now` and `addedAt: Date.now` in UI, bridge security tests and E2E were inspected. Only ForkResolution samples these coupled genesis fields independently. `ui/src/lib/ledger-auth.test.ts:46–49` uses one captured createdAt. Ledger-client, passkey and bridge ledger tests use shared timestamps or explicit fixed times; standalone authority additions refer to different events and are not the same pattern. Other repeated envelope creation/expiry reads increase the expiry and do not violate genesis ordering.

## Resolution
- Fixture genesis builder now captures one event timestamp and reuses it. Runtime ledger verification is unchanged.
- Permanent regression: `ui/src/components/ForkResolution.test.tsx`, “builds a valid genesis when the clock advances between timestamp reads”. Spy restored in finally before real signing/verification.
- Red proof with original two-read builder (frozen suite setup to isolate the new test): `AssertionError: expected 1794998735695 to be 1794998735694`; 1 failed / 25 passed. Green with shared timestamp, including the original advancing-clock setup: 26 passed.
- Node 24.22.1 (same as failed release): complete UI unit suite, 130 files / 2359 tests passed. Command: `npm exec --yes --package=node@24.22.1 -- node node_modules/vitest/vitest.mjs run` from ui.
- Node 24.22.1: 12 repeated focused suites with three concurrent processes and `--maxWorkers=1`; all 12 exited zero (312 test executions), alongside the full UI suite. No retries used to obtain green.
- Bridge TypeScript build passed; release planning/parity tests: 23 passed. Bridge manifest and lock bumped together from 0.30.39 to 0.30.40 at user request to trigger a fresh release after merge; both registry packages were 0.30.38 when checked.
- Independent parent review: PASS for fixture repair and regression.
- Scratch reproduction files removed. No E2E services, database writes, or background test servers started; this repair changes only test setup and release version metadata. Automatic PR CI provides the repository-wide gates.
