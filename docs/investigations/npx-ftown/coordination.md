# Short npm setup command

User request: make setup available as `npx ftown setup`.

## Contract (reviewed and frozen)

Keep `bridge/package.json` named `ftown-bridge`, with its existing bins and
dependencies. Publish the same built package under both `ftown` and
`ftown-bridge`; manifests differ only in name and both carry the same version
and source gitHead. Publish ftown first, then ftown-bridge, and tag only after
both succeed. Check exact package versions before the panel release: only an
E404 means absent, other registry failures fail closed, existing same-commit
versions allow retry, and different/missing gitHead fails with version-bump
guidance. An existing release tag must resolve to the intended commit.

Onboarding uses `npx ftown setup`; readiness and upgrade/repair hints retain
the exact version as `npx ftown@VERSION setup`. Runtime behavior stays intact.
Document first-publication and separate npm trusted-publisher prerequisites.
No live npm publication or merge is included in this implementation wave.

Independent pre-implementation review: `/root/npx_review`, explicitly
`gpt-6.1-sol` / `high`, approved this contract. npm currently returns E404 for
ftown and reports ftown-bridge latest 0.19.41. Prior PR115 is merged.

## Ownership and dependencies

Shared checkout: `/Users/fkesheh/projects/ftown-simplify-all`.
One implementation/integration worker `/root/npx_implementation`, explicitly
`gpt-6.1-sol` / `high`, owns exactly:

- `.github/workflows/publish-bridge.yml`
- `bridge/scripts/publish-packages.mjs`
- `bridge/scripts/publish-packages.test.mjs`
- `bridge/src/setup-state.ts`
- `bridge/src/setup-state.test.ts`
- `bridge/package.json`
- `bridge/package-lock.json`
- `bridge/AGENTS.md`
- `bridge/skills/ftown/SKILL.md`
- `bridge/skills/ftown/references/sessions.md`
- `README.md`
- `docs/solo.md`
- `docs/local-browser.md`
- `docs/npm-release.md`
- `docs/investigations/npx-ftown/worker.md`

The reviewer owns only `docs/investigations/npx-ftown/review.md` and otherwise
stays read-only. Root owns this coordination file and E2E execution/evidence.
These exact file lists are disjoint; there are no parent directory leases.
Worker has exclusive Git/lockfile/build-output leases until explicit handoff;
root alone owns runtime smoke, temp HOME/npm-cache/resources and CI monitoring.
No other live implementation workers existed at dispatch.

Preserve three previously modified investigation/coordination notes; exclude
them from the new PR. Use one new branch from current main in this shared
checkout. Do not touch the original dirty `/Users/fkesheh/projects/ftown`.

## Gates and status

Implementation → focused release/state unit checks and build → independent
review → root packed-package npx/setup smoke → commit/push/PR → CI monitoring.
Worker must not run E2E, servers, CI or live npm publish. Git landing happens
only after root accepts review/runtime gates. No recursive worker delegation.

Status: `/root/npx_implementation` dispatched through native spawn with explicit
`gpt-6.1-sol` / `high`; `/root/npx_review` used the same explicit selections.
Root mechanically validated all 17 exact file leases for equality and
parent/child overlap: no collisions.

Implementation branch: `feat/npx-ftown-setup`, base main `c98766d`, version
0.19.42. Build, five release tests (including real package file/mode parity),
four setup-state tests, read-only registry/tag preflight and diff check passed.
Independent review accepted the implementation and corrected release docs.

Root runtime smoke passed fresh setup, repeated/current setup, repair and
installed CLI help for both packed package names using isolated temporary HOME,
USERPROFILE, cwd and npm cache. Canonical package used actual npx executable
inference from `file:/absolute/package.tgz`; compatibility package used its
explicit ftown bin. Each produced setup state version 0.19.42. The initial
bare-path smoke invocation was interpreted by npx as a shell executable; docs
were corrected to the file: package spec and the complete rerun passed.
All temporary HOME/cache/artifacts removed; no database or bridge server used.

Source/review writers stopped; root accepts focused runtime and review gates.
Integration worker may now acquire Git lease to commit/push/open PR. Existing
three modified notes remain excluded. Registry name is not yet published; no
live npm publication was attempted.
