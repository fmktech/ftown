---
type: investigation
symptom: "On an iPhone (Safari), the user cannot select and copy text from the session terminal in the dashboard"
slug: mobile-terminal-cannot-copy-selection
date: 2026-11-01T17:41:11-03:00
investigator: Foad Kesheh
git_commit: 67efb45
branch: fix/mobile-terminal-clipboard
repository: fmktech/ftown
status: resolved
hypotheses_formed: 4
hypotheses_rejected: 3
hypotheses_proven: 1
related:
  - docs/investigations/2026-11-01-mobile-terminal-paste-uses-host-clipboard.md
---

# On iPhone Safari, text in the session terminal cannot be selected and copied

Scope: the **copy** half of the report. Paste is investigated separately (see `related`).

## Symptom

User report (verbatim): "on mobile I cant copy a selection, I also thibk paste goes on the hostint machinr paste instead pasting ehat is in the client side".
Clarifications relayed by the coordinator: the device is an **iPhone with Safari (iOS WebKit)**. The "workspace menu" remark only meant that the mobile Workspace tab shows a Stop button. The copy problem is in the session terminal itself. "BH" was a typo.

- **Observed**: on the phone, the user cannot select terminal text and get it onto the phone's clipboard.
- **Expected**: the same thing a desktop user can do (mouse-drag a selection, then Cmd/Ctrl+C) should be possible by touch: select text in the terminal, copy it, and paste it into another iOS app.
- **Delta**: on desktop, a mouse drag creates an xterm selection and the browser `copy` event puts it on the clipboard. On touch, no gesture creates a selection and no copy command is reachable, so nothing is ever written to the clipboard.

Scope note (Workspace tab, now out of scope): I checked it before the clarification arrived. The mobile "Workspace" tab (`Dashboard.tsx:953-958`) shows the session list, the session context menu (`SessionList.tsx:394-431`: Open pull request, Rename, Clone, Hide/Unhide, Stop, Remove) and `SessionHeaderActions.tsx:10-20` (Open preview, Stop, Relaunch). None of these has a copy action, so the Workspace angle was dropped.

## Environment facts

- `@xterm/xterm` **6.0.0** (`ui/node_modules/@xterm/xterm/package.json:4`), with addons fit, unicode11 and web-links only (`ui/package.json:24-27`). There is no clipboard addon (`grep -c addon-clipboard ui/package.json` → `0`).
- Renderer: **DOM** (xterm 6 dropped the canvas renderer, and no WebGL addon is loaded):
  ```
  node_modules/@xterm/xterm/src/browser/CoreBrowserTerminal.ts
  583:  private _createRenderer(): IRenderer {
  584-    return this._instantiationService.createInstance(DomRenderer, this, this._document!, this.element!, this.screenElement!, this._viewportElement!, this._helperContainer!, this.linkifier!);
  $ grep -rn "WebglAddon\|addon-webgl\|addon-canvas" src package.json; echo "exit=$?"
  exit=1
  ```
- There is one terminal component (`ui/src/components/Terminal.tsx`), used on both desktop and mobile. On touch devices the only extra UI is `MobileControlBar` (`ui/src/components/MobileControlBar.tsx`), shown under `@media (pointer: coarse)` (`ui/src/app/globals.css:377-385`). There is no read-only or preview terminal view.
- The bridge runs every session inside tmux with `set -g mouse off` (`bridge/src/tmux.ts:74`) and does not set `set-clipboard`.

## Reproduction

There is no device in the loop. This is a deterministic jsdom reproduction that runs the real xterm 6.0.0 build and the real `Terminal.tsx` and `MobileControlBar.tsx`. The test file lives **outside the repo**, at `<scratchpad>/repro-mobile-copy/mobile-copy.repro.test.tsx`, run through a private vitest config that roots at `ui/`. The full source is in the Appendix.

1. Build a touch-device environment: `window.ontouchstart = null` is the same detection `Terminal.tsx:266` uses. Add polyfills for `matchMedia` and `ResizeObserver`.
2. jsdom has no layout, so pin xterm's mouse→cell mapping to an 8×16 grid (same formula as `src/browser/input/Mouse.ts:44-53`) and give the render canvas a height.
3. Write `hello mobile copy\r\n` into the terminal.
4. Send the gesture as a **mouse drag** (desktop) and as a **touch press-and-drag** (phone), then dispatch a `copy` event. Also send a **tap**: touchstart, touchend, then the compat mousemove/mousedown/mouseup/click that WebKit emits for a tap.
5. Run:
   ```
   unset FTOWN_DATA_DIR FTOWN_SESSION_ID FTOWN_BRIDGE_POINTER FTOWN_HOOK_PORT FTOWN_HOOK_TOKEN
   cd <worktree>/ui && npx vitest run --config <scratchpad>/repro-mobile-copy/vitest.repro.config.ts --reporter=verbose
   ```
   Output, verified 2026-11-01 17:40 -03:00. The symptom reproduces on demand:
   ```
   [desktop] hasSelection=true selection="hello" setData=[["text/plain","hello"]] defaultPrevented=true navigator.clipboard=undefined
   [touch-drag bare] hasSelection=false selection="" setData.calls=0 defaultPrevented=false
   [tap bare] hasSelection=false selection=""
   [ftown touch] container touch-action="none" touchmove.defaultPrevented=true textarea readonly="true" inputmode="none" hasSelection=false copy.setData.calls=0
   [ftown mouse] hasSelection=true selection="hello" setData=[["text/plain","hello"]]
   [counterfactual touch->mouse] hasSelection=true selection="hello" setData=[["text/plain","hello"]]
   [osc52] navigator.clipboard.writeText calls=0
   [MobileControlBar] buttons=["Show keyboard","ESC","Control C","Shift Tab","Up arrow","Down arrow","Enter","Paste clipboard into terminal","PgUp","PgDn","Left arrow","Right arrow"]
    Test Files  1 passed (1)
         Tests  7 passed (7)
   ```
   The tests assert the *current* (buggy) behaviour, so "passed" means the symptom reproduced.

