---
type: investigation
symptom: "Typing and switching sessions in the ftown UI are slow when 3-4 bridges are connected"
slug: ui-slow-typing-and-switching-with-multiple-bridges
date: 2026-11-07T11:00:00-03:00
investigator: Foad Kesheh
git_commit: 765237f
branch: perf/bridge-keystroke-latency
status: resolved
hypotheses_formed: 12
hypotheses_rejected: 11
hypotheses_proven: 1
related:
  - docs/investigations/2026-11-04-bridge-encrypted-publication-capacity-reached.md
---

# Typing and session switching are slow with 3-4 bridges

## Symptom
- **User report, verbatim:** "investigate why ftown is so slow to type and switching chat when 3,4 bridges are running, is it the encryption?" Follow-up: "should we switch to symetric keys after exchanging".
- **Observed:** keystroke echo and session ("chat") switching lag when 3-4 bridges are connected.
- **Expected:** echo and switch latency do not depend on how many bridges are connected.
- **Delta:** latency grows with the number of bridges. It has not been measured yet; this is the user's report.

## Reproduction
Not reproduced yet. Phase 1 was read-only code tracing plus a microbenchmark.

Phase 2 needs a measurement in the user's real browser with 3-4 bridges, covering:
- packets/s and bytes/s per channel;
- long tasks;
- time spent in crypto versus render;
- resize publishes and bytes per session switch;
- the active transport (direct or cloud).

## Evidence base (phase 1)
- The scheme is HPKE auth mode on every packet: DHKEM-P256, HKDF-SHA256 and AES-256-GCM, from `@hpke/core` 1.9.0 (`bridge/src/security/crypto.ts:18,203,219`).
  - There is no signature step.
  - Nothing asymmetric is cached across packets, on either the UI or the bridge.
  - Every packet also re-runs a self-key and a sender-key digest and import (`crypto.ts:139,148`).
- **Microbenchmark** of the real `crypto.ts` in Node 24.12, script in `scratchpad/perf-M1/`. Median µs:

  | payload | open | seal per recipient | open with a cached key |
  |---|---|---|---|
  | 200 B | 609 | 637 | 61 |
  | 2 KB | 850 | 806 | 264 |
  | 16 KB | 2983 | 2254 | 1969 |
  | 64 KB | 12356 | 10114 | 10822 |

  - At 200 B, HPKE context setup is 373 µs. Self and sender key validation add 121 µs, and AES-GCM about 30 µs.
  - At 16 KB and above, JS base64 and regex in `parseSecureEnvelope` dominate: 1.4 ms at 16 KB and 4.9 ms at 64 KB, and those run on the main thread.
- **Rates.** The estimated inbound load at one UI is about 1 packet/s with 4 bridges idle, and about 9 packets/s with one session streaming (R3 arithmetic: terminal flushes, hooks and session updates).
  - Terminal output reaches the UI only for the selected session (`hybrid-terminal-transport.ts:1083`).
  - Hook events arrive for every session (`useAllSessionEvents.ts:264`).

## Hypotheses

#### H1: Per-packet asymmetric HPKE crypto saturates the UI at 3-4 bridges
- **Layer:** dependency.
- **Prediction:** packet rate × open cost is a large share of the main thread.
- **Evidence:** about 9 packets/s × 0.61 ms is about 0.6% of one core, counting all threads. Even 80 packets/s is 4.9%. Chrome runs the WebCrypto work off the main thread.
- **Verdict:** REJECTED for small packets at realistic rates.
- **Rationale:** the load is two orders of magnitude too small. Caching keys saves about 0.55 ms per small packet, roughly 2 ms per keystroke round trip, which is imperceptible. Large packets remain open as part of H5.

#### H2: The UI replay guard reaches its cap and silently drops packets
- **Layer:** state-data.
- **Evidence:** the cap is 10,000 entries per 120 s, about 83/s. It throws `capacity_exceeded` and the throw is swallowed (`secure-endpoint-runtime.ts:185`, `secure-message-client.ts:24`). The estimated load of about 9/s is far below that.
- **Verdict:** REJECTED by estimate; to confirm with a live count.

#### H3: The `events:{sid}` subscriptions churn and replay their history repeatedly
- **Layer:** state-data.
- **Evidence:** `subscribe()` returns early for a session that is already subscribed (`useAllSessionEvents.ts:189`). A full teardown happens only when `[client, userId]` changes (:290-299). History is 100 events per session (`centrifugo/config.fly.json:73-80`), replayed only on page load or a new session.
- **Verdict:** REJECTED.

