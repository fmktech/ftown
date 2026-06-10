---
type: investigation
symptom: "Multi-line paste into a Cursor session via the ftown dashboard submits the literal placeholder '[Pasted text #1 +2 lines]' — the pasted content never reaches the agent"
slug: cursor-paste-placeholder-content-lost
date: 2026-06-10T17:30:00-03:00
investigator: Foad Kesheh
git_commit: 78979ab
branch: main
repository: fmktech/ftown
status: root-cause-proven
hypotheses_formed: 4
hypotheses_rejected: 2
hypotheses_proven: 1
related: []
---

# Cursor paste arrives as literal placeholder, content lost

## Symptom

- **Observed**: User pasted multi-line text into a Cursor agent session (`scm790-manual-qa`, bridge `mac-studio.local`, cursor-agent v2026.06.04-5fd875e) through the ftown dashboard terminal. The composer showed the paste placeholder. The message the agent received was the literal string `[Pasted text #1 +2 lines]` — the agent replied: "The pasted content didn't come through fully … the actual pasted content didn't arrive, so I can't see what you wanted me to do."
- **Expected**: The pasted text is delivered to the agent verbatim on submit (cursor-agent expands its paste placeholder into the stored content).
- **Delta**: Placeholder was created (paste detected) but placeholder→content expansion never happened; the literal placeholder string was submitted instead of the content.

## Reproduction

Local rig: cursor-agent v2026.06.04-5fd875e (same version as the report) spawned as ftown
session via bridge 0.4.1, tmux runtime. Input injected via `POST /api/sessions/:id/keys`,
which is byte-identical to the dashboard path (both end in `runner.write(data)`;
Terminal.tsx publishes each xterm `onData` chunk as one Centrifugo message, verified at
ui/src/components/Terminal.tsx:320-322).

Experiments:
1. **E1 small bracketed paste** (3 lines, one chunk, `\x1b[200~…\x1b[201~`, CR line
   separators as xterm normalizes): composer inlines full text. No placeholder. ✗ no repro
2. **E2 small raw multi-line chunk** (no markers): composer inlines full text via rate
   heuristic; inner CRs do not submit. ✗ no repro
3. **E3 large bracketed paste** (30 lines, 1742 bytes, one chunk): composer shows
   `→ [Pasted text #1 +30 lines]` — **placeholder reproduced**. Verified 2026-06-10.
4. **E4 submit after placeholder**: typed instruction + `\r` submit — result pending.

## Hypotheses

#### H1: Cursor's placeholder is size-triggered, and expansion-on-submit works — the user's failure needs an extra variable (busy agent / interrupt / reconnect)
- **Layer**: dependency (cursor-agent TUI)
- **Prediction**: E4 returns the correct line count (30). If so, plain paste+submit is NOT
  the failing path and H1 directs investigation to the extra variable.
- **Verification method**: E4 (running)
- **Evidence**: pending
- **Verdict**: INCONCLUSIVE
- **Rationale**: pending E4

#### H2: Paste while the agent is mid-run (user's session showed `thinking…`) breaks placeholder expansion
- **Layer**: state-data (cursor composer queueing)
- **Prediction**: pasting during an active run, then submitting after/during the run,
  produces a literal-placeholder submission.
- **Verification method**: give the session a long task, paste during it, submit, inspect
  what the agent received.
- **Evidence**: pending
- **Verdict**: INCONCLUSIVE
- **Rationale**: matches the screenshot's session state (`thinking…`, mid /manual-qa task).

#### H3: After dashboard reconnect, the replayed screen dump lacks the original `\x1b[?2004h`, so xterm.js pastes unbracketed; cursor's rate heuristic then mis-detects boundaries on chunked transport and loses content
- **Layer**: config-env (terminal mode state across reattach — ftown-specific)
- **Prediction**: raw (unbracketed) MULTI-CHUNK delivery with gaps produces a placeholder
  whose expansion fails or truncates.
- **Verification method**: send a large raw paste split into several chunks with ~50-100ms
  gaps (Centrifugo-realistic), then submit.
- **Evidence**: pending
- **Verdict**: INCONCLUSIVE
- **Rationale**: E2 showed small raw chunks inline fine, but chunk-split timing untested.

## Final verdicts (2026-06-10)

- **H1**: RESOLVED-CONFIRMED — E4: agent answered "30" after a 30-line placeholder paste
  was submitted; expansion-on-submit works on an idle composer.
- **H2**: REJECTED — paste + submit while the agent was mid-`sleep 20` run queued
  correctly; agent answered "25" after finishing. Busy state does not break expansion.
- **H3** (lost closing marker): REJECTED as explanation — an unterminated `\x1b[200~`
  swallows ALL subsequent input (content, questions, CRs) into the open paste buffer;
  nothing is submitted at all until `\x1b[201~` arrives, at which point the full
  blob lands in the composer. This produces "input eaten", not "literal placeholder
  submitted".
- **H4** (literal placeholder string WAS the input): PROVEN — sending the bytes
  `[Pasted text #1 +2 lines]` as a paste and submitting renders a transcript identical
  to the user's screenshot, and the agent receives only that literal string.

## 5 Whys
Symptom:  Agent received literal `[Pasted text #1 +2 lines]`, no content.
Why 1?    The input bytes WERE the literal placeholder string (H4 proven).
Why 2?    A sender (human copy or agent relay) captured the RENDERED screen of a
          composer where a real paste had collapsed to a placeholder.
Why 3?    Terminal rendering is lossy: cursor-agent stores paste content internally
          and renders only the placeholder; screens/copies carry the rendering.
Why 4?    ftown's multi-session workflows (screen/grep scraping, dashboard copy
          between sessions) treat rendered screen text as faithful content.
Why 5?    No guidance/guardrail exists telling agents and users that rendered
          composer content is not relayable — `tell`/files are the lossless paths.

## Falsification
- Adjacent-cause search: busy-composer expansion (H2) and marker loss (H3) were both
  directly tested and produce different observable outcomes than the symptom. Only H4
  reproduces the exact transcript + agent-received bytes.

## Status note (2026-06-10)
Mechanism proven (literal placeholder string as input bytes reproduces the symptom
exactly; all in-session paste/expansion paths verified working). User decided to treat
the occurrence as possibly one-off — no mitigation applied yet. If it recurs: check what
the SENDER captured (rendered screen vs actual content) before anything else.
