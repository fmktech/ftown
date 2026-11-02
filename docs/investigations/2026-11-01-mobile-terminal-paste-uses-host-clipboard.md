---
type: investigation
symptom: "On iPhone Safari, pasting into a session terminal seems to insert the host machine's clipboard (the Mac running the bridge and agent) instead of the phone's clipboard"
slug: mobile-terminal-paste-uses-host-clipboard
date: 2026-11-01T17:24:46-03:00
investigator: Foad Kesheh
git_commit: 67efb45
branch: fix/mobile-terminal-clipboard
repository: fmktech/ftown
status: resolved
hypotheses_formed: 5
hypotheses_rejected: 4
hypotheses_proven: 1
related:
  - docs/investigations/2026-11-01-mobile-terminal-cannot-copy-selection.md
  - docs/investigations/2026-06-10-cursor-paste-placeholder-content-lost.md
---

# On iPhone Safari, terminal paste seems to insert the host's clipboard

Scope: paste only. A separate investigation covers mobile copy. No product code was changed.

## Symptom

User report, verbatim: "on mobile I cant copy a selection, I also thibk paste goes on the hostint machinr paste instead pasting ehat is in the client side".
Follow-ups relayed by the coordinator: the device is an **iPhone with Safari (iOS WebKit)**. The problem is in the session terminal view, not in the mobile Workspace menu ("BH" was a typo; no element labelled `BH` exists: `grep -rnw BH ui/src` returns nothing).

- **Observed**: after trying to copy a terminal selection on the iPhone, Paste in the terminal inserts text the user recognises as the host Mac's clipboard, not what they meant to copy.
- **Expected**: Paste on the phone inserts the phone's clipboard. After a copy on the phone, that means the text just copied.
- **Delta**: the pasted bytes are not the text the user expected. The user puts this down to ftown reading the host clipboard. This log proves that ftown cannot do that from an iPhone, and shows where the unexpected text comes from.

## Reproduction

There is no real iPhone here. The reproduction is deterministic and unit-level, and it records the exact bytes each paste path produces at three points: the UI hand-off (`Terminal.sendInput` and xterm `onData`), the tmux pane, and the agent TUI's reaction.

1. **UI bytes, jsdom + vitest + the real `@xterm/xterm` 6.0.0.** This was a throwaway test at `ui/src/__paste_investigation__/mobile-paste-repro.test.tsx`. It was deleted after the run; its full content is in Appendix A.
   ```
   cd ui && unset FTOWN_DATA_DIR FTOWN_SESSION_ID FTOWN_BRIDGE_POINTER FTOWN_HOOK_PORT FTOWN_HOOK_TOKEN
   ./node_modules/.bin/vitest run src/__paste_investigation__/mobile-paste-repro.test.tsx --reporter=verbose --silent=false
   ```
   Output, verbatim (filtered to the log lines):
   ```
   P1 sent=["PHONE-CLIP line1\nline2"] hex=[50 48 4f 4e 45 2d 43 4c 49 50 20 6c 69 6e 65 31 0a 6c 69 6e 65 32]
   P1b sent=[] hex=[]
   P1b status: Paste was blocked. Open the keyboard and paste there instead.
   P1c sent=[] hex=[]
   P2 sent=["PHONE-CLIP"] hex=[50 48 4f 4e 45 2d 43 4c 49 50]
   P2 paste defaultPrevented: false beforeinput defaultPrevented: false
   P2b sent=[] hex=[]
   P3 buttons: ESC, Control C, Shift Tab, Up arrow, Down arrow, Enter, PgUp, PgDn, Left arrow, Right arrow
   P3 sent=["\u001b","\u0003","\u001b[Z","\u001b[A","\u001b[B","\r","\u001b[5~","\u001b[6~","\u001b[D","\u001b[C"] hex=[1b | 03 | 1b 5b 5a | 1b 5b 41 | 1b 5b 42 | 0d | 1b 5b 35 7e | 1b 5b 36 7e | 1b 5b 44 | 1b 5b 43]
   X1 sent=["\u001b[200~PHONE-CLIP line1\rline2\u001b[201~"] hex=[1b 5b 32 30 30 7e 50 48 4f 4e 45 2d 43 4c 49 50 20 6c 69 6e 65 31 0d 6c 69 6e 65 32 1b 5b 32 30 31 7e]
   X2 sent=["\u001b[200~\u001b[201~"] hex=[1b 5b 32 30 30 7e 1b 5b 32 30 31 7e]
   X3 readonly=false sent=["\u0016"] hex=[16]
   X3 readonly=false defaultPrevented: true
   X3 readonly=true sent=["\u0016"] hex=[16]
   X3 readonly=true defaultPrevented: true
    Test Files  1 passed (1)
         Tests  9 passed (9)
   ```
   Key: P = MobileControlBar (key bar and its hidden input); X = xterm's own helper textarea. `PHONE-CLIP` stands in for the phone's clipboard.
2. **Bytes after the bridge, through tmux 3.6a with ftown's exact `tmux.conf` options.** The test used an isolated socket `ftown-inv-paste-<pid>`, never the prod `ftown` server, and a PTY running `tmux attach-session` like `claude-runner.ts:316-318`. The script is in Appendix B.
   ```
   sent  [mobile key-bar Paste / hidden-input paste (raw, unbracketed)]: 50 48 4f 4e 45 2d 43 4c 49 50 20 6c 69 6e 65 31 0a 6c 69 6e 65 32
   pane  received   : 50 48 4f 4e 45 2d 43 4c 49 50 20 6c 69 6e 65 31 0a 6c 69 6e 65 32
   sent  [xterm paste event (bracketed)]: 1b 5b 32 30 30 7e 50 48 4f 4e 45 2d 43 4c 49 50 1b 5b 32 30 31 7e
   pane  received   : 1b 5b 32 30 30 7e 50 48 4f 4e 45 2d 43 4c 49 50 1b 5b 32 30 31 7e
   sent  [xterm empty paste (image-only clipboard)]: 1b 5b 32 30 30 7e 1b 5b 32 30 31 7e
   pane  received   : 1b 5b 32 30 30 7e 1b 5b 32 30 31 7e
   sent  [xterm hardware Ctrl+V keydown]: 16
   pane  received   : 16
   ```
