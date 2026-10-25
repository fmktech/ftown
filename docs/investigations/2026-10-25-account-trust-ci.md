# PR 136 CI repair coordination

- Checkout: `/Users/fkesheh/projects/ftown-simplify-all`; branch `feat/account-trust-pairing`; starting SHA `9819b77c4bebfdd0891825f64295b7d634f02234`.
- Evidence: GitHub run `40210710101`, 45 passed / 3 failed / 2 skipped; `/tmp/ftown-pr136-ci-failed.log` and `/tmp/ftown-pr136-ci-artifacts`.
- Failures: old device-pairing test waits for a stdout code; two push tests fail registering users with HTTP 429; cleanup reports first bridge PID identity mismatch.
- Existing four unrelated notes remain protected and unstaged. No production deployment or merge authorized.

## Ownership and gates

All previous workers were completed before this wave. Existing native workers retain explicit `gpt-6.1-sol` / `high` selections. They share this checkout and must not revert others' edits.

| Owner | Exclusive writable paths | Dependencies / leases |
| --- | --- | --- |
| `/root` | this coordination document | Sole E2E, browser, server, database, sandbox and CI execution owner |
| `/root/security_ui_impl` | `docs/investigations/2026-10-25-account-trust-ci-pairing.md` | Read-only source investigation; source repair awaits proven cause and explicit lease |
| `/root/mcp_security_impl` | `docs/investigations/2026-10-25-account-trust-ci-fixtures.md` | Read-only source investigation; source repair awaits proven cause and explicit lease; designated later integration owner |
| `/root/account_server_review` | `docs/investigations/2026-10-25-account-trust-ci-review.md` | Independent read-only review of frozen contracts and stopped repair diffs; no application/runtime/Git writes |

Exact report paths are disjoint; application, Git/index, generated output and dependency resources are unleased. No worker may execute E2E, start services or rerun CI. Debug reports must record evidence and falsification before source changes. Root accepts reports, freezes bounded repair contracts, then assigns disjoint source ownership. Independent review follows STOP-WRITE; root validates changed scenarios and the combined suite via existing CI. Landing uses normal hooks and preserves protected notes.

## Pairing repair contract (frozen)

The pairing report proves the old consumer is stale: modern noninteractive startup deliberately never prints the expected code, and the old UI labels/public-code-only navigation are retired. Source lease granted only to `/root/security_ui_impl`: `e2e/tests/device-pairing.spec.ts`, plus its report above. Reuse the existing modern account-pairing helper without editing it. Preserve real no-token/fresh-user startup, one comparison confirmation, broker presence, mandatory registration Active-to-Revoked behavior and awaited exact-child cleanup. No production/security changes, no secret output, no skips, no weakened assertions. Worker may run static/pure checks; root alone runs E2E. Exact ownership remains disjoint.

## Fixture repair contract (frozen)

Pairing writer has stopped; independent static review passes. Fixture investigation proves both the shared registration quota and relative restart argv causes. Sole source lease to `/root/mcp_security_impl`: `e2e/helpers/app.ts`, `e2e/helpers/bridge-process.ts`, new `e2e/scripts/ci-fixtures.test.mjs`, `.github/workflows/e2e.yml`, plus its report. Independent reviewer owns only its report throughout.

- Model a stable source IP per normalized `@ftown.test` user using documentation-only IPv6 addresses and the existing client-IP header boundary. Reject noncanonical local harness destinations before fetch. Retain actual registration requests, stable same-user quota, production limits and route behavior.
- Relaunch the exact absolute bridge entrypoint with explicit owned HOME/USERPROFILE/data directory, retaining same-PID readiness and strict cleanup guards.
- Add small pure Node regressions against actual helpers; no framework/dependency additions. Prove separate identities and repeated identity, remote-target rejection and replacement argv/home/PID compatibility. Mocked quota checks demonstrate fixture behavior, not independent verification of the database-backed production limiter. Capture old-behavior failure and new-behavior pass. One pure-test invocation in existing CI; no runner migration or runtime-selector changes.
- Production sources, stop guards, package/lockfiles, Git/index and runtime resources remain unleased. Root verified existing workflow/environment uses Node24.22.1 and CI-local compose PostgreSQL `localhost/ftown`; automatic CI will run all browser tests and cleanup after reviewed repair publication.

## Accepted repair and CI handoff

Both repair writers stopped and released their exact scopes. Pairing strict TypeScript passed; fixture regressions against actual helpers passed4/4 on Node24.22.1, while the captured old behavior fails3/4. The same-user quota control passes both versions. Combined strict E2E TypeScript and diff checks passed. Independent combined review PASS, including real client-IP precedence over Next's forwarded header and exact restart identity. These are static/pure gates; full browser and teardown runtime remains pending.

All nine task paths above are frozen. After the independent reviewer releases its report, `/root/mcp_security_impl` receives the exclusive Git/index/commit/push/PR-metadata lease, stages exactly these nine paths, preserves four unrelated notes byte-for-byte and unstaged, and updates existing PR136 using normal hooks. No application edits, merge or deploy. Root exclusively monitors the resulting automatic full CI through cleanup; final runtime evidence belongs in PR metadata/native handoff without reopening unchanged sources. Worker completion releases all leases.