Limitation: jsdom cannot emulate WebKit's gesture recognizers. The repro encodes which mouse events WebKit emits for each gesture: a **tap** emits mousemove/mousedown/mouseup/click at one point, while **pan** and **touch-and-hold** emit no mouse events. That mapping comes from Apple's Safari Web Content Guide ("Handling Events → One-finger events") and the W3C Touch Events spec ("Interaction with Mouse Events": compat mouse events are dispatched for a *tap*). I could not fetch either page in this session (web tools unavailable), so they are cited as references, not pasted. Everything after the browser boundary is proven from source and test output.

## Hypotheses

#### H1: No touch path creates a selection that a copy can act on. xterm's selection is mouse-only, iOS's native selection is disabled by xterm's CSS, and ftown provides no substitute, so xterm's only copy code never has text to copy

- **Layer**: dependency / integration (xterm.js input model × WebKit touch semantics × the missing ftown affordance)
- **Prediction**: if H1 is true:
  - xterm source registers no touch or pointer listeners;
  - selection starts only on `mousedown` and grows only on document `mousemove`;
  - a touch drag leaves `term.hasSelection() === false`, and so does a tap, because its compat events fire at a single point;
  - a later `copy` event writes nothing;
  - the rendered rows are `-webkit-user-select: none`, so iOS cannot start a native selection;
  - no ftown control writes terminal text to the clipboard.

  If H1 is false, a touch gesture yields a selection, or some other code path copies terminal text.
- **Verification method**: read the xterm 6.0.0 source and CSS, grep, run the jsdom repro, and enumerate the mobile controls.
- **Evidence**:
  ```
  $ grep -rnE "touchstart|touchmove|touchend|pointerdown|pointermove|TouchEvent" node_modules/@xterm/xterm/src/browser node_modules/@xterm/xterm/src/common | grep -v "\.test\.ts"
  node_modules/@xterm/xterm/src/browser/Types.ts:106:  handleTouchStart(ev: TouchEvent): void;
  node_modules/@xterm/xterm/src/browser/Types.ts:107:  handleTouchMove(ev: TouchEvent): boolean;
  $ grep -rn "handleTouchStart\|handleTouchMove" node_modules/@xterm/xterm/src | grep -v "browser/Types.ts"; echo "exit=$?"
  exit=1          # stale interface members, nothing implements them
  ```
  (The only other `touch` code in the package is the vendored VS Code scrollbar, `src/vs/base/browser/touch.ts`, which handles scroll gestures, not selection.)
  ```
  node_modules/@xterm/xterm/src/browser/CoreBrowserTerminal.ts
  544:    this._register(addDisposableListener(this.element, 'mousedown', (e: MouseEvent) => this._selectionService!.handleMouseDown(e)));

  node_modules/@xterm/xterm/src/browser/services/SelectionService.ts
  449:  public handleMouseDown(event: MouseEvent): void {
  ...
  480:    } else {
  481:      if (event.detail === 1) {
  482:        this._handleSingleClick(event);
  ...
  490:    this._addMouseDownListeners();
  ...
  500:      this._screenElement.ownerDocument.addEventListener('mousemove', this._mouseMoveListener);
  501:      this._screenElement.ownerDocument.addEventListener('mouseup', this._mouseUpListener);

  191:  public get hasSelection(): boolean {
  ...
  197:    return start[0] !== end[0] || start[1] !== end[1];     # a tap (start == end) is no selection
  ```
  The only copy code is xterm's, and it bails out without a selection:
  ```
  CoreBrowserTerminal.ts
  334:    this._register(addDisposableListener(this.element!, 'copy', (event: ClipboardEvent) => {
  335:      // If mouse events are active it means the selection manager is disabled and
  336:      // copy should be handled by the host program.
  337:      if (!this.hasSelection()) {
  338:        return;
  339:      }
  340:      copyHandler(event, this._selectionService!);
  341:    }));
  ```
  iOS native long-press selection is disabled on every rendered row. The one `user-select: text` layer, the accessibility tree, ignores touches and exists only in `screenReaderMode`, which defaults to false (`OptionsService.ts:38`):
  ```
  node_modules/@xterm/xterm/css/xterm.css
  38: .xterm {
  39:     cursor: text;
  40:     position: relative;
  41:     user-select: none;
  42:     -ms-user-select: none;
  43:     -webkit-user-select: none;
  44: }
  139: .xterm .xterm-accessibility:not(.debug),
  140: .xterm .xterm-message {
  ...
  148:     pointer-events: none;
  155: .xterm .xterm-accessibility-tree {
  156:   font-family: monospace;
  157:   user-select: text;
  ```
  iOS Safari does not fire `contextmenu` on long-press, so xterm's right-click "put selection in the textarea" path (`CoreBrowserTerminal.ts:355-357` → `Clipboard.ts:83-93`) never runs on iPhone. It would copy `selectionText`, which is empty anyway.

  ftown provides no substitute. No terminal code writes the clipboard, and the touch bar has no Copy control:
  ```
  $ grep -rnE "clipboard|execCommand|getSelection|registerOscHandler" src/components/Terminal.tsx src/hooks/useTerminal.ts src/components/MobileControlBar.tsx
  src/components/MobileControlBar.tsx:112:        if (!navigator.clipboard?.readText) {
  src/components/MobileControlBar.tsx:115:        const text = await navigator.clipboard.readText();
  src/components/MobileControlBar.tsx:189:                aria-label="Paste clipboard into terminal"
  src/components/MobileControlBar.tsx:190:                title={pasteError || "Paste clipboard into terminal"}
  [MobileControlBar] buttons=["Show keyboard","ESC","Control C","Shift Tab","Up arrow","Down arrow","Enter","Paste clipboard into terminal","PgUp","PgDn","Left arrow","Right arrow"]
  ```
  Repro output:
  ```
  [touch-drag bare] hasSelection=false selection="" setData.calls=0 defaultPrevented=false
  [tap bare] hasSelection=false selection=""
  [ftown touch] ... hasSelection=false copy.setData.calls=0
  [desktop] hasSelection=true selection="hello" setData=[["text/plain","hello"]] defaultPrevented=true
  ```
