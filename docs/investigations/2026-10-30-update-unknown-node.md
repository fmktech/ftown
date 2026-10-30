---
type: investigation
symptom: "Latest release is Unknown on Node 24.12.0 despite a valid registry release"
slug: update-unknown-node
date: 2026-10-30T12:00:00-03:00
git_commit: c5d955d3f9990a1f1345ca21394ccf2127da87cf
branch: fix/updates-enabled-default
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

# Latest update version is unknown on an older Node runtime

## Symptom and reproduction

Observed by root with installed CLI 0.19.58 and Node 24.12.0: Latest is Unknown. The read-only `https://registry.npmjs.org/ftown/latest` response was HTTP 200 with version 0.19.61, gitHead `c5d955d` and engines `^22.23.4 || ^24.22.1 || >=26.12.1`. Root passed the same live metadata to installed `validateStableMetadata`: Node `24.12.0` threw `Unsupported release metadata`, while `24.22.1` returned `0.19.61`. Expected: report the known latest version and distinguish incompatibility from lookup failure without permitting staging on an unsupported runtime.

## Hypotheses

### H1: Registry lookup fails or has no latest version.
- **Layer:** network/data. **Prediction:** latest returns an error or lacks a version. **Evidence:** root observed HTTP 200 and valid 0.19.61 metadata above. **Verdict:** REJECTED for this reproduction.

### H2: Discovery rejects otherwise valid metadata when the current Node does not satisfy the release engine.
- **Layer:** application logic. **Prediction:** identical metadata passes for supported Node and fails for unsupported Node; discovery turns that exception into unknown. **Evidence:** the two root invocations above; `bridge/src/update-release.ts` validates `supportsNode` inside `validateStableMetadata` and discovery calls that validator; `bridge/src/bridge-update.ts` catches any resolve failure and sets `latest = null`. **Verdict:** PROVEN.

### H3: The release itself is malformed independently of runtime.
- **Layer:** registry metadata. **Prediction:** both Node versions reject identical metadata. **Evidence:** Node 24.22.1 accepted exactly the same metadata. **Verdict:** REJECTED for this reproduction.

## Falsification and five whys

The supported-runtime invocation is the counterfactual: same data, different Node version, opposite outcome. It rules out a universally malformed response but does not claim all Unknown results have this cause.

1. Latest is Unknown because discovery's rejected promise becomes a null release.
2. Discovery rejects because it applies the current runtime engine check.
3. It uses the same strict validator required for staging.
4. That validator conflates trusted release metadata with whether this process may install it.
5. The discovery and installation boundaries were not represented separately in the update status contract.

## Repair and verification plan

Separate bounded trusted metadata parsing from strict runtime validation; expose incompatibility in status and reject requests before persistence. Keep the strict validator at preparation before any staging mutation. Regression tests must show known metadata on 24.12.0, rejection of installation there, success on 24.22.1, and Unknown for actual resolution failure. Root owns runtime verification. No update or restart of the user's bridge is authorized.

## Resolution
Root reproduced live discovery under local Node24.12.0 after the fix: latest0.19.61 and exact Node range returned; strict validation still rejects installation. Development sandbox Node24.22.1 fullbridge1112passed/4existing skips, UI832passed, releaseartifact17passed, bridge/UI builds and focuseddesktop/mobile E2E3/3passed. No actual release installation or user bridge restart was performed.
