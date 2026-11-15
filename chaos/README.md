# Deterministic Chaos Harness

## What It Is

The `chaos/` harness runs deterministic chaos testing for `ftown`. A pseudorandom seed drives a fault schedule against a real `ftown start --solo` bridge with scripted fake agents inside a no-network QEMU guest with an instruction-counted clock (`-icount`). Given the same seed, commit, and guest image, the harness produces a byte-identical canonical execution log (`canon.jsonl`) and SHA-256 hash (`H_run`). Faults happen exclusively inside the guest environment, never affecting the host. Invariants across mail delivery, attention routing, tree events, and session lifecycles are checked purely against the resulting canonical log.

## Requirements

- **Node.js**: Node 24 (`>=24.12.0`), executing TypeScript directly via type stripping.
- **Docker**: Docker daemon running on the host, used to build container images and run headless QEMU.
- **First Build Downloads**: The initial build downloads hermetic dependencies pinned by version or digest:
  - Base container images: `debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc` and `node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c`.
  - Pinned Debian packages: `qemu=1:7.2+dfsg-7+deb12u18` (source), `qemu-system-x86=1:7.2+dfsg-7+deb12u18+b3` (runtime and SeaBIOS firmware), and `linux-image-6.1.0-54-cloud-amd64=6.1.190-1` (guest kernel).
  - Pinned Centrifugo archive: `v6.10.2` linux-amd64 verified against `CENTRIFUGO_SHA256['linux-amd64']` from `bridge/src/solo/contract.ts` via `sha256sum -c`.
- **Build Time**: Approximate build time on arbitrary machines is unknown. Factsheet records show ~84 s for a clean `--no-cache` build on developer hardware with base layers pulled, and ~5 s cached.

## Quick Start

### 1. Build the guest image and kernel
Builds the kernel (`vmlinuz`), initramfs (`initramfs.cpio.gz`), and QEMU container into `chaos/.cache/`:
```bash
npm run test:chaos -- build
```
Flags and defaults:
- `--image <tag>`: Custom container image tag (default: builds `ftown-chaos-box:dev` from `chaos/box/Dockerfile`). A custom image keeps the chaos-side fingerprint only; the box is not rebuilt.
- `--check-repro`: Builds initramfs twice and asserts identical SHA-256 digests (default: false).

The guest image is a function of one file list: tracked and untracked, not gitignored, under `bridge/`, `chaos/src` (no `*.test.ts`), `chaos/box`, `chaos/qemu`, and `chaos/package.json`. The build stages that list at `chaos/.cache/context` with mode `0755` or `0644` and write-time mtimes (mtimes are not pinned: BuildKit would skip re-reading a same-size edit). The box build reads the whole tree; the QEMU and kernel builds read its `chaos/qemu` prefix; the initramfs pack mounts `chaos/src`, `chaos/package.json`, and `chaos/qemu/init` from the same tree. Each fingerprint entry is the path, the byte hash, and the executable bit. `chaos/box/Dockerfile.dockerignore` is a comment and matches nothing. A second build exits 3 while `chaos/.cache/build.lock` is held by a live pid. A lock whose pid is dead is reclaimed. A lock whose pid is alive but whose age exceeds 60 minutes is stale and is reclaimed with a one-line notice, because a full build takes well under that. A lock with no readable pid is held.

### 2. Run guest selftest
Boots the VM into selftest mode, verifying hardware invariants (no network beyond `lo`, no `rdrand`/`rdseed`, TSC clocksource, fixed RTC start date) and requiring byte-identical reports:
```bash
npm run test:chaos -- selftest
```
Flags and defaults:
- `--times <n>`: Number of boots to compare (default: `2`).
- `--long <guest_s>`: Extended timing probe duration in seconds (default: disabled; sets default `--timeout` to `3600`).
- `--jobs <n>`: Concurrent VMs (default: `1`).
- `--mem <mb>`: Guest memory in MiB (default: `1536`, minimum: `1536`).
- `--timeout <s>`: Watchdog per boot in seconds (default: `300`, or `3600` with `--long`).
- `--icount-shift <n>`: Instruction-count shift where ns per instruction = 2^shift (default: `1`).
- `--no-build`: Fail instead of rebuilding if `chaos/.cache/` is missing or stale (default: false).

