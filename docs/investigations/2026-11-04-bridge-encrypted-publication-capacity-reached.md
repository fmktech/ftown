---
type: investigation
symptom: "Production bridge log is flooded with `[Centrifugo] Encrypted publication capacity reached` (plus one `[Centrifugo] Encrypted command rejected`) while the dashboard keeps polling"
slug: bridge-encrypted-publication-capacity-reached
date: 2026-11-04T15:58:02-03:00
investigator: Foad Kesheh
git_commit: f325c4ed1c71b88348a15f71c49e356681665509
branch: fix/bridge-publication-capacity
repository: fmktech/ftown
status: resolved
hypotheses_formed: 6
hypotheses_rejected: 5
hypotheses_proven: 1
related:
  - docs/investigations/2026-11-01-mobile-terminal-cannot-copy-selection.md
---

# Bridge drops cloud publications: "Encrypted publication capacity reached"

The investigation itself changed no source file. The fix that landed afterwards is described under Fix and Resolution. The experiments live outside the repo, in
`/private/tmp/claude-501/-Users-fkesheh-projects-ftown/99a20ec3-eacc-48b8-849e-8dba56f1eaba/scratchpad/pubcap-exp/`
(called `pubcap-exp/` below).

## Symptom

**Observed.** The user sent a screenshot of the production bridge's terminal. These lines are transcribed verbatim; the screenshot holds 50 lines in total:

```
[Bridge] Received command: get_bridge_update (requestId: 9e2c9a6c-8398-4532-a784-c891fab3dc78)
[Centrifugo] Encrypted publication capacity reached
[Centrifugo] Encrypted publication capacity reached
[Bridge] Received command: session_preview_status (requestId: a746d40c-4e18-42e6-ad11-a11b509d0728)
[Centrifugo] Encrypted publication capacity reached
[Bridge] Received command: list_sessions (requestId: 60549ca7-20dd-41ca-b0f7-b97a99f549ce)
...
[Bridge] Received command: list_sessions (requestId: 93e2a576-1643-474f-9b4c-b9ef3122311d)
[Centrifugo] Encrypted publication capacity reached
[Centrifugo] Encrypted publication capacity reached
[Centrifugo] Encrypted command rejected
[Bridge] Received command: session_preview_status (requestId: e99e7761-562e-46d7-b747-bdfc39891cf2)
[Bridge] Received command: session_preview_status (requestId: baf4a330-f960-4f5f-b3a7-2251a83bd3b1)
...
[Bridge] Received command: get_bridge_update (requestId: f4ab067d-1de2-43d1-a8e2-432133401a1c)
[Centrifugo] Encrypted publication capacity reached
```

The 50 visible lines break down as follows:

- 28 × `Encrypted publication capacity reached`;
- 1 × `Encrypted command rejected`;
- 21 × `Received command`:
  - 6 × `list_sessions`;
  - 6 × `session_preview_status`;
  - 3 × `session_preview_chunk`;
  - 3 × `get_sessions_usage`;
  - 3 × `get_bridge_update`.

The window contains **no** `Encrypted publication failed`, `Connecting`, or `Disconnected` lines.

**Expected.** Every live-state publication reaches the cloud: terminal output, screen dumps, hook events, session updates and WebRTC signals. Dashboard viewers stay current.

**Delta.** The bridge silently discards new cloud publications. Each discard prints one warning and nothing else: no channel, no type, no retry. The dashboard RPCs keep succeeding, so the dashboard looks alive while its live channels degrade.

## Production facts (read-only observation)

These facts come from the allowed read-only commands: `ftown-harness status` and `ls`, `ps`, and `ls` or `stat` of files.

```
$ ~/.ftown/bin/ftown-harness status
bridge: up  pid: 80748  id: cc184a54-ffcc-4ae5-831c-8b6b798033d4  since: 2026-11-03T13:55:51.896Z
$ ps -o pid,etime,args -p 80748
80748 01-04:39:39 node /Users/fkesheh/.ftown/cli/dist/ftown-cli.js start
$ cat ~/.ftown/cli/package.json   -> {"name":"ftown","version":"0.20.1", ... "gitHead":"825bd2e5518e79eb94f0b7651e924cbed6530c13"}
$ ~/.ftown/bin/ftown-harness ls  -> 15 sessions, every one "running alive" (codex x8, claude x4, shell x2, pi x1)
$ grep -n "capacity reached\|outboundQueued >= " ~/.ftown/cli/dist/centrifugo-client.js
131:            if (this.outboundQueued >= 100) {
132:                console.warn('[Centrifugo] Encrypted publication capacity reached');
$ git merge-base --is-ancestor 825bd2e HEAD && echo ancestor   -> ancestor (4 commits behind f325c4e)
$ git diff --stat 825bd2e HEAD -- bridge/src/centrifugo-client.ts bridge/src/security/bridge/{security,policy,snapshot}.ts \
    bridge/src/security/crypto.ts bridge/src/direct-transport/publish-router.ts bridge/src/terminal-pump.ts   -> (empty)
$ grep '"version"' ~/.ftown/cli/node_modules/centrifuge/package.json  ->  "version": "5.7.4"
```

The old log files are not the current log. `~/.ftown/bridge-restart.log` and `bridge-0.15.0.log` date from July 2026 and contain 0 matches for either line. The live stdout is the bridge's tmux pane, which I did not read because of the rules.

I also sampled live output by file size only, never reading content. The script is `pubcap-exp/flush-rate.mjs`. It polls `stat()` of each running session's `terminal.log` every 8 ms. Each size change is about one `TerminalPump.flush()`:

```
ftown_4                claude  1.00 flushes/s
prive_1                claude  6.70 flushes/s
vitalsigns             claude  2.05 flushes/s
all 15 running sessions: 9.75 flushes/s over 20s at 2026-11-04T18:56:09.777Z
```

