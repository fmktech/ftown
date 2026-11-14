# Finding F1: Solo Hub Health Deadline Uses Wall-Clock `Date.now()` and Exits Bridge on Forward Clock Jump

## Summary

After a `SIGKILL` and restart of `ftown-bridge --solo` (`f1`), the bridge's `startHub()` health-check loop (`bridge/src/solo/hub-manager.ts:456,459`) computes and checks its `30_000` ms deadline (`DEFAULT_HEALTH_DEADLINE_MS` at line `338`) using `Date.now()` (`CLOCK_REALTIME`) instead of a monotonic clock (500 ms poll interval, 1,000 ms probe timeout). In the baseline run (`seed=1, level=high`), when the guest wall clock jumped forward by `+90000` ms (`f2`, `clock_jump_fwd`) ~26.07 s after the bridge restart while the Centrifugo hub child was not yet healthy (`state.exit === null`), `Date.now() < deadline` immediately became `false`, causing `startHub()` to `SIGKILL` the live hub child (`hub-manager.ts:469`) and throw `HubStartError` (`hub-manager.ts:474`). The bridge caught this in `bridge/src/index.ts:1040-1048`, logged `[Solo] Cannot continue without the hub: ...`, and called `process.exit(1)` (`index.ts:1046`), remaining down for ~120 s across checkpoints `cp5`–`cp8` until `f5` heal restarted it.

In the counterfactual run (`seed=1, level=high, --drop-faults clock_jump_fwd,clock_jump_back`), with the exact same non-clock fault schedule (`f1`, `f3`, `f5`, `f6`), the restarted hub became healthy within the 30 s window (`<= 27.65 s` after `f1` heal) and the bridge stayed alive and responsive through `cp5`–`cp8`. Both the counterfactual and the cited code path hold, so the finding is upgraded to **Grade A**, subject to the remaining methodological gap noted below (`n=1` run per condition, `contract: 5` vs `6`, and harness determinism not yet proven).

## Reproduction

- **Baseline**: `cd chaos && npm run test:chaos -- run --seeds 1 --level high --times 1` (`seed=1`, `level=high`, `contract=5`)
- **Counterfactual**: `cd chaos && npm run test:chaos -- run --seeds 1 --level high --times 1 --drop-faults clock_jump_fwd,clock_jump_back` (`seed=1`, `level=high`, `contract=6`)

## Evidence

### Schedule comparison (`canon.jsonl` line 2)

Both runs share the exact same four non-clock faults (`id`, `kind`, `atMs`, `durationMs`, `target`), with only `f2` and `f4` (`clock_jump_fwd`) omitted in the counterfactual:

- **Baseline (`seed=1, level=high`)**:
  - `f1`: `bridge_kill9`, `atMs: 120951`, `durationMs: 1392`, `target: "bridge"`
  - `f2`: `clock_jump_fwd`, `atMs: 137427`, `durationMs: 0`, `jumpMs: 90000`, `target: "clock"`
  - `f3`: `agent_sigstop`, `atMs: 142049`, `durationMs: 3000`, `target: "child3"`
  - `f4`: `clock_jump_fwd`, `atMs: 214820`, `durationMs: 0`, `jumpMs: 2100000`, `target: "clock"`
  - `f5`: `bridge_sigterm`, `atMs: 269171`, `durationMs: 2162`, `target: "bridge"`
  - `f6`: `agent_kill9`, `atMs: 283604`, `durationMs: 0`, `target: "child2"`
- **Counterfactual (`seed=1, level=high, --drop-faults clock_jump_fwd,clock_jump_back`)**:
  - `f1`: `bridge_kill9`, `atMs: 120951`, `durationMs: 1392`, `target: "bridge"`
  - `f3`: `agent_sigstop`, `atMs: 142049`, `durationMs: 3000`, `target: "child3"`
  - `f5`: `bridge_sigterm`, `atMs: 269171`, `durationMs: 2162`, `target: "bridge"`
  - `f6`: `agent_kill9`, `atMs: 283604`, `durationMs: 0`, `target: "child2"`

