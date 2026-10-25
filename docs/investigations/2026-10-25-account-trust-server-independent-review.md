# Independent security review — account-trust server/API slice

Reviewer: `/root/account_server_review`, explicitly dispatched `gpt-6.1-sol` / `high`. Checkout `/Users/fkesheh/projects/ftown-simplify-all`, branch `feat/account-trust-pairing`, base `8425849`. Application files were read-only; only this report was written. Frozen contract/core and server STOP-WRITE handoff were reviewed; bridge/UI implementation remains outside this review.

## Verdict

**PASS for focused static security review; no confirmed blocking vulnerability found.** This is not a PostgreSQL/runtime/E2E sign-off. Preserve the root-owned isolated database and focused integration gates below before declaring the combined feature complete.

## Threat model

The service handles immutable account UUIDs, signed public trust histories, public candidate keys and labels, opaque encrypted enrollment responses, pairing bearer codes and issued bridge credentials. Authenticated browsers can create/append owner-scoped records; registered bridges can read their owner's history; anonymous bridge candidates can start/poll pairing by bearer code. Attackers may substitute candidates, replay stale approval material, race revocation/consumption, cross owner boundaries, exhaust bounded storage, or exploit browser cookies through cross-origin requests. Boundaries reviewed are HTTP/session or bearer authentication to owner selection, request JSON to signed-history verification and parameterized SQL, signed state to enrollment/pairing persistence, and consumed pairing state to credential issuance. The delivery service is not a cryptographic trust authority: candidates must still verify the encrypted transcript/HMAC and signed history. Malicious-service withholding or old-valid-history forks are the documented limit; 24 hours is connectivity grace, not guaranteed revocation.

## Entry points and evidence

- Account GET/POST and browser enrollment create/read/approve routes: `ui/src/app/api/security/account/route.ts:6`, `enrollments/route.ts:5`, `enrollments/[id]/route.ts:6`. Browser mutations resolve session identity after exact canonical-origin validation; bridge GET verifies HS256 audience, immutable owner mapping and a non-revoked registration (`_shared.ts:15-32`). Bearer authentication cannot authorize browser mutations.
- Public pair start/poll and authenticated lookup/approve/deny: `ui/src/app/api/auth/bridge/pair/{start,lookup,approve,poll,deny}/route.ts`. Public start accepts only a bounded bridge request; lookup/approval/denial require the existing browser session and trusted Origin. Public codes are intentionally capabilities for not-yet-owned requests, rather than foreign account object identifiers.
- `AccountTrustStore.readVerified` verifies the complete signed history and denormalized owner/root/revision/head (`ui/src/lib/account-trust-store.ts:35-42`). Append verifies the prior state and next signed record, then first-inserts with conflict-do-nothing or updates only the exact owner/root/revision/head (`:45-60`). No unsigned genesis presence establishes a client/bridge pin.
- Enrollment reads/writes include the authenticated owner; exact request/candidate/signing-key/label/approver/envelope context and TTL are checked (`:83-141`). Browser approval SQL conditions on the old bundle, exact request, expiry and verified current history head (`:105-109`). Same-approver resealing preserves membership rather than appending it again. Historical approver acceptance is limited to delivery/read paths; the candidate still verifies authority at the encrypted bundled head and current candidate membership.
- Account pairing cannot fall back to legacy approval/consumption: legacy SQL explicitly requires `enrollment IS NULL`; account SQL checks exact request/bundle, current head and expiry (`ui/src/lib/pairing-store.ts:115-179`). Poll validates advert, TTL, owner and account approval before consumption, and returns no credentials on unsuccessful CAS or owner-scoped refresh upsert (`ui/src/app/api/auth/bridge/pair/poll/route.ts:64-167`). Resealing changes cannot pass an old bundle's consumption condition.
- Migration `ui/migrations/0007_account_trust.sql:4-29` only creates new empty tables/index and nullable pairing columns, with local five-second lock/thirty-second statement limits. Schema matches. The E2E runner applies it inside an explicit transaction (`e2e/scripts/setup-db.mjs:75-77`). Existing records, credentials and grants are not transformed; application rollback retains the new trust data.

## Findings

None confirmed in the reviewed slice. No speculative hardening issue is ranked as a vulnerability. Exact-head SQL is a stale-write guard at statement execution; this report does not claim stronger global revocation or delivery guarantees.

## Least-privilege review

