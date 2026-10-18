---
type: investigation
symptom: "CI npm ci fails: Missing @emnapi/runtime@1.11.3 from lock file"
slug: ci-lockfile-repair
date: 2026-10-18T02:25:00Z
git_commit: 5c30a796
branch: feat/simplify-cli-release-and-notifications
status: resolved
hypotheses_formed: 3
hypotheses_proven: 1
hypotheses_rejected: 2
---

# Clean-install lockfile portability

Worker `/root/npx_review`, explicitly `gpt-6.1-sol` / `high`, owns only this
note and `ui/package-lock.json`. Shared checkout; preserve other writers and
four existing modified notes. Scratch dependency operations only; shared
node_modules and application/manifests remain frozen. Applying debug skill.

## Symptom and reproduction

CI39089624759 at PR119 head5c30a796 failed before tests:

```text
node: v24.21.0
npm: 11.19.0
npm error code EUSAGE
npm error Missing: @emnapi/runtime@1.11.3 from lock file
```

Read-only run logs establish the exact CI toolchain, correcting the initial
npm12 suspicion. Workflow e2e.yml selects Node24 and runs ui/npm ci. Expected:
clean installation succeeds with the committed manifest/lock on the CI
toolchain. Actual: missing optional graph metadata blocks validation.

Copied only ui/package.json and lock into a task-owned mktemp directory. The
reproduction command (inside an isolated Node/npm runner) is:

```bash
npm ci --ignore-scripts --dry-run --no-audit --no-fund
```

Verified original-lock results:
- Node24.12.0/npm11.6.2: status0.
- Node24.15.0/npm12.2.0: status1, EUSAGE/Missing runtime1.11.3.
- Exact CI Node24.21.0/npm11.19.0: status1, same EUSAGE/Missing runtime1.11.3.

No application/native scripts or shared node_modules are involved.

## Hypotheses

### H1: omitted optional hoisted record fails newer npm graph validation

- Layer: state/dependency integration.
- Prediction: original lock fails newer npm; restoring only its omitted
  resolver-generated record makes the same toolchain pass.
- Verification: inspect graph and regenerate in scratch with npm12
  `install --package-lock-only --ignore-scripts --no-audit --no-fund`.
- Evidence: `node_modules/@emnapi/runtime` is absent, while sharp-wasm32 and
  tailwind WASM dependency ranges require it. npm regeneration adds exactly
  runtime1.11.3, along with unrelated peer-flag normalization. A minimal
  scratch candidate retaining only that generated record yields:

  ```text
  node v24.21.0 / npm11.19.0
  before: status1, npm error Missing: @emnapi/runtime@1.11.3 from lock file
  after: status0, added 220 packages in 4s, lockUnchanged=true
  ```

- Verdict: PROVEN by the one-record counterfactual with unchanged manifest.

### H2: direct manifest dependency versions do not match the lock

- Layer: configuration.
- Prediction: root dependency fields differ and need manifest/version changes.
- Verification/evidence: compare dependencies/devDependencies/optionalDependencies
  against lock packages[""]: `rootDependencyFieldsMatch: true`.
  The one-record counterfactual passes with the same manifest and every prior
  package version/resolved URL/integrity unchanged.
- Verdict: REJECTED. No manifest or package version repair is required.

### H3: Linux native build scripts fail for the chosen package versions

- Layer: platform/build.
- Prediction: failure requires Linux or native script execution.
- Verification/evidence: original lock reproduces the exact EUSAGE on Darwin
  with `--ignore-scripts --dry-run`, before installs/build scripts. The minimal
  repaired graph installs with Linux/x64/glibc targeting and scripts disabled.
- Verdict: REJECTED. This is graph validation, not native execution.

## 5 Whys and falsification

1. npm ci aborts because the optional hoisted runtime record is missing.
2. Earlier npm11.6.2 lock regeneration pruned it although optional consumers
   remain; the original implementation handoff recorded that pruning.
3. npm11.6.2 accepted the incomplete optional graph in local install validation.
4. Local validation did not use the newer CI npm11.19.0 toolchain.
5. Lock portability was inferred from local graph acceptance rather than a
   clean install with the actual CI toolchain.

Falsification: isolate just manifest/lock (no app/native scripts), then restore
only the npm-generated missing record in scratch. Exact CI tooling changes
from fail to pass; every existing entry remains unchanged. Cause survives.
Mitigation is deliberately bounded to omitted metadata; no npm pinning,
dependency update, manifest change or application redesign.

## Repair and regression evidence (before repository lock mutation)

Use only the npm12-generated runtime record, preserving existing entries and
avoiding npm12's unrelated peer-flag rewrites. Its version1.11.3, resolved URL,
integrity, MIT license, optional flag and tslib dependency match the previously
present pre-notification record. The package manager supplied all metadata.

Actual scratch clean installations with the minimal candidate:

| Toolchain | Target | Result |
| --- | --- | --- |
| Node24.21.0 / npm11.19.0 (exact CI) | Linux x64 glibc | 220 packages; exit0; lock unchanged |
| Node24.15.0 / npm12.2.0 | Linux x64 glibc | 220 packages; exit0; lock unchanged |
| Node24.12.0 / npm11.6.2 | native Darwin arm64 | 216 packages; exit0; lock unchanged |

Each used `npm ci --ignore-scripts --no-audit --no-fund`; Linux targeting added
`--os=linux --cpu=x64 --libc=glibc`. This verifies dependency installation and
validation, not Linux execution of native binaries. The exact failing command
is the regression gate; no redundant application test suite is added.

Root owns PR/automatic CI monitoring. No E2E/browser/server/Docker/CI trigger,
Git mutation, production operation or shared dependency installation occurred.

Status: investigation gate satisfied; copy the verified minimal candidate next.


## Resolution and lease handoff

Repository lock now contains exactly ten added lines: the generated optional
hoisted runtime1.11.3 record. Every preexisting byte/entry, version, URL and
integrity remains intact; ui/package.json is unchanged. Copied lock bytes equal
the minimal candidate that passed all three scratch clean installs above.
`git diff --check` passes. No application/full/E2E suite repeated for this
metadata-only repair; root will monitor fresh automatic CI on the repair commit.

Scratch manifest/locks, generated metadata, downloaded install trees and local
probe transcripts were removed after preserving the decisive evidence here.
All file writes stopped; exclusive scratch dependency-resolution/install lease
released. Changed paths: ui/package-lock.json and this note only.
