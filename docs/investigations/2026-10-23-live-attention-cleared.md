---
type: investigation
symptom: "Explicit agent attention is saved but disappears from the live dashboard"
slug: live-attention-cleared
date: 2026-10-23T22:40:00-03:00
git_commit: c2d5e7b453399931f75f6fcf5e83407aed6f822f
branch: fix/session-attention-sidebar
status: verified
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

## Symptom
User: "I didnt see here anything about attention" and "the PR is there".
Expected: one explicit request appears in Needs attention and the alert until the user handles it. Observed: the PR updates but the attention disappears. The local session is running Codex, ID a8b5c8f9-1fdf-4e70-912c-cf2fda24c73c. Installed capability flags report attention.request=true and sessionMetadata.pullRequest=true.

## Reproduction and live evidence
1. Real installed CLI linked PR129, requested Work complete and returned event 05445dd6-b020-40a6-a9ac-a9e5efc478e0. Immediate GET confirmed persistence and occurrences=1.
2. User reported no attention. PWA native accessibility inspection showed PR129 in sidebar/header, expanded sidebar, active ftown session, no Needs attention/alert.
3. A single bounded background diagnostic requested attention after the requesting tool completed, avoiding its immediate completion hook. At 2026-10-24T01:37:03.873Z, event 668ba164-1a0a-4c91-8585-8dbee0727b06 was persisted, occurrences=1.
4. Root read the live PWA: AX added container135 Needs attention, button138 `ftown: Attention visibility test. Live diagnostic: this notice should remain visible after ordinary tools finish. PR #129 is linked.`, image Input needed, alert140 and Open session/Dismiss buttons. Screenshot confirmed all three visible indicators.
5. Root ran one ordinary read-only shell command reading the diagnostic result file; no UI selection/dismissal/reload was performed. Next PWA AX report: `Removed element IDs: 135-143`; ftown reverted from Input needed to Thinking.
6. GET includeResolved=true still returned diagnostic event668ba164 with no resolvedAt or resolution, disproving a user-prompt resolution. Backend activity was thinking with lastActivityAt2026-10-24T01:37:25.772Z. Installed Codex hook names include Stop, UserPromptSubmit, SessionStart, PreToolUse and PostToolUse.
Result artifact: /tmp/ftown-live-attention-diagnostic.json. Native PWA screenshots/AX evidence preserved in the conversation. User subsequently requested clickable sidebar PR and removal of sidebar usage; those scoped UX changes accompany this fix.

## Hypotheses
### H1: persistence failed or the ledger lost the request
- Layer: backend/state-data.
- Prediction: exact event missing even with includeResolved=true.
- Verification: authenticated GET local session attention ledger.
- Evidence: original event05445dd6 created2026-10-24T01:27:20.919Z, resolvedAt2026-10-24T01:28:38.533Z, resolution=user_prompt. Diagnostic event668ba164 remains open after UI disappearance.
- Verdict: REJECTED. Bare GET hides resolved records; a later user prompt explains the original disappearing from that default response. The UI cannot resolve the ledger.

### H2: ordinary tool completion clears an explicit agent attention notice
- Layer: frontend/code-logic.
- Prediction: notification appears after a delayed request, then disappears following ordinary tool completion while ledger remains open.
- Verification: live reproduction above, installed Codex PostToolUse configuration, direct source inspection.
- Evidence: ui/src/lib/hook-events.ts85-97 returns true for PostToolUse/postToolUse/postToolUseFailure without consulting the active notice; ui/src/hooks/useAllSessionEvents.ts58-79 clears attention accordingly. Live AX changed visible attention to removed IDs135-143 after a read-only tool; open persisted event remained.
- Verdict: PROVEN. Explicit session attention is incorrectly treated like a completed blocking tool interaction.

### H3: event delivery or current-session visibility prevents any attention display
- Layer: integration/observation.
- Prediction: the same real request would not render even when emitted after tool completion.
- Verification: delayed request to the same running Codex session, same live PWA and selected session.
- Evidence: AX Needs attention button138, Input needed indicator and alert140 all rendered; expanded original sidebar and PR link remained visible.
- Verdict: REJECTED. Delivery and rendering work; the event's later lifecycle causes the loss. Selected/thinking session alone does not hide it.

## 5 Whys
1. User did not see the request because it was removed almost immediately.
2. The requesting/next tool completion invokes a generic clear rule.
3. That rule assumes all attention means a blocking tool interaction ended.
4. Explicit session requests reused the existing notice representation without distinguishing the different lifetime of agent_needs_input.
5. Prior feature coverage used shell sessions without the real Codex PostToolUse lifecycle; successful persistence and rendering did not exercise the subsequent event sequence.

## Falsification
Without a following tool completion, the delayed request rendered correctly in the same selected live session. With ordinary tool completion, UI attention vanished while the durable record stayed open. This rejects transport failure, absent persistence, current selection and backend resolution as explanations. The regression must exercise this event sequence and preserve other manual-input lifecycles.