- **Verdict**: PROVEN
- **Rationale**: every predicted observation occurs. Touch never produces a selection, the browser cannot produce one either because of `-webkit-user-select: none`, the copy handler needs a selection, and no other copy path exists. The same component copies correctly when given mouse input. The hypothesis also survives the falsification below.

#### H2: ftown's own touch handlers in `Terminal.tsx` suppress the iOS long-press selection that would otherwise let the user copy

These handlers are `touch-action: none` on the container, a non-passive `touchmove` that calls `preventDefault()`, and the tap that focuses the hidden input.

- **Layer**: code-logic (ftown UI)
- **Prediction**: if H2 is true, the bug disappears without these handlers: a bare xterm with the same options and addons, and no ftown handlers, would let a touch gesture select text.
- **Verification method**: read `Terminal.tsx`. In the repro, run the same touch gesture on (a) the real `<Terminal>` and (b) a bare xterm without any ftown handlers.
- **Evidence**:
  The handlers do exist and do cancel the native gesture:
  ```
  ui/src/components/Terminal.tsx
  294:    const onTouchMove = (e: TouchEvent) => {
  295:      if (touchStartY === null) return;
  296:      e.preventDefault();
  323:    container.addEventListener("touchstart", onTouchStart, { passive: true });
  324:    container.addEventListener("touchmove", onTouchMove, { passive: false });
  512:        onClick={() => { if (!didScrollRef.current) onMobileTapRef.current?.(); }}
  517:          style={{ position: "absolute", inset: 0, touchAction: "none" }}
  [ftown touch] container touch-action="none" touchmove.defaultPrevented=true textarea readonly="true" inputmode="none" hasSelection=false copy.setData.calls=0
  ```
  Counterexample: remove all of them and the bug persists:
  ```
  [touch-drag bare] hasSelection=false selection="" setData.calls=0 defaultPrevented=false
  [tap bare] hasSelection=false selection=""
  ```
  Native selection is disabled by xterm's own CSS (`xterm.css:38-44`, above), not by ftown code:
  ```
  $ grep -rn "touch-callout\|touchCallout\|TouchCallout" node_modules/@xterm/xterm/css/xterm.css src; echo "touch-callout hits exit=$?"
  touch-callout hits exit=1      # nobody sets -webkit-touch-callout:none either
  ```
- **Verdict**: REJECTED
- **Rationale**: with the supposed cause absent (bare xterm), the bug still happens. These handlers only matter for the fix: a select surface must not sit inside the `touchmove`/`onClick` subtree, or `preventDefault()` and focus-on-tap would fight native selection.

#### H3: Copy fails because of WebKit clipboard rules: an insecure context, or `writeText` outside a user gesture

The insecure-context case is e.g. Solo mode at `http://<LAN-IP>`, where `navigator.clipboard` is undefined. The gesture rule is that WebKit rejects `writeText` called outside a gesture.

- **Layer**: config-env
- **Prediction**: if H3 is true, the terminal's copy path calls `navigator.clipboard.writeText`, and it throws or rejects, and only on the phone. Desktop over the same origin, or a path not using `navigator.clipboard`, would succeed.
- **Verification method**: grep the terminal code for clipboard writes. In the repro, run the desktop copy path with `navigator.clipboard` removed.
- **Evidence**:
  ```
  $ grep -rnE "clipboard|execCommand|getSelection|registerOscHandler" src/components/Terminal.tsx src/hooks/useTerminal.ts src/components/MobileControlBar.tsx
  (only MobileControlBar.tsx:112-190 — readText for Paste; no writeText anywhere)
  [desktop] hasSelection=true selection="hello" setData=[["text/plain","hello"]] defaultPrevented=true navigator.clipboard=undefined
  ```
  `copyHandler` uses `ClipboardEvent.clipboardData.setData` (`Clipboard.ts:32-38`), which needs neither a secure context nor the async Clipboard API.
- **Verdict**: REJECTED
- **Rationale**: no terminal code calls `navigator.clipboard.writeText`, so these rules cannot be the failing step. The existing copy path works with `navigator.clipboard` undefined. The failure happens earlier: there is never a selection. These rules still **constrain the fix** (see Fix).

#### H4: The user relies on the TUI's own copy (Claude Code `/copy`, OSC 52) and the dashboard drops OSC 52

