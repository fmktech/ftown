---
type: investigation
symptom: "intermittent switch-file link drop (e2e :475 fails 1/3)"
slug: switch-file-drop
date: 2026-11-12T01:16:06-03:00
investigator: Foad Kesheh
git_commit: 9af4d26d24cfad512f862b9cbe0539ed9301fe54
branch: feat/preview-markdown-multi
repository: fmktech/ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

# Intermittent switch-file link drop (e2e :475 fails 1/3)

## Symptom
- **Observed**: `e2e/tests/session-preview.spec.ts:559` `toHaveAttribute('aria-selected','true')` on tab `a.html` stayed `'false'` for 15s after markdown link click at `:558`. Link click ~200ms after tab switch to `notes.md`. Parent evidence: `:475` passed 2/3 with `--repeat-each=3`; same click at `:753` passed 3/3; `'marker is not defined'` gone. Failure is `await mdFrame.locator('a[href="a.html"]').click()` succeeded (no throw) but selection never switched.
- **Expected**: Clicking `[View a.html](a.html)` inside sandboxed `notes.md` frame posts `{channel:'ftown-preview-link-v1',kind:'switch-file',fileName:'a.html'}` to the parent, parent selects `a.html`, tab `a.html` becomes `aria-selected='true'`.
- **Delta**: Click on a visible, DOM-ready link in the currently mounted frame results in no selection. The message is either never posted by the child or silently dropped by the parent guard with no error, retry, or UI feedback.

## Reproduction
Cannot run Playwright here (ports owned by runner; do not start stack). Recipe from parent trace (HEAD `9af4d26`):
1. Register `a.html` + `notes.md` via REAL CLI; select session.
2. Click tab `notes.md`; poll `inPreviewFrame` heading (`Notes` + marker) and table cell (`${marker}-cell`) until ok.
3. Click `a[href="a.html"]` inside `iframe[title="Preview: notes.md"]`.
4. Assert tab `a.html` `aria-selected='true'` (15s). Flakes 1/3: stays `'false'`.

Verified: parent observed 1/3 fail at step 4 (this session did not re-run Playwright). Unit-level reproduction of the drop condition is documented under H2 (jsdom test would show drop; gate requires code-edit only after this log).

Message chain read end-to-end (HEAD `9af4d26`):
- Child script `ui/src/lib/session-preview.ts:80-155` (`previewLinkScript`): attaches `document` `click` capture handler in `<head>` (via `previewDocument` at `:210-211` before `<body>`). On trusted left click on `<a>`/`<area>`, parses `href`, and for a relative file link posts `window.parent.postMessage({channel,kind:'switch-file',fileName:base},'*')` at `:149`/`:152`. `files` array embedded at `:109` from `fileNames` passed by `SessionWorkspace.tsx:262-263`.
- Parent listener `ui/src/hooks/usePreviewScroll.ts:66-101` (`receive`): single guard at `:69`, then link branch at `:71-86`, then scroll branch at `:87-98`. `switch-file` forwarded at `:76` via `switchFileRef.current`.
- Selection `ui/src/components/SessionWorkspace.tsx:107-111` (`onSwitchFile`): `files.find(f=>f.fileName===fileName)` else silent return; `handleSelectFile` at `:76-78` sets `internalSelections`; `effectiveFileName` derived at `:56-70`.

