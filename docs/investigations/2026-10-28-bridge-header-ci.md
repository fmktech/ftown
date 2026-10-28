---
type: investigation
symptom: "Desktop bridge header measures 59px, exceeding compact-header threshold"
slug: bridge-header-ci
date: 2026-10-28
git_commit: 678c716123e3b799273428cab50c11d5993553e5
branch: feat/bridge-update-flow
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

# Desktop bridge header CI failure

## Symptom and reproduction

CI run 40702236812, job 122864818824, Ubuntu Chromium, Node 24.22.1, commit above: `tests/session-needs-attention.spec.ts:27` desktop manual attention case, 1280x900. Private receipt `agent-receipts/pr150-e2e-failed.log` lines 2923–2937 states:

```text
Error: expect(received).toBeLessThan(expected)
Expected: < 52
Received:   59
> 156 | expect((await bridgeHeader.boundingBox())!.height).toBeLessThan(52);
```

Root reproduced the untouched exact case on fresh Linux sandbox bx_7affq75a, fresh DB and HOME, Node 24.22.1/npm 11.19.1, at 16:41 UTC: `cd e2e && npx playwright test tests/session-needs-attention.spec.ts --grep "navigate on desktop"`; it failed in 2.1 seconds at line 156 with `Expected: < 52`, `Received: 59`. Isolated log: `/home/user/pr150-repair-evidence/red-desktop-e2e.log`. This investigator did not execute E2E. The existing 11px desktop disclosure font assertion follows the failing line. Mobile case requires header at least 52px, all controls and drag handle at least 44px in each dimension at 390 and 320, and no overflow. `e2e/tests/bridge-updates.spec.ts:6–19` requires the new action control at least 44x44 at 1280 and 390.

## Hypotheses

### H1 — desktop actions target plus existing vertical row padding determines the height

- Layer: layout/code. Prediction: the actions button is 44px high and the expanded row has 7px top and bottom padding and 1px bottom border: 44 + 7 + 7 + 1 = 59px. Reducing only desktop vertical padding to 3px should give 51px while preserving the button size.
- Evidence: `ui/src/components/SessionList.tsx:1403–1413` sets `md:min-h-0`, flex row, inline `padding: "7px 9px"`, and expanded 1px bottom border. Lines 1489–1492 add `min-h-11 min-w-11` including at `md`. The base-to-HEAD diff shows this button was newly added; row padding predates it. Exact predicted 59 equals CI observation.
- Verdict: PROVEN for the failed threshold: the prior real updates E2E measured the desktop action target at least 44px. Combined with unconditional 7px top and bottom and the 1px expanded border, this alone imposes a 59px lower bound; the fresh isolated run independently reproduces exactly 59px. No computed-style counterfactual has been run; final actual geometry remains root’s post-fix verification.

### H2 — the desktop case accidentally uses mobile viewport rules

- Layer: test/configuration. Prediction: the test selects mobile viewport or uses its branch for the failed assertion.
- Evidence: `session-needs-attention.spec.ts:20–31` explicitly selects desktop width 1280 and identifies `isMobile` from the viewport name; line 156 is in the desktop `else`. CI calls the failing test desktop. The mobile-only 52px minimum in `SessionList.tsx:1403` is explicitly reset by `md:min-h-0`.
- Verdict: REJECTED as a mistaken test viewport/branch claim. Computed breakpoint activation remains to be observed in root’s browser probe.

### H3 — update status data or asynchronous state alone causes the height

- Layer: state/data. Prediction: changing version text or its loading state should change the row height without changes in button geometry.
- Evidence: version text (`SessionList.tsx:1486–1487`) is a 10px, truncating, single flex item; action button is independently present when `onOpenUpdates` is provided. The text states vary but the 44px minimum does not. No runtime state manipulation has been performed.
- Verdict: REJECTED as the sole cause: the action target and unconditional padding already impose 59px regardless of this single-line status value; fresh isolated DB/HOME/registry state reproduces it. This does not assert all possible data states were measured.