#### H4: Every inbound message from any bridge re-renders the whole Dashboard tree
- **Layer:** code-logic.
- **Evidence:**
  - There is no `React.memo` in `ui/src/components`.
  - `setSessions` produces a new array on every update, every 15 s poll per bridge, and every security change (`useSessions.ts:181,187,291,349`).
  - Hook events create a new `activityMap` (`useAllSessionEvents.ts:239`).
  - Presence produces a new array every 10 s (`useBridges.ts:164`).
  - The `securityGeneration++` every 30 s re-renders the whole tree (`Dashboard.tsx:253`).
  - Usage and list RPCs run per bridge every 15 s, and update checks per bridge every 60 s.
- **Verdict:** INCONCLUSIVE. Render cost has to be profiled in the browser.

#### H5: A session switch causes repeated resizes and full TUI repaints, producing large packets
- **Layer:** code-logic.
- **Evidence:**
  - The Terminal effect does a forced resize bounce (`Terminal.tsx:386-405`).
  - `scheduleTerminalRenderAdjustment` adds three more refits, at rAF, 80 ms and 250 ms (`Dashboard.tsx:197-203`).
  - Each bounce resizes to cols-1, then back to cols after 120 ms, and each resize is an encrypted publish to the bridge.
  - Large packets cost 3-12 ms each, partly as main-thread JS.
- **Verdict:** INCONCLUSIVE. Resizes and bytes per switch have to be counted.

#### H6: Direct transport is not established, so keystrokes take the cloud round trip
- **Layer:** config-env.
- **Evidence:**
  - The first session on a bridge waits up to about 5.5 s: `LOOPBACK_TIMEOUT_MS` is 1.5 s and `PAIR_TIMEOUT_MS` is 4 s (`direct-transport/contract.ts:12,17`).
  - Bridges before 0.20.4 dropped WebRTC signals under load (see the 2026-11-04 investigation).
- **Verdict:** INCONCLUSIVE. The transport per session has to be checked.

#### H7: Host CPU contention when the bridges run on the same machine as the browser
- **Layer:** config-env.
- **Evidence:**
  - Each publication does 1+3R policy snapshot disk reads, each with zod parsing and `structuredClone`, on a global promise tail (`snapshot.ts:52`, `security.ts:174,236-243`).
  - Bridge seals are serial (`outbound-pipeline.ts:166-168`).
  - Load average was about 95 on 8 CPUs on 2026-11-04, and is 6.65 now.
- **Verdict:** INCONCLUSIVE. It is not yet known where the 3-4 bridges run.

- **Update (live measurement):** the bridge and the client both run on this Mac, and one ftown bridge (v0.20.4, PID 43907) is running with 13 sessions.
  - **CPU over 60 s:** mean 33% of a core, median 3.9%, bursts up to 109% about every 10 s. Host load average was 6.65 on 8 CPUs.
  - **`sample` ×2:** crypto is about 2.5% of bridge CPU. Main-thread non-idle time is about 60% JSON/UTF-8 and 32-36% JS.
  - **Verdict:** H7 is REJECTED for the current setup. The host is not saturated, and bridge crypto is negligible.

#### H8: The usage collector re-parses every transcript on each poll and blocks the bridge event loop, delaying keystrokes
- **Layer:** code-logic.
- **Mechanism:**
  - The UI sends `get_sessions_usage` once per bridge every 15 s for each open client (`ui/src/hooks/useSessions.ts:414`).
  - That runs `command-rpc.ts:494`, then `session-controller.ts:221`, then `collectSessionUsage` (`usage-collector.ts:70`).
  - `jsonlLines` (`usage-collector.ts:256-272`) streams and `JSON.parse`s the whole transcript, with no cache for running sessions (`session-controller.ts:195`).
  - The sampled stack matches `fs::AfterInteger`, then `AsyncGeneratorAwaitResolveClosure`, then `Builtin_JsonParse`.
- **Measured** with the real function on the real files (`scratchpad/perf-R5/measure.mjs`, median of 5):
  - 467 MB and about 190k lines per poll;
  - 1.35 s of CPU per poll;
  - the largest files are 158 MB (322 ms), 105 MB (344 ms) and 65 MB (264 ms).
- **Falsification** (`scratchpad/perf-R5/impact.mjs`, median of 3):

  | Metric | Idle | During one collection |
  |---|---|---|
  | Event-loop delay p99 | 2.0 ms | 7.4 ms |
  | Event-loop delay max | 3.5 ms | 10.8 ms |
  | Simulated keystroke I/O callback p95 | 0.3 ms | 2.4 ms |
  | Simulated keystroke I/O callback max | 0.6 ms | 7.7 ms |
  | Callbacks over 50 ms | 0 | 0 |

  The stream chunks interleave with other work. The largest single line, 6.48 MB, parses in 3.6 ms.