Every condition under which a link click on a just-loaded file is ignored (verbatim `file:line`):
- C1 child no handler / no link: `session-preview.ts:120` `if (!link) return` (click not on `<a href>`/`<area href>`); script not yet executed (head script not run) means no listener at all (attach at `:113`).
- C2 child untrusted / non-left: `session-preview.ts:126` `if (!event.isTrusted || button!==0) return` — after `preventDefault` at `:124`, so untrusted clicks are swallowed with no post.
- C3 child hash/absolute/scheme/`//`/empty-base exclusions return without post: `:127` (hash), `:128-134` (absolute http(s) posts `open-link`, not `switch-file`), `:138` (`//`), `:145` (scheme), `:148` (empty base).
- C4 child file not in embedded list: `:149`/` :152` `includes(files,[base])` / decoded check — stale `files` (from `srcDoc` creation render) or mis-parsed base drops silently.
- P1 parent no display: `usePreviewScroll.ts:69` `!current` — `displayRef.current===null` (before first commit, or cleared by effect at `:50` `displayRef.current=null; setDisplay(null)` during `!candidate` loading gap).
- P2 parent epoch stale: `usePreviewScroll.ts:69` `current.hardEpoch!==getHardEpoch()` — `hardEpoch` bumped by `useSessionPreview.ts:47` `clear()` on identity change, or `:99`/`:130`/`:159`/`:175`/`198` on authority/request failure, while `display.hardEpoch` (set at `usePreviewScroll.ts:43` in `commit`) lags.
- P3 parent source stale/foreign: `usePreviewScroll.ts:69` `event.source!==iframeRef.current?.contentWindow` — ref null (no iframe mounted), ref holds previous `contentWindow` (frame replaced by `key={scroll.display.key}` at `SessionWorkspace.tsx:264`), or sender is a foreign window.
- P4 parent origin: `usePreviewScroll.ts:69` `event.origin!=='null'` — sandboxed `srcDoc` opaque origin must serialize as `'null'`.
- P5 parent malformed envelope: `usePreviewScroll.ts:69` `!event.data||typeof!==object||Array.isArray`.
- P6 parent strict parse: `usePreviewScroll.ts:72-73` `parsePreviewLinkMessage` null — `preview-scroll-protocol.ts:47-61` requires exact 3 keys, `fileName` string 1–255 chars, `channel==='ftown-preview-link-v1'`.
- P7 parent file not in current set: `SessionWorkspace.tsx:109` `if (!match) return` — descriptor changed between `srcDoc` creation and click (add/remove/re-register) or stale `files` closure.
- P8 parent link-prompt freeze (open-link only, NOT switch-file): `usePreviewScroll.ts:80` `if (linkPromptRef.current!==null) return` — does not apply to `switch-file`; `switch-file` has no dedupe/promnt gate.
- D0 scroll checks that do NOT apply to switch-file (for contrast): `usePreviewScroll.ts:87` `data.documentId!==current.documentId` gates only `PREVIEW_SCROLL_CHANNEL`; link channel returns at `:76`/`:85` before that. Stale `documentId`, `restored` flag, and snapshot `requestId` cannot drop `switch-file`. Listener attach itself is `usePreviewScroll.ts:100` `window.addEventListener('message',receive)` with deps `[getHardEpoch]` (stable `useCallback` at `useSessionPreview.ts:213`), so no attach gap after mount except initial mount before first effect.

## Hypotheses

#### H1: The child never posts `switch-file` for `href="a.html"` because the link script is not attached, `isTrusted` is false, or `files`/href parsing excludes `a.html`.

- **Layer**: code-logic (child script).
- **Prediction**: If H1 is true, reading `previewLinkScript` will show a condition that excludes a relative `a.html` link with `files=['a.html','notes.md']`, or attaches after the body (so heading-ready does not imply handler-ready). Conversely, if false, `a.html` passes all child checks and the handler is attached before the heading exists.
- **Verification method**: Read `ui/src/lib/session-preview.ts:80-155,210-211`; trace `previewMarkdown` href and `markdownDocument` structure; check attach order (head vs body) and href parsing for `a.html`.
- **Evidence**:
  ```
  session-preview.ts:210-211: previewDocument wraps: `<head>...${previewLinkScript(fileNames)}${...}</head><body>${html}</body>`
  session-preview.ts:113: document.addEventListener('click', event => { ... }, true);
  session-preview.ts:149: if (includes(files,[base])) post switch-file
  helpers/session-preview.ts:178-180: previewMarkdown returns `[View a.html](a.html)` -> marked `<a href="a.html">`
  spec :547-554: heading+table polls pass before click at :558 (body parsed)
  ```