### 3. Run one seed
Executes the workload and fault schedule for a seed, comparing runs for determinism:
```bash
npm run test:chaos -- run --seeds 1
```
Or multiple seeds with flags:
```bash
npm run test:chaos -- run --seeds 1-4 --profile short --level low --times 2
```
Flags and defaults:
- `--seeds <spec>`: Seed list, e.g. `1`, `1-4`, `1-3,5` (required).
- `--profile <short|soak>`: Run profile (default: `short`).
- `--level <off|low|high>`: Chaos level (default: `low` for `short`, `high` for `soak`; `--level high` requires `--profile soak`).
- `--times <n>`: Boots per seed to compare (default: `2`).
- `--drop-faults <list>`: Comma-separated fault IDs or kinds skipped by the guest (e.g. `clock_jump_fwd`, `f1,f3`; default: none).
- `--jobs <n>`: Concurrent VMs (default: `1`).
- `--mem <mb>`: Guest RAM in MiB (default: `3072`, minimum: `1536`).
- `--timeout <s>`: Watchdog per boot in seconds (default: `2000` for `short`, `3000` for `soak`).
- `--icount-shift <n>`: Instruction-count shift (default: `1`).
- `--no-build`: Fail instead of rebuilding if `chaos/.cache/` is missing or stale (default: false).

### 4. Run a campaign
Runs a sequence of seeds and writes aggregated summaries to `chaos/out/campaign.json`:
```bash
npm run test:chaos -- campaign --seeds 1-20
```
Flags and defaults: Accepts `--seeds`, `--profile`, `--level`, `--times`, `--jobs`, `--mem`, `--timeout`, `--icount-shift`, and `--no-build` with the same defaults as `run`. Does not accept `--drop-faults`.

### 5. Reproduce a seed (`--repro`)
Runs a single seed repeatedly (default 5 boots) to verify determinism:
```bash
npm run test:chaos -- repro --seed 1
```
Or equivalently:
```bash
npm run test:chaos -- --repro 1
```
Flags and defaults: Accepts `--seed <N>` (or `--repro <N>`), `--profile`, `--level`, `--times` (default: `5`), `--drop-faults`, `--jobs`, `--mem`, `--timeout`, `--icount-shift`, and `--no-build`.

## Profiles and Levels

### Profile Timing (`PROFILE` in `contract.ts`)

| Profile | Fault Window Start (`faultWindowStartMs`) | Fault Window End (`faultWindowEndMs`) | Quiesce Duration (`quiesceMs`) | Checkpoint Interval (`checkpointEveryMs`) | Workload Bound (`workloadEndMs`) | Total Guest Virtual Time |
|---|---|---|---|---|---|---|
| `short` | 75,000 ms (75 s) | 115,000 ms (115 s) | 135,000 ms (135 s) | 15,000 ms (15 s) | 170,000 ms (170 s) | 250,000 ms (~4.2 min) |
| `soak` | 90,000 ms (90 s) | 330,000 ms (330 s) | 150,000 ms (150 s) | 30,000 ms (30 s) | 330,000 ms (330 s) | 480,000 ms (8.0 min) |

The fault window opens after bridge bring-up, root session creation, and early communication ops complete. Every fault heals by `faultWindowEndMs`, followed by a quiet period (`quiesceMs`) before the final checkpoint at `faultWindowEndMs + quiesceMs`.

### Chaos Levels

- `off`: No faults scheduled. Bridge and workload run unperturbed.
- `low`: Schedules 2–4 short faults in table order. Default for `short`.
- `high`: Schedules 3–5 short faults plus **exactly one long fault**. Long faults last 40–150 s and outlast bridge timeouts, so they do not fit in a short run. **Level `high` requires `--profile soak`** (the CLI rejects `--level high` with `--profile short`).

## Faults Table

The fault table is defined in `chaos/src/contract.ts`. Faults are drawn deterministically from this table in order:

| Fault Kind (`kind`) | Target (`target`) | Short Duration | Long Duration | Bridge Timeouts Outlasted / Invariants Checked |
|---|---|---|---|---|
| `bridge_kill9` | `bridge` | 1,000–3,000 ms | 75,000 ms | ask-hook `OUTAGE_LIMIT_MS` (60s), CLI `timeoutMs` (60s), envelope fetch (65s), `MAX_MAIL_WAIT_SECONDS` (30s) |
| `bridge_sigstop` | `bridge` | 2,000 ms | 40,000 ms | hub ping 10s + pong 5s, `maxServerPingDelay` 20s, `ATTENTION_WAITER_TTL_MS` 10s, hook curl `--max-time 2` |
| `bridge_sigterm` | `bridge` | 1,000–3,000 ms | None (`null`) | Graceful bridge shutdown path |
| `agent_kill9` | `agent` (child role) | 0 ms (instant) | None (`null`) | Event-driven agent exit path |
| `agent_sigstop` | `agent` (child role) | 3,000 ms | 150,000 ms | `HOOKED_BUSY_STALE_MS` 120s, `SUBAGENT_IDLE_DELAY_MS` 120s, `MAIL_NUDGE_BUSY_RECHECK_MS` 60s |
| `parent_kill9` | `parent` (`root`) | 0 ms (instant) | None (`null`) | Parent-exit escalation trigger |
| `clock_jump_fwd` | `clock` | 0 ms (jump: +90,000 ms) | 0 ms (jump: +2,100,000 ms) | `AGENT_BUSY_STALE_MS` 30min, `CARD_STALE_MS` 10min |
| `clock_jump_back` | `clock` | 0 ms (jump: -30,000 ms) | 0 ms (jump: -600,000 ms) | `MAIL_NUDGE_MIN_INTERVAL_MS` 30s and every `Date.now()` difference |

## Properties

Properties check invariants over the canonical log. All 12 properties from `chaos/src/contract.ts` and `chaos/src/props/*.ts` are pure functions:

- **M1** (`always`): Accepted mail is durable — Every accepted send (`mail_send` op or `mail_sent` agent event) is in the recipient inbox at the final checkpoint or already received (`bridge/src/mail-delivery.ts:506-519`).
- **M2** (`always`): Mail consumed at most once — Each mail tag is received by an agent at most once (`bridge/src/mail-delivery.ts:589-595,619-629`).
- **M4** (`always`): Nudge-once — A waking mail is covered by at most one nudge; total nudges received by a role never exceed its waking mail, and FYI mail never nudges (`bridge/src/coordination/contract.ts:216-220`).
- **M5** (`always`): Pending mail is recovered after heal — After faults heal, a live, idle recipient has no undelivered, un-nudged waking mail at the final checkpoint (`bridge/src/mail-delivery.ts:253-270`).
- **A1** (`always`): An ask is answered at most once — An ask receives at most one answer and resolution across the run (`bridge/src/attention-store.ts:423,455-462`).
- **A2** (`always`): Parent-routed ask escalates when the parent dies — Any open parent-routed ask is human-routed at the final checkpoint if the parent role is dead (`bridge/src/coordination/contract-b.ts:26-28`).
- **T1** (`always`): Tree-event seq strictly increasing — Root tree-event sequence numbers are strictly monotonic (`seq[i] === seq[i-1] + 1`), with no gaps, no duplicates, no regression, stable event kinds, and zero corrupt lines at the final checkpoint (`bridge/src/coordination/contract.ts:120`).
- **S1** (`unreachable`): Dead session shown live — A session is never shown with status `running` or `pending` at the final checkpoint while its tmux session and process are gone (`bridge/src/claude-runner.ts:344-390`).
- **R1** (`always`): Bridge is back after heal — Bridge is alive and responsive at the final checkpoint (`bridgeAlive: true`, `bridgeResponsive: true`), and all `session.json` files parse (`bridge/src/index.ts:1057-1074`).
- **R2** (`unreachable`): Bridge down while no bridge fault is active — Bridge is never dead at any checkpoint outside an active bridge fault window plus a 30,000 ms grace period after fault heal (`bridge/src/solo/hub-manager.ts`, `bridge/src/index.ts`).
- **C1** (`sometimes`): Bridge restarted with mail pending — Bridge was restarted (`bridge_kill9` or `bridge_sigterm`) while mail remained undelivered in an inbox (`bridge/src/mail-delivery.ts:186-205`).
- **C2** (`sometimes`): Parent died with an open child ask — A parent died (`parent_kill9`) while a child question with route `parent` was open (`bridge/src/coordination/wiring.ts:165`).

