# Setup and CLI lifecycle implementation brief

Worker `/root/simplify_all`: explicit `gpt-6.1-sol` / `high`. Shared checkout
`/Users/fkesheh/projects/ftown-simplify-all`, branch `simplify/setup-cli-lifecycle`,
base `origin/main` at `f202f98ac782505394777567047a044b2ad9acf9` (bridge 0.19.40).
Read current bridge AGENTS and RTK instructions. The prior task's local
`docs/investigations/simplify-agent-surface/coordination.md` modification is
preserved and excluded from this task's staging. Discovery only; no installs,
implementation, listeners, E2E or real-HOME changes.

## Discovery and contract refinements

Semble located startup integration blocks in `index.ts:624` and `index.ts:723`.
Those currently run after local listener/auth initialization. Readiness must be
checked at the start action, before `resolveDefaultDataDir()` at line 131 (which
can migrate legacy data), bridge-id writes, local API binding, solo downloads
and authentication. Help and local management command help remain usable.

`ftown setup` is bootstrapped directly through the package bin, e.g.
`npm exec --yes --package ftown-bridge -- ftown setup`. It owns CLI runtime,
notify/Pi assets, Claude/Cursor hooks, available Codex/opencode/Muse integrations,
ftown skill, short guide, PATH and cleanup migrations. `ftown setup --repair`
reruns safe installation and migration checks. A successful version marker is
written atomically only after required setup succeeds. Missing optional binaries
are reported as skipped; available integrations that fail are reported as failure
so an interrupted/partial setup remains retryable. Repair discovers newly
installed optional integrations. Existing hook installers swallow errors; their
returns must become explicit success/failure without disturbing merge behavior.

Separate state fields: `packageVersion` determines readiness; durable migration
IDs (factory/loops and bundled ticket/workflow retirement) determine cleanup
completion. Once completed, ordinary setup at the same version is a no-op;
upgrade setup installs the new version and runs only pending migration IDs.
Repair deliberately reruns migrations. Conservative skipped custom assets count
as a successfully inspected migration; actual I/O failures must not be recorded
as success. Existing cleanup currently catches both cases, so error handling
needs the smallest distinction required for accurate migration status.

Codex workdir trust is performed inside `createFtownSession` for the specific
requested repository; preserve that runtime behavior. It cannot be prepared for
all future directories at machine setup. Preserve explicitly supplied user env,
including an inert `FTOWN_ORCHESTRATOR`; stop all ftown injection/interpretation.

Canonical CLI command bodies move into import-safe modules. `ftown-cli` calls
them in process; legacy binaries only delegate to the same dispatcher. Share
pointer loading, local HTTP error handling, session lookup and mail requests in
one client; preserve each command group's syntax/output rather than redesigning
transport. Harness creates a fresh Commander per invocation. Imports must not
parse argv, exit, read pointer files or snapshot HOME. Main entry guards remain
symlink-safe; only executable entry code sets process exit status.

Copy one explicit runtime module inventory plus commander and bundled setup
assets into a stable per-user runtime. Setup from that runtime must survive
removal of the original npx cache, including later repair. Avoid self-copy when
repair's source and destination are identical. Retain stable old launcher and
hook paths; their scripts exec the canonical Node entry with a fixed group.
No child Node CLI is spawned by the canonical command. Setup may still invoke
native Muse integration commands, as it does today.

Orchestrator removal spans `create-ftown-session`, RPC, shared request types,
MCP/Pi schemas/producers, UI `useSessions`, modal guidance, and mail-window
participation. Parent/child and mail history retain their existing behavior.
Recommend ignored legacy CLI/API booleans rather than rejection: omit active
help, mark any retained schema/type compatibility input deprecated/ignored,
never forward it into ordinary create logic. The UI already offers only an
orchestrator hint, not an active toggle; remove that hint.

UI onboarding currently copies only `npx ... ftown-bridge` and landing copy says
startup installs the CLI. Update those instructions to explicitly run package
setup before the bridge. Existing E2E startup script also needs setup in its
already-disposable HOME before starting the bridge.

## Proposed exact application ownership

One application writer and integration/landing owner: this worker. Root owns
`coordination.md` and all E2E/server resources; reviewer owns `review.md` only.
Dependency/lock/build/Git operations remain serialized under worker until handoff.

Modify:

```
README.md
bridge/AGENTS.md
bridge/package.json
bridge/package-lock.json
bridge/src/index.ts
bridge/src/bridge-cli.test.ts
bridge/src/ftown-cli.ts
bridge/src/ftown-cli.test.ts
bridge/src/ftown-sessions-cli.ts
bridge/src/ftown-env-cli.ts
bridge/src/ftown-env-cli.test.ts
bridge/src/harness-cli.ts
bridge/src/install-ftown-command-cli.ts
bridge/src/install-ftown-command-cli.test.ts
bridge/src/harness-installer.ts
bridge/src/harness-installer.test.ts
bridge/src/install-notify-script.ts
bridge/src/hook-installer.ts
bridge/src/cursor-hook-installer.ts
bridge/src/codex-installer.ts
bridge/src/codex-installer.test.ts
bridge/src/opencode-plugin-installer.ts
bridge/src/ensure-ftown-path.ts
bridge/src/install-ftown-skill.ts
bridge/src/install-ftown-skill.test.ts
bridge/src/create-ftown-session.ts
bridge/src/create-ftown-session.test.ts
bridge/src/command-rpc.ts
bridge/src/command-rpc.test.ts
bridge/src/types.ts
bridge/src/mail-delivery.ts
bridge/src/mail-delivery.test.ts
bridge/src/mcp/server.ts
bridge/src/mcp/mcp.test.ts
bridge/src/pi-extension.test.ts
bridge/src/orchestration-coordination-contract.test.ts
bridge/src/wire-types.ts
bridge/src/harness-registry.ts
bridge/pi-extension/ftown.js
bridge/pi-extension/API.md
bridge/skills/ftown/SKILL.md
bridge/skills/ftown/references/sessions.md
bridge/skills/ftown/references/orchestrator.md
ui/src/types.ts
ui/src/hooks/useSessions.ts
ui/src/hooks/useSessions.test.ts
ui/src/components/NewSessionModal.tsx
ui/src/components/Dashboard.tsx
ui/src/app/page.tsx
docs/automation-sunset.md
e2e/scripts/start-services.sh
e2e/README.md
```

Delete obsolete sibling installers/tests (central installer replaces them):

```
bridge/src/install-ftown-cli.ts
bridge/src/install-ftown-cli.test.ts
bridge/src/install-ftown-env-cli.ts
```

Add:

```
bridge/src/install-notify-script.test.ts
bridge/src/hook-installer.test.ts
bridge/src/cursor-hook-installer.test.ts
bridge/src/cli-entry.ts
bridge/src/cli-client.ts
bridge/src/cli-client.test.ts
bridge/src/sessions-commands.ts
bridge/src/harness-commands.ts
bridge/src/env-commands.ts
bridge/src/setup.ts
bridge/src/setup.test.ts
bridge/src/setup-state.ts
bridge/src/setup-state.test.ts
bridge/src/setup-migrations.ts
bridge/src/setup-migrations.test.ts
docs/investigations/setup-cli-lifecycle/worker.md
docs/investigations/setup-cli-lifecycle/smoke.mjs
```

Generated resources only: `bridge/node_modules/`, `bridge/dist/`,
`ui/node_modules/`, `ui/.next/`. Root owns runtime evidence files it creates.
No change to prior task artifacts, cloud auth/storage, solo infrastructure,
session lifecycle or API protocol. Additional files require architect approval.

## Exports and dependency direction

- `cli-entry`: symlink-safe `isCliEntry` and common exit/error boundary.
- `cli-client`: lazy pointer/path loading, injected-fetch-capable API client,
  shared session lookup/list/inbox send/read helpers; depends on wire types only.
- `sessions-commands`, `harness-commands`, `env-commands`: explicit argv-taking
  runners; no import side effects. Legacy entry files delegate to `runFtown`.
- `ftown-cli`: `runFtown(argv): Promise<number>` routes in process and setup;
  executable guard applies exit status. No sibling executable spawning.
- `setup-state`: package-version readiness inspection and atomic success state.
- `setup-migrations`: stable migration IDs, pending selection/repair and progress
  persistence only after successful cleanup; uses conservative retirement helpers.
- `setup`: explicit install sequence, optional integration skips/failures,
  `--repair`, stable runtime asset source resolution. Does not import bridge main.
- Central installer: one runtime/module/asset inventory and compatible delegates.
- `index`: read-only setup gate, stable runtime paths for notify/harness pointer,
  then existing runtime startup. No global setup/retirement calls.