- **Layer**: dependency / integration (xterm core, tmux)
- **Prediction**: if this is the cause of "can't copy a selection", desktop copy would fail the same way, because the OSC 52 handling is identical on desktop and mobile.
- **Verification method**: list the OSC handlers in xterm core, grep ftown for an OSC 52 handler, write OSC 52 into the real `<Terminal>` with a `writeText` spy, and check tmux's `set-clipboard` default on an isolated socket.
- **Evidence**:
  ```
  node_modules/@xterm/xterm/src/common/InputHandler.ts registers OSC 0,1,2,4,8,10,11,12,104,110,111,112 — no 52.
  $ grep -rn "registerOscHandler\|addon-clipboard\|ClipboardAddon" ui/src ui/package.json; echo "exit=$?"
  exit=1
  [osc52] navigator.clipboard.writeText calls=0
  $ tmux -L ftown-copy-investigation-$$ -f /dev/null start-server \; show-options -s set-clipboard \; show-options -g mouse \; kill-server
  set-clipboard external
  mouse off
  $ man tmux | col -b   (tmux 3.6a)
       If set to on, tmux will both accept the escape sequence to create
       a buffer and attempt to set the terminal clipboard.  If set to
       external, tmux will attempt to set the terminal clipboard but
       ignore attempts by applications to set tmux buffers.
  ```
  Counterexample: `[desktop] ... setData=[["text/plain","hello"]]`. Desktop selection copy works while OSC 52 is dropped in exactly the same way.
- **Verdict**: REJECTED (as the cause of the reported symptom)
- **Rationale**: the cause is present on desktop, yet the bug does not appear there. OSC 52 is a real, separate gap: the UI drops it, and tmux's default `external` ignores application OSC 52 anyway. It is recorded as an optional follow-up in the Fix.

## 5 Whys

```
Symptom:  On iPhone Safari the user cannot copy selected text from the session terminal.
Why 1?    No selection ever exists on touch and no copy command is reachable:
          a touch drag leaves term.hasSelection() === false, so xterm's `copy` listener returns early
          (CoreBrowserTerminal.ts:337), and the touch bar has no Copy control.
Why 2?    Three things together:
          - xterm.js 6.0.0 builds selections only from mousedown + document mousemove/mouseup
            (SelectionService.ts:449-501) and has no touch or pointer listeners;
          - WebKit emits compat mouse events only for taps;
          - iOS's own long-press selection is disabled because every row sits under
            `.xterm { -webkit-user-select: none }` (xterm.css:38-44), and the only selectable layer
            (the a11y tree) is pointer-events:none and off by default.
Why 3?    ftown's terminal relies entirely on xterm's desktop copy model (mouse selection plus a keyboard
          or context-menu `copy` event). Every mobile change so far handled getting input INTO the PTY
          and scrolling. None added a way to get text OUT on touch. The changes were:
          - touch-action:none (d8a57e8),
          - readonly/inputmode=none textarea (5e292db, 9a1d16d, 9d7c552),
          - MobileControlBar keys,
          - Paste (ea726ec).
Why 4?    Mobile terminal UX grew from reactive input-bug fixes, with no mobile capability checklist covering
          the clipboard in both directions. No unit or e2e test checks that a touch user can copy terminal
          text: grep finds no terminal selection or clipboard test in ui/src or e2e/tests. So the gap never
          surfaced.
Why 5?    Architectural root: the terminal is an emulator-rendered surface, not native selectable text,
          and it re-renders constantly: DomRenderer.renderRows replaces row children on every render
          (DomRenderer.ts:456), cursorBlink is on. Touch-first copy therefore needs an explicit app-level
          "export terminal text" surface: a snapshot as native selectable text plus a gesture-bound
          clipboard write. The product has no such abstraction and delegates copy implicitly to xterm's
          desktop-only model.
```

## Falsification

- **Counterfactual edit (scratch only, not product code)**: supply the missing link. I translated the touch drag into the mousedown/mousemove/mouseup events SelectionService needs, on the *same* touch-configured `<Terminal>` (touch-action none, `touchmove` preventDefault, readonly textarea all still active):
  ```
  [counterfactual touch->mouse] hasSelection=true selection="hello" setData=[["text/plain","hello"]]
  ```
  Removing the cause removes the symptom, even with all of ftown's touch handlers still in place.
- **Isolation / absence**: with the bare xterm and no ftown handlers, the bug persists (`[touch-drag bare] hasSelection=false`). The failure follows xterm's mouse-only selection plus the missing substitute, not ftown's handlers.
- **Control**: in the same component, mouse input works with `navigator.clipboard` undefined (`[ftown mouse]`, `[desktop]`). The clipboard write itself is not the failing step.
- **Adjacent causes considered**:
  - (a) An application enabling mouse tracking would also disable SelectionService (`CoreBrowserTerminal.ts:546-548`). But tmux runs with `mouse off` (`tmux.ts:74`), SelectionService was enabled in the repro, and touch still failed. Mouse mode is irrelevant to H1.
  - (b) `-webkit-touch-callout: none` hiding the iOS Copy callout: it is set nowhere (`touch-callout hits exit=1`).
- **Conclusion**: H1 survived.

## Root Cause