- **Verdict**: REJECTED
- **Rationale**: The script is in `<head>` and executes before `<body>` parsing, so heading-visible (body parsed) implies handler attached. `a.html` is relative, non-hash, non-absolute, non-scheme, non-`//`, base `a.html` is in `files` — all C1–C4 pass. `isTrusted` for Playwright CDP Input clicks is true (same pipeline as passing `:753` click). No child condition explains a silent drop for a DOM-ready link.

#### H2: The parent silently drops a `switch-file` from the still-mounted frame because the single guard at `usePreviewScroll.ts:69` requires `!current` false, `hardEpoch` match, and `source===contentWindow` — all of which fail in the window where `displayRef` has been cleared/updated in an effect but the iframe DOM (and its `contentWindow`) is still the old one (or the new one not yet assigned to `iframeRef`).

- **Layer**: state-data (race / ordering).
- **Prediction**: If H2 is true, a `switch-file` dispatched while `displayRef.current===null` (loading clear) or while `iframeRef.current` still points at the previous frame (commit leads DOM by one render) will be dropped even though the sender frame is still in the DOM and clickable. Conversely, if false, the same dispatch after the transition completes (display committed + ref updated) will be forwarded. Existing test `usePreviewScroll.test.ts:134-151` only covers the steady state (same frame, same epoch) and passes.
- **Verification method**: Read `usePreviewScroll.ts:40-65,66-101` ordering (effect `commit` sets `displayRef` + `setDisplay` at `:43-44`; clear at `:50` sets `displayRef=null` + `setDisplay(null)`; listener uses `displayRef.current` + `iframeRef.current?.contentWindow` at `:68-69`); read `SessionWorkspace.tsx:258-264` (iframe rendered only when filtered `scroll.display` non-null, `key={display.key}`, `ref={scroll.iframeRef}`); inspect that effects run after commit and `setDisplay` schedules the next commit (DOM unmount/remount lags `displayRef` by one render). Confirm scroll-only checks (`documentId` at `:87`) do not gate link, so the only link gates are P1–P3.
- **Evidence**:
  ```
  usePreviewScroll.ts:43-44: const result: Display = { ...next, documentId: uuidv4(), owner: nextOwner, hardEpoch: generation };
    displayRef.current = result; setDisplay(result);
  usePreviewScroll.ts:50: if (!candidate || !owner) { ... displayRef.current = null; ... setDisplay(null); return; }
  usePreviewScroll.ts:69: if (!current || current.hardEpoch !== getHardEpoch() || event.source !== iframeRef.current?.contentWindow || event.origin !== 'null' || ...) return;
  usePreviewScroll.ts:71-76: if (data.channel === PREVIEW_LINK_CHANNEL) { ... if (message.kind === 'switch-file') { switchFileRef.current?.(message.fileName); return; } }
  SessionWorkspace.tsx:264: <iframe ref={scroll.iframeRef} key={scroll.display.key} title={...} sandbox="allow-scripts" srcDoc={srcDoc} />
  usePreviewScroll.test.ts:134-151: 'forwards switch-file messages ...' uses same mocked frame for source+ref, no transition case
  ```
- **Verdict**: PROVEN
- **Rationale**: Code ordering guarantees a window where the iframe element is still in the DOM (React has not yet committed the `setDisplay(null)` unmount, or `setDisplay(new)` remount) but `displayRef`/`hardEpoch` already reflect the new state — any `switch-file` arriving in that window hits P1/P2/P3 and returns silently. A real user (or Playwright at ~200ms after the tab click, i.e. during frame settlement) CAN occupy that window: the frame is painted and clickable (heading poll via `inPreviewFrame` evaluate can pass on the still-attached DOM) while the guard still sees the pre/post-transition `displayRef`. The child-side absence (H1 REJECTED) and the fact that steady-state forwards pass (existing test) force the drop to this guard.

