# Account trust — server/core pre-freeze review

Reviewer: `/root/mcp_security_impl`, gpt-6.1-sol/high. Read-only application review on base `8425849`; no installs, tests, servers, database work or Git mutation during review.

## Verdict

Not ready to freeze until the following bounded interface/behavior corrections are resolved centrally. Existing encrypted per-bridge MCP receipts remain unchanged; no account-signed MCP certificates are proposed.

1. **Approval envelope capacity.** Moving full history outside HPKE resolves the largest mismatch, but `AccountApprovalPlaintext.checkpoint` still includes all device/bridge labels and permanent tombstones. A permitted history can derive a checkpoint exceeding the approximately 337 KiB plaintext budget of the existing 450,000-byte serialized envelope (`bridge/src/security/crypto.ts:8`). Prefer an authenticated `AccountHead` plus owner UUID; derive the full checkpoint from the separate verified history, require the approved head in its verified prefix, and require candidate/approver active in the latest state. This removes capacity coupling without increasing wire limits.
2. **Durable offline-clock state.** `StoredAccountTrust.lastServerReadAt` alone cannot detect a clock rollback after a later observation when the rolled-back time remains after the last read. Add durable `lastObservedAt` and a fail-closed backward-observation rule; use monotonic elapsed time within a running process. State the restart limitation rather than claiming stronger trusted-clock guarantees.
3. **Pending bridge restoration.** New `generateAccountBridgeCandidate` addresses initial generation, but existing `importEndpoint` rejects the `pending:<bridgeId>` owner. Add `importAccountBridgeCandidate(endpoint, privateKey, extractable?)` or explicitly assign a local import seam to the bridge worker. Normalize only inside proof-verified bootstrap; do not permit pending owners for ordinary application encryption.
4. **Link wire format.** Freeze whether `parseAccountEnrollmentLink` accepts the encoded base64url fragment string, decoded object, or both. Define comparison-code format/domain/hash bytes so producer and approval UI agree. The interface currently specifies the encoder output but leaves the parser interpretation and displayed comparison format implicit.
5. **Genesis insertion versus trust establishment.** Generic account POST permits a first genesis insert, while product prose limits genesis to bridge approval or explicit migration. Specify whether this restriction applies to storing internally valid public history or only to pinning/using it. If insertion itself is flow-restricted, define the server-verifiable bootstrap-context field/check before implementation.

## Corrections already incorporated during review

- Separate signing keys, pending bridge candidate generator, public enrollment request parser, explicit link/comparison helpers.
- Separate public history argument for approval opening and history in bridge poll results; opening returns verified trust without inventing a successful account-read timestamp.
- Browser bootstrap envelope context `account_<UUID>` rather than colon-containing `account:<UUID>`, which existing bridge-ID validation rejects.
- Adoption sends only a head and fetches full history through authenticated HTTPS, avoiding an oversized encrypted command.
- Retry may reseal the same exact membership/request within its five-minute lifetime.

## Server/storage feasibility

Whole bounded history can use an atomic PostgreSQL compare-and-swap: validate the read history/next record, then update only the exact owner/root/revision/head observed. First insert uses conflict-do-nothing with an explicit conflict result. `neon`'s HTTP query interface does not require a long-held connection for this design. Enrollment approval and pairing-state changes must be conditioned on the same verified current head, preventing a roster change between validation and persistence from accepting stale authority.

The additive migration plan is feasible: new public history/enrollment tables and nullable pairing JSONB fields; bounded lock/statement timeouts; no backfill or destructive changes. Existing directory remains discovery only. A server can validate signatures, membership and public bundle bindings but cannot verify the fragment-secret HMAC or decrypted approval plaintext; candidate verification remains mandatory before pinning or application access.

Report lease released after handoff. No application write authority has been exercised.

## Frozen v1 closure and core handoff

Root resolved the five pre-freeze findings in the shared contract: head-only approval, durable observed-time highwater plus required startup refresh, explicit pending bridge import, exact encoded link/comparison rules, and separation of public genesis storage from trusted activation. No outstanding contract blocker remains from this review.