- **Immediate cause**: on touch, the terminal never holds a selection, and no copy action exists. The evidence:
  - xterm 6.0.0 selection is mouse-only: `CoreBrowserTerminal.ts:544`, `SelectionService.ts:449-501`, and no touch or pointer listeners per the grep;
  - iOS native selection is disabled by `xterm.css:38-44`;
  - the copy listener requires a selection (`CoreBrowserTerminal.ts:334-341`);
  - ftown has no terminal clipboard write and no Copy control (grep, plus the `[MobileControlBar]` button list).
- **Architectural root**: copy is delegated to xterm's desktop-only model. There is no app-level "terminal text export" surface for touch, and the constantly re-rendered DOM rows make selecting in place fragile.
- **Rejected H2**: the bare xterm without ftown's touch handlers still yields `hasSelection=false`. Native selection is blocked by xterm.css, not ftown.
- **Rejected H3**: no terminal code calls `navigator.clipboard.writeText`, and xterm's copy path works with `navigator.clipboard` undefined.
- **Rejected H4**: desktop copy works despite the identical OSC 52 drop, so OSC 52 is a separate gap.

## Fix (proposal only, not applied)

### UX (iOS Safari first, works the same on Android Chrome)

1. **"Select" button** in `MobileControlBar` row 2, next to Paste. Its aria-label is "Select and copy terminal text". It blurs the hidden input so the keyboard drops away.
2. Tapping it opens a **"Copy terminal text" sheet** over the terminal pane, with role `dialog`. It shows a **frozen snapshot** of the buffer (scrollback plus viewport, last ~2000 logical lines), scrolled to the current viewport. The text is a native, selectable `<pre>`, styled `user-select: text; -webkit-user-select: text; -webkit-touch-callout: default; touch-action: pan-x pan-y; white-space: pre; overflow: auto; font: 13px monospace`.
   - iOS long-press then gives native word selection with handles and the loupe, and the system callout's **Copy**. That works even in an insecure context (Solo over `http://LAN-IP`), because it is the OS doing the copy.
   - The snapshot is frozen so xterm's re-renders cannot wipe the selection (`DomRenderer.ts:456`, cursor blink). A "Refresh" button re-snapshots.
3. Header buttons: **Copy selection** (enabled when the document selection is inside the sheet), **Copy all**, and **Done**. The clipboard write follows WebKit's rules:
   - Call `navigator.clipboard.writeText(text)` **synchronously inside the `click` handler**, with no `await` before it. WebKit rejects the call once transient activation is lost.
   - Track the last non-empty in-sheet selection on `selectionchange`, and `preventDefault` the button's `mousedown`. A tap on the button can collapse the iOS selection before `click` fires.
   - Fallback when `navigator.clipboard` is missing (insecure context) or the call rejects: `document.execCommand('copy')` in the same gesture, against the real DOM selection in the sheet. For "Copy all", first select the `<pre>` via `Range.selectNodeContents`.
   - Last resort: leave the text selected and show "Text selected — tap Copy in the menu".
   - Reuse or extract the existing fallback pattern at `Dashboard.tsx:891-901`.
4. **Optional follow-up**: OSC 52. Add `term.parser.registerOscHandler(52, …)` to decode the base64 UTF-8 payload.
   - Desktop: write it immediately.
   - iOS: the write arrives outside a gesture and would be rejected, so show a toast, "Claude copied text — Tap to copy". Its button calls `writeText` synchronously, or opens the sheet prefilled.
   - This needs `set -s set-clipboard on` in `bridge/src/tmux.ts:68-86`, because tmux's default `external` ignores application OSC 52.

### Code plan (files)

| File | Change | Traces to |
|---|---|---|
| `ui/src/lib/terminal-text.ts` (new) | `readTerminalText(buffer, { maxLines })`: walks `buffer.active`, joins `isWrapped` continuations into logical lines (`translateToString(true)`), trims trailing blank lines, caps the line count, and returns `{ text, viewportLine }`. | Why 5: a text-export surface |
| `ui/src/lib/copy-text.ts` (new) | `copyText(text, selectionRoot?)`: sync `writeText` → `execCommand('copy')` fallback, returns which method worked. Documents the "no await before writeText" rule. | H3 constraints |
| `ui/src/components/TerminalCopySheet.tsx` (new) | The sheet above: selectable `<pre>`, Copy selection / Copy all / Refresh / Done, focus trap, Escape closes. | Why 1/2: a selection and a copy command on touch |
| `ui/src/components/Terminal.tsx` | Add `openCopySheet()` to `TerminalHandle`. Render the sheet as a **sibling of the xterm wrapper div at :508**, not inside it (its `onClick` → `onMobileTap` at :512 would focus the hidden input) and not inside `containerRef` (its `touchmove` preventDefault at :294-296/:324 would block handle drags). | H2 interaction |
| `ui/src/components/MobileControlBar.tsx` | New `onSelectText` prop and a "Select" button in row 2. **The paste investigation also touches this file, so it needs a single owner.** | Why 1 |
| `ui/src/components/Dashboard.tsx:1142` | Pass `onSelectText={() => terminalRef.current?.openCopySheet()}`. | wiring |
| `bridge/src/tmux.ts:68-86` (follow-up) | `set -s set-clipboard on` for OSC 52. | H4 follow-up |

### Regression tests (fail before, pass after)

