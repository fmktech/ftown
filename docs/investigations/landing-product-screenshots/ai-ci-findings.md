---
type: investigation
symptom: "Unchanged account-trust desktop case throws BridgeSecurityError bridge_offline while checking phone revocation"
slug: account-trust-local-read-ci
date: 2026-10-27
git_commit: 6abbc0e
branch: feat/landing-product-screenshots
status: investigating
hypotheses_formed: 5
hypotheses_rejected: 3
hypotheses_proven: 1
---

# Bounded CI account-trust investigation

AI-CI-REVIEW — Tier 2 `gpt-6.1-sol` / `max`, shared checkout `/Users/fkesheh/projects/ftown-e2e-performance`. Sole writable file is this report. All application/test/artifact reads are non-mutating; root owns runtime, isolated local database, diagnostic execution and CI. No source fix is justified yet.

## Symptom and preserved evidence

CI run `40576973672`, revision `6abbc0e`, direct-transport job, Node 24.22.1/npm 11.19.1 on Ubuntu 24.04. Command was `npx playwright test`, with two configured workers, zero retries. `/tmp/ftown-ai-media-20261027/ci-failed.log:133-150` records:

```text
BridgeSecurityError: Bridge security: bridge_offline
at expect.poll.timeout (.../e2e/tests/account-trust.spec.ts:245:24)
at .../e2e/tests/account-trust.spec.ts:244:7
```

The failed case is `account trust: one computer confirmation, one device approval, future computers and durable two-tab pins (1280)`. It had completed approval, multiple real encrypted terminals, future-computer and responsive access-map assertions, then removed the phone through the UI. Lines 244–247 poll all three task-owned bridges in parallel, requiring `security_devices` no longer to contain the revoked phone. Instead, one read throws before the convergence assertion can complete. The 390px counterpart passed. CI reports 57 passed, two existing skips, one failure; all eight new landing cases passed. This is not a passing full CI result.

Downloaded trace/error context embed the same local-client source. The failure stack reaches the application leg after the local hello, but the artifacts do not retain the failing Node fetch's HTTP status or the isolated bridge's internal rejection. `startAccountTestBridge` uses ignored stdio and removes its temporary HOME on cleanup (`e2e/helpers/account-pairing.ts:28-30,67-79`); the top-level shared bridge log does not substitute for these three isolated child logs.

## Hypotheses and falsification

### H1 — The offline label hides an HTTP rejection (PROVEN observation cause)

- Layer: observation/transport boundary.
- Prediction: the thrown error is created for a received non-OK response, even if the server is reachable.
- Evidence: `bridge/src/security/bridge/local-client.ts:24-27` awaits fetch, then executes `if (!response.ok) throw new BridgeSecurityError('bridge_offline');`. It does not catch connection errors into this class. The CI stack enters this exact post path. `bridge/src/local-api-server.ts:470` maps any uncaught envelope rejection to HTTP 400 `{error:'invalid_envelope',code:'invalid_envelope'}`.
- Falsification: an actual TCP connection refusal would reject fetch before this explicit non-OK branch; it would not be this newly constructed BridgeSecurityError. Thus this failure cannot be diagnosed as process death from its error label alone. Exact rejecting status/cause remains unknown.

### H2 — Account projection invalidates an otherwise still-approved local CLI principal during the read (INCONCLUSIVE, narrow leading hypothesis)

- Layer: state/authorization concurrency.
- Prediction: diagnostic output identifies a local-cli principal whose saved policy generation differs from the current generation, while its approved record/key/grant remain unchanged.
- Evidence: `BridgePolicyStore.projectAccount` preserves non-browser endpoints but increments policy generation when account head changes (`bridge/src/security/bridge/policy.ts:287-308`). `principal()` records that generation (`:84-99`). Both authorization and revalidation reject any mismatch as `endpoint_revoked` (`:89-108`). `acceptApplication` awaits decode before revalidating (`security.ts:165-195`), allowing account refresh to intervene. `executeSecurePacket` does not authenticate an unverified `endpoint_revoked` rejection (`execute.ts:27-35`), which can reach the generic HTTP 400 boundary and become H1's offline label.
- Counter-check: unchanged-head refresh does not increment generation (`policy.ts:290,307`); this is a bounded head-transition race, not every periodic refresh. The source proves a possible path, not that it occurred in CI. Need correlated diagnostic evidence before any generation-handling fix.

### H3 — Parallel helper calls mutate global HOME/FTOWN_DATA_DIR and use another bridge's pointer (REJECTED)

- Layer: fixture/configuration.
- Prediction: an await leaves global environment selectors temporarily changed between calls.
- Evidence: `e2e/helpers/secure-browser.ts:81-83` passes `readBridgePointer(bridgeHome)` directly to `cli.securityCommand`. `bridge-api.ts:36-48` synchronously reads that explicit home's pointer without modifying it or process.env. `cli-client.ts:55-60` forwards that pointer; `local-client.ts:15` loads the identity from its explicit `dataDir`/`ownerId`. Each call's pointer/identity is function-local. `account-pairing.ts:14-16` uses mkdtemp and a per-child environment object. No global selector mutation exists on this path.