## Authorized repair and validation

Scope only the bridge row in `ui/src/components/SessionList.tsx`: replace the inline all-sides padding with horizontal-only inline padding and responsive vertical utilities `py-[7px] md:py-[3px]`. Inline `padding` must not remain because it would override utility declarations. Mobile retains its 7px vertical padding; at desktop, 44 + 3 + 3 + 1 = 51px expanded and 50px collapsed. Preserve drag-state borders, 11px font, menu behavior, and every target. No interface changes. Verify root’s existing attention desktop/mobile assertions, update-menu 44px assertions at both widths, and 320px mobile no-overflow. Inspect both expanded and collapsed rows and the desktop visible focus indicator. Confirm actual computed padding, border and control boxes before and after; ensure drag-over top/bottom border states do not create unexpected overflow.

## Falsification and root cause

Adjacent-cause check: independent of version text and asynchronous state, the 44px target plus fixed padding and border imposes a 59px lower bound. A fresh DB/HOME/registry state in isolated Linux reproduced exactly the CI result, which weighs against a CI-only state or stale-data explanation. The 1280px desktop test branch and `md:min-h-0` refute mistaken mobile test selection. No DOM counterfactual measurement was run or claimed. An actual post-fix browser measurement remains required.

1. Why does the header fail? Its expanded desktop height is 59px while the test requires less than 52px.
2. Why 59px? Its 44px action target sits inside 14px vertical padding and a 1px border.
3. Why does desktop carry those 14px? The existing padding was unconditional even though other controls have responsive sizing.
4. Why did the regression appear with updates? The new actions button intentionally retains a 44px minimum at desktop, increasing the row’s content-height floor.
5. Why was this interaction missed? The new updates checks verified target size, while the existing attention check separately enforced compact header height; the initially run focused checks did not combine both invariants.

The bounded cause is incompatible vertical layout requirements across adjacent features; responsive row padding satisfies both without changing the control target or test assertion. Existing attention E2E is the discriminating red regression and root will rerun it together with the update and mobile checks.

## Handoff

Root owns browser/runtime verification. The original isolated E2E reproduction is red; actual post-fix geometry and green E2E evidence remain pending.

## C1 implementation handoff

Changed only `ui/src/components/SessionList.tsx` and this report. Row class now uses `py-[7px] md:py-[3px]`, and inline style uses `paddingInline: 9`; existing min heights, action button, borders, fonts and behavior are unchanged. Node 24.22.1 scoped Vitest run (`BridgeUpdatesMenu.test.tsx`, `session-needs-attention.test.ts`, `session-pull-request.test.ts`) passed 3 files / 25 tests. JSDOM emitted its existing canvas-not-implemented warning. `tsc --noEmit --incremental false` passed. No E2E or runtime executed by this worker. Root must run the untouched desktop/mobile attention and update-menu browser cases and inspect final geometry before marking resolved. Source and report leases released.

## Root validation after repair

2026-10-28T16:46UTC, isolated Boat Linux `bx_7affq75a`, same Node24.22.1 and
local-only fixture selectors. UI production build passed. Unchanged
`npx playwright test tests/session-needs-attention.spec.ts tests/bridge-updates.spec.ts`
passed all5 cases in19.8s, covering original desktop<52px/font11, desktop/mobile
More44x44, mobile320/390 controls/overflow, menu Escape/focus, attention navigation
and explicit app-update notice. Original isolated red was Expected<52 Received59;
no test assertions/retries/timeouts were changed. C1 unit/static25 tests and UI
typecheck passed; V2 independent review accepted. Full CI rerun follows the push.
Root service/DB/browser-trust cleanup completed; private red/green logs, traces and
screenshots retained outside source.

Root inspected the final desktop and320px mobile screenshots: compact desktop rows, readable attention previews/focus ring, preserved mobile controls and no horizontal overflow. No additional source repair requested.