- **Verdict:** REJECTED as the cause of the typing and switching lag. The worst block is about 11 ms.
- **Still a defect:** it re-reads about 467 MB, about 1.35 s of CPU, per client every 15 s. Worth fixing separately with an incremental per-session offset cache, a tail-read for Codex, and a short TTL shared across clients.

## Reproduction (live, 2026-11-07)
1. **Setup.** One bridge (v0.20.4) runs on this Mac. The dashboard is open at https://ftown.ia.br in Chrome.
2. **Instrumentation** (`scratchpad/perf-UI/instrument.js`):
   - long tasks and rAF gaps;
   - a wrapper on `SubtleCrypto`;
   - the xterm `onWriteParsed` echo time;
   - typing probes into the shell session `perf-typing-probe`.
3. **Load:** `scratchpad/lp-load/start-load.sh` starts 10 Haiku Claude Code sessions building landing pages.

| Metric (p50 / p95 / max) | Baseline | 10 Haiku sessions |
|---|---|---|
| keydown → echo parsed (ms) | 42 / 52 / 52 | 57 / **697** / **815** |
| echo → paint (ms) | 6 / 14 / 15 | 9 / 16 / 20 |
| keydown → UI encrypt (ms) | 1.6 / 2.4 / 2.4 | 1.2 / 1.7 / 1.8 |
| long tasks / frame gaps > 50 ms | 0 / 0 | 0 / 0 |

- Under load, the first 7 keys echoed together about 815 ms after the first key.
- The transport was WebRTC direct.
- **The browser is ruled out**, which REJECTS H4, H5 and H6 as causes of the lag:
  - there were no long tasks and no frame gaps;
  - encrypt runs within 2 ms of keydown;
  - paint takes 20 ms or less.

#### H9: Head-of-line blocking on the global policy snapshot queue
- **Code facts:** each keystroke round trip makes at least 5 reads on the global tail (`snapshot.ts:52`):
  - inbound: `security.ts:168`, `security.ts:194` and `direct.ts:34`;
  - echo: `security.ts:230` and `security.ts:233`.
- **Evidence** (offline, with the real modules, R = 8, `scratchpad/perf-A3/bench.mjs`):
  - A read costs 0.49 ms of CPU, of which zod is 0.38 ms.
  - The mean queue wait is 0.15 ms or less, at up to 1,100 reads/s.
  - Every caller awaits its reads one at a time, so the queue never builds up.
- **Verdict:** REJECTED as a queue. The cost of each read still matters (see H12).

#### H10: The main thread saturates its CPU
- **Evidence:** under load the main thread is non-idle only 24–40% of the time (`scratchpad/perf-A1/`), with no event-loop block over about 11 ms.
- **Verdict:** REJECTED as stated. The thread has spare CPU. Refined into H12.

#### H11: UI input flow control (one input in flight, waiting for a bridge ack)
- **Evidence:** over direct transport, `dispatchInput` sends synchronously (`hybrid-terminal-transport.ts:1163-1166`). The UI chain waits only for local seals (`webrtc-peer.ts:250-258`).
- **Verdict:** REJECTED.

#### H12: Keystrokes queue behind the usage collector, three factors combined
- **The factors:**
  1. **Many async hops per key, through a serial chain.** Each keystroke passes about 15 async hops, including at least 5 policy snapshot reads, each with open/stat/readFile/close plus zod. It goes through a per-peer serial chain: inbound awaits the outbound queue (`bridge/src/security/bridge/direct.ts:19-38`, `:37`).
  2. **Concurrent transcript streams.** While `get_sessions_usage` runs, `usages()` streams every running transcript concurrently (`session-controller.ts:214-221`, `usage-collector.ts:256-272`). That is K streams.
  3. **Fair scheduling.** Each hop of the keystroke waits its turn behind the chunk callbacks of the K streams.