#### H3: The spec clicks before the frame is ready (link script not attached / input not trusted), so no product fix is needed — the spec should wait on a stronger readiness signal.

- **Layer**: observation (test artifact).
- **Prediction**: If H3 is true, heading+table polls can pass while the click handler is absent or the click is untrusted, and waiting for a link-script-ready marker (e.g. scroll `ready` round-trip) would eliminate the flake without a product change. Conversely, if false, heading-ready already implies handler-ready + trusted input, and a readiness wait cannot fix a parent-side drop.
- **Verification method**: Read `previewDocument` attach order (head before body, see H1) and `inPreviewFrame` heading polls at `:547-554`; reason about Playwright `frameLocator.click()` trust (CDP Input.dispatchMouseEvent, same as passing clicks at `:753`, `:159`, etc.).
- **Evidence**:
  ```
  spec :547-554: await expect.poll(() => inPreviewFrame(page, mdName, heading...)).toBe("heading");
              await expect.poll(() => inPreviewFrame(page, mdName, table cell...)).toBe("cell");
  spec :558: await mdFrame.locator('a[href="a.html"]').click();
  session-preview.ts:113 handler in head; body heading after head
  ```
- **Verdict**: REJECTED
- **Rationale**: Heading poll evaluates `body` inside the frame — body exists only after head scripts ran, so handler-ready is already proven. Playwright clicks are trusted (untrusted would also be true for `:753` identical click, which passes). The spec DID wait on real readiness (DOM + handler). A stronger wait cannot resurrect a message the parent already dropped; the drop is downstream (P1–P3).

## 5 Whys
Symptom:  Click on a DOM-ready markdown link in the mounted preview frame produces no selection (aria-selected stays false).
Why 1?    Because the parent `receive` returns early at `usePreviewScroll.ts:69` for that `switch-file` (P1 `!current`, P2 epoch mismatch, or P3 source mismatch) and never calls `switchFileRef.current`.
Why 2?    Because `displayRef`/`hardEpoch` are updated synchronously in effects (`:43-44` commit, `:50` clear) while the iframe DOM (`iframeRef` + `contentWindow`, `SessionWorkspace.tsx:264`) is updated in the next render commit — the guard reads the new lifecycle state against the old DOM for one render window, and also conflates scroll-document lifetime with link intent.
Why 3?    Because the link channel reuses the scroll channel's strict document gate (`current`/`hardEpoch`/`source`/`documentId` machinery) instead of validating only what a selection needs (`origin` + `source` + strict parse + parent file-set check). `switch-file` carries no `documentId` and is idempotent, yet it is gated as if it were a scroll coordinate.
Why 4?    Because the multi-file `switch-file` feature (`858fb72`) was added inside the existing scroll listener (`:71-76`) without decoupling link intent from scroll document lifetime; the coupled guard predates the feature.
Why 5?    Because preview frame lifetime (fetch → commit → remount) and user-intent lifetime (click → postMessage → selection) were never given separate readiness contracts — the parent has no way to say "this frame is mounted and its intent is well-formed" independent of "this document's scroll epoch is current".

## Falsification
- Check performed: absence / adjacent-cause.
- Result: In steady state (same mounted frame, same epoch, source matches), the existing unit test `forwards switch-file messages` at `usePreviewScroll.test.ts:134-151` passes — the guard does NOT drop. The drop requires the transition window (P1/P2/P3 mismatch). Adjacent child-side cause (H1) was rejected by head-before-body + href-parsing evidence; adjacent spec-side cause (H3) was rejected by heading-poll + trusted-click evidence. The transition-window drop is the only remaining condition that is both present in code and consistent with "click succeeded but selection stayed false".
- Conclusion: hypothesis survived. (E2E Playwright re-run was not performed — ports owned — so e2e timing is cited from parent trace, not re-observed here; the code-ordering gap itself is proven by `file:line` ordering above.)