This sample was taken about 1 h after the screenshot, with the codex sessions idle. At that time a single cloud-watched busy Claude session already produced 6.7 publications per second.

## Reproduction

The repro is in-process only: no network, no production bridge, no cloud. It runs the **real** `CentrifugoClient`, `BridgeSecurityService`, policy store and HPKE crypto. These are built exactly as `bridge/src/centrifugo-client.test.ts` builds them, from `secureFixture` plus `Object.defineProperty(client, 'client', fake)`. The fake `client` is a Centrifuge transport whose `publish()` resolves after `RTT` ms, standing in for centrifuge-js waiting for the server reply.

1. Copy the source and link the dependencies read-only. The worktree has no `node_modules`, and the dev repo lacks `zod` and `@hpke`. The linked install has the same dependency versions production runs: zod 4.6.7, @hpke/core 1.9.0, centrifuge 5.7.4.
   ```
   cd pubcap-exp && cp -R ../wt-pub-cap/bridge/src bridge/src && ln -s ~/.ftown/cli/node_modules node_modules
   echo '{"type":"module"}' > package.json && echo '{"type":"module"}' > bridge/package.json
   diff -rq bridge/src ../wt-pub-cap/bridge/src   # identical
   ```
2. Run the flood scenario with `pubcap-exp/e2-flood.ts` and `pubcap-exp/harness.ts`. The scenario:
   - R = 3 recipients: the always-provisioned local-cli endpoint and 2 browsers.
   - RTT = 30 ms.
   - One cloud-watched session emits 20 terminal flushes per second.
   - Hook events arrive at 1 per second.
   - A new watcher at t = 2 s triggers a 1.5 MB screen dump.
   - A WebRTC answer and 5 ICE candidates are sent at t = 8 s.
   - A dashboard `list_sessions` arrives every 1.5 s.
   ```
   TERM_HZ=20 SECS=25 /Users/fkesheh/projects/ftown/bridge/node_modules/.bin/tsx e2-flood.ts
   ```
   Output (`pubcap-exp/e2-term20.txt`):
   ```
   config: R=3 recipients, RTT=30ms, terminal 20/s, hooks 1/s, new watcher at t=2s (dump 1500000 B), WebRTC answer+ICE at t=8s, dashboard RPC every 1.5s, 25s
   t=  5s depth= 88 drops(+0) total=0 capacityLines=0 packetsOut(+121)
   t= 10s depth=100 drops(+62) total=62 capacityLines=62 packetsOut(+106)
   t= 15s depth=100 drops(+59) total=121 capacityLines=121 packetsOut(+127)
   t= 20s depth=100 drops(+55) total=176 capacityLines=176 packetsOut(+147)
   t= 25s depth=100 drops(+64) total=240 capacityLines=240 packetsOut(+120)
   publish() attempts by channel/type: {"terminal/output":508,"events/hook_event":25,"terminal/screen_dump":2,"commands/webrtc_answer":1,"commands/webrtc_ice":5}
   DROPPED by channel/type: {"terminal/output":216,"events/hook_event":18,"commands/webrtc_answer":1,"commands/webrtc_ice":5}
   RPC: sent=16 responded=16 latency median=45ms max=65ms; "Encrypted command rejected" lines=0
   first capacity line at t=5.95s; verbatim: [Centrifugo] Encrypted publication capacity reached
   WebRTC signals at t=8s: 6 attempted, 6 dropped (queue depth at the time: 100)
   ```
   With a milder load (10 Hz output, `SECS=60`, `pubcap-exp/e2-default-60s.txt`), the queue grows by about 1.6 slots per second. It reaches the cap at t = 41 s and then stays at 100, dropping about 1.2 publications per second:
   ```
   t= 40s depth= 99 drops(+0) total=0 capacityLines=0 packetsOut(+138)
   t= 45s depth=100 drops(+7) total=7 capacityLines=7 packetsOut(+143)
   t= 60s depth=100 drops(+6) total=25 capacityLines=25 packetsOut(+148)
   DROPPED by channel/type: {"terminal/output":16,"events/hook_event":9}
   first capacity line at t=41.02s; verbatim: [Centrifugo] Encrypted publication capacity reached
   ```

Verified 2026-11-04, about 15:30–15:55 -03:00: the symptom reproduces on demand with the exact production log line. Host load average was about 55 during all runs, so the absolute CPU timings are noisy. Every ratio and conclusion below survived that noise.

## Hypotheses

#### H1: The outbound chain is strictly serial and waits for one server reply per recipient packet, so throughput is about 1/(R·RTT). The fixed 100-slot tail-drop cap then discards every new publication while arrivals exceed that rate.

- **Layer:** code-logic. The cap and serial await are the defect; the trigger is ordinary load.
- **Prediction:**
  - Each publication costs about R × RTT, with exactly one packet in flight at a time.
  - Once arrivals exceed the throughput, depth climbs to 100, stays there, and every newer publication of any type is dropped. The production warning is printed exactly once per drop.
  - Removing only the per-packet reply wait makes the drops disappear under the same load.
