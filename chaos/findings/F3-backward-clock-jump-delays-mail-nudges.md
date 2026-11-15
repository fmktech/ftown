# Finding F3: A backward wall-clock step delays mail nudges

## Summary

An idle session that already has unread waking mail is not nudged for about as long as the wall clock stepped backward. The mail is in the inbox the whole time, and a manual read sees it. The pane nudge is the safety net that is late. It heals by itself when the rescheduled timer fires, about ten minutes after a ten-minute step back, or on a bridge restart, which drops the in-memory deadlines and arms a fresh delay on the new clock. Soak runs end at eight minutes, so the final checkpoint lands inside the hole and M5 reports the mail still pending.

## Trigger

One live hooked session, and then a backward step of the realtime clock. The session has either accepted waking mail, which stores a "not before" deadline, or it has already been nudged, which stores the time of that nudge. No other fault is required. A kill, a stop, or a lost end-of-turn hook is not part of the trigger. The long form of `clock_jump_back` steps the clock back by 600 seconds. The short form steps it back by 30 seconds, and that delay finishes before a soak checkpoint.

## Evidence

Contract v9, profile soak, level high. The bridge under test is source head `c28364c6f312`, fingerprint `f9a98a2a5b06`. Seeds 6 and 10 each ran twice. Each pair is byte-identical, including `canon.jsonl`, `verdicts.json`, and `side-bridge.log`. Both runs exit 1 with M5 violated. Seeds 4 and 7 are the clean comparison: the same profile and the same bridge, with the short backward jump of 30 seconds. Both exit 0 and M5 passes. `H_run` prefixes: seed 6 `6db8cb1fe34b`, seed 10 `0a6346b8a0dd`, seed 4 `9737c99e3693`, seed 7 `627b28c8e44e`.

The harness clock in `canon.jsonl` is monotonic guest time. The bridge's mail clock is the wall clock. A backward jump moves only the wall clock.

