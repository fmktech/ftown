# Idle push follow-up contract

User direction (2026-10-18): notify after ten uninterrupted idle minutes, once for that idle period; allow another only after the session resumes activity and becomes idle again. Question notifications remain immediate.

## Frozen behavior and interfaces
- A meaningful thinking/tool_use to idle transition starts a 600000ms cycle. Repeated idle observations neither restart nor duplicate it. Initial/legacy idle snapshots do not create cycles.
- Backward-compatible optional strict ledger field: idleCycle { id: UUID, startedAt: ISO, dueAt: ISO, notifiedAt?: ISO }. Existing ledger version remains readable. UUID persists across retries/recovery; new bridge eventKey is idle:<UUID>.
- AttentionStore keeps its third notification callback. Optional fourth options inject clock/timers, a live-running non-shell session predicate, and onIdleCanceled(sessionId). Exports restoreIdleNotifications(ids), cancelIdleNotification(id), stopNotifications().
- Timer eligibility is checked under the session lock against the current cycle and live session. Persist notifiedAt before callback; occurredAt is actual notification emission time, avoiding the API age window. Questions still follow their committed attention UUID immediately.
- Resume thinking/tool_use, session_end, terminal/removed session and shutdown cancel timers. SessionEnd must not start an idle cycle despite its existing idle classification. Cancellation clears durable pending cycle state when appropriate.
- Restore only already persisted cycles for known live running non-shell sessions. Preserve their UUID/due time; a qualifying overdue pending cycle may emit once. Already notified cycles and legacy snapshots do not replay. No new startup cycles are inferred.
- BridgePushNotifier.cancelIdle(sessionId) drops queued idle notices, invalidates post-await continuations and aborts a matching in-flight local request best-effort. Questions are unaffected. No new cloud cancellation protocol: delivery already handed to the provider cannot be recalled.
- API parser accepts legacy literal idle and new idle:<UUID> for rolling upgrades. Existing cloud event identity and per-endpoint delivery dedup remain. A later cycle has a new identity. No DB schema changes.

## Ownership and integration
The authoritative dispatch manifest is ownership.json (initial dispatch was recorded at /tmp/ftown-push-followup/coordination.json); mechanically validated disjoint files/resources. All workers explicitly use gpt-6.1-sol/high in /Users/fkesheh/projects/ftown-simplify-all. Branch fix/idle-push-after-ten-minutes starts at main cb6406890217f2b7bbeb3399300c4c307839e491. Preserve the four pre-existing dirty notes.
- npx_review: bounded store/notifier/index/parser changes, associated tests, focused E2E spec, push docs and implementation report.
- npx_implementation: sole Git/package-version owner and independent review/integration report; no implementation ownership overlap.
- canonical_start: independent production VAPID configuration and matching dedicated WebCraw ENV backup; no repository writes. User explicitly authorized both. Check absence before generating; never rotate existing keys or expose private values in logs/chat.
- root: architecture, runtime/E2E resources and execution. No worker E2E/server/CI reruns. No merge authorized. VAPID configuration does not imply a production database migration.

## Acceptance
Deterministic clock tests: no notice at599999ms; one at600000ms; repeated idle no reset/repeat; resume then idle creates a distinct cycle; busy/end/deletion/stop cancel; stale queued retry and async handoff are fenced; pending/notified/legacy recovery; questions immediate. Parser tests accept both supported formats and reject malformed keys. Focused API E2E proves per-cycle dedup and distinct subsequent cycle rows with no real ten-minute wait. Root executes focused E2E after writers stop; workers run isolated unit/static checks. Independent reviewer accepted the contract before implementation. Patch version bump and new PR after review and required gates; automatic CI is valid evidence.