- **Result:** the per-key cost inflates to tens or hundreds of ms. At typing speed the per-peer serial chain saturates, and keys pile up and echo together.
- **Layer:** code-logic (event-loop scheduling).
- **Prediction:** an offline probe through the real direct accept and seal path backs up to seconds with K production-shaped concurrent streams. It does NOT back up with a single stream, and it recovers when the policy is read from memory.
- **Evidence** (`scratchpad/perf-A3/`, results in `results.jsonl`; probe p50 at 20 keys/s):

  | Concurrent streams K | As-is | Policy in memory |
  |---|---|---|
  | 1 (one-stream hog) | 11–13 ms | 5 ms |
  | 12 | 3.1–3.4 s | 35 ms |
  | 24 | 5.8–6.8 s | 2.6–3.2 s |

  - At one key per 500 ms: K = 12 gives 75 ms (35 ms in memory), and K = 24 gives 143 ms (71 ms in memory).
  - Event-loop delay p99 stays at 4.5 ms or less throughout, so there are no long tasks.
  - Under K = 12, a snapshot read slows from 0.5 ms to 6 ms.
- **Live consistency:**
  - The main thread was about 60% idle while keys were delayed about 800 ms.
  - Under load the main-thread share of fs/promises completions grew to 22% (`perf-A1`).
  - The live load had more than 20 running sessions, each streamed on every usage poll.
- **Verdict:** PROVEN.

## 5 Whys
- **Symptom:** under load from many busy sessions, keystroke echo reaches 0.7–0.8 s and keys arrive in bursts.
- **Why 1?** Each keystroke spends tens to hundreds of ms in the bridge. Keystrokes for a peer are processed strictly serially, behind that peer's queued outbound seals (`direct.ts:37`), so a burst of typing backs up.
- **Why 2?** The keystroke path makes about 15 async I/O and crypto hops. While K transcripts stream concurrently on the same loop, each hop waits its turn behind them.
- **Why 3?** On every poll, the usage collector re-streams every running transcript in full (467 MB in 11 sessions, no cache), all at once, for each client every 15 s. Separately, every packet re-reads the policy file and re-validates it with zod (0.49 ms each, 1+3R reads per cloud publication).
- **Why 4?** Both were built for small inputs:
  - usage was designed as a stateless recomputation;
  - policy freshness, needed to catch revocations, was implemented as "re-read on every use" instead of change detection.
- **Why 5?** There is no latency budget or load test for the bridge's interactive hot path, so costs that scale with transcript size × session count × clients went unnoticed. Measurements of a single call, such as R5's 11 ms max block, hid the multi-hop amplification.

## Falsification
- **Counterfactual, policy served from memory:** at K = 12 and 20 keys/s, p50 drops from 3.1 s to 35 ms. The keystroke cost halves even without a hog.
- **Isolation, one stream versus K concurrent streams:** a single stream does NOT reproduce the delay (11–13 ms). Concurrency is necessary.
- **Absence:** with 0 publications/s and no hog, keystrokes take 12–14 ms p50. Encryption alone (HPKE with R = 8) does not reproduce the delay. This answers the user's question: it is not the encryption.
- **Adjacent cause, the cloud outbound pipeline:**
  - Echo over cloud at 40 publications/s gives p50 1.6 s with drops; from memory, 11 ms. This is relevant only in cloud fallback.
  - The observed live session was direct, so H12 explains it better.
- **Result:** H12 survived.

## Root Cause
- **Immediate:** while the usage collector streams every running transcript concurrently, the many-hop keystroke path is starved. Each policy read takes about 0.5 ms of zod plus 4 file-I/O hops, and the strictly serial per-peer chain (`direct.ts:19-38`) turns per-key latency into a backlog.
- **Architectural:**
  - the usage collector recomputes everything (no incremental cache, unbounded concurrency, no sharing across clients);
  - the policy is re-read and re-validated from disk on every packet;
  - there is no latency budget for the interactive path.
- **Rejected:**
  - H1, crypto: 0.6 ms per op, about 2–20% of bridge CPU;
  - H2, replay cap: about 9/s against the 83/s cap;
  - H3, history churn: subscriptions are made once;
  - H4/H5/H6, browser: no long tasks, and paint ≤ 20 ms;
  - H7, host CPU: load 6.6 on 8 cores;
  - H8, single-call event-loop block: max 11 ms;
  - H9, queue: wait ≤ 0.15 ms;
  - H10, CPU saturation: thread 60% idle;
  - H11, UI ack: no ack wait.

## Fix
Each change maps to a clause of the root cause.

1. **`bridge/src/jsonl-fold-cache.ts`** (new), used by **`usage-collector.ts`**. This addresses "recomputes everything, unbounded concurrency".
   - Every usage sum (claude, codex, pi, kimi, muse) is now an incremental fold.
   - The cache is keyed by (fold kind, path) and validated by dev/ino, by size ≥ offset, and by a 64-byte anchor before the saved offset.
   - Each poll reads only appended bytes. Half-written lines are retried on the next poll.
   - Calls for the same key are serialized. Across all sessions, a FIFO limiter allows at most 2 file reads at a time.
   - The read budget starts when a slot is acquired. A deadline stop resumes on the next poll.
   - This makes the cross-client TTL and Codex tail-only reads that were proposed unnecessary.