| Run | Record / source | What it shows |
| --- | --- | --- |
| Seed 6 | `canon.jsonl` L2 | Schedule: `bridge_sigterm` at 173,235 ms for 2,034 ms, `parent_kill9` of root at 232,522 ms, `bridge_sigstop` at 241,227 ms for 2,000 ms, `agent_sigstop` of child3 at 282,820 ms for 3,000 ms, `clock_jump_back` −600,000 ms at 321,442 ms. |
| Seed 6 | `canon.jsonl` L134 | `clock_jump_back` applied at t=321442, doneT=321472, ok. Final checkpoint L142 t=480000, bridge alive and responsive. |
| Seed 6 | `verdicts.json` M5 | Violated. Evidence: `pending CHAOS-M-23 to=child2`, `pending CHAOS-M-25 to=child2`, `pending CHAOS-M-26 to=child2`. |
| Seed 6 | `canon.jsonl` L127, L131, L133 | The three mails are external sends, all ok. M-23 message at t=278904, M-25 result at t=297775, M-26 message at t=312546. All three are before the jump. |
| Seed 6 | `canon.jsonl` L132, L137, L142 | M-23 and M-25 are in child2's inbox at t=300001, undelivered and unnudged. M-26 joins them at t=330000. All three are still undelivered and unnudged at t=480000. Ages then: 201 s, 182 s, 167 s. |
| Seed 6 | `canon.jsonl` L115; `side-bridge.log` L83 | child2's last nudge is t=267884, n=2, before these three mails. The second bridge process logs `nudge pty wake with 2 message(s)` for that session. There is no later nudge, and the log has no `defer busy` line. |
| Seed 6 | `canon.jsonl` L93, L71, L76 | child2's last hook is Stop at t=191975, ok. Idle at the checkpoint is 288 s. That Stop, and the hook before it, fall inside the SIGTERM outage (start t=173235, heal doneT=205412). The replacement process then nudged child2 at t=267884, so it was not holding a busy marker. |
| Seed 10 | `canon.jsonl` L2, L48 | `clock_jump_back` −600,000 ms is the first fault, scheduled at 142,828 ms, applied at t=142829. Later: `parent_kill9` of root at t=164717, two `bridge_sigstop` of 2,000 ms, and `clock_jump_fwd` +90,000 ms at t=317013. Final checkpoint L110 t=480001, bridge alive. The bridge process is not restarted. |
| Seed 10 | `verdicts.json` M5 | Violated. Seventeen pending mails: child1 M-8, M-10, M-13, M-15, M-19, M-26, M-29; child2 M-9, M-12, M-24, M-27; child3 M-20, M-21, M-22, M-25, M-1000, M-1001. |
| Seed 10 | `canon.jsonl` L32, L33, L41 | Mail accepted before the jump, and never nudged: child1 M-8 at t=105201 and M-10 at t=131830; child2 M-9 at t=117723. child1 and child2 have no nudge record in the whole run. |
| Seed 10 | `side-bridge.log` L38–L43 | Before the jump the log has one nudge for child3 (4 messages) and one for root (3 messages). After root exits 137, exactly one line each: child1 and child2 `defer busy within 1800000ms stale window`. No second defer. No nudge for child3 after that. |
| Seed 10 | `canon.jsonl` L34, L52, L58, L61, L70 | child3's only nudge is t=117855, n=4, before the jump. child1's hooks around the defer: UserPromptSubmit at t=160578, Stop at t=175974. The defer matches that mid-turn window. The Stop is after the 2 s bridge stop has ended (healed by t=169883). Last Stops: child1 t=175974, child2 t=194049, child3 t=199494. Idle at t=480001 is 304 s, 286 s, and 281 s. |
| Seed 10 | `canon.jsonl` L49; M4 evidence | Root's send of M-1000 at t=144145, 1.3 s after the jump, is `accepted` false with error `expired`. M4 records `persisted without ack: CHAOS-M-1000 to=child3`. The mail is in the inbox and then sits unnudged with the others. Root's next send, M-1001 at t=160420, is accepted. |
| Seed 4 | `canon.jsonl` L2, L107 | `clock_jump_back` is the short jump, −30,000 ms, at t=269759. M5 passes. |
| Seed 4 | `canon.jsonl` L112, L124, L125, L139, L140 | Waking mail is still pending at t=300001 and t=330001. Root is nudged at t=338510 (69 s after the jump). child2 is nudged at t=388534 (119 s after the jump). From t=390001 on, no waking mail is pending. |
| Seed 7 | `canon.jsonl` L69, L118 | Two short backward jumps, −30,000 ms, at t=181894 and t=266917. M5 passes. Nudges after them at t=221021, t=251391, t=334148, and t=355529. |

1800000 ms is `AGENT_BUSY_STALE_MS`. These sessions are shell `claude`. The hook payload carries the ftown session id in `session_id`, and the hook persister stores that as `claudeSessionId`, so the busy window is the 30-minute one. The log prints that number once. A marker that stayed busy would print `defer busy` every 60 s until the checkpoint. It does not.

## Code path

`date -s` steps the guest realtime clock (`chaos/src/supervisor/main.ts:133-141`). The mail service reads that clock through `Date.now()` (`bridge/src/mail-delivery.ts:212`). Node's `setTimeout` uses a monotonic clock, so a timer that was armed for 60 seconds still fires 60 seconds later. The jump does not move it. The failure is the comparison the timer runs when it fires, against a wall-clock value stored before the jump.

Hooked sessions wait 60 seconds before a nudge (`MAIL_NUDGE_DELAY_HOOKED_MS`, `bridge/src/mail-delivery.ts:25`). Two stored deadlines sit on that path. Both are absolute wall times.

