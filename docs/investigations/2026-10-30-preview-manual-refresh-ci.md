---
type: investigation
symptom: "CI session-preview manual refresh does not return Count: 0 after reload"
slug: preview-manual-refresh-ci
date: 2026-10-30T15:16:08-03:00
investigator: Foad Kesheh
git_commit: bd6d4e3ed63f5e8e31d5502b90cbd581d6b2d710
branch: fix/update-dialog-layout
repository: fmktech/ftown
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

# Preview manual refresh CI failure

## Symptom
CI run 41102306295, `session-preview.spec.ts:162`, reports:
```
Locator: locator('iframe[title="HTML preview: preview.html"]').contentFrame().getByRole('button', { name: 'Count: 0', exact: true })
Expected: visible
Timeout: 15000ms
Error: element(s) not found
```
Expected manual refresh reloads unchanged preview and resets iframe state to `Count: 0`. CI observed absent expected content; this alone does not establish exact cause. Root is reproducing the old revision in isolated Linux service-backed E2E separately.

## Reproduction
Test-only regression in `ui/src/hooks/useSessionPreview.test.ts` uses existing stable fixture and same-fingerprint security notification. Sequence: initial ready key K, start manual refresh, notify same authority, resolve stale manual response (must be ignored), resolve new epoch unchanged response (must remount), perform ordinary unchanged poll (must preserve remounted key). Run `cd ui && npm test -- src/hooks/useSessionPreview.test.ts -t 'retains manual refresh across a benign authority notification'` under Node 24.22.1 before product edits. Observed exit 1 (1 failed, 13 skipped):
```
AssertionError: expected '["bridge","one","12345678-1234-4234-8…' not to be '["bridge","one","12345678-1234-4234-8…'
  at useSessionPreview.test.ts:153:29
  expect(refreshed.key).not.toBe(initial.key);
```
The preceding assertions passed: old response retained K and verifying true; new response committed ready but kept K.

## Hypotheses

#### H1: A benign authority epoch restart discards in-flight manual intent stored in effect-local state.
- **Layer**: code-logic
- **Prediction**: old response is ignored, new response succeeds unchanged, but key remains K despite a requested refresh.
- **Verification**: isolated test above and source tracing effect cleanup/creation.
- **Evidence**: Test fails exactly at `expect(refreshed.key).not.toBe(initial.key)` after stale reply was ignored and new unchanged response committed. `useSessionPreview.ts` declares `pendingManual` inside the effect and clears it at poll start, before response; the authority notification increments epoch and recreates that effect.
- **Verdict**: PROVEN for the isolated race.
- **Rationale**: The new valid response uses a recreated effect with no manual intent and preserves K.

#### H2: The old epoch response is incorrectly applied and consumes the refresh.
- **Layer**: concurrency/state
- **Prediction**: resolving the old pending response changes the verified status or key before current epoch responds.
- **Verification**: assert old response leaves key K and `verifying: true` before resolving new.
- **Evidence**: Before failing later, the test successfully asserted `key: initial.key, verifying: true` after resolving old reply.
- **Verdict**: REJECTED.
- **Rationale**: The old reply had no observable effect; epoch fence works.

#### H3: The test failure arises solely from preview HTML content changing, rather than refresh/identity behavior.
- **Layer**: data/integration
- **Prediction**: with a constant verified revision and HTML, the failure cannot occur.
- **Verification**: use stable fixture with fixed digest, HTML and unchanged status for both responses.
- **Evidence**: The failing test uses one fixed HTML, digest and unchanged response for both epochs.
- **Verdict**: REJECTED as necessary cause of isolated failure.
- **Rationale**: Race occurs with unchanged content. CI E2E causality remains separately unproven until root reproduction.

## Why chain
1. A requested manual refresh leaves the iframe key unchanged after a benign authority notification.
2. The pending manual flag was cleared before the old status response committed; the old epoch is then invalidated.
3. The replacement effect creates a fresh local flag, so its unchanged response is treated as an automatic poll.
4. Manual intent is owned by effect lifetime rather than by the preview identity and a successfully validated response.
5. Existing tests exercised manual refresh and authority restarts separately, leaving their interaction uncovered.

## Falsification
Old-epoch reply was resolved deliberately and the test proved it did not commit (key K, `verifying: true`), ruling out H2. The same fixture retains identical content and digest, ruling out H3 as necessary. The existing test `keeps the document key on unchanged polls, remounts on manual refresh, and pauses while hidden` shows manual remount without intervening restart; together these isolate the lost intent at effect lifetime. This confirms an observable race but does not by itself assert the full CI preview failure had this cause.

## Repair contract
After root-authorized R2-reviewed brief, persist requested/applied intent across benign epoch restarts; acknowledge only a valid active ready commit. Cancel intent on identity/client/user/read/authority changes and errors/unavailable/unregistered, coalesce concurrent requests, stale-revision uses bounded poll. Preserve authorization and fail-closed behavior. Add isolated race, cancellation and coalescing coverage and run full hook tests/typecheck. Root owns service-backed reproduction and post-fix browser validation.

## Implementation and validation

`useSessionPreview.ts` stores requested/applied manual counters in identity-scoped state, captures the current request on poll start, acknowledges only active validated ready commits, and retains requests through benign epochs. Fail-closed clears, invalid/error/unregistered/unavailable responses cancel queued intent; stale revision waits for the normal timer. `refreshRef` checks active epoch, and later clicks during a poll coalesce into one later poll. No public API, authorization or content-retention contract changed.

Regression failed pre-fix as above and now passes. Full `cd ui && npm test -- src/hooks/useSessionPreview.test.ts` passed 21/21; `cd ui && npm exec --no -- tsc --noEmit --incremental false` passed, Node 24.22.1. New coverage verifies benign restart, stale old reply, unchanged subsequent poll, multiple clicks coalescing, batched authority loss/recovery, failed/invalid/unregistered/unavailable cancellation and bounded stale-revision retry. Existing authorization loss tests pass. No browser, server, E2E, CI or Git execution by worker. Root must verify actual service-backed symptom; independent closure pending. Investigation remains `root-cause-proven` for isolated race until root verifies resolution.