## Verification plan

Worker pure/static checks: shared client behavior with injected fetch; repeated
in-process argv routing/import safety; fresh Commander invocations; legacy
orchestrator inputs yield identical ordinary task/parent/env behavior; optional
integration outcomes; migration once/upgrade/repair/retry and failure-marker
semantics; conservative custom/symlink/data preservation; runtime inventory
copying and stable cache independence. Required bridge build and UI type/build
checks, relevant pure suites, diff checks. No listener-backed tests by worker.

Root smoke: sanitized temporary HOME and no cloud/database selectors. First test
missing/outdated gate leaves no bridge data/listeners/integration changes. Run
explicit package-entry setup; start real local-only bridge with task data dir;
canonical and legacy commands operate on it, old orchestrator options do not
alter session behavior. Snapshot global integration contents/mtimes before and
after two starts. Check current setup no-op, version upgrade migration selection,
repair/retry and custom data preservation. Copy package fixture then remove its
original source/cache and verify installed command + repair still work. Root
also owns UI runtime/render review, full suites and process cleanup. No need to
start native harness agents: ordinary shell/fake commands suffice.

Status: application implementation complete; source writes stopped for independent review and root runtime verification.


## Approved manifest amendments

Architect approved these additional exclusive files after concrete review/audit:
`bridge/src/muse-plugin-installer.ts`, `bridge/src/muse-plugin-installer.test.ts`
(disabled integration drift), `bridge/src/ftown-home.ts`,
`bridge/src/ftown-home.test.ts` (read-only runtime vs explicit legacy migration),
`docker/solo/Dockerfile`, `docker/solo/README.md`, `docker/solo/compose.yml`,
`docs/solo.md`, `docs/local-browser.md` (existing startup onboarding). No other
worker owns these paths. UI resources released to root after final UI build.

## Implementation and worker verification

- Explicit setup owns all integration writes and stable migration IDs. Ordinary
  startup is gated before legacy migration/data identity/auth/listeners and only
  performs ordinary runtime state writes. Complete read-only readiness inventory
  covers command modules, dependencies, aliases, guide and durable repair assets.
- One self-contained copied CLI runtime dispatches all groups in process. Legacy
  entries/launchers delegate; pointer/session/mail client and entry handling are
  shared, lazy and import safe. Stable runtime repair survives lost package cache.
- Setup state is atomic and invalidated before work, required failures remain
  retryable, successful migration progress survives failures/upgrades. Setup lock
  publishes a complete owner directory atomically, preserves active/unknown owners,
  and reclaims only an exact marker for a provably dead PID. Older cached packages
  cannot overwrite a newer installed runtime. Optional missing/user-disabled
  integrations are intentional skips; disabled Muse drift never mutates approval.
- Removed effective orchestrator role prompt/env/mail-window behavior and UI hint.
  Deprecated compatibility inputs are inert. Parent/task/briefing suppression and
  explicit user env remain intact.
- Bridge version 0.19.41 with synchronized lock. Central runtime inventory and
  Docker image pin align with it. Docker runs setup once during image build before
  volume initialization; existing-volume upgrades use the NEW image package's
  explicit Node entrypoint. Building the Docker image awaits npm publication of
  0.19.41; no publish or Docker runtime was attempted here.
- Bridge clean build PASS. Focused pure/unit run **171 passed, 0 failed, 42 suites**.
  After the final lock-marker validation, the two directly affected setup/state
  suites passed **7/7**; final clean build passed again. No worker listener/E2E run.
- UI `npm ci` and production build PASS with dummy build-only auth/hub secrets;
  existing dependency Edge/metadata warnings remain. Applied the Vercel React
  best-practices checklist to the bounded copy/hint edits; no hook/dataflow changes.
  Root independently reports full UI suite **282/282** and landing render PASS.
- Diff whitespace and smoke syntax checks PASS. Dependency audits report existing
  bridge/UI advisories; dependency versions were not changed by this task.

## Root runtime handoff

Run from repository root after inspecting isolation:

```
rtk proxy node docs/investigations/setup-cli-lifecycle/smoke.mjs
```