Implemented only `bridge/src/security/account-crypto.ts` and its pure test file. All named AccountCrypto exports and frozen limits are present. The module imports only existing neutral crypto and shared types; WebCrypto supplies ECDSA P-256/SHA-256, SHA-256, HMAC and random generation. Strict manual bounded parsing avoids a new dependency. Canonical signed/hash bytes sort object keys, preserve array order and include the required domains; 64-byte P1363 signatures remain outside payload hashes. AccountTrustError implements sanitized typed failures.

The implementation verifies each signer against the previous state, immutable owner/root/revision/hash continuity, public point fingerprints, exact key roles, active-set bounds, permanent tombstones and last-admin protection. Pins require the complete matching derived state at the pinned revision. Pending keys import through a private neutral-owner normalization without broadening ordinary endpoint crypto validation. Approvals bind the exact request, owner, head and approver with the fragment-secret HMAC, use existing HPKE Auth, and validate historical approver membership plus latest candidate membership. Opening returns no fabricated server freshness timestamp.

Checks on this checkout's Node24.12.0 (supported-runtime final gate remains with root): 16 new account tests plus 12 existing crypto tests passed, 28 total; strict scoped TypeScript passed for both implementation and tests; neutral-import and whitespace checks passed. Tests independently construct canonical signing/hash inputs and a 601-transition history larger than the 450,000-byte transport limit, successfully conveyed through a sub-10-KiB head-only approval. Other cases cover wrong keys/owners/secrets/transcripts, revoked signers/candidates, historical revoked approvers, tombstones, last admin, limits, malformed points/encodings, stale/forked pins, expiration/resealing and pending key restoration.

No dependency install, Git mutation, server, browser, database or E2E execution. Core/report write leases released; core stops writing for independent review before dependent implementation begins.

## Server/API wave handoff

Implemented frozen account routes and `AccountTrustStore`. Reads independently validate complete signed history and denormalized head metadata; append verifies owner/history then uses one exact-head conditional SQL write (first genesis is conflict-do-nothing). Storing genesis establishes no client or bridge authority. Browser mutations use the existing strict request-origin predicate, session UUID, bounded JSON and rate checks. Account GET additionally accepts a signed current bridge credential only after checking its immutable owner and non-revoked database registration. Responses are no-store; sanitized AccountApiError failures preserve explicit auth/origin statuses.

Browser enrollments store only the signed public request and opaque encrypted response, never the fragment secret. A unique 128-slot owner constraint bounds concurrent creation; global expiry cleanup is bounded/lazy. Approval validates candidate membership, sender/recipient/context/TTL and exact public request against current signed state; conditional persistence includes that state head and previous bundle. Same-approver resealing within request TTL is supported; candidate HMAC verification remains mandatory. Approved lookup may return an aged response so it can be resealed; expired enrollment itself fails.

Pair start persists optional public bridge enrollment and uses its five-minute expiry. Lookup POST returns `enrollment: null | AccountEnrollmentRequest`; cookie-authenticated lookup/approve/deny require exact trusted Origin. Approval cannot downgrade an enrolled row into the old flow. Poll validates advert, TTL, owner and public account approval before consumption, and conditions the account consumption on exact request/bundle/current head. Successful new pairing returns both accountApproval and public accountHistory with existing credentials. Legacy rows remain auth-only and cannot receive account authority. Expired approved rows do not mint credentials; account CAS failure returns an explicit conflict. Existing MCP consent/receipt behavior is unchanged and its focused tests still pass.

Changed files in this server wave:

- `ui/src/lib/account-trust-store.ts`, `account-trust-store.test.ts`, `pairing-store.ts`, `pairing-store.test.ts`.
- `ui/src/app/api/security/account/_shared.ts`, `route.ts`, `route.test.ts`, `enrollments/route.ts`, `enrollments/[id]/route.ts`.
- `ui/src/app/api/auth/bridge/pair/{start,lookup,approve,poll,deny}/route.ts`, `pair-routes.test.ts`, `account-pair-routes.test.ts`.
- `ui/migrations/0007_account_trust.sql`, `ui/schema.sql`, `e2e/scripts/setup-db.mjs`.
- `bridge/package.json` and `bridge/package-lock.json` patch version 0.19.54; no install or dependency change.
- `docs/e2ee-operations.md` and this report.

