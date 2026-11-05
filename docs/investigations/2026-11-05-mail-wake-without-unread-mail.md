---
type: investigation
symptom: "ftown-mail Claude Code plugin wakes a session with 'You have unread FTown mail. Run ftown harness mail read', and that read returns (no mail)"
slug: mail-wake-without-unread-mail
date: 2026-11-05T07:45:06-03:00
git_commit: 40cac7b1f2e6e2c9ea97eff08f25e9d05b81ac75
branch: fix/mail-wake-no-mail
status: resolved
hypotheses_formed: 5
hypotheses_rejected: 4
hypotheses_proven: 1
---

# Plugin mail wake followed by an empty `mail read`

Investigation only. No application, test, Git or runtime state was changed. Production
bridge (PID 80748) was not touched. No `mail read`, `mail send` or `ftown-harness send` ran
against real sessions. Live data was only read: transcripts, inbox metadata (ids,
timestamps, `deliveredAt`/`deliveredVia`; no bodies quoted beyond system PR headings)
and installed files. Scratch work: `/private/tmp/claude-501/-Users-fkesheh-projects-ftown/99a20ec3-eacc-48b8-849e-8dba56f1eaba/scratchpad/mailwake-exp/`.

## Symptom

**Observed** (verbatim, user paste from the Claude Code session "2 q", an orchestrator):

```
› Prompt from the ftown-mail plugin
❯ [ftown mail] You have unread FTown mail. Run ftown harness mail read and handle the messages. Reply with ftown harness mail send ... where appropriate.
  Ran 2 shell commands
There was no new mail: ftown harness mail read returned "(no mail)". The plugin probably re-notified about the repair message I sent the worker, which it has already picked up.
```

The user also asked "why we didn't send the full message and why there was no email?"

**Expected:** a wake that says "You have unread FTown mail. Run `mail read`" fires only when
that `mail read`, in the same session, returns at least one message.

**Delta:** the wake said there was unread mail and the read found none. No mail is shown
to be lost. The agent guessed the wake was about its own outgoing message. That guess is
H2 below, and it is rejected.

**Where "2 q" ran:** not on this machine. `ftown-harness ls` has no such session. No
`session.json` in `~/.ftown/data/sessions/` (853 sessions) or `archive.jsonl` is named
"2 q". `SCM-843` and "re-notified" appear only in the coordinator's own transcript
(`ftown_4`, Claude session `99a20ec3…`), where the user pasted them. That session's
transcript and inbox could not be inspected. The same symptom does occur on this machine,
with the same code as main, and that occurrence is what proves the cause (H1).

## Versions (this machine compared with origin/main)

