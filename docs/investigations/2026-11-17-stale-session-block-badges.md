---
type: investigation
symptom: "Dashboard session rows keep amber badges crashed (3d old) and auth expired (1d old) indefinitely."
slug: stale-session-block-badges
date: 2026-11-17T17:41:46-03:00
investigator: redacted
git_commit: 3ee99ce72b886851da63c7986c834d6b36703a72
branch: fix/stale-status-badges
repository: fmktech/ftown
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 1
hypotheses_proven: 1
related: []
---

# Session failure badges persist after recovery

## Symptom
- **Observed**: Owner report: “dashboard session rows keep amber badges \"crashed\" (3d old) and \"auth expired\" (1d old) indefinitely.” The current live CLI record for `codebenchmark` has `status=running`, `block.reason=auth`, `block.detectedAt=2026-11-16T17:48:27.177Z`, `block.transitionKey=auth||running` and old auth text in `lastError`.
- **Expected**: A healthy new activity/status or restart/revive clears the stale badge; otherwise the user can dismiss it. Stale failure state is not persisted forever.
- **Delta**: `SessionBlockBadge` renders whenever a session wire record has `block`, and there is no badge dismissal path or healthy-state clearing path.

## Reproduction
1. Read live state without changing it: `ftown sessions list --json` (and `ftown sessions get 3c87816f-5174-49aa-9b94-9e864617aa5b --json`).
2. Observe the `codebenchmark` record reports `status: running` and the auth block detected Nov 16, despite the running session's `updatedAt` advancing to Nov 17. The CLI output includes the stale block and lastError.
3. Inspect rendering and state transitions: `ui/src/components/SessionList.tsx` renders on `session.block`; bridge `SessionFailureMonitor` persists that field; no code clears it.
Verified: 2026-11-17 17:40 -03:00 — live `ftown` CLI read reproduced a stale badge state. The owner screenshots are not available in this checkout, so the current CLI record is the reproducible evidence.

## Hypotheses

#### H1: Healthy session transitions clear `block` in bridge state, but the dashboard holds a stale client-side snapshot.
- Layer: state-data
- Prediction: If H1 is true, after a healthy transition the bridge's `ftown sessions get` record will omit `block`, while UI ingestion/merge retains it.
- Verification method: inspect bridge relaunch/output lifecycle writes and live CLI record; inspect `mergeSessionSnapshot`.
- Evidence:
  ```
  ftown sessions get ...: "status": "running" ... "block": { "reason": "auth", "detectedAt": "2026-11-16T17:48:27.177Z" ... }
  bridge/src/create-ftown-session.ts relaunchFtownSessionImpl sets status='running' and saves the session; it does not delete block.
  ui/src/hooks/useSessions.ts mergeSessionSnapshot starts from incoming snapshot; it has no block-retention logic.
  ```
- Verdict: REJECTED
- Rationale: The bridge's durable record itself still contains the stale field; this is not solely a browser merge/cache artifact.

#### H2: The bridge session store resurrects old block fields from its on-disk cache/index after a clean save.
- Layer: tooling/data
- Prediction: If H2 is true, store reads can return a record inconsistent with the atomic on-disk session record after updating it.
- Verification method: inspect session persistence and read indexing behavior, plus live state freshness.
- Evidence:
  ```
  bridge/src/session-store.ts saveSession atomically renames a complete JSON snapshot and deletes recordIndex for that session; loadSession stats the path and indexes only settled file stamps.
  CLI live `updatedAt` is newer than the block's `detectedAt`, so the record is not an old untouched listing snapshot.
  ```
- Verdict: REJECTED
- Rationale: Reads validate the disk stamp; session persistence is atomic and the stale `block` is part of the saved source record.

