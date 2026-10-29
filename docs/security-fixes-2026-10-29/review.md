# Independent contract and implementation review

Reviewer: native `/root/auth_review`, Tier 2, `gpt-6.1-sol`, reasoning `max`.
Shared checkout: `/tmp/ftown-security-fixes`, base `8244d6d`.
Exclusive writable files: this report; `e2e/tests/security-admission.spec.ts`; `e2e/scripts/rate-limit-db.ts`; `e2e/scripts/mcp-body-parser-smoke.ts`. Root subsequently approved `e2e/helpers/app.ts` for fixture source isolation and exactly two invocations in `scripts/ci/run-job.sh`. All other files read-only. Root owns Git, integration, E2E/services/DB/CI execution. No recursive delegation.

## Contract review — approved

The behavior contract in `plan.md` is approved for implementation. No blocking architecture correction was found. The following are explicit review gates, not contract changes:

- Admission must come from the atomic SQL result; a later SELECT or atomic increment alone does not satisfy the concurrency promise.
- First `maxAttempts` calls are admitted; the next is denied. Expiry and legacy-null windows reset to count one, rejected calls preserve expiry, and stored count saturates.
- Both successful and failed login consume the source quota. Neither resets it; victim-email failure history cannot prevent correct login from an unthrottled source.
- Request caps count bytes in both declared and streaming bodies; typed size failures stay 413. Revoke's authentication and registration's disabled check remain before reading the body.
- Dependency schema migrations must preserve validation and generated-schema behavior; fixing an audit entry alone does not prove a runtime path safe.

## Focused test design (before test implementation)

The tests will assert contract outcomes through live HTTP/real PostgreSQL, leaving execution to root. Unit/static behavior and compatibility coverage remain with the implementation workers.

| Edge taxonomy | Applicable behavior / test responsibility |
|---|---|
| Empty/null/missing | HTTP malformed/non-object payloads return 400; missing auth keeps early 401; disabled registration keeps early 404 |
| Boundaries | 16,384-byte body cap and one byte above; admission budget exactly N then denial; expiry and legacy-null reset |
| Invalid input | Unsupported Content-Type and malformed JSON; wrong JWT; compressed-body late errors cannot disrupt the server |
| Dependency failure | Malformed compressed input exercises parser failure plus subsequent healthy request; DB connectivity errors must fail the standalone check |
| Concurrency/ordering | Independent DB clients contend for one scope/key and yield exactly the configured admissions; burst HTTP requests cannot bypass the register budget |
| Idempotency/duplicates | Repeated denied calls preserve window expiry and saturated count; successful login cannot reset source quota |
| Unicode/encoding/time | Byte-cap test includes multi-byte JSON; PostgreSQL time/expired rows used instead of timing sleeps; no timezone-dependent expectation |

Mutation discrimination: removing the cap must fail oversize status assertions; moving revoke auth after parsing must fail its oversized anonymous request; returning allowed unconditionally or admitting N+1 must fail exact concurrent counts; extending denial expiry/resetting on success must fail state/subsequent-denial checks; reintroducing email hard lock must fail a victim login from another source. These are planned checks; actual mutation/E2E execution is root-owned.

## Test-author handoff

- `security-admission.spec.ts` covers byte-exact multibyte at/over limits with Content-Length and real chunked requests, malformed/type errors, anonymous revoke authentication ordering, authenticated revoke/registration caps, real HTTP concurrent registration admission, victim login after another source's failures, and successful-login no-refund.
- `rate-limit-db.ts` executes the actual limiter source and SQL with a schema-scoped PostgreSQL transport. It verifies 7 admissions among 24 distinct backend clients, denial saturation/non-extension, retry bounds, expiry/legacy-null reset, max=1, scope isolation, and legacy failed-count reset. It uses only a newly created private schema and verifies its deletion. No production SQL export or application test seam was added.
- `mcp-body-parser-smoke.ts` targets the already running canonical HTTPS gateway. Valid compressed assertions must reach its real consent handler; delayed trailing gzip/deflate/br bytes may be rejected or disconnect only if the next health request succeeds. The byte sequences are an application regression derived from the advisory, not an exact upstream PoC. The script starts no services.
- `helpers/app.ts` assigns a synthetic documentation IPv6 source once per BrowserContext and injects it only on canonical localhost auth browser requests. Repeat logins in a context share their quota; dedicated security specs use explicit API sources.
- CI runs the DB harness after package builds/schema setup with explicit `MIGRATION_DATABASE_URL="$DATABASE_URL"`, and the parser smoke after `start-services.sh`, both under `timeout 120s`. Routing/preflight/cleanup remain unchanged.