## Root Cause
- Immediate cause: `switch-file` from the currently mounted frame is dropped by the shared guard at `ui/src/hooks/usePreviewScroll.ts:69` (`!current || hardEpoch mismatch || source mismatch`) while `displayRef` and the iframe DOM disagree for one render transition. Evidence: `usePreviewScroll.ts:43-44,50,69,71-76` + `SessionWorkspace.tsx:264`; steady-state passes (`usePreviewScroll.test.ts:134-151`), transition-window dispatch is dropped by the same lines.
- Architectural root: link intent (selection, idempotent, no document binding) is coupled to scroll document lifetime (strict `documentId`/`hardEpoch`/`source` gate) — 5 Whys above.
- Rejected H1: head script runs before body, `a.html` passes all child checks — child posts correctly.
- Rejected H3: heading+table polls already prove DOM + handler ready; Playwright clicks are trusted (identical `:753` click passes) — spec did wait.

## Fix
- File `ui/src/hooks/usePreviewScroll.ts:69` — decouple `switch-file` (and link-intent validation) from scroll-document lifetime: validate `origin` + `source` + strict parse + parent file-set, without requiring `displayRef.current!==null` or `hardEpoch` match for selection. Scroll channel keeps strict `current`/`hardEpoch`/`documentId`/`restored` checks unchanged. This ensures a switch-file from the currently mounted frame (`event.source===iframeRef.current?.contentWindow`, `origin==='null'`) is never dropped due to display/epoch transition lag, while stale/foreign frames (`source` mismatch, wrong `origin`) and malformed messages are still rejected. No CSP/document structural change; no `session-preview.ts` link-script change; no `SessionWorkspace.tsx` change.
- Regression test: `ui/src/hooks/usePreviewScroll.test.ts` — case(s) dispatching `switch-file` from the current frame source during the transition window (display null / hardEpoch bumped between commit and delivery) expecting `onSwitchFile` called. Fails before fix (guard returns early), passes after (source+origin gate forwards). Proven by running the new test against pre-fix code (temporary revert) and post-fix code.
- Justification (not symptom-only): the fix addresses the root coupling (Why 3/5) — selection no longer depends on scroll epoch/readiness — rather than adding a spec wait.

## Resolution
- Diff summary: `ui/src/hooks/usePreviewScroll.ts` — moved `current`/`hardEpoch` check to scroll-only branch; link channel now gated by `origin`/`source`/strict parse only (see `## Fix`). `ui/src/hooks/usePreviewScroll.test.ts` — new `honors switch-file from the mounted frame across display transition...` case. No change to `ui/src/lib/session-preview.ts`, `ui/src/components/SessionWorkspace.tsx`, or `e2e/tests/session-preview.spec.ts` (product verdict, not spec-timing).
- Verification: new test FAILS on pre-fix code (`expected "vi.fn()" to be called 2 times, but got 1 times` at epoch-bump dispatch) and PASSES on fixed code; `ui/src/hooks/usePreviewScroll.test.ts` 10/10 pass. Gates: `cd ui && npx tsc --noEmit` clean; `cd ui && npx vitest run` 114 files / 1851 tests pass; `cd e2e && npx tsc --noEmit` clean. Playwright not run (ports owned). Reproduction recipe from `## Reproduction` no longer drops at the unit level; e2e confirmation remains runner-side.
- Follow-up: sibling-code nits from parent memory (`preparePreviewAdd` 12-limit, dead `selectedFileName`) are out of scope for this task. Why :753 passed vs :558 flaked: sample of 3 each is too small to attribute the difference to a proven timing variable; both clicks take the same parent path and the fix eliminates the drop condition for both.
