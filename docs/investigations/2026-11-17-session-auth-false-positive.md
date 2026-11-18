---
type: investigation
symptom: "A working Claude session was reported blocked with reason auth while its screen showed gh help output and Thinking activity."
slug: session-auth-false-positive
date: 2026-11-17T22:00:03-03:00
investigator: Codex child session
git_commit: 5362bd93be5f2e48d5e0a06303c50a1fc5806c86
branch: fix/auth-block-false-positive
repository: fmktech/ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related: []
---

# Working session incorrectly classified as auth blocked

## Symptom
- **Observed**: "Session blocked, reason: auth" attention fired for a working Claude session while its screen showed `gh --help` output (including `auth Authenticate gh and git with GitHub`) and the agent was Thinking with queued prompt `is gh logged in?`.
- **Expected**: Ordinary tool output and active work must not create an auth block/attention. A recognized auth failure must be specific to the harness's own UI and must not fire while the agent is actively working.
- **Delta**: A live output classification can create a block and notification based on broad screen phrases without considering activity state.

## Reproduction
1. In `bridge`, run the focused detector:
   ```sh
   node --import tsx --input-type=module -e "import {detectLimit} from './src/harness-limits.ts'; console.log(detectLimit('claude','gh --help\\n auth Authenticate gh and git with GitHub\\n'))"
   ```
   Output: `undefined`; the abbreviated help text in the report alone does not reproduce the auth hit.
2. Run with a generic auth-like tool-output line:
   ```sh
   node --import tsx --input-type=module -e "import {detectLimit} from './src/harness-limits.ts'; console.log(detectLimit('claude','gh auth status\\nYou are not logged in to any GitHub hosts. Run gh auth login to authenticate.\\n'))"
   ```
   Output: `{"reason":"auth","line":"You are not logged in to any GitHub hosts. Run gh auth login to authenticate."}`.
3. `classifyFailure` currently accepts screen hits when session status is `running`, and `SessionFailureMonitor.evaluate` passes output to it without querying recorded activity. The latter shares the integration condition: any matching terminal output is eligible while running.

## Hypotheses

#### H1: The auth detector treats generic auth wording in arbitrary tool output as a harness auth failure.
- **Layer**: code-logic
- **Prediction**: A line such as a tool's `not logged in` diagnostic is classified as auth even though it is not the harness's own UI; exact supplied gh help wording may or may not match.
- **Verification method**: Execute `detectLimit('claude', screen)` with the reported excerpt and a generic gh auth-status line.
- **Evidence**:
  ```
  "gh --help\\n auth Authenticate gh and git with GitHub\\n" undefined
  "gh auth status\\nYou are not logged in to any GitHub hosts. Run gh auth login to authenticate.\\n" {"reason":"auth","line":"You are not logged in to any GitHub hosts. Run gh auth login to authenticate."}
  ```
  `bridge/src/harness-limits.ts:112-118` makes Claude auth a match for `PLEASE_LOGIN`, `NOT_LOGGED`, `LOGIN_EXPIRED`, or `TOKEN_EXPIRED`; these expressions are not anchored to Claude UI context.
- **Verdict**: PROVEN (general false-positive mechanism; the supplied abbreviated excerpt itself does not reproduce)
- **Rationale**: The reproduction demonstrates that non-harness output matching a broad phrase is classified; the user report's exact triggering line is absent from the abbreviated screen text supplied.

#### H2: Session state is stale or mismatched, causing a different session's screen text to be classified.
- **Layer**: state-data
- **Prediction**: A session ID/screen pairing discrepancy will be required; isolated calls to the pure detector will not explain the auth classification.
- **Verification method**: Inspect the monitor's output buffer/session keyed evaluation path and reproduce detector output independently.
- **Evidence**:
  ```
  bridge/src/session-block.ts:273-276 keys buffers by sessionId and evaluates that same id
  bridge/src/session-block.ts:298-314 loads the session by sessionId and classifies the associated screen
  ```
  The detector's isolated input reproduces the broad-phrase hit without any shared session state.