### M5 Exact Rule

At the final checkpoint, M5 checks every live recipient session (`status === 'running'`, `tmuxAlive === true`, and `procAlive === true`):
1. **Idle settled**: The recipient is idle settled if either it never issued a hook and `t_final - t_start >= 75_000 ms` (`SETTLE_MS = 75_000`), or its last hook event was `'Stop'` and `t_final - t_lastHook >= 75_000 ms`.
2. **Mail settled**: An inbox message is mail settled if `t_final - t_accepted >= 75_000 ms`.
3. **Evaluation**: For every waking (`type !== 'fyi'`), undelivered (`!delivered`), and un-nudged (`!nudged`) inbox message:
   - If **both** the recipient is idle settled and the mail is mail settled, M5 is **violated** (`pending <tag> to=<role>`).
   - If either condition is not settled, it is noted as non-violating info and passes (`pending, recipient not settled: <tag> to=<role>`).

## Reading a Result

### Summary Line

Each seed outputs a single summary line:
```text
seed 1  H_run=9f8a3c4b12e0  violated=-  wall=142.3s (71.1+71.2)  exit=0
```
- `seed`: Seed integer.
- `H_run`: First 12 hex characters of the SHA-256 digest of `canon.jsonl` (or `------------` on infra error).
- `violated`: Comma-separated list of violated property IDs (or `-` if none).
- `wall`: Total host wall-clock seconds across boots, followed by per-boot durations `(run1+run2)`.
- `exit`: Runner exit code.
- Tag: Appended on failure (`INFRA: <reason>` or `NONDETERMINISTIC`).

### Exit Codes

- `0` (`ok`): Clean run; all properties satisfied and runs produced identical hashes.
- `1` (`violation`): Invariant violated; an `always` was violated or unexercised, or an `unreachable` was reached.
- `3` (`infra`): Infrastructure failure; VM boot failed, watchdog timed out, Docker failed, or guest setup aborted.
- `4` (`reproDiverged`): Reproducibility failure; two runs of the same seed produced differing `canon.jsonl` contents or hashes.
- `64` (`usage`): Command-line argument syntax error or unsupported flag combination.

Precedence: `infra` (3) > `reproDiverged` (4) > `violation` (1) > `ok` (0); `usage` (64) wins outright on bad arguments.

### Output Files

Outputs are saved in `chaos/out/<seed>-<profile>/run<k>` (or `chaos/out/<seed>-<profile>-drop-<list>/run<k>`):
- `canon.jsonl`: Canonical execution log (run metadata, schedule, faults, ops, agent events, checkpoints, verdicts). Hashed for determinism.
- `verdicts.json`: Verdict array for all evaluated properties with kind, status, and evidence strings.
- `side-bridge.log`: Full stdout and stderr of the `ftown start --solo` bridge process.
- `side-procs.txt`: Periodic process table snapshots (`ps aux`) taken at each checkpoint.
- `side-tmux.log`: Tmux server and session activity logs.
- `console.log`: Raw serial console log from kernel boot and guest `/init` (ttyS0).
- `frames.txt`: Raw ttyS1 frame stream containing base64-encoded files.

## Triaging a Violation

1. **Reproduce with `--repro`**:
   Confirm consistent reproduction across multiple boots:
   ```bash
   npm run test:chaos -- repro --seed 1 --profile short --level low
   ```
2. **Compare runs**:
   Diff `canon.jsonl` between runs (`diff -u out/1-short/run1/canon.jsonl out/1-short/run2/canon.jsonl`) and inspect `verdicts.json` evidence fields to identify the failing property and violating records.
3. **Test counterfactuals with `--drop-faults`**:
   Drop the suspected fault from the schedule to test causation:
   ```bash
   npm run test:chaos -- run --seeds 1 --profile short --level low --times 1 --drop-faults clock_jump_fwd
   ```
   Check if the violation clears in `chaos/out/1-short-drop-clock_jump_fwd/run1/`.
