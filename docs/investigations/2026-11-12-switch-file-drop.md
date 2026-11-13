---
type: investigation
symptom: "intermittent switch-file link drop (e2e :475 fails 1/3)"
slug: switch-file-drop
date: 2026-11-12T01:16:06-03:00
investigator: Foad Kesheh
git_commit: 9c779cc
branch: feat/preview-markdown-multi
repository: fmktech/ftown
status: resolved
hypotheses_formed: 5
hypotheses_rejected: 4
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

Verified: parent observed 1/3 fail at step 4 (this session did not re-run Playwright). The jsdom cases added under de1bd21 mocked `iframeRef.current.contentWindow` as still attached while `candidate` was null; per the Correction below that state is not production-reachable, so it is not a reproduction — see H2 (hypothesis) and H4 (remount count).

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
- **Verdict**: REJECTED (was HYPOTHESIS after the parent-review downgrade; finally rejected by the parent e2e trace — see H5)
- **Rationale**: In isolation `displayRef` and the iframe DOM can disagree for one effect/render window, but the parent review shows P1/P2 with a still-mounted, clickable frame does not follow: `usePreviewScroll.ts:107` returns `display: null` in the SAME render that owner/`hardEpoch` changes, so `SessionWorkspace.tsx:258` renders the loading message and React unmounts the old frame (`key={display.key}` at `:264`) in that commit — before the clearing effect runs and before `iframeRef` detaches. A `postMessage` task therefore cannot be delivered to a mounted frame while `!current` or `hardEpoch` mismatches: every `hardEpoch` bump (`useSessionPreview.ts:47/99/130/159/175/198`) also nulls `complete` and makes `candidate` null in the same task (`redraw()` follows synchronously), and JS message delivery cannot interleave mid-task. The de1bd21 regression test held `iframeRef.current.contentWindow` attached (mocked `Object.defineProperty`) while rendering `candidate: null`; production React detaches the ref on unmount, so that test pins a state the app cannot reach. P2 (epoch lag) is at most one task wide, with no mounted frame inside it. No observed event, e2e trace, or unit run has yet shown a real `switch-file` dropped by this guard; the flake (1/3) is not attributed to H2. **E2E falsification (parent trace, HEAD `9c779cc`):** the failing click posted nothing at all — trusted input went to the embedder `<iframe>` element (target=IFRAME), so the guard at `:69` was never evaluated and no message exists for H2 to have dropped. The retry from the same frame forwarded with `sourceMatch=true`, exactly as the steady-state unit test predicts. The transition-window ordering concern is moot: no `switch-file` is ever delivered in that window because the click never enters the frame.

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

#### H4: After the tab switch the iframe mounts more than once for unchanged content, so the click lands in a first mount that is then replaced (or fails the `event.source` check).

- **Layer**: state-data (remount / key churn).
- **Prediction**: If H4 is true, driving a file switch through the real `useSessionPreview` poll sequence (status/chunk, `loading → ready`, `knownRevision → unchanged` polls) yields more than one distinct `display.key` / iframe DOM mount for the new file whose bytes did not change — caused by a nonce regeneration, a first-poll `ready` (not `unchanged`) for the new revision, a `hardEpoch` bump, or the `SessionWorkspace` selection effect. If false, the new file mounts exactly once.
- **Verification method**: New tests wire `useSessionPreview` + `usePreviewScroll` as `SessionWorkspace.tsx:104-113` does (candidate from `state.kind === 'ready'`, owner from `previewScrollOwnerKey`) with a bridge-faithful `sendCommand` mock (`ready` without matching `knownRevision`, `unchanged` when it matches; per-file digests/revisions), switch file, then advance several 1000 ms polls and count distinct non-null `state.key` / `display.key` values; plus a `SessionWorkspace` tab-switch test that counts distinct iframe DOM nodes via `MutationObserver` across the same polls.
- **Evidence**:
  ```
  useSessionPreview.test.ts: 'mounts the switched file exactly once for unchanged bytes across the real poll sequence (P3)' — distinct state keys for new file: 1; distinct display keys: 1; hardEpoch after switch: stable (no bump).
  SessionWorkspace.test.tsx: 'mounts the switched iframe exactly once for unchanged bytes (P3)' — MutationObserver iframe nodes titled 'Preview: notes.md': 1; 'Preview: a.html': 1; same DOM node survives 3 poll intervals.
  useSessionPreview.ts:164/182 nonce++ only on manual 'unchanged' refresh and on 'ready' completion (once per switch); unchanged polls keep the key.
  ```