`legacyReadyAt` is set when waking mail is accepted and no nudge is already pending, to `now()` plus the delay (`bridge/src/mail-delivery.ts:547`; the restart path sets the same field at `:266` if it is empty). `wakeSession` computes `legacyReadyAt - now()` and, when that is positive, arms a timer for that many milliseconds and returns (`bridge/src/mail-delivery.ts:940-941`). It does not log. After a step back of 600 seconds the difference is about 600 seconds, so the new timer waits about 600 seconds of real time. When it fires, wall time has caught up and the nudge proceeds.

`lastNudgeAt` is set only after a nudge is written to the terminal (`bridge/src/mail-delivery.ts:1048`). The next wake requires `now() - lastNudgeAt` to be at least 30 seconds (`MAIL_NUDGE_MIN_INTERVAL_MS`, `:26`, check at `:953-959`). A missing entry means "never nudged" and is not rate-limited (`:950-953`). A pre-jump `lastNudgeAt` makes `now() - lastNudgeAt` largely negative, so the reschedule is `30000 - sinceLast`, about 10 minutes. This check is after the `legacyReadyAt` check, so a mail accepted before the jump returns at `:940` and never reaches it.

`scheduleMailNudge` keeps an existing timer (`bridge/src/mail-delivery.ts:658-661`). Later mail joins that timer and does not move `legacyReadyAt`.

Seed 6 takes the `legacyReadyAt` gate. child2 was nudged at t=267884, which cleared the pending-nudge flag (`:1046`). M-23 at t=278904 stored `legacyReadyAt` as the wall time then plus 60 seconds and armed a 60 second timer. M-25 and M-26 joined it. The timer fires near monotonic t=338904, 17 seconds after the jump. The replacement bridge has an empty busy map and child2 sent no hook after the restart, so the busy check does not return. `legacyWait` is 600,000 ms. The min-interval check is not reached. It would also have failed: `sinceLast` against the nudge at t=267884 is 71,020 − 600,000 ms.

Seed 10 splits the two gates. child1 and child2 were never nudged, so `lastNudgeAt` is unset. Their first mail was accepted before the jump, so `legacyReadyAt` is a pre-jump deadline. The 60 second timer fires during a real turn (child1: UserPromptSubmit at t=160578, Stop at t=175974), logs the one `defer busy`, and rechecks 60 seconds later (`:862-865`, `MAIL_NUDGE_BUSY_RECHECK_MS` at `:30`). The Stop has been delivered by then. The recheck is not busy, logs nothing, and reschedules for about 540 seconds on `legacyReadyAt`. child3 was nudged at t=117855, before the jump, so `lastNudgeAt` is pre-jump and the mail accepted after the jump stores a fresh `legacyReadyAt` on the new clock. `:940` does not bite. `:955` does. The +90 second forward jump at t=317013 does not shorten a timer that is already armed.

The rescheduled timer fires near monotonic t=939000 on seed 6, and near t=765000 (child1, child2) and t=748000 (child3) on seed 10. The checkpoint is t=480000. A bridge restart after the jump also heals: `stop()` clears `legacyReadyAt` (`:286`), and a new process starts with empty maps.

## Contract it breaks

M5 (`chaos/src/props/mail.ts:161-235`, `SETTLE_MS` at `:26`). At the final checkpoint, waking mail that is undelivered and unnudged, to a live session whose last hook is Stop and has been idle for at least 75 seconds, and that has itself been pending for at least 75 seconds, is a violation. The bridge's own statement of the recovery path is `recoverPendingMail` (`bridge/src/mail-delivery.ts:253-270`), which re-arms the same wake path.

## Alternatives considered

