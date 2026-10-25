# Independent CI repair review — PR136

Reviewer `/root/account_server_review`, explicitly reused `gpt-6.1-sol` / `high`; shared checkout `/Users/fkesheh/projects/ftown-simplify-all`, root-reported starting head `9819b77`. Read-only application/test review; only this report is writable. No Git, install, generated output, runtime, server, database, browser/E2E or CI execution.

## Pairing repair verdict

**PASS combined static review of the stopped pairing, registration-fixture and restart repairs. No confirmed blocker.** Root owns actual full CI/browser completion and exact runtime cleanup. Pairing evidence remains valid; the final fixture/restart closure is recorded below.

The boundary is test-fixture authority: a fresh user's tokenless bridge may reveal its enrollment fragment only through the explicit local helper, the browser must use the current proof-bound confirmation, and teardown may stop only the exact owned child/scratch directory. Test changes must retain observable registration revocation and cannot hide failure behind conditional checks, secret logging or broad process cleanup.

Reviewed `e2e/tests/device-pairing.spec.ts` against unchanged `helpers/account-pairing.ts`, registration/login helpers, actual PairClient and DevicesClient UI, frozen CI contract and the producer investigation. The old stdout/public-code/retired-selector consumer is proven incompatible with current noninteractive onboarding; increasing timeouts cannot repair it.

- Fresh `makeUser` plus registration/login with `pairBridge:false` preserves independent owner identity (`device-pairing.spec.ts:17-25`). The unchanged start helper creates isolated HOME/USERPROFILE/dataDir, runs CLI setup, and spawns the real bridge with no token. Approval retrieves the explicit local private link, scrubs the URL and clicks `Codes match — connect computer`; no public-code authority or enrollment bypass is introduced.
- Authoritative broker-presence polling remains mandatory for the fresh owner's channel (`:29-34`). The approved bridge's actual pointer supplies the immutable bridge ID.
- `/devices` must show exactly one row. The locator matches its immutable12-character bridge prefix, which DevicesClient renders independently of status. Exact Active→confirmed Revoke→Revoked assertions are mandatory; reload→Revoked proves server persistence (`:36-47`, `ui/src/app/devices/DevicesClient.tsx:186-227`). This is bridge-registration revocation, distinct from the last account administrator rule.
- The awaited finally block calls the original helper's exact child cleanup and removes only its scratch home (`:48-58`, helper`:52-64`). An original assertion exception is rethrown; a secondary cleanup error does not replace it, while cleanup failure on an otherwise successful test produces a fixed safe failure. No unowned PID scan or real-HOME deletion was added.
- CLI private stdout is consumed only by the unchanged local link helper; bridge stdio is ignored, CLI/navigation errors are replaced with fixed messages, and the repaired spec adds no fragment/token/response-body logging. No production/shared helper/security/dependency edit accompanies this pairing repair.

Reused producer evidence: strict E2E TypeScript passed on local Node24.12; old stdout predicate was reproduced against actual CI output; unchanged modern helpers already passed desktop/mobile account CI scenarios. These checks do not prove this repaired lifecycle's runtime success. Root must run it and retain mandatory revocation and exact process/home cleanup evidence.

## Fixture contracts reviewed

- Retain the production registration limit of10 attempts/hour. Isolate ordinary test registration sources so unrelated fixture users do not consume one shared IP budget; no production limiter increase/bypass, sleeps, skipped users or masking429 success. Keep intentional same-source rate-limit coverage meaningful. The final implementation is reviewed in the closure below.
- Restart the bridge through the canonical absolute entrypoint already required by strict teardown identity checks. Repair the process producer rather than loosening ownership validation; preserve exact PID/HOME/argv/path checks, serialized restart ownership and verified cleanup. The final restart arguments and pure regression are reviewed below.

## Security coverage of the pairing change

| # | Check | Verdict | Evidence / scope |
|---|---|---|---|
| 1 | Authentication | checked-clean | Real fresh registration/login and encrypted proof-bound approval; no bootstrap token shortcut. |
| 2 | Function authorization | checked-clean | Existing explicit comparison and registration revoke flows retained. |
| 3 | Object authorization / IDOR | checked-clean | Fresh owner broker channel, exact bridge ID row and original owned child/home cleanup. |
| 4 | Input bounds/validation | checked-clean | Reuses unchanged validated pair-link helper; assertions bind actual bridge pointer. |
| 5 | Injection | checked-clean | No new shell/SQL/path construction in repaired spec. |
| 6 | Output encoding/XSS | n.a. | No renderer/HTML change; selectors target existing React UI. |
| 7 | Secrets | checked-clean | No operational private-link logging; unchanged fixed-message helper error handling. |
| 8 | Unsafe deserialization | n.a. | No new decoder in repaired spec. |
| 9 | SSRF | n.a. | No new network target; existing configured test origin only. |
| 10 | Uploads | n.a. | No upload surface. |
| 11 | Rate/abuse | checked-clean for pairing scope | No production rate change; shared-source429 repair remains separately pending. |
| 12 | Errors/leaks | checked-clean | Original failure preserved; fixed cleanup error; no new sensitive dump. |
| 13 | CORS | n.a. | No header/origin policy change in pairing spec. |
| 14 | Headers/CSRF | n.a. | Existing UI/session mutation controls reused unchanged. |
| 15 | Dependencies | n.a. | No package added or upgraded. |