3. **Agent TUI reaction: Claude Code 2.1.316** (`~/.local/share/claude/versions/2.1.316`, the installed binary). Its bundled JS was searched with `python3 -I` byte searches. Excerpts are under H3.

Verified 2026-11-01 17:35-17:38 -03:00. The repro is stable and deterministic. Every iPhone paste path delivers the phone-side text, and no iPhone path produces either of the two inputs that make Claude Code read the host clipboard.

### Inventory: every way an iPhone Safari user can paste in the terminal view

Ranked by how reachable each path is on an iPhone:

| # | Path | Where it lands | Bytes to the PTY | Evidence |
|---|---|---|---|---|
| 1 | ftown key-bar **Paste** button (row 2). iOS shows its native "Paste" callout because the button calls `navigator.clipboard.readText()` | `MobileControlBar.handlePaste`, then `onSendInput(text)`, then `Terminal.sendInput` | the phone's clipboard text, **raw, unbracketed** (LF kept as `0a`). Nothing if the text is empty | P1, P1c |
| 1b | same button in an insecure context (Solo LAN `http://`), or the iOS bubble dismissed | `catch` branch | **nothing**; status "Paste was blocked. Open the keyboard and paste there instead." | P1b |
| 2 | iOS edit-menu paste (three-finger pinch or tap edit bar; Cmd+V on a hardware keyboard) into the focused **hidden `<input aria-label="Terminal input">`** | `paste`, then `beforeinput(insertFromPaste)`, then `input(insertFromPaste)`; only `onInput` is handled | the phone's clipboard text, raw. `paste` and `beforeinput` are not intercepted (`defaultPrevented: false`). No composition events take part in a paste | P2 |
| 2b | hardware Ctrl+V into the hidden input | `handleKeyDown` handles only Enter and Backspace | nothing | P2b |
| 3 | xterm's helper textarea | on touch devices it is `readonly` with `inputmode="none"` (`Terminal.tsx:266-269`), and the CSS puts it at `left:-9999em; width:0; height:0` (`xterm.css:61-72`). iOS offers no Paste callout for it, and no keyboard opens for it | (if a paste event ever reached it: bracketed client text, X1; a paste with no text gives an **empty** bracketed paste, X2) | X1, X2 |
| 4 | hardware **Ctrl+V** keydown while xterm's textarea has focus | xterm `evaluateKeyboardEvent` (`Keyboard.ts:309-310`), then `triggerDataEvent` | **`\x16`**, with the browser paste cancelled, even when the textarea is readonly | X3 |
| - | Long-press on the terminal output | `.xterm { user-select: none }` (`xterm.css:38-44`); no editable target | nothing | - |
| - | Key-bar `^V` / Ctrl+V key | none exists | - | P3, grep |

No `paste`, `beforeinput`, composition, or custom-keyboard handler exists anywhere in `ui/src` outside tests:
```
$ grep -rn "beforeinput\|onBeforeInput\|compositionstart\|onComposition\|insertFromPaste\|onPaste\|addEventListener(\"paste\|addEventListener('paste" ui/src | grep -v "\.test\."
grep-exit=1
```

## Hypotheses

#### H1: ftown's mobile paste control sends Ctrl+V (`\x16`), Cmd+V, an empty bracketed paste, or a bridge-side paste RPC instead of the phone's text, so the agent TUI pastes from the host clipboard

- **Layer**: code-logic (UI)
- **Prediction**: if H1 is true, the bytes handed to `sendInput` for a paste contain `\x16`, `ESC[200~ESC[201~`, or no text at all, or an RPC other than `input` is sent. If false, the bytes equal the phone clipboard's text.
- **Verification method**: read `MobileControlBar.tsx`; grep `ui/src` for `\x16`; search git history across all branches for Ctrl+V or readText changes; run P1, P2, P2b and P3.
- **Evidence**:
  ```
  ui/src/components/MobileControlBar.tsx:109-120
  109     const handlePaste = useCallback(async () => {
  110       setPasteError("");
  111       try {
  112         if (!navigator.clipboard?.readText) {
  113           throw new Error("Clipboard access is unavailable");
  114         }
  115         const text = await navigator.clipboard.readText();
  116         if (text) onSendInput(text);
  117       } catch {
  118         setPasteError("Paste was blocked. Open the keyboard and paste there instead.");
  119       }
  120     }, [onSendInput]);
  ui/src/components/MobileControlBar.tsx:97-103
   97     const handleInput = useCallback((e: React.FormEvent<HTMLInputElement>) => {
   98       const input = e.currentTarget;
   99       const value = input.value;
  100       if (!value) return;
  101       onSendInput(value);
  102       input.value = "";
  ui/src/components/Dashboard.tsx:1142
  <MobileControlBar ref={mobileControlRef} onSendInput={(data) => terminalRef.current?.sendInput(data)} />
  ui/src/hooks/useTerminal.ts:79-82
    const sendInput = useCallback((data: string) => { if (!transport || !sessionId) return; transport.sendInput(sessionId, data); }, ...
  ui/src/lib/direct-transport/webrtc-peer.ts:242-243 / loopback-peer.ts:203-204
    sendInput(sessionId: string, data: string): void { this.send({ kind: 'input', sessionId, data }); }

  $ grep -rn "x16\|u0016" ui/src bridge/src --include='*.ts' --include='*.tsx'
  grep-x16-exit=1
  $ git log --all --oneline -S'\x16' -- ui/src
  (no output)
  $ git log --all --oneline -S'readText' -- ui/src
  ea726ec Session UX: live usage, paste control, and input alerts (#51)
  d4db111 feat(terminal): add paste action to mobile controls

  P1 sent=["PHONE-CLIP line1\nline2"] ...
  P2 sent=["PHONE-CLIP"] ...
  P2b sent=[] hex=[]
  P3 sent=["\u001b","\u0003","\u001b[Z","\u001b[A","\u001b[B","\r","\u001b[5~","\u001b[6~","\u001b[D","\u001b[C"]
  ```
