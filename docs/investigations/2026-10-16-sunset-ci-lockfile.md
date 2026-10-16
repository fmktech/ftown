---
type: investigation
symptom: "UI npm ci fails: Missing: @emnapi/runtime@1.11.3 from lock file"
slug: sunset-ci-lockfile
date: 2026-10-16T01:40:00-03:00
investigator: Foad Kesheh (Codex UI worker)
git_commit: 989baa45fb5eb28a79cc93824fde21573a53ca92
branch: feat/sunset-factory-cron
repository: fmktech/ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

# UI clean install rejects the sunset lockfile

## Symptom

- **Observed**: PR #112 CI run [38851248086](https://github.com/fmktech/ftown/actions/runs/38851248086), `direct-transport-e2e / Build UI`, fails before build/tests:
  ```text
  npm error code EUSAGE
  npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.
  npm error Missing: @emnapi/runtime@1.11.3 from lock file
  ```
- **Expected**: The existing CI clean-install gate accepts the committed manifest/lockfile, then builds and tests the UI.
- **Delta**: Installed-tree unit/type/build checks passed locally, but clean installation rejects lockfile dependency closure.

## Reproduction

CI setup log reports `node: v24.21.0` and `npm: 11.19.0`. Local defaults are Node v24.12.0/npm 11.6.2; exact CI versions will be invoked through npm exec. A disposable directory containing only copies of `ui/package.json` and `ui/package-lock.json` isolates the manifest/lock from existing node_modules and the application checkout. No runtime, database, browser or CI rerun is involved.

## Hypotheses

#### H1: The root lockfile dependency ranges disagree with package.json after dependency removal

- **Layer**: state-data
- **Prediction**: Comparing package.json dependencies with packages[""].dependencies finds a mismatch.
- **Verification method**: Parse both committed JSON files before modifying either.
- **Evidence**:
  ```text
  direct dependencies match: True
  dev dependencies match: True
  ```
- **Verdict**: REJECTED
- **Rationale**: All direct dependency ranges match; the missing entry is deeper in the transitive graph.

#### H2: A Linux native install script or platform-specific binary causes the failure

- **Layer**: config-env / dependency
- **Prediction**: The error disappears when testing the exact CI npm/Node on the local host with install scripts disabled.
- **Verification method**: Run clean npm ci in a disposable manifest-only directory using CI versions and --ignore-scripts.
- **Evidence**:
  ```text
  v24.21.0
  11.19.0
  npm error code EUSAGE
  npm error Missing: @emnapi/runtime@1.11.3 from lock file
  ```
  This repeats on macOS with `npm ci --ignore-scripts --no-audit --no-fund` and no application files or installed dependencies.
- **Verdict**: REJECTED
- **Rationale**: The failure precedes installation/scripts and reproduces away from Linux, ruling out native build scripts and Linux binaries.

#### H3: The committed lockfile is missing a required optional transitive runtime entry

- **Layer**: tooling-build / state-data
- **Prediction**: Exact-version npm ci reproduces EUSAGE without any application code; regenerating only lock metadata restores the runtime entry and makes the same clean install pass without upgrading existing package versions.
- **Verification method**: Original-vs-regenerated lockfile clean-install experiment in a disposable directory, then structural package/version diff.
- **Evidence**:
  ```text
  top-level @emnapi/runtime entry: None
  ```
  ui/package-lock.json contains transitive requirements on @emnapi/runtime at lines 780, 912, 1373, 1673 and 1722.
  Exact CI-version `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` in the disposable directory generates the missing entry. It makes no package version changes, but normalizes unrelated peer flags on 26 existing entries. A minimized experiment keeps every original entry byte-for-byte and adds only the npm-generated runtime entry:
  ```text
  added: ['node_modules/@emnapi/runtime']
  removed: []
  version changes: []
  minimal experiment: original lock plus npm-generated node_modules/@emnapi/runtime only
  added 203 packages in 10s
  ```
  The same minimal lock also passes exact-version `npm ci --ignore-scripts --no-audit --no-fund --os=linux --cpu=x64`:
  ```text
  added 208 packages in 19s
  ```
- **Verdict**: PROVEN
- **Rationale**: Only the missing record is necessary and sufficient for the failure; neither application code nor existing dependency versions changes.

## Reproduction commands and discriminating regression

Use a disposable directory outside the repository; copy only `ui/package.json` and `ui/package-lock.json` there. With that directory as cwd, run:

