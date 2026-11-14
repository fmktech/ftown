---
type: investigation
symptom: "e2e shard 3/3: session-preview real-CLI test fails with 'locator.evaluate: Target page, context or browser has been closed' at previewScrollY poll"
slug: preview-scroll-target-closed
date: 2026-11-14T17:40:00-03:00
investigator: Foad Kesheh
git_commit: 3ace9c4a251f14144f8315bf71303b9b090c8838
branch: feat/require-green-pr
repository: fmktech/ftown
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-11-14-ci-sandbox-removed-mid-run.md
---

# Preview scroll poll throws on Chromium target-closed wording

## Symptom
- **Observed**: CI run 43620664355 job 132525391359 (`direct-transport-e2e (3/3)`), one failure:
  `tests/session-preview.spec.ts:61:1 › real CLI preview is encrypted, interactive, revision-consistent and isolated across sessions` —
  `Error: locator.evaluate: Target page, context or browser has been closed` at `e2e/helpers/session-preview.ts:41` via `previewScrollY` (`session-preview.spec.ts:372`).
- **Expected**: after `atomicHtml(path, previewHtml(marker, 2, true))` (spec:371) reloads the preview iframe, the `expect.poll(() => previewScrollY(...)).toBeLessThan(600)` retries until the new document answers.
- **Delta**: the poll throws on first contact with the swapping frame instead of returning the not-ready sentinel.

## Reproduction
CI-only so far: 1 failure in run 43620664355 (head 3ace9c4); the same test passed in the 8bf442d rollup (2026-11-14T17:17Z fyi) and in shards 1/3+2/3 of the same run. Race-dependent: the evaluate must land while the iframe document is being replaced.

## Hypotheses

#### H1: `PREVIEW_FRAME_NOT_READY` misses Chromium's "Target page, context or browser has been closed" wording, so a frame-swap race throws instead of retrying
- **Layer**: observation (test harness)
- **Prediction**: the verbatim CI error will not match any pattern in `e2e/helpers/session-preview.ts:18-25`, while `page.isClosed()` is false (failure screenshot exists, taken after the error).
- **Verification method**: read helper source; compare with verbatim log line; inspect failure screenshot/artefacts.
- **Evidence**:
  ```
  Error: locator.evaluate: Target page, context or browser has been closed
      at inPreviewFrame (/home/runner/work/ftown/ftown/e2e/helpers/session-preview.ts:41:44)
      at previewScrollY (/home/runner/work/ftown/ftown/e2e/tests/session-preview.spec.ts:15:58)
  ```
  Helper patterns: `/Frame was detached/i, /frame got detached/i, /Execution context was destroyed/i, /Cannot find context with specified id/i, /Element is not attached to the DOM/i, /Target closed/i` — none matches `Target page, context or browser has been closed` (`/Target closed/` requires adjacency). Trace: locator resolved to visible `<body>` at t=182044ms, error at t=182071ms (frame replaced in between, right after the spec:371 file update). Failure screenshot shows the dashboard alive (bridges connected), so the page itself was not closed.
- **Verdict**: PROVEN
- **Rationale**: the helper's own contract (comment, lines 13-32) is exactly this race; the one unlisted Chromium wording escapes it and fails the poll deterministically whenever the race is lost.

#### H2: Product bug closes the preview/session on file update (this branch's preview-dismissal or #226 solo changes)
- **Layer**: code-logic
- **Prediction**: if the product closed the preview, the iframe/session would be gone in the failure screenshot and the earlier identical update+poll at spec:351/354 would fail the same way every run.
- **Evidence**: screenshot shows dashboard with bridges connected and sessions listed; spec:353-356 assertions (new heading, focus) passed before the failing poll in the same run; the failing evaluate is inside the documented iframe-swap window.
- **Verdict**: REJECTED
- **Rationale**: no product-side closure is visible; the failure mode is the harness throwing during a by-design iframe reload.

#### H3: Hosted runners are slower, widening the race (environment)
- **Layer**: config-env
- **Prediction**: failures correlate with runner change only via timing, with the same H1 signature.
- **Evidence**: test passed on Boat-era head 8bf442d; first hosted-runner head shows the H1 wording escape. Timing may widen the window but cannot throw by itself — the throw requires the missing pattern.
- **Verdict**: REJECTED (as root cause; plausible contributing timing factor)
- **Rationale**: environment explains frequency, not the failure mechanism.

## 5 Whys
Symptom: preview scroll poll fails the shard intermittently.
Why 1? The poll's evaluate throws "Target page, context or browser has been closed" during the iframe reload instead of returning not-ready.
Why 2? `PREVIEW_FRAME_NOT_READY` enumerates Chromium wordings and this variant is absent.
Why 3? The allowlist is maintained by hand against evolving Playwright/Chromium error strings, with no test pinning the mapping.
Why 4? The race only manifests when the evaluate lands in the reload window, so the gap stayed latent until runner timing shifted.
Why 5? Test-harness error classification is string-enumeration-based rather than keyed on the structural condition (frame gone, page alive) it actually means.

## Falsification
- Check performed: adjacent-cause + absence. If H1 were wrong and the page had truly closed, `page.isClosed()` would be true and no failure screenshot/DOM snapshot could be captured; artefacts contain both, and the trace shows the body locator resolving 27ms before the throw. H2's predicted product closure is absent from screenshot and preceding assertions. Hypothesis survived.

## Root Cause
- Immediate cause: `inPreviewFrame` rethrows Chromium's `Target page, context or browser has been closed` during a preview iframe swap because `PREVIEW_FRAME_NOT_READY` (`e2e/helpers/session-preview.ts:18-25`) does not match that wording.
- Architectural root: hand-enumerated error-string allowlist for a structural condition (frame replaced while page alive).
- Rejected H2: no product closure in screenshot/assertions. Rejected H3: timing affects frequency only.

## Fix
- File `e2e/helpers/session-preview.ts` — add `/Target page, context or browser has been closed/i` to `PREVIEW_FRAME_NOT_READY` so the existing poll retries (explicit synchronisation via `expect.poll`, no sleeps).
- Verification: re-run e2e on CI for the new head; the previously failing shard must pass, plus one repeat dispatch for stability.

## Resolution
- Pending CI verification on the fix head.
