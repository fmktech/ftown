# R2 — CI preview refresh investigation

## Observed failure and scope

Run `41102306295`, merge revision `50a3223170d04acdda2fb1ea9ea55d4bc50a8214`, Chromium on Linux/Node 24.22.1: `session-preview.spec.ts:162` timed out after 15 seconds waiting for `Count: 0` within the preview iframe immediately after clicking its count and then `Refresh preview`. The assertion had already observed revision 2 and `Count: 0` at lines 155–156. The log does not state whether the iframe still contained `Count: 1`, was hidden/absent, or experienced a transport/authority change. No root cause for this individual run can be proven from the log alone.

`git diff 16c233331a5e7520b4a06b6c8422c1b9433a3d76 bd6d4e3 -- ui/src/hooks/useSessionPreview.ts ui/src/components/SessionWorkspace.tsx e2e/tests/session-preview.spec.ts` is empty: the code and test underlying this scenario predate PR 167. The new header component changes the open-preview action, not the refresh control within SessionWorkspace, and the test reached the latter.

## Source-supported hypothesis, not proven CI cause

`useSessionPreview.ts:104–106` creates `pendingManual` inside the poll effect. A click sets it and either starts a poll or queues it (`163`); only a valid unchanged manual response changes the iframe key (`131–134`), causing the `SessionWorkspace.tsx` iframe keyed by `state.key` to remount and reset its script state. A benign authority notification increments `store.epoch` (`90–96`), and effect cleanup/recreation (`165–166`) discards the old effect's pending/manual flag. If notification occurs after a manual request starts but before its response commits, `isActive` rejects the stale response (`108`, `125–126`); the new effect's automatic unchanged poll retains the old iframe key. This exactly predicts a remaining `Count: 1`, but neither notification timing nor iframe state is present in the supplied failure log. Other possibilities, including response failure or a visibility/authority transition, remain open.

## Relationship to PR 169

PR 169, head `17a57f4c2c539d7b2785752b4566e862d601e5d4`, changes the preview hook and keeps `manualRequested`/`manualApplied` in the persistent store. Its `useSessionPreview.test.ts:315–331` explicitly exercises a manual refresh followed by a benign authority notification, verifies the stale result does not apply, then verifies the current result changes the key exactly once. It addresses the source-supported race. Its `direct-transport-e2e` job passed at that head (run `41102968203`), which is useful independent evidence but does not establish that the race caused PR 167's particular failure. PR 169 is a separate open change with wider preview, toolbar and security behavior; do not cherry-pick or broaden this task without an explicit decision.

## Smallest root-run reproduction

After the documented isolated Linux E2E setup and verifying all effective DB/deployment selectors are local, run only:

```sh
cd e2e
npx playwright test tests/session-preview.spec.ts --project=chromium --workers=1
```

Retain failure screenshot, error context, and trace. If it reproduces, check whether the iframe remains present and shows `Count: 1`, and correlate refresh request/response, authority notification, epoch/effect teardown, and iframe key before attributing the cause; transport errors, unavailable/hidden iframe, or lack of notification would falsify this specific hypothesis. A successful isolated run is not proof of absence for an intermittent race. A deterministic hook test reproducing the PR 169 notification sequence against the original implementation can separately establish the code defect, but does not prove the CI timing. Root owns E2E services and execution. No source edits, servers, browser runs or CI reruns performed by R2; report lease released.

## R2 — independent review of W3 CI fixes

Approved. The row filters now use a page-rooted inner locator that Playwright evaluates relative to each candidate row, while retaining the non-Unknown and stable-version assertions for both values. Explicit responsive minimum heights restore the existing lifecycle CSS contract alongside the unchanged fixed icon dimensions. The updated reproduction reads the actual installed-row selector, verifies its known value, retains the broken selector as a negative control, and checks computed minimum and bounding boxes; `visual-smoke.ts` adds the computed-style check for all three icons. Root reports pre-fix failure and post-fix passing results across 1280/900/390/320, plus passing visual smoke, focused tests and typechecks. The harness uses fixtures and does not establish real bridge behavior; root's separate Linux preview reproduction remains in progress. No additional source issue found in this scope. R2 did not execute browsers or services; report lease released.

## CI artifact follow-up

The downloaded failure `error-context.md` shows the iframe still displaying the version 2 heading and `Count: 1` at failure, matching the lost-remount prediction rather than an absent iframe. In `trace.zip`, refresh click `call@1129` starts at monotonic 398960.709 ms and ends at 399017.396 ms; a `GET /api/security/account` begins at 399019.117 ms, lasts 30.001 ms, and returns 200. The account request starts about 1.7 ms after the click action completes (58.4 ms after it begins). This timing and unchanged counter corroborate the proposed race, but the trace does not establish that the account response caused an authority notification, changed the effect epoch, or arrived before a manual preview response; encrypted preview request/response content does not resolve that ordering. Thus the particular CI root cause remains an inference rather than proven. Root's isolated preview run remains pending.

## R2 — W4 narrow contract review

The proposed identity-scoped manual intent is compatible with the existing epoch and authority model, subject to these refinements:

1. Cancel pending intent at every existing fail-closed clear boundary: identity/client/runtime/user/readable/subscriber changes, unobservable security-generation clear, and fingerprint absence/change, including batched loss and recovery. A stale `refreshRef` closure must not enqueue intent after its epoch was invalidated.
2. Preserve current fail-closed content handling and cancel pending intent on error, invalid/unregistered/unavailable responses; generic failed RPCs do not establish whether the cause is an authorization denial. A stale revision should wait for normal bounded polling, not spin on immediate retries.
3. Coalesce requests captured at a poll's start into one remount. A newer click during that poll can queue at most one subsequent poll. Only an active, validated ready-document commit acknowledges captured intent; stale responses cannot consume it.

Tests should cover pending refresh through benign notification, stale responses, ordinary unchanged polls, pending refresh canceled by batched authority loss/recovery, newer click during an in-flight request, and failure behavior. Keep existing verification, read-access checks, network contracts and fail-closed behavior intact. Approved with these refinements; no source or browser work performed by R2.

## R2 — W4 implementation review

Approved conditional on root's runtime gate. The counter pair remains in the preview store and is canceled on existing identity/security clear paths and invalid/error/unavailable outcomes. The epoch fence guards both refresh entry and response commits; valid ready commits consume only the snapshot taken at poll start, leaving newer clicks for one subsequent poll. Stale revisions defer through the normal timer. The tests cover benign notification with stale response, automatic-poll stability, coalescing, batched authority loss/recovery, failed/invalid/unavailable/unregistered cancellation, and bounded stale-revision polling. Existing runtime authorization and fail-closed content behavior are unchanged. Worker reports 21/21 hook tests and UI typecheck passed; no source issue found. The deterministic test proves the isolated race, not the exact timing of the original CI failure. R2 did not execute browser or services; report lease released.