### H4 — Phone revocation rotates receiverEpoch and invalidates the local handshake (REJECTED)

- Layer: protocol/state.
- Prediction: receiver epoch changes during account refresh/revocation without process restart.
- Evidence: `bridge/src/security/bridge/security.ts:37` initializes a readonly lifetime receiverEpoch. Revocation/account refresh do not replace it (`:255-308`). The handshake epoch changes only with a new service lifetime, which is not a revocation effect. Do not propose epoch retry as the fix.

### H5 — The reported exception proves an ordinary TCP-offline bridge (REJECTED as this immediate exception mechanism)

- Layer: runtime/transport.
- Prediction: no HTTP response is received and fetch rejects with a connection error.
- Counterexample: H1's throwing branch requires an actual non-OK HTTP Response. This does not rule out a wrong process/port or another HTTP failure; those require status/process diagnostics. It rules out treating the literal offline label as sufficient process-death evidence.

## Why the current evidence stops short

The known chain is: convergence read throws → local encrypted application POST gets a non-OK response → local client collapses all non-OK statuses into one offline code → local server deliberately keeps unauthenticated envelope rejection details generic → isolated child diagnostics are discarded. That last observability gap prevents proving the underlying authorization/runtime cause from the CI artifact alone. H2 is not promoted to root cause by plausibility. No complete causal five-whys chain or production fix is claimed before isolated reproduction/falsification.

## Minimal reproduction and temporary diagnostic scope

Root's dedicated sandbox `bx_tjrm2dv7` starts with exact revision `6abbc0e`, matching Node/npm, fresh local database and validated exact local service selectors. Run only:

```sh
npx playwright test tests/account-trust.spec.ts --project=chromium-isolated --grep '\(1280\)' --workers=1
```

No retries, catch-and-success, assertion weakening, sleeps or full CI rerun. Preserve the original unmodified result first. A passing isolated attempt is useful evidence but does not falsify a timing race.

For a diagnostic rerun, root delegates temporary copies outside the tracked application diff:

1. `bridge/src/security/bridge/policy.ts:91,104`: inside existing generation-mismatch branches, under `FTOWN_ACCOUNT_CI_DIAGNOSTICS=1` only, emit a fixed tagged JSON line with timestamp, pid, stage, endpoint kind, actor/current generation, member-present/same-key/same-grant booleans (and permission-allowed when applicable). Never print endpoint IDs, actual keys/grants, account history, envelopes, payloads, pointers or credentials. Keep the same throw and all policy behavior.
2. `e2e/helpers/account-pairing.ts:28-30`: under the same flag only, pipe child stderr and forward only that exact validated diagnostic marker/field allowlist; drop other stderr. Default behavior remains ignored stdio. Do not forward general bridge logs or secrets.
3. Optional outside-checkout Node preload: inspect only `/api/security/envelope` non-OK fetch results and log timestamp/status/purpose. Do not log request body, headers, responses or key material. This alone cannot reveal the server's underlying error because its body is deliberately generic.

If no local-cli generation mismatch correlates with the failure, a separately bounded diagnostic at `local-api-server.ts:470` may log only a fixed allowed error constructor/code, with the same flag; never change HTTP response semantics or print the raw exception/packet. Review temporary copies before execution. Remove diagnostic-only changes from any proposed production fix.

## Conditional fix boundary and gate

Do not change account revocation, policy generations, crypto checks or polling errors until H2 (or a concrete alternative) is reproduced and falsified against an appropriate control. In particular, changing `Promise.all` to serial reads or blanket-catching `bridge_offline` does not establish the cause and can conceal a real authorization failure. If H2 is proven, the fix must distinguish a fresh, still-authorized read from a revoked principal and preserve fail-closed mutation/replay behavior; add a deterministic regression around an account head transition between principal acquisition and revalidation. A narrow test-boundary mitigation must be justified with exact typed evidence rather than accepting every offline error. Root/worker ownership and a separate implementation brief remain required.

Initial bounded source/artifact review complete. Only this report was written; no source edits, execution, CI, installation, browser, database or Git work. Report lease released pending the concrete temporary-copy review and root reproduction evidence.

## Temporary diagnostic copy review

Reviewed `/tmp/ftown-ai-media-20261027/ci-diagnostic/handoff.md` and exact two-file diffs against the shared source. **Approved for root's isolated experiment; no diagnostic blocker.** Only the existing `authorize`/`revalidate` generation-mismatch branches call an env-gated reporter before the same `endpoint_revoked` throw. The reporter emits a fixed tag and time/pid/stage/actor-kind/generation values plus membership/key/grant comparison booleans; it never emits the compared values. Reporter failure cannot bypass the original authorization rejection.

