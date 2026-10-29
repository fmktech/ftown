---
type: investigation
symptom: E2E CI failed before browser execution
slug: device-names-ci-guard
date: 2026-10-29
git_commit: 8d17394
branch: feat/account-device-names
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---
## Symptom and reproduction
User: “e2e failed”. CI40854520023, merge c53a884d6e04f467c9e32bb38dd9fcaaf6f4fc98, fails ci-fixtures.test.mjs:57 before browser execution: `3 !== 2`. Expected fixture guard pass.
Root reproduced with Node24.22.1: `node --test --test-name-pattern 'Playwright assigns' e2e/scripts/ci-fixtures.test.mjs`, exit1 same assertion. Dependencies installed using `npm ci --prefix e2e --ignore-scripts`. No services/database used.
## Hypotheses
- H1 naming/DB regression (logic): predicts browser/API failure. REJECTED: failing pure config guard invokes no server, database or browser.
- H2 runner/transport outage (environment): predicts remote-specific failure. REJECTED: identical assertion reproduced locally on Mac Node24.22.1.
- H3 stale expected isolated roster (test/config): PROVEN. Config has account-trust, device-display-names, pending-approvals; guard expects2 and omits new spec, cross-match uses `1-index`. Exact file contents and reproduction agree.
## 5 Whys
Job fails because guard asserts3===2. It expects2 because roster was fixed at two specs. A third spec was intentionally added for isolated account naming coverage. Guard was missed because focused validation ran browser feature tests without config-boundary checks. Process root: changes to test routing need fixture-boundary checks in focused validation.
## Falsification
Isolated config-only execution reproduces without any backend. Exact three configured patterns are canonical distinct specs, not wildcards/duplicates. Thus deleting the third entry would remove intended coverage rather than repair the stale guard. No source edits made during diagnosis.
## Fix brief and ownership
G: reuse /root/device_names_frontend, Tier1 gpt-6.1-terra xhigh, shared /Users/fkesheh/projects/ftown-device-names. Sole write e2e/scripts/ci-fixtures.test.mjs. Config/spec read-only. Expected explicit three-name roster in config order; assert count against expected list. Replace pair-only `1-index` assertion with all-other-pattern nonmatch assertions for each canonical file. Preserve unknown/nested/adjacent/prefix/suffix rejection and runtime/security settings checks. Existing guard is regression: fails before; corrected full roster guard must pass. No product changes, retries or assertion weakening.
Worker may run `node --test e2e/scripts/ci-fixtures.test.mjs`; no E2E/server/DB/install/Git. Root owns integration/CI/docs. Others share checkout: no reverting or outside edits. Handoff diff/checks and released lease. R reviews read-only except existing review report after G release. Root runs isolated reproduction and complete fixture suite before push/CI.

## Resolution
Guard now names all three isolated specs and checks every other pattern rejects each canonical path. All existing negative paths/settings preserved. Root Node24.22.1 full fixture suite6/6 PASS; failing isolated assertion reproduced before repair. CI log confirms same Node24.22.1. Product/browser code unchanged; prior focused browser evidence remains valid. No CI rerun requested before local repair evidence.