| Alternative | How it was ruled out |
| --- | --- |
| A lost Stop left a stale busy marker (observation O3). | A stuck marker logs `defer busy` every 60 seconds. Seed 6's bridge log has no such line, and the replacement process nudged child2 at t=267884 after the Stops that fell in the SIGTERM outage. Seed 10 logs exactly one defer per child1 and child2, timed to a real mid-turn, and the following Stop is posted while the bridge is up. The sessions then stay silent, which is the unlogged deadline path, not the busy loop. |
| The sender was root, and root's death changed delivery. | The M5 mails on seed 6 are external sends and all three are ok. On seed 10 the external sends are ok as well. Root's death does not take a different branch in `wakeSession`. M-1000 is the one root send that crossed the jump and came back `expired`; it was stored, and it then waited on the same timer as the accepted mail. |
| M5 judged the harness clock, or a Stop the bridge never saw, so the violation is the harness. | `hook_sent` ok means the hook script exited 0 (`chaos/src/fake-agent/cli.ts:67-70`). On these mails the bridge was up at the checkpoint, the last hook is Stop, and the busy map was clear: seed 6 proved that with a successful nudge, and seed 10 proved it by not repeating `defer busy`. Idle time on the monotonic clock past 75 seconds is the bug being visible, not a false reading. |
| The bridge was stopped or down, so it could not nudge. | Seed 6's bridge stop ended at t=243240, before the three mails. Seed 10's stops are 2 seconds each. The bridge log shows the process running and making the one defer decision after the jump. The final checkpoints show the bridge alive and responsive. |
| Any backward jump of this kind fails M5. | Seeds 4 and 7 step back 30 seconds. The nudge lands 69 to 119 seconds later, inside the soak, and M5 passes. The long step is 600 seconds, which does not finish before t=480000. |

## Settling experiment

RUNNING. RESULT PENDING.

```text
cd chaos && npm run test:chaos -- run --profile soak --level high --seeds 6,10 --times 1 --drop-faults clock_jump_back
```

Dropping `clock_jump_back` leaves the other faults on each seed's schedule. The expected result is M5 passing, with mail that arrives after the removed jump nudged before the final checkpoint, as on seeds 4 and 7. If M5 still fails, this account is wrong.

## Grade

**B.** Reproduced on seed 6 and seed 10, each pair byte-identical, on contract v9, soak, level high. The code path is the two wall-clock gates above. Grade A needs the counterfactual. That run is in progress and has no result yet.

## Related

These are the same pattern, a stored wall time compared with `Date.now()` after a backward step. None of them is what held the mail in this campaign. They are not yet observed as failures.

- `bridge/src/mail-delivery.ts:345` and `:673-676`. A busy marker stored before the jump stays "recent" until wall time catches the marker plus the stale window, and the recheck logs every 60 seconds. That is O3 combined with a backward step. These logs do not show it.
- `bridge/src/mail-delivery.ts:307` and `:310-318`, checked at `:861`. A native-wake lease deadline moves about ten minutes out. The reschedule is silent. These sessions did not take that branch.
- `bridge/src/mail-delivery.ts:714`, `:741`, and `:822`. The codex retry deadline does the same. These sessions are claude.
- `bridge/src/mail-delivery.ts:432`. A backward step makes `now() - lastInjection` negative, so a prompt hook with no text is treated as injected for about ten minutes.
- `bridge/src/attention-store.ts:155` and `:172`. An idle-notification due time stamped before the jump schedules the notice about ten minutes late.
- `bridge/src/attention-store.ts:136`. A waiter whose last poll is in the future relative to the new clock still counts as live for about ten minutes.
- `bridge/src/attention-store.ts:514-531` and `:551-577`. An attention long-poll captures its deadline with `Date.now()` and then waits `deadline - Date.now()`. A step back during the wait stretches it by the size of the step.
- `bridge/src/attention-store.ts:569`. Poller expiry uses the same subtraction, so a poller from before the jump is kept.

## Suggested fix direction

Measure the nudge gates with a monotonic clock, the same way the hub health deadline was fixed for F1. `legacyReadyAt`, `lastNudgeAt`, the busy-since time, the native-wake lease, and the codex retry time should store a monotonic reading, and the comparisons in `wakeSession` should use that reading. Wall time remains appropriate for timestamps that are shown to people. A backward step of the realtime clock, from `date -s` or from a suspend, then cannot push a deadline ten minutes into the future. The attention waits and the idle-notification due time want the same treatment where they decide how long to sleep. No patch is included here.
