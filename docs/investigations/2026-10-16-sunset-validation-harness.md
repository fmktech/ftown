---
type: investigation
symptom: "Muse hook tests time out after 10s; retired HTTP Host test receives 410 instead of 421"
slug: sunset-validation-harness
date: 2026-10-16T14:00:00-03:00
git_commit: 656524670c92cc83090c63ecd7cd08daf4118e75
branch: feat/sunset-factory-cron
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

# Validation harness API mismatches

## Symptom and reproduction

The architect's isolated full bridge run reports 804 tests: 793 pass, 7 fail,
4 skip. Six Muse hook cases fail at approximately 10 seconds; the new HTTP
compatibility case fails at local-api-server.test.ts:324 with actual 410,
expected 421. The source hook files are unchanged by the sunset.

Run the full bridge suite with isolated HOME as recorded in the task evidence,
or isolate the child-process issue without a server:

```js
const run = promisify(execFile);
await run('/bin/cat', [], { input: 'payload', timeout: 150 });
```

Observed by the implementation worker before editing the harness:

```text
async execFile input option: killed=true, stdout=""
explicit child stdin end: stdout="payload"
```

The counterfactual uses the same executable and timeout API, with
`const execution = run('/bin/cat', [], { timeout: 1000 });`
then `execution.child.stdin.end('payload')` before awaiting the result.
No server or production hook process was used for this probe.

## Hypotheses

### H1: The asynchronous child-process fixture never sends or closes stdin

- Layer: test/tooling API boundary.
- Prediction: even an isolated `cat` child blocks until timeout when only the
  `input` option is supplied; explicitly ending the pipe returns the input.
- Verification: isolated probe above and source inspection at
  bridge/src/muse-plugin.test.ts:117-121 and muse-plugin/lib/ftown-hook.sh:27.
- Evidence: `input: stdin` is passed to promisified async `execFile`; the helper
  reads `INPUT=$(cat)`. The exact probe output is recorded above.
- Verdict: PROVEN. Async execFile does not implement the synchronous API's
  `input` option; the test must stream and close its child's stdin.

### H2: A missing jq/curl dependency causes the Muse 10-second failures

- Layer: environment.
- Prediction: missing dependencies cause a long wait.
- Verification: inspect the helper's dependency guards and full-run cases.
- Evidence: `command -v curl >/dev/null 2>&1 || exit 0` and
  `command -v jq >/dev/null 2>&1 || exit 0` precede `INPUT=$(cat)`;
  the "exits 0 when curl/jq are unavailable" case passes in 39ms.
- Verdict: REJECTED. This failure mode exits quickly rather than waiting for EOF.

### H3: A slow or unreachable bridge causes the exact 10-second wait

- Layer: network integration.
- Prediction: the wait requires a bridge connection and curl timeout.
- Verification: run the isolated cat probe; inspect curl deadlines.
- Evidence: the no-network cat child reproduces the timeout. The helper's curl
  calls use `--connect-timeout 1 --max-time 2` after reading stdin.
- Verdict: REJECTED. Network behavior is downstream of the blocked read.

## 5 Whys

1. Muse cases time out because their hook child is waiting for stdin EOF.
2. EOF never arrives because the fixture does not write/end the child pipe.
3. The fixture assumes async execFile supports the sync API's input option.
4. The wrapper mixes process creation and payload delivery without checking the
   actual payload handoff independently.
5. The harness lacks a focused stdin-delivery contract test. Add one alongside
   the corrected explicit pipe handoff; keep the production hooks unchanged.

## Falsification

The no-network isolated probe removes the bridge, jq, curl, plugin wrapper and
production runtime. The timeout persists with unsupported `input`; ending stdin
returns exactly the payload. This falsifies adjacent environment/network causes
and retains H1.

## HTTP fixture finding

The architect pinpointed actual 410 versus expected 421 in the fetch-based Host
spoof assertion. Existing local-browser-integration.test.ts:160-164 uses raw
`node:http.request` to send a real hostile Host header and verifies 421. Use that
same raw transport in the new assertion, leaving the production Host guard and
the rest of the legacy-route matrix unchanged. Browser-style fetch is unsuitable
for asserting this restricted header on this runtime.

## Fix and verification plan

- End the actual async execFile child's stdin with the supplied payload.
- Add a pure fixture test that echoes the input and detects this exact defect.
- Send the hostile Host header using raw node:http in the HTTP regression.
- Main assistant reruns all listener-backed tests and the full suite; the worker
  runs only the pure stdin fixture/installer checks and static build.

## Worker verification handoff

The corrected pure stdin fixture and installer ownership tests pass (7/7), and
`npm run build` plus `git diff --check` pass. No listener-backed tests were run
by the worker. The existing six Muse behavioral cases and the hostile Host
matrix remain the main assistant's full-suite regression gate; production hook
scripts and HTTP Host enforcement were not changed.
