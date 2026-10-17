# Implementation handoff

## Setup and discovery

- Worker: `/root/simplify_all`, explicitly `gpt-6.1-sol` / `high`.
- Shared checkout: `/Users/fkesheh/projects/ftown-simplify-all`.
- Branch: `simplify/ftown-agent-surface`; base `origin/main` at `4f6811c215865c839f9b6a9f3e277346bbde4b74`.
- Original dirty checkout preserved. Read `bridge/AGENTS.md` and `/Users/fkesheh/.codex/RTK.md`. Semble CLI located startup installer, briefing, generated guide, skill and workflow surfaces; literal occurrence scans checked dependent references.
- No implementation, install, runtime, E2E or CI execution yet.

## Proposed exclusive writable manifest

Integration/landing owner is this worker. Root owns `coordination.md`; reviewer owns `review.md`. All implementation is serialized under this worker, including build output, dependency installation and Git mutations.

Modify:

```
README.md
bridge/AGENTS.md
bridge/package.json
bridge/package-lock.json
bridge/src/index.ts
bridge/src/ftown-cli.ts
bridge/src/ftown-cli.test.ts
bridge/src/ftown-env-cli.ts
bridge/src/ftown-env-cli.test.ts
bridge/src/ftown-sessions-cli.ts
bridge/src/harness-cli.ts
bridge/src/create-ftown-session.ts
bridge/src/create-ftown-session.test.ts
bridge/src/harness-installer.ts
bridge/src/harness-installer.test.ts
bridge/src/install-ftown-skill.ts
bridge/src/install-ftown-skill.test.ts
bridge/src/retired-skill-assets.ts
bridge/src/orchestration-coordination-contract.test.ts
bridge/src/harness-registry.ts
bridge/src/harness-registry.test.ts
bridge/src/ftown-home.ts
bridge/src/provider-env-store.ts
bridge/src/provider-env-store.test.ts
bridge/src/mail-delivery.ts
bridge/src/mail-delivery.test.ts
bridge/skills/ftown/SKILL.md
bridge/skills/ftown/references/sessions.md
bridge/skills/ftown/references/orchestrator.md
docs/automation-sunset.md
```

Delete:

```
bridge/skills/fticket/                         (entire bundled directory)
bridge/skills/ftown/references/workflows.md
bridge/skills/ftown/scripts/example.flow.mjs
bridge/src/workflow-runner.ts
bridge/src/workflow-runner.test.ts
bridge/src/workflow-runner-cli.ts
bridge/src/install-ftown-workflows-cli.ts
bridge/src/install-ftown-workflows-cli.test.ts
bridge/src/claude-trust.ts
bridge/src/claude-trust.test.ts
```

Add/update task-owned evidence:

```
docs/investigations/simplify-agent-surface/worker.md
docs/investigations/simplify-agent-surface/smoke.mjs
```

Generated resources: `bridge/node_modules/` and `bridge/dist/` only; no tracked additions from either. No UI, transport, hook implementation, Pi/plugin command alias, historical investigation or CI-workflow changes.

## Architecture and risk notes

- Startup unconditionally installs bundled fticket and workflows. Remove both feature paths and package bin routing. Workflow-only Claude trust helper and harness-registry workflow metadata have no surviving callers and should be deleted.
- Existing ownership-manifest skill removal unlinks canonical agent links even when the canonical tree is customized. New retirement path must preserve links to customized surviving trees; only remove exact owned trees/links. Preserve independent absolute/foreign skill links and symlink parents.
- Prior workflow files have no ownership manifest. Recognize only exact shipped file hashes and the exact generated launcher content for the current HOME; preserve unrecognized/custom files, symlinks, shared package marker and all `.ftown/workflows/` run data. Recognize shipped workflow reference/example independently so stale bundled instructions do not survive an upgrade.
- Existing `orchestration-coordination-contract.test.ts` asserts FTS-primary wording that current main's playbook already lacks. Replace this obsolete feature contract with assertions for the new authorized surface; do not restore FTS policy.
- Keep installed nonworkflow launchers and internal hook paths compatible. Canonicalize public help, injected briefing/nudge text, README and skill examples only. No alias/parser redesign.
- `bridge/AGENTS.md` requires a bridge package patch bump with lockfile sync and build. Its live harness status check is handed to root; do not contact the user's running bridge.

## Verification plan