4. **Decide harness bug vs bridge bug**:
   - *Harness bug*: The harness broke its contract (overlapping faults on a single target, wrong clock epoch, faulty property check).
   - *Bridge bug*: The bridge failed under a valid fault schedule (e.g. wall-clock deadline expired early on clock jump, lost message).
5. **Write findings to `chaos/findings/`**:
   Document confirmed issues as `chaos/findings/FN-<title>.md` with an evidence grade:
   - **Grade A**: Verified bridge code path + counterfactual holds + alternative explanations ruled out.
   - **Grade B**: Strong reproduction trace, but partial counterfactual or unproven determinism gap.
   - **Grade C**: Suspected issue without deterministic reproduction.
6. **Security findings policy**:
   `ftown` is a public repository. Never commit security reviews, vulnerabilities, or threat models to `chaos/findings/` or git. Write security findings exclusively to `.security-notes/` at the repository root (git-ignored) and report directly to the maintainer.

## Determinism Rules and Known Limits

### Determinism Rules for Contributors

From `chaos/AGENTS.md`:
- **Time**: In-guest code reads time exclusively through `Clock.now()` (shared epoch from `/run/chaos/t0`). Never use `Date.now()`, `Math.random()`, or host `setTimeout` in anything feeding the canonical log.
- **Randomness**: All randomness derives strictly from `deriveRng(seed, label)`.
- **Hermetic Runtime**: The guest runs with `-nic none` and has no network interfaces other than `lo`.
- **Iteration Order**: Always sort object keys and directory listings (`readdir`) before iterating or logging.
- **No Service Edits**: The harness observes; never modify code under `bridge/`, `ui/`, `e2e/`, etc.
- **Git**: Commit locally on the task branch; never push.
- **Unit Tests**: Run unit tests with `cd chaos && npm test`.

### Carried QEMU Patch: TLB Deterministic Resize

Stock QEMU 7.2 dynamically sizes its softmmu translation lookaside buffer (TLB) based on host wall-clock time between flushes. Under `-icount`, host CPU scheduling jitter causes variations in TLB sizing and eviction timing, which leak into guest page table entry (PTE) Accessed and Dirty bits, destroying determinism across runs.

The carried patch (`chaos/qemu/patches/tlb-deterministic-resize.patch`, enabled by default via `TLBFIX=1` in `chaos/qemu/qemu.Dockerfile`) ties TLB resizing strictly to guest virtual instruction counts instead of host real time.

### Known Limits

- **Sleep-off warp**: Closed by `PATCH=1` (default) in `chaos/qemu/qemu.Dockerfile`. A halted vCPU counts as idle before its slice is added to `qemu_icount`, so the main thread could add the distance to the next virtual timer onto the instruction-count bias and the timer fired late by that unpublished tail. That depended on host scheduling and showed up as a few milliseconds in the final `canon.jsonl` timestamp of a soak pair. The patch reads `icount_budget` under `vm_clock_lock` and skips that warp while the budget is nonzero. The vCPU wakes the main loop after it publishes the slice. A warp that already sees a zero budget adds the same bias as before.
- **Single vCPU**: VMs run with `-smp 1` under single-threaded TCG. Multicore concurrency is not simulated.
- **Process-Crash Faults Only**: Injects process kills, signal pauses, and guest clock jumps. Power-loss faults (ungraceful VM reset), filesystem corruption, and network partitions are not simulated.
- **Not in CI Yet**: Due to QEMU `-icount` emulation cost, chaos tests are intended for manual runs, overnight campaigns, and targeted reproductions; they are not yet wired into CI pull-request checks.

## Licensing

QEMU patches in `chaos/qemu/patches/` are derivative works of QEMU (`1:7.2+dfsg-7+deb12u18`, upstream QEMU 7.2) and are licensed under the GNU General Public License, version 2 or later (`GPL-2.0-or-later`).

See [chaos/qemu/patches/LICENSE.md](qemu/patches/LICENSE.md) for full license terms, source files touched, and binary distribution requirements.
