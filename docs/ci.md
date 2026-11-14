# CI validation

The five secret-free validation jobs use the fixed entry point `scripts/ci/run-job.sh`: `e2e`, `release-artifacts`, `gitleaks`, `bridge-version`, and `centrifugo`. Their existing workflow events, job IDs and release matrix remain in GitHub Actions.

## Default: GitHub-hosted runners

This is a public repository, so GitHub's standard hosted runners are free. By default (`CI_RUNNER` unset or `local`) every job — internal PRs, fork and Dependabot PRs, pushes and dispatches — runs its payload directly on the `ubuntu-latest` runner through `.github/actions/run-ci`, with no provider key. The runner image already provides Docker with Compose v2, passwordless sudo and Node 24 (pinned by `actions/setup-node` and verified by `scripts/ci/setup-runtime.sh`); `run-job.sh` installs Playwright's Chromium and its OS dependencies per run, and the e2e suite brings up its own Postgres, Centrifugo and HTTP shim with Docker Compose on the runner. E2E is split into three shards, each running one isolated stack; observed hosted durations are recorded on PR #225 and fit comfortably inside the existing 45-minute job deadline (the full GitHub job limit is 6 hours).

## Opt-in: Agent37

Setting the `CI_RUNNER` repository variable to `agent37` runs trusted jobs on long-lived Agent37 instances instead (`scripts/ci/agent37-runner.mjs`). It requires the `AGENT37_API_KEY` repository secret, which the repository owner must add; no job fails when the secret is absent unless this backend is selected. Instances are reused per job kind (`ftown-ci-unit`, `ftown-ci-e2e-<shard>`), auto-sleep after 300 idle seconds, are given a per-run directory under `~/ci/runs/` plus a remote `flock`, and are never destroyed by CI. The template image under `scripts/ci/agent37/` (Node 24.22.1, Docker/Compose, Playwright Chromium, sshd on port 22022) is built once with `a37 image build scripts/ci/agent37/Dockerfile ftown-ci scripts/ci/agent37`.

## Opt-in: Boat

Setting `CI_RUNNER` to `boat` selects the previous Boat sandbox backend (`scripts/ci/boat-runner.mjs`), which requires the `BOAT_API_KEY` secret (CI-scoped, expires 2027-01-26; rotate before expiry). Each job uses a fresh sandbox named `ci-<job>-<run-id>-<attempt>` (plus the shard for e2e), with account environment and snapshots disabled. If the Boat exec stream ends without an exit frame, the controller fails with the sandbox ID and state: that is a platform failure with no test result, not a test failure — re-run the job and report the sandbox ID if it repeats.

For both opt-in backends, fork and Dependabot PRs always run the hosted payload, the exact checkout revision is archived (history bundled only for Gitleaks and bridge-version), no provider credentials or GitHub token enter the remote environment, and remote run directories or sandboxes are cleaned up on success, failure or cancellation.

E2E retrieves only the fixed Playwright report, test-results, UI/bridge logs and failure infrastructure log; symlink or special-file artifacts are rejected. The workflow uploads them for seven days even after failure. A failed artifact transfer fails an otherwise successful job and cannot hide a test failure. GitHub-hosted publishing, deployment and production migration remain separate and retain their existing permissions and gates.
