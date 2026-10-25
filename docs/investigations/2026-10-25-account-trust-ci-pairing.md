---
type: investigation
symptom: "PR136 device-pairing E2E times out waiting for a userCode on bridge stdout"
slug: account-trust-ci-pairing
date: 2026-10-25T17:17:02Z
investigator: /root/security_ui_impl
git_commit: 9819b77
branch: feat/account-trust-pairing
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-10-25-account-trust-contract.md
  - docs/investigations/2026-10-25-account-trust-ui-review.md
---

# CI device-pairing fixture still expects retired onboarding

Read-only investigation by the explicitly selected gpt-6.1-sol/high worker in the
shared checkout. Head is root-reported9819b77; no Git command was executed.
Application/test sources unchanged. No browser, servers, database, E2E or CI run.

## Symptom and reproduction

Observed in root-provided `/tmp/ftown-pr136-ci-failed.log`:

```
Error: timed out waiting for bridge userCode in stdout:
[LocalApiServer] Listening on port 44715
[Bridge] Local API server started on port 44715
[Bridge] No bootstrap token or stored session — starting device pairing...
Waiting for encrypted computer approval. Run ftown security pair-link to display the current private approval link.
```

CI `device-pairing.spec.ts:139` registers an isolated user, runs explicit setup,
spawns a tokenless bridge with stdout/stderr piped, then searches that output for
XXXX-XXXX for20s (`:55–104,147–148`). Expected by the current contract:a private
fragment link retrieved through explicit local `security pair-link`, immediate
browser fragment capture, comparison and one account-aware confirmation.
The old test instead expects a logged user code and retired UI selectors.

Root-owned CI reproduced this in22.2s. The same CI passed the current account
onboarding desktop1280 and mobile390 cases (1.8m each). Worker reproduced the
isolated predicate using the exact captured startup text:

```
Old userCode regex matches captured startup output: False
Current PairClient contains 'This device is requesting access': False
Current PairClient contains 'Approve this device': False
Current PairClient contains 'is now connecting': False
Current PairClient contains 'Codes match — connect computer': True
```

## Hypotheses

### H1:pair/start is unavailable, so the bridge cannot obtain pairing data

- Layer:dependency/configuration.
- Prediction:startup cannot reach the validated modern waiting branch, and the
  modern CI account onboarding cases should also fail.
- Evidence:`pairing-client.ts:105–127` awaits pair/start, validates the returned
  code/poll metadata and saves the local pairing code before emitting the exact
  waiting instruction seen in CI. Both current account cases passed in CI.
- Verdict:REJECTED for this observed waitForUserCode failure. Later outages are
  outside the failed stage; there is no evidence of one here.

### H2:slow CI merely prints the expected user code after the20s deadline

- Layer:environment/timing.
- Prediction:a longer wait eventually receives XXXX-XXXX from the same process.
- Evidence:`pairing-client.ts:123–127` displays a modern private URL only via an
  explicit display callback or interactive TTY. The test supplies neither and
  pipes stderr (`device-pairing.spec.ts:81`); modern operational logs contain
  instructions only. The legacy code-printing branch is the separate else at
  `pairing-client.ts:128–133` and is not reached for a virgin modern bridge.
- Verdict:REJECTED. No timeout increase can make this branch log the expected code.

### H3:the legacy test fixture was not migrated to the current private-link flow

- Layer:test/consumer integration.
- Prediction:the bridge's intended modern output cannot satisfy the old regex;
  even bypassing that wait leaves obsolete public-code-only navigation and labels.
- Evidence:the CI output and isolated regex predicate above; test:93–104 waits for
  stdout code, :151 navigates without a fragment, :155–166 uses all three retired
  labels. Current PairClient:29–38 captures/parses the private link, :62 requires
  exact parsed request equality, and :65–71 obtains the cryptographic approval.
- Verdict:PROVEN as the one immediate cause. The test depends on a retired output
  and approval contract while the producer follows the frozen security contract.

## 5 Whys

1. The test times out because its stdout regex never sees XXXX-XXXX.
2. No code appears because modern noninteractive startup deliberately logs only
   instructions for explicit local secret display.
