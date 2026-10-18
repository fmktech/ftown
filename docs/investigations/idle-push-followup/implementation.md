# Idle notification follow-up

Worker `/root/npx_review`, explicitly `gpt-6.1-sol` / `high`, shared checkout.
Exact ownership is in /tmp/ftown-push-followup/coordination.json. Other workers
share the checkout; preserve their edits and four preexisting notes. A alone
owns Git/package bump; root alone owns E2E and runtime resources.

Read frozen contract.md before edits. Behavioral checks from the contract:
- Empty/legacy: no cycle from initial idle, snapshots, or old ledger activity.
- Boundary: no alert at599999ms; one at600000; duplicate idle does not extend.
- Invalid: API rejects malformed UUID keys, retains legacy literal idle.
- Failures: inactive/deleted session never notifies; observer/storage failure
  stays isolated; existing retry budget remains bounded.
- Ordering/concurrency: resumed activity clears timer and unsent/retried idle,
  including awaited token/session lookups and matching inflight abort.
- Idempotency: durable UUID per period; notified restart never replays; pending
  restart restores only its known cycle; new busy->idle rearms a new period.
- Time/encoding: occurredAt reflects emission, not original ten-minute start;
  fake clock avoids real ten-minute waits. Existing Unicode behavior unchanged.

Implementation complete; all source/test writes stopped and worker resource leases
released for independent review and root runtime gates. No installs, generated
bridge output, E2E/browser/server/CI, secrets access or Git mutations performed.

Changed files (within the twelve assigned paths):
- `bridge/src/attention-store.ts` and `.test.ts`: strict optional persisted cycle,
  ten-minute timer, injected time, restart recovery, live-session eligibility,
  serialized cancellation, shutdown cleanup. Recovery isolates one corrupt or
  missing ledger and leaves it fail-closed rather than aborting bridge startup.
- `bridge/src/push-notifier.ts` and `.test.ts`: cancel matching idle queue items,
  guard async continuations and abort local in-flight request. Per-item retry
  deadlines allow a newly queued question through an idle retry backoff.
- `bridge/src/index.ts`: named store, known-running/non-shell recovery, local
  terminal/removed session publication observer and shutdown cleanup.
- `ui/src/lib/push.ts`, `push.test.ts`, `push-store.test.ts` and
  `ui/src/app/api/push/events/route.test.ts`: rolling legacy/new UUID key parsing,
  stable retry identity and a distinct subsequent cycle, using existing schema.
- `e2e/tests/push-notifications.spec.ts`: two unique idle cycles with same-cycle
  duplicates, unchanged owner/revocation/no-backlog checks, no vendor recipients.
- `docs/push-notifications.md` and this report: behavior and delivery limits.

Checks passed:
- Bridge: `node --import tsx --test src/attention-store.test.ts src/push-notifier.test.ts`:
  19/19. Includes 599999/600000 boundary, repeated idle, new period UUID, immediate
  questions, pending/notified/legacy/overdue recovery, inactive/deleted sessions,
  concurrent idle/resume/idle, deferred predicate/session/token cancellation,
  local inflight abort, retry cancellation and corrupt recovery isolation.
- UI: `npx vitest run src/lib/push.test.ts src/lib/push-store.test.ts src/app/api/push/events/route.test.ts`:
  3 files, 15/15 tests.
- Both bridge and UI: `npx tsc --noEmit --incremental false` passed.
- `git diff --check` passed. Four preexisting modified notes preserved.

Root handoff: run the existing focused push E2E spec after the normal isolated
fixture build/start. The API case now expects two idle event rows and one
question row, zero deliveries. No ten-minute real-time wait or new env is needed.
A owns independent review, patch package bump, builds and Git landing.

Limits remain explicit: restored pending cycles use persisted known activity;
bridge delivery queue is in memory, so a crash after the durable notified marker
but before delivery can lose a notice. Provider delivery already accepted cannot
be recalled by resumed activity; local unsent/retried requests are canceled.
No DB schema changes, cloud cancellation protocol or notification UI changes.
