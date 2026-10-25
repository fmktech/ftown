---
type: investigation
symptom: "PR136 push fixtures receive registration429; teardown rejects the restarted primary bridge PID"
slug: account-trust-ci-fixtures
date: 2026-10-25T17:26:00.570188+00:00
git_commit: 9819b77c4bebfdd0891825f64295b7d634f02234
branch: feat/account-trust-pairing
repository: fmktech/ftown
status: root-cause-proven
hypotheses_formed: 6
hypotheses_rejected: 4
hypotheses_proven: 2
---

# PR136 registration fixtures and restarted-process ownership

Read-only investigation by `/root/mcp_security_impl`, gpt-6.1-sol/high. Each independent cause below has one proven hypothesis. Only this report was written. No application/harness edits, Git mutation, server, database, browser, E2E or CI execution. The main assistant owns runtime reproduction and cleanup.

## Reproduction and observed symptoms

The root-owned full `e2e` workflow on commit9819b77, Node24.22.1, one Chromium worker and isolated local compose completed45 passed/3 failed/2 skipped. Reproduction is the existing workflow sequence: source env once, start all four bridges/two accounts, run all Playwright specs in configured order, then stop-services. Evidence: `/tmp/ftown-pr136-ci-failed.log` and downloaded `/tmp/ftown-pr136-ci-artifacts/{bridge,ui}.log`. The two new account scenarios and MCP scenario passed. This worker did not rerun the workflow.

Distinct deltas:

- Both push tests fail before their push assertions: `Error: register failed: 429 {"error":"Too many registration attempts. Try again later."}` (CI log162,197), through helpers/app.ts50. Expected each logically isolated fixture user to register successfully through the real API.
- Teardown logs `[stop] bridge session cleanup failed; details suppressed.` and `[stop] bridge PID identity mismatch; preserving process and record` (CI log241,250). The other three bridge session cleanups succeed. Expected the exact restarted task-owned primary PID to retain the launch identity understood by teardown.

## Cause A: registration quota shared between logical fixture users

### A1: The suite exhausts the unchanged per-client registration quota (PROVEN)

- Layer: state/data and test-fixture integration.
- Prediction: registrations earlier in the serial suite reach10 at the same local source before push; later registrations get the exact production429 without entering push behavior.
- Verification: traced every registration caller, route and limiter; compared serial CI order and error stacks.
- Evidence: `ui/src/lib/login-rate-limit.ts24-27` defines `maxAttempts: 10` and one-hour lockout. `ui/src/app/api/auth/register/route.ts78-89` checks scope `register`, derived client IP, records every valid attempt before checking whether an account already exists. `e2e/helpers/app.ts42-47` supplies only Content-Type, and every registration targets the same local UI. Startup registers two accounts (start-services.sh82-83); each account-trust viewport registers its account and foreign account (account-trust.spec.ts20,56), adding4. Auth-session adds1; device-pairing adds1; IDOR channels and HTTP add1 each. Total before push=10. CI order shows these registration-bearing phases execute before push (log71-106); the two push registrations then both fail429 (log162,197).
- Verdict: PROVEN. Increased aggregate fixture demand crosses a deliberately shared egress budget; this is not a reason to increase that production budget.

### A2: Push permissions/service worker or provider setup produces the429 (REJECTED)

- Layer: browser/dependency integration.
- Prediction: failure occurs during push subscription/display or API ingestion.
- Evidence: both stacks end at `registerUser`/`registerAndLogin` before the push assertions; first spec25 and second spec116. Error text exactly matches registration route's429 branch.
- Verdict: REJECTED. Neither failure reaches push business behavior.

### A3: Duplicate email or password validation causes registration rejection (REJECTED)

- Layer: API/code logic.
- Prediction: duplicates or invalid password return this same failure independently of quota.
- Evidence: helper makeUser creates a fresh timestamp/random email; password is the existing12+character fixture. Registration route returns400 for invalid input and generic200 for duplicate accounts; it alone returns the observed429 when the limiter blocks.
- Verdict: REJECTED. Neither alternative produces the observed status/body.

### A: 5 Whys

