# Finding F1: Solo Hub Health Deadline Uses Wall-Clock `Date.now()` and Exits Bridge on Forward Clock Jump

## Summary

After a `SIGKILL` and restart of `ftown-bridge --solo`, the bridge's `startHub()` health-check loop (`bridge/src/solo/hub-manager.ts:456,459`) computes and checks its 30,000 ms deadline using `Date.now()` (`CLOCK_REALTIME`) instead of a monotonic clock. When the guest wall clock jumped forward by +90 s ~26.1 s after the bridge restart (before the Centrifugo hub child had passed `/health`), `Date.now() < deadline` immediately became `false`, causing `startHub()` to `SIGKILL` the live hub child and throw `HubStartError`. The bridge caught this error in `bridge/src/index.ts:1040-1048` and exited with `process.exit(1)`, remaining down for ~120 s until the harness's next bridge fault heal restarted it.

## Reproduction

- **Seed / Level**: Seed `1`, level `high` (deterministic QEMU guest, `ftown-bridge --solo`, no network).
- **Fault sequence** (`canon.jsonl`):
  1. `t=120952` (`f1`, `start`, `bridge_kill9`): Harness sends `SIGKILL` to the bridge process (`ok: true`).
  2. `t=122345` (`f1`, `heal`, `bridge_kill9`): Harness restarts the bridge (`ok: true`).
  3. `t=135127`: `op mail_send` succeeds (`ok: true`), confirming the restarted bridge's local API server is up.
  4. `t=148416` (`f2`, `start`, `clock_jump_fwd`): Harness steps `CLOCK_REALTIME` forward by `+90000` ms (`date -s`, monotonic clock unaffected).
  5. `t=150001` (`cp5`): Checkpoint observes `bridgeAlive: false`, `bridgeResponsive: false`.
  6. `t=180001` (`cp6`), `t=210001` (`cp7`), `t=240001` (`cp8`): Bridge remains dead (`bridgeAlive: false`).
  7. `t=269172` (`f5`, `start`, `bridge_sigterm`): `ok: false` (bridge is already dead).
  8. `t=271334` (`f5`, `heal`, `bridge_sigterm`): Harness restarts the bridge (`ok: true`); bridge recovers cleanly.

## Evidence

### Bridge log (`side-bridge.log`, IDs redacted)

Incarnation 1 (ephemeral hub port `42327`):
```text
  ftown-bridge starting
  Bridge ID:      <redacted-bridge-id>
  User ID:        solo
  Centrifugo URL: ws://127.0.0.1:42327/connection/websocket
  Data dir:       /data
...
[Solo] Panel is up (private port)
[Solo] Hub is up (private port)
[Solo] Hub healthy — connecting Centrifugo client
```

Incarnation 2 (restarted at `t=122345` on ephemeral hub port `40669`, exited after `f2` at `t=148416`):
```text
[LocalApiServer] Listening on port 44399
[Bridge] Local API server started on port 44399
========================================
  ftown SOLO mode
  Bridge ID: <redacted-bridge-id>
  Key not shown: already issued once. --rotate-key regenerates it.
  WARNING: no LAN interface detected; loopback only.
========================================
[Solo] Using local panel dir: /opt/chaos-seed/panel
========================================
  ftown-bridge starting
  Bridge ID:      <redacted-bridge-id>
  User ID:        solo
  Centrifugo URL: ws://127.0.0.1:40669/connection/websocket
  Data dir:       /data
========================================
[Bridge] Loopback WS rung ready at ws://127.0.0.1:44399/ws
[Bridge] Wrote bridge pointer to /data/bridge.json
[Solo] Panel is up (private port)
[Solo] Hub failed to start: hub did not become healthy within 30000ms; last hub stderr:

[Solo] Cannot continue without the hub: hub did not become healthy within 30000ms; last hub stderr:
```

Incarnation 3 (restarted by `f5` heal at `t=271334` on ephemeral hub port `43841`):
```text
[Solo] Panel is up (private port)
[Solo] Hub is up (private port)
[Solo] Hub healthy — connecting Centrifugo client
```

### Canonical log (`canon.jsonl`)