- **Verdict**: REJECTED
- **Rationale**: The new file mounts exactly once for unchanged bytes under the real poll sequence. The nonce changes a single time on the switch's `ready` completion; later polls are `unchanged` and keep the key (automatic polls never regenerate it). There is no `hardEpoch` bump in the steady sequence, no second `loading → ready`, and no selection-effect key churn (the `SessionWorkspace` iframe node is stable). P3 remount-then-replace is therefore not the flake mechanism at unit level; it remains the hypothesis the e2e trace must still exclude (see Correction). **E2E confirmation (parent trace):** exactly one frame per switch — `added t=839862`, `loaded t=839880`, no second add — so P3 is out at the browser level too.

#### H5: The click is routed to the embedder `<iframe>` element by Chromium's compositor hit-test lag, so the frame never receives it — a SPEC bug, not a product bug.

- **Layer**: observation (browser input routing / test artifact).
- **Prediction**: If H5 is true, the first click after a file switch is delivered to the embedder element (`<iframe>`) with `trusted=true` and never reaches the sandboxed frame document — no FRAME click, no `switch-file` — while the same click seconds later (after hit-test data settles) is delivered into the frame and switches selection. Conversely, if false, the click would reach the frame on the first attempt.
- **Verification method**: Parent e2e trace with input instrumentation (frame add/load timestamps, mouse/click target, FRAME click presence, parent message source check).
- **Evidence** (parent trace, HEAD `9c779cc`; this session did not re-run Playwright — ports owned):
  ```
  iframe 'Preview: notes.md' added t=839862
  iframe 'Preview: notes.md' loaded t=839880
  test clicks link t=839907 (~45-75ms after insertion)
  parent receives 'mousedown/click trusted=true target=IFRAME' — trusted click delivered to EMBEDDER <iframe> element, never to out-of-process sandboxed frame: no FRAME click, no switch-file
  second click ~15s later (same frame): FRAME click, then PARENT message sourceMatch=true and selection switched
  ```
- **Verdict**: PROVEN
- **Rationale**: The click was trusted (`trusted=true`), so H1/C2 (untrusted) is out, and the handler was attached (heading polls passed), so H3 as written (handler-absent) is out — S2 (the spec-timing shorthand) is rejected in that form. No message was dropped: none was posted, because input never entered the frame — H2's guard was never evaluated (see H2 falsification above). Exactly one frame existed per switch, so H4/P3 remount is out. The second click from the same frame succeeded, proving the child handler + parent guard + selection path all work once input is actually delivered. This is the same hit-test lag documented in `clickOverPreview` (spec `:28-35`), now in the inverse direction (click *into*, not over, the frame). The product is fine; the spec clicks too soon after insertion.