Least privilege: no new grant/token/service identity. The test uses one fresh owner and one task-owned child; helper reuses existing OS-local pairing capability. Root alone remains authorized to execute E2E/CI and manage shared test resources.

Pairing review handoff complete. Report lease released; reviewer stopped writing. Reuse the same reviewer for the concrete fixture/restart STOP-WRITE closure.


## Combined registration/restart closure

**PASS.** Reused the pairing review above and examined the producer's stopped four-file scope: `e2e/helpers/app.ts`, `e2e/helpers/bridge-process.ts`, `e2e/scripts/ci-fixtures.test.mjs` and `.github/workflows/e2e.yml`, plus its evidence report. No confirmed blocker or requested follow-up implementation change.

- Registration's destination guard is an exact string comparison with `http://localhost:3000` before fetch (`app.ts:47-51`). It rejects non-test email domains and oversized/malformed normalized identities before transmitting credentials or a fixture source header. The SHA-256-derived96-bit suffix produces a valid eight-group IPv6 documentation-range `2001:db8` address; normalized same-user inputs and separate helper instances retain the same key (`:52-57`). Different fixture users model separate proxied test clients through the existing real `clientIp` x-real-ip path. This is bounded test isolation, not a new production authorization/rate-limit mechanism. The actual extractor returns nonempty x-real-ip at `client-ip.ts:15-16` before considering x-forwarded-for at `:18-22`, so a Next-added loopback forwarded header cannot override this source. Fly-Client-Ip has higher priority, but the guarded destination is the direct localhost UI without that proxy. The VM loads the real extractor; its request mock does not independently synthesize Next forwarding headers, so this priority conclusion is based on the inspected production branch order.
- The actual production route still checks/records its client-IP quota and registration limit remains10 attempts/hour (`ui/src/app/api/auth/register/route.ts:71-80`, `ui/src/lib/login-rate-limit.ts:23-26`). The helper still performs the real HTTP POST with the original email/password body and propagates non-2xx, including429. No limiter reset/increase, retry, sleep, seeded-user bypass or success masking was added. The two startup users remain in their existing common source bucket.
- Restart uses `resolve(e2eDir, ..)` and an absolute `bridge/dist/index.js` argument (`bridge-process.ts:92,117-122`), matching both unchanged strict Linux cleanup argv guards (`stop-services.sh:23,50-55`). HOME, USERPROFILE and FTOWN_DATA_DIR override inherited selectors to the same task-owned bridge home. Exact old-PID handling, new-PID write, matching new pointer then broker-presence ordering remain intact (`:95-109,129-142`). Cleanup identity validation was not relaxed and no broad process matching was added.
- The pure Node regression transpiles and executes the actual helper functions with allowlisted mocked dependencies, real client-IP extraction and fake fetch/process/spawn/filesystem. It starts no child, server, socket, browser or database. Tests require11 distinct logical registration sources, same normalized identity's11th429, cross-instance stability, malformed/remote target rejection before fetch, real request shape, and exact restart argv/environment/PID/readiness (`ci-fixtures.test.mjs:47-114`). Its modeled quota is explicitly labeled and is not claimed as proof of PostgreSQL limiter behavior. The old-source RED cases distinguish the targeted defects rather than simply mirroring the new hash algorithm.
- Workflow line73 invokes the pure test after UI npmci and npm test, with the already installed UI TypeScript compiler; Node24.22.1 is selected at line18 and E2E dependencies were installed earlier. The VM's configuration/import stubs avoid real environment/service side effects. No package or new framework is required. Existing full Playwright, strict cleanup and artifact gates remain. New unit failures contain only deterministic fake credentials/bootstrap placeholders; no real private enrollment link/token/environment dump was introduced. Existing HTTP error-body behavior is unchanged and only the canonical task-local server is eligible for fixture registration.

Least privilege remains unchanged: no production IAM/DB/OAuth scope/secret, no new trusted production header rule, and no expanded process cleanup authority. All four implementation paths are E2E/helper/workflow scope; the reviewed production registration/rate-limit code remains intact. Root/integration owner retains final Git scope checks; this reviewer performed no Git command.

Reused producer evidence on supported local Node24.22.1: actual-helper VM regressions OLD1 PASS/3 FAIL → NEW4 PASS/0 FAIL; repeated-user11th429 remains blocked in both. Strict E2E TypeScript and whitespace/final-newline checks pass. These pure checks prove fixture boundaries, not full runtime recovery. Root must run the repaired pairing lifecycle, later push registrations/business assertions, resurrection, and successful exact-PID/session/home cleanup through existing full CI. No full CI pass is claimed from static/unit evidence.

Final combined review handoff complete. Only this report was amended by the reviewer; no application/test execution or implementation occurred. Exclusive report lease released; reviewer stopped writing.