- `ui/src/components/TerminalCopySheet.test.tsx` (jsdom, touch-emulated via `window.ontouchstart = null`). Render `<Terminal>` and `<MobileControlBar>` wired as in `Dashboard.tsx`, with a fake `TerminalTransportApi` whose `subscribeTerminal` captures handlers and feeds `onScreen("hello mobile copy\r\n")`. Then:
  1. click "Select and copy terminal text" → `getByRole("dialog", { name: "Copy terminal text" })` contains `hello mobile copy`. The `<pre>` has `user-select`/`-webkit-user-select: text` and is not a descendant of `.xterm` or of the `touch-action:none` container. **Fails today**: no such button, matching the repro's `[MobileControlBar]` list.
  2. select "hello" with a `Range`, then click "Copy selection" → `navigator.clipboard.writeText` is called with `"hello"` **synchronously**, i.e. asserted right after `fireEvent.click` with no `await`.
  3. with `navigator.clipboard` undefined (Solo/http) → `document.execCommand` is called with `"copy"`.
- `ui/src/lib/terminal-text.test.ts`: wrapped lines are joined, trailing blanks trimmed, cap respected, using a real xterm in jsdom.
- Promote the repro's desktop control into `ui/src/components/Terminal.test.tsx`: mouse drag + `copy` event → `clipboardData.setData("text/plain","hello")`. Add a touch-scroll test: swipe → `scrollLines`, and for opencode → `\x1b\x19`/`\x1b\x05`. These guard the behaviour below.

### Existing behaviour that must not regress

- Desktop: mouse drag, double-click (word) and triple-click (line) selection, Cmd/Ctrl+C via xterm's `copyHandler`, and right-click copy (`rightClickHandler`). Do **not** add a touch→mouse shim that also fires on mouse input.
- Touch swipe scrolling (`Terminal.tsx:284-316`), including opencode's PTY scroll keys, and the wheel override (`:327-350`). The sheet suspends these simply by sitting outside the container.
- `touch-action: none`, which stops the page scrolling when touching the terminal (d8a57e8). The readonly / `inputmode=none` xterm textarea, an IME fix (`:264-269`). Tap → focus the hidden input (`onMobileTap`).
- MobileControlBar buttons must not steal focus (`onMouseDown` preventDefault). Paste is the other investigation's scope.
- WebLinks taps open URLs (`:246-248`).

## Appendix: throwaway reproduction (outside the repo, recorded verbatim)

`<scratchpad>/repro-mobile-copy/` holds two files: `vitest.repro.config.ts` (a vitest config rooted at `ui/` that includes only this file) and `node_modules` (a symlink to `ui/node_modules`). The scratchpad path is `/private/tmp/claude-501/-Users-fkesheh-projects-ftown/c1622140-6baf-4d8c-87c6-1193f081a22d/scratchpad`.

### vitest.repro.config.ts

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

const UI = "/private/tmp/claude-501/-Users-fkesheh-projects-ftown/c1622140-6baf-4d8c-87c6-1193f081a22d/scratchpad/wt-mobile-clipboard/ui";

export default defineConfig({
  root: UI,
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    dir: __dirname,
    include: ["*.repro.test.tsx"],
    environment: "jsdom",
  },
  resolve: {
    alias: {
      "@": path.resolve(UI, "./src"),
    },
  },
});
```

### mobile-copy.repro.test.tsx

```tsx
// Throwaway reproduction for docs/investigations/2026-11-01-mobile-terminal-cannot-copy-selection.md
// Lives OUTSIDE the repo. Run with:
//   cd <wt>/ui && npx vitest run --config <scratch>/repro-mobile-copy/vitest.repro.config.ts --reporter=verbose
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { cleanup, render } from "@testing-library/react";

// Capture every xterm instance (including the one Terminal.tsx creates) so the
// test can read its selection state. Behaviour of the class is unchanged.
const captured = vi.hoisted(() => ({ instances: [] as unknown[] }));
vi.mock("@xterm/xterm", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@xterm/xterm")>();
  class CapturedTerminal extends mod.Terminal {
    constructor(...args: ConstructorParameters<typeof mod.Terminal>) {
      super(...args);
      captured.instances.push(this);
    }
  }
  return { ...mod, Terminal: CapturedTerminal };
});

import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";

const CELL_W = 8;
const CELL_H = 16;
const TEXT = "hello mobile copy";

beforeAll(() => {
  // jsdom gaps that xterm 6 open() touches.
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false, media: q, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {} unobserve() {} disconnect() {}
    };
  }
  // Emulate a touch device the way Terminal.tsx detects one ("ontouchstart" in window).
  (window as unknown as { ontouchstart: null }).ontouchstart = null;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

type Core = {
  _mouseService: { getCoords: (...a: unknown[]) => [number, number] | undefined };
  _renderService: { dimensions: { css: { canvas: { height: number } } } };
  screenElement: HTMLElement;
};

/** jsdom has no layout, so pin xterm's mouse→cell mapping to an 8x16 grid
 *  (same formula as xterm src/browser/input/Mouse.ts getCoords) and give the
 *  canvas a real height so SelectionService._getMouseEventScrollAmount does not
 *  treat every drag as "below the viewport" (which would extend to end of line). */
function pinCellGrid(term: XTerm): Core {
  const core = (term as unknown as { _core: Core })._core;
  core._renderService.dimensions.css.canvas.height = term.rows * CELL_H;
  core._mouseService.getCoords = (ev: unknown, _el: unknown, cols: unknown, rows: unknown, isSelection: unknown) => {
    const e = ev as { clientX: number; clientY: number };
    const x = Math.ceil((e.clientX + (isSelection ? CELL_W / 2 : 0)) / CELL_W);
    const y = Math.ceil(e.clientY / CELL_H);
    return [
      Math.min(Math.max(x, 1), (cols as number) + (isSelection ? 1 : 0)),
      Math.min(Math.max(y, 1), rows as number),
    ];
  };
  return core;
}

