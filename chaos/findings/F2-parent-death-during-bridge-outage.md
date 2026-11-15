# Finding F2: A parent killed during a bridge outage leaves the child's question with the parent

## Summary

A child asks a question that the bridge routes to its parent. The human inbox shows that question greyed, marked with the parent, and does not notify the human. A human who opens the inbox can still answer the greyed "with parent" item. What is missing is the escalation and its notice. The parent is then killed while the bridge is down for a restart, before the new bridge has attached to the parent's session. When the bridge comes back it records the parent as an error and leaves the question routed to the parent. The child stays blocked in a wait that is allowed to last a day (`chaos/src/fake-agent/agent.ts:72-73,215-224`), and on seed 9 it was still alive and still unanswered at the final checkpoint, about 149 seconds after the parent died.

## Trigger

Three things land together. The bridge is killed and is still down. The parent process is killed before the new bridge has re-attached to that session, so the bridge that owned the terminal never sees the exit, and the new process finds no tmux session to attach to (`remain-on-exit` is off, `bridge/src/tmux.ts:76`). The stored session is not resumable because it has no stored agent session id. Root's only hook fired during the outage, and the hook script exits 0 without reaching the bridge, so no id was recorded. `canResumeStoredSession` refuses resume for this shell unless `claudeSessionId` is set (`bridge/src/create-ftown-session.ts:401`), so startup marks the session error instead of respawning it.

## Evidence

Both runs below are contract 9 (`canon.jsonl` line 1), profile short, level low. The seed 9 pair is byte-identical. The seed 6 pair is the control from the same campaign: the parent is killed while the bridge is up.

| Run | Record / source | What it shows |
| --- | --- | --- |
| Seed 9, short, low | `canon.jsonl` L18, checkpoint `cp4`, t=60000 | `CHAOS-Q-4000` is already stored for child3, route `parent`, unresolved, not escalated. The root inbox already has the parent-question mail (`untaggedWakingMail` 1). |
| Seed 9, short, low | `canon.jsonl` L20, t=62999 | child3 logs `ask_sent` for `CHAOS-Q-4000`, accepted. No `answer_received` for this tag exists in the log. |
| Seed 9, short, low | `canon.jsonl` L29–L30 | `f1` `bridge_kill9` start t=83511 doneT=83519 ok. Heal starts t=85485 and `up.sh` returns at doneT=110538 ok. The bridge process is dead at the 90 s checkpoint (`cp6`, t=90000) and the 105 s checkpoint (`cp7`, t=105000). The parent is killed at 101.2 s (t=101154), between them. The new bridge accepts its first CLI call at 105.8 s (t=105751) and the restart script returns at 110.5 s (doneT=110538). |
| Seed 9, short, low | `canon.jsonl` L43, t=101154 doneT=101251 | `f3` `parent_kill9` of root, ok. This is inside the bridge-down span. |
| Seed 9, short, low | `canon.jsonl` L44, checkpoint `cp7`, t=105000 | Bridge still dead. Root's on-disk status is still `running` because nothing has rewritten it. `tmuxAlive` false, `procAlive` false. The question is still route `parent`. |
| Seed 9, short, low | `side-procs.txt` checkpoint `cp6` (header at line 344) vs `cp7` (header at line 420) | `cp6` still has the root agent process (`node … fake-agent/main.ts --role root`, line 398). From `cp7` on, that process is gone. |
| Seed 9, short, low | `canon.jsonl` L45, t=105751 | First successful CLI call on the new bridge (`mail_send` ok), before `up.sh` returned. |
| Seed 9, short, low | `side-bridge.log` lines 62, 65–70 | Second process logs Ready (line 62), reattaches child3 and child2, respawns child1, then line 70: `Marked stale session 06baccb6-1468-4952-a4ab-29f61f8428f6 as error`. No attach to the root tmux session, and no `Session … error:` line for it. |
| Seed 9, short, low | `canon.jsonl` L50 `cp8` t=120001 through L74 final t=250063 | Bridge alive and responsive. Root status `error`, `tmuxAlive` false, `procAlive` false. `CHAOS-Q-4000` stays route `parent`, unresolved, `escalated` false. Root `untaggedWakingMail` stays 1. |
| Seed 9, short, low | `canon.jsonl` L74 tree events; L81; L84 | Tree events are attention and result only. There is no exit event for root. A2 violated: `child3 CHAOS-Q-4000 route=parent unresolved, root not alive`. S1 passes, so the bridge is not still advertising a live root. |
| Seed 9, short, low | `side-tmux.txt` at the end of the run; `side-procs.txt` final header at line 1077 | Three tmux sessions, all children. No root session. No `node` process with `--role root`. |
| Seed 6, short, low | `canon.jsonl` L26, checkpoint `cp5`, t=75001 | Bridge up. Root running, tmux alive, process alive. child2 `CHAOS-Q-3000` is route `parent`, unresolved, not escalated. |
| Seed 6, short, low | `canon.jsonl` L31, t=84630 doneT=84715 | `parent_kill9` of root, ok, with the bridge up. No bridge-fault window covers this time. |
| Seed 6, short, low | `side-bridge.log` lines 38–39 | `tmux attach client exited`, then `Session 18c899ae-080d-4796-ac4e-5b1880633139 error: Process exited with code 137`. |
| Seed 6, short, low | `canon.jsonl` L35, checkpoint `cp6`, t=90001; L77 | Root status `error`, tmux false, process false. `CHAOS-Q-3000` is route `human`, `escalated` true, still unresolved (nobody answered, but the human was given the question). A2 passes. |

