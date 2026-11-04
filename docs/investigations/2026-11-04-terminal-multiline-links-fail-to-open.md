---
type: investigation
symptom: "Clicking a URL that spans more than one row in the dashboard terminal opens a truncated URL (first row only) or does nothing"
slug: terminal-multiline-links-fail-to-open
date: 2026-11-04T08:20:00-03:00
investigator: Foad Kesheh
git_commit: f325c4ed1c71b88348a15f71c49e356681665509
branch: fix/terminal-multiline-links
repository: fmktech/ftown
status: resolved
hypotheses_formed: 5
hypotheses_rejected: 4
hypotheses_proven: 1
related: []
---

# Multi-row links in the dashboard terminal fail to open

## Symptom

User report, verbatim: "links com mais de uma linha falham ao abrir". In English: links that span more than one line fail to open.

- **Observed**: the URL is longer than the terminal width, so it covers two or more rows. Then:
  - Clicking the first row calls `window.open` with only that row's piece of the URL.
  - Hovering or clicking any later row does nothing.
  - The repro shows this with the shipped addon code (see Reproduction):
    ```
    row  10: link range y11x3..y12x0 len=78 -> window.open("https://example.com/ftown/multiline-link-test/0123456789/abcdefghijklmnopqrstu")
    row  11: NO LINK (hover/click does nothing)
    ```
- **Expected**: clicking any row of the URL opens the whole URL, which is 149 characters long:
  `https://example.com/ftown/multiline-link-test/0123456789/abcdefghijklmnopqrstuvwxyz/0123456789/abcdefghijklmnopqrstuvwxyz/path-segment-x?q=END-OF-URL`
- **Delta**:
  - The link the UI detects ends at the first row's last cell, so it is 78 characters instead of 149.
  - Continuation rows give no link at all.
  - Single-row links are not affected. The user complains only about multi-row ones.

## Reproduction

Environment:
- tmux 3.6a (Homebrew), using the bridge's exact tmux.conf. It is copied from `bridge/src/tmux.ts:68-86` into `ml-links-exp/ftown-tmux.conf`.
- The client is attached the way the bridge does it: `tmux -L <sock> attach-session -t =<name>` in node-pty with `name: 'xterm-256color'` (`bridge/src/claude-runner.ts:316-323`).
- The bytes are fed into `@xterm/headless` 6.0.0. This is the same core as the UI's `@xterm/xterm` 6.0.0.
- The links come from the UI's `@xterm/addon-web-links` 0.12.0, loaded from `ui/node_modules` and built exactly as at `ui/src/components/Terminal.tsx:260-262`.
- Claude Code 2.1.318.
- Experiment directory: `/private/tmp/claude-501/-Users-fkesheh-projects-ftown/99a20ec3-eacc-48b8-849e-8dba56f1eaba/scratchpad/ml-links-exp/`. The scripts are:
  - `capture.js`: a PTY reader, like the bridge's.
  - `analyze.js`: dumps rows with `isWrapped`, runs the real web-links provider per row, and simulates a click.
  - `osc8-scan.js`: mirrors `OscLinkProvider`.
  - `repro.sh`: the one-command repro.

Steps:

1. Run `ml-links-exp/repro.sh`. It uses only the private socket `-L ftown-mldebug`.
   - Case 1 replays recorded Claude Code output (`cc-pane-raw.bin`) through tmux at 80x30. No model call is needed.
   - Case 2 is a plain shell at 60x20 that writes the URL in three chunks while the cursor is on the bottom row.
   ```
   $ ml-links-exp/repro.sh
   == case 1: Claude Code reply through tmux (OSC 8 bytes reaching browser: 0)
   row  10 isWrapped=F len= 80 |⏺ https://example.com/ftown/multiline-link-test/0123456789/abcdefghijklmnopqrstu|
   row  11 isWrapped=F len= 73 |  vwxyz/0123456789/abcdefghijklmnopqrstuvwxyz/path-segment-x?q=END-OF-URL|
   row   7: link range y8x3..y8x79 len=77 -> window.open("https://example.com/ftown/multiline-link-test/0123456789/abcdefghijklmnopqrst")
   row   8: NO LINK (hover/click does nothing)
   row  10: link range y11x3..y12x0 len=78 -> window.open("https://example.com/ftown/multiline-link-test/0123456789/abcdefghijklmnopqrstu")
   row  11: NO LINK (hover/click does nothing)
   == case 2: plain shell, URL written in chunks on the bottom row
   row  16 isWrapped=F len= 60 |C:https://example.com/ftown/multiline-link-test/0123456789/a|
   row  17 isWrapped=F len= 60 |bcdefghijklmnopqrstuvwxyz/0123456789/abcdefghijklmnopqrstuvw|
   row  18 isWrapped=F len= 31 |xyz/path-segment-x?q=END-OF-URL|
   row  16: link range y17x3..y18x0 len=58 -> window.open("https://example.com/ftown/multiline-link-test/0123456789/a")
   row  17: NO LINK (hover/click does nothing)
   row  18: NO LINK (hover/click does nothing)
   ```
   Verified: 2026-11-04 08:19 -03:00. The symptom reproduced on demand in both cases. Rows 7 and 8 are Claude Code's echo of the prompt, and row 10 is the assistant's reply.