- **Verdict**: REJECTED
- **Rationale**: counterexample P1. With the phone clipboard set to `PHONE-CLIP line1\nline2`, the Paste button sends exactly those 22 bytes, read with `navigator.clipboard.readText()` on the client. The only messages are `{kind:'input', data}` frames. No key-bar button and no hidden-input path ever emits `\x16` or a bracketed-paste marker. No branch has ever contained a `\x16` send.

#### H2: the bridge or its tmux server reads the host clipboard (pbpaste, xclip, osascript, a tmux paste-buffer binding, OSC 52) or rewrites incoming input

- **Layer**: dependency / integration (bridge PTY and multiplexer)
- **Prediction**: if H2 is true, `bridge/src` contains a clipboard reader or a tmux paste binding, or bytes written to the attach client reach the pane changed. If false, there are zero clipboard references, no bindings, and verbatim pass-through.
- **Verification method**: grep `bridge/src`; read the tmux config and the input sinks; run the isolated tmux pass-through (Appendix B).
- **Evidence**:
  ```
  $ grep -rniE "pbpaste|pbcopy|xclip|xsel|wl-paste|osascript|clipboardy|clipboard|paste-buffer|load-buffer|set-clipboard|\]52;" bridge/src --include='*.ts'
  grep-bridge-clipboard-exit=1
  bridge/src/index.ts:670   onInput: (sid, data) => { runner.write(sid, data); },      // WebRTC
  bridge/src/index.ts:687   onInput: (sid, data) => { runner.write(sid, data); },      // loopback WS
  bridge/src/index.ts:795   (sid, data) => { runner.write(sid, data); },               // Centrifugo
  bridge/src/claude-runner.ts:146-152
  146   write(sessionId: string, data: string): boolean {
  147     const proc = this.activeProcesses.get(sessionId);
  ...
  151     proc.write(data);
  bridge/src/claude-runner.ts:316-318  pty.spawn('tmux', ['-L', TMUX_SOCKET_NAME, 'attach-session', '-t', `=${tmuxSessionName(sessionId)}`]
  bridge/src/tmux.ts:72-74
   72       'unbind-key -a -T prefix',
   73       'unbind-key -a -T root',
   74       'set -g mouse off',
  (tmux pass-through) every case: "pane  received" == "sent", including 0a, ESC[200~..ESC[201~ and 16
  ```
- **Verdict**: REJECTED
- **Rationale**: the bridge has no clipboard code at all. All three input transports call `runner.write(sid, data)`, which calls `node-pty.write`. Every tmux key binding is unbound, mouse mode is off, and the real tmux 3.6a passes all four byte sequences through unchanged.

#### H3: the agent TUI (Claude Code on the macOS host) answers a forwarded client paste by reading the host clipboard, whatever bytes it receives

- **Layer**: dependency / integration (agent TUI)
- **Prediction**: if H3 is true, Claude Code's input handling reads the host clipboard for ordinary, non-empty pasted text. If false, host reads happen only for specific trigger inputs.
- **Verification method**: byte-search the installed Claude Code 2.1.316 bundle for its clipboard readers and their call sites.
- **Evidence** (verbatim minified excerpts from `~/.local/share/claude/versions/2.1.316`):
  ```
  // keybinding: Ctrl+V is chat:imagePaste on macOS/linux (alt+v on windows/wsl)
  var c=I(),m=c==="windows"||c==="wsl",h=m?"alt+v":"ctrl+v", ...
  "ctrl+s":"chat:stash",[h]:"chat:imagePaste",...c==="wsl"&&{"ctrl+v":"chat:imagePaste"}

  // chat:imagePaste handler: host image, else HOST TEXT via pbpaste ("text_fallback")
  aD=()=>{kn(!0),f_e(Cd(Gn)).then(async(gB)=>{if(gB){SP(gB.base64,{mediaType:gB.mediaType,dimensions:gB.dimensions});return}
    let X_=await Izt("clipboard");if(X_&&!x0o(X_)){p("input_image_paste","text_fallback"),J_(X_);return} ...
  async function Izt(e="clipboard"){if(b())return"";let r={useCwd:!1,timeout:2000};switch(I()){case"macos":{let n=await it("pbpaste",[],r);return n.code===0?n.stdout:""} ...
  async function f_e(e){try{let r=Bun.Image.fromClipboard();if(!r)return null; ...

  // bracketed-paste handler: only an EMPTY paste on macOS/WSL reads the host clipboard (image)
  se=Q(()=>I()==="macos",[]),Z=Q(()=>I()==="wsl",[]);
  let fe=ce(()=>{...f_e(zt()).then((T)=>{if(T&&w.current)n(T.base64,{...})})...}),F=Xj(fe,Rr);
  function z(T,U=T.length===0,oe=T.endsWith("[I")||T.endsWith("[O")){x.current=!0;let te=oe?T.replace(/\[[IO]$/,""):T;if(U&&(se||Z)&&n){F();return} ...
  ```