1. Push setup fails because registration is the11th/later attempt from the shared fixture source.
2. Its source is shared because all logical users use the same helper request headers/local target.
3. Demand increased because the new desktop/mobile scenarios require separate own/foreign accounts and startup adds an MCP account.
4. Fixture isolation covered email/account state but did not model distinct client-source identities.
5. The suite implicitly budgeted all unrelated users against one production anti-abuse bucket; fixture identity needs to include a deterministic test source, while actual registration/authentication remains exercised.

### A: falsification

Adjacent-cause and absence checks: registration status is429, not duplicate200/validation400; the earlier registration-dependent specs succeed, then both later push fixtures fail before browser push work. This explains the ordering dependence without disabling production protection. Exact server-derived IP bytes were not logged; no claim is made about whether Next materializes loopback forwarding headers or the fallback key. All helpers/startup share the same local source and do not supply distinct source headers.

## Cause B: restart producer violates the cleanup launch-identity contract

### B1: Resurrection relaunches the bridge using a relative entrypoint (PROVEN)

- Layer: harness code/integration contract.
- Prediction: primary cleanup alone fails after resurrection, despite a live usable bridge; never-restarted siblings pass exact-path ownership checks.
- Verification: read startup/restart/stop producers and consumers; inspected passed CI resurrection and bridge log lifecycle.
- Evidence: startup uses absolute `$REPO/bridge/dist/index.js`; `e2e/helpers/bridge-process.ts123-130` instead spawns `["dist/index.js", ...]` with cwd bridge, then writes that child's PID to `.bridge.pid`. `stop-services.sh24` requires the exact absolute entry in Linux cmdline before session cleanup; its kill guard50-54 likewise requires the exact absolute entry. CI resurrection passes (log111), bridge.log289 records shutdown and298-313 records resumed refresh/startup/ready, later usage specs pass (CI117-120), then primary-only cleanup identity checks fail (CI241,250). The other three bridges were never relaunched and clean successfully.
- Verdict: PROVEN. The process is task-owned, but its replacement argv no longer matches the deliberately strict ownership evidence.

### B2: Primary bridge crashed/exited before cleanup (REJECTED)

- Layer: runtime/environment.
- Prediction: no live process reaches the PID-identity guard; later encrypted bridge operations fail.
- Evidence: later usage specs pass after resurrection. The stop shell only prints PID identity mismatch inside a successful kill-0 branch. The sibling cleanup successes rule out a global unavailable CLI build or database.
- Verdict: REJECTED as the cause of the recorded identity mismatch.

### B3: New account migration moved or revoked the main fixture bridge (REJECTED)

- Layer: account/policy state.
- Prediction: an account authorization failure or changed bridge home causes this mismatch and affects the same account's other bridge.
- Evidence: MCP migration uses its separate account and two homes; new account tests also use separate scratch homes. Teardown fails before crypto/API authorization, at the literal executable-path check. Main bridge2 cleans successfully. The main resurrection helper alone rewrites the primary PID using a relative entrypoint.
- Verdict: REJECTED. Policy migration cannot account for this pre-dispatch argv failure.

### B: 5 Whys

1. Cleanup rejects primary because the exact expected absolute script argument is absent.
2. It is absent because restartBridge launches `dist/index.js` relative to its cwd.
3. Only primary is affected because resurrection replaces its PID while siblings retain startup launches.
4. Startup and restart have separate launch descriptions, while teardown enforces only the newly canonicalized startup description.
5. The harness lacked a regression checking replacement-process compatibility with ownership guards; fix the producer, preserving teardown's fail-closed contract.

### B: falsification

The same strict guards succeed for the three absolute-path sibling launches; primary remains usable after restart and only fails identity inspection. This counterexample rejects general cleanup/API failure and isolates the producer mismatch. No live process was inspected or killed by this worker.

## Minimal proposed repair and precise lease request

