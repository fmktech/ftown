# Chaos findings — index

What the chaos harness has found in ftown so far, and how sure we are. One entry per finding or
observation. Detailed write-ups live next to this file.

Grades:

- **A** — reproduced, counterfactual run confirms the trigger, code path identified.
- **B** — reproduced and code path identified, counterfactual missing or ambiguous.
- **C** — seen once or inferred from code; not reproduced on demand.
- **Observation** — behaviour worth knowing that breaks no stated promise of the bridge.

Findings with a security angle are not listed here or anywhere in the repository.

## Campaign record

| Date | Contract | Profile / level | Seeds | Runs per seed | Pairs identical | Bridge violations |
|---|---|---|---|---|---|---|
| 2026-11-14 | v8 | short / off | 1 | 2 | yes | none |
| 2026-11-14 | v8 | short / low | 1–4 | 2 | yes (4 of 4) | none reported by v8 (seed 2 contained an undetected F1 outage of ~51 s that old R2 missed; fixed in contract v9) |
| 2026-11-14 | v6 | soak / high | 1 | 2 | yes | none in the pair; F1 found in an earlier run of this seed with clock faults |
| 2026-11-14/15 | v9 | short / low | 1–40 | 2 | yes (40 of 40) | A2 on seeds 9 and 36 (F2) |
| 2026-11-15 | v9 | soak / high | 1–10 | 2 | yes (10 of 10) | M5 on seeds 6 and 10 (F3) |
| 2026-11-16 | v9 | soak / high | 11–40 | 2 | yes (30 of 30) | none (seed 17 reported R2; harness problem, see harness problems) |

The 2026-11-14/15 contract v9 short/low campaign ran on the bridge before the F2 fix (`39f03f5`).

The 2026-11-15 soak / high row is the campaign that found F3. The same-build counterfactual dropping only `clock_jump_back` passes M5 and all always/unreachable properties on both seeds (exit 0; `H_run` prefixes `0c83ac100058` and `bcec72f7af52`).

The 2026-11-16 campaign ran on bridge 0.30.4, which includes the F3 fix; this is why M5 is absent. Seeds 12, 22 and 32 first ended as infrastructure errors (one watchdog expiry under host load, two out-of-memory kills of the emulator while other work shared the container host) and were clean, identical pairs when re-run on a quiet host (`H_run` prefixes `18186da1c157`, `f1d02a5af19c`, `2fd69412159a`). Seed 17's pair was identical (`H_run` prefix `313459c6e7a2`) and reported R2, a false positive fixed in contract v10 (see harness problems).

A short run takes about 3.7 minutes of wall time on a lightly loaded host.

The v8 rows cover four seeds at level low. The first v9 row covers seeds 1–40 at short / low.
Those runs exercise bridge kill -9, bridge SIGTERM, parent death, and clock jumps inside a
40-second fault window. What short runs never include is long faults. A clean table here says
little about long faults.

## Findings

### F1 — Bridge exits if the wall clock jumps forward while the solo hub is starting (grade A)

After a bridge restart, the solo hub's 30-second health deadline is computed from the wall
clock. A forward clock jump inside that window makes the deadline expire at once; the bridge
stops the hub and exits. In the run that found it the bridge stayed down for about 120 seconds,
until the next scheduled heal. Without the clock jump the same restart succeeds.

- Details: [F1-hub-health-after-restart.md](F1-hub-health-after-restart.md)
- Found by: seed 1, level high, long-form run (today: `--profile soak --level high`).
- Limits of the evidence: one run per condition, taken before the harness was shown to be
  deterministic. Re-confirm with a soak pair before relying on exact timings. The reproduction
  commands in the detail file predate run profiles and need `--profile soak` added.