- **Verdict**: REJECTED for the bytes an iPhone sends.
- **Rationale**: Claude Code reads the host clipboard on exactly two inputs. One is `\x16`, through `chat:imagePaste`: `Bun.Image.fromClipboard()` first, then a **`pbpaste` text fallback**. The other is an **empty** bracketed paste on macOS, which reads the host image. Non-empty text, the only thing paths 1 and 2 ever send (P1, P2; P1c sends nothing when the text is empty), is inserted as text. The host readers exist but cannot be reached from the iPhone paste paths.

#### H4: in an insecure context, or when iOS denies clipboard access, the key-bar Paste falls back to a host-side or alternative paste path

- **Layer**: config / environment (secure context, WebKit permission)
- **Prediction**: if H4 is true, with `navigator.clipboard` undefined (an `http://` Solo LAN URL) or `readText` rejected (the iOS bubble dismissed), something is still sent to the PTY. If false, nothing is sent.
- **Verification method**: read the `catch` branch at `MobileControlBar.tsx:117-119`; run P1b with `navigator.clipboard = undefined`.
- **Evidence**:
  ```
  P1b sent=[] hex=[]
  P1b status: Paste was blocked. Open the keyboard and paste there instead.
  ```
- **Verdict**: REJECTED
- **Rationale**: the failure branch only sets an error string, and zero bytes are sent. There is no fallback, host-side or otherwise. Secondary finding: the fallback advice points the user to the hidden input, which is 0×0 with opacity 0 and sits inside a 0×0 `overflow:hidden` wrapper (`MobileControlBar.tsx:132-154`). On an iPhone that input has no long-press target, so the advised workaround is close to unusable. The only route left is the three-finger edit gesture.

#### H5: the iPhone pastes exactly its own pasteboard, and the "host" text is already on that pasteboard because the touch terminal cannot copy a selection

Full claim: every iPhone paste path forwards the phone's own pasteboard byte for byte, so the pasted text is whatever the iOS pasteboard holds. That pasteboard was never refreshed with the terminal selection, because the touch terminal has no working copy path. It therefore still holds older content. With an iPhone and the bridge Mac on one Apple ID, iOS Universal Clipboard makes that older content the Mac's latest copy.

- **Layer**: observation artifact / state (a symptom downstream of the copy defect, plus OS pasteboard state)
- **Prediction**: if H5 is true, then:
  - (a) for any pasteboard value V, the PTY receives V (paths 1 and 2);
  - (b) no iPhone path can produce a host-clipboard trigger (`\x16` or an empty bracketed paste);
  - (c) nothing reachable by touch in the terminal view writes the pasteboard.

  If false, either the bytes differ from V, or a touch copy path exists that would have put the selection on the pasteboard.
- **Verification method**: repro P1, P2, P1c, P2b and P3 with the tmux pass-through for (a) and (b); code search of the touch terminal for every copy writer for (c).
- **Evidence**:
  ```
  (a) P1 sent=["PHONE-CLIP line1\nline2"]   P2 sent=["PHONE-CLIP"]   tmux: pane received == sent
  (b) P1c sent=[] (empty clipboard -> nothing, never ESC[200~ESC[201~)   P2b sent=[]   P3: no 16, no 1b 5b 32 30 30 7e
  (c) $ grep -rn "attachCustomKeyEventHandler\|writeText\|execCommand\|'copy'\|\"copy\"" ui/src/components/Terminal.tsx ui/src/components/MobileControlBar.tsx
      grep-exit=1
      $ grep -rln "touchstart\|touchmove\|TouchEvent" ui/node_modules/@xterm/xterm/src/browser ui/node_modules/@xterm/xterm/src/common
      browser/Types.ts                       <- xterm 6 has no touch selection handling; SelectionService starts on mousedown only
      ui/node_modules/@xterm/xterm/src/browser/services/SelectionService.ts:446  "Handles te mousedown event, setting up for a new selection."
      ui/node_modules/@xterm/xterm/css/xterm.css:38-44   .xterm { ... user-select: none; -webkit-user-select: none; }
      ui/src/components/Terminal.tsx:294-297,324
        const onTouchMove = (e: TouchEvent) => { if (touchStartY === null) return; e.preventDefault(); ...   // drags become scroll
        container.addEventListener("touchmove", onTouchMove, { passive: false });
      ui/src/components/Terminal.tsx:264-269
        // On mobile, hide xterm's textarea to prevent IME composition issues.
        if ("ontouchstart" in window) { xtermTextarea.setAttribute("inputmode", "none"); xtermTextarea.setAttribute("readonly", "true"); }
      Host side, for the Universal Clipboard condition: platform darwin (the prod bridge runs on this Mac);
      `defaults -currentHost read com.apple.coreservices.useractivityd` -> "Domain ... does not exist" (Handoff never changed from its default, which is on)
  ```
- **Verdict**: PROVEN, for (a), (b) and (c). The Universal Clipboard part is a condition of the user's environment that cannot be seen from here. It is not needed for the claim; see Root Cause.
- **Rationale**: the pasted bytes are, by construction, `navigator.clipboard.readText()` or the native paste's inserted value, which is the iOS general pasteboard. They reach the agent unchanged. No iPhone path can trigger any of the host's clipboard readers. The terminal has no touch-reachable copy writer: xterm selection works only with a mouse, `.xterm` has `user-select: none`, touch drags are turned into scroll, and there is no Copy control. So the selection the user tried to copy never replaced the pasteboard's contents, and Paste returned what was there before.

## 5 Whys