- **Verification method:** read the code, run a micro-benchmark (`e1-cost.ts`, `e1b-components.ts`) and the reproduction (`e2-flood.ts`), then a counterfactual edit (see Falsification).
- **Evidence:**

  1. The chain. `bridge/src/centrifugo-client.ts:167-181` at f325c4e, identical in the production dist:
     ```
     if (!this.disabled && this.client.state === 'connected' && this.security) {
       if (this.outboundQueued >= 100) { console.warn('[Centrifugo] Encrypted publication capacity reached'); return Promise.resolve(); }
       this.outboundQueued++;
       const security = this.security;
       const run = this.outbound.then(async () => {
         const packets = await security.sealPublication(channel, { type: 'application', route: { kind: 'publication' },
           data: applicationJson(data), mcp: null });
         for (const packet of packets) {
           if (packet.type !== 'ftown_encrypted') continue;
           await security.policy.principal(packet.recipientId);
           await this.client.publish(channel, packet);
         }
       });
       this.outbound = run.catch(() => { console.error('[Centrifugo] Encrypted publication failed'); }).finally(() => { this.outboundQueued--; });
     ```

  2. One packet per recipient. `security/bridge/security.ts:236-240` and `policy.ts:173-179`:
     ```
     async sealPublication(channel, application) {
       const recipients = await this.policy.recipients();
       for (const recipient of recipients) {
         try { packets.push(await this.sealTo(recipient.endpoint.id, application, { transport: 'cloud', channel, ... })); }
     async recipients() { return this.snapshot.read(state => { ... state.devices.filter(device => {
         try { return this.active(state, device.endpoint.id).permissions.includes('read'); } catch { return false; } }) }); }
     ```

  3. The always-present local-cli recipient. `index.ts:571,577` and `policy.ts:248`:
     ```
     const localIdentity = await loadOrCreateIdentity(dataDir, auth.ownerId, 'local-cli');
     await security.policy.provisionLocalEndpoint(localIdentity.endpoint);
     state.devices.push({ endpoint: candidate, label: 'Local CLI', permissions: ['read', 'control', 'admin'], ...
     ```
     So R ≥ 1 even with no browser enrolled. Only `centrifugo-client.ts` and `mcp/relay.ts` construct a Centrifuge client, and the MCP relay subscribes only to `commands:rpc`. The cloud copies addressed to the local-cli endpoint therefore have no consumer.

  4. A publish waits for the server reply. In centrifuge-js 5.7.4 (`build/index.js:3961-3970, 5462-5473`), `publish()` does `yield this._methodCall(); yield this._callPromise(cmd, ...)`, and `_registerCall` arms `setTimeout(..., this._config.timeout)` with `timeout: 5000`.

  5. Measured cost from `pubcap-exp/e1-cost.ts`, which enqueues n publications below the cap and drains them. `maxInFlight=1` confirms strict serialization:
     ```
     R=1 rtt= 30ms small    ... publish()+drain=44.0ms/pub  (4 policy reads, 1 packets/pub)  => max 22.8 pub/s; maxInFlight=1
     R=2 rtt= 30ms small    ... publish()+drain=94.6ms/pub  (7 policy reads, 2 packets/pub)  => max 10.6 pub/s; maxInFlight=1
     R=3 rtt= 30ms small    ... publish()+drain=144.8ms/pub (10 policy reads, 3 packets/pub) => max 6.9 pub/s; maxInFlight=1
     R=5 rtt= 30ms small    ... publish()+drain=219.4ms/pub (16 policy reads, 5 packets/pub) => max 4.6 pub/s; maxInFlight=1
     R=1 rtt= 80ms small    ... publish()+drain=91.5ms/pub  => max 10.9 pub/s
     R=3 rtt= 80ms small    ... publish()+drain=265.8ms/pub => max 3.8 pub/s
     R=5 rtt= 80ms small    ... publish()+drain=447.4ms/pub => max 2.2 pub/s
     R=3 rtt= 30ms chunk60k ... publish()+drain=120.5ms/pub (10 policy reads, 3 packets/pub) => max 8.3 pub/s
     ```
     Per publication there are R packets, 1 + 3R policy snapshot reads, and R serial round trips.

  6. The reproduction above. Depth is pinned at 100, every drop prints the verbatim production line, and the drops are indiscriminate across terminal output, hook events and WebRTC signals.

- **Verdict:** PROVEN.
- **Rationale:** Every prediction occurred. Throughput falls as R × RTT grows, only one packet is ever in flight, and a sustained load above roughly 7 publications per second (R = 3, RTT = 30 ms) saturates the 100 slots. The production text appears once per drop. The counterfactual below removes the symptom.

#### H2: The queue is wedged: one `publish` never settles, `outboundQueued` never decrements, and every publication after it is dropped forever.

- **Layer:** state-data / dependency.
- **Prediction:** A wedged chain would show no packets leaving at depth 100. A timed-out publish would eventually print `Encrypted publication failed`.
- **Verification method:** read the centrifuge-js timeout, measure delivery while saturated, and inspect the screenshot.
- **Evidence:**
  - centrifuge-js arms a 5000 ms timer on every call (`_registerCall`, `timeout: 5000`), so no publish can hang forever. A timeout would reject `run` and print `[Centrifugo] Encrypted publication failed` (`centrifugo-client.ts:180`). That line is absent from the screenshot.
  - While pinned at depth 100 in E2, packets keep leaving: `packetsOut(+106) ... (+127) ... (+147) ... (+120)` per 5 s.
  - E4 (`pubcap-exp/e4-drain.ts`) shows the queue empties once producers stop:
    ```
    enqueued 130 back-to-back: depth=100 dropped=30
      t=2.0s depth=88 ... t=10.1s depth=47 ... t=18.2s depth=16
    drained in 22.1s => the last accepted frame reached the cloud 22.1s after it was produced; frames 100..129 were never sent
    ```
- **Verdict:** REJECTED.
- **Rationale:** The chain is slow but it progresses and drains. The saturation is a rate imbalance, not a wedge. There is no `failed` line, so publishes were succeeding, just slowly.

#### H3: HPKE sealing and the per-recipient policy-file reads (open, stat, readFile, JSON.parse, zod) are the CPU bottleneck.