2. **`security/bridge/snapshot.ts`** (`AtomicSnapshot.load`/`save`). This addresses "the policy is re-read and re-validated from disk on every packet".
   - The parsed value is cached and validated on every read by a synchronous bigint `statSync` identity: dev, ino, size, mtimeNs, ctimeNs.
   - Any write by another instance or process changes the identity, so revocation stays immediate.
   - `save` invalidates the cache first. The cache only ever holds bytes parsed from a durable file.
   - The racy-timestamp rule applies: a file whose max(mtime, ctime) is less than 50 ms old is not cached. This guards against inode reuse together with coarse timestamps.
   - ENOENT still yields `initial()`. Every other stat error yields `storage_unavailable`.
3. **`security/bridge/direct.ts`**: `receive` no longer awaits `this.outbound`. This addresses "the strictly serial per-peer chain".
   - Each direction stays strictly ordered.
   - Callers ignore the returned promise: `peer-manager.ts:206`, `loopback-server.ts` (`void this.secure.receive`).
   - A screen for `attach` is still queued synchronously, before any later output.
4. **Not done:** caching imported keys in `crypto.ts`. The gain is small now, and the module is shared with the UI.

## Resolution
- **Regression tests.** Each fails on the base code and passes on the fix.
  - `bridge/src/security/bridge/direct.test.ts`: 2 of 4 fail on base, because the inbound frame stays blocked behind a pending seal.
  - `bridge/src/security/bridge/snapshot.test.ts`, 16 cases: the parse-count cases fail on base. An identity-ignoring cache mutant fails the 5 stale-read cases.
  - `bridge/src/jsonl-fold-cache.test.ts`, 19 cases. It checks:
    - equivalence under random appends;
    - delta-only reads;
    - the real open-handle limiter;
    - the truncate/rename/rewrite resets;
    - fake-clock deadline stops mid-chunk, which neither lose nor double-count lines.
    
    A 1500-iteration differential fuzz against a fresh fold also passed in review.
  - `bridge/src/usage-collector.test.ts`, 7 new cases. A missing kimi `wire.jsonl` is now skipped rather than nulling the whole collect.
- **Reproduction re-run** (`bridge/src/perf/keystroke-latency.perf.test.ts`, opt-in `FTOWN_PERF=1`). The setup:
  - R = 8 recipients;
  - 12 Claude transcripts of 40 MB each, growing;
  - usage polls every 5 s;
  - 20 publications/s;
  - 20 keys/s for 12 s.

  | Code | Keys measured | p50 | p95 | max | Result |
  |---|---|---|---|---|---|
  | Base | 240 | 9.4 ms | 895.8 ms | 1016.7 ms | fails |
  | Fix, run 1 | 240 | 4.4 ms | 11.9 ms | 89.8 ms | passes |
  | Fix, run 2 | 240 | 3.7 ms | 10.4 ms | 113.9 ms | passes |
  | Fix, run 3 | 240 | 4.0 ms | 10.6 ms | 95.9 ms | passes |
  | Final code, run 1 | 240 | 4.2 ms | 10.0 ms | 23.3 ms | passes |
  | Final code, run 2 | 240 | 4.4 ms | 10.4 ms | 16.3 ms | passes |

  The final runs include the review amendments: the racy-timestamp rule and owned anchors.

  The budget is p50 ≤ 50 ms and p95 ≤ 250 ms.
- **Equivalence.** A differential check compared base and new collectors: 301 synthetic fixtures with 1194 polls, and 37 real transcripts on this machine. There were 0 mismatches.
- **Full bridge suite.**
  - Base: 1358 tests, 24 failing.
  - Fix: 1403 tests, the same 24 failing, which are environmental.
  - `tsc` is clean.
- **Live re-run pending deploy.** The dashboard re-run with 10 busy Haiku sessions needs the production bridge to be updated to this build.
- **Known limits and follow-ups:**
  - On NFS, attribute caching can delay seeing an external policy write for up to `acregmin`.
  - A bare `\r` inside a line no longer splits records. readline did split them, but no harness writes them.
  - The outbound queue per peer is unbounded. This was already true, since PTY output was never back-pressured. Coalescing pending screens is a possible follow-up.
