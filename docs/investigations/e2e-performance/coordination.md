# E2E performance and concurrency

User request: get latest version, reduce E2E time and make it concurrent. Fetched latest `main` at `acf5a180039d04753f7d79433477b1bcde938a32` and used one shared task checkout on `perf/e2e-concurrency`; preserved both existing dirty checkouts. Root is architect/runtime owner, Terra/xhigh implements and lands, Sol/max independently reviews. Exact ownership and task briefs are in [ownership.json](ownership.json) and [contract.md](contract.md).

## Result and scope

Two Playwright workers overlap four independently owned account-trust/pending-approval cases with a one-worker shared lane. Only those two canonical spec paths enter the isolated project; future/unclassified tests stay serialized. No application code, security cadence, assertion, skip, retry, dependency, CI provider or setup changes. JSON timing output is retained by the existing CI artifact path. README explains combined, isolated and one-worker commands; guard checks enforce the safe classification and browser settings.

| Same sandbox/workload | Browser duration | Passed / existing skips | Reduction |
| --- | ---: | ---: | ---: |
| Original one-worker configuration | 458.785s | 50 / 2 | baseline |
| Concurrent run 1, fresh DB | 241.160s | 50 / 2 | 47.44% |
| Concurrent run 2, fresh DB | 240.537s | 50 / 2 | 47.57% |

Budget <=300s met twice. Both runs retain exactly the same52 normalized test identities and named skips, zero unexpected/flaky outcomes and zero retries. Interval sweeps prove peak2 concurrent test bodies, peak1 shared-project body, and79.200s/78.061s of cross-project overlap. Worker IDs0,1,2 represent sequential process replacement in two slots, not three concurrent workers. Slow security-case durations remain substantially unchanged; overlapping their real waits explains the gain.

## Validation and evidence

- Boat development sandbox `bx_4t4e2was`,4vCPU/8GiB, Node24.22.1, Playwright1.61.1; baseline copied before edits. The two concurrent runs used identical repaired source and a fresh local Compose database/environment each time.
- Pure fixture/config guards6/6, TypeScript `tsc --noEmit`, actual Playwright list52=48shared/fourisolated. Independent review caught an overly broad nested-path matcher; the same implementation worker repaired it to canonical absolute paths, negative cases passed, reviewer closed the finding before optimized runtime.
- Existing unchanged-code CI gates ran once in sandbox: UI701passed and productionbuild; bridge1014passed/fourpreexisting skips and build; browser-trust6/6, original fixture4/4, release17/17, real PostgreSQL pending-approval atomicity and managed Solo security smoke passed. Changed fixture checks reran6/6 after final repair. No need to repeat unchanged application suites.
- Root viewed retained desktop/mobile pending-approval review and Security access-map screenshots: expected controls/content rendered, responsive layout and scrollable mobile workflow preserved. Both full runs include shared IDOR negative controls, bridge restart, encrypted browser/MCP behavior and real revocation.
- New JSON reports omit config/project `use`, `launchOptions` and `env`; only sanitized identities/timing/outcome summaries are committed under [baseline](baseline/). Original reports/logs/screenshots are preserved in local `/tmp/ftown-e2e-performance-20261027/sandbox-evidence.tar.gz` (36,487,705bytes,376members). No production credentials were used or committed.

## Resource safety and completion

Before schema writes, root verified exact task-owned localhost5432/ftown DB selectors, default local Docker context/empty containers, canonical scratch homes, no deployment selectors and ports443/5432/8000/3000/8080/8443/8444. The initial unprivileged443 bind check returned EACCES; read-only socket inspection proved it free before any schema mutation. Repetitions recreated the disposable DB to respect the real IP pairing quota; no limiter rows or thresholds were changed.

All three runs used exact PID-aware stop-services and Compose down-v with exit0. Before each repetition and after the final run, owned ports, containers, volumes, PID records, canonical homes, account temp directories and application node children were absent. Both concurrent UI logs had zero HTTP429 matches. Evidence archive verified locally, then sandbox deleted; Boat list--all returned no sandboxes. No task runtime resources remain. Deliberate failure injection was unnecessary because lifecycle code is unchanged and no unresolved cleanup concern remained.

Latest-main CI baseline was492.030s; three recent successful CI summaries were8.2/8.5/8.8min. Their median workflow was13m23s, maximum27m29s. A separate slow OS-package transfer accounted for795s in the outlier; current evidence does not establish the network cause. Setup/provider/cache changes are deliberately outside this measured optimization. These samples and two concurrent runs do not establish a reliable tail percentile or eliminate every possible race. Automatic PR CI is the remaining external confirmation; no merge or deployment authorized.

Independent source and both-runtime verification accepted with no unresolved findings. Reviewer completed and released its report/resources; native completion retires it. Implementation worker released all source leases and is the sole landing owner for normal-hook commit, push and PR creation; final Git/resource handoff is retained in the native task and PR. Root stops editing tracked artifacts during landing and remains sole automatic-CI monitor.