Checks: 53 focused store/route/pairing/MCP tests passed across seven files; scoped strict TypeScript for changed server/test entrypoints reported zero diagnostics; setup-db JavaScript syntax passed. Local Node24.12.0; root owns supported-runtime combined gates. Core files remain frozen. No Git, generated output, dependency install, database, server, browser or E2E execution.

Root-only database acceptance, after verifying the exact isolated loopback database/user/port and task-owned resources:

1. Seed representative legacy pairing/bridge/user/OAuth rows before 0007 and capture deterministic row counts/digests. Apply 0007 transactionally twice through existing runner semantics; assert identical legacy values, new pairing columns null and new tables empty. Fail fast on unexpected selectors, lock timeout or statement timeout; retain tables on application rollback.
2. Use real signed fixtures to insert genesis, append two competing records with one expected head concurrently and assert exactly one winner; stale writer returns conflict. Verify owner-isolated history reads and rejection of tampered signatures/denormalized metadata.
3. Verify enrollment idempotency/collision rejection, the unique owner/slot cap under concurrent inserts, expiry and owner-only reads. Assert public SQL contains no fragment secret or private JWK.
4. Exercise account pairing approval/response resealing and policy-head changes between validation and CAS; invalid/missing/expired binding must leave the row unconsumed and issue no tokens. Confirm an unchanged legacy auth-only row still issues its ordinary token bundle.
5. The owned E2E setup script now loads 0007 inside its existing migration transaction (`cd e2e; node scripts/setup-db.mjs` only after root preflight). Root then runs the new focused account/browser/bridge/MCP flows and verifies exact cleanup; worker has not executed that command.

No unresolved implementation blocker from this server wave. Full combined static/build checks, independent security review and real PostgreSQL/E2E assertions remain root-owned gates. Server/config/report write leases released; stopped for cross-review.

## Root-only real PostgreSQL harness

`e2e/scripts/check-account-trust-db.mjs` implements the database acceptance steps above. It requires Node24.22.1+ and validates loopback database `ftown`, user `ftown`, port5432, compatible PG environment selectors and test account email before connecting. It creates a unique `ftown_account_check_<randomhex>` schema and restricts all production-store queries through that schema's search_path. A process-local source loader injects the schema adapter into the actual pairing store; AccountTrustStore uses its existing query injection. No production SQL is reimplemented.

The harness derives pre0007 DDL from the canonical schema prefix, explicitly removes extension creation, seeds representative users/bridge/pairing/OAuth records, applies0007 twice and compares stable legacy projections/digests. It exercises actual signed same-head CAS races, owner isolation, history/metadata tampering, enrollment idempotency/collision/expiry, concurrent128-slot capacity, and account pairing downgrade/invalid/expired/stale-head guards plus legacy success. Expiry for the enrollment read uses its production injected clock; pairing SQL expiry uses an expired row timestamp. It does not issue HTTP credentials or replace browser/E2E coverage.

Invoke once from the repository root in the root-owned supported-runtime shell, after normal isolated resource preflight and sourcing the run environment: `node e2e/scripts/check-account-trust-db.mjs`. Only fixture schema identifiers, stage names, sanitized error codes/line numbers and pass/fail summaries are logged. The finally block closes the pool, drops only the exact created schema and verifies its deletion. The worker performed only syntax and pure parse/path/alias/schema-prefix/email-guard checks; no database or module execution. DB harness write lease released separately so root can execute it while unrelated fixture scripts are still being authored.

## Dedicated MCP fixture handoff