## 5 Whys
**Superseded 2026-11-12 by H5 (proven):** the chain below explains a guard drop (H2). The parent e2e trace proves no message reaches the guard on the failing click (see H5 evidence), so the chain is retained as history and must not be read as the mechanism.
Symptom:  Click on a DOM-ready markdown link in the mounted preview frame produces no selection (aria-selected stays false).
Why 1?    Because the parent `receive` returns early at `usePreviewScroll.ts:69` for that `switch-file` (P1 `!current`, P2 epoch mismatch, or P3 source mismatch) and never calls `switchFileRef.current`.
Why 2?    Because `displayRef`/`hardEpoch` are updated synchronously in effects (`:43-44` commit, `:50` clear) while the iframe DOM (`iframeRef` + `contentWindow`, `SessionWorkspace.tsx:264`) is updated in the next render commit — the guard reads the new lifecycle state against the old DOM for one render window, and also conflates scroll-document lifetime with link intent.
Why 3?    Because the link channel reuses the scroll channel's strict document gate (`current`/`hardEpoch`/`source`/`documentId` machinery) instead of validating only what a selection needs (`origin` + `source` + strict parse + parent file-set check). `switch-file` carries no `documentId` and is idempotent, yet it is gated as if it were a scroll coordinate.
Why 4?    Because the multi-file `switch-file` feature (`858fb72`) was added inside the existing scroll listener (`:71-76`) without decoupling link intent from scroll document lifetime; the coupled guard predates the feature.
Why 5?    Because preview frame lifetime (fetch → commit → remount) and user-intent lifetime (click → postMessage → selection) were never given separate readiness contracts — the parent has no way to say "this frame is mounted and its intent is well-formed" independent of "this document's scroll epoch is current".

## Falsification
- Check performed: absence / adjacent-cause + remount count (Correction).
- Result: In steady state (same mounted frame, same epoch, source matches), the existing unit test `forwards switch-file messages` passes — the guard does NOT drop. Adjacent child-side cause (H1) was rejected by head-before-body + href-parsing evidence; adjacent spec-side cause (H3) was rejected by heading-poll + trusted-click evidence; remount cause (H4) was rejected by the mount-count tests (exactly one mount). No unit or e2e observation yet shows a real `switch-file` dropped by the H2 guard; the transition-window drop exists only as a code-reading candidate with a production-reachability gap (mounted frame vs. `displayRef`/`hardEpoch` ordering per H2 rationale).
- Conclusion (H5): the parent e2e trace is the falsifier and it resolved the case. The failing click posted nothing (trusted input to the embedder element, no FRAME click, no `switch-file`); the retry from the same frame forwarded with `sourceMatch=true`; exactly one frame existed per switch. H2 (drop-in-guard) is falsified — no message was ever dropped; H4/P3 (remount) is falsified — one frame per switch; H3/S2 as written (handler-absent/untrusted) is falsified — `trusted=true` with heading polls green. The cause is hit-test routing lag (H5, PROVEN). This session did not re-run Playwright; the trace lines are parent-observed and pasted verbatim in H5.

## Root Cause
- PROVEN (H5): the failing click never reached the sandboxed frame. Chromium's compositor hit-test data lags a just-inserted iframe by ~75ms: the trusted click is delivered to the embedder `<iframe>` element, so the child's link handler never fires and no `switch-file` is posted. The parent guard is never evaluated — nothing is dropped by the product. This is a SPEC bug (click issued too soon after insertion), not a product bug. The same lag is documented in `clickOverPreview` (spec `:28-35`) in the inverse direction.
- Architectural note (retained, not a root): link intent shares the scroll listener's guard — 5 Whys above (superseded; see note there). Decoupling was already reverted and stays reverted (see Fix).
- Rejected H1: head script runs before body, `a.html` passes all child checks — child posts correctly (proved by the successful retry from the same frame).
- Rejected H2: no message was dropped — the failing click posted nothing; the guard was never evaluated. The retry forwarded with `sourceMatch=true`.
- Rejected H3/S2 (spec-timing as written — handler-absent/untrusted): heading+table polls already prove DOM + handler ready and the click was `trusted=true`. The qualified spec-timing cause is H5 (routing, not readiness/trust).
- Rejected H4/P3 (remount): exactly one frame per switch in the e2e trace (`added t=839862` / `loaded t=839880`, no second add), plus unit mount-count tests (count 1).