```
Symptom:  On iPhone Safari, Paste in the session terminal inserts text the user recognises as the Mac's
          clipboard, not the selection they just tried to copy on the phone.
Why 1?    Because Paste inserts exactly the iPhone's system pasteboard (readText / native paste value, P1/P2),
          and that pasteboard did not hold the terminal selection.
Why 2?    Because the touch terminal has no copy path: xterm 6 selection is mouse-only, .xterm is
          user-select:none, Terminal.tsx turns touch drags into scroll (preventDefault), and neither
          Terminal.tsx nor MobileControlBar.tsx writes the clipboard. The pasteboard keeps older content,
          which Universal Clipboard fills with the Mac's (the bridge host's) latest copy.
Why 3?    Because the touch input layer was built one way, as a phone-to-PTY injector: 5e292db replaced
          xterm's input with a hidden-input bar and made xterm's textarea readonly on touch devices
          (Terminal.tsx:264-269), and d4db111 added Paste as a blind readText -> sendInput. Neither added
          a copy-out path or any display of what is about to be pasted, so a stale or foreign pasteboard
          looks exactly like "ftown pasted the host's clipboard".
Why 4?    Because nothing specifies or tests the mobile clipboard round trip: MobileControlBar has no test
          file, Dashboard.test.tsx:43 mocks it out entirely (`MobileControlBar: () => <div>Session controls</div>`),
          and no e2e covers touch copy or paste. The missing copy and the opaque paste shipped green.
Why 5?    (root) Clipboard behaviour has no single owner or contract across the remote-terminal stack.
          The browser (xterm, the key bar), the multiplexer (tmux) and the agent TUI (Claude Code's
          Ctrl+V -> host pbpaste) each bring their own clipboard rules, and ftown never decided whose
          clipboard a remote terminal uses or how copy-out and paste-in pair up on touch. So touch has no
          copy, paste is invisible, and the host-clipboard trapdoor (\x16) is still reachable from a
          hardware Ctrl+V (X3).
```

## Falsification

- **Absence test.** Remove the stale-pasteboard condition by setting the phone pasteboard to a fresh, known value (`PHONE-CLIP...`). Result: the PTY receives exactly that value (P1, P2), and tmux delivers it unchanged. If ftown or the agent read the host clipboard, the bytes would differ from the stub. They do not. H5 survives.
- **Counterfactual.** Feed the stack the only inputs that do read the host clipboard. Result: tmux passes `\x16` and `ESC[200~ESC[201~` through unchanged, and Claude Code then runs `Bun.Image.fromClipboard()` and the `pbpaste` text fallback. Those inputs come only from xterm's own textarea: a hardware Ctrl+V keydown (X3) or a text-less paste event (X2). Neither iPhone path produces them (P1c, P2b, P3). The host-read cause is real but not reachable from the user's paths. H5 survives.
- **Adjacent-cause search.** One alternative would produce the identical symptom: a hardware Ctrl+V reaching xterm's textarea sends `\x16`, which Claude Code answers with the Mac's clipboard text. H5 fits the evidence better for an iPhone because:
  - on touch devices xterm's textarea is readonly, `inputmode="none"` and off-screen;
  - every terminal tap moves focus to the hidden input (`Dashboard.tsx:1137` `onMobileTap={() => mobileControlRef.current?.focusInput()}`);
  - the iOS soft keyboard has no Ctrl key;
  - the user described the phone's paste, not a keyboard.

  The alternative is recorded as a latent defect (desktop Windows/Linux Ctrl+V; iPad or iPhone with a hardware keyboard) and is handled in the Fix.
- **Conclusion**: H5 survived all three checks.

## Root Cause

- **Immediate cause (proven)**: the iPhone paste paths, the key-bar Paste (`MobileControlBar.tsx:109-120`) and native paste into the hidden input (`MobileControlBar.tsx:97-103`), forward the iPhone pasteboard verbatim (P1, P2, tmux pass-through). No iPhone path emits `\x16` or an empty bracketed paste (P1c, P2b, P3), the bridge has no clipboard code (H2), and the agent reads the host clipboard only on those two triggers (H3). **The user's belief that ftown pastes the host clipboard is wrong for an iPhone.** The text that looks like the host's was already on the iPhone pasteboard. It is stale because the touch terminal cannot write a selection to the pasteboard (Terminal.tsx:264-269, 294-297; xterm.css:38-44; xterm 6 has no touch selection; no copy writer in Terminal or MobileControlBar).
- **Why that stale text is the Mac's**: this is environmental and not observable from here. iOS Universal Clipboard, on by default with Handoff; the host's `useractivityd` defaults domain shows it was never turned off. It hands the iPhone the Mac's newest copy when the phone has nothing newer. Since the phone's copy failed, the Mac's copy is the newest. One user check would confirm it: iOS briefly shows "Pasting from <Mac name>..." when this happens. Alternatively, turn off Handoff on the Mac and repeat; the "host" text should stop appearing.
- **Architectural root (from the 5 Whys)**: clipboard behaviour has no owner or contract across browser, multiplexer and agent TUI. The touch layer is a one-way, untested injector with no copy-out, and paste gives no feedback about what it is sending.
- Rejected H1: P1 sends exactly the readText bytes; no `\x16` exists in `ui/src` or in any branch's history.
- Rejected H2: the bridge has zero clipboard references, all tmux bindings are unbound, and tmux 3.6a passes the bytes unchanged.
- Rejected H3: Claude Code reads the host only on `\x16` or an empty paste, and the iPhone paths send neither.
- Rejected H4: an insecure or denied clipboard sends nothing (P1b); there is no fallback path.
- **Falsification**: the absence, counterfactual and adjacent-cause checks above all left H5 standing.