function touch(target: EventTarget, type: "touchstart" | "touchmove" | "touchend", x: number, y: number): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const t = { identifier: 0, clientX: x, clientY: y, target };
  Object.defineProperty(ev, "touches", { value: type === "touchend" ? [] : [t] });
  Object.defineProperty(ev, "changedTouches", { value: [t] });
  target.dispatchEvent(ev);
  return ev;
}

function mouse(target: EventTarget, type: string, x: number, y: number, detail = 1): MouseEvent {
  const ev = new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y,
    button: 0, buttons: type === "mouseup" || type === "click" ? 0 : 1, detail,
  });
  target.dispatchEvent(ev);
  return ev;
}

function copy(target: EventTarget): { ev: Event; setData: ReturnType<typeof vi.fn> } {
  const setData = vi.fn();
  const ev = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: { setData, getData: () => "" } });
  target.dispatchEvent(ev);
  return { ev, setData };
}

/** Same options/addons Terminal.tsx uses, minus the ftown touch/wheel handlers. */
async function bareXterm(): Promise<{ term: XTerm; core: Core }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const term = new XTerm({ scrollback: 10000, allowProposedApi: true, fontSize: 13 });
  term.loadAddon(new FitAddon());
  term.loadAddon(new Unicode11Addon());
  term.loadAddon(new WebLinksAddon());
  term.open(host);
  const core = pinCellGrid(term);
  await new Promise<void>((r) => term.write(`${TEXT}\r\n`, r));
  return { term, core };
}

