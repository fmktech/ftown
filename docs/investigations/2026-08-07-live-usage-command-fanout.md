---
type: investigation
symptom: "Live session usage refresh emits a burst of get_session_usage commands"
slug: live-usage-command-fanout
date: 2026-08-07T05:19:34-03:00
investigator: Foad Kesheh
git_commit: c1ea6231f90aca3bfdb8a9ab2acbfe4ef16bc86f
branch: fix/smart-usage-refresh
repository: fmktech/ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-08-06-session-read-transient-json-500.md
---

# Live usage refresh floods the bridge command channel

## Symptom

- **Observed**: the user reported, verbatim, `I fell we are pooling` followed by a continuous block of `[Bridge] Received command: get_session_usage (requestId: ...)` messages. An independent E2E bridge artifact from Actions run `31134540427` contains:

  ```text
  217
  ```

  occurrences of `Received command: get_session_usage` during a single approximately three-and-a-half-minute run.
- **Expected**: refreshing usage for many live sessions should use bounded command traffic and should not poll when no collectable usage exists or the dashboard is in the background.
- **Delta**: each refresh pass emits one RPC for every running session, and changes to the running-session set trigger an additional immediate all-session pass.

## Reproduction

1. Open the dashboard with multiple sessions whose status is `running`.
2. Add running sessions one at a time or wait for the 15-second usage interval.
3. Observe bridge logs for `get_session_usage`.

Verified 2026-08-07: the saved bridge log contains 217 matching commands:

```text
$ rg -c 'Received command: get_session_usage' bridge.log
217
```

The implementation deterministically explains the burst: `ui/src/hooks/useSessions.ts:230-257` filters every running session and maps each one to `sendCommand`; lines 260-269 rerun that whole operation whenever the running ID set changes; lines 271-275 repeat it every 15 seconds.

## Hypotheses

#### H1: The UI deliberately fans each refresh pass out to every running session and retriggers the full pass when the running set changes

- **Layer**: code-logic
- **Prediction**: one refresh with N running sessions emits N distinct `get_session_usage` RPCs; adding sessions sequentially also causes immediate repeated passes over the previously running sessions.
- **Verification method**: inspect the live polling effect and count commands in an independent bridge run.
- **Evidence**:

  ```ts
  const running = sessionsRef.current.filter((session) => session.status === "running");
  await Promise.all(running.map(async (session) => {
    // ...
    const response = await sendCommand({
      type: "get_session_usage",
  ```

  ```ts
  useEffect(() => {
    if (!userId || !runningSessionKey) return;
    void pollLiveUsage();
  }, [userId, runningSessionKey, pollLiveUsage]);

  const interval = window.setInterval(() => void pollLiveUsage(), LIVE_USAGE_POLL_MS);
  ```

  ```text
  $ rg -c 'Received command: get_session_usage' bridge.log
  217
  ```

- **Verdict**: PROVEN
- **Rationale**: the caller implements an explicit one-command-per-running-session fan-out on both set changes and timer ticks; the runtime artifact exhibits the predicted repeated commands with unique request IDs.

#### H2: React reconnects or rerenders leak duplicate interval timers

- **Layer**: state-data
- **Prediction**: if H2 is the cause, the interval effect must omit cleanup or retain old timers after its dependencies change.
- **Verification method**: inspect the interval effect lifecycle at `ui/src/hooks/useSessions.ts:271-275`.
- **Evidence**:

  ```ts
  const interval = window.setInterval(() => void pollLiveUsage(), LIVE_USAGE_POLL_MS);
  return () => window.clearInterval(interval);
  ```

- **Verdict**: REJECTED
- **Rationale**: the effect explicitly clears its timer. Duplicate leaked timers are unnecessary to produce the observed burst because one valid timer already fans out N commands and the running-key effect independently adds more passes.

#### H3: The bridge retries or recursively generates usage commands

