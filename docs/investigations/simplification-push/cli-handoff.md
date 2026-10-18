# CLI/release/installation handoff

Worker `/root/npx_implementation`, explicitly `gpt-6.1-sol` / `high`, integration
owner. Shared checkout `/Users/fkesheh/projects/ftown-simplify-all`; branch
`feat/simplify-cli-release-and-notifications` from main
`957d90bbd265b90d60f54848a26a13a74722ccca`. Exact file scope is ownership.json;
four previously dirty investigation notes were preserved throughout.

## Result

- Release helpers moved from bridge/scripts to scripts/release. Shared
  package-change classification gates both version enforcement and automatic
  publication; shipped assets/build inputs remain covered, while tests/agent
  docs/external release tooling avoid package version/publication requirements.
  Dedicated PR artifact checks include external tooling changes. Existing npm
  schemas, immutable source/version/tag checks and visibility deadline retained.
- installation-manifest.ts drives copied directories, compatibility launchers
  and mandatory readiness paths. Installer copies full compiled dist/assets and
  original package metadata, then production dependencies with their native
  assets; generated installation.json records the copied file closure for
  read-only readiness checks. Existing locks/downgrade/setup-state safeguards
  remain; foreign/dangling source/target symlinks and incomplete runtime fail.
- Dependency planner preserves actual resolved versions across package-local,
  outer-hoisted, nested and scoped layouts. It reserves direct slots first and
  shadows conflicting outer versions beneath requesters. Optional missing
  packages are allowed; required dependencies fail clearly. Unrelated dev
  packages are not traversed/copied. No runtime npm/network invocation.
- Sessions uses Commander help/parsing with unchanged runSessions(argv) entry.
  Legacy commands/aliases/flags, payloads and output defaults retained;
  --orchestrator remains a no-op. Help/invalid input returns before transport.
  Bounded RED/GREEN proof is in 2026-10-18-sessions-help.md.
- Single package/lock patch bump to 0.19.45 after peers froze bridge source.
  Fresh fetch still main957d90; npm latest was0.19.44, no version collision.

## Evidence

- Combined `npm run build` in bridge: passed after canonical start and notifier
  bridge writers froze. Complete new dist is available to root.
- Focused unit command (`node --import tsx --test` with installation-manifest,
  production-dependencies, install-ftown-command-cli, setup-state, setup and
  sessions-commands test files): 19/19 passed.
- `node --test scripts/release/publish-packages.test.mjs scripts/release/package-changes.test.mjs`:
  16/16 passed on local npm11.6.2 and isolated Node24.15.0/npm12.2.0, including
  actual extracted artifact/file-mode/manifest parity apart from package name.
- Actual repository production graph copied4717 files into an isolated temp
  target and was cleaned; no application runtime or network was started.
- Independent startup reviewer caught root-local/outer dependency collision;
  added effective require-resolution regression and repaired context placement.
  Reviewer also caught --orchestrator parity; flag and payload regression added.
- `git diff --check`: passed. No E2E/servers/manual CI/npm publication were run
  by this worker. Root owns full bridge suite, CLI startup and browser checks.

Implementation writes stopped and bridge dependency/build/dist leases released
to root for integrated runtime gates. Git/index lease is idle pending root
landing authorization; no commit/push yet. Existing authors retain repair
ownership through root. No known unresolved implementation findings.

Review follow-up: missing tell fanout message validation moved before target
resolution. New stub regression RED (three GETs) → GREEN (zero transport),
parser5/5 passed and combined bridge build passed again at unchanged0.19.45.
Root's prior full bridge suite passed796 with4skips; it owns remaining runtime
smoke/browser checks. No broad suite was repeated by this worker. Source writes
stopped and renewed bridge build/dist lease released immediately after repair.

Root accepted all final gates: bridge797passed/4skipped, UI307passed, both
builds, release checks16/16 on npm11/12, cache-independent real CLI smoke,
focused browser notifications2/2 and rendered control review. Provider/OS
boundaries were simulated and full Solo downloads were not tested; validation.md
records these limits and cleanup. All five independent findings are closed.
Root authorized integration commit/push/PR, with no merge or production change.
Fresh origin/main still957d90, ancestor of this branch; no conflict or version
collision appeared. Only the frozen task allowlist is staged; four unrelated
dirty notes remain excluded. Final PR/lease retirement state follows landing.