- Suggested direction: measure the deadline with a monotonic clock.
- Fix confirmation (2026-11-14, fix commit `a33c8bc`, #226): confirmed on contract v9 with
  seed 2 (`--profile short --level low`, `f1` `bridge_kill9` at 83,531 ms followed by
  `clock_jump_fwd` +90,000 ms at 107,248 ms). Pre-fix (`bridge/` at `309b678` on v9 harness,
  source fingerprint `5297ec8714be`): `H_run=6587cd4c9479`, `exit=1`, `R2` violated
  (`heal failed: f1 bridge_kill9 t=86100 doneT=108327`), `side-bridge.log` recorded
  `hub did not become healthy within 30000ms` and checkpoints `cp6`–`cp8` showed `bridgeAlive: false`.
  Post-fix (source fingerprint `5f6a682a4488`, `--times 2`): identical pair `H_run=85caa5790c30`,
  `exit=0`, `R2` passed, checkpoints `cp8`–`cp9` showed `bridgeAlive: true` and `bridgeResponsive: true`.

### F2 — A child question stays with a parent that died during a bridge outage (grade A)

The child keeps waiting, up to a day, and the human gets no notice. A human who opens the inbox can still answer the greyed "with parent" item. What is missing is the escalation and its notice. Startup marks the dead parent as an error and, on the bridge before the fix, leaves the question routed to the parent. Reproduced byte-identical on seed 9 and on seed 36, short, level low. Seed 6 kills the parent while the bridge is up, and the question moves. The counterfactual that drops `bridge_kill9` on seed 9 passes A2.

- Details: [F2-parent-death-during-bridge-outage.md](F2-parent-death-during-bridge-outage.md)
- Fix confirmation (2026-11-15, fix commit `39f03f5`, #229): confirmed on contract v9, short / low. Pre-fix campaign: seed 9 `H_run=51fbe1c3a3de`, `violated=A2`, `exit=1`; seed 36 `H_run=9a38a903144b`, `violated=A2`, `exit=1`. Counterfactual (`--drop-faults bridge_kill9`, source fingerprint `0508bf92547a`): `H_run=14fba9da891c`, `violated=-`, `exit=0`, A2 pass, final route `human`, `escalated` true. Post-fix (source fingerprint `b1014caec549`, different from the counterfactual): seed 9 pair `H_run=3dfc8f602ab7`, `exit=0`, A2 pass; seed 36 pair `H_run=e5eb2f6f5e39`, `exit=0`, A2 pass. Both pairs byte-identical.

### F3 — A backward wall-clock step delays mail nudges (grade A)

A backward wall-clock step can delay the idle safety-net nudge by roughly the step. Mail stays readable; a later successful real-agent hook pump or inbox consumer can deliver it sooner. Eventual timer recovery or fresh-delay recovery after restart is inferred from code. Soak / high, contract v9, seeds 6 and 10, each pair byte-identical. Grade A: the code path is identified and the same clean-build counterfactual dropping only `clock_jump_back` passes M5 on both seeds. Fixed in #241 (bridge 0.30.3), with follow-up #242 (bridge 0.30.4).

- Details: [F3-backward-clock-jump-delays-mail-nudges.md](F3-backward-clock-jump-delays-mail-nudges.md)
- Fix confirmation: seeds 6 and 10 (soak / high) pass M5 twice each on the fixed bridge, byte-identical pairs.

## Observations

### O1 — A sender can see "failed" for a mail the bridge has already stored

If the bridge is killed after it appends a mail to the recipient's inbox and before it answers
the sender, the sender's CLI reports a connection failure while the mail is delivered and nudged
normally later. Seen once (seed 3, short, level low, contract v8 build: a result mail from a
child to the root). The bridge breaks no promise here, but a sender that retries on failure
sends the mail twice; nothing de-duplicates it. The harness properties account for this case
("persisted without ack" in M4's evidence).

Whether a given seed hits the window depends on the exact build: on the next build the same
seed's kill landed before the append and the mail was simply not sent.

### O2 — CLI calls fail for a few seconds after a bridge kill -9

In the seconds after the bridge is killed and restarted, CLI calls from agents fail with a
connection error (six calls within about 10 seconds of the restart in one soak run; none after a
SIGTERM restart in the same run). Expected while the bridge is down; listed because agents get
no retry from the CLI.

### O3 — A lost end-of-turn hook can delay mail nudges for a long time (not yet observed)

Inferred from code and from a harness mistake, not from a failing run. The bridge marks a hooked
session busy on its prompt and tool hooks and idle on its `Stop` hook, and defers mail nudges
while the session is busy, re-checking every 60 seconds. The hook script exits 0 even when the
bridge is unreachable. If a `Stop` hook fires while the bridge is down or frozen, the bridge can
keep treating the session as busy until its stale limit, which for sessions with a known agent
session id is 30 minutes, and mail to that session is not nudged meanwhile. The harness would
report this as an M5 violation; it has not yet produced one.

## Harness problems found and fixed along the way

These were reported as violations and turned out to be the harness, not the bridge. Listed so
the same shapes are recognised quickly next time.

| Reported | Cause | Fix |
|---|---|---|
| A1, M2, M4 after an agent kill -9 | The bridge respawned the agent and the fake agent replayed its script, reusing tags | Fake agent persists its position and tag counter |
| M5 with no faults | Fake agents looked busy for the whole run, so every nudge was deferred | Scripts run in turns; M5 only judges mail and recipients settled for 75 s |
| M4 "nudge excess" | A mail stored without sender acknowledgement (O1) was not counted | M4 counts mail seen in the inbox or received |
| R2 "bridge down" with the bridge alive (seed 17, soak / high) | One 20 s responsiveness probe timed out from guest CPU load; a run with no faults before that checkpoint shows the same timeout, and neighbouring probes took up to 17 s | Contract v10: R2 needs the bridge dead, or unresponsive at two consecutive checkpoints; probe results are logged to `side-probes.jsonl` |

## Open harness limits that affect findings

- CLI calls are slow in the guest (a `sessions list` takes about 3 s idle and up to 20 s under load), so agent hooks and operator calls can time out with no fault active. Runs stay deterministic, but properties must not read a single slow call as a bridge failure.
- The soak clock race in the emulator is fixed (emulator patch, PR #234). Soak pairs in the
  2026-11-15 contract v9 soak / high campaign were identical, 10 of 10. Short runs have been
  identical in every pair so far, including under heavy host load.
- Process-crash faults only: no power loss, disk or network faults yet.
