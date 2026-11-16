---
type: investigation
symptom: "Stopping a shell session opens Waiting with Session blocked reason exited and hides the terminal"
slug: shell-stop-session-blocked
date: 2026-11-15T17:30:00Z
investigator: Foad Kesheh
git_commit: 6a68d5cca8e5ad52ce1f307585b5a226abd57593
branch: feat/session-handoff
repository: fmktech/ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-11-15-blocked-child-collapsed.md
---

# Stopping a shell opens Session blocked

## Symptom

- **Observed**: On CI run 43739720144, head `6a68d5cca8e5ad52ce1f307585b5a226abd57593`, `direct-transport-e2e (3/3)` failed three tests that share one bridge. `session-lifecycle.spec.ts` dense header: `getByTestId('terminal-header')` stayed hidden while the Waiting tab showed `Session blocked` / `reason: exited` for the shell that the test had stopped. CRUD round-trip: after Stop and Rerun, `.xterm-rows` stayed `" "` and the same Waiting panel was selected, screen tail containing the earlier `echo CRUD...` plus `[lost tty]`. Needs-attention: `Inbox, 0 messages` was absent; the button was `Inbox, 1 waiting`, and the sidebar still showed the CRUD shell as `Blocked: exited` / `Input needed`.
- **Expected**: Stopping a shell moves it to `completed` and leaves the terminal header in place. A shell Stop hook does not add an inbox item. The inbox stays `Inbox, 0 messages` until the test posts its own notices.
- **Delta**: A finished shell is recorded as a failure (`reason: exited`) and raised as human attention titled `Session blocked`, which selects the Waiting tab and counts as inbox waiting.

## Reproduction

1. Push `6a68d5cca8e5ad52ce1f307585b5a226abd57593` and read job `direct-transport-e2e (3/3)` (run 43739720144).
2. Playwright error context for the dense header test, captured at the hidden `terminal-header` assertion:

```
tab "Waiting" [selected]
paragraph: Session blocked
paragraph: "Session blocked id: 33fdc85a-a4a5-47f0-9f5a-6384927c05b0 ... reason: exited ... screen: =(B>c>q (B (B>[lost tty]"
```

3. Needs-attention error context after `postHook(idle, "Stop")`:

```
button "Inbox, 1 waiting"
button "Shell agent Idle mwi3kahq Idle now" 
  text: Session running
  button "Stop"
button "Shell agent crud-long-session-name-... Blocked: exited Input needed now"
```

Verified: 2026-11-15 from the downloaded artifact `playwright-report-2`. The API poll in the CRUD test had already observed `completed` before the blank terminal assertion (`session-lifecycle.spec.ts:283` then failure at line 289).

## Hypotheses

#### H1: A completed shell with no result mail is classified as reason exited, and the parentless path raises Session blocked attention

- **Layer**: code-logic
- **Prediction**: If H1 is true, the Waiting copy is exactly the block mail (`reason: exited`) and the session row shows `Blocked: exited` after a stop that sets `status` to `completed`. A shell that is still `running` does not get that badge. Conversely, if classification ignored `shell` completions, the Waiting panel would not open on stop.
- **Verification method**: Read `classifyFailure` and `notify`, the stop path, and the output debounce, and compare with the error-context text.
- **Evidence**:

```
bridge/src/session-block.ts:150
  if (status === 'completed' && input.hasResult) return { action: 'ignore', notify: false };
bridge/src/session-block.ts:160
  const reason: BlockReason = hit?.reason ?? (status === 'error' ? 'crashed' : 'exited');
bridge/src/session-block.ts:326-332
  // no parent:
  recordAttention(..., { title: 'Session blocked', ... })

bridge/src/session-controller.ts:136-147
  runner.stop(sessionId)  // sets generation.stopping and does not emit complete
  session.status = 'completed'

bridge/src/session-block.ts:210-224
  observe() debounces evaluate(kind: 'output')
bridge/src/session-block.ts:255-259
  hasResult is checked whenever status is already completed
```

The dense-header and CRUD screens match `buildBlockedMail` (`reason: exited`, screen tail includes `[lost tty]`). Stop itself does not call `settle`. The output debounce still runs `classifyFailure` after stop has stored `completed`. A shell never has a result mail, so the completed branch becomes `exited` and, with no parent, human attention.