Worker has not executed it. It uses one disposable HOME/work directory and a PATH
containing ONLY task-owned symlinks to Node/bash/sh. No production, cloud or DB
selectors are inherited; optional native harness binaries/tmux cannot be found.
It runs the actual package-bin setup in a disposable package cache, verifies
current/upgrade/repair/failure-retry and stale-version handling, removes the source
cache and exercises durable installed repair, then starts the real bridge only in
`--local` mode. Session test commands are explicit `/bin/cat`, not native agents.
It exercises canonical and compatible commands, mail and ordinary child behavior,
and snapshots global integration file contents/mtimes across two normal starts.
Finally it removes only its owned sessions, stops its bridge/process group and
removes temporary files. Root owns any execution logs and additional validation.

All application and build writes stopped. Bridge/UI build/dependency resource
leases released to root for full suites/runtime checks. Git landing lease retained
pending acceptance. No worker-owned process, listener, server or DB exists. The
prior task's local coordination change remains preserved and must not be staged.


## Final documentation closure

Root's real local-only smoke passed all cases, including two ordinary starts with
unchanged global integration hashes/mtimes. Reviewer identified copied-runtime
upgrade wording: README, skill and related setup instructions now explicitly use
the matching new package's versioned npm entrypoint for upgrades. Installed
`ftown setup --repair` repairs the current copied version and does not discover
new npm versions. Documentation-only closure; no application/build changes or
repeat test runs.


## 2026-10-17: preexisting Muse test stdin race investigation

Root observed full suite 776 pass / 1 failure / 4 skips: EPIPE at unchanged
`muse-plugin.test.ts:121` while testing silent exit with no FTOWN_SESSION_ID.
The isolated unchanged suite passed 11/11 on root retry. Architect granted this
one test-harness file; investigation evidence stays in this approved report.

- H1 (test/stream layer), PROVEN: child early exit closes stdin before the helper's
  write finishes; its error event has no listener and bypasses the execFile
  promise catch. A listener-free 262144-byte probe using the exact helper pattern
  produced `{"command":"exit 0","exit":0,"stdoutBytes":0,"uncaught":["EPIPE"]}`.
- H2 (plugin/config layer), REJECTED: plugin setup/role changes make the hook fail.
  The same failure reproduces with `/bin/sh -c 'exit 0'`, no plugin or FTown env.
- H3 (process layer), REJECTED: EPIPE means the child itself failed. The probe
  confirms exit0 while EPIPE occurs. An independent `exit 7` remains exit7 with
  EPIPE; child status is a separate signal that must stay authoritative.

Falsification: replace early exit with `cat` using identical payload/pipe setup.
Result: `{"command":"cat","exit":0,"stdoutBytes":262144,"uncaught":[]}`.
H1 survives isolation and absence checks. Hook source confirms both wrappers
intentionally exit0 before reading stdin when FTOWN_SESSION_ID is absent.

5 Whys: test fails because stdin emits unhandled EPIPE; that happens because
intentional early exit need not consume queued input; the helper only catches
child execution promise failures; child completion and stdin stream completion
were treated as one signal; fixture design omitted the valid early-exit/closed-
input case. Fix belongs at the test process boundary, not plugin behavior.

Planned regression: deterministic large stdin with exit0 must succeed, and exit7
must remain failure. Attach stdin error handling before writing; ignore only
expected EPIPE, preserve every other stream error and actual child status.


Resolution: added two deterministic large-input regressions before changing the
helper. Filtered listener-free test run failed 2/3 with exact `Error: write EPIPE`
on both exit0 and exit7 fixtures. The helper now registers a stdin error listener
before `.end`, ignores only EPIPE, preserves other stream errors, and still awaits
execFile for authoritative child status. The same filtered command now passes
3/3, including complete stdin delivery to cat and preserved exit7. No product
plugin code changed; no listener-backed suite or E2E was worker-executed. Root
owns independent Muse/full-suite reruns. Additional test-file ownership was
explicitly granted by architect; application/runtime validation remains valid.

```
rtk proxy node --import tsx --test --test-name-pattern='muse process fixture' src/muse-plugin.test.ts
```


## Accepted landing gate

Root final evidence: clean bridge build and full suite **779 passed, 4 skipped,
0 failed**; UI build and **282/282** tests plus rendered onboarding; real
local-only smoke with two unchanged global integration snapshots; package
inventory **261 files at 0.19.41**; independent review accepted. Docker image
build remains unexecuted pending publication of the pinned npm version.
Fresh origin/main has no divergence and remains 0.19.40. Mechanical final scope
check passes for 78 selected source/evidence paths. Raw logs and the prior task's
local coordination edit are excluded. No owned processes or runtime resources.