- **Layer**: dependency-integration
- **Prediction**: if H3 is true, handling one command should schedule another command, retry, or publish a live session update that loops back into command generation.
- **Verification method**: inspect `bridge/src/command-rpc.ts:223-235` and `bridge/src/session-controller.ts:131-153`.
- **Evidence**:

  ```ts
  const result = await sessionController.usage(payload.sessionId);
  response = result.ok
    ? { requestId: command.requestId, success: true, data: { usage: result.usage } }
    : { requestId: command.requestId, success: false, error: result.message };
  break;
  ```

  For live sessions, `SessionController.usage` returns the collected value without saving or publishing a session update.
- **Verdict**: REJECTED
- **Rationale**: the bridge performs exactly one collection and response per received command and has no retry or recursive publication path for live usage.

## 5 Whys

Symptom: the bridge logs large bursts of `get_session_usage`.

1. Why? Because each refresh emits one RPC per running session.
2. Why? Because the UI maps a per-session RPC across the complete running-session list.
3. Why? Because both the initial/set-change refresh and periodic refresh reuse the same unbounded fan-out.
4. Why? Because the bridge contract exposes only a single-session usage operation.
5. Why? Because the live-usage design lacked an aggregate refresh primitive and an explicit scheduling policy for capability filtering, burst coalescing, and background tabs.

## Falsification

- **Check performed**: adjacent-cause search. A leaked timer and a bridge retry loop could also create repeated logs.
- **Result**: the timer has explicit cleanup, and the bridge handler terminates after one response. Conversely, even with exactly one mounted timer and no bridge retry, the `running.map(sendCommand)` path necessarily emits N requests; the independent running-key effect repeats that fan-out as sessions are added.
- **Conclusion**: H1 survives. The burst is inherent in the documented scheduling and RPC shape, not dependent on a lifecycle leak or server retry.

## Root Cause

- **Immediate cause**: `pollLiveUsage` emits one command per running session, and is invoked by both a running-set effect and a 15-second interval (`ui/src/hooks/useSessions.ts:228-275`).
- **Architectural root**: the live-usage contract has no bridge-level batch operation or bounded client scheduling policy.
- **Rejected H2**: interval cleanup is present; one legitimate interval plus the running-set effect already reproduces the fan-out.
- **Rejected H3**: the bridge command/controller path responds once and does not recursively schedule usage requests.
- **Falsification**: removing duplicate-timer and bridge-retry explanations does not remove the deterministic N-command client fan-out.

## Fix

- Add a bridge-level batch usage RPC that accepts session IDs for one bridge and returns an ID-to-usage map while retaining the single-session RPC for compatibility.
- Build a pure UI polling plan that excludes sessions without collectable usage and groups eligible sessions by bridge.
- Debounce running-set changes into one batch per bridge, keep one periodic batch per bridge, and suppress polling while the document is hidden.
- Add regression tests at the existing command RPC boundary and the pure UI polling-plan seam.

## Resolution

- **Diff summary**: the dashboard now constructs stable, capability-filtered batches and sends `get_sessions_usage` once per bridge instead of `get_session_usage` once per running session. Running-set changes are coalesced for one second, hidden documents issue no usage traffic, and returning to a visible tab triggers one refresh. The legacy single-session command remains available.
- **Bridge contract**: `SessionController.usages` deduplicates IDs and collects them concurrently; the RPC boundary accepts at most 200 validated IDs per request and returns an ID-keyed usage object.
- **Regression tests**:
  - `ui/src/lib/live-usage-polling.test.ts` proves multiple eligible sessions collapse into one bridge batch, non-collectable sessions are excluded, and large sets are safely chunked.
  - `bridge/src/session-controller.test.ts` proves batch collection deduplicates IDs and tolerates sessions that disappear during refresh.
  - `bridge/src/command-rpc.test.ts` proves one batch command produces one ID-keyed response.
- **Verification**: bridge 534/534 tests passed; UI 132/132 tests passed; bridge and UI TypeScript checks passed; package dry-run produced `ftown-bridge-0.19.7.tgz`.
- **Result**: for N eligible sessions on one bridge, a normal refresh now emits one command instead of N. Sessions with no structured usage collector and background tabs emit zero.
