---
type: investigation
symptom: "[why so much?"
slug: attention-polling
date: 2026-10-28T22:37:02-03:00
investigator: Foad Kesheh
git_commit: ebd108eb1628d261339891cb683d0a2b16ae8d62
branch: fix/attention-polling-noise
repository: fmktech/ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-10-24-attention-refresh.md
---

# Repeated attention receipt logs
> Historical investigation of logging noise. The user clarified that the target is unnecessary transmissions; the logging-only patch was reverted. See [the transmission investigation](2026-10-28-attention-transmissions.md) and [its final review](2026-10-28-attention-transport-review.md) for the final change.


## Symptom
User pasted approximately 80 lines of the form `[Bridge] Received command: get_session_attention (requestId: 9043d238-b846-4d45-9319-2bd69a6c813a)` with distinct request IDs, interspersed with three `list_sessions`, after `[Bridge] Resurrected session 9a2cd677-9551-48a8-b1df-ffe088709036 via tmux reattach`, and asked `[why so much?`. The desired outcome is a quieter bridge console while preserving useful operation and error visibility. This investigation proves why each receipt is printed; the transcript contains no timestamps, so it does not establish a request rate, fixed interval, excessive traffic, or the precise triggering lifecycle in the deployed UI.

## Reproduction
Read-only, in-memory reproduction using the installed 0.19.58 runtime's `createCommandHandler`, mock session controller and attention store, and an in-memory response array; no live bridge or state was modified:

```sh
node --input-type=module <<'NODE'
import { createCommandHandler } from '/Users/fkesheh/.ftown/cli/dist/command-rpc.js';
const responses = [];
const handler = createCommandHandler({bridgeId:'owner',sessionController:{get:async id=>({id,bridgeId:'owner'})},attentionStore:{explicitSnapshot:async()=>({attention:null,sequence:0})},publishCommandResponse:async response=>responses.push(response)});
await handler({type:'get_session_attention',requestId:'local-read',payload:{bridgeId:'owner',sessionId:'session'}});
await handler({type:'get_session_attention',requestId:'foreign-read',payload:{bridgeId:'other',sessionId:'session'}});
console.log('responses:', JSON.stringify(responses));
NODE
```

Verified 2026-10-28; command output (Node color warning omitted):

```text
[Bridge] Received command: get_session_attention (requestId: local-read)
[Bridge] Received command: get_session_attention (requestId: foreign-read)
responses: [{"requestId":"local-read","success":true,"data":{"sessionId":"session","attention":null,"sequence":0}}]
```

`cmp` verified the copied runtime `~/.ftown/cli/dist/command-rpc.js` is byte-identical to the running npm package's `dist/command-rpc.js`. PID 78921 runs `node /Users/fkesheh/.npm/_npx/42a3c29a29e8ae75/node_modules/.bin/ftown --api-url https://ftown.ia.br`; the corresponding package is `ftown` 0.19.58. This is evidence of installed artifacts and process path, not proof that the process's in-memory code could not predate an on-disk replacement. Its stdout/stderr point to `/dev/ttys000`; no timestamped current log was available. Current main package is also 0.19.58. The original dirty `feat/solo-mode` checkout is 0.19.39 and does not represent this runtime.

## Hypotheses

#### H1: Routine attention reads are printed because the command handler logs every receipt before target filtering.
- **Layer**: observation / code logic.
- **Prediction**: Both an owned read that succeeds and a foreign read that is ignored print a receipt, regardless of failure or response outcome.
- **Verification method**: Isolated installed-runtime reproduction above; current source inspection `bridge/src/command-rpc.ts:71-77,128-141,361-386`.
- **Evidence**: The two receipt lines above and one successful owned response; current source says `console.log(...command.type...)` before `if (payloadBridgeId && payloadBridgeId !== bridgeId) return;`.
- **Verdict**: PROVEN for the mechanism generating the printed lines, not the rate of live requests.
- **Rationale**: Both branches print despite different processing outcomes, and the reproduction matches the user's line format.

#### H2: Current main's attention hook uses a recurring timer to poll at a fixed interval.
- **Layer**: UI code logic.
- **Prediction**: `ui/src/hooks/useAllSessionEvents.ts` contains a recurring timer that calls attention hydration.
- **Verification method**: Semble located the hook; full hook read and `git grep -n -E 'setInterval\\(|setTimeout\\(' HEAD -- ui/src/hooks/useAllSessionEvents.ts`.
- **Evidence**: No timer match; `hydrate` issues the read at line 89; calls occur on prompt hooks (179), event subscription (195,199), and command channel (re)subscription (223-226). A running session causes a separate read. `useBridgeRpc.ts:311-319` immediately calls an onSubscribed listener if the command subscription is already live, and dispatches subsequent subscription events at 253-256.
- **Verdict**: REJECTED as a claim about current main. The live deployed UI build and event timings are unverified.
- **Rationale**: The inspected producer is lifecycle/event-driven. Many running sessions and reconnects can produce bursts, but their actual contribution to the pasted output was not observed.