## Fix (proposal only; nothing implemented)

The user-visible fix is mostly on the **copy** side, which belongs to the other investigation. Once a touch copy writes the selection, it is the newest pasteboard item and beats Universal Clipboard, so the next Paste returns it. The paste-side changes below close the parts of the root cause that paste owns: blind paste, unbracketed paste, the unusable fallback, and the reachable host trapdoor.

1. `ui/src/components/Terminal.tsx`. Clause: "paste sent as raw typed bytes; empty paste triggers the host image read".
   - Add `paste(text: string)` to `TerminalHandle` (next to `sendInput` at :189-193). It calls `xtermRef.current.paste(text)`, xterm's public API: LF becomes CR, and the text is wrapped in `ESC[200~...ESC[201~` when the app enabled DECSET 2004, the same as a desktop paste (X1).
   - Return early on empty text, so ftown never emits an empty bracketed paste (X2). On a macOS host Claude Code answers that with the host's clipboard image.
   - In the init effect (:206-270), `term.attachCustomKeyEventHandler`: on a `keydown` of Ctrl+V without Meta, return `false` so xterm does not send `\x16` (X3). On non-Mac browsers the native paste event then fires and xterm brackets the **client** text. On Mac browsers, where Ctrl+V has no browser paste, do the same and read `navigator.clipboard.readText()` within that keydown gesture, then call `paste()`. This is a deliberate behaviour change: a remote dashboard's Ctrl+V means the viewer's clipboard. Users who need Claude's host-image paste can still use it at the host.
2. `ui/src/components/MobileControlBar.tsx`. Clause: "blind one-way paste; fallback points at a 0×0 input".
   - Add an `onPaste(text)` prop, separate from `onSendInput`.
   - On a Paste tap, call `navigator.clipboard.readText()` synchronously inside the click handler. That keeps it inside the user gesture. iOS Safari still shows its "Paste" callout, and the call needs a secure context.
   - Show a small sheet that previews what will be pasted (first 2-3 lines and a character count) with **Send** and **Cancel**, so a stale or Universal Clipboard pasteboard is visible before it reaches the agent.
   - When `navigator.clipboard?.readText` is missing (Solo `http://` LAN) or rejects (`NotAllowedError` when the user dismisses the iOS bubble), open the same sheet with a **visible**, focused `<textarea>` at 16px font, so iOS does not zoom. The user long-presses it and taps Paste; native paste needs neither the async Clipboard API nor a secure context. Then Send calls `onPaste(value)`.
   - Remove the "Open the keyboard and paste there instead" message.
3. `ui/src/components/Dashboard.tsx:1142`: wire `onPaste={(text) => terminalRef.current?.paste(text)}`.
4. Follow-up, root clause (no owner or contract): add a short "terminal clipboard contract" section to the terminal docs. It should say the viewer's clipboard is the source for paste and the target for copy on every device, and that ftown never forwards keys that make the agent read the host clipboard. Coordinate it with the copy fix.

**Regression tests** (each fails on 67efb45 and passes after the fix):
- `ui/src/components/MobileControlBar.test.tsx` (new, jsdom):
  - (a) Stub `readText` to return `"a\nb"`, tap Paste, then Send. Expect `onPaste("a\nb")` once, and `onSendInput` never receives `"a\nb"` or `"\x16"`. *Before*: `onSendInput("a\nb")` raw, with no sheet and no `onPaste` (P1).
  - (b) With `navigator.clipboard` undefined, tap Paste. Expect a visible textbox labelled "Text to paste"; enter a value, Send, and expect `onPaste(value)`. *Before*: only the status message and zero bytes (P1b).
  - (c) Guard: `readText` returns `""`, and nothing is sent. This passes before and after; it pins H5(b).
- `ui/src/components/Terminal.paste.test.tsx` (new, jsdom, real `@xterm/xterm` as in Appendix A, `useTerminal` mocked to capture `sendInput`):
  - (d) After `term.write("\x1b[?2004h")`, `handle.paste("a\nb")` produces `sendInput("\x1b[200~a\rb\x1b[201~")`. *Before*: no `paste` on the handle.
  - (e) A Ctrl+V keydown on xterm's textarea never produces `"\x16"`. *Before*: `["\u0016"]` (X3).
  - (f) `handle.paste("")` sends nothing.
- Mobile limits honoured: `readText` stays in the click gesture; in insecure contexts the sheet is used without calling it; one extra tap on iOS is accepted in exchange for a visible preview; nothing else depends on clipboard permission.

## Appendix A: throwaway UI repro (ran at 67efb45, then deleted from `ui/src/__paste_investigation__/`)