- **Verdict**: REJECTED
- **Rationale**: No cross-session state is needed to create the false positive; the pure classifier accepts the matching tool text directly.

#### H3: Missing activity-state gating alone produced the reported `reason: auth` classification.
- **Layer**: integration
- **Prediction**: The attention subsystem will store `thinking` while failure evaluation has no activity dependency, allowing output classification during that state.
- **Verification method**: Read activity schema/write paths and monitor construction/evaluation dependencies.
- **Evidence**:
  ```
  bridge/src/attention-store.ts:54 activity state is thinking|tool_use|idle|unknown
  bridge/src/index.ts:879-895 constructs SessionFailureMonitor with session/mail/attention dependencies, but no activity read
  bridge/src/session-block.ts:151-166 classifies running session screen hits
  ```
- **Verdict**: REJECTED (as the immediate auth classifier)
- **Rationale**: Activity state does not choose the `auth` reason; only `detectLimit` can return that reason. The missing gate allowed an auth hit to notify during active work, but cannot explain which phrase matched.

## 5 Whys
Symptom: A working session can be reported as auth blocked from unrelated CLI output.
Why 1? The running-session monitor accepts a screen detector hit and sends a block notification.
Why 2? Auth hits are broad phrase matches applied to terminal output without identifying which CLI rendered the line.
Why 3? The detector treats any output line as though it came from the harness's auth UI.
Why 4? Failure classification receives raw screen text but no source/UI boundary or activity state.
Why 5? The monitor's input contract conflates terminal output with authoritative harness lifecycle/auth state.

## Falsification
- **Check performed**: Isolation and adjacent-cause check.
- **Result**: The exact reported gh help excerpt returns `undefined`, so it is not the matching line by itself. A gh auth-status message with `not logged in` returns `auth`. This rules out claiming that the displayed `auth` command-list entry itself matched. The broad pattern mechanism remains demonstrated and can create false positives when such output is present; an independent activity-state gate is needed to enforce the explicit no-alert-while-working requirement.
- **Conclusion**: H1 survives as a proven general defect mechanism; exact incident trigger text remains unavailable.

## Root Cause
- Immediate cause: `bridge/src/harness-limits.ts:112-118` classifies broad unanchored auth phrases independent of CLI UI context; `bridge/src/session-block.ts:151-166` accepts the match while running.
- Architectural root: The failure monitor consumes terminal text as an authoritative auth signal without source attribution and without active-work context.
- Rejected H2: session-keyed buffer/evaluation path and isolated detector reproduction show no state mix-up is required.
- Rejected H3: activity state cannot produce the `auth` reason; it only determines whether live screen detection runs.
- Falsification: The abbreviated gh help text does not match; a generic `not logged in` tool line does. The diagnosis is limited to the proven classifier defect, not an invented claim about the absent screenshot bytes.

## Fix
- Restrict each harness auth detector to that harness's recognizable auth screen messages and anchor them to CLI-facing UI lines.
- Add negative coverage for gh help, git output, and documentation mentioning auth/login; positive coverage for each harness's own auth failure UI.
- Gate live output-derived limit classification while activity is `thinking` or `tool_use`; lifecycle error/completion classification remains available.
- Bump bridge version to 0.30.36.
- Regression tests: `bridge/src/harness-limits.test.ts` and `bridge/src/session-block.test.ts`.

## Resolution
- **Diff summary**: Auth signatures now match complete harness-specific lines; live output classification consults AttentionStore and ignores `thinking`/`tool_use`; gh help, git output, docs wording, and active-work cases have regression coverage; bridge package version is 0.30.36.
- **Verification**: Focused harness-limits/session-block suite passed 31/31. `npm run build` passed. Full `npm test` was started but interrupted after about 90 seconds while still progressing through unrelated tests; no full-suite pass is claimed.
- **Follow-up**: CI on the pull request is the full-suite gate.