```json
{"k":"fault","t":120952,"id":"f1","phase":"start","kind":"bridge_kill9","target":"bridge","ok":true}
{"k":"fault","t":122345,"id":"f1","phase":"heal","kind":"bridge_kill9","target":"bridge","ok":true}
{"k":"op","t":135127,"op":{"op":"mail_send","tag":"CHAOS-M-10","to":"child2","type":"message"},"ok":true,"error":null}
{"k":"fault","t":148416,"id":"f2","phase":"start","kind":"clock_jump_fwd","target":"clock","ok":true}
{"k":"checkpoint","t":150001,"name":"cp5","final":false,"snap":{"bridgeAlive":false,"bridgeResponsive":false,...}}
{"k":"checkpoint","t":180001,"name":"cp6","final":false,"snap":{"bridgeAlive":false,"bridgeResponsive":false,...}}
{"k":"checkpoint","t":210001,"name":"cp7","final":false,"snap":{"bridgeAlive":false,"bridgeResponsive":false,...}}
{"k":"checkpoint","t":240001,"name":"cp8","final":false,"snap":{"bridgeAlive":false,"bridgeResponsive":false,...}}
{"k":"fault","t":269172,"id":"f5","phase":"start","kind":"bridge_sigterm","target":"bridge","ok":false}
{"k":"fault","t":271334,"id":"f5","phase":"heal","kind":"bridge_sigterm","target":"bridge","ok":true}
```

### Agent stderr (`side-child2.stderr.log`, `side-child3.stderr.log`)

- `t=150139` (`child2`): `ftown harness: fetch failed`
- `t=151912` (`child3`): `ftown harness: Bridge not running (no valid /data/bridge.json). Run ftown setup, then start ftown-bridge.`

## Hypotheses

| ID | Hypothesis | Status | Evidence & Counterexample |
| --- | --- | --- | --- |
| H1 | Wall-clock health deadline in `startHub()` expired prematurely when `CLOCK_REALTIME` jumped +90 s | **PROVEN** | `bridge/src/solo/hub-manager.ts:456,459` sets `deadline = Date.now() + 30_000` and loops `while (Date.now() < deadline && !state.exit)`. Only ~26.07 s of monotonic time elapsed between `f1` heal (`t=122345`) and `f2` clock jump (`t=148416`). After `f2` (+90 s), `Date.now()` exceeded `deadline` on the next loop check while `state.exit === null`, triggering `child.kill('SIGKILL')` (`hub-manager.ts:469`), `HubStartError` (`hub-manager.ts:474`), and `process.exit(1)` (`bridge/src/index.ts:1045-1046`), matching `side-bridge.log:59-61` verbatim. |
| H2 | Orphaned hub from the `SIGKILL`ed bridge held the port or pidfile so the new hub could not become healthy | **REJECTED** | Counterexamples: (1) Ports are ephemeral (`bridge/src/solo/contract.ts:32-34`, `bridge/src/index.ts:331-345`); incarnation 1 used `42327` (`side-bridge.log:13`) and incarnation 2 used `40669` (`side-bridge.log:53`), so no port collision was possible. (2) `reapStalePidFile()` (`bridge/src/solo/hub-manager.ts:385-396`) unlinks `hub.pid` unconditionally and sends `SIGTERM` without blocking. (3) Had the new hub failed to bind, it would have exited with stderr (`hub exited early ...`), whereas `side-bridge.log:59` reports `last hub stderr:` empty and `hub did not become healthy within 30000ms`. (4) Incarnation 3 started cleanly (`side-bridge.log:82-83`) without manual pidfile removal (contradicting the outdated note in `docs/solo.md:177-186`). |
| H3 | The new hub was never spawned or `spawn()` failed silently | **REJECTED** | Counterexamples: (1) A synchronous `spawn()` failure throws `failed to spawn hub binary: ...` (`bridge/src/solo/hub-manager.ts:424-427`). (2) An async `'error'` event logs `[ftown-solo] hub process error: ...` (`hub-manager.ts:438-440`), absent from `side-bridge.log`. (3) An early child exit sets `state.exit` (`hub-manager.ts:441-443`) and throws `hub exited early (code=..., signal=...)` (`hub-manager.ts:471-472`). The logged message `hub did not become healthy within 30000ms` (`hub-manager.ts:473`) is reachable only when `spawn()` succeeded and `state.exit` remained `null`. |

## Root cause