#### H3: Failure state is written as a durable optional `session.block`, but no recovery/dismissal transition deletes it.
- Layer: code-logic
- Prediction: If H3 is true, monitor failure detection will persist `block`, and relaunch/output/healthy events will not clear it; list/get will keep returning it and UI will keep rendering the badge.
- Verification method: read `bridge/src/session-block.ts`, `bridge/src/create-ftown-session.ts`, UI render sites and execute read-only `ftown sessions` CLI.
- Evidence:
  ```
  bridge/src/session-block.ts:268 sets session.block = decision.block and saves/publishes it.
  bridge/src/create-ftown-session.ts relaunchFtownSessionImpl sets status='running'; resume clears errorReason, but neither retry nor resume clears block.
  ui/src/components/SessionList.tsx renders <SessionBlockBadge block={session.block}/> at both row variants.
  rg found no bridge session-block deletion or clear route; the only session block delete is invalid wire parsing in ui/src/hooks/useSessions.ts.
  Live CLI: codebenchmark is running, updatedAt 2026-11-17, block.reason auth detected 2026-11-16 and lastError retains auth screen.
  ```
- Verdict: PROVEN
- Rationale: The bridge source record and UI rendering condition jointly show a persistent field with no clearing transition. The current live record is a direct instance.

## 5 Whys
Symptom: A recovered/running row continues displaying an old failure badge.
Why 1? Because the UI renders the badge whenever `session.block` exists.
Why 2? Because the bridge persists the block and healthy output/relaunch does not remove it.
Why 3? Because `block` is modeled as a detected failure snapshot with notification idempotency, but no lifecycle contract defines it as recovery-cleared or user-dismissible.
Why 4? Because bridge block detection was implemented as a one-way failure reporting path and not paired with recovery/dismissal state transitions.
Why 5? Because the feature's state contract did not define ownership and expiry for session failure annotations, leaving terminal and recovered sessions indistinguishable in the stored optional field.

## Falsification
- Check performed: adjacent-cause and absence test.
- Result: A stale browser cache cannot explain the CLI result because `ftown sessions get` directly reports the persisted stale `block`. Conversely the live record has `status=running` and fresh `updatedAt`, but retains the old block, demonstrating that running status/activity does not currently clear it.
- Conclusion: H3 survived falsification; H1 was rejected.

## Root Cause
- Immediate cause: `SessionFailureMonitor.evaluate` saves `session.block` on detection (`bridge/src/session-block.ts`), while relaunch and later healthy output never delete that field (`bridge/src/create-ftown-session.ts`). Both list row variants render it (`ui/src/components/SessionList.tsx`).
- Architectural root: the failure annotation has no recovery/dismissal/expiry lifecycle contract.
- Rejected H1: live bridge record carries the stale block, disproving client-only staleness.
- Rejected H2: store reads validate current atomic file stamps, and the record's block is persisted alongside newer `updatedAt`.
- Falsification check: the live record is `running` with a new update timestamp but old block detection; this confirms status/activity does not currently clear the block.

## Fix
- `bridge/src/session-block.ts`: clear a block after fresh healthy terminal output, clear a successful completed result, and expire annotations older than seven days.
- `bridge/src/create-ftown-session.ts`: clear failure metadata before retry/resume; `bridge/src/index.ts` runs an expiry sweep over stored blocks at startup.
- `bridge/src/command-rpc.ts` and `bridge/src/session-controller.ts`: add fenced `dismiss_session_block`, matching both transition key and detection timestamp so an old UI click cannot remove a newer failure.
- `ui/src/components/SessionList.tsx`: add an accessible “Dismiss badge” action in the session context menu and wire it through the dashboard/session RPC hook.
- Regression tests: `bridge/src/session-block.test.ts`, `bridge/src/create-ftown-session.test.ts`, `bridge/src/command-rpc.test.ts`, and `ui/src/components/SessionList.test.tsx`.

## Resolution
- Diff summary: failure badges now clear on fresh healthy output, clean result completion, restart/resume, explicit dismissal, or a seven-day expiry sweep at bridge startup. The bridge version is bumped to 0.30.35.
- Verification: pending final root-owned full-suite, PR CI, and runtime checks.
- Limitation: inactive annotations younger than seven days are pruned at the next bridge startup or when dismissed. The bridge never restarts a user's bridge as part of this change.
