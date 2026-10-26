---
type: investigation
symptom: "Concurrent approved bridge credential deliveries do not both return the immutable snapshot"
slug: concurrent-credential-delivery
date: 2026-10-26
git_commit: 32f6712882d18308a369c57c2ffd9bc5b3bfd924
branch: codex/simplify-security-window
status: investigating
---
# PR141 database concurrency failure
CI40373907131 failed pending-approvals-db.ts326 before browser tests: two concurrent deliver calls for one approved pairing do not both return snapshot. Prior same-code runs passed this step. Root collected /tmp/ftown-pr141-failed.log and confirmed CI infrastructure cleanup.

## Hypotheses
H1 Security UI change causes failure: rejected; this stage imports store code and runs before any UI server/browser.
H2 A session-list or browser test assertion causes failure: rejected; precise failure is database delivery result shape at the existing concurrent snapshot assertion.
H3 READ COMMITTED command snapshot misses concurrent inserted refresh row: strong source-supported hypothesis, awaiting deterministic PostgreSQL reproduction. Both delivery statements start before first commits; loser waits on pending-row lock and can observe updated locked pending/pair tuples while the newly inserted refresh row is absent from its original command snapshot. Ready replay requires that row, yielding zero writes/null snapshot and denial.
PostgreSQL primary reference: https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED
Do not call scheduling sensitivity a test-only flake or weaken the immutable-delivery assertion.

## Reproduction plan
Hold the target pending row in a dedicated transaction; launch both actual store.deliver calls on separate schema-scoped clients; confirm both real delivery SQL statements are blocked using pg_blocking_pids; release lock. Existing production must reproduce one null/denied outcome. Preserve all later replay/rotation/revocation assertions.
Root alone executes PostgreSQL/E2E/CI. Test authors may edit deterministic regression before production repair; no production source writes until RED evidence is recorded.

## Proposed repair contract (independently reviewed)
Retry exactly once, total two attempts, ONLY a well-formed final SQL result with one row, integrity_guard=1, snapshot=NULL and explicit n/r/c/s zero counts. Malformed/no rows and thrown SQL/integrity/validation errors never trigger retry. Fresh attempt reruns complete pending/state/expiry, ownerTarget, signed account history validation, owner email, predecessor, current-refresh-JTI CAS, atomic SQL and validatedSnapshot. Existing replay authority remains unchanged. Persistent null denies after second attempt.
Tests cover deterministic overlap and immutable same snapshot, bounded retries, fresh revocation/rotation/expiry/history/owner validation, and unchanged failure behavior. No keys, scopes, schema or approval bypass changes.

## Ownership
Shared checkout /Users/fkesheh/projects/ftown-simplify-all, PR141 branch. Existing protected four dirty notes remain untouched/hash-identical.
Implementation/integration /root/existing_pwa_access explicit gpt-6.1-sol/high: e2e/scripts/pending-approvals-db.ts first for deterministic test only. ui/src/lib/pending-approval-store.ts and ui/src/lib/pending-approval-store.test.ts reserved for later GO after RED. Root owns this report. Read-only reviewer /root/rate_window_review explicit gpt-6.1-sol/high. Four exact paths disjoint; single writer. No dependency installs, local DB/server/E2E/CI execution by workers.
Git commit/push lease only when root authorizes; root owns CI dispatch/monitoring. Existing workflow/env audited localhost ftown database with Docker teardown; never production DB. No merge/deploy.