```sh
rtk npm exec --yes --package=node@24.21.0 --package=npm@11.19.0 -- node --version
rtk npm exec --yes --package=node@24.21.0 --package=npm@11.19.0 -- npm --version
rtk npm exec --yes --package=node@24.21.0 --package=npm@11.19.0 -- npm ci --ignore-scripts --no-audit --no-fund
```

The committed lock at `989baa45` fails exit 1 with the quoted missing runtime. The minimized lock passes exit 0. `npm ci` itself is the discriminating regression test and the repository's existing `.github/workflows/e2e.yml` Build UI clean-install gate: it validates the real dependency closure before running scripts. This investigation preserves that gate rather than adding an implementation-mirroring package-presence assertion.

## 5 Whys

1. Why did CI stop before tests? `npm ci` rejected an incomplete lockfile dependency graph.
2. Why was it incomplete? The sunset dependency-removal diff dropped `node_modules/@emnapi/runtime` while surviving optional packages retained requirements on it. `HEAD^` contains runtime 1.11.3; `HEAD` does not.
3. Why was the missing closure not caught locally? The reported local validation used the installed dependency tree for type/unit/build checks, which do not perform npm's clean-install lock validation.
4. Why could that evidence be mistaken for installation readiness? Dependency removal was validated as an application change without rerunning the existing clean-install boundary against only the final manifests under CI tooling.
5. Process root: dependency/lock edits need the existing `npm ci` gate, not only checks using populated node_modules. The repair validation now explicitly includes exact CI-version clean installation in isolation; no new CI mechanism is needed.

The experiment proves the missing-record defect and validation gap. It does not attribute a specific npm-internal pruning bug without evidence.

## Falsification

- **Isolation**: Only manifests are copied; exact CI versions and disabled install scripts still reproduce the same EUSAGE. Application changes, runtime config, and native build scripts cannot explain it.
- **Counterfactual edit**: Generate lock metadata through exact CI npm in scratch, then discard its unrelated peer-flag normalization. Add only the generated runtime record to the original lock. The same clean install passes, including Linux/x64 optional package selection.
- **Result**: The proposed cause survives both attempts. No existing package version was changed; unrelated npm metadata normalization was unnecessary.

## Root Cause

The immediate cause is the absent top-level @emnapi/runtime 1.11.3 record in `ui/package-lock.json`, required by the retained transitive optional graph. H1 is rejected because root dependency and devDependency ranges match the manifest. H2 is rejected by the scripts-disabled reproduction on a non-Linux host. The controlled one-record counterfactual fixes clean installation, establishing exactly one proven cause. The process root is the missing final-manifest clean-install validation described above.

## Fix

- `ui/package-lock.json`: restore only the missing runtime record using metadata generated by npm 11.19.0 under Node v24.21.0. Preserve every existing package record, version, resolved URL, integrity, and root manifest entry.
- Regression: repeat the existing CI `npm ci` validation on both original and repaired manifests in a disposable directory. It fails before and passes after. No application code, manifest, workflow, or test behavior needs changing.
- Scope: the process gap is addressed by performing and recording the clean-install gate for this lock repair. This does not require changing unrelated dependency versions or rebuilding unchanged application code.

## Resolution

- Restored exactly one npm-generated package record: `node_modules/@emnapi/runtime` version 1.11.3, its registry integrity, optional classification, and existing tslib dependency.
- Diff is **10 inserted lockfile lines**, with no package removals, existing-entry changes, version changes, manifest edits, application changes, or CI changes.
- Exact CI Node v24.21.0/npm 11.19.0 original-lock clean install: **exit 1**, exact reported EUSAGE/missing-runtime error.
- Full npm-regenerated scratch lock clean install: **exit 0**, `added 203 packages in 10s`.
- Minimal single-entry scratch lock clean install: **exit 0**, `added 203 packages in 10s`.
- Minimal single-entry scratch lock with Linux/x64 optional selection: **exit 0**, `added 208 packages in 19s`.
- Final repository lockfile is byte-identical to the validated minimal scratch lock. SHA-256: `6b745609fa898e82aeea1eea448a96d7d239e2e4aa91fab7794fc5cb741db936`.
- `git diff --check`: passed.
- Existing unchanged application unit/build/E2E evidence remains applicable; no runtime, server, browser, E2E or CI reruns were started by this worker. Root will observe the normal post-push CI gate.
- Disposable install directory was cleaned after evidence collection. No repository node_modules changes or Git mutations were performed.
- Completed: 2026-10-16T04:49:03.993853+00:00 .