describe("desktop control: mouse drag + copy event", () => {
  it("creates an xterm selection and xterm's copy handler writes it to clipboardData (navigator.clipboard absent)", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }); // insecure-context shape
    const { term, core } = await bareXterm();
    mouse(core.screenElement, "mousedown", 1, 8);
    mouse(document, "mousemove", 20, 8);
    mouse(document, "mousemove", 40, 8);
    mouse(document, "mouseup", 40, 8);
    const { ev, setData } = copy(term.textarea!);
    console.log("[desktop] hasSelection=%s selection=%j setData=%j defaultPrevented=%s navigator.clipboard=%s",
      term.hasSelection(), term.getSelection(), setData.mock.calls, ev.defaultPrevented, String(navigator.clipboard));
    expect(term.hasSelection()).toBe(true);
    expect(term.getSelection()).toBe("hello");
    expect(setData).toHaveBeenCalledWith("text/plain", "hello");
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe("mobile: the same gesture by touch (bare xterm, no ftown handlers)", () => {
  it("press-and-drag (touch events only, no compat mouse events) creates no selection; copy is a no-op", async () => {
    const { term, core } = await bareXterm();
    touch(core.screenElement, "touchstart", 1, 8);
    touch(core.screenElement, "touchmove", 20, 8);
    touch(core.screenElement, "touchmove", 40, 8);
    touch(core.screenElement, "touchend", 40, 8);
    const { ev, setData } = copy(term.textarea!);
    console.log("[touch-drag bare] hasSelection=%s selection=%j setData.calls=%d defaultPrevented=%s",
      term.hasSelection(), term.getSelection(), setData.mock.calls.length, ev.defaultPrevented);
    expect(term.hasSelection()).toBe(false);
    expect(setData).not.toHaveBeenCalled();
  });

  it("tap (touch + the tap-only compat mousemove/mousedown/mouseup/click at one point) creates no selection", async () => {
    const { term, core } = await bareXterm();
    touch(core.screenElement, "touchstart", 40, 8);
    touch(core.screenElement, "touchend", 40, 8);
    mouse(core.screenElement, "mousemove", 40, 8);
    mouse(core.screenElement, "mousedown", 40, 8);
    mouse(document, "mouseup", 40, 8);
    mouse(core.screenElement, "click", 40, 8);
    console.log("[tap bare] hasSelection=%s selection=%j", term.hasSelection(), term.getSelection());
    expect(term.hasSelection()).toBe(false);
  });
});

describe("ftown <Terminal> on a touch device", () => {
  it("cancels touchmove, makes xterm's textarea read-only, and a touch drag still yields no copyable selection; a mouse drag in the same component does", async () => {
    const { Terminal } = await import("@/components/Terminal");
    const ref = createRef<import("@/components/Terminal").TerminalHandle>();
    const { container } = render(
      <Terminal ref={ref} transport={null} sessionId="s1" bridgeId="b1" isRunning shellType="claude" />,
    );
    const term = captured.instances.at(-1) as XTerm;
    const core = pinCellGrid(term);
    await new Promise<void>((r) => term.write(`${TEXT}\r\n`, r));
    const scan = container.querySelector(".scanlines") as HTMLElement;
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    touch(core.screenElement, "touchstart", 1, 8);
    const move = touch(core.screenElement, "touchmove", 40, 8);
    touch(core.screenElement, "touchend", 40, 8);
    const touchCopy = copy(textarea);
    console.log("[ftown touch] container touch-action=%j touchmove.defaultPrevented=%s textarea readonly=%j inputmode=%j hasSelection=%s copy.setData.calls=%d",
      scan.style.touchAction, move.defaultPrevented, textarea.getAttribute("readonly"), textarea.getAttribute("inputmode"),
      term.hasSelection(), touchCopy.setData.mock.calls.length);
    expect(scan.style.touchAction).toBe("none");
    expect(move.defaultPrevented).toBe(true);
    expect(textarea.getAttribute("readonly")).toBe("true");
    expect(term.hasSelection()).toBe(false);
    expect(touchCopy.setData).not.toHaveBeenCalled();

    // Same component, mouse input: the desktop path works.
    mouse(core.screenElement, "mousedown", 1, 8);
    mouse(document, "mousemove", 40, 8);
    mouse(document, "mouseup", 40, 8);
    const mouseCopy = copy(textarea);
    console.log("[ftown mouse] hasSelection=%s selection=%j setData=%j", term.hasSelection(), term.getSelection(), mouseCopy.setData.mock.calls);
    expect(mouseCopy.setData).toHaveBeenCalledWith("text/plain", "hello");
  });

  it("COUNTERFACTUAL: supply the missing link (touch drag -> the mouse events SelectionService needs) and copy works on the same touch-configured component", async () => {
    const { Terminal } = await import("@/components/Terminal");
    render(<Terminal transport={null} sessionId="s1" bridgeId="b1" isRunning shellType="claude" />);
    const term = captured.instances.at(-1) as XTerm;
    const core = pinCellGrid(term);
    await new Promise<void>((r) => term.write(`${TEXT}\r\n`, r));
    // Throwaway shim, NOT product code: what a touch "select mode" would do.
    const el = core.screenElement;
    const toMouse = (type: string) => (e: Event) => {
      const t = (e as unknown as { changedTouches: { clientX: number; clientY: number }[] }).changedTouches[0];
      mouse(type === "mousedown" ? el : document, type, t.clientX, t.clientY);
    };
    el.addEventListener("touchstart", toMouse("mousedown"));
    el.addEventListener("touchmove", toMouse("mousemove"));
    el.addEventListener("touchend", toMouse("mouseup"));
    touch(el, "touchstart", 1, 8);
    touch(el, "touchmove", 20, 8);
    touch(el, "touchmove", 40, 8);
    touch(el, "touchend", 40, 8);
    const { setData } = copy(term.textarea!);
    console.log("[counterfactual touch->mouse] hasSelection=%s selection=%j setData=%j", term.hasSelection(), term.getSelection(), setData.mock.calls);
    expect(term.getSelection()).toBe("hello");
    expect(setData).toHaveBeenCalledWith("text/plain", "hello");
  });

  it("OSC 52 (what Claude Code /copy emits) never reaches navigator.clipboard", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { Terminal } = await import("@/components/Terminal");
    render(<Terminal transport={null} sessionId="s1" bridgeId="b1" isRunning shellType="claude" />);
    const term = captured.instances.at(-1) as XTerm;
    await new Promise<void>((r) => term.write("\x1b]52;c;aGVsbG8gZnJvbSBvc2M1Mg==\x07", r));
    console.log("[osc52] navigator.clipboard.writeText calls=%d", writeText.mock.calls.length);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("MobileControlBar", () => {
  it("offers no Copy control (only Paste and keys)", async () => {
    const { MobileControlBar } = await import("@/components/MobileControlBar");
    const { container } = render(<MobileControlBar onSendInput={() => {}} />);
    const labels = [...container.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent);
    console.log("[MobileControlBar] buttons=%j", labels);
    expect(labels.some((l) => /copy/i.test(l ?? ""))).toBe(false);
  });
});
```

## Resolution

- Fix level: the selection model is in xterm 6 (vendor). It builds selections only from mouse events, which iOS never sends for touch. We mitigate at our boundary: on mobile, a "Select" button shows the terminal text as ordinary selectable text, where iOS's own long-press selection and Copy work. No change to xterm.
- Changes from the proposed fix: the helper is named `terminalBufferText` (not `readTerminalText`), and the handle method is `TerminalHandle.getText()` (no `openCopySheet()`; Dashboard opens the sheet). The sheet has no Refresh button: it shows a snapshot taken when it opens; close and reopen it to see newer output.
- Diff summary:
  - `ui/src/lib/terminal-text.ts`: `terminalBufferText` turns the xterm buffer into plain text. It joins wrapped rows into one line, trims trailing spaces and drops trailing blank lines.
  - `ui/src/lib/copy-text.ts`: `copyText` writes to the phone's clipboard inside the tap. If the Clipboard API is missing or refuses, it falls back to `execCommand("copy")`.
  - `ui/src/components/TerminalCopySheet.tsx`: a "Copy terminal text" sheet with the selectable text, "Copy selection" and "Copy all".
  - `ui/src/components/Terminal.tsx`: `TerminalHandle.getText()`.
  - `ui/src/components/MobileControlBar.tsx`: new "Select" key-bar button.
  - `ui/src/components/Dashboard.tsx`: opens the sheet with a snapshot of the last 2000 lines; closes it when the session changes.
- Regression tests: `ui/src/lib/terminal-text.test.ts`, `ui/src/lib/copy-text.test.ts`, `ui/src/components/TerminalCopySheet.test.tsx`, `ui/src/components/Terminal.clipboard.test.tsx`, `ui/src/components/MobileControlBar.test.tsx`, `ui/src/components/Dashboard.test.tsx`, and the copy test in `e2e/tests/mobile-terminal-clipboard.spec.ts`. They exercise APIs that don't exist on origin/main (67efb45), so they can't pass there.
- Verification: UI typecheck clean; `vitest` 95 files / 1070 tests pass (run twice); `next build` passes; e2e typecheck clean. The e2e test runs in CI on Chromium with touch emulation (390x844), not on a real iPhone.
- Follow-up: check on a physical iPhone in Safari after deploy.