- **Layer:** dependency / tooling (CPU cost of the crypto and storage stack).
- **Prediction:** If H3 is true, the components cost tens of milliseconds, and the drops persist with RTT = 0.
- **Verification method:** a warmed-up component micro-benchmark (`pubcap-exp/e1b-components.ts`) and an RTT = 0 run.
- **Evidence:**
  ```
  policy.principal (1 snapshot read)           median=0.103ms p90=0.151ms (n=300)
  policy.recipients (1 snapshot read)          median=0.096ms p90=0.193ms (n=300)
  crypto.seal 0.5KB (HPKE auth P-256)          median=0.777ms p90=2.061ms (n=300)
  security.sealTo (principal+seal+revalidate)  median=0.911ms p90=1.435ms (n=300)
  security.sealPublication R=3, 0.5KB          median=2.899ms p90=3.497ms (n=200)
  security.sealPublication R=3, 60KB           median=23.198ms p90=26.579ms (n=100)
  ```
  The same 21 publications/s load with RTT = 0 on the original code (`pubcap-exp/e2-term20-rtt0.txt`):
  ```
  t=  5s depth=  2 drops(+0) ... t= 15s depth=  3 drops(+0)
  DROPPED by channel/type: {}
  ```
- **Verdict:** REJECTED.
- **Rationale:** A small publication costs about 3 ms of CPU for R = 3, which supports more than 300 publications per second. With the round trip removed, the identical crypto and storage work causes no drops. The CPU is real overhead (about 8 ms per recipient for 60 KB slices) but it is not the limiter.

#### H4: The dashboard polling in the screenshot (`list_sessions`, `session_preview_status`/`session_preview_chunk`, `get_sessions_usage`, `get_bridge_update`) fills the queue, and its responses are what get dropped. This would be a feedback loop of timeouts and retries.

- **Layer:** observation (UI-side load).
- **Prediction:** If H4 is true, RPC responses or their handlers go through `publish()`, responses get dropped or delayed, and polling raises the queue depth.
- **Verification method:** read the code and measure RPC delivery while saturated.
- **Evidence:**
  - The RPC response bypasses `publish()`. `centrifugo-client.ts:327,332`:
    ```
    const response = await executeSecurePacket(security, ctx.data, { transport: 'cloud', channel, ... }, dispatch, ...);
    await this.client.publish(channel, response);
    ```
  - The handlers publish nothing. `grep -n "publishSessionUpdate\|publishHookEvent\|centrifugo\." bridge/src/command-rpc.ts` returns nothing. `get_sessions_usage` → `sessionController.usage()` publishes only for finished sessions (`session-controller.ts:203-209`), and the UI polls only running ones.
  - UI cadences:
    - `useSessions.ts:33` `LIVE_USAGE_POLL_MS = 15_000`, which drives both the `list_sessions` and `get_sessions_usage` periodic polls;
    - `preview-protocol.ts:4` `PREVIEW_POLL_MS = 1_000`;
    - `useBridgeUpdates.ts:127` 60 s, plus visibility and effect re-runs.
  - In E2, while saturated: `RPC: sent=16 responded=16 latency median=45ms max=65ms`, and in the 60 s run `sent=39 responded=39 latency median=37ms`.
- **Verdict:** REJECTED.
- **Rationale:** RPC traffic never enters the capped queue and is unaffected by it. The polled commands are only interleaved in the log. The real feedback loop is the WebRTC one (see Root Cause), not dashboard polling.

#### H5: The single `Encrypted command rejected` (`centrifugo-client.ts:335`) is caused by the flood: a dashboard command's response is capped, dropped, or timed out by the queue.

- **Layer:** state-data.
- **Prediction:** If H5 is true, saturated runs print the line for valid commands.
- **Verification method:** read the code (`execute.ts`, `centrifugo-client.ts:325-335`) and the trigger matrix `pubcap-exp/e3-rejected.ts`.
- **Evidence:** The line prints only when the async block throws. That happens in three cases:
  - `executeSecurePacket` rethrows for an unauthenticated packet whose error is outside the allowlist (`execute.ts:37-39`);
  - a handshake fails, because `execute.ts:9` `return security.handleHandshake(packet, route)` has no try/catch;
  - the response `this.client.publish` rejects.

  Trigger matrix (`pubcap-exp/e3.txt`):
  ```
  valid list_sessions from approved browser                      rejectedLines=+0 sealedReplyPublished=true
  expired envelope (ttl 1 ms) from approved browser              rejectedLines=+0 sealedReplyPublished=true
  route.sessionId != payload.sessionId (wrong_context)           rejectedLines=+1 sealedReplyPublished=false
  sender not approved on this bridge (approval_required)         rejectedLines=+1 sealedReplyPublished=false
  valid command but response publish rejects (5 s timeout/disconnect) rejectedLines=+1 sealedReplyPublished=false
  valid hello handshake from approved browser                    rejectedLines=+0 sealedReplyPublished=true
  expired hello handshake (ttl 1 ms; e.g. sent from a backgrounded tab) rejectedLines=+1 sealedReplyPublished=false
  ```
  Under saturation, every E2 run shows `"Encrypted command rejected" lines=0`.
- **Verdict:** REJECTED.
- **Rationale:** The rejected line is independent of the cap. The response path is not queued, and saturated runs never produce it. One of the four paths in the matrix produced it. Which one cannot be recovered, because `.catch(() => { console.warn('[Centrifugo] Encrypted command rejected'); })` discards the error. That is an observability gap; see the fix options.

#### H6: The production bridge runs different code from main, for example an older or smaller cap or a different chain.

- **Layer:** config-env (version skew).
- **Prediction:** If H6 is true, the production build lacks this code or differs from it.
- **Verification method:** read the installed `package.json` gitHead, `git diff` over the relevant files, and grep the installed dist.
- **Evidence:** See "Production facts": version 0.20.1, gitHead 825bd2e, an ancestor of f325c4e, an empty diff over every relevant file, and dist lines 131-132 with the same `>= 100` cap.
- **Verdict:** REJECTED.
- **Rationale:** Production runs exactly the analysed code.

