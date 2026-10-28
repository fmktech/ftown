# P1 release and handoff implementation

Owner `/root/site_integration`, Tier1 `gpt-6.1-terra` / `xhigh`. Exact changed files: `bridge/src/update-release.ts`, `bridge/src/update-release.test.ts`, `bridge/src/update-handoff.ts`, `bridge/src/update-handoff.test.ts`, `bridge/scripts/bridge-update-smoke.mjs`, `bridge/package.json`, `bridge/package-lock.json`, `README.md`, and this report. No other files were written by P1.

Release exports implement fixed-origin stable metadata validation, conservative Node engine matching, exact SHA-512 tarball verification, UUID-owned private stage, sanitized npm subprocess environment, package protocol/version and native load probes, and owner-checked stage deletion. `createUpdateReleaseApi` is an injected unit seam; no registry environment override was added. Package and lock versions are 0.19.58; package advertises `ftownUpdateProtocol: 1`.

Handoff exports provide private reservation/receipt storage, owner/permission checks, exact nonce and parent-PID-bound context, helper prepared and commit acknowledgements, old-PID exit wait, staged setup, exact installed CLI restart and identity-matched readiness receipt. `UpdateHandoffUncertainError.code = 'handoff_uncertain'` signals unproven helper termination. Setup lock/reservation interlock was coordinated with R1. Update context environment is removed after it is authenticated; only a nonsecret launch-environment allowlist is forwarded to setup/replacement. README documents support bounds and repair instructions.

Checks on Node 24.22.1: focused `node --import tsx --test src/update-release.test.ts src/update-handoff.test.ts` **6 passed** (metadata rejection, staged candidate/protocol/integrity/failure, reservation exclusivity/foreign/symlink/dead-owner/setup interlock, atomic receipt). Own-module strict no-emit TypeScript passed; `node --check scripts/bridge-update-smoke.mjs` passed; version/protocol fields checked. These tests use injected stage boundaries and **do not** establish actual process handoff, native module loading, user-facing end-to-end behavior, or security review. The host emitted the existing NO_COLOR/FORCE_COLOR Node warning. No full build, E2E, service, network install, registry query or process smoke was run by this worker.

Root-only smoke after building the combined bridge in its isolated environment:

```sh
cd bridge
npm run build
node scripts/bridge-update-smoke.mjs
```

The authored smoke uses synthetic fixture setup/replacement executables and a private temporary HOME; it attempts cancel-before-commit, real IPC/old-process exit with success, setup failure and replacement-readiness failure. It is syntax-checked only and has **not been executed**. It does not prove real npm acquisition or the real installed bridge integration. Root should additionally run the integrated installed bridge/harness status against its isolated local DB, using the exact runtime owner's E2E steps; never use a user HOME or production account.

For independent review: process timeout paths send SIGKILL to the owned process group and wait for its close, but there is no additional hard deadline on the subsequent close event if the OS cannot reap it; this is a boundedness/ownership concern that must be checked before declaring the flow ready. The private reservation guard file deliberately fails closed if a process dies while holding that short-lived guard; recovery of such a guard is not implemented. The smoke fixture and real private IPC ordering also require root execution. No rollback is promised; failures after setup request exact-version repair. No claim of production readiness is made.

P1 source, test, README, package metadata and report leases released to root for independent review and integrated validation. I remain available for a concrete repair assignment; no Git lease is active.


## V1 bounded repair handoff

The earlier two concerns above are superseded by this repair. `update-reservation.guard` is now an atomic nonempty private directory carrying a PID and random owner marker; only a validated exact marker with a provably dead PID is reclaimed. Live, malformed, empty, symlink or unknown ownership fails closed and is preserved. Reservation and setup/start checks use the same guarded mutation; tests cover dead, live, empty and mismatched-owner cases.

Both stage subprocess and postcommit setup wait for actual child close, then use a five-second termination-proof budget after the kill deadline. If close is not observed, they reject with `code: 'update_process_uncertain'`. Staging leaves its job and marker in place rather than deleting them; R1 must retain reservation and closed admission for that error. If helper-owned setup or replacement termination cannot be proven after commitment, the helper intentionally stays alive holding its reservation and leaves the existing receipt unchanged, so stale-owner recovery cannot treat uncertainty as completion. Injected EventEmitter tests exercise missing close and confirmed-close branches without spawning children. The prior root process smoke applies to the previous snapshot only; root must rerun relevant process checks on this revision.

Root independently reproduced npm 11.19.1 rejecting the same `/dev/null` file for both user/global config. Staging now creates two distinct empty mode-0600 npm config files under its private job. An actual bounded offline `npm config get registry` unit check passed with those exact sanitized settings; it performs no install or network call. The first run returned the configured registry without a trailing slash; the test now normalizes the URL before strict comparison. No install, process smoke, E2E, service or Git work was run here.