1. `e2e/helpers/app.ts`: derive a stable documentation-range IPv6 source from the normalized `@ftown.test` fixture email and send it as x-real-ip only after validating the destination is the exact local harness UI origin (localhost3000; reject remote/credential/path/query variants). This models separate logical proxied test clients using the existing production clientIp boundary. Same user retains the same key, so repeated requests still share a quota. Do not change application limits, add a test bypass, reset limiter rows, or sleep/retry through429. Existing startup sources remain their common bucket with only two registrations.
2. `e2e/helpers/bridge-process.ts`: spawn the canonical absolute bridge entrypoint and explicitly retain owned HOME/USERPROFILE/FTOWN_DATA_DIR, same actual PID record and pointer readiness checks. Keep teardown's exact argv/home checks unchanged.
3. New `e2e/scripts/ci-fixtures.test.mjs`: Node built-in pure unit regression, transpiling the actual two TypeScript helpers with the already-installed UI TypeScript compiler in an isolated VM with fake fetch/process/spawn/filesystem/dependencies. No child process, socket, database or browser. Registration test drives11 distinct fixture users through a key-counting fake API using real clientIp extraction, while11 repeated requests for one user still get429; hostile remote targets reject before fetch. Restart test captures actual spawn argv/env and PID-file write, validates compatibility with exact absolute cleanup identity, and verifies ownership overrides inherited selectors. A counterfactual old-header/relative-argv module variant must fail the same assertions before accepting the regression.
4. `.github/workflows/e2e.yml`: run the new pure regression after UI dependencies are installed, retaining the existing provider, actual full browser suite and cleanup gates. No new framework/dependency.
5. This report only for investigation/results. No other source/config changes requested.

Acceptance: pure regressions fail against prior behavior and pass with both bounded repairs; UI/E2E strict types; diff check; root-run full CI registration/push coverage plus resurrection then successful exact-PID cleanup. Preserve10/hour production registration behavior and negative-control429, real HTTP registration/auth coverage, exact task homes/PIDs, and no broad kill/allowlist. This report proves causes and proposes repairs; it does not claim fixes or runtime cleanup have passed.

## Before-repair regression evidence

On local supported Node24.22.1, the new pure Node tests executed the actual unchanged TypeScript helpers in isolated VM contexts:1 passed/3 failed. The eleven-distinct-user test failed at registration11 with `register failed: 429 {}` from the modeled backend; remote-destination rejection failed with `Missing expected rejection`; replacement-bridge compatibility failed at the exact absolute argv assertion. The same-identity11th429 negative control passed. No network, process, browser or database was started. This establishes fixture-boundary discrimination, not a new test of the production database limiter.

## Scoped repair STOP-WRITE handoff

Implemented only the granted paths: `e2e/helpers/app.ts`, `e2e/helpers/bridge-process.ts`, new `e2e/scripts/ci-fixtures.test.mjs`, `.github/workflows/e2e.yml`, and this report. Registration now refuses any target except exact `http://localhost:3000` and any non-test email before fetch, derives a stable96-bit documentation-range IPv6 suffix from the normalized test user, and sends the source through the existing x-real-ip boundary. Actual HTTP request method/body remain unchanged. Repeated identity keeps one quota; there are no sleeps, retries, limiter resets, production changes or new dependencies. Restart uses the absolute bridge entrypoint and explicitly restores owned HOME/USERPROFILE/FTOWN_DATA_DIR while retaining PID write, pointer-PID readiness and presence ordering. Teardown remains unchanged.

Supported local Node24.22.1 evidence: the same four pure tests changed from1 PASS/3 FAIL before repair to4 PASS/0 FAIL afterward. The repeated-identity11th429 negative control passes in both versions. The regressions execute actual helper functions in isolated VM contexts with fake fetch/process/spawn/filesystem and the real pure client-IP extractor; no external resources are used. They check eleven distinct identities, stable identity across instances, canonical-local destination/email rejection before fetch, full registration request shape, exact replacement argv/environment and new PID readiness/record. These mocks demonstrate fixture-boundary behavior only, not production PostgreSQL limiter semantics. CI invokes the test once after UI npmci, reusing the installed TypeScript compiler and Node built-in runner.

Strict E2E TypeScript passed with Node24.22.1; tracked diff check and all four repaired paths' whitespace/final-newline checks passed. The uncited earlier-focused-push-pass statement was removed. Original full CI run40210710101 remains the real runtime RED evidence; full automatic browser CI and exact cleanup on the reviewed new head remain root-owned runtime GREEN gates. No worker E2E/server/database/browser/CI or Git mutation occurred. No unresolved implementation blocker. All source/report write leases released; STOP-WRITE for one independent review and later landing lease.