## Findings per question

**Q1. Which publications flood the queue, and from which producers?** Every caller of `publish()`:

| Producer (call site) | Channel / type | Gate | Rate per event |
|---|---|---|---|
| `TerminalPump.flush` → `PublishRouter.publishTerminalData` → `publishTerminalData` (terminal-pump.ts:109; publish-router.ts:76-83; centrifugo-client.ts:251) | `terminal:{sid}` / `output` | only sessions with a live **cloud** watcher (`registry.hasWatchers`) | up to 62.5/s per watched session (`FLUSH_INTERVAL_MS = 16`); measured live 1 to 6.7/s per Claude session |
| `publishScreenDump` on every new watcher and on terminal-input `init` (index.ts:748-751, 798, 942-962) → `publishTerminalScreen` (centrifugo-client.ts:394-401) | `terminal:{sid}` / `screen_dump` plus 60 000-char `output` slices | each new (session, client) watcher: a session switch on the cloud path, a reload, or re-watch after the 60 s TTL | 1 + ⌈min(raw, 2.5 MB)/60 000⌉, so up to 43 publications per event, twice (viewport and full) |
| hook events (index.ts:970-985; terminal-pump.ts:131 synthetic Stop) | `events:{sid}` / `hook_event` | every hook, all 15 sessions, not gated by watching | per agent tool call |
| session updates (many sites: pump, controller, persisters, resurrection, create/remove) | `sessions:updates#{user}` / `session_update` | status, usage or id changes | bursty; on a bridge reconnect all live sessions are re-published (index.ts:631-652): 15 now |
| `publishSignal` from `DirectPeerManager.sendSignal` (index.ts:663-670) | `commands:rpc` / `webrtc_answer`, `webrtc_ice` | each direct-upgrade attempt | several per attempt |
| *not producers:* RPC responses (centrifugo-client.ts:332) and `publishCommandResponse` (cloud dispatch captures it in memory, index.ts:1002) | | | |

Every publication becomes R serial packets. The rate needed to saturate the queue is anything above about 4.6 to 23 publications per second, depending on R and RTT; see the E1 table.

The exact production mix at screenshot time could not be observed. From the screenshot, the drop rate is about 28 drops over a window holding 9 preview polls at about 1 Hz, so roughly 3 drops per second. That means arrivals exceeded throughput by about 3 publications per second. This matches a single cloud-watched busy session at R ≥ 3 (E2 at 10 to 20 Hz gives 1.2 to 12 drops per second).

**Q2. What does one publication cost, and what is the chain's ceiling?**

- CPU: about 1 ms seal plus 0.3 ms of policy reads per recipient for small messages, and about 8 ms per recipient for 60 KB slices.
- Wall time: about R × RTT plus that CPU, with strictly one packet in flight.
- Ceiling: about 22.8 / 10.6 / 6.9 / 4.6 publications per second for R = 1/2/3/5 at RTT = 30 ms, and 10.9 / 5.5 / 3.8 / 2.2 at RTT = 80 ms.
- The cloud host is AWS sa-east-1 (per the deploy note), but the real RTT was not measured because no network probes were allowed.

**Q3. What is dropped, and what does the user see?** The cap is a tail drop: the newest publication is discarded and old ones are kept.

- **Terminal output** on the cloud path loses byte ranges, which gives a garbled or stale terminal until the next screen dump. The frames that are accepted lag by up to about 22 s (E4).
- **Screen-dump slices** give a partial or blank terminal when opening a session.
- **Hook events**, including the synthetic Stop, leave the activity indicator stuck on "working" or stale.
- **Session updates** leave statuses stale until the next 15 s `list_sessions` poll.
- **WebRTC answer and ICE** are dropped outright (E2: `6 attempted, 6 dropped`), or delayed past the UI's `PAIR_TIMEOUT_MS = 4_000` (E5: an answer enqueued at depth 83 had still not left 7.5 s later). The direct upgrade then fails and the session stays on the cloud path (`goCentrifugo`, hybrid-terminal-transport.ts:1063-1110). That keeps terminal output and dumps flowing through `publish()`: a **positive feedback loop**.
- RPC responses are **not** dropped, so the dashboard appears healthy. Dashboard polling does **not** feed the loop (H4).

**Q4. What is the trigger, and does the queue drain?** It drains only when arrivals fall below throughput, for example when the agent goes idle, the viewer leaves, or the watch expires after 60 s (`WATCH_TTL_MS`). Otherwise it stays pinned at 100 (E2: depth = 100 for 20 s straight).

The triggers are:

- a busy cloud-watched session;
- dump bursts: E5 (`pubcap-exp/e5.txt`) shows 3 session switches in 6 s on the cloud path reach depth 83 with no busy output at all;
- a bridge reconnect re-sync of the 15 live sessions;
- hook traffic across the 15 sessions.

All of these are multiplied by R.

**Q5. What causes `Encrypted command rejected`?** It is unrelated to the cap (H5). The possible causes are:

- a security rejection outside the allowlist (`wrong_context`, `approval_required`, `authentication_failed`, or a ZodError);
- a failed or expired hello handshake;
- a failed response publish (5 s timeout or disconnect).

The swallowed error makes the actual cause unrecoverable.

**Q6. Is it new?** Yes.

- `git log -S 'outboundQueued'` → `8425849 2026-10-25 Encrypt bridge transports and add MCP security history (#135)`.
- The first release containing it is `bridge-v0.19.53`.
- Before it, `git show 8425849^:bridge/src/centrifugo-client.ts` had `void this.client.publish(channel, data).catch(...)`: one plaintext packet, pipelined, no cap.
- `grep -c "capacity\|outboundQueued" bridge/src/centrifugo-client.test.ts` → `0`, so no test exercises the cap or the throughput.