### Evidence table

| Run | Record / Source | What it shows |
| --- | --- | --- |
| Baseline (`seed=1, level=high`) | `canon.jsonl` L1: `{"k":"run","seed":1,"level":"high","contract":5}` | Baseline run metadata (`contract: 5`). |
| Baseline (`seed=1, level=high`) | `canon.jsonl` L34, L36: `{"k":"fault","t":120952,"id":"f1","phase":"start","kind":"bridge_kill9","target":"bridge","ok":true}` / `{"k":"fault","t":122345,"id":"f1","phase":"heal","kind":"bridge_kill9","target":"bridge","ok":true}` | `SIGKILL` kills bridge at `t=120952` and harness restarts it at `t=122345`. |
| Baseline (`seed=1, level=high`) | `canon.jsonl` L48: `{"k":"fault","t":148416,"id":"f2","phase":"start","kind":"clock_jump_fwd","target":"clock","ok":true}` | `+90000` ms `CLOCK_REALTIME` jump executes ~26.07 s after `f1` heal (at least ~3.93 s before the 30,000 ms monotonic deadline from `f1` heal, `t=152345`). |
| Baseline (`seed=1, level=high`) | `canon.jsonl` L51, L69, L76, L82: `cp5` (`t=150001`), `cp6` (`t=180001`), `cp7` (`t=210001`), `cp8` (`t=240001`) all have `bridgeAlive: false, bridgeResponsive: false` | Bridge exited after `f2` and stayed dead for ~120 s across `cp5`–`cp8`. |
| Baseline (`seed=1, level=high`) | `canon.jsonl` L86, L88: `{"k":"fault","t":269172,"id":"f5","phase":"start","kind":"bridge_sigterm","target":"bridge","ok":false}` / `{"k":"fault","t":271334,"id":"f5","phase":"heal","kind":"bridge_sigterm","target":"bridge","ok":true}` | Bridge was already dead at `f5` start (`ok: false`); `f5` heal restarts it cleanly. |
| Baseline (`seed=1, level=high`) | `side-bridge.log` L58–61: `[Solo] Panel is up (private port)` / `[Solo] Hub failed to start: hub did not become healthy within 30000ms; last hub stderr:` / `[Solo] Cannot continue without the hub: hub did not become healthy within 30000ms; last hub stderr:` | Confirms `startHub()` hit the `Date.now() < deadline` exit path with `state.exit === null` and empty stderr, then `bridge/src/index.ts:1045-1046` exited. |
| Counterfactual (`seed=1, level=high, --drop-faults clock_jump_fwd,clock_jump_back`) | `canon.jsonl` L1: `{"k":"run","seed":1,"level":"high","contract":6}` (`verdicts.json`: `"dropFaults":["clock_jump_fwd","clock_jump_back"]`) | Counterfactual run metadata (`contract: 6`, clock jumps dropped). |
| Counterfactual (`seed=1, level=high, --drop-faults clock_jump_fwd,clock_jump_back`) | `canon.jsonl` L34, L35: `{"k":"fault","t":120957,"id":"f1","phase":"start","kind":"bridge_kill9","target":"bridge","ok":true}` / `{"k":"fault","t":122351,"id":"f1","phase":"heal","kind":"bridge_kill9","target":"bridge","ok":true}` | Same `bridge_kill9` start/heal within 5–6 ms of baseline. |
| Counterfactual (`seed=1, level=high, --drop-faults clock_jump_fwd,clock_jump_back`) | `canon.jsonl` L48, L59, L75, L98: `cp5` (`t=150000`), `cp6` (`t=180000`), `cp7` (`t=210001`), `cp8` (`t=240001`) all have `bridgeAlive: true, bridgeResponsive: true` | Without the clock jump, the restarted bridge is alive and responsive by `cp5` (27.65 s after `f1` heal) and remains up through `cp8`. |
| Counterfactual (`seed=1, level=high, --drop-faults clock_jump_fwd,clock_jump_back`) | `canon.jsonl` L112: `{"k":"fault","t":269172,"id":"f5","phase":"start","kind":"bridge_sigterm","target":"bridge","ok":true}` | Bridge was still alive when `f5` `bridge_sigterm` ran (`ok: true`). |
| Counterfactual (`seed=1, level=high, --drop-faults clock_jump_fwd,clock_jump_back`) | `side-bridge.log` L58–64 & `side-procs.txt` (`cp5 t=150000`) | `side-bridge.log` (un-timestamped) logs `[Solo] Hub is up (private port)`, `[Solo] Hub healthy — connecting Centrifugo client`, `[Bridge] Ready and listening for commands`. `side-procs.txt` at `cp5` shows `centrifugo` PID `907` with `ELAPSED 00:21` (spawned ~t=129000, ~6.6 s after `f1` heal), bounding hub health to `<= 27.65 s` after `f1` heal. |