## Fix
- de1bd21 (decoupling link channel from display/epoch guard) REVERTED: `ui/src/hooks/usePreviewScroll.ts` is byte-identical to pre-de1bd21; the single guard (`!current || hardEpoch mismatch || source mismatch || origin !== 'null'`) covers both channels. Reason: the mount count is exactly 1 (no remount fix needed) and the decoupled tests pinned production-unreachable states (mocked `iframeRef` held attached across `candidate: null` / epoch bump without render). Decoupling would not fix a P3 replace-drop anyway — the source check still rejects the replaced frame — and would have honored selection/prompt after a revocation bump while the frame was still in the DOM.
- No change to `ui/src/hooks/useSessionPreview.ts` (key stable: `nonce` only on manual refresh and on each `ready` completion, exactly once per switch) and no change to `ui/src/components/SessionWorkspace.tsx`.
- No product change for H5: the product path (child post → parent forward → selection) is proved correct by the successful retry from the same frame.
- Spec fix (this session, uncommitted): new `clickPreviewLinkAndExpectSelected(page, fromFileName, linkHref, toFileName)` helper in `e2e/helpers/session-preview.ts` wraps the in-frame link click + tab `aria-selected` assertion in `expect(...).toPass({ timeout: 15_000 })` with a 1000 ms inner assertion, so a hit-test-lagged first click simply retries until input lands. It replaces the identical click+assert pairs at `e2e/tests/session-preview.spec.ts` `:558-559` (`notes.md` → `a.html`) and `:753-754` (weird name → `a.html`). Retrying is safe: selecting the already-selected file is a value-wise no-op in `SessionWorkspace` (same `effectiveFileName`/identity/iframe key — see Resolution). No other frame clicks are after-switch switch-file clicks (see Resolution); `:529-:535` and all other assertions are kept.
- Tests kept: mount-count cases (P3, count 1) + link-channel strictness cases (wrong origin for `switch-file`/`open-link`; foreign source for `open-link`, with positive controls). The unreachable `honors switch-file... across display transition` case was deleted.
- Justification: no production-reachable drop is fixed by decoupling and no product path is broken by H5; keeping the guard strict and fixing the spec's click timing is the smallest change consistent with evidence.

## Resolution
- Diff summary (uncommitted, for parent review): revert of `ui/src/hooks/usePreviewScroll.ts` to pre-de1bd21; `ui/src/hooks/usePreviewScroll.test.ts` — deleted unreachable transition case, added two strictness cases; `ui/src/hooks/useSessionPreview.test.ts` — added P3 mount-count case (1 distinct `display.key`); `ui/src/components/SessionWorkspace.test.tsx` — added P3 iframe-node case (1 node); this log corrected. No stack/Playwright run (ports owned); do NOT commit; e2e confirmation is runner-side per Correction.
- Verification: P3 mount tests pass with count exactly 1 (see H4); full gates re-run after the revert (results below). Playwright not run.
- Follow-up: sibling-code nits from parent memory (`preparePreviewAdd` 12-limit, dead `selectedFileName`) are out of scope for this task. Why :753 passed vs :558 flaked: sample of 3 each is too small to attribute the difference to a proven timing variable; both clicks take the same parent path.
- Resolution update (H5, this session): replaced the two after-switch click+assert pairs (`:558-559`, `:753-754`) with `clickPreviewLinkAndExpectSelected`; no product file changed. No-op-on-reselect verified by code reading: `SessionWorkspace.tsx:76-78` (`handleSelectFile`) with derivation at `:54-70`, sync guard at `:89-90`, iframe key at `:264`, and `useSessionPreview.ts:39` (identity) / `:210` (effect deps) — same file ⇒ same identity string ⇒ no `clear()`, no nonce bump, same `display.key`, no remount (one redundant render from new object identity only). Frame-click inventory from grep (`documentFrame`/`mdFrame` clicks at `:159, :188, :207, :213, :303, :312, :365, :800` plus `:558, :753` — `:558`/`:753`/`:800` are pre-edit numbers for the replaced sites): only `:558` and `:753` are after-switch `switch-file` clicks (`a[href="a.html"]` with a tab assertion); the others target counter/external/hash/long links in a single stable file and carry no tab assertion. `:529-:535` and all other assertions kept.