## 5 Whys

- **Symptom:** The bridge prints `Encrypted publication capacity reached` many times per second and silently discards live-state publications.
- **Why 1?** Because `outboundQueued` sits at 100. Arrivals exceed what the outbound chain completes, and the cap discards every new arrival (H1, E2).
- **Why 2?** Because the chain completes only about 1/(R·RTT) publications per second. It is a single promise chain (`this.outbound.then`) that `await`s the Centrifugo server reply for each recipient packet before starting the next, so exactly one packet is ever in flight (E1: `maxInFlight=1`).
- **Why 3?** Because PR #135 replaced a fire-and-forget, single-packet publish with per-recipient sealing (R copies, including the local-cli endpoint that never reads the cloud). It serialized them with full reply awaits, presumably to keep ordering and bounded memory. It bounded the backlog with a count-based tail drop that has no priority, coalescing or resync signal.
- **Why 4?** Because the transport was designed and tested for correctness (confidentiality, ordering, never blocking local mutation acks) without a throughput budget. Nothing states the required publication rate (terminal output at up to 62.5/s per watched session, screen dumps of up to 43 slices) against the chain's ceiling. No test or metric covers saturation (0 tests reference the cap, and the warning carries no channel or depth).
- **Why 5?** Because every cloud publication type goes through one undifferentiated FIFO. That covers lossy-tolerant streams (terminal bytes), replace-latest state (session status, screen dumps) and latency-critical control (WebRTC signals). Under overload the system cannot shed the right thing, and its own failure (dropped or late signals) pushes clients onto the cloud path that overloads it.

## Falsification

- **Counterfactual edit:** I made a scratch copy `pubcap-exp/bridge-cf/src/centrifugo-client.ts` that differs only at line 177:
  ```
  <           await this.client.publish(channel, packet);
  ---
  >           // COUNTERFACTUAL: do not wait for the server reply per packet (pipelined, order kept by the socket).
  >           void this.client.publish(channel, packet).catch(() => { console.error('[Centrifugo] Encrypted publication failed'); });
  ```
  It runs the same load (`TERM_HZ=20 SECS=25 tsx e2-flood-cf.ts`, `pubcap-exp/e2-term20-counterfactual.txt`), with the same sealing, the same R = 3 packets, the same RTT, the same cap and the same producers:
  ```
  t=  5s depth=  1 drops(+0) total=0 capacityLines=0 packetsOut(+381)
  t= 25s depth=  2 drops(+0) total=0 capacityLines=0 packetsOut(+309)
  DROPPED by channel/type: {}
  WebRTC signals at t=8s: 6 attempted, 0 dropped (queue depth at the time: 1)
  ```
  Result: the symptom disappears. The cause is the serial reply wait, not the crypto, the cap value or the producers alone.
- **Absence test:** I ran the original code with RTT = 0 under the same load, which keeps the cause's code but removes its cost (see H3 evidence): `depth=2..3`, `DROPPED {}`. Consistent.
- **Adjacent-cause search:**
  - The dashboard polling (H4) is present in both the saturated and the counterfactual runs, yet drops occur only in the former. It cannot be the cause.
  - A wedged publish (H2) would show 0 packets leaving at depth 100, but the measured rate was 106 to 147 packets per 5 s.
- **Conclusion:** the hypothesis survived.

## Root Cause

- **Immediate cause:**
  - `bridge/src/centrifugo-client.ts:171-178` serializes every cloud publication on one promise chain and awaits `this.client.publish` (one server round trip, bounded only by the 5 s centrifuge-js timeout) for each of the R packets that `sealPublication` produces (`security.ts:236-240`). One for every `read` device, including the local-cli endpoint (`index.ts:571-577`).
  - Throughput is therefore about 1/(R·RTT): 6.9 publications per second at R = 3, RTT = 30 ms (E1).
  - When arrivals exceed it, line 168 tail-drops every new publication with the observed warning (E2 verbatim).
- **Architectural root:** A single count-capped FIFO handles every publication class, with serialized round-trip waits and no throughput budget. Terminal bytes, replace-latest state and WebRTC control share it with no priority, coalescing or resync. It was introduced in #135 (8425849, bridge-v0.19.53), and no test or metric covers saturation.
- **Rejected:**
  - **H2:** the chain drains (E4: 22.1 s) and keeps sending at depth 100. The 5 s timeout plus the absence of `Encrypted publication failed` rule out a wedge.
  - **H3:** seal is about 0.8 ms and a policy read about 0.1 ms. With RTT = 0 the same CPU work produces 0 drops.
  - **H4:** RPC responses bypass `publish()` (`:332`), and saturated runs answered 39/39 commands in about 40 ms.
  - **H5:** the rejected line comes from security, handshake or response-publish failures (E3 matrix). Saturated runs printed 0 rejected lines.
  - **H6:** production is 0.20.1 / 825bd2e with no diff in the relevant files, and its dist has the same cap.
- **Falsification:** the counterfactual (pipelined publish) gave 0 drops under the identical load, so the conclusion survived.

## Fix options (for the manager)

Ranked by leverage. None has been implemented.

1. **Pipeline the outbound chain and bound it by bytes in flight, not by a reply count.**
   - **Change:** keep sealing and ordering serial, but send the R packets without awaiting each server reply. Settle replies asynchronously, and apply backpressure on bytes or packets in flight, for example ≤ 2 MB.
   - **Evidence:** the counterfactual removed every drop at 21 publications per second.
   - **Files:** `bridge/src/centrifugo-client.ts` (`publish`), `bridge/src/centrifugo-client.test.ts` (new saturation and ordering tests using the fake-transport pattern above).
   - **Risks:**
     - Ordering assumes centrifuge-js writes commands in order on one socket and that Centrifugo applies publishes from one connection in order. This must be verified for `terminal:` (out-of-order output corrupts xterm).
     - Failure accounting moves to async callbacks.
     - Memory needs a real byte bound, because 60 KB slices × R add up.
