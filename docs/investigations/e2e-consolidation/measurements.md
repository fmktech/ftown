# E2E consolidation measurements

## Outcome
Browser execution meets the 300-second target in the measured passing run: **235.645 seconds**, versus **367.509 seconds** before consolidation (35.9% shorter). **The full validation script does not meet the target: 406.02 seconds.** GitHub queue and outer VM/artifact orchestration are excluded, so this is not a complete GitHub job timing.

| Run | Browser seconds | Passed / skipped / failed | Script seconds |
| --- | ---: | --- | ---: |
| Baseline 73c67cc | 367.509 | 74 / 2 / 0 | 795.35 |
| Final task changes | 235.645 | 71 / 2 / 0 | 406.02 |

Both passing runs have zero unexpected failures, flaky cases, or retries. Three duplicate executions were removed; the same two pre-existing skips remain. Coverage ownership is recorded in the independent review reports. Worker counts remain two globally and one for shared tests. No production behavior changed.

## Method and limits
Root alone ran tests on disposable Boat development sandbox bx_nwfdv7h3 (4 vCPU, 8 GiB, Node 24.22.1), using sandbox-local Postgres. Baseline source was 73c67cc. Local Docker was unavailable. Final source was checked against local file hashes. Raw logs, JSON, screenshots and traces are preserved under /tmp/ftown-e2e-consolidation-evidence; final artifacts are in its final/ directory.

Baseline command: `/usr/bin/time -p timeout 1200 bash scripts/ci/run-job.sh e2e`. Final command used the same script under the CI controller's sanitized environment: `env -i HOME=/home/user PATH=<Node24.22.1 and system paths> CI=true GITHUB_WORKSPACE=/home/user/repo GITHUB_RUN_ID=0 GITHUB_RUN_ATTEMPT=1 timeout 1200 bash scripts/ci/run-job.sh e2e`.

The baseline had cold OS, Docker, dependency and browser provisioning; final caches were warm. Baseline also used the default Boat shell environment. Therefore the whole-script reduction is not wholly attributable to code changes, and these single samples are not percentile estimates. Final setup/build/unit checks took approximately 150 seconds before browsers; teardown approximately 20 seconds. This remaining overhead prevents the overall five-minute target.

## Validation
- Final full script exited 0: UI and bridge builds/tests, fixture and runner checks, release checks, database/security/protocol smoke checks, then 71 browser tests passed with two existing skips.
- Standalone strict E2E TypeScript check passed; two existing UI alias mappings resolve previously missing imports without relaxing compiler options.
- Six actual-config fixture guards passed; Playwright lists 73 tests across 21 files.
- Full Chromium execution passed after removing the headless-shell cache, validating `--no-shell` installation.
- Root inspected final mobile approval screenshots: comparison codes and primary approval controls fit; the pending review modal retains its scrollable content. Responsive overflow assertions passed.

## Failed experiments and repairs
Failed runs are not counted as performance successes.

| Experiment | Result | Repair / passing reproduction |
| --- | --- | --- |
| Trust-only consolidation | 71 pass, 2 skip, 1 fail; 199.057s | Immediate post-resize overflow assertion ran before layout settled. Preserve exact predicate with a bounded 2-second poll. Isolated pending scenario passed in 82.270s, no retries. |
| 15-second action budget | 68 pass, 2 skip, 3 fail; 176.177s | Exposed implicit trust-propagation waits in session creation. Explicit bounded readiness checks preserve enabled-button and exact bridge identity; ordinary interactions keep 15 seconds. All three isolated specs passed in 171.188s, no retries. |

One experimental cleanup trap used a relative path after cwd changed; root immediately performed absolute-path service and Compose teardown and verified resource removal. Subsequent operational traps use absolute paths. Mac archive transport introduced AppleDouble metadata; only generated metadata was removed and source hashes/listing verified. Neither incident changed application code.