2. The recording `cc-pane-raw.bin` came from one interactive run, captured with `tmux pipe-pane -O`. That records the program's raw output before tmux processes it. The run:
   - `claude --model haiku --strict-mcp-config --no-chrome --setting-sources local --settings '{"disableAllHooks":true}' "<print this URL>"`.
   - The env matched an ftown session: `TERM_PROGRAM=Apple_Terminal`, `TERM_PROGRAM_VERSION=470`, `COLORTERM=truecolor`, `FORCE_COLOR=3`, `TERM=xterm-256color`, `TMUX` set.
   - `FORCE_HYPERLINK=1` was added so the run would show OSC 8 output.
   - All `FTOWN_*` and `CLAUDE_*` variables were removed.
   - The script is `ml-links-exp/run-claude.sh`.

## Hypotheses

#### H1: tmux redraws each row on its own, so every URL wider than the pane reaches the browser with `isWrapped=false` on its continuation rows, and tmux alone causes the failure

- **Layer**: dependency (tmux 3.6a)
- **Prediction**:
  - If H1 is true, a plain-shell URL printed inside tmux arrives with continuation rows `isWrapped=F` and a truncated link.
  - The same URL printed without tmux arrives with `isWrapped=T` and a full link.
  - If H1 is false, tmux output keeps `isWrapped=T` and the full URL opens.
- **Verification method**: `print-url.sh` prints `A:<url>` near the top of the screen. It then fills the screen and prints `B:<url>` on the bottom row, each in one `printf`. The bytes were captured three ways: directly in node-pty, through a live tmux client, and through a tmux client that re-attached (a full redraw). Each capture was run through `analyze.js`.
- **Evidence**:
  ```
  # direct (no tmux) — control
  row  33 isWrapped=F len= 60 |B:https://example.com/ftown/multiline-link-test/0123456789/a|
  row  34 isWrapped=T len= 60 |bcdefghijklmnopqrstuvwxyz/0123456789/abcdefghijklmnopqrstuvw|
  row  35 isWrapped=T len= 31 |xyz/path-segment-x?q=END-OF-URL|
  row  34: link range y34x3..y36x31 len=149 -> window.open("https://example.com/ftown/...path-segment-x?q=END-OF-URL")
  # through tmux, live (cap-tmux-live.bin) — tmux emits the run with no cursor motion:
  "␛[3S␛[3AB:https://example.com/ftown/multiline-link-test/...path-segment-x?q=END-OF-URL␛[K\r\n"
  row  17 isWrapped=T len= 60 |bcdefghijklmnopqrstuvwxyz/0123456789/abcdefghijklmnopqrstuvw|
  row  18 isWrapped=T len= 31 |xyz/path-segment-x?q=END-OF-URL|
  row  17: link range y17x3..y19x31 len=149 -> window.open("https://example.com/ftown/...?q=END-OF-URL")
  # through tmux, full redraw on re-attach (cap-tmux-reattach.bin)
  row  17 isWrapped=T ... row  18 isWrapped=T ... -> window.open(<full 149-char URL>)
  ```
  A narrower sub-case does break. If the wrap boundary falls in a later write while the cursor is on the bottom row, tmux places the continuation row with an absolute cursor move (`cap-tmux-osc8-default.bin`):
  ```
  "C:https://example.com/ftown/multiline-link-test/0123456789/a␛[20;1H\nbcdefghijklmnopqrstuvwxyz/0123456789/abcdefghijklmnopqrstuvw␛[...␛[20;1H␛[2S␛[Axyz/path-segment-x?q=END-OF-URL"
  ```
  tmux's own grid still records that line as wrapped. `capture-pane -J` joins it back into one line, and a re-attach redraw brings back `isWrapped=T` and the full link.
- **Verdict**: REJECTED
- **Rationale**: Counterexample 1: tmux is in the path, but URLs written in a single write, and full redraws, keep `isWrapped=T` and open in full. Counterexample 2: the Claude Code failure also happens with tmux removed (H2 evidence, `cc-pane-raw.bin` fed directly gives `isWrapped=F`). tmux causes hard rows only in the bottom-row split-write case. That case is one input to H5, not a separate root cause.

#### H2: Claude Code alone causes the failure, because its Ink renderer hard-wraps long URLs with explicit row breaks and indentation and leaves no way to recover the full URL, so links break even without tmux