2. **Make the queue class-aware.**
   - **Change:**
     - Give control traffic (`webrtc_*`) a priority lane that is never dropped.
     - Make `session_update` replace-latest per session id.
     - Make `screen_dump` replace-latest per session, cancelling older queued slices of the same session when a new dump starts.
     - Coalesce consecutive `output` frames per session up to 60 000 chars.
     - On overflow, drop the oldest terminal output and force a screen resync, never newer state or control.
     - Log the channel, type and depth (rate-limited) instead of the bare warning.
   - **Files:** `bridge/src/centrifugo-client.ts` (or a new outbound-queue module it owns), possibly `bridge/src/index.ts` (`publishScreenDump` resync hook) and `bridge/src/direct-transport/publish-router.ts`. Add tests.
   - **Risks:**
     - The most code.
     - Gaps in terminal output must always be followed by a dump, or viewers stay garbled.
     - Coalescing changes frame boundaries, which is fine for xterm.
     - The priority lane must keep per-channel order.
3. **Cut the multiplier R.**
   - **Change:** stop sealing cloud publications for recipients that never read cloud publication channels. That always includes the local-cli endpoint (−1 packet per publication, a 33 % saving at R = 3), and MCP endpoints for non-`commands` channels.
   - **Files:** `bridge/src/security/bridge/security.ts` (`sealPublication`), `bridge/src/security/bridge/policy.ts` (a cloud-recipient filter), and their tests.
   - **Risks:** recipient selection is security-sensitive and needs a security review. The gain is limited when many browsers are enrolled, so this is complementary to option 1 or 2, not a substitute.
4. **Quick observability (cheap, low risk, ship with any of the above):**
   - Include the error code in `Encrypted command rejected` (`centrifugo-client.ts:335`). Today it is swallowed, so the cause in Q5 cannot be determined.
   - Rate-limit the capacity warning with counts per channel type.
   - **File:** `bridge/src/centrifugo-client.ts`.
   - **Risk:** none, beyond log volume.
5. **Not recommended as a fix: reducing dashboard polling.** It does not feed this queue (H4), so it would only shorten the log interleave.

## Fix

The manager chose option 1 (pipelining) together with option 4 (observability). The change is uncommitted in the worktree on top of f325c4e.

- **New `bridge/src/outbound-pipeline-types.ts` (66 lines).** It holds:
  - the frozen limits `OUTBOUND_MAX_QUEUED = 100`, `OUTBOUND_MAX_IN_FLIGHT_PACKETS = 64`, `OUTBOUND_MAX_IN_FLIGHT_BYTES = 2 MiB` and `OUTBOUND_WARN_INTERVAL_MS = 5000`;
  - the log constants;
  - the `OutboundJob`/`OutboundPacket` contract;
  - `describeError()`.

  This traces to the root-cause clause "count-capped FIFO … no throughput budget": the budget becomes an explicit in-flight window instead of one reply at a time.
- **New `bridge/src/outbound-pipeline.ts` (216 lines).**
  - Job preparation (`sealPublication` plus the per-packet `policy.principal` check) and sends stay serial and in FIFO order.
  - Each packet's `send()` is started and **not awaited**. Its reply settles asynchronously and frees the window (`sendPacket`/`settle`).
  - The sender waits only when the window holds 64 packets or 2 MiB (`hasRoom`/`waitForRoom`).
  - The queued-job cap of 100 remains as the memory bound.
  - Drop and failure logs are throttled: one immediate line with depth, in-flight count and label, then one per-label summary per 5 s.

  This traces to "Why 2: awaits the Centrifugo server reply for each recipient packet before starting the next".
- **`bridge/src/centrifugo-client.ts` (+21/−14).**
  - `publish()` enqueues an `OutboundJob` labelled `channel/type` instead of chaining `this.outbound.then(...)`. This addresses the immediate cause at `:167-181`.
  - `Encrypted command rejected` now logs `${COMMAND_REJECTED_WARNING}: ${describeError(error)}` (`:342`). This addresses the H5 observability gap.
- **Regression tests.**
  - `bridge/src/centrifugo-client.test.ts` adds 4 tests:
    - `300 publications at ~200/s with a 50 ms reply never hit the capacity warning and all packets are published`. This is the regression test; it fails on origin/main with about 190 capacity warnings.
    - `packets reach the transport in publication order even when replies arrive in reverse`.
    - `only encrypted packets are published, each authorized once before its publication is sent`.
    - `a rejected command response is logged with its code and message`.
  - `bridge/src/outbound-pipeline.test.ts` adds 13 unit tests (O1–O9: window, order, drops, throttled summaries, idle, logger faults).
- **Justification of scope.** This fixes the throughput ceiling (Why 1–2). It does not yet split the FIFO by traffic class (Why 5); that is follow-up (b).

## Resolution

- **Diff summary:**
  - 2 new source files (282 lines);
  - `centrifugo-client.ts` +21/−14;
  - `centrifugo-client.test.ts` +102 lines;
  - `outbound-pipeline.test.ts` 402 lines.