#### H3: The observed attention command must come from the old 0.19.39 checkout, whose bridge lacks that handler.
- **Layer**: config / deployment.
- **Prediction**: The active process executes that checkout's bridge runtime and its package version is 0.19.39.
- **Verification method**: PID 78921 process command and corresponding npm package metadata; compare running artifact with copied CLI.
- **Evidence**: `node .../node_modules/.bin/ftown --api-url https://ftown.ia.br`; that package is 0.19.58 and includes the attention switch; byte comparison of the running package artifact and copied CLI succeeded. Main's `bridge/package.json` also reports 0.19.58.
- **Verdict**: REJECTED for the process path and installed artifacts; exact deployed UI revision and immutable process image remain unknown.
- **Rationale**: The process points to the npm package, not the unrelated old checkout. Equal package versions do not alone establish source commit equivalence.

## 5 Whys
1. Each routine attention command prints because the common command handler logs every receipt.
2. It logs before bridge target filtering, including commands that this bridge ignores.
3. The handler treats high-frequency snapshot reads and less frequent actionable commands identically for console visibility.
4. Attention restoration intentionally creates per-running-session snapshot reads on subscription and reconnect, but the generic logging policy was not adapted when that read path was added.
5. There is no command-level distinction between routine observation and actionable operations in this receipt logger. This is the bounded code-level design gap; the amount of traffic and any wider process cause remain unproven.

## Falsification
Isolation/adjacent-cause check: a valid owned snapshot returned successfully and an unrelated bridge target returned no response; both still printed. This rules out errors or actual attention records as prerequisites for the noise, and shows targeting alone cannot prevent it. Full UI source has no timer, although external reconnects and other deployed versions remain possible. No claim is made about why 80 calls occurred.

## Root Cause
`bridge/src/command-rpc.ts:72-77` unconditionally logs receipt before routing, including routine attention snapshot reads and commands targeted elsewhere. That logging design accounts for each matching line independently of snapshot success. The UI restoration lifecycle explains plausible bursts on current main, not the observed interval or causation of every live call. The pre-investigation suggestion of fixed polling/version skew is not supported by the inspected evidence.

## Fix proposal and limits
- On clean task checkout based on current `origin/main`, edit `bridge/src/command-rpc.ts` to avoid normal receipt logs for `get_session_attention`; retain other command logs and response/publish-error behavior. A narrowly scoped explicit diagnostic opt-in, such as `FTOWN_DEBUG_COMMANDS=1`, should print the targeted read receipt only after foreign-target filtering; document its exact semantics. No existing bridge DEBUG/LOG_LEVEL convention was found. Preserve visibility of failures without exposing sensitive payloads; current caught errors are returned in RPC responses and publish failures are logged with `console.error`.
- Add regression to `bridge/src/command-rpc.test.ts`: owned read succeeds unchanged and is quiet by default; foreign read ignored and quiet; debug-enabled owned read logs; debug-enabled foreign read remains quiet; a mutation still logs; failed read and response publication failure behavior stay visible/unchanged. Ensure tests cleanly restore env and console spies. Assert RED before patch, GREEN after.
- Bridge runtime changes require patch bump in `bridge/package.json` and matching `bridge/package-lock.json` per `bridge/AGENTS.md`; one owner serializes these. Relevant checks: `cd bridge && node --import tsx --test src/command-rpc.test.ts` and `npm run build`; root owns focused E2E/runtime execution and cleanup.
- Do not change hydration, reconnect or scheduling without timestamped evidence of unnecessary traffic and a discriminating test; these are required to restore persisted attention and protect correctness.
- Base is clean `fix/attention-polling-noise` at ebd108eb1628d261339891cb683d0a2b16ae8d62 in `/Users/fkesheh/projects/ftown-attention-polling`. Preserve the extensive unrelated edits in `/Users/fkesheh/projects/ftown`.

## Resolution
The bridge now filters commands addressed to other bridges before receipt logging and suppresses `get_session_attention` receipt logs by default. Starting the bridge with `FTOWN_DEBUG_COMMANDS=1` enables targeted attention-read receipt logs. Other command receipt logging, responses, and existing publication-error logging remain intact. The option is documented in `docs/bridge-command-logging.md`; bridge package and lock were bumped to 0.19.59.

With Node 24.22.1, the new focused test failed on the baseline with `1 !== 0` for the default attention-read log count. After the change, `node --import tsx --test src/command-rpc.test.ts` passed 9/9 and `npm run build` passed. The test covers debug opt-in, non-`1` values, foreign targets, mutation logging, failed-read responses and publication errors. Root owns separate runtime verification; no live bridge was modified.