- **Verdict**: PROVEN
- **Rationale**: The recorded reason, title, and screen tail are the monitor's mail, and the only path that runs after stop sets `completed` without emitting a lifecycle event is the output evaluation.

#### H2: The needs-attention inbox failure is the Stop hook recording an item of its own

- **Layer**: observation
- **Prediction**: If H2 is true, the idle session that received the Stop hook would be the waiting session, and it would no longer be running. If H2 is false, that session stays running and the extra inbox item belongs to a different session.
- **Verification method**: Read the needs-attention error context and `handleHook` for `Stop`.
- **Evidence**:

```
button "Shell agent Idle mwi3kahq Idle now Session actions"
text: Session running
button "Stop"
button "Inbox, 1 waiting"
button "... crud-long-session-name-... Blocked: exited Input needed now"

local-api-server.ts:2263
  else if (hookEventName === 'Stop') this.mail.markAgentIdle(ftownSessionId);
```

- **Verdict**: REJECTED
- **Rationale**: The Stop hook only marks the agent idle. The idle row is still running with a Stop button. The one waiting item is the earlier CRUD shell, which H1 marked `Blocked: exited` and which the failed CRUD test never removed.

#### H3: The CRUD terminal is blank because the PTY never started

- **Layer**: state-data
- **Prediction**: If H3 is true, the block screen tail would be empty or would lack the marker the test typed. If H3 is false, the tail contains that marker and a prompt, and the visible xterm is empty because another tab is selected.
- **Verification method**: Read the CRUD error context.
- **Evidence**:

```
tab "Waiting" [selected]
reason: exited
screen: runnervmccnms% ... echo CRUD1794762977841 CRUD1794762977841 ... [lost tty]
locator('.xterm-rows').first() received " "
```

- **Verdict**: REJECTED
- **Rationale**: The marker was echoed in the PTY. The assertion reads an xterm that is not the selected surface; Waiting is selected because of the H1 attention item.

## 5 Whys

Symptom: Stopping a shell opens Waiting with Session blocked and hides the terminal.
Why 1? Because `classifyFailure` treats `completed` without a result mail as `exited`, and `notify` raises `Session blocked` when there is no parent.
Why 2? Because the output debounce evaluates after `stop()` has stored `completed`, and kill noise such as `[lost tty]` is not a limit screen, so the completed branch wins.
Why 3? Because "no result report" was written for an agent child that must mail a result, then applied to every session, including `shellType: shell`, which never sends result mail.
Why 4? Because one classifier keys only off status and a result mail lookup, with no split between an interactive shell the user stopped and an agent that ended without reporting.
Why 5? Because user stop and a child dying share the status value `completed`, and the notifier treats every such completion as a coordinator failure.

## Falsification

- Check performed: absence. The needs-attention idle session received a Stop hook and did not become blocked; it stayed `Session running`. The CRUD session, which did transition to `completed`, shows `Blocked: exited`.
- Result: The failure appears only after status is `completed` without a result, and it does not appear for a Stop hook that leaves the session running.
- Conclusion: hypothesis survived.

## Root Cause

- Immediate cause: `classifyFailure` in `bridge/src/session-block.ts` maps a `completed` shell with no result mail to `reason: exited` and `notify` records human attention. The output debounce applies that after `SessionController.stop` sets `completed`.
- Architectural root: completion status is shared by an intentional shell stop and an agent that owed a result, and the failure monitor does not tell them apart.
- Rejected H2: the Stop hook does not create the inbox item; the idle row is still running, and the waiting row is the CRUD shell.
- Rejected H3: the PTY echoed the CRUD marker; Waiting is selected over that terminal.

## Fix

- `bridge/src/session-block.ts` — a `completed` session whose harness is `shell` and whose screen is not a limit or auth hit is not a failure. Agents that complete without a result still notify. Status `error` still notifies.
- Regression test: `bridge/src/session-block.test.ts` — a completed shell records no block and no attention; a completed agent without a result still mails `exited`.

## Resolution

- `classifyFailure` returns ignore for a completed `shell` session whose screen is not a limit or auth hit. Status `error` and agent completions without a result are unchanged.
- The new shell test failed on the unpatched classifier (`reason: exited` plus attention) and passes after the change. The existing agent exit test still passes.
- Follow-up: the same head also makes `ftown sessions create` wait through startup and report a launch failure to the caller. That is the separate owner requirement, not this root cause.