```tsx
// @vitest-environment jsdom
// THROWAWAY investigation repro (docs/investigations/2026-11-01-mobile-terminal-paste-uses-host-clipboard.md).
// Records the exact bytes each paste path hands to Terminal.sendInput / xterm onData.
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileControlBar } from "@/components/MobileControlBar";

const hex = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
const show = (tag: string, sent: string[]) => console.log(`${tag} sent=${JSON.stringify(sent)} hex=[${sent.map(hex).join(" | ")}]`);

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("mobile key bar + hidden input (MobileControlBar)", () => {
  it("P1 key-bar Paste: sends navigator.clipboard.readText() verbatim, unbracketed", async () => {
    const readText = vi.fn().mockResolvedValue("PHONE-CLIP line1\nline2");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });
    const sent: string[] = [];
    render(<MobileControlBar onSendInput={(d) => sent.push(d)} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Paste clipboard into terminal" }));
    });
    show("P1", sent);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(["PHONE-CLIP line1\nline2"]);
  });

  it("P1b key-bar Paste in an insecure context (navigator.clipboard undefined): nothing sent, error shown", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const sent: string[] = [];
    render(<MobileControlBar onSendInput={(d) => sent.push(d)} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Paste clipboard into terminal" }));
    });
    show("P1b", sent);
    console.log("P1b status:", screen.getByRole("status").textContent);
    expect(sent).toEqual([]);
  });

  it("P1c key-bar Paste when the phone clipboard holds only an image (readText -> ''): nothing sent", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: vi.fn().mockResolvedValue("") } });
    const sent: string[] = [];
    render(<MobileControlBar onSendInput={(d) => sent.push(d)} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Paste clipboard into terminal" }));
    });
    show("P1c", sent);
    expect(sent).toEqual([]);
  });

  it("P2 OS/keyboard paste into the focused hidden input: paste event is not intercepted, input event sends the client text", () => {
    const sent: string[] = [];
    render(<MobileControlBar onSendInput={(d) => sent.push(d)} />);
    const input = screen.getByLabelText("Terminal input") as HTMLInputElement;
    input.focus();
    const pasteEvt = createEvent.paste(input);
    Object.defineProperty(pasteEvt, "clipboardData", { value: { getData: () => "PHONE-CLIP", types: ["text/plain"] } });
    fireEvent(input, pasteEvt);
    // WebKit (iOS Safari) order for an edit-menu / 3-finger paste into an <input>:
    // paste -> beforeinput(insertFromPaste, data) -> DOM insert -> input(insertFromPaste, data). No composition events.
    const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertFromPaste", data: "PHONE-CLIP" });
    input.dispatchEvent(before);
    input.value = "PHONE-CLIP";
    fireEvent.input(input, { inputType: "insertFromPaste", data: "PHONE-CLIP" });
    show("P2", sent);
    console.log("P2 paste defaultPrevented:", pasteEvt.defaultPrevented, "beforeinput defaultPrevented:", before.defaultPrevented);
    expect(pasteEvt.defaultPrevented).toBe(false);
    expect(before.defaultPrevented).toBe(false);
    expect(sent).toEqual(["PHONE-CLIP"]);
  });

  it("P2b hardware Ctrl+V keydown on the hidden input emits no \\x16", () => {
    const sent: string[] = [];
    render(<MobileControlBar onSendInput={(d) => sent.push(d)} />);
    const input = screen.getByLabelText("Terminal input");
    fireEvent.keyDown(input, { key: "v", code: "KeyV", keyCode: 86, ctrlKey: true });
    show("P2b", sent);
    expect(sent).toEqual([]);
  });

  it("P3 no key-bar button emits Ctrl+V (\\x16) or a bracketed-paste marker", () => {
    const sent: string[] = [];
    render(<MobileControlBar onSendInput={(d) => sent.push(d)} />);
    const labels: string[] = [];
    for (const btn of screen.getAllByRole("button")) {
      const name = btn.getAttribute("aria-label") ?? "";
      if (name === "Paste clipboard into terminal" || name === "Show keyboard") continue;
      labels.push(name);
      fireEvent.click(btn);
    }
    console.log("P3 buttons:", labels.join(", "));
    show("P3", sent);
    expect(sent.some((d) => d.includes("\x16"))).toBe(false);
    expect(sent.some((d) => d.includes("\x1b[200~"))).toBe(false);
  });
});

describe("xterm 6 textarea (desktop, or any device where xterm's textarea has focus)", () => {
  async function openTerm(readonly: boolean) {
    if (!window.matchMedia) {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
      });
    }
    const { Terminal } = await import("@xterm/xterm");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const term = new Terminal({ allowProposedApi: true });
    term.open(el);
    if (readonly) {
      term.textarea!.setAttribute("inputmode", "none");
      term.textarea!.setAttribute("readonly", "true");
    }
    const data: string[] = [];
    term.onData((d) => data.push(d));
    // Claude Code / tmux enable bracketed paste (DECSET 2004).
    await new Promise<void>((r) => term.write("\x1b[?2004h", r));
    return { term, data };
  }

  function pasteEvent(text: string) {
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { getData: () => text } });
    return ev;
  }

  it("X1 paste event with client text -> ESC[200~ text(LF->CR) ESC[201~", async () => {
    const { term, data } = await openTerm(false);
    term.textarea!.dispatchEvent(pasteEvent("PHONE-CLIP line1\nline2"));
    show("X1", data);
    expect(data).toEqual(["\x1b[200~PHONE-CLIP line1\rline2\x1b[201~"]);
    term.dispose();
  });

  it("X2 paste event whose clipboard has no text (image only) -> EMPTY bracketed paste", async () => {
    const { term, data } = await openTerm(false);
    term.textarea!.dispatchEvent(pasteEvent(""));
    show("X2", data);
    expect(data).toEqual(["\x1b[200~\x1b[201~"]);
    term.dispose();
  });

  it("X3 hardware Ctrl+V keydown on xterm's textarea -> \\x16, default (browser paste) prevented", async () => {
    for (const readonly of [false, true]) {
      const { term, data } = await openTerm(readonly);
      const ev = new KeyboardEvent("keydown", { key: "v", code: "KeyV", ctrlKey: true, bubbles: true, cancelable: true });
      Object.defineProperty(ev, "keyCode", { value: 86 });
      term.textarea!.dispatchEvent(ev);
      show(`X3 readonly=${readonly}`, data);
      console.log(`X3 readonly=${readonly} defaultPrevented:`, ev.defaultPrevented);
      expect(data).toEqual(["\x16"]);
      expect(ev.defaultPrevented).toBe(true);
      term.dispose();
    }
  });
});
```

## Appendix B: isolated tmux pass-through script (scratchpad, outside the repo)

