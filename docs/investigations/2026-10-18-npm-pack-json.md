---
type: investigation
symptom: "npm release fails at packPackages with TypeError: object is not iterable"
slug: npm-pack-json
date: 2026-10-18T00:25:00Z
git_commit: cf4060fdbf4f76eb7bbe5fd04f618079d67dc2e7
branch: fix/npm-pack-json-output
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

# npm JSON output breaks the release helper

Worker: `/root/npx_implementation`, explicitly selected `gpt-6.1-sol` / `high`.
Shared checkout: `/Users/fkesheh/projects/ftown-simplify-all`. Branch created
from fetched main `cf4060f...` after PR116 merged. Four unrelated modified
investigation/coordination notes preserved. Exact writable scope:
`bridge/scripts/publish-packages.mjs`, its `.test.mjs`, `bridge/package.json`,
`bridge/package-lock.json`, this log, and root-approved new
`.github/workflows/check-bridge-release.yml` (confirmed absent before creation).
Worker owns Git/index, lockfile and build-output leases until handoff. Root
owns E2E/runtime resources and automatic CI monitoring. No worker subagents,
E2E/setup/server/CI runs or live npm publication are authorized.

## Symptom

- Observed: release run `39082348592` fails before publication in artifact
  test `scripts/publish-packages.test.mjs:67`:
  `TypeError: object is not iterable (cannot read property Symbol(Symbol.iterator))`
  at `packPackages`, `scripts/publish-packages.mjs:64:22`.
- Expected: npm artifacts are built, compared and then published in order.
- Delta: JSON array destructuring throws before either package can publish.
  Root reports CI Node `v24.21.0`; the workflow installs npm latest.

## Reproduction

Local npm is `11.6.2`; registry `npm@latest` is `12.2.0`, with engines
`^22.22.2 || ^24.15.0 || >=26.0.0`. Use npm exec to isolate npm and a supported
Node version rather than changing the global toolchain:

```bash
rtk npm exec --yes --package node@24.15.0 --package npm@12.2.0 -- node --test scripts/publish-packages.test.mjs
```

Verified on the unmodified source: 4 passed, artifact parity failed with the
same TypeError at line 64. The same source/build using local npm 11.6.2 passes
all 5 tests. A separate temporary minimal package (only name/version manifest)
reproduces the output-shape difference with `npm pack --ignore-scripts --json`.

## Hypotheses

### H1: npm major-version JSON contracts differ from the helper's assumptions

- Layer: dependency/integration.
- Prediction: npm11 pack returns an array, npm12 pack a non-array; the same
  built source passes with npm11 and fails with npm12.
- Verification: run both CLIs on a minimal package and the actual release tests.
- Evidence (minimal-package probe and test output):

  ```text
  npm --version: 11.6.2
  npm view npm@latest version: 12.2.0
  node=v24.15.0 npm=12.2.0
  pack status=0 array=false keys=ftown-pack-probe
  TypeError: object is not iterable (cannot read property Symbol(Symbol.iterator))
      at packPackages (.../bridge/scripts/publish-packages.mjs:64:22)
  npm11 actual release tests: tests 5 / pass 5 / fail 0
  npm12 actual release tests: tests 5 / pass 4 / fail 1
  ```

- Verdict: PROVEN. Both canonical and repacked npm responses are destructured
  as arrays, while the release workflow deliberately updates npm to latest.

### H2: missing compiled files or differing canonical payload caused the failure

- Layer: tooling/build.
- Prediction: the same build should fail artifact checking with both npm CLIs.
- Verification: run the existing release tests unchanged with local npm11.
- Evidence: `both real npm artifacts have identical files, modes and manifest
  fields except package name` passed; `tests 5`, `pass 5`, `fail 0`.
- Verdict: REJECTED. The same generated package works; failure occurs before
  unpacking or comparing compiled files.

### H3: an absent npm version or registry authorization caused the pack TypeError

- Layer: state/data and transport.
- Prediction: a package with no registry dependency should not reproduce it.
- Verification: pack a temporary minimal local package with scripts disabled.
- Evidence: npm12 pack exits `0` and emits the name-keyed object shown above;
  array destructuring of that successful JSON throws the same TypeError.
- Verdict: REJECTED. Successful local packing alone reproduces the exception;
  no registry lookup or authorization is involved.

## 5 Whys