- **Verification by the implementer** (reported, not re-run by me): bridge `tsc` exit 0. `npm test` shows the same 29 environmental failures as origin/main. One extra failure (attention-store) was flaky and passes 3/3 on both branches. The regression test fails on origin/main and passes on the fix.
- **Verification against this investigation's repro** (2026-11-04 about 16:25 -03:00, host load average 90–106):
  - **Setup.** I copied the fixed worktree into `pubcap-exp/bridge-fix/src`, and `diff -rq` reports it identical to `wt-pub-cap/bridge/src`. `pubcap-exp/harness-fix.ts` is `harness.ts` pointed at that copy, with depth read from `outbound.queued` and drops from `enqueue()` returning `false`.
  - **Same scenario as the Reproduction.** R = 3, RTT = 30 ms, 20 Hz terminal output plus 1 Hz hooks (21 pub/s), a 1.5 MB screen dump at t = 2 s, 6 WebRTC signals at t = 8 s and an RPC every 1.5 s.
  - **Original code, re-run at the same host load** (`pubcap-exp/e2-term20-ORIG-rerun.txt`):
    ```
    t= 10s depth=100 drops(+74) total=74 ...
    t= 25s depth=100 drops(+69) total=287 ...
    DROPPED by channel/type: {"terminal/output":263,"events/hook_event":18,"commands/webrtc_answer":1,"commands/webrtc_ice":5}
    WebRTC signals at t=8s: 6 attempted, 6 dropped (queue depth at the time: 100)
    ```
  - **Fixed code** (`TERM_HZ=20 SECS=25 tsx e2-flood-fix.ts`, `pubcap-exp/e2-term20-FIX.txt`):
    ```
    t=  5s depth= 56 drops(+0) total=0 capacityLines=0 packetsOut(+189)
    t= 10s depth= 36 drops(+0) total=0 capacityLines=0 packetsOut(+357)
    t= 15s depth=  2 drops(+0) total=0 capacityLines=0 packetsOut(+399)
    t= 20s depth=  1 drops(+0) total=0 capacityLines=0 packetsOut(+307)
    t= 25s depth=  6 drops(+0) total=0 capacityLines=0 packetsOut(+270)
    DROPPED by channel/type: {}
    RPC: sent=16 responded=16 latency median=66ms max=387ms; "Encrypted command rejected" lines=0
    WebRTC signals at t=8s: 6 attempted, 0 dropped (queue depth at the time: 49)
    ```
    The depth of 56 at t = 5 s is the 1.5 MB dump's 25 slices being sealed serially under load (see follow-up (a)). It drains to single digits by t = 15 s.
  - **Headroom, fixed code at 40 Hz (41 pub/s)** (`pubcap-exp/e2-term40-FIX.txt`): depth 91 → 70 → 36 → 37 → 99, and **5 drops in 25 s** (`terminal/output=4, hook_event=1`), against 287 for the original at 21 pub/s. The new limit is serial preparation CPU under host load, not the round trip.
  - **Drain, fixed code** (`pubcap-exp/e4-FIX.txt`, R = 3, RTT = 30 ms, 130 enqueued in one tick):
    ```
    enqueued 130 back-to-back: depth=100 dropped=30
    drained in 2.3s => the last accepted frame reached the cloud 2.3s after it was produced; frames 100..129 were never sent
    LOG [Centrifugo] Encrypted publication capacity reached (queued 100, in flight 0 packets / 0 bytes); dropped terminal/output
    LOG [Centrifugo] Encrypted publication capacity reached: dropped 29 more in the last 5s (terminal/output=29)
    ```
    The original code took 22.1 s. The 30 drops are by design: one tick enqueued more than the 100-job memory bound. The new logs carry depth, in-flight count, label and a per-label summary.
  - **New tests on the copy:** `tsx --test bridge-fix/src/outbound-pipeline.test.ts bridge-fix/src/centrifugo-client.test.ts` → `tests 21, pass 21, fail 0`.
  - **Conclusion:** the reproduction no longer triggers the symptom at the load that produced it (287 → 0 drops), and the WebRTC signals are no longer lost.
- **Follow-up:**
  - **(a) Seal cost under host load.**
    - A benchmark at load average about 95 on 8 CPUs gave `sealPublication` p50 of 14 ms (200 B), 19 ms (2 KB) and 121 ms (60k) for R = 3.
    - Serial preparation may become the next ceiling for 60k slices under heavy host load. The 40 Hz run above already reaches depth 99 with 5 drops.
    - Options: seal recipients concurrently (partial overlap, 0.52× at 2 KB), or cut R by not sealing cloud publications for the local-cli endpoint (fix option 3).
    - Both change the security pipeline and need a security review.
  - **(b) Class-aware queue** (Why 5, fix option 2):
    - coalesce consecutive terminal `output` per session;
    - keep only the latest `session_update` and `screen_dump` per session, cancelling stale queued dump slices;
    - give WebRTC signals a priority lane that is never dropped;
    - on overflow, drop the oldest output and force a screen resync instead of a silent tail drop.
  - **(c) UI replay-guard cap.** The UI keeps at most 10,000 replay entries per 120 s envelope lifetime, about 83 packets per second per device. With publications no longer throttled by the round trip, a busy cloud-watched session times R can approach that rate. The cap needs a check, a raise, or a tie-in to the coalescing in (b).

## Not verified

- **R in production.** Reading `~/.ftown/data/security/policy.json`, even for counts only, was denied by the permission classifier as credential exploration, so the number of browsers and MCP endpoints with `read` is unknown. R ≥ 1 is certain (local-cli).
- **The real round trip to Centrifugo,** because no network probes were allowed. The throughput is stated as a function of R and RTT.
- **The live log and producer mix at screenshot time.** I did not read the tmux pane, and the bridge has no per-channel counters. The current rates came from file-size sampling only, and they were taken after the screenshot.
- **Which path produced the single `Encrypted command rejected`.** The bridge discards the error (H5).
- **Whether the viewing dashboard was on the cloud path** (WebRTC failed or remote device) or on the loopback path.
- **Absolute CPU timings,** which were taken at host load average 55. The conclusions rest on ratios and on the counterfactual, which are robust to that noise.
