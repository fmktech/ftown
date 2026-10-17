---
type: investigation
symptom: "Device-pairing E2E waits for userCode after a fresh bridge exits at setup readiness"
slug: pairing-setup
date: 2026-10-17T14:59:25-03:00
git_commit: 188be04c683191095fd32d29c952ecd429e81a8f
branch: simplify/setup-cli-lifecycle
repository: fmktech/ftown
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

# Pairing fixture omitted explicit setup

## Ownership

Native worker `/root/simplify_all`, explicit `gpt-6.1-sol` / `high`, shared
checkout `/Users/fkesheh/projects/ftown-simplify-all`. Exclusive writable lease:
`e2e/tests/device-pairing.spec.ts` and this log. Other workers share the checkout;
preserve their edits, both locally modified prior coordination notes and raw CI
evidence. Root alone executes E2E, servers and CI; no worker runtime or CI run.

## Symptom and reproduction

CI run [39039744280](https://github.com/fmktech/ftown/actions/runs/39039744280)
already reproduces the regression on this commit. Its Playwright pairing test
creates a new HOME, directly launches `dist/index.js` without setup and waits for
the pairing code. Verbatim result from the preserved CI log:

```
Error: timed out waiting for bridge userCode in stdout:
FTown setup is missing, incomplete or outdated. Run: npm exec --yes --package ftown-bridge@0.19.41 -- ftown setup
32 passed (51.9s)
```

Expected: the tokenless bridge prints a userCode, the browser approves it, and
the bridge becomes online. Observed: startup deliberately exits before pairing.
Root has confirmed CI uses isolated test infrastructure. The worker inspected
this existing failed reproduction rather than starting another environment.
Root also reproduced it deterministically using a Python TemporaryDirectory,
HOME set to that scratch directory, and `node bridge/dist/index.js --api-url
http://127.0.0.1:1`: exit 1 with the same setup error. No server started and the
temporary directory was removed automatically.

## Hypotheses

### H1: The independent scratch-HOME fixture omitted required setup — PROVEN

- Layer: test/configuration lifecycle.
- Prediction: readiness rejects the fresh HOME before any pairing request.
- Verification: fixture source at `device-pairing.spec.ts:53` creates a new HOME
  and immediately spawns `dist/index.js`; `index.ts:115` calls
  `assertSetupReady(BRIDGE_VERSION)` before auth/data/listeners.
- Evidence: exact missing-setup error above; the fixture contains no setup call.
- Verdict: PROVEN. This accounts for both absent userCode and intentional exit.

### H2: Pairing UI/auth approval broke — REJECTED

- Layer: application/auth.
- Prediction: bridge reaches pairing, then lookup/approval/token exchange fails.
- Evidence: readiness exits before onboarding; the CI trace instead stops at
  `waitForUserCode`, before navigation to `/pair?code=...` or approval.
- Verdict: REJECTED. The allegedly failing application phase is never reached.

### H3: The compiled CLI/setup version is broken or mismatched — REJECTED

- Layer: build/integration.
- Prediction: the main harness using the same build also fails setup/startup.
- Evidence, same CI run:

```
ftown setup 0.19.41: installed
[start] bridge online (presence=1)
```

- Verdict: REJECTED. The compiled package works when its HOME is explicitly set up.

## Falsification and 5 Whys

Absence check: the same CI artifact's main harness performs explicit setup in
its own HOME and comes online; only the separate fresh pairing HOME fails. The
setup-omission explanation survives this counterexample search. Production
readiness is working as specified and must remain unchanged.

1. No userCode appears because readiness exits before pairing.
2. Readiness exits because the scratch HOME lacks a completed setup.
3. The pairing fixture spawns its own bridge and does not reuse harness setup.
4. The explicit-setup change updated the main harness but missed this second
   startup site.
5. The fixture encoded startup as sufficient preparation, coupling its lifecycle
   to the removed automatic installation behavior.

## Fix and regression gate

Make the existing fixture await the current compiled `ftown-cli.js setup` with
the same scratch HOME/USERPROFILE before tokenless bridge startup. Run setup
from the empty scratch HOME so it cannot migrate a repository's legacy data.
On setup failure, remove that HOME and report captured diagnostics immediately.
No product/readiness/pairing changes. The existing pairing E2E is the regression:
it is red in the recorded CI run and root will execute/monitor it after review.

Root-only focused invocation, with the established isolated harness ready:

```
cd e2e
npx playwright test tests/device-pairing.spec.ts --project=chromium
```

## Implementation handoff

The fixture now awaits compiled CLI setup with the same scratch HOME and
USERPROFILE, then starts the bridge without a token. Setup uses the empty scratch
directory as cwd, avoiding accidental migration of a repository's legacy data.
Failure removes the scratch directory and surfaces captured setup diagnostics;
the bridge cannot start until setup succeeds. Existing pairing assertions and
production code are unchanged.

TypeScript syntax/transpilation passed with the existing compiler and no output
files/runtime execution; scoped `git diff --check` passed. A full E2E typecheck
was not run because this checkout has no `e2e/node_modules`; no dependencies were
installed. Root retains the existing red CI regression and owns post-change E2E
execution. Source writes stopped for independent review; this log lease remains
available for final CI evidence. No commit/push before root instruction.