1. Pack throws because the helper destructures a JSON object as an array.
2. npm12 emits a package-name-keyed result; npm11 emitted a result array.
3. The helper assumed the developer CLI's shape at the external boundary.
4. Its artifact regression ran locally under npm11 but in publishing under latest.
5. Pull request checks did not exercise release artifacts across the supported
   npm boundary, so the first production-equivalent check ran during release.

## Falsification

Absence/isolation check: the same unmodified source and build passes the full
release-helper checks under npm11, while a minimal local-only package packed
under npm12 supplies the non-iterable shape. Thus neither application payload,
registry permissions nor missing output is needed; the boundary-shape cause
survived the counterexamples.

Adjacent boundary check also found npm12 exact-version `npm view --json`
returns a singleton array, whereas npm11 returns a record. Feeding the actual
successful npm12 output into existing `lookupVersion` produces:
`Invalid registry metadata for ftown-bridge@0.19.41`. npm12 E404 remains an
`{"error":{"code":"E404",...}}` object. This same class of assumption would
break same-commit retries/tagging after the initial pack repair.

## Root Cause and fix contract

Normalize only observed npm11/npm12 response shapes at the CLI boundary;
require exactly one matching package/version and a safe expected tarball
filename. Continue failing closed for malformed/ambiguous/unexpected output
and non-E404 registry errors. Accept a singleton view result while validating
its requested package and exact version. Preserve canonical content and
name-only artifact differences.

Add discriminating parser/view tests and run the existing real artifact check
under npm11 and npm12. Add a dedicated PR-only check using npm11 and npm latest
with Node24, build then release tests; no registry auth or publication commands.
Bump patch to `0.19.43` and synchronize lockfile per bridge instructions.

Investigation gate satisfied before the first source mutation. Validation and
resolution evidence will be appended after the bounded implementation.


## Resolution and handoff

Root mechanically validated ownership: six exact worker files above and the
reviewer's sole `docs/investigations/npm-pack-ci-review.md` do not overlap.
No application source or runtime behavior changed beyond the mandated version.

- Added strict `parsePackResult` normalization at both pack invocation sites;
  supported single npm11/npm12 results retain identical packaging behavior.
- Exact-version view accepts one record or one-record array, validating name
  and exact version; E404/error distinctions remain unchanged.
- Regression tests reject ambiguous output, wrong package/version, malformed
  metadata and unsafe/unexpected filenames. Before repair the new view test
  failed with `Invalid registry metadata for ftown@1.2.3`; the existing real
  artifact test failed under npm12 with the exact original TypeError.
- Added PR artifact checks for npm11 and npm latest, matching the publishing
  toolchain before release rather than pinning away the dependency change.
- Synced package and lock versions to `0.19.43`; dependencies/bins unchanged.

Validation:

- `npm run build`: passed.
- Local npm11.6.2 release tests: 7/7 passed, including real packed file/mode/
  manifest parity apart from package name.
- Isolated Node24.15.0/npm12.2.0 exact reproduction command: now 7/7 passed.
- Isolated Node24.15.0/npm@11 (the PR matrix major): 7/7 passed as well.
- Actual npm12 registry output is accepted by repaired `lookupVersion`:

  ```text
  node=v24.15.0
  {"name":"ftown-bridge","version":"0.19.41","gitHead":"c98766de6521464b5247da6bba3af89bc49dcc98"}
  ftown-bridge@0.19.43 absent=true
  ftown@0.19.43 absent=true
  ```

- `git diff --check`: passed. No E2E/runtime setup/server/database, manual CI
  trigger, live npm publish, commit or push was run during implementation.
- Root owns independent review, combined acceptance and any runtime/CI gate.

All implementation file writes stopped and Git/lockfile/build leases released
to root for review. No unassigned file changed; four prior modified notes
remain preserved. Landing is pending explicit root acceptance, with automatic
CI monitoring retained by root.

## Landing handoff

Root accepted the focused reproduction/regression evidence and independent
review with no findings, then granted the worker the sole Git/index lease to
commit/push/open a PR. A fresh origin fetch before landing confirmed main is
still `cf4060fdbf4f76eb7bbe5fd04f618079d67dc2e7` / `0.19.42`, so the `0.19.43`
patch does not collide. Only the six implementation files and reviewer report
are included; all four older modified notes stay outside the commit.

The worker stops after returning the commit SHA and PR URL, releasing every
file/Git/lock/build lease. No merge, npm publication, manual CI trigger or E2E
execution is part of landing. Root owns automatic CI monitoring; this final
handoff is recorded before committing to avoid a later notes-only push.