Checks on Node24.22.1: `node --import tsx --test src/update-release.test.ts src/update-handoff.test.ts` **10/10 passed**, including npm configuration, uncertain-close, retained stage, owner-marker and prior release/receipt controls. Scoped strict no-emit TypeScript passed. Host emitted its existing NO_COLOR/FORCE_COLOR warning. Updated files: `bridge/src/update-release.ts`, `bridge/src/update-release.test.ts`, `bridge/src/update-handoff.ts`, `bridge/src/update-handoff.test.ts`, this handoff. The scope does not prove actual subprocess behavior beyond the offline npm config query; root owns re-running synthetic/installed process smoke and the independent reviewer owns closure. P1 files/report leases released to root.


## V1 readiness ordering and trusted-LAN repair

Reacquired and changed only `bridge/src/update-handoff.ts`, `bridge/src/update-handoff.test.ts`, and this report. The helper validates the replacement's exact readiness identity without acknowledging it, writes the matching succeeded receipt, verifies and releases the exact operation's reservation, and only then sends the final private ready ACK. Failed receipt persistence or reservation release propagates to the existing helper failure path; the ACK is not sent and the owned replacement is terminated, with uncertainty retained fail-closed. The post-ACK IPC disconnect is best-effort, so a disconnect race cannot turn an acknowledged success into a helper failure. Runtime integration must keep replacement admission closed until `reportUpdateReady` resolves from that final ACK.

The helper now forwards the explicit trusted-LAN flag only when `FTOWN_ALLOW_INSECURE_API=1`, through both environment filters, together with the previously allowed nonsecret launch settings. Other FTown environment variables, tokens, npm configuration and `NODE_OPTIONS` remain excluded. Staging's separate sanitized environment was unchanged.

`node --import tsx --test src/update-handoff.test.ts` passed **8/8** on Node24.22.1. The new deterministic test pauses receipt and reservation completion separately and checks no early ACK, including failure at either step; another tests trusted-LAN allowlist and exclusion. Strict scoped no-emit TypeScript passed. Tests use injected completion functions, not a live replacement; root owns the updated process smoke and independent reviewer closure. Existing host NO_COLOR/FORCE_COLOR warning appeared. No runtime, E2E, Git, service, install or outside-scope writes performed. File and report leases released.


## V1 ACK uncertainty correction

This supersedes the preceding release-before-ACK ordering. In `update-handoff.ts`, the helper persists the identity-matched success receipt while still holding the reservation, marks the ACK as attempted **before** sending, waits for the private send callback, and releases the exact reservation only after that callback succeeds. R1 keeps replacement admission closed until it receives the exact ACK. Any error after the ACK attempt leaves the replacement untouched, attempts to change the receipt to restarting/uncertain, and keeps the helper alive holding the reservation; it never sends the owned replacement a kill signal. Before an ACK attempt the existing bounded terminate/proof path remains. The retained helper is intentional when delivery or release cannot be established, because the replacement may already have admitted work.

`update-handoff.test.ts` now tests receipt → mark ACK attempt → ACK callback → release, with deferred receipt/ACK; injected ACK rejection and post-ACK release failure each verify retained reservation and no call to an intentionally unprovable child-stop operation. A receipt failure verifies the pre-ACK stop path. `node --import tsx --test src/update-handoff.test.ts` passed **9/9** and scoped strict no-emit TypeScript passed on Node24.22.1; the existing host color warning appeared. These are injected ordering/cleanup checks, not process-level proof; root owns the fresh smoke and reviewer closure. Only `update-handoff.ts`, its test and this report changed; the three leases are released. No runtime, E2E, services, Git or outside-scope writes were performed.


## Focused browser fixture selector repair

Reacquired only `e2e/tests/bridge-updates.spec.ts` and this report. The desktop/mobile test now identifies the paired default bridge using the existing `readBridgePointer().bridgeId` and its exact `data-bridge-row` rather than assuming the first row is approved. It waits for a successful real `/api/version` response during login and asserts that the unchanged served build has no app-update notice after the real bridge dialog is ready. The separate app-update test still uses its explicit build-ID route fixture. Installed version, disabled update without opt-in, screenshots, 44px target, Escape/focus and overflow assertions remain unchanged.

E2E static check passed: `/Users/fkesheh/.nvm/versions/node/v24.22.1/bin/node node_modules/typescript/bin/tsc --noEmit` from `e2e/`. No Playwright, browser, server, database, runtime or Git run by this worker. Root must rerun the focused browser file and inspect its rendered screenshots; the real version-response timing and paired fixture have not been runtime-verified by this worker. Both file leases released.


## L1 landing handoff

The final source and review gates are accepted; exact results, isolated fixture scope and cleanup are recorded in `bridge-updates-validation.md`. Fetch confirmed main remained `ce62d9d3c118528df70b9e49aceea4aaf1e28819`, bridge/lock agree on `0.19.58`, protocol capability is 1, and both exact npm package versions returned registry E404 at landing time. The designated integration owner stages the reviewed task paths and preserves the configured pre-commit hook. Git and report/coordination leases release at successful PR handoff; commit SHA and PR URL will be reported to root after they exist. No source, runtime, E2E, CI, package publication or merge is performed by L1.