### Hub health timing and state at `f2`

- **Counterfactual hub startup time**: `side-bridge.log` has no per-line timestamps, so the exact millisecond when `[Solo] Hub healthy — connecting Centrifugo client` was logged is not directly recorded. However, `side-procs.txt` at `cp5` (`t=150000`) shows `centrifugo` PID `907` with `ELAPSED 00:21` (spawned around `t=129000`, ~6.6 s after `f1` heal at `t=122351`), and `cp5` (`t=150000`) records `bridgeAlive: true, bridgeResponsive: true`. Thus the hub became healthy within **at most ~27.65 s** of `f1` heal (inside the 30,000 ms deadline).
- **Baseline hub state when `f2` landed**: At `t=148416` (~26.07 s after `f1` heal at `t=122345`), the hub was **not yet healthy** — it had not yet returned HTTP `200` on `GET http://127.0.0.1:40669/health` (whether because Centrifugo's HTTP listener was not yet up or the next 500 ms poll had not yet succeeded), while `state.exit` was still `null` and `stderrTail` was empty. When `f2` stepped `CLOCK_REALTIME` forward by `+90000` ms, `Date.now() < deadline` immediately evaluated to `false` on the next loop check, causing `startHub()` to `SIGKILL` the live hub child and throw `HubStartError`.

## Code path verification

Re-reading the cited bridge source lines confirms the exact mechanism:

- `bridge/src/solo/hub-manager.ts:338`: `const DEFAULT_HEALTH_DEADLINE_MS = 30_000;`
- `bridge/src/solo/hub-manager.ts:456`: `const deadline = Date.now() + deadlineMs;`
- `bridge/src/solo/hub-manager.ts:459`: `while (Date.now() < deadline && !state.exit) {`
- `bridge/src/solo/hub-manager.ts:464`: `await sleep(intervalMs);` (uses `setTimeout`, which is monotonic, unlike `Date.now()`).
- `bridge/src/solo/hub-manager.ts:469-474`: on `!healthy`, sends `child.kill('SIGKILL')`, unlinks `hub.pid`, and throws `HubStartError` with `hub did not become healthy within ${deadlineMs}ms` when `state.exit` is `null`.
- `bridge/src/index.ts:369-379`: `hubReady` logs `[Solo] Hub failed to start: ...` on rejection.
- `bridge/src/index.ts:1040-1048`: `await solo.hubReady` catches the rejection, logs `[Solo] Cannot continue without the hub: ...`, and calls `process.exit(1)` (line `1046`).
- Sibling `Date.now()` deadline loops exist in `bridge/src/solo/hub-manager.ts:488-489` (`stopHub`) and `bridge/src/solo/panel-manager.ts:681,688,763-764` (`waitHealthy`, `waitForPidDeath`).

## Alternative explanations considered

| Alternative explanation | Status | How ruled out (or not) |
| --- | --- | --- |
| **Orphaned hub from `SIGKILL`ed bridge held port or pidfile (H2)** | **Ruled out** | Ports are ephemeral (`bridge/src/index.ts:331-345`; baseline incarnation 1 used `42327`, incarnation 2 used `40669`), `reapStalePidFile()` (`hub-manager.ts:385-396`) unlinks `hub.pid` unconditionally, `side-bridge.log:59` has empty stderr and `hub did not become healthy within 30000ms` (not `hub exited early`), and the counterfactual succeeded after the same `kill -9`. |
| **Hub `spawn()` failed or child exited early (H3)** | **Ruled out** | Synchronous `spawn()` failure throws `failed to spawn hub binary: ...` (`hub-manager.ts:426`), async `'error'` logs `[ftown-solo] hub process error: ...` (`hub-manager.ts:439`), and early exit throws `hub exited early (code=..., signal=...)` (`hub-manager.ts:472`). Only `!state.exit && Date.now() >= deadline` reaches line `473`. |
| **Slow hub restart (>30 s) would have timed out even without the clock jump** | **Ruled out in counterfactual** | In `seed=1, level=high, --drop-faults clock_jump_fwd,clock_jump_back`, `cp5` (`t=150000`, 27.65 s after `f1` heal) already observes `bridgeAlive: true, bridgeResponsive: true`, and `side-bridge.log` logs `[Solo] Hub healthy — connecting Centrifugo client`. |
| **Run-to-run timing variance / unproven harness determinism (`n=1` per condition)** | **Not fully ruled out (remaining gap)** | Only one baseline run (`contract: 5`) and one counterfactual run (`contract: 6`) exist, and the harness is not yet proven deterministic (`f1` start/heal differed by 5–6 ms: `120952`/`122345` vs `120957`/`122351`). Because `side-bridge.log` lacks timestamps, the counterfactual's margin below 30,000 ms is bounded only as `<= 27.65 s` (at least 2.35 s below 30 s). |

## Classification and grade

- **Classification**: **SUT bug** (real bug, harness-amplified by QEMU `-icount` startup latency + scheduled `+90 s` `clock_jump_fwd`).
- **Grade**: **A** — the counterfactual holds (`cp5`–`cp8` stay alive and responsive without the clock jump), the code path holds (`Date.now()` deadline in `hub-manager.ts:456,459` + `process.exit(1)` in `index.ts:1040-1048`), and no alternative explanation for the baseline's exit at `t=148416` survives.
- **Remaining gap**: Evidence consists of a single run each (`run1` baseline at `contract: 5` vs `run1` counterfactual at `contract: 6`), the chaos harness is not yet proven deterministic (same-seed runs can differ by milliseconds, as seen in the 5–6 ms `f1` shift), and `side-bridge.log` has no per-line timestamps to pinpoint the exact millisecond of hub health within the `<= 27.65 s` window.

## Suggested fix direction

Replace `Date.now()` deadline arithmetic with a monotonic clock (`performance.now()`, or an injected monotonic `nowMs` function defaulting to `performance.now` for unit-testable clock jumps) in `startHub()` (`bridge/src/solo/hub-manager.ts:456,459`) so that forward `CLOCK_REALTIME` steps (NTP adjustments, VM/laptop suspend-resume) cannot prematurely expire the 30 s startup health budget, and apply the same monotonic deadline fix to the sibling `Date.now()` loops in `stopHub()` (`bridge/src/solo/hub-manager.ts:488-489`) and `waitHealthy()`/`waitForPidDeath()` (`bridge/src/solo/panel-manager.ts:681,688,763-764`).

## Suggested property to add

`R1` in `chaos/src/props/sessions.ts` only inspects `finalCheckpoint(log)`, so an unscheduled bridge death between `f1` heal and `f5` start passed when `f5` heal later restarted the bridge. An `always` property (`R2: bridge stays alive outside bridge-down faults`, present in `contract: 6`) that asserts `rec.snap.bridgeAlive === true` at every checkpoint outside active `bridge_kill9`/`bridge_sigterm`/`bridge_sigstop` windows fails the baseline run at `cp5`–`cp8` and passes the counterfactual run.