The fixture preserves ignored stdio by default. Its flagged path pipes only stderr, buffers at most 4096 characters per line, rejects non-tagged/malformed/overlong lines and reconstructs only checked numeric/enum/boolean fields. It does not relay arbitrary child stderr. No HTTP response, permissions, retry, timeout, polling assertion or environment-ownership behavior changes. The copies are outside tracked application source and must remain diagnostic evidence, not a production fix.

Root's unmodified smallest case was still running at this handoff. Underlying CI rejection remains unproven until reproduction/diagnostic evidence arrives; this report does not recommend a speculative generation fix or CI rerun. Sole report lease released again. Concrete pending assignment is that exact evidence review, if root dispatches it.

## Unmodified reproduction status and one-head CI process

Root reports the exact unmodified 1280px case passed 1/1 in 2.2 minutes with cleanup successful. This establishes the smallest reproduction was attempted and did not reproduce the CI failure; it does not prove the timing hypothesis false or a fix successful. Root is next running two explicit copies with two workers and the reviewed logging-only diagnostics to test concurrency, rather than rerunning full CI. No application fix is present.

Read the complete `.github/workflows/e2e.yml`. Lines 3–7 define unfiltered `pull_request`, `push` restricted to `main`, and `workflow_dispatch`; there is no `paths`, `paths-ignore`, or concurrency/cancel control. The workflow's test command remains the full `npx playwright test` at line 116. Consequently, an evidence-only documentation commit pushed to the open PR will start the full workflow; a feature-branch push does not independently match the main-only push trigger.

Recommended sequence after the bounded diagnostic result:

1. Finish the evidence report and any separately proven/verified necessary fix before the final Git handoff. Keep diagnostic-only copies outside the tracked application change.
2. Have the integration owner make one final evidence/fix commit and push that exact head once. Use its automatic PR workflow as the single next full CI attempt; do not also rerun `40576973672` or dispatch a manual workflow.
3. Monitor and attribute the result to that final SHA. After it completes, record the run link/result in the PR description and FTown metadata, rather than adding another documentation-only commit solely to announce CI success.

If that attempt fails, apply the existing isolated-reproduction rule to its concrete failure; do not use repeated full runs as diagnosis. No workflow change is proposed. Only this report was edited, no runtime/Git/CI/source work was performed, and the report lease is released pending the concrete two-copy diagnostic result.

## Final bounded non-reproduction result

**The original CI cause remains unproven. No production or test fix is justified by this evidence.** Read both saved run logs and their `test-results/results.json`, rather than relying only on the reported outcome:

| Run | Scope and result | Cleanup |
| --- | --- | --- |
| CI `40576973672` at `6abbc0e` | Full 60-case workload, two workers: 57 passed, two existing skips, unchanged account1280 failed; all eight new landing cases passed | CI failure retained as original evidence |
| `/tmp/ftown-ai-media-20261027/account-repro-r1/ftown-ci-account-repro-r1.log` | Unmodified exact account1280 case, one effective worker: 1/1 passed in 2.2 minutes | `FINAL_VALIDATION_EXIT=0 CLEANUP_FAILED=0` |
| `/tmp/ftown-ai-media-20261027/account-diagnostic/ftown-ci-account-repro-diag.log` | Two explicit copies of the same account1280 case with two workers and reviewed logging-only diagnostics: 2/2 passed in 2.2 minutes | `FINAL_VALIDATION_EXIT=0 CLEANUP_FAILED=0` |

The diagnostic JSON result records `repeatEach: 2` for `chromium-isolated` and `retries: 0`, with no unexpected/flaky/skipped cases. The saved diagnostic log contains **zero** `FTOWN_ACCOUNT_CI_DIAGNOSTIC ` event lines. Thus no generation-mismatch rejection was observed in that run. This is not proof that H2 can never occur, and the three local case passes do not establish a repaired race, successful full-suite reproduction or infrastructure root cause.

The workload distinction is material: CI ran the heterogeneous full suite alongside the isolated lane, while the bounded concurrent experiment ran two copies of account1280 only. It exercised concurrent account flows but did not recreate the full suite's resource use or scheduling. Node/npm matched the CI versions; the separate VM and installed optional CLI availability were not identical (CI setup reported Codex/OpenCode absent, local setup reported them installed). No causal claim follows from those environment differences. The rejected global-selector/epoch hypotheses remain rejected by their source counterexamples; the actual HTTP rejection cause remains unresolved.

This completes the requested bounded investigation, not a claim that the underlying intermittent CI failure has been fixed. Keep the original failure plus these non-reproduction logs and diagnostic copies as evidence; do not commit temporary instrumentation or weaken revocation/polling assertions. Root owns sandbox deletion/absence verification and the final documentation-only integration handoff. Finish that evidence commit once, push one final head and use its single automatic PR CI run, without also rerunning the old workflow or manually dispatching another full run.

Sole report lease released. No application/test/workflow/source changes, runtime/E2E/CI, installs or Git operations were performed by reviewer. This concrete assignment is complete; no further review or speculative investigation is retained.