Root executed the frozen PostgreSQL harness on Node24.22.1/PostgreSQL16: migration0007 idempotency and legacy digests, signed CAS/owner/tamper checks, enrollment expiry/collision/concurrent128-capacity and pairing guards/legacy consumption all passed. Root verified removal of the unique schema, compose containers/network and database listener. The harness remains frozen; this worker did not execute database or runtime checks.

The dedicated MCP account fixture is complete. Changed files in this bounded fixture wave: `e2e/env.sh`, `e2e/scripts/start-services.sh`, `e2e/scripts/stop-services.sh`, `e2e/scripts/mcp-test-config.mjs`, `e2e/.gitignore`, `e2e/README.md`, and this report. Existing main account and its two bridge homes remain independent. New exports are `E2E_MCP_USER_EMAIL`, `E2E_MCP_USER_PASSWORD`, `E2E_MCP_BRIDGE_HOME` and `E2E_MCP_SECOND_BRIDGE_HOME`. The default homes are exact absolute children `.mcp-bridge-home` and `.mcp-bridge-home-2`; startup writes `.run-mcp-email` for helper fallback. New bridge PID files are `.mcp-bridge.pid` and `.mcp-bridge-2.pid`, with logs `mcp-bridge.log` and `mcp-bridge-2.log`. Both start through the legacy auth-only token path so the dedicated browser flow can migrate them without altering shared account fixtures.

Startup validates the exact loopback database, TLS/broker origins, distinct test accounts, scratch homes, absent PID records and available service ports before writes. Each bridge receives its own explicit data directory. The single MCP gateway config authorizes two distinct immutable owner UUIDs, each with exactly its own two authenticated bridge IDs; pointer credentials and wrapping secrets are never emitted. Config generation failure propagates before gateway startup. Stop uses the production encrypted OS-local client to remove task sessions before stopping only recorded, identity-checked PIDs; it removes owned homes/run-email files only after successful cleanup and otherwise preserves evidence with a failing status. Docker infrastructure remains root-owned.

Checks passed: shell syntax for env/start/stop, JavaScript syntax for MCP config, pure TypeScript parsing of all four embedded JavaScript heredocs, and whitespace/final-newline checks for all six fixture files. No dependency install, Git mutation, database, server, browser, E2E or CI execution. Root can source `e2e/env.sh` once in its supported-runtime shell and use the existing start/test/stop commands; the environment and gateway configuration now include the dedicated account automatically. No unresolved blocker. All remaining fixture/report write leases are released; STOP-WRITE for combined snapshot and root-owned runtime validation.

## Accepted combined validation and landing

Root accepted final validation on Boat Node24.22.1: bridge974 passed/4 skipped plus build; UI549 passed, types and production build, including UI-only dependency/output isolation; release17 passed and browser-trust harness6 passed. Real PostgreSQL16 migration/CAS/ownership/tamper/enrollment/pairing acceptance passed. The task-owned harness reported UP. Independent server, bridge and UI security reviews closed. Nine focused E2E scenarios passed across the latest combined eight successes and a final MCP-only success after correcting test assertions to the existing structured per-machine error contract; production hashes were identical. Coverage includes desktop/mobile account trust, three transports, legacy encryption and OAuth/MCP read/control/audit. This does not claim the full E2E suite passed locally.

Root accepted rendered desktop/mobile/MCP screens and verified cleanup of task containers, listeners, recorded PIDs, scratch bridge homes, browser trust and sessions. Root deleted the task Boat sandbox `bx_52n5ebz2` and verified a follow-up404; evidence was copied locally. Evidence is recorded in `/tmp/ftown-account-final-validation`, `/tmp/ftown-account-e2e-round5` and `/tmp/ftown-account-e2e-mcp-passed`. Exclusive landing lease permits exactly95 task paths; four unrelated notes remain hash-identical and unstaged. No merge or production deployment is authorized.

Landing-only fixture checks: removed one extra EOF blank line from the account-pairing helper and replaced the account pairing unit test's static signing secret with a generated32-byte hex fixture, preserving every assertion. The focused pairing test passed5/5 on local Node24.22.1. Normal commit hooks remain enabled; no allowlist or hook bypass.