3. The test still expects the previous auth-only onboarding's stdout/public-code UI.
4. Account trust changed the bootstrap authority to a fragment-bound request and
   comparison; this old consumer was not adapted.
5. New modern acceptance cases were added and passed, but the existing onboarding
   lifecycle fixture retained its independent legacy setup/selector implementation.

## Falsification and bounded repair proposal

Falsification:producer startup reaches the intended modern waiting branch, both
modern CI cases pass, and an exact captured-output regex check fails without any
network timing variable. Inspecting the remaining legacy test steps reveals
additional retired selectors/public-code-only approval, so replacing only the
stdout wait is insufficient. H3 survives; restoring logged links or accepting a
public code alone would violate the current contract.

Proposed writable source scope:only `e2e/tests/device-pairing.spec.ts`.
Reuse existing tested `startAccountTestBridge(UI_BASE_URL)` and
`approveAccountComputer(page, bridge)` from `e2e/helpers/account-pairing.ts`
without modifying that helper. It already isolates HOME/USERPROFILE/dataDir,
performs CLI setup plus zsh guards, starts the real no-token process, retrieves
its pending private link through explicit `security --data-dir ... pair-link`,
keeps it out of logs/error messages, checks scrubbed public URL, clicks the exact
comparison confirmation, waits for the encrypted bridge row, and awaits precise
process/home cleanup. It supplies no enrollment bypass or test authorization.

Preserve fresh independent user registration/login, authoritative broker presence
polling and `/devices` bridge-registration revocation. Require the isolated user's
one device row to appear, assert Active, explicitly accept its revoke confirmation,
assert Revoked and optionally reload to prove durability. Do not retain the old
conditional that silently skipped revocation if the row was slow. This is bridge
registration revocation, distinct from last-account-admin revocation.

Cleanup must await the same test-owned bridge's stop helper in finally, preserve
an original assertion failure over a secondary cleanup error, and fail an otherwise
successful test on cleanup failure. Never kill an unowned process or remove the
real HOME. Do not log explicit pair-link CLI stdout, private URL, fragment, token
or response body; catch navigation/CLI errors with fixed safe messages.

## Acceptance and execution handoff

- Strict E2E TypeScript after the test-only repair.
- Root-only focused runtime:
  `cd e2e && npx playwright test tests/device-pairing.spec.ts --project=chromium --workers=1`.
- Real tokenless bridge pairs with one comparison confirmation and appears in
  broker presence; public code alone is never used as encryption authority.
- `/devices` registration becomes Active then Revoked, without optional skips.
- Exact child process and scratch HOME are removed after success or failure.
- Reuse existing passing modern desktop/mobile evidence; do not weaken producer
  secret-display restrictions, core crypto, owner checks or enrollment schemas.

Report write lease released after handoff. No source implementation until root
assigns the exact test file; root remains sole runtime/E2E executor.


## Source repair handoff

Root granted the frozen test-only repair contract in account-trust-ci.md.
Changed only `e2e/tests/device-pairing.spec.ts` and this report. Removed the
independent stdout parser/spawn/old selectors; reused unchanged modern helpers
for explicit private-link onboarding and precise awaited cleanup. Kept the
same test title, fresh independent user, real no-token startup and authoritative
owner broker presence. `/devices` now requires exactly one matching bridge row,
Active→confirmed Revoke→Revoked, then reload→Revoked; no conditional skip remains.
Original assertion failures survive secondary cleanup failures; cleanup errors
fail otherwise successful runs with a fixed secret-free message.

Verification:strict E2E TypeScript (`npx tsc --noEmit -p tsconfig.json` in e2e)
passed on local Node24.12 (supported-runtime CI remains root-owned). The old
predicate was already reproduced against captured CI output; the replacement
uses the same unchanged helpers whose desktop/mobile CI onboarding cases passed.
No new private-link logging, production/shared-helper edits, dependencies or
security exception were introduced. No E2E/browser/server/database/CI/Git run.

Runtime remains unexecuted by this worker. Root must run the focused device-
pairing spec via coordinated CI and confirm mandatory registration revocation
and exact child cleanup. A passing typecheck is not a runtime completion claim.
STOP-WRITE; source/report leases released for independent review and landing.