1. Worker: serialized dependency setup, required bridge build, pure unit/static checks for dispatcher rejection, brief/task preservation, guide pointer, ownership cleanup safety and unchanged registry/session/mail behavior. Do not run listener-backed tests or E2E.
2. Worker authors `smoke.mjs`; root executes it. Temporary HOME only; install real built dispatcher and session/harness/env launchers, use a task-owned loopback fake bridge, exercise canonical dispatcher routes and old compatible launchers, reject removed workflow route, verify returned data and task/brief behavior. Smoke owns its temp data/processes and cleans up.
3. Root verifies packaged file list excludes deleted workflow/fticket feature; independent reviewer checks diff, cleanup and command discovery. Landing after root acceptance, focused E2E and required checks.

## State

Implementation complete; application source writes stopped for independent review and root E2E. No worker-owned server or database exists. Build/dependency output lease released to root for validation. Git landing lease retained pending acceptance.

## Implemented and verified

- Removed bundled fticket and workflow CLI/runner/installer/reference/example, unique Claude trust source and workflow registry metadata. Startup safely retires only known shipped assets. Shared installed runtime modules and workflow run data survive.
- Canonical public docs/help/briefings now use grouped commands. Child briefing contains identity/reporting only; task delivery and suppression have direct pure regression coverage. The skill is authoritative, its coordination reference is terse, and the generated guide is a short pointer.
- Bridge version is `0.19.40`, lockfile synchronized. Build now clears dist before compiling, preventing deleted workflow output from leaking into subsequent npm packages.
- `rtk npm ci`: pass. Existing npm audit summary reports one moderate advisory; dependency versions unchanged.
- `rtk npm run build`: pass after final application edits.
- Focused pure unit run: **205 passed, 0 failed, 54 suites**. Command from `bridge/`:

```
rtk proxy node --import tsx --test --test-reporter=spec src/ftown-cli.test.ts src/create-ftown-session.test.ts src/harness-installer.test.ts src/install-ftown-skill.test.ts src/harness-registry.test.ts src/provider-env-store.test.ts src/orchestration-coordination-contract.test.ts src/mail-delivery.test.ts
```

- `rtk git diff --check`: pass. `rtk proxy node --check docs/investigations/simplify-agent-surface/smoke.mjs`: pass.
- Workflow runtime signatures were derived from actual TypeScript program emission of immutable base sources in a disposable temporary ESM package, and matched independent ESM transpile emission. This avoids mistakenly fingerprinting CommonJS output when the shipped bundle is ESM.

## Root-run focused E2E handoff

```
rtk proxy node docs/investigations/simplify-agent-surface/smoke.mjs
```

Worker has **not** executed this script. Inspect it before execution. It creates one temporary HOME, imports only built installer modules, reconstructs immutable old shipped fixtures using read-only `git show` at the fixed base, verifies default managed retirement/custom skill/workflow-data preservation, installs actual compiled launchers and ftown skill, and starts one loopback fixture server on an ephemeral `127.0.0.1` port. CLI child environments contain only the temporary HOME, safe PATH and synthetic session id; production deployment/environment selectors are absent. It exercises canonical help/list/status/env, compatible launchers, exact task argv, screen flag forwarding, removed workflow rejection and nonzero child exit propagation. Finally it closes the fixture, restores in-process HOME values and removes all temporary data.

Boundary: real installed dispatchers and CLI transports against a loopback fixture API; it does not boot the full bridge, cloud services, native harness agents, databases or browser. Root owns full unit-suite/runtime execution, package-content inspection and any additional E2E. No real HOME installer was run by this worker.


## Root smoke follow-up: CLI entry paths

Root's first smoke run passed retirement/installation, then observed exit 0 with
empty output from the installed dispatcher. Both dispatcher and env CLI had a
preexisting entry guard comparing Node's canonical ESM URL with an unnormalized
argv path; macOS `/var` aliases and npm bin symlinks can disagree. Per architect
and reviewer direction, both owned CLIs now compare against `realpathSync(entry)`
with safe false behavior for missing entries. Smoke retains its original
noncanonical temporary path to exercise the actual failure route.

Pure regression checks cover physical paths, symlink parents and npm-bin links
for both CLIs, plus import/missing-entry guards: **32/32 tests pass** across the
dispatcher/env suites. Final clean build passes. No worker E2E execution. Root can
rerun the unchanged smoke route and full bridge suite now; all application writes
and build processes have stopped.


## Landing handoff

Root accepted independent review and all final gates: full bridge suite 772 pass,
4 platform/optional skips, focused installed CLI smoke pass with six fixture
requests, package check 243 files/no retired feature, and read-only harness status.
Fresh origin/main still equals the immutable task base, with bridge version
0.19.39; the task patch version 0.19.40 has no release divergence. All changed
files match frozen ownership. Raw full-suite log stays local; concise reports,
reproducible smoke and package evidence are included in the PR. Worker application
writes have stopped and no task process/database/server is owned.