Path: `/private/tmp/claude-501/-Users-fkesheh-projects-ftown/c1622140-6baf-4d8c-87c6-1193f081a22d/scratchpad/paste-inv/scripts/tmux_passthrough.py`. Run with `python3 -I tmux_passthrough.py <workdir>`. It uses its own socket `ftown-inv-paste-<pid>` and `kill-server`s it afterwards; the leftover socket file was removed. The prod `ftown` tmux server was never touched.

```python
import os, pty, subprocess, sys, time
work = sys.argv[1]
sock = f"ftown-inv-paste-{os.getpid()}"
conf = os.path.join(work, "tmux.conf"); out = os.path.join(work, "pane-bytes.txt"); dumper = os.path.join(work, "dumper.py")
# Same option lines as bridge/src/tmux.ts tmuxConfigPath() (lines 69-86).
open(conf, "w").write("\n".join([
    "set -g status off", "set -g prefix None", "set -g prefix2 None",
    "unbind-key -a -T prefix", "unbind-key -a -T root", "set -g mouse off",
    "set -g history-limit 100000", "set -g remain-on-exit off", "set -g destroy-unattached off",
    "set -g exit-empty on", "setw -g window-size latest", "setw -g aggressive-resize on",
    "set -s escape-time 0", 'set -g default-terminal "xterm-256color"',
    'bind-key -n PPage if-shell -F "#{alternate_on}" "send-keys PPage" "copy-mode -eu"',
]) + "\n")
# Pane program: raw mode, DECSET 2004 (as Claude Code does), log each read as hex.
open(dumper, "w").write(f"""
import os, sys, termios, tty
fd = sys.stdin.fileno(); tty.setraw(fd)
sys.stdout.write("\\x1b[?2004h"); sys.stdout.flush()
with open({out!r}, "a") as f:
    while True:
        b = os.read(fd, 4096)
        if not b: break
        f.write(b.hex(" ") + "\\n"); f.flush()
""")
env = dict(os.environ, TERM="xterm-256color")
subprocess.run(["tmux", "-L", sock, "-f", conf, "new-session", "-d", "-s", "s", "-x", "80", "-y", "24",
                f"python3 -I {dumper}"], check=True, env=env)
pid, fd = pty.fork()
if pid == 0:
    os.execvpe("tmux", ["tmux", "-L", sock, "attach-session", "-t", "=s"], env)   # like claude-runner.ts:316-318
try:
    time.sleep(1.0)
    for label, data in [("mobile key-bar Paste / hidden-input paste (raw, unbracketed)", "PHONE-CLIP line1\nline2"),
                        ("xterm paste event (bracketed)", "\x1b[200~PHONE-CLIP\x1b[201~"),
                        ("xterm empty paste (image-only clipboard)", "\x1b[200~\x1b[201~"),
                        ("xterm hardware Ctrl+V keydown", "\x16")]:
        before = open(out).read() if os.path.exists(out) else ""
        os.write(fd, data.encode()); time.sleep(0.6)
        after = open(out).read() if os.path.exists(out) else ""
        print(f"sent  [{label}]: {data.encode().hex(' ')}")
        print(f"pane  received   : {after[len(before):].strip() or '(nothing)'}")
finally:
    subprocess.run(["tmux", "-L", sock, "kill-server"], stderr=subprocess.DEVNULL)
```

## Resolution

- The reported cause ("paste uses the host clipboard") stays rejected, as recorded above. The fix addresses the proven defect: key-bar Paste sent the phone's clipboard text raw through `onSendInput`, skipping xterm's paste handling.
- Changes from the proposed fix: there is no preview sheet before a normal paste; the clipboard text is pasted straight away, and the "Text to paste" box appears only when the clipboard can't be read. The Ctrl+V key-handler change was not made (see Out of scope). The empty-text guard was made: `TerminalHandle.paste("")` does nothing (`ui/src/components/Terminal.tsx:209`, covered by "paste of an empty string sends nothing" in `Terminal.clipboard.test.tsx`).
- Diff summary:
  - `ui/src/components/MobileControlBar.tsx`: Paste sends the clipboard text to a new `onPaste` prop instead of `onSendInput`. An empty clipboard shows "Clipboard is empty." When the Clipboard API is missing (for example plain http) or the read is refused, a "Text to paste" box with Send/Cancel appears, so the user can long-press and paste there. Paste events on the hidden input also go to `onPaste`, which keeps newlines.
  - `ui/src/components/Terminal.tsx`: `TerminalHandle.paste(text)` calls xterm's `term.paste`, which turns `\n` into `\r` and adds bracketed-paste markers when the app turned them on. So a multi-line paste reaches Claude Code as one paste instead of line by line.
  - `ui/src/components/Dashboard.tsx`: wires the key bar's `onPaste` to `TerminalHandle.paste`.
- Out of scope: on desktop, a hardware Ctrl+V sends `\x16`, and Claude Code then reads the HOST machine's clipboard. Unchanged, because changing it would break Claude Code's host image paste. Left for the owner to decide.
- Regression tests: `ui/src/components/MobileControlBar.test.tsx` (Paste goes to `onPaste`, never raw to `onSendInput`; empty clipboard; fallback box), `ui/src/components/Terminal.clipboard.test.tsx` (`paste` uses `term.paste`), `ui/src/components/Dashboard.test.tsx`, and the paste and paste-fallback tests in `e2e/tests/mobile-terminal-clipboard.spec.ts`.
- Verification: same gates as the copy fix (UI typecheck, 1070 vitest tests, build, e2e typecheck). The e2e tests run in CI on Chromium with touch emulation, not on a real iPhone.
- Follow-up: check on a physical iPhone in Safari after deploy.