- **Layer**: dependency (the agent's TUI)
- **Prediction**:
  - If H2 is true, Claude's raw output (without tmux) has continuation rows with `isWrapped=F` and carries the URL only as split text.
  - In that case no link provider in xterm could recover the full URL from it.
- **Verification method**:
  - One Claude Code TUI run, with the raw pane output captured by `pipe-pane -O`.
  - Those raw bytes fed straight into xterm 6.0.0. They are what a terminal without tmux would receive.
  - Two scans over the result: `analyze.js` (WebLinksAddon) and `osc8-scan.js` (xterm's built-in OSC 8 link provider).
  - The tmux grid checked with `capture-pane -p -J`.
- **Evidence**:
  ```
  # tmux grid: Claude's rows are NOT joined by -J => Claude emitted hard rows
  11:⏺ https://example.com/ftown/multiline-link-test/0123456789/abcdefghijklmnopqrstu
  12:  vwxyz/0123456789/abcdefghijklmnopqrstuvwxyz/path-segment-x?q=END-OF-URL
  # raw Claude bytes for the reply (CR, cursor-forward 2, cursor-down 1 instead of a wrap; OSC 8 on BOTH rows)
  "␛]8;id=1nzqeb2;https://example.com/...?q=END-OF-URL\u0007␛[94mhttps://example.com/ftown/multiline-link-test/0123456789/abcdefghijklmnopqrstu␛]8;;\u0007\r␛[2C␛[1B␛]8;id=1nzqeb2;https://example.com/...?q=END-OF-URL\u0007vwxyz/0123456789/abcdefghijklmnopqrstuvwxyz/path-segment-x?q=END-OF-URL␛]8;;\u0007"
  # same bytes, no tmux, WebLinksAddon: truncated
  row  10: link range y11x3..y12x0 len=78 -> window.open("https://example.com/ftown/multiline-link-test/0123456789/abcdefghijklmnopqrstu")
  row  11: NO LINK (hover/click does nothing)
  # same bytes, no tmux, xterm OscLinkProvider: full URL from either row
  row  10 isWrapped=F OSC8 cells x3..x80 -> activate("https://example.com/ftown/...path-segment-x?q=END-OF-URL")
  row  11 isWrapped=F OSC8 cells x3..x73 -> activate("https://example.com/ftown/...path-segment-x?q=END-OF-URL")
  ```
- **Verdict**: REJECTED
- **Rationale**: Part of H2 is true. Claude hard-wraps with explicit cursor moves (`\r ESC[2C ESC[1B`) and a 2-column indent, so `isWrapped` is never set. But the claim that Claude leaves the full URL unrecoverable, even without tmux, is false. Its raw output carries the whole URL as an OSC 8 hyperlink on every row, and xterm's OSC 8 provider opens the whole URL from either row. Counterexample 2: plain-shell output with no Claude involved fails the same way (Reproduction case 2). So the URL is lost downstream of Claude.

#### H3: The bridge's snapshot/replay path drops wrap flags, so links that work live break after a (re)attach

The path is `TerminalManager` (headless xterm plus `SerializeAddon`) to `onAttach`, then to a browser `term.write`.

- **Layer**: state-data (bridge)
- **Prediction**: if H3 is true, rows with `isWrapped=T` in the headless buffer come back as `F` after `serialize()` and `write()`. It would also mean live bytes work while snapshots fail.
- **Verification method**:
  - The serialize round trip in `analyze.js --serialize-roundtrip` uses the same call as `bridge/src/index.ts:673,690` (`terminalManager.serialize(sid, 20000)`, defined at `terminal-manager.ts:97-101`).
  - The `isWrapped` values were compared before and after on the direct and tmux captures.
  - Live bytes were also checked on their own, with no snapshot involved.
- **Evidence**:
  ```
  --- after SerializeAddon.serialize -> fresh terminal.write (bridge onAttach snapshot path): buffer.length=37 cols=60
  row  33 isWrapped=F len= 60 |B:https://example.com/ftown/multiline-link-test/0123456789/a|
  row  34 isWrapped=T len= 60 |bcdefghijklmnopqrstuvwxyz/0123456789/abcdefghijklmnopqrstuvw|
  row  35 isWrapped=T len= 31 |xyz/path-segment-x?q=END-OF-URL|
  row  34: link range y34x3..y36x31 len=149 -> window.open(<full 149-char URL>)
  ```
  The live tmux client bytes, which never go through a snapshot, already fail (Reproduction case 1, `cc-client.bin`). Side finding, which matters for the fix: `SerializeAddon` 0.14.0 drops OSC 8.
  ```
  snapshot bytes=1205 OSC8 sequences in snapshot=0
  rows carrying OSC 8 link cells: 0
  ```
- **Verdict**: REJECTED
- **Rationale**: Serialize keeps `isWrapped` exactly, both `T` and `F`, and the failure already shows in the live stream. The snapshot path is not the cause. Its loss of OSC 8 is a risk for Fix option 1.

#### H4: Detection is fine, and the click handler or the browser's popup blocker is what fails

The handler in question is `window.open(uri, "_blank")` at `Terminal.tsx:261`.

- **Layer**: code-logic (UI)
- **Prediction**:
  - If H4 is true, the handler gets the full URL and the window fails to open.
  - If H4 is false, the handler gets a wrong (truncated) URL, or is never called.
- **Verification method**:
  - The real addon is run with its handler swapped for a recorder. `activate(event, link.text)` is called exactly as xterm's Linkifier does (`ui/node_modules/@xterm/xterm/src/browser/Linkifier.ts:231`, inside `_handleMouseUp`).
  - The URI it receives is compared between a soft-wrapped URL and a hard-wrapped one.
- **Evidence**:
  ```
  soft-wrapped (direct):  row 34: ... -> window.open("https://example.com/ftown/...path-segment-x?q=END-OF-URL")   (149 chars)
  hard-wrapped (Claude):  row 10: ... -> window.open("https://example.com/ftown/multiline-link-test/0123456789/abcdefghijklmnopqrstu") (78 chars)
                          row 11: NO LINK (hover/click does nothing)
  Linkifier.ts:231        this._currentLink.link.activate(event, this._currentLink.link.text);   // synchronous in mouseup
  ```
- **Verdict**: REJECTED
- **Rationale**: The handler opens exactly what detection hands it: the full URL when the rows are joined, and the first-row fragment otherwise. It runs synchronously inside the mouse gesture. Single-row links, which use the same handler, work according to the report. The defect is in detection.

#### H5: The dashboard can only rebuild a URL across rows from xterm's soft-wrap flag `isWrapped`, and the only signal that carries a whole URL regardless of layout (OSC 8) never reaches the browser. So a URL laid out as hard rows is cut to its first-row fragment

More precisely:
- The only detector that can fire is `WebLinksAddon`. It joins a row to its neighbours only when `isWrapped` is true (`WebLinkProvider.ts:124,142`).
- xterm's OSC 8 provider is registered, but it gets no OSC 8 cells.
- Hard rows come from Claude Code's Ink layout in every case, and from tmux's bottom-row split writes.

- **Layer**: code-logic plus config-env (UI link layer and the bridge's tmux and env setup)
- **Prediction**:
  - In every capture where the continuation rows are `isWrapped=F` and no OSC 8 reaches xterm, the click opens the first-row fragment and continuation rows give no link.
  - In every capture where the same text has either `isWrapped=T` or OSC 8 cells, every row opens the full 149-character URL.
- **Verification method**:
  - A matrix over all captures, scanned with the shipped addon and with a mirror of `OscLinkProvider`.
  - Checks of tmux's client features and of its OSC 8 forwarding.
  - Reading the UI, bridge, xterm and Claude Code source.
- **Evidence**:

  | capture | path | continuation `isWrapped` | OSC 8 cells in xterm | URL the click opens |
  |---|---|---|---|---|
  | `cap-direct.bin` | shell, no tmux | T | none | full (149 chars) |
  | `cap-tmux-live.bin` and `cap-tmux-reattach.bin` | shell, tmux, one write | T | none | full |
  | `repro2.bin` | shell, tmux, bottom-row split write | **F** | none | **58-char fragment, then nothing** |
  | `cc-client.bin` | Claude Code to tmux to bridge client (the production shape) | **F** | **0** | **78-char fragment, then nothing** |
  | `cc-pane-raw.bin` | Claude Code raw, no tmux | F | 2 rows | full on both rows (OSC provider) |
  | `cc-replay-hyperlinks-client.bin` | Claude bytes to tmux with `xterm*:hyperlinks` | F | 2 rows | full on both rows |

  ```
  # UI: the sole detector, no OSC 8 linkHandler configured
  ui/src/components/Terminal.tsx:260  term.loadAddon(new WebLinksAddon((_event, uri) => {
  ui/src/components/Terminal.tsx:261    window.open(uri, "_blank");
  $ grep -rn linkHandler ui/src | wc -l   ->   0
  # addon joins rows only on isWrapped
  WebLinkProvider.ts:124  if (line.isWrapped && currentContent[0] !== ' ') {
  WebLinkProvider.ts:142  while ((line = terminal.buffer.active.getLine(++bottomIdx)) && line.isWrapped && length < 2048) {
  # tmux: the bridge-style client is not given the hyperlinks feature, so OSC 8 is stripped
  client_pid=22875 termname=xterm-256color termtype= termfeatures=bpaste,ccolour,clipboard,cstyle,focus,RGB,title
  terminal-features[0] xterm*:clipboard:ccolour:cstyle:focus:title      (bridge tmux.conf adds none: bridge/src/tmux.ts:68-86)
  OSC8 sequences in client output (default bridge config): 0
  O-line: "O:https://example.com/ftown/...?q=END-OF-URL\r\n"                (printf'd with OSC 8 in the pane; tmux removed it)
  # counterfactual: same server + `set -as terminal-features ',xterm*:hyperlinks'`
  O-line: "O:␛]8;id=tmux2;https://example.com/ftown/...?q=END-OF-URL␛\\https://example.com/..."
  # tmux auto-detects hyperlinks only for these XTVERSION replies (strings of tmux 3.6a): xterm.js is not one
  iTerm2 / tmux / XTerm( / mintty / foot(
  # Claude Code 2.1.318 decides OSC 8 via fb(): with the env ftown sessions inherit
  # (TERM_PROGRAM=Apple_Terminal from the bridge's launch terminal, via claude-runner.ts:238 `...process.env`)
  # no branch returns true; FORCE_HYPERLINK=1 makes cqe() return true. The bridge never sets it (xterm-theme.ts:31-40).
  function fb(r){let n=cqe(r);if(n!==void 0)return n;...let p=e.TERM_PROGRAM;if(p&&L.includes(p))return!0;...
    if(p==="tmux"){...if(s>3||s===3&&v>=4)return!0}...return!1}
  var L=["ghostty","Hyper","kitty","alacritty","iTerm.app","iTerm2","WarpTerminal"]
  ```
- **Verdict**: PROVEN
- **Rationale**:
  - The URL text is identical in every capture.
  - The full URL opens exactly when there is a way to join the rows (soft-wrap or OSC 8), and only the fragment opens when there is none.
  - In the production shape (`cc-client.bin`) neither exists, because:
    - Claude's rows are hard rows.
    - tmux drops OSC 8 for a client without the `hyperlinks` feature.
    - The bridge requests neither the feature nor `FORCE_HYPERLINK`.

## 5 Whys

```
Symptom:  Clicking a URL that spans 2+ rows opens a truncated URL (first row only); continuation rows are dead.
Why 1?    WebLinksAddon, the only detector that fires, matched only the first row's fragment. It joins rows
          only when isWrapped=true (WebLinkProvider.ts:124,142), and the continuation rows have isWrapped=false
          (row 11 in cc-client.bin; rows 17-18 in repro2.bin).
Why 2?    The rows are laid out by a full-screen renderer, not wrapped by the terminal. Claude Code (Ink) breaks
          the URL at the wrap width and places the next row with `\r ESC[2C ESC[1B` plus a 2-column indent.
          tmux places a split write on the bottom row with `ESC[20;1H \n`. xterm sets isWrapped only when it
          auto-wraps by itself, so no TUI-rendered row can ever carry it.
Why 3?    The one signal that survives any layout, OSC 8 (Claude emits it with the full URL on every row when
          its hyperlink check passes), is cut before the browser. tmux strips it for the bridge's attach client,
          which lacks the `hyperlinks` feature: the tmux.conf in bridge/src/tmux.ts:68-86 does not add it, and
          tmux auto-detects it only for iTerm2/tmux/XTerm/mintty/foot. The bridge also never sets FORCE_HYPERLINK,
          so with the inherited TERM_PROGRAM=Apple_Terminal, Claude's fb() check fails anyway.
Why 4?    The terminal stack was built from defaults meant for a raw shell byte stream: the default WebLinksAddon,
          no xterm `linkHandler` (Terminal.tsx:220-254), and tmux's default terminal-features. There was no
          requirement or test that a link printed by an agent TUI in a tmux session can be opened from the dashboard.
Why 5?    Architectural root: the dashboard shows the rendered cell grid of a TUI running inside tmux, not the
          program's logical text. Information about logical lines and links has to be carried explicitly
          (OSC 8, end to end) or rebuilt by a heuristic in the UI. The current design does neither, so any URL
          wider than the screen that an agent TUI lays out loses its tail.
```

## Falsification

- **Check performed**: isolation, then counterfactual, then an adjacent-cause search.
- **Result**:
  - **Isolation.** The same 149-character URL text, shown through the same tmux, the same bridge-style client and the same shipped addon, opens in full when its rows are soft-wrapped (`cap-tmux-live.bin`, row 17: `len=149`). It opens as a 58-character fragment when the only change is that the write is split on the bottom row (`repro2.bin`). So the text, the regex and `isUrl`, the handler and the popup path are not the variable. The row-join signal is.
  - **Counterfactual.** I replayed Claude's exact bytes through tmux after `tmux -L ftown-mldebug set -as terminal-features ',xterm*:hyperlinks'`. The OSC 8 channel came back, and the rows are still `isWrapped=F`, yet both rows activate the full URL:
    ```
    row  10 isWrapped=F OSC8 cells x3..x80 -> activate("https://example.com/ftown/...path-segment-x?q=END-OF-URL")
    row  11 isWrapped=F OSC8 cells x3..x73 -> activate("https://example.com/ftown/...path-segment-x?q=END-OF-URL")
    ```
    tmux also sends OSC 8 again on a full redraw (`cc-replay-hyperlinks-reattach.bin`: `OSC8 opens on full redraw: 8`). Removing the feature again brings the symptom back (`cc-client.bin`, `repro1.bin`: 0 OSC 8, 78-character fragment).
  - **Adjacent causes.** The snapshot path (H3) keeps `isWrapped` and live bytes fail anyway. The handler or popup (H4) receives the truncated URI. The Unicode11 width tables the UI uses give the same layout (`⏺` has width 1; rows 10 and 11 are unchanged).
- **Conclusion**: the hypothesis survived. The symptom appears exactly when there is no way to join the rows and goes away when either one is supplied.

## Root Cause

- **Immediate cause**:
  - The dashboard's link detection (`ui/src/components/Terminal.tsx:260-262` with `@xterm/addon-web-links` 0.12.0) joins rows only through `isWrapped` (`WebLinkProvider.ts:124,142`).
  - A multi-row URL rendered by Claude Code reaches the browser as hard rows (`isWrapped=F`) with no OSC 8. As a result, `window.open` receives the first-row fragment and continuation rows are not links. Evidence: `repro.sh` case 1, `row 10 ... len=78 -> window.open("...abcdefghijklmnopqrstu")` and `row 11: NO LINK`.
  - OSC 8 is missing because tmux's bridge attach client lacks the `hyperlinks` feature (`termfeatures=bpaste,ccolour,clipboard,cstyle,focus,RGB,title`; `bridge/src/tmux.ts:68-86`), and because the bridge never sets `FORCE_HYPERLINK` (`bridge/src/xterm-theme.ts:31-40`).
- **Architectural root**: the browser shows the rendered grid of tmux plus an agent TUI. Logical-line and link information has to travel end to end (OSC 8) or be rebuilt in the UI, and the stack does neither.
- Rejected H1 (tmux alone): single-write and redrawn URLs inside tmux keep `isWrapped=T` and open in full, and Claude's failure happens with no tmux at all. tmux contributes only through the bottom-row split-write case.
- Rejected H2 (Claude Code alone): Claude does hard-wrap. But its raw output (with `FORCE_HYPERLINK=1`) carries the full URL in OSC 8 on both rows, which xterm opens. Plain-shell output fails the same way without Claude.
- Rejected H3 (snapshot loses wrap flags): the serialize round trip keeps `T` and `F` exactly, and live bytes already fail. Side note: it does drop OSC 8.
- Rejected H4 (click handler or popup): the handler opens exactly the URI that detection supplies, synchronously in mouseup. It gets the full URL when the rows are joined.
- Falsification: isolation (only the row-join signal varies, and the outcome follows it) and counterfactual (adding OSC 8 through tmux opens the full URL on both hard rows). The hypothesis survived both.

Not verified:
- No real browser was used. Clicks were simulated with the shipped addon on `@xterm/headless` 6.0.0, which has the same core as `@xterm/xterm` 6.0.0, together with a reading of the Linkifier and OscLinkProvider source.
- I did not observe at runtime whether Claude Code emits OSC 8 in the default ftown env (no `FORCE_HYPERLINK`). The single allowed TUI run used `FORCE_HYPERLINK=1`.
  - Its `fb()` check returns false for `TERM_PROGRAM=Apple_Terminal`.
  - Its `pb()` link wrapper also has an `assumeSupport` path that could emit OSC 8 anyway.
  - Either way, tmux strips it today.
  - To check: run `claude --continue` in `ml-links-exp/ccwork` without `FORCE_HYPERLINK`, under `pipe-pane -O`, then grep for `ESC]8;id=`.
- The production `TERM_PROGRAM` was taken from this investigation's own ftown session (`TMUX=/private/tmp/tmux-501/ftown,...`, `TERM_PROGRAM=Apple_Terminal`). I did not read it from the bridge process.
- Codex, opencode, cursor-agent and pi were not tested. Their row layout and OSC 8 behaviour are unknown.

## Fix options (for the manager)

Ranked by recommendation. Every option should come with a regression test. It can replay the recorded fixtures (`ml-links-exp/cc-pane-raw.bin` and `repro2.bin`) into a headless xterm and assert that the full URL is activated from every row.

### 1. Enable OSC 8 end to end (fixes the dropped channel itself)

- **Change**:
  - **tmux.** In `bridge/src/tmux.ts` `tmuxConfigPath()`, add `set -as terminal-features ',xterm*:hyperlinks'`. The attach client's TERM is `xterm-256color` (`claude-runner.ts:320`).
    - The config is only read when the server starts (`tmux.ts:64-65`), and features are fixed when a client attaches.
    - So for servers already running, also run `tmux -L ftown set -as terminal-features ...` at bridge start, then re-attach the clients.
  - **Session env.** Set `FORCE_HYPERLINK=1` unless the user already set it, either in `applyTerminalColorEnv` (`bridge/src/xterm-theme.ts:31`) or in `buildEnv` (`claude-runner.ts:236`). This makes Claude Code's `fb()` return true every time. I verified that Claude then emits `ESC]8;id=…;<full URL>BEL` on every hard row.
  - **UI.** In `ui/src/components/Terminal.tsx` (`new XTerm({...})` at line 220), set `linkHandler: { activate: (_e, uri) => window.open(uri, "_blank", "noopener,noreferrer"), allowNonHttpProtocols: false, hover/leave: show the target URI }`.
    - Without this, xterm's `defaultActivate` opens a `confirm()` dialog (`OscLinkProvider.ts:114-115`).
    - OSC links take priority over WebLinksAddon, because `OscLinkProvider` is registered first (`CoreBrowserTerminal.ts:160`) and the Linkifier follows provider order.
- **Fixes**:
  - Claude Code: verified by replay, where both rows open the full URL.
  - Any CLI that honours `FORCE_HYPERLINK` or supports-hyperlinks.
- **Does not fix**:
  - Programs that never emit OSC 8: plain `echo`, and the plain-shell bottom-row split write.
  - Other agents: not verified.
- **Risks**:
  - `SerializeAddon` 0.14.0 drops OSC 8, so after a reload or re-attach the snapshot has no links until tmux does a full redraw.
    - The UI's switch-in resize bounce (`Terminal.tsx:176-184`, `:405-408`) triggers such a redraw, and tmux sends OSC 8 again from its grid (verified).
    - Headless-only consumers (`getScreen`, `renderRawLogToText`) never get links.
  - OSC 8 can show text that differs from the target, which allows link spoofing. Show the URI on hover and keep the http/https filter.
  - Other tools in sessions will start emitting OSC 8, so raw logs will contain more escape sequences.
  - Running tmux servers need the runtime `set`.

### 2. A UI link provider that joins hard-wrapped rows (heuristic, covers producers without OSC 8)

- **Change**:
  - Add a new `ILinkProvider`, for example `ui/src/lib/terminal-links/hard-wrap-link-provider.ts` with a unit test, registered in `Terminal.tsx` next to (or instead of) WebLinksAddon at line 260.
  - Heuristic, taken from the observed rows:
    - **Row N** holds a URL match (same `strictUrlRegex` as the addon) that is the last text on the row. The match ends at column ≥ `cols − 2`. Observed:
      - Claude reply: ends at 80/80.
      - Claude prompt echo: ends at 79/80, then a padding space.
      - tmux split: ends at 60/60.
      - Trailing padding spaces are allowed.
    - **Row N+1** starts with exactly `k` spaces, where `k` is the column where row N's text block starts after its gutter. Observed:
      - Claude reply: `k=2`, after the `⏺ ` gutter.
      - Claude prompt echo: `k=2`.
      - Plain shell: `k=0`.
      - The spaces are followed directly by URL-legal characters up to the first whitespace.
      - `isWrapped` is ignored.
    - **Repeat** for N+2 and later rows while the rule holds, capped at 2048 characters as in the addon.
    - **Join** by stripping the indent and concatenating. The result must pass `new URL()` and the addon's `isUrl` prefix check.
    - **Links.** Return one `ILink` per row fragment, with the indent cells left out of the range, all carrying the full URL text. Cell widths are mapped as in the addon's `_mapStrIdx`.
    - **Activate** with `window.open(uri, "_blank", "noopener,noreferrer")`.
    - Soft-wrap joining stays as it is.
- **Fixes**:
  - Claude Code, without needing OSC 8.
  - The plain-shell bottom-row split.
  - Probably other TUIs with a fixed gutter.
  - Links survive snapshots and reloads, because this works on plain text only.
  - No bridge or tmux change is needed.
- **Risks**:
  - False joins. A URL can end exactly at the wrap edge while the next line is ordinary indented prose (for example `  and…`), which would add a word to the URL.
  - Gutter width varies by agent, so `k` has to be inferred per row, not hard-coded.
  - Wide characters or emoji in the gutter shift columns.
  - The heuristic has to be maintained as TUIs change.

### 3. Both: option 1 as the exact path, option 2 as the fallback (recommended end state)

- **Change**: everything in options 1 and 2. Register the joining provider after xterm's OSC provider, so an OSC 8 link always wins on rows that have one and the heuristic applies only where no OSC 8 exists.
- **Fixes**: Claude Code exactly, including after a tmux redraw. Agents without OSC 8, plain-shell splits, and post-reload snapshots go through the heuristic.
- **Risks**: the union of 1 and 2. Two code paths need tests: OSC 8 fixtures and hard-wrap fixtures.

Suggested order: ship option 1, the smallest change, which is exact for Claude Code. Add option 2 if links from non-OSC-8 agents or plain shells matter, or if links have to keep working on snapshots after reload.

## Fix

Option 2 shipped: the UI joins hard-wrapped rows. It was chosen over option 1 because the bridge snapshot path (`SerializeAddon` 0.14.0) drops OSC 8 (see H3). Labelled OSC 8 links would lose their target after a reload, while a join based on text survives snapshots.

- **`ui/src/lib/terminal-link-types.ts`** (new): the frozen contract.
  - `TERMINAL_URL_REGEX` is identical to the addon's `strictUrlRegex`.
  - `TERMINAL_LINK_EDGE_SLACK = 0` and `TERMINAL_LINK_MAX_INDENT = 8`.
  - `TERMINAL_LINK_MAX_URL_LENGTH = 2048`.
  - Buffer types are structural, so `term.buffer.active` and test fakes can both be passed.
- **`ui/src/lib/terminal-links.ts`** (new): `findTerminalLinks(buffer, y)`. Traces to the root-cause clause "WebLinksAddon joins rows only via `isWrapped`" (`WebLinkProvider.ts:124,142`).
  - It ports the addon's soft-wrap window.
  - It adds a hard-wrap join for the layout observed in H2 and in Reproduction case 2:
    - The URL run must fill the row's last cell.
    - The next row's indent `k` must satisfy `k ≤ 8` and `k ≤` the column where the run began. Claude uses `k=2`; a plain shell uses `k=0`.
  - It returns one link per fragment. Every fragment carries the full URL, and the range leaves out the indent cells.
- **`ui/src/components/Terminal.tsx:260-271`**: `term.registerLinkProvider({ provideLinks })` calls `findTerminalLinks(term.buffer.active, …)` and opens with `window.open(link.url, "_blank")`. It replaces `new WebLinksAddon(...)`, the detector named in the immediate cause. The provider is disposed on unmount (`Terminal.tsx:388`).
- **`ui/package.json` and `ui/package-lock.json`**: the `@xterm/addon-web-links` dependency is removed. Its only use was replaced.
- **Regression tests**:
  - `ui/src/lib/terminal-links.test.ts` (22 tests): pure-function cases for soft wrap, hard wrap and the edge and indent rules.
  - `ui/src/components/Terminal.links.test.tsx` (3 tests): the component-level regression. According to the coordinator, it fails on origin/main with the truncated `…abcdefghijklmnopqrstu` and passes on the patched tree.
- **Justification for fixing at the symptom level**: the architectural root (Why 5) is that the dashboard renders a TUI cell grid without link metadata. This fix rebuilds the URL from text at the UI boundary instead of restoring the metadata channel. The end-to-end OSC 8 fix is deferred; see Resolution, Follow-up.

## Resolution

- **Diff summary**:
  - Two files are new: `terminal-link-types.ts` (63 lines) and `terminal-links.ts` (282 lines).
  - Two test files are new: 253 and 141 lines.
  - `Terminal.tsx` changes by +14/−4: WebLinksAddon is swapped for `registerLinkProvider(findTerminalLinks)` and the provider is disposed on unmount.
  - `ui/package.json` drops `@xterm/addon-web-links`.
  - No bridge or tmux changes.
- **Verification: repro.** I re-ran `ml-links-exp/repro.sh` on 2026-11-04 at 08:36 -03:00, through tmux 3.6a with the bridge's tmux.conf and a bridge-style node-pty client.
  - The same headless buffers were then scanned with the landed `findTerminalLinks`. The `.ts` files were transpiled read-only with `ui/node_modules/typescript` by `ml-links-exp/compile-fix.js`, and the scan ran through `ml-links-exp/analyze-fix.js`.
  - Before, with the addon:
    ```
    row  10: link range y11x3..y12x0 len=78 -> window.open("https://example.com/ftown/multiline-link-test/0123456789/abcdefghijklmnopqrstu")
    row  11: NO LINK (hover/click does nothing)
    row  16: link range y17x3..y18x0 len=58 -> window.open("https://example.com/ftown/multiline-link-test/0123456789/a")
    row  17: NO LINK (hover/click does nothing)
    row  18: NO LINK (hover/click does nothing)
    ```
  - After, with `findTerminalLinks`:
    ```
    == case 1 (fix): Claude Code reply via tmux
    row   7: range y8x3..y8x79 len=77 -> open("https://example.com/ftown/multiline-link-test/0123456789/abcdefghijklmnopqrst")
    row   8: NO LINK
    row  10: range y11x3..y11x80 len=149 -> open("https://example.com/ftown/multiline-link-test/0123456789/abcdefghijklmnopqrstuvwxyz/0123456789/abcdefghijklmnopqrstuvwxyz/path-segment-x?q=END-OF-URL")
    row  11: range y12x3..y12x73 len=149 -> open("https://example.com/ftown/multiline-link-test/0123456789/abcdefghijklmnopqrstuvwxyz/0123456789/abcdefghijklmnopqrstuvwxyz/path-segment-x?q=END-OF-URL")
    == case 2 (fix): plain shell chunked bottom-row
    row  16: range y17x3..y17x60 len=149 -> open("https://example.com/ftown/...path-segment-x?q=END-OF-URL")
    row  17: range y18x1..y18x60 len=149 -> open("https://example.com/ftown/...path-segment-x?q=END-OF-URL")
    row  18: range y19x1..y19x31 len=149 -> open("https://example.com/ftown/...path-segment-x?q=END-OF-URL")
    ```
  - The soft-wrap controls are unchanged: `cap-direct.bin`, `cap-tmux-live.bin` and `cap-tmux-reattach.bin` all open the full 149 characters from every row.
  - The reported symptom is gone. The Claude Code reply opens the full URL from both rows, and a plain-shell split opens it from all three rows.
  - **Residual (not covered).** Rows 7 and 8 are Claude Code's echo of the user's prompt. That URL run ends at column 79 of 80, followed by a padding space, because the echo box wraps at 78 inside a 2-column gutter. With `TERMINAL_LINK_EDGE_SLACK = 0` it is still truncated to 77 characters. Assistant output, which is what the user clicks, is fixed.
- **Verification: tests.**
  - `ui/node_modules/.bin/vitest run src/lib/terminal-links.test.ts src/components/Terminal.links.test.tsx` gives `Test Files 2 passed (2)` and `Tests 25 passed (25)`.
  - Fails before: reported by the coordinator, who ran `Terminal.links.test.tsx` on origin/main and saw the truncated `…abcdefghijklmnopqrstu`. I did not re-run it, because reverting source was out of scope for this log.
  - Full UI suite (1125/1125) and `tsc` (exit 0): reported by the coordinator; they will confirm.
- **Follow-up**:
  - **OSC 8 end to end** (Fix option 1) is deferred. `SerializeAddon` 0.14.0 drops OSC 8, so after a reload or re-attach the snapshot would hold labelled links with no target until tmux does a full redraw. Doing it needs:
    - `terminal-features ',xterm*:hyperlinks'` in `bridge/src/tmux.ts`;
    - `FORCE_HYPERLINK=1` in the session env;
    - an http/https-only `linkHandler`;
    - a way to keep OSC 8 in the snapshot.
  - **Known residual false joins**: a prose word right after a URL that exactly fills the row is joined into the URL. For example, the next row reads `  and then…` with an indent no deeper than the URL's start column.
  - **Prompt-echo layout**: as described above, the URL ends one cell short of the edge. `TERMINAL_LINK_EDGE_SLACK = 1` would cover it, at a slightly higher risk of false joins.
  - **Other agents** (Codex, opencode, cursor-agent, pi): row layout still unverified.
- **Cleanup**: the `ftown-mldebug` tmux server is gone. It exits when empty, and the final `kill-server` reported `no server running on /private/tmp/tmux-501/ftown-mldebug`.