`canon.jsonl` L47 on seed 9 (`id` `heal`, kind `parent_kill9`, target `all`, t=110538) is the executor's final heal, not a respawn of root. `parent_kill9` itself has no heal (`chaos/src/supervisor/faults.ts:32-34,61-63,178-183`).

## Code path

Live path, the one seed 6 took. The runner's PTY error handler saves the session as `error` and then unregisters it (`bridge/src/terminal-pump.ts:351-372`). Unregister calls `onSessionExit(id)` with no snapshot (`bridge/src/index.ts:806-813`). That load sees a terminal status and calls `escalateExitingParent` (`bridge/src/coordination/wiring.ts:180-195`), which is the only caller of `escalateParentChildren` (`bridge/src/coordination/wiring.ts:167-177`, `bridge/src/coordination/attention-routing.ts:119-148`). The item flips from `parent` to `human` with the parent-unavailable note, and the human notice is published.

Startup path, the one seed 9 took. The bridge that owned the PTY was already dead, so the handler above never ran. Resurrection tries to reattach, then to resume (`bridge/src/session-resurrection.ts:63-92`). Reattach fails because the tmux session is gone. Resume is refused because the stored session has no agent session id. The next statement is `markSessionDead` (`bridge/src/session-resurrection.ts:46-53` and the call at line 95). That sets status `error`, saves, publishes, and logs `Marked stale session … as error`. It does not call `onSessionExit` or `escalateParentChildren`. The publish observer starts a session only when the update says `running`; any other status only cancels an idle notification (`bridge/src/index.ts:795-804`). After resurrection, startup restores idle notifications only for sessions that are still running (`bridge/src/index.ts:1072-1075`). Nothing walks open parent-routed questions.

The missing step is that call. `onSessionExit` is never entered for this death, so its terminal-status check is never evaluated. `markSessionDead` does not escalate, and there is no startup pass over parent-routed items.

## Contract it breaks

`bridge/src/coordination/contract-b.ts:25-27`: when the parent exits, stops, or errors while the item is open and `route` is `parent`, the route flips to `human`, `escalatedAt` is set, the escalation note is set, and the normal human notice fires. The same block says there are no timers, and only the parent or parent unavailability moves an item to the human (`contract-b.ts:28`).

## Alternatives considered

| Alternative | How it was ruled out |
| --- | --- |
| The harness called the parent dead from a stale pid, while the bridge had respawned a live parent. | `parentAlive` is `status === 'running'` and a live process whose argv contains `fake-agent` and the tokens `--role` then the role (`chaos/src/props/attention.ts:29-33`, `chaos/src/observe/procs.ts:59-75`). It does not read a stored pid. At the final checkpoint status is `error` and `procAlive` is false. `side-tmux.txt` has no root session. `side-procs.txt` at the final checkpoint has no root agent process. The bridge log says `Marked stale session … as error`, not a resume respawn, and there is no second attach to the root tmux session. |
| Escalation ran, and the route write was lost. | The final tree has no exit event. `onSessionExit` is what emits that event for a terminal session (`wiring.ts:187-188`). `escalated` is still false at every checkpoint from `cp8` to the final one, more than two minutes after the bridge is back. |
| The question was created after the parent was already dead, so routing it to the parent was correct at the time. | The item is route `parent` at t=60000. The parent kill is at t=101154, and the root process is still alive at the t=90000 checkpoint. |
| Marking the session error is enough, and leaving the route is intended when the session cannot be resumed. | The contract sentence above requires the flip when the parent errors. Seed 6, where the bridge sees the same kill, does flip the route. |
| child1 was respawned, so root should have been too, and the mark-dead log is a different bug. | child1 had delivered hooks to the first bridge (t=71814 and t=82268), so it had a stored agent session id and took the resume branch (`side-bridge.log` line 69). Root's only hook is at t=98526, during the outage. The hook script exits 0 even when the bridge is unreachable (`chaos/src/fake-agent/cli.ts:61-70`), so that event did not store an id. Root took the mark-dead branch. That explains which branch ran. It does not move the question. |

## Reproduction

```text
cd chaos && npm run test:chaos -- repro --seed 9 --profile short --level low --times 2
```

The recorded pair is contract 9. Both canonical logs are byte-identical. A2 is violated and the process exit is 1. The in-progress short/low campaign log shows the same pair: identical hashes, `violated=A2`.

## Settling experiment

**NOT YET RUN.**

```text
cd chaos && npm run test:chaos -- repro --seed 9 --profile short --level low --times 1 --drop-faults bridge_kill9
```

The harness writes that run under `chaos/out/9-short-drop-bridge_kill9` (`chaos/src/host/paths.ts:15`). Dropping `bridge_kill9` leaves `parent_kill9` at its scheduled time while the bridge stays up. The question is opened at t=62999, before the kill at t=101154. Expect the seed 6 shape: the bridge log shows the tmux client exit and `Process exited with code 137`, the question's route becomes `human` with `escalated` true, and A2 passes. If A2 still fails with the bridge up the whole time, this account of the trigger is wrong.

## Grade

**B.** Reproduced twice, byte-identical. The code path is identified. Seed 6 is a natural control in the same profile and level: the parent dies while the bridge is up, and escalation happens. The dedicated counterfactual (`--drop-faults bridge_kill9` on seed 9) has not been run, so the grade is not A.

## Suggested fix direction

When startup marks a session error because it cannot reattach and cannot resume, it should run the same parent-exit escalation the live PTY path runs: after the status write, `escalateParentChildren` for that session, so every open child item still routed to the parent flips to the human and the notice fires once. The same pass belongs at the end of resurrection for every stored session that is no longer running, because a death during the outage never enters `onSessionExit`. The publish observer that today only cancels an idle notification for a non-running update is not that pass. No change is needed on the live path that seed 6 already exercises.