Root commands: `MIGRATION_DATABASE_URL="$DATABASE_URL" node e2e/scripts/rate-limit-db.ts`; `node e2e/scripts/mcp-body-parser-smoke.ts`; from e2e, `npx playwright test tests/security-admission.spec.ts --project chromium`. Existing canonical isolated fixtures and root selector/resource preflight are prerequisites. Disabled-registration behavior is covered by UI route tests; the shared running E2E service explicitly enables registration.

Test files, fixture helper and CI invocation leases are released for root validation. Static/mutation/runtime execution has not been performed by this reviewer; root owns the real-world runs. Final source review is pending.

Root's first DB run found the harness extraction omitted the canonical table's `UNLOGGED` modifier; cleanup passed. The extraction now accepts the actual `CREATE UNLOGGED TABLE` declaration and executes that declaration unchanged. Script repair lease released for the same isolated rerun.

## Independent source review — approved, no blocking findings

Reviewed the complete application/manifest/lockfile diff against `8244d6d`, the new UI tests, and the Zod migration test/report. No new authorization bypass, injection sink, validation weakening beyond the explicitly approved compatibility decisions, or unrelated lockfile movement was found.

- UI: `login-rate-limit.ts:49–69` performs one parameterized upsert and returns its admission result, saturates at budget+1 and preserves active expiry. `auth.ts:34–61` charges source admission before lookup/bcrypt, preserves dummy bcrypt, removes victim-email hard denial and all success refunds. Registration charges before parsing while disabled registration remains early; revoke remains auth-first. The four routes preserve 413 and reject non-object JSON; helper `security-store.ts:27–34` now distinguishes absent input (400) from oversize (413).
- Legacy counter repair resets an expired count in `login-rate-limit.ts:110–121`; its comment now correctly warns that separate check/write callers do not supply atomic admission. New scopes avoid mixing admission windows with those legacy semantics.
- Zod: GUID substitutions retain historical UUID grammar; two-argument string-key records retain arbitrary-key behavior; optional unknown fields preserve v3 omission acceptance. Missing encrypted enrollment/receipt material still reaches mandatory `parseSecureEnvelope` and fails closed (`security/bridge/security.ts:96–101`, `mcp/oauth.ts:252–261`). Snapshot generic changes affect compile-time inference only. Safe-integer tightening and diagnostic prose differences are recorded root-approved behavior changes; schema limits and MCP -32602/isError contracts have focused tests. No `any`/ignore workaround was introduced by this migration.
- Dependency lock diffs contain the requested body-parser/qs/fast-uri/Zod/undici versions and necessary declared floors/version bump, without unrelated package resolution changes. Runtime compression regression remains required; an audit result alone is not its evidence. `dependencies.md` explicitly records the non-exhaustive v3→v4 release-history review limitation.

Root-reported verification accepted: corrected DB harness passed exact 7/24 admissions across distinct backend clients plus saturation/non-extension/expiry/null/max1/scope/legacy checks, and verified schema cleanup. Linux UI unit/build, bridge unit/build and release checks passed; bridge reported 1089 passes plus four pre-existing skips, release 17 passes. These were executed by root, not this reviewer. Parser and focused HTTP/E2E results were still pending at this review checkpoint.

Remaining scope limits: source-IP attribution continues to depend on the existing trusted ingress normalizing headers; this change intentionally reuses `clientIp`. The dependency migration includes the documented approved safe-integer and diagnostic differences. This is a bounded diff review, not a fresh audit of every unrelated security subsystem. Reviewer has stopped application/test/CI writes; all file leases are released. Root may return concrete failures for a scoped repair before final closure.

Root subsequently passed service startup and the compressed-parser smoke. E2E standalone typecheck exposed two introduced type errors: current Playwright returns a Disposable from `context.route`, and does not export the imported `Playwright` type. The route registration promise now normalizes to void; the focused spec uses the exported request factory directly. No global compiler configuration or unrelated alias errors were changed. Both repair leases are released for root's isolated rerun.