| Item | Installed | origin/main 40cac7b |
| --- | --- | --- |
| bridge package | `~/.ftown/cli/package.json` `"version":"0.20.1"`, `gitHead 825bd2e` (#178) | `bridge/package.json` `0.20.2` |
| running bridge | PID 80748 `node ~/.ftown/cli/dist/ftown-cli.js start`, started 2026-11-03 10:55:50 -03 | — |
| plugin `register.js` | `~/.ftown/claude-plugin/hooks/register.js` SHA-256 `58117a4c…a963f` (same for `~/.ftown/cli/claude-mod/…`) | `bridge/claude-mod/hooks/register.js` SHA-256 `58117a4c…a963f`, identical |
| 2026-10-27 fix (#149, `ce62d9d`) | contained: `git merge-base --is-ancestor ce62d9d 825bd2e` succeeds. Installed `dist/mail-delivery.js:18` has the hook-aware `MAIL_WAKE_TEXT` | contained |
| mail-relevant diff 825bd2e..40cac7b | `mail-store.ts`: `mkdir(dir, { recursive: true })` → `mkdir(dir, { recursive: true, mode: 0o700 })` only; `local-api-server.ts` diff has no mail/inbox/hook/wake change | — |

`git log -L3,3:bridge/claude-mod/hooks/register.js` lists only `8157ab6 2026-10-18 Prefer native
adapters for mail wakeups (#121)`. The WAKE line has not changed since the plugin was
introduced. `git show --stat ce62d9d` touches `bridge/src/mail-delivery.ts` and
`mail-delivery.test.ts`, and not `bridge/claude-mod/`.

## Reproduction

### R-runtime: real occurrences on this machine, same code as main (read-only)

Only one local Claude transcript contains plugin wakes:
`~/.claude/projects/-Users-fkesheh-projects-prive/ac5e9a64-00fb-4d14-8733-cecf2792df52.jsonl`
(ftown session `prive_1` `cc06db19…`, `claudeSessionId ac5e9a64…`). The classifier
`mailwake-exp/wakes.py` printed:

```
$ python3 -I wakes.py ~/.claude/projects/-Users-fkesheh-projects-prive/ac5e9a64-….jsonl
total wakes 11
10 ('new-turn prompt', 'hook-supplied-mail', 'empty-read')
1 ('new-turn prompt', 'no-hook-mail', 'read-got-mail')
```

Here is the first wake, record by record. Bodies are truncated to the system PR heading.

```
10369 11:09:26.783 system stop_hook_summary  [notify.sh, ftown-harness hook-pump]   <- previous turn ended, idle
10371 11:11:10.828 queue-operation enqueue:[ftown mail] You have unread FTown mail. Run `ftown harness …
10372 11:11:10.836 queue-operation dequeue
10373 11:11:10.849 user str:The ftown-mail plugin sent a message: [ftown mail] You have unread FTown mail. …
10374 11:11:11.030 attachment hook_additional_context: "[ftown mail]\n[2026-11-03T11:11:06.691Z] FTown PR updates (message): GitHub rollup checks passed. …"
10376        api-request-blob text: UserPromptSubmit hook additional context: [ftown mail] …
10384 11:11:14.495 assistant tool_use:Bash            (ftown harness mail read)
10385 11:11:15.425 user tool_result:(no mail)
10394 11:11:24.186 assistant text: "As verificações automáticas do GitHub passaram no PR #156 …"  <- handled the hook-supplied mail
```

The store shows the same order. `inbox.jsonl` metadata, compared with each wake prompt's timestamp:

```
msg ts        wake prompt    deliveredAt (via drain)   dt       first tool result
11:11:06.691  11:11:10.849   11:11:10.995             0.146s   11:11:15.425 empty
11:16:06.775  11:16:19.974   11:16:35.521             15.547s  11:16:24.374 not-empty   <- control, see C2
11:17:28.251  11:17:31.062   11:17:31.277             0.215s   11:17:44.526 empty
11:56:38.819  11:56:42.363   11:56:42.515             0.152s   11:56:48.791 empty
13:06:49.334  13:06:49.669   13:06:49.856             0.187s   13:07:09.801 empty
13:26:52.020  13:26:55.433   13:26:55.571             0.138s   13:27:00.593 empty
16:17:02.429  16:17:02.633   16:17:02.773             0.140s   16:17:10.418 empty
16:50:06.529  16:50:08.770   16:50:08.917             0.147s   16:50:13.209 empty
17:50:08.886  17:50:10.454   17:50:10.626             0.172s   17:50:25.713 empty
23:26:22.275  23:26:22.811   23:26:22.951             0.140s   23:26:26.888 empty
08:35:18.557  08:35:20.092   08:35:20.270             0.178s   08:35:27.096 empty
```

In all 10 empty cases the message was marked `deliveredVia: drain` 138–215 ms after the
wake prompt was submitted. That is the wake's own `UserPromptSubmit` hook
(`~/.ftown/bin/ftown-harness hook-pump`, installed in `~/.claude/settings.json` for
`Stop`, `UserPromptSubmit` and `SessionStart`). The drain happened seconds before the
model ran the `mail read` that the wake told it to run. The TUI shows only the pointer,
not the hook context. `prive_1`'s `terminal.log` renders
`› Prompt from the ftown-mail plugin ❯ [ftown mail] You have unread FTown mail…` and then
`Ran 1 shell command`, the same shape as the "2 q" paste.

### R-isolated: deterministic in-process reproduction (actually run)

`mailwake-exp/repro.mts` imports the real `bridge/claude-mod/hooks/register.js`,
`src/security/bridge/native-wake.ts` (`nativeWake`), `src/mail-delivery.ts`
(`MailDeliveryService`) and `src/mail-store.ts` (`MailStore` on a scratch directory) from
this worktree. Claude Code's `$` is faked. `prompt.submit` enqueues, and dequeues when the
session is idle, as in the transcript above. The classic hook pump and `ftown harness mail
read` both call `fetchInbox(wait:0)` without peek (`harness-commands.ts:425,515,533`), and
that call reaches `mail.readMail({wait:0, peek:false})`. The repro calls that same bridge
method and prints what the CLI would print (`harness-commands.ts:435-436`).

```
$ cd <WT>/bridge && npm ci --ignore-scripts && node --import tsx <scratch>/mailwake-exp/repro.mts
plugin WAKE (register.js:3): "[ftown mail] You have unread FTown mail. Run `ftown harness mail read` and handle the messages. …"
bridge MAIL_WAKE_TEXT (mail-delivery.ts:21, the 2026-10-27 hook-aware text): "FTown mail may be available. If this prompt's hooks supplied [ftown mail], process that mail without reading it again. Otherwise run `ftown harness mail read` once; if no mail is returned, no action is needed."
[C1-own-send] orch sent mw3f3zlv-2ddab9 to worker; orch undelivered=0, worker undelivered=1
[C1-own-send] heartbeat 1: FtownNativeWake -> messages=[]
[C1-own-send] heartbeat 2: FtownNativeWake -> messages=[]
[C1-own-send] heartbeat 3: FtownNativeWake -> messages=[]
[C1-own-send] RESULT {"wakeTurns":0,"heartbeats":3,"ptyWrites":0}
[S1-idle] worker -> orch mw3f3zm7-f6fc9a
[S1-idle] heartbeat 1: FtownNativeWake -> messages=["mw3f3zm7-f6fc9a"]
[S1-idle] queue-operation enqueue: [ftown mail] You have unread FTown mail. Run `ftown harness ...
[S1-idle] queue-operation dequeue (idle)
[S1-idle] turn: prompt=PLUGIN WAKE; UserPromptSubmit hook-pump additionalContext=[ftown mail] x1 (mw3f3zm7-f6fc9a)
[S1-idle] heartbeat 2: FtownNativeWake -> messages=[] (agent marked busy)
[S1-idle] turn: model runs `ftown harness mail read` -> (no mail)
[S1-idle] heartbeat 3: FtownNativeWake -> messages=[]
[S1-idle] RESULT {"wakeTurns":1,"heartbeats":3,"ptyWrites":0}
[S2-busy] orch turn in progress (UserPromptSubmit/PreToolUse marked busy)
[S2-busy] worker -> orch mw3f3zma-a32a96 while orch is busy
[S2-busy] heartbeat 1: FtownNativeWake -> messages=["mw3f3zma-a32a96"] (agent marked busy)
[S2-busy] queue-operation enqueue: [ftown mail] You have unread FTown mail. Run `ftown harness ... (busy: waits for idle)
[S2-busy] heartbeat 2: FtownNativeWake -> messages=["mw3f3zma-a32a96"] (agent marked busy)
[S2-busy] orch finishes its turn
[S2-busy] Stop hook-pump: decision=block with [ftown mail] x1 (mw3f3zma-a32a96); model handles it in the same turn
[S2-busy] queue-operation dequeue (idle)
[S2-busy] turn: prompt=PLUGIN WAKE; UserPromptSubmit hook-pump additionalContext=none
[S2-busy] turn: model runs `ftown harness mail read` -> (no mail)
[S2-busy] heartbeat 3: FtownNativeWake -> messages=[]
[S2-busy] heartbeat 4: FtownNativeWake -> messages=[]
[S2-busy] RESULT {"wakeTurns":1,"heartbeats":4,"ptyWrites":0}
[C2-no-pump] worker -> orch mw3f3zme-39985b
[C2-no-pump] heartbeat 1: FtownNativeWake -> messages=["mw3f3zme-39985b"]
[C2-no-pump] queue-operation enqueue: [ftown mail] You have unread FTown mail. Run `ftown harness ...
[C2-no-pump] queue-operation dequeue (idle)
[C2-no-pump] turn: prompt=PLUGIN WAKE; UserPromptSubmit hook-pump additionalContext=none
[C2-no-pump] turn: model runs `ftown harness mail read` -> [2026-11-05T10:43:43.766Z] worker (message): ack: picked up repair round 2
[C2-no-pump] heartbeat 2: FtownNativeWake -> messages=[] (agent marked busy)
[C2-no-pump] RESULT {"wakeTurns":1,"heartbeats":2,"ptyWrites":0}
```

The full output is saved at `mailwake-exp/repro-output.txt`. Both bad schedules (S1 and
S2) reproduce every time. Both controls (C1 and C2) behave as expected.

## Hypotheses

### H1 — the classic hook pump drains the inbox before the read the wake asks for (PROVEN)

- **Layers:** plugin prompt contract (`claude-mod`) and Claude hook integration (`hook-pump`).
- **Prediction:** the plugin wakes only for a real undelivered ID. The same Claude session
  also runs `ftown-harness hook-pump` on `UserPromptSubmit` and `Stop`, and that hook drains
  the inbox without peeking. So the message is already `deliveredAt` when the model runs the
  `mail read` that `register.js:3` requires. There are two schedules:
  - S1, idle: the wake's own `UserPromptSubmit` pump drains the message and injects it as
    hidden `additionalContext`.
  - S2, busy: the wake waits in Claude's queue, and the `Stop` pump (or an in-turn read)
    drains the message first.
- **Verification:** source trace, real transcript and store correlation, isolated
  reproduction.
- **Evidence:**
  - `bridge/claude-mod/hooks/register.js:3`: `const WAKE = '[ftown mail] You have unread FTown mail. Run \`ftown harness mail read\` and handle the messages. …'`.
    The read instruction is unconditional.
  - `register.js:104-113`: `const fresh = ids.filter((id) => !handled.has(id)); if (!fresh.length || pending || …) return; … return $.prompt.submit({ text: WAKE });`
    The only check before submitting is the heartbeat snapshot. Lines 109-110 note that
    submit "waits for idle". Nothing checks whether the agent is busy, and nothing re-checks
    the inbox when the queued prompt is dequeued.
  - `bridge/src/security/bridge/native-wake.ts:18`: `return { messages: (await dependencies.unread(session.id)).slice(0, 500)…`
    That calls `listUndelivered` (`local-api-server.ts:1363`) and never consults the
    busy marker that `local-api-server.ts:1385` maintains.
  - `bridge/src/hook-installer.ts:6`: `const MAIL_PUMP_EVENTS = ['Stop', 'UserPromptSubmit', 'SessionStart']`.
    Installed live: `UserPromptSubmit /Users/fkesheh/.ftown/bin/ftown-harness hook-pump`
    and `Stop …hook-pump`.
  - `bridge/src/harness-commands.ts:533-543`: the `UserPromptSubmit` branch runs
    `fetchInbox(pointer, sessionId, { wait: 0, … })` (no peek), then
    `additionalContext: \`[ftown mail]\n${formatted}\``.
    `:510-530`: the `Stop` branch drains and returns `decision: 'block'`.
  - `mail-delivery.ts:407-416`: a non-peek read calls `markDelivered(…, 'drain')`.
  - `harness-commands.ts:435-436`: an empty result prints `(no mail)`.
  - Runtime: 10 of 11 real wakes on this machine follow S1 (tables above). Each message was
    `drain`ed 138–215 ms after the wake prompt, and every one of those reads printed
    `(no mail)`.
  - Isolated: S1 and S2 both end with `model runs \`ftown harness mail read\` -> (no mail)`.
- **Verdict:** PROVEN. Both schedules come from one mechanism: two consumers of one inbox,
  plus a pointer that states unread mail exists and tells the model to read it. Which
  schedule "2 q" hit cannot be observed from this machine; see Open risks.

### H2 — the wake is triggered by the session's own outgoing mail (REJECTED)

- **Layer:** bridge mail routing and store.
- **Prediction:** `mail send` from 2 q leaves a record in 2 q's own inbox (a sent copy,
  receipt or bounce), and the next heartbeat lists it.
- **Evidence:**
  - `harness-commands.ts:404-409`: the body is `{ body, from: self, fromName }`, sent to
    `targetId`.
  - `mail-delivery.ts:337-338`: `createMailMessage({ from, fromName, to: session.id, … }); await this.mailStore.append(msg)`,
    where `session` is the target.
  - `mail-store.ts:122-128`: the message is appended under `msg.to` only.
  - `native-wake.ts:16-18`: lists only the verified caller's own `session.id`.
  - The inbox producers are `acceptMail` callers (`local-api-server.ts:315,1257,1263,1284,1305`)
    and `commitPullRequestObservation`. None of them writes to the sender.
  - Repro C1: `orch undelivered=0, worker undelivered=1`, 3 heartbeats `messages=[]`,
    `wakeTurns:0`.
- **Verdict:** REJECTED. Every wake corresponds to a real message addressed to the woken
  session. In 2 q that message could have been a worker reply, a reviewer result, a PR
  event, or the bridge's own `Child session … has been idle for 120 seconds` notice
  (`local-api-server.ts:1284-1285`). The agent's guess only reflects that the pump had
  already removed the evidence.

### H3 — a stale unread counter or cursor in the plugin fires for already-consumed IDs (REJECTED)

- **Layer:** plugin state machine.
- **Prediction:** `handled`/`pending`/`blockedSignature` drift so that the plugin wakes for an
  ID that is no longer undelivered.
- **Evidence:**
  - `register.js:91-93,104`: `fresh` is computed only from IDs present in the current
    heartbeat's `listUndelivered`, and `handled` is pruned to that set.
  - The drop and unknown paths (`:116-128`) only suppress or back off; they never submit.
  - In S1 and S2 the submit resolves `{text}` (accepted), so neither path runs. In the real
    transcript the `enqueue`/`dequeue` pair is normal.
  - After the drain, every later heartbeat returns `[]` and no second wake follows (S1
    heartbeat 3, S2 heartbeats 3–4).
- **Verdict:** REJECTED. The wake is correct at poll time. Consumption after the poll makes
  the instructed read empty.

### H4 — the hook and `mail read` resolve different session identities (REJECTED)

- **Layer:** env, identity and integration.
- **Prediction:** the plugin heartbeat, the pump and the CLI read address different inboxes.
- **Evidence:**
  - The plugin sends `ftown_session_id: FTOWN_SESSION_ID` plus the native ID
    (`register.js:32,72`). The bridge rejects any mismatch (`native-wake.ts:16`).
  - The pump uses `FTOWN_SESSION_ID` first (`harness-commands.ts:476-477`). The CLI read
    does the same (`:367-369`).
  - In the real control, the 11:16:19Z prive wake, both pumps failed. The model's
    `ftown harness mail read` first hit
    `ftown harness: Bridge not running (no valid /Users/fkesheh/.ftown/bridge.json…`. Its
    retry returned the very message the wake was about
    (`[2026-11-03T11:16:06.775Z] FTown PR updates (message): Pull request me…`,
    `deliveredAt 11:16:35.521 drain`). So the read and the wake address the same inbox.
  - Repro C2 shows the same: with the pump off, the read returns `ack: picked up repair round 2`.
- **Verdict:** REJECTED as a cause of the reproduced schedules.

### H5 — version skew: the installed bridge or plugin is older than the 2026-10-27 fix (REJECTED)

- **Layer:** configuration and version.
- **Prediction:** current main no longer shows the symptom, and only an old install does.
- **Evidence:**
  - The installed bridge 0.20.1 contains `ce62d9d`, and the installed plugin is
    byte-identical to main (Versions table).
  - The WAKE line has been unchanged since `8157ab6` (#121, 2026-10-18), which is the
    commit that introduced the plugin. Any build that can show "Prompt from the
    ftown-mail plugin" therefore carries this exact text.
  - The isolated reproduction runs main's code.
- **Verdict:** REJECTED. This is not skew. The 2026-10-27 fix never covered this path.

## Relation to earlier investigations

- **2026-10-27 stale-mail-notification (#149):** a different path. That bug was the
  bridge-side Codex native wake being queued while busy. The fix added
  `isAgentRecentlyBusy` gating and the hook-aware `MAIL_WAKE_TEXT` in `mail-delivery.ts`
  (`:21`, `:493-496`, `:598-601`). Its frozen contract (`2026-10-27-stale-mail-notification.md:72`)
  scoped the text to Codex: "Codex PTY fallback must use the same conditional instruction;
  other harness fallbacks retain behavior". The Claude plugin keeps its own copy of the
  pointer text (`register.js:3`). Its heartbeat path (`native-wake.ts`) has no busy gate.
  This symptom is therefore a case the fix did not cover, not a regression. The pre-fix
  bridge already stands aside while the plugin holds a lease
  (`mail-delivery.ts:596-597`), so the plugin is the only waker for these sessions.
- **2026-10-28 empty-mail-nudges:** the same family. It proved H2 there ("current Claude
  Mod retains a queued pointer after its inbox is consumed") with a mocked heartbeat, which
  is this log's S2. It proposed the hook-aware wording and a pending-submit test. That fix
  was never implemented: `register.js` is unchanged since `8425849` (2026-10-25). This log
  adds three things:
  - S1 is deterministic, not a race. On this machine it accounts for 10 of 11 real wakes,
    because the wake's own `UserPromptSubmit` pump drains the mail.
  - Real store and transcript evidence on current code.
  - A reproduction against the real bridge modules, not a mocked heartbeat.

## 5 Whys

1. **Why did `mail read` print `(no mail)`?** The message the wake was about had already
   been marked `deliveredAt` (`deliveredVia: drain`) by `ftown-harness hook-pump`. In S1 the
   wake's own `UserPromptSubmit` hook did it, about 0.15 s after submission, as seen on this
   machine. In S2 the `Stop` hook did it while the wake waited in Claude's queue.
2. **Why did the wake still demand a read?** `register.js:3` hard-codes "You have unread
   FTown mail. Run `ftown harness mail read`". The plugin is pointer-only by design
   (`register.js:1-2`; `native-wake.ts:8` "no … message body"). It does not account for the
   hook path that delivers the body with that same prompt. It also enqueues while busy and
   never re-checks at dequeue (`register.js:104-113`; `native-wake.ts:18` ignores busy).
3. **Why does the hook drain the same inbox?** FTown keeps the classic mail pump on
   `Stop`/`UserPromptSubmit`/`SessionStart` for every Claude session "for compatibility"
   (`native-mail-delivery/contract.md:25`; `hook-installer.ts:6`). Every launch also loads
   the plugin (`harness-registry.ts:259-260`). The result is two consumers and no
   coordination between them.
4. **Why did the 2026-10-27 and 2026-10-28 work not prevent it?** The fix changed only the
   bridge's own wake constant and busy gate (`ce62d9d` touches only `mail-delivery.ts` and
   its test). The plugin's text is a second literal with no shared source and no parity
   test. The 10-28 follow-up proposed the plugin change but was never implemented.
5. **Design and process root:** the wake contract (a pointer that never consumes) is
   written as a factual claim ("You have unread mail") and duplicated per adapter, while
   the shipped configuration includes a second consumer that always runs first. Tests never
   run that shipped combination. `claude-mod.test.ts` uses a static heartbeat with no pump,
   and `scripts/claude-mod-smoke.mjs:73` writes a `settings.json` with no hooks and asserts
   "busy follow-up must wait for idle" (`:123`). So the empty read was invisible to the
   suite, and S2 is asserted as intended behaviour.

## Falsification

- **If prior consumption were not required, disabling the pump would still produce an
  empty read.** It does not. C2 returns the message, and so does the real 11:16:19Z wake
  where both pumps silently failed.
- **If own outgoing mail could trigger the wake, C1 would wake.** It recorded 0 wakes in 3
  heartbeats, and the sender's inbox stayed empty.
- **If the plugin woke from stale state, it would wake again after the drain.** No second
  wake occurs in S1 or S2. In the real data, each wake maps 1:1 to a distinct message
  (11 wakes, 11 messages).
- **If H1 were wrong about timing, `deliveredAt` would come after the model's read.** In
  all 10 empty cases it precedes the read by 4–20 s and follows the wake prompt by
  138–215 ms. In the one non-empty case, `deliveredAt` equals the model's own successful
  read (11:16:35.521 compared with tool result 11:16:35.580).

## Root Cause

The ftown-mail Claude plugin (`bridge/claude-mod/hooks/register.js:3`, `:104-113`) submits an
unconditional "You have unread FTown mail. Run `ftown harness mail read`" prompt. It does so
into Claude sessions that also run FTown's classic `hook-pump` on `UserPromptSubmit` and
`Stop` (`bridge/src/hook-installer.ts:6`; `bridge/src/harness-commands.ts:510-543`). That pump
drains the same inbox before the model executes the instructed read:

- in the wake's own `UserPromptSubmit` hook when the session is idle (S1, deterministic,
  10 of 11 real wakes on this machine);
- in the `Stop` hook while the wake is queued behind a busy turn (S2). The heartbeat
  (`bridge/src/security/bridge/native-wake.ts:18`) returns undelivered IDs regardless of the
  busy marker.

The hook-aware wording and busy gate from the 2026-10-27 fix live only in
`bridge/src/mail-delivery.ts` (`MAIL_WAKE_TEXT`, `isAgentRecentlyBusy`) and were never
applied to the plugin. The mail is not lost. It reaches the model as hidden hook context in
S1, or as a Stop-hook block in S2, and the TUI shows only the pointer. That answers "why
didn't we send the full message": the plugin deliberately carries no body, and the body
travels in the invisible hook context.

## Proposed fix (sketch only, not implemented)

1. **Hook-aware plugin text** (`bridge/claude-mod/hooks/register.js:3`). Use the bridge's
   conditional wording, for example: "FTown mail may be available. If this prompt's hook
   context includes FTown mail messages, handle them without reading again. Otherwise run
   `ftown harness mail read` once; if it returns no mail, no action is needed."
   - Drop the literal `[ftown mail]` prefix from the prompt itself. The plugin prompt
     begins with `[ftown mail]`, which is the same tag the conditional clause refers to.
   - Keep one source of truth: a test that asserts the plugin text matches the bridge
     constant, or a generated asset.
2. **Busy gate on the heartbeat** (`native-wake.ts` / `local-api-server.ts:1358-1366`).
   While `isAgentRecentlyBusy(session.id)` holds (the same predicate and
   `AGENT_BUSY_STALE_MS` escape as the 10-27 fix), return no IDs, or return `busy: true` and
   have the plugin skip. The `Stop` pump already delivers in-turn mail, and the next idle
   poll covers anything left.
   - Keep the registration lease renewing so the bridge's legacy nudge does not take over.
3. **Out of scope / residual:** a prompt already in Claude's queue cannot be cancelled. A
   user prompt typed at the same moment can still drain first. Item 1 makes that harmless.
   Do not make the plugin consume or carry bodies. That would change the durable-inbox
   contract (`contract.md:25`).

**Regression test that discriminates:** a new `bridge/src/claude-mod.test.ts` case built
like `mailwake-exp/repro.mts`. It uses real `register.js`, `nativeWake`,
`MailDeliveryService` and `MailStore`, and a fake Claude queue that runs the classic
`UserPromptSubmit`/`Stop` pump through `readMail({wait:0,peek:false})`.

- **(a) S2:** mark the session busy (`markAgentBusy`), append mail, poll twice, end the turn
  with the Stop pump draining, then poll twice more. Assert `prompts.length === 0`. Today
  it is 1 (fails); with the busy gate it is 0.
- **(b) S1:** an idle wake whose `UserPromptSubmit` pump supplies the message. Assert the
  submitted text does not unconditionally instruct a read, by parity with `MAIL_WAKE_TEXT`
  and absence of "You have unread". Today it fails.
- **Liveness controls (must stay green):**
  - idle mail with no pump produces exactly 1 wake, and the read returns it (C2);
  - busy mail that the Stop pump cannot drain produces exactly 1 wake after idle;
  - own outgoing mail produces 0 wakes (C1);
  - a fresh later message produces a new wake.
- Update `scripts/claude-mod-smoke.mjs:121-125` (busy follow-up wake) to the deferred
  contract. That smoke also still targets the pre-`8425849` GET-inbox protocol (`:75-81`),
  while the current plugin POSTs `/hook`, so it needs refreshing anyway.

## Open risks / limits

- "2 q" is on another machine or bridge, so its transcript and inbox were not inspected.
  Whether it hit S1 or S2 is inferred:
  - the agent's "There was no new mail" and the busy turn in which it had just sent a
    repair message both fit S2 (Stop pump or an in-turn read consumed the mail while the
    wake was queued);
  - S1 would normally leave the mail visible in hidden context, as in every prive case.
  - Both have the same cause and fix. Confirm with that machine's transcript:
    `queue-operation enqueue` and `dequeue` around the wake, `hook_additional_context`,
    and the inbox `deliveredAt`/`deliveredVia`.
- The reproduction models Claude Code's queue and hooks from transcript records, not a
  live Claude binary. The runtime evidence above covers the real binary for S1.
- A separate issue showed up in the control case. At 2026-11-03T11:16Z `~/.ftown/bridge.json`
  was transiently unreadable, so both pumps exited silently (`harness-commands.ts:544-545`
  swallows all errors) and the agent's first read failed. This is not part of this
  symptom.

## Fix

- `bridge/src/security/bridge/native-wake.ts`: new required `busy(id)` dependency. The heartbeat returns `{ messages, busy: true }` while the session is mid-turn and `{ messages }` otherwise. Registration and `messages` are unchanged, so live sessions still running the old plugin behave as before. Traces to root-cause clause S2: the heartbeat ignored the busy marker.
- `bridge/src/local-api-server.ts`: passes `busy: id => this.mail.isAgentRecentlyBusy(id)`. `bridge/src/mail-delivery.ts` makes that existing 10-27 predicate public.
- `bridge/claude-mod/hooks/register.js`: the wake text is now byte-identical to `MAIL_WAKE_TEXT`, which says to process hook-supplied `[ftown mail]` without rereading and otherwise to read once. A `busy: true` response is ignored with no state change. Traces to clause S1: the wake was unconditional and not hook-aware. Plugin version 1.0.1.
- `docs/investigations/native-mail-delivery/contract.md`: dated amendment.

## Resolution

- Regression tests:
  - `bridge/src/claude-mod.test.ts`, +6: busy skip keeps state, wake text parity, the S2 end-to-end test (real `register.js`, `nativeWake`, `MailStore` and `MailDeliveryService` busy marking, plus a fake Claude queue whose Stop pump drains), and liveness controls. Every zero-wake assertion is guarded by recorded polls that returned the mail id.
  - `bridge/src/security/bridge/security.test.ts`, +3: the `busy` flag, the absent key, and session-id routing.
- On origin/main code, 4 of the new plugin tests fail as intended: busy skip, wake text, S2, and the busy-without-pump control. The busy and routing `nativeWake` cases fail too. With the fix, all pass: `claude-mod.test.ts` 12/12 on 3 runs, and `security.test.ts` plus `mail-delivery.test.ts` 65/65.
- `tsc --noEmit` exits 0. Full bridge suite: 1285 pass and 28 fail with the fix, against 1275 pass and 29 fail on origin/main 40cac7b. No test fails only with the fix; the shared failures are environmental.
- Known limit: Claude Code does not fire `Stop` on a user interrupt (hooks docs, "Stop"). After an Esc with no further input, the busy marker holds until `AGENT_BUSY_STALE_MS` (30 min), so the plugin defers its wake that long. Any new prompt delivers the mail through the `UserPromptSubmit` pump. The bridge's own nudge has had the same limit since 10-27. Possible follow-up: clear busy on `Notification` `idle_prompt`, once it is confirmed that it fires after an interrupt, or use a shorter stale window for the heartbeat.
- Not done: `bridge/scripts/claude-mod-smoke.mjs` still targets the pre-`8425849` GET-inbox protocol and the old busy follow-up wake. It needs a separate refresh.
