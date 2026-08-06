---
type: investigation
symptom: "I tried npx -y ftown-bridge@latest and it failed to start"
slug: ftown-bridge-latest-failed-to-start
date: 2026-08-06T10:20:54-03:00
investigator: Foad Kesheh
git_commit: 892c26c887c55892b8f954c301a54398c508e755
branch: feat/move-sessions-between-parents
repository: fmktech/ftown
status: investigating
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 0
related: []
---

# `ftown-bridge@latest` reportedly fails to start

## Symptom

- **Observed**: User report, verbatim: "I tried npx -y ftown-bridge@latest and it failed to start". No error output was supplied.
- **Expected**: The published CLI starts with no `--api-url`, binds its local API, and either resumes stored credentials or prints a device-pairing URL and code.
- **Delta**: The reported environment does not reach a usable bridge, while a fresh local reproduction reaches device pairing. The exact failing stage and error remain unknown.

## Reproduction

1. Confirm the npm dist-tag and package version.
2. Run the published package with an isolated data directory:

   ```text
   npx -y ftown-bridge@0.19.4 --data-dir /tmp/ftown-bridge-direct.6H52Dc
   ```

3. Observed on 2026-08-06:

   ```text
   [LocalApiServer] Listening on port 52185
   [Bridge] Local API server started on port 52185
   [Bridge] No bootstrap token or stored session — starting device pairing...
   Approve this machine to connect it to ftown:
       https://ftown.ia.br/pair?code=R5VX-P7ZP
       code: R5VX-P7ZP
   Waiting for approval…
   ```

The reported failure is not reproduced. The command deterministically reaches the expected pairing state in an isolated directory on the same machine.

## Hypotheses

#### H1: npm `latest` still resolves to a pre-0.19.4 package that requires `--api-url`

- **Layer**: tooling-build
- **Prediction**: `npm view ftown-bridge version dist-tags --json` reports a version older than 0.19.4.
- **Verification method**: Inspect the live npm registry metadata.
- **Evidence**:

  ```text
  {
    "version": "0.19.4",
    "dist-tags": {
      "latest": "0.19.4"
    }
  }
  ```

- **Verdict**: REJECTED
- **Rationale**: The live `latest` tag resolves to the release containing the default URL.

#### H2: The 0.19.4 artifact does not apply the default API URL or cannot enter its action

- **Layer**: code-logic / tooling-build
- **Prediction**: Published help omits the default, or a fresh invocation exits or stalls before binding the local API.
- **Verification method**: Run published `--help`, then invoke the published artifact with a fresh data directory.
- **Evidence**:

  ```text
  --api-url <url>    ftown UI API URL (default: "https://ftown.ia.br")
  [LocalApiServer] Listening on port 52185
  [Bridge] No bootstrap token or stored session — starting device pairing...
  ```

- **Verdict**: REJECTED
- **Rationale**: The registry artifact contains the default and reaches interactive onboarding.

#### H3: The reported run differs by local credential/network state or by interpreting the pairing wait as startup failure

- **Layer**: state-data / config-env / observation
- **Prediction**: The exact failing run shows either a stored-refresh rejection, pairing HTTP error, network error, or the normal `Waiting for approval…` state without completing browser approval.
- **Verification method**: Obtain the exact stdout/stderr from the failed invocation and compare its last successful stage with the isolated reproduction.
- **Evidence**:

  ```text
  Exact stdout/stderr from the reported failure: not yet supplied.
  A separate currently running process with explicit --api-url has both a
  loopback listener and an established Centrifugo TLS connection.
  ```

- **Verdict**: INCONCLUSIVE
- **Rationale**: This is the only remaining class consistent with the evidence, but the missing error output prevents a single cause from being proven.

## 5 Whys

Deferred until one immediate cause is proven from the failed run's exact output.

## Falsification

- **Check performed**: Absence test for the suspected missing-default/package defect.
- **Result**: With no `--api-url` and no stored state, the published package reaches pairing using `https://ftown.ia.br`.
- **Conclusion**: The package/default hypothesis was broken; the environment- or stage-specific hypothesis remains inconclusive.

## Root Cause

Not yet proven. Exact stdout/stderr from the user's failed invocation is required.