## Correction (2026-11-12, parent review response)

- (a) The original "PROVEN" verdict rested on code reading only (no e2e re-run, no observed drop) — downgraded to HYPOTHESIS above; status `resolved` → `reopened`.
- (b) P1: with `iframe key={scroll.display.key}` (`SessionWorkspace.tsx:264`, key = identity+revision+nonce at `useSessionPreview.ts:182`) and `display: null` returned in the same render on owner/epoch change (`usePreviewScroll.ts:107`), the old frame unmounts in that commit before the clearing effect (`:50`) and `iframeRef` detaches — so a loading gap has no mounted clickable frame. P1 with a mounted frame cannot occur as written.
- (c) P2: epoch lag is one task wide (bump + `redraw()` in the same task; message tasks cannot interleave mid-task), with no mounted frame inside it.
- (d) P3 (leading suspect): after the tab switch the iframe mounts exactly once for unchanged bytes (H4, count 1 at unit level; causes: single nonce increment on the switch's `ready` completion, `loading → ready` commits once via the owner-change immediate path, first poll returning `ready` for the new revision exactly once, no `hardEpoch` bump in the steady sequence, no selection-effect churn). Clicking the visible frame therefore has a single stable `event.source`.
- Decision: REVERT de1bd21 (see Fix); keep only reachable-state tests; no stable-key fix needed since the count is 1.
- What the parent e2e `--repeat-each=20` run will prove: the true flake rate and mechanism at the browser level. If the flake persists with a single iframe load and only the current frame's `source` ever posting, H2/H4 are both excluded and the cause lies in click delivery/timing (child handler or Playwright input), not in parent lifecycle or remounts. If the flake disappears, the 1/3 rate was small-sample noise and no product change was needed.

## E2E trace signal that distinguishes the hypotheses

Instrument the spec (or a manual run) to log, per tab-switch within 500 ms: (i) iframe `load` event count and distinct `key`/`srcDoc` values for `notes.md`; (ii) every parent `message` event with `channel`, `origin`, and whether `event.source` equals the current `iframe.contentWindow` at delivery time vs. a detached node; (iii) guard outcome (forwarded / dropped-by-guard / never posted).

- Decoupled-link (H2) prediction: exactly one iframe load, the click's message arrives FROM the current mounted frame's window and is dropped by the guard (source would match post-decoupling). If the trace instead shows the dropped message coming from a replaced/detached window (or no message at all), H2 is disproven.
- P3 remount prediction: two or more iframe loads (or key changes) within the first ~500 ms after the tab switch, with the click's `source` equal to the FIRST mount's window while the parent listens on the SECOND. A single load + current-source drop supports H2; multiple loads + stale-source drop supports P3 (and only then is a stable-key fix indicated — decoupling would not help, since the source check correctly rejects the stale frame).
- Result (parent trace): neither prediction fired — there is no message at all on the failing click (input to the embedder element, no FRAME click), and exactly one frame per switch. The trace instead proves H5 (hit-test routing lag); see H5 evidence.

## Verification (corrected run)

- Reverted tree (this correction): `cd ui && npx tsc --noEmit` clean (exit 0); `cd ui && npx vitest run` 114 files / 1854 tests pass; `cd e2e && npx tsc --noEmit` clean (exit 0). Owned files: `usePreviewScroll.test.ts` 11 tests, `useSessionPreview.test.ts` 40 tests, `SessionWorkspace.test.tsx` 34 tests (85 total across the three, all green). No stack/Playwright run. Previous "114 files / 1851 tests pass" described the pre-revert tree.
- H5 spec-retry tree (this session): `cd e2e && npx tsc --noEmit` clean; `cd ui && npx tsc --noEmit` clean (verify untouched). No stack/Playwright run — runtime UNVERIFIED.
