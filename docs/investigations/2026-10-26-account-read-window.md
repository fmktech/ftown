# Account-read throttle repair — 2026-10-26

## Scope and evidence
User's existing PWA showed bridges but no sessions, misleading account approval errors, blank terminal and Cloud fallback. Root encrypted local GET /api/sessions returned HTTP 200 with 13 running sessions. Installed CLI 0.19.55; local bridge account revision 2, two active browsers, no revoked IDs, fresh account reads.
Production READ ONLY query at 2026-10-26T14:55:30Z found owner-scoped account-read failed_count 346, locked_until 14:56:29Z, updated_at 14:55:29Z. Source increments forever, so expired lock re-locks on next successful request.
Root operational mitigation updated ONLY this owner's account-read row with count>=300 to count0/unlocked. User confirmed "it started to work just now". No keys, membership, other users or login scopes changed.

## Hypotheses and falsification
H1 lost sessions/bridge unavailable REJECTED: encrypted local response lists13 running sessions and live bridge healthy.
H2 permanent lost/revoked browser key REJECTED as outage cause: no trust changes; scoped counter reset restored user's samePWA access. Policy retains2activebrowserIDs, norevocations.
H3 account-read limiter accumulates successful reads over lifetime, re-locks eachminute, and browser mislabels429 PROVEN: SQL source, live346counter+lock, and reset-only recovery.
Adjacent cause test: successful refresh with missing local trust has different unapproved UI state; screenshot showed account error + retained legacy pins. Gateway deployment and unrelated post-merge push test failures do not explain reset-only recovery.

## Five whys
Sessions hidden because account-authorized commands paused; commands paused because429 becameapproval_required;429 persisted because counterneverreset; successfulperiodicreads reusedloginfailurecounter; account request budgets lack a time-window atomic admission primitive and end-to-end long-lived polling coverage.

## Frozen repair contract
Replace accountRateLimit implementation with one atomic bounded60second request-window admission using existing rate_limit_attempts columns. Preserve existing per-scope limits, owner isolation, <=max accepted requests under concurrency, reset at boundary, and bounded Retry-After. Do not alter login/register failure limiter behavior or schema.
Treat browser HTTP429 as temporary AccountReadUnavailable using existing bounded verified-read/offline-grace rules; fresh/reloaded clients still require valid history before access, and revocation/rollback/epoch/security checks remain intact. No key regeneration, unsigned bootstrap, authority expansion, or protocol changes.
Test expired-window and repeated-window recovery, exact threshold, concurrent cap, scope/key isolation, and existingoverthresholdrow recovery. Client regressions: validtrust->429 retainsboundedgrace; freshclient429 staysblocked; validreadrecovers; existingrevocation/rollbackcasesremain.
Use real isolatedPostgreSQL acceptance through existing CI database harness for SQL correctness. Root exclusively executes E2E/servers/DB/CI. Workers may author tests and runisolatedunits/noEmit.

## Ownership and dispatch
Shared checkout /Users/fkesheh/projects/ftown-simplify-all. Primary /Users/fkesheh/projects/ftown is unrelateddirty; neverstage its changes.
Implementation/integration owner: /root/existing_pwa_access, explicit gpt-6.1-sol/high.
Exclusive write files: ui/src/app/api/security/account/_shared.ts; ui/src/app/api/security/account/_shared.test.ts; ui/src/app/api/security/account/route.test.ts; ui/src/lib/account-security-client.ts; ui/src/lib/account-security-client.test.ts; e2e/scripts/pending-approvals-db.ts.
Root only: this coordination/investigation file.
Reviewer: read-only, independently review fixed-window and429guard contract before implementation.
Git lease: implementation owner may fetchoriginmain/createbranch fix/account-read-window only after rootbrief; preserve4preexistingdirtynotes. No commit/push until sourcehandoff+independentreview. No merge/deploy.
Dependencies: reviewcontract then implementation then reviewfix then rootfocusedCI/runtime. No dependencyinstalls/migrations/generatedfiles/leaseliveDB allowed toworkers.

## Validation coordination
Ownership check passed: six exact implementation files and one root report are disjoint; reviewer is read-only. Active native IDs: /root/existing_pwa_access and /root/rate_window_review, both explicitly gpt-6.1-sol/high. Branch fix/account-read-window starts at origin/main f51fb4f004670b3f069377589d34ae5c2d744131.
Root will dispatch existing e2e workflow against the reviewed branch. Workflow currently uses ubuntu-latest; no provider migration is part of this repair. Preflight: e2e/env.sh sets DATABASE_URL to isolated ftown@localhost/ftown, Centrifugo localhost:8000, temporary MCP TLS endpoints; DB acceptance independently validates localhost:5432, ftown database/user and unique temporary schema. Workflow creates its own Docker infrastructure and always tears it down. Local Docker is unavailable; no local services started.

Lease amendment: implementation owner also owns ui/src/lib/pending-approval-http.test.ts solely to adapt its existing accountRateLimit mock. This exact path is distinct from all seven previous paths; no production pending-approval HTTP changes authorized. Total seven implementation/test paths plus root report.

## Source handoff and review
Implementation stopped writes and released leases. Regression RED: 10 expected failures. GREEN: 46 focused tests; full UI suite 633/633 across 66 files; UI and E2E TypeScript checks passed on Node24.22.1. Independent gpt-6.1-sol/high reviewer inspected all seven source/test files and returned PASS with no material findings. Real SQL and browser outcomes remain pending CI. Root independently verified all four protected notes retain their baseline SHA256. Integration owner may stage only the seven task source/test files and this report, commit and push; no merge/deploy.