## Fix contract
Make notice clearing depend on the active notice type. Explicit agent_needs_input requests must survive ordinary tool completion/failure and unrelated elicitation completion; user prompt submission and existing deliberate selection/dismissal still clear. Preserve existing permission/question/elicitation behavior. Do not change bridge persistence, delivery/auth or introduce a second notice store.

User UX update: make expanded sidebar PR badge a safe, accessible sibling link next to the preserved draggable session-selection button; do not nest interactive controls. Remove sidebar usage only; preserve terminal header usage. Full file ownership and acceptance are recorded before dispatch in the adjacent ownership manifest. Root alone executes live/browser/E2E tests. Native workers are explicit gpt-6.1-sol/high and share this checkout.

## Verification plan
Regression must fail on original clearing logic, pass after repair, and verify matching user actions still clear. Add focused desktop/mobile E2E for real CLI attention followed by PostToolUse, clickable sidebar PR without changing selected session, and existing selection/drag flow. Reuse unaffected backend checks. Preserve unrelated notes. Open a new PR; no unauthorized merge/deployment.

Pre-freeze review `/root/npx_review` approved the attention design, requiring current notice evaluation inside the functional React updater to preserve batched Notification→PostToolUse ordering. Only one production caller exists; useSessionEvents requires no change. UI owner proposed a sibling link next to the unchanged draggable selection button, preserving existing drag/select/menu targets and avoiding nested interactive controls.

## Review and regression evidence
Independent reviewer `/root/npx_review` approved the combined eight source/test files with no actionable defects and released its read-only lease. React review confirmed functional state updates for current batched notice state, preserved subscription structure, stable wrapper keys, native sibling-anchor semantics and no new dependencies/listeners. All native workers use gpt-6.1-sol/high in the shared checkout; completed source writers released their leases.

Checks ran serially on task-owned Boat development sandbox `bx_cew4y98w` (small 2vCPU/4GB, no inherited environment or snapshots, TTL3600), using a base archive of c2d5e7b and an exact SHA-verified overlay. This was development validation, not CI. The repository's existing GitHub workflows remain unchanged.

- RED: new hook regressions against the original two source files failed 11/35 cases, with 24 legacy/manual cases passing. Failures reproduced explicit attention becoming undefined after completion/failure/elicitation and same-batch events. Original experiment was confined to the disposable snapshot; final files restored in finally and byte hashes verified.
- GREEN: focused hook/component regressions passed 49/49 across four files. Full UI suite passed 424/424 across 41 files.
- UI and E2E TypeScript checks passed; bridge build passed. Every GREEN inner exit code was 0 without timeout/OOM. All 10 snapshot hashes matched after checks. No package/dependency changes.
- Local captured Boat evidence: `/tmp/ftown-attention-sidebar-{red,green,ui-unit,ui-tsc,e2e-tsc,bridge-build,final-sha}.json`. Root assumed the exclusive E2E resource lease after the worker released checks.

## Runtime, visual review and cleanup
Root ran `playwright test tests/session-tools.spec.ts tests/session-needs-attention.spec.ts` against the SHA-verified combined source in Boat: **4/4 passed** (13.6s). Both desktop1280 and mobile390 exercised real CLI PR association/replace/clear, persisted reload, explicit attention followed by actual delivered completion/failure/elicitation hooks, keyboard/pointer sidebar PR navigation without selecting the target or clearing its notice, deliberate selection clearing, and legacy manual-input shortcuts. UI production build and scratch harness startup passed.

Root inspected all six captured desktop/mobile screenshots: sidebar link and keyboard focus visible, attention alert/shortcut retained, selected session unchanged after PR navigation, narrow layout contained without horizontal overflow. Sidebar usage absent by component regression; terminal header usage retained by rendering the real Terminal component.

Preflight verified the exact disposable localhost database (ftown,5432), shim443, UI3000, Centrifugo8000, scratch bridge HOME, no inherited remote/deployment selectors, no active service/PID leases. An initial preflight stopped before mutation because it treated the checked-in `.env.local.example` as an active env file; allowlisting that example corrected the harness guard, with no application change.

Teardown passed: no Docker compose containers, no service PID files, and ports443/3000/5432/8000 closed. All 10 snapshot files retained their hashes through E2E; all eight source/test files still match the local checkout. Evidence retrieved to `/tmp/ftown-attention-sidebar-evidence/` with logs, Playwright HTML report and screenshots. Boat sandbox bx_cew4y98w deleted; subsequent inventory has no sandboxes. Local live bridge and user services untouched.

## Handoff
Source workers `/root/session_ui` and `/root/npx_implementation` completed and released write/check leases; independent reviewer `/root/npx_review` completed and released read-only lease. Their results are accepted. Only the designated integration owner is reactivated for the final exclusive commit/push/PR operation; it must stage the exact manifest paths, preserve four unrelated notes byte-for-byte, and stop after its handoff. No merge or production deployment. Production still needs the resulting PR merged and deployed before the repaired notice lifecycle is live.
