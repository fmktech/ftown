---
type: investigation
symptom: "Structured launch smoke receives HTTP 426 upgrade_required while deleting a successfully launched session"
slug: structured-launch-smoke-raw-api-426
date: 2026-11-16T18:44:48Z
git_commit: ec6af38daa3b477353d2bda70c00cb78a6d0d31b
branch: feat/accounts-core
repository: fmktech/ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

## Symptom

Observed output:

```text
AssertionError [ERR_ASSERTION]: {"error":"upgrade_required","code":"upgrade_required"}

426 !== 200
    at api (bridge/scripts/structured-launch-smoke.mjs:62:46)
    at async remove (bridge/scripts/structured-launch-smoke.mjs:70:29)
    at async bridge/scripts/structured-launch-smoke.mjs:106:3
```

Expected: the smoke deletes the Claude account session after verifying the spawned process environment. Observed: the local API returns HTTP 426 with `upgrade_required`. The account create and launch assertions before cleanup pass.

## Reproduction

From the repository root, build the bridge and run the root-owned integration smoke:

```bash
cd bridge && npm run build
cd .. && node bridge/scripts/structured-launch-smoke.mjs
```

On the 0.30.27 worktree with Node 24.12.0, the current smoke reproduces the 426 during the `DELETE /api/sessions/<id>` cleanup request. The test itself creates an isolated temporary HOME, starts its own local bridge, and cleans up its processes and files.

## Hypotheses

#### H1: The smoke helper still sends a retired raw bearer API request, so the bridge rejects cleanup with 426.

- **Layer**: code-logic / integration
- **Prediction**: The helper will send an `Authorization: Bearer` request to an application route, and the local server will return the raw-API retirement response (426 `upgrade_required`).
- **Verification method**: Inspect the helper and server fallback; reproduce with the smoke.
- **Evidence**:
  ```text
  bridge/scripts/structured-launch-smoke.mjs:54-62 uses fetch() with Authorization: Bearer ${pointer.token} for application paths.
  bridge/src/local-api-server.ts:987-988 returns status 426 and { error: 'upgrade_required', code: 'upgrade_required' } for retired raw bearer APIs.
  The smoke reproduction receives exactly {"error":"upgrade_required","code":"upgrade_required"} with status 426 at its first DELETE.
  ```
- **Verdict**: PROVEN
- **Rationale**: The request uses the transport the server intentionally retired, and the observed response is that retirement response.

#### H2: The bridge pointer is missing security metadata, causing the secure local client to require an upgrade.

- **Layer**: configuration / environment
- **Prediction**: A secure CLI request using the same temporary HOME and bridge pointer will fail before creating a session.
- **Verification method**: Run the CLI account create and inspect the smoke's progress to the first cleanup.
- **Evidence**:
  ```text
  The smoke reaches its first DELETE at bridge/scripts/structured-launch-smoke.mjs:106 only after the installed CLI creates the account session, observes its real process launch, and passes assertions at lines 98-105.
  The CLI uses the encrypted local application path; it could not create that session from an incomplete pointer.
  ```
- **Verdict**: REJECTED
- **Rationale**: The installed CLI successfully uses the same temporary bridge pointer to create and launch the session before the helper's raw request fails.

#### H3: The account-specific process environment causes the local server to reject session deletion.

- **Layer**: state / data
- **Prediction**: The failure will occur during account create or the process-environment assertions, before cleanup.
- **Verification method**: Observe exact stack location and assertions passed before it.
- **Evidence**:
  ```text
  The stack points to remove() from line 106. The preceding assertions at lines 101-105 verify the session account, CLAUDE_CONFIG_DIR in the spawned-process receipt, and absence of that path from the command, then pass.
  ```
- **Verdict**: REJECTED
- **Rationale**: Account selection and launch environment succeed; the failure begins only when the helper sends its cleanup request.

## 5 Whys

1. Why does cleanup receive 426? Because the server routes the request to its retired raw bearer API fallback.
2. Why does the request reach that fallback? Because the smoke helper sends an ordinary HTTP request with an Authorization bearer header.
3. Why does the helper send raw bearer authorization? It predates the encrypted local API wrapper and retained the old request helper.
4. Why did the stale helper remain? The smoke had no CI invocation, so the regular CI suite did not execute it.
5. Why was it not caught before this change? The test was a manually run integration script rather than a required CI gate.

## Falsification attempt

The secure local API tests use `apiResponse()` (the encrypted local client) and passed 61/61, including the actual session routes. The smoke's installed CLI also creates the session successfully through that same encrypted application mechanism before the raw cleanup helper fails. This falsifies the alternative that the local secure API or bridge pointer is generally unavailable.

## Root cause and next step

The smoke has a stale raw-bearer request helper. Replace it with the built `cli-client.js` encrypted `apiResponse()` helper and keep the test's isolated local bridge/process setup. Then rerun the focused smoke as the root E2E owner. Wire that passing smoke into the Linux CI unit job so the account process-environment proof runs in CI.

### H1 falsification experiment (before source fix)

- **Intervention**: In a throwaway copy of the smoke, change only its HTTP helper from raw `fetch()` with a bearer token to the already-built `cli-client.js` `apiResponse()` encrypted local client. Keep the temporary HOME, bridge process, selected account, delete path and all assertions the same.
- **Prediction if H1 is true**: The account cleanup DELETE will return its expected 200 response; the current raw-bearer version returns 426.
- **Prediction if H1 is false**: The encrypted DELETE will also fail with 426, indicating the cause is not the retired raw request helper.
- **Status**: Pending execution before source fix.

- **Falsification result**: The throwaway encrypted-client copy passed end-to-end with exit code 0 and output `{"result":"PASS","version":"0.30.27",...}`. Both Claude and Codex child-process environment assertions passed, as did create/delete, retry/resume and cleanup. This falsification attempt did not break H1: the same route and pointer work through the encrypted client; only the raw-bearer helper fails.


## Fix and verification

`bridge/scripts/structured-launch-smoke.mjs` now uses the built encrypted `apiResponse()` client for local bridge API calls. The exact process smoke then passed with exit code 0 on the committed script, including Claude `CLAUDE_CONFIG_DIR`, Codex `CODEX_HOME`, session cleanup, resume/retry and final process cleanup. The smoke remains wired to the Linux CI unit job via `scripts/ci/run-job.sh`.
