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
| — | not named in the campaign log | short / low | in progress, 18 of 40 seeds so far | 2 | yes (18 of 18 finished) | A2 on seed 9; none on seeds 1–8 and 10–18 |

A short run takes about 3.7 minutes of wall time on a lightly loaded host.

Coverage is small: four seeds at level low exercise bridge kill -9, bridge SIGTERM and agent
faults in a 40-second window. No long faults, no clock jumps and no parent-death case ran in the
short campaign. A clean table here says little about those.

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

### F2 — A child question stays with a parent that died during a bridge outage (grade B)

The child keeps waiting, up to a day, and the human gets no notice. Startup marks the dead
parent as an error and does not move the question to the human. Reproduced twice, byte-identical,
on seed 9, short, level low. Seed 6 kills the parent while the bridge is up, and the question moves.
The counterfactual that drops the bridge kill is not yet run.
Details: [F2-parent-death-during-bridge-outage.md](F2-parent-death-during-bridge-outage.md)

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

## Open harness limits that affect findings

- Soak-length runs can still differ between two runs of one seed by a few milliseconds in the
  last record (a rare clock race in the emulator while the guest is idle). Short runs have been
  identical in every pair so far, including under heavy host load.
- Process-crash faults only: no power loss, disk or network faults yet.