- No new IAM policy, database grant, OAuth scope, environment secret or dependency was introduced. Bridge package/lock changes are a patch-version change only.
- Bridge account access uses an existing signed connect credential only for owner-scoped public-history reads and checks the registered bridge is not revoked. It provides no account signing key or mutation authority.
- Browser mutations require a session plus same-origin request; cryptographic membership changes additionally require a signature from an active prior device. The server stores only public signed history/public requests and opaque approval ciphertext. Fragment secrets and browser private keys are absent from the persisted request shapes and SQL parameters.
- Existing 24-hour connect / 30-day rotating refresh credentials retain their established transport scope. The account-roster authority remains independently pinned and cryptographically verified; gateway credentials alone do not confer it. No scope expansion of MCP receipts was found.

## Absence checklist

| # | Item | Verdict | Evidence / scope |
|---|------|---------|------------------|
| 1 | Authentication | checked-clean | Session identity for browser routes; signed, audience-restricted registered-bridge GET; public pair start/poll deliberately use bearer pairing codes. |
| 2 | Function authorization | checked-clean | Same-origin session mutations; valid prior-state signing authority for append; bridge bearer cannot mutate. |
| 3 | Object authorization / IDOR | checked-clean | Account/enrollment queries include authenticated owner. Pair approval prechecks existing bridge owner and credential registration uses the owner-scoped upsert. |
| 4 | Input validation | checked-clean | Exact shapes, streamed body bounds, shared strict enrollment/history parsers, canonical public keys/heads, allowed advert fields, context and expiry checks. |
| 5 | Injection | checked-clean | Reviewed SQL binds user-controlled values. No added shell/path/template sink. |
| 6 | Output encoding / XSS | n.a. | Reviewed handlers return JSON; no HTML/DOM rendering added in this server slice. UI rendering requires its separate review. |
| 7 | Secrets | checked-clean | Public-only request/history shapes; ciphertext-only bundles; secrets sourced through existing required-secret helper. No new key/dependency credential in inspected changes. Pair polling intentionally returns credentials to the one-use bearer-code holder. |
| 8 | Unsafe deserialization | checked-clean | Bounded JSON decoding followed by strict schemas; no evaluator, arbitrary class instantiation or unsafe object deserializer. |
| 9 | SSRF | n.a. | No new server-side user-directed network-fetch target. SQL driver and configured service access are existing infrastructure. |
| 10 | File uploads | n.a. | No upload/file storage surface introduced. |
| 11 | Rate limiting / abuse | checked-clean | Existing owner/IP/code-scoped checks protect reviewed handlers; streamed body and history bounds plus unique 128 owner slots independently bound stored enrollment material. This is not a strict concurrent requests-per-window guarantee for the existing two-call limiter. |
| 12 | Errors / information leaks | checked-clean | Account failures use sanitized typed errors and no-store; unauthorized enrollment IDs disclose no foreign request. Pair errors do not expose ciphertext plaintext/private keys. |
| 13 | CORS | checked-clean | No reflective or credentialed wildcard CORS added; browser mutations require exact trusted Origin. |
| 14 | Headers / CSRF | checked-clean | Exact canonical Origin required on all changed cookie-auth mutations; existing NextAuth session machinery retained, no cookie-setting code introduced. Account responses no-store; global framing/nosniff/referrer headers remain in `ui/next.config.ts`. |
| 15 | Dependency risk | n.a. | No new package/version dependency; bridge manifest/lock only change the application's patch version. |

## Validation and remaining gates

Reused valid evidence from the server handoff: 53 focused store/route/pairing/MCP tests and scoped strict TypeScript passed on Node24.12.0. Core's separate 28-test independent review and root's matching-snapshot Node24.22.1 pass remain valid; no core implementation review or test rerun was duplicated. I read the focused tests: mocked SQL checks demonstrate intended guards, not real PostgreSQL concurrency or migration execution.

Root-only remaining gates: supported-runtime combined checks; actual isolated PostgreSQL first-insert and transition CAS races; enrollment slot concurrency and owner isolation; expiry/current-head/bundle changes before pair consumption; seeded legacy-row preservation plus repeat migration application; focused account/browser/bridge/MCP E2E and rendered mobile UX. Verify the exact database/deployment selectors before setup and retain resource cleanup evidence. No production DDL, runtime, browser, database, E2E or CI execution was performed by this reviewer.

Report handoff complete. Application write authority was never acquired; the exclusive report lease is released and the reviewer is stopped after this handoff.