1. **Wall-clock deadline (`bridge/src/solo/hub-manager.ts:455-465`)**:
   - Line 456: `const deadline = Date.now() + deadlineMs;` (`DEFAULT_HEALTH_DEADLINE_MS = 30_000` at line 338).
   - Line 459: `while (Date.now() < deadline && !state.exit)`.
   - `Date.now()` reads `CLOCK_REALTIME` (wall clock), while `await sleep(intervalMs)` at line 464 uses `setTimeout` (monotonic). Stepping `CLOCK_REALTIME` forward by +90 s expires `deadline` immediately regardless of monotonic elapsed time.
   - Note: The same `Date.now()` deadline pattern exists in `bridge/src/solo/hub-manager.ts:488-489` (`stopHub`) and `bridge/src/solo/panel-manager.ts:681,688,763-764` (`waitHealthy`, `waitForPidDeath`).
2. **Was the hub actually healthy?**:
   - **No** at `t=148416`: ~26.07 s of monotonic time had elapsed since `f1` heal (`t=122345`), and Centrifugo had not yet responded `200` to `GET http://127.0.0.1:40669/health`. However, the child process was still alive (`state.exit === null`, no stderr) and still had ~4 s of its 30 s monotonic budget remaining when `startHub()` killed it with `child.kill('SIGKILL')` (`bridge/src/solo/hub-manager.ts:469`).
3. **Fatal bridge exit (`bridge/src/index.ts:369-379, 1040-1048`)**:
   - `hubReady` logs `[Solo] Hub failed to start: ...` (`index.ts:378`), then `await solo.hubReady` catches the rejection, logs `[Solo] Cannot continue without the hub: ...`, and calls `process.exit(1)` (`index.ts:1045-1046`).

## Impact

- **User experience**: If `CLOCK_REALTIME` steps forward while `ftown start --solo` is waiting for the hub (or panel) to become healthy during boot or restart, the bridge aborts startup, kills the child, and exits with code 1. The bridge stays down permanently until manually restarted (or restarted by an external process supervisor).
- **Real-world reachability**: A real deployment can hit this without a chaos harness during any forward wall-clock jump in the 30 s hub (or 45 s panel) startup window — e.g. NTP/`chronyd`/`systemd-timesyncd` initial clock step on boot, VM pause/resume, or laptop suspend/resume. In this test run, slow startup under single-threaded QEMU `-icount` kept the hub in its health-wait loop for >26 s right into the scheduled +90 s clock jump, making the bug **harness-amplified**.

## Classification and grade

- **Classification**: **SUT bug** (real bug, harness-amplified by QEMU `-icount` startup latency + scheduled `+90 s` `clock_jump_fwd`).
- **Grade**: **A** — exact `file:line` cause located and consistent with all logs, checkpoints, and source code.

## Suggested property to add

`R1` in `chaos/src/props/sessions.ts:26-41` only inspects `finalCheckpoint(log)`, so an unscheduled bridge death between `f1` heal (`t=122345`) and `f5` start (`t=269172`) passed because `f5` heal later restarted the bridge.

Add an `always` property (e.g. `R2: bridge stays alive outside bridge-down faults` in `chaos/src/props/sessions.ts`):
- Track active bridge-down fault windows from `fault` records (`bridge_kill9`, `bridge_sigterm`, `bridge_sigstop` from `phase: 'start'` until `phase: 'heal'`, plus a short boot grace after `heal`).
- Assert that at every `checkpoint` outside an active bridge-down window, `rec.snap.bridgeAlive === true` (and `rec.snap.bridgeResponsive === true` after boot grace).
- On seed 1 run 1, checkpoints `cp5` (`t=150001`), `cp6` (`t=180001`), `cp7` (`t=210001`), and `cp8` (`t=240001`) all record `bridgeAlive: false` outside any bridge fault window and would fail the run.

## Open questions

1. Why did Centrifugo take >26 s of monotonic guest time to answer `/health` in incarnation 2 (while `panel` became healthy in the same window)? Is it purely QEMU `-icount` CPU contention between Node, Next.js standalone, Centrifugo, and the 4 fake agents, or is something else delaying Centrifugo's HTTP listener?
2. Should `panel-manager.ts:681,688,763-764` and `hub-manager.ts:488-489` be migrated to `performance.now()` alongside `hub-manager.ts:456,459`?
