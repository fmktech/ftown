---
type: investigation
symptom: "PR158 is merged but live dashboard displays only PR #158"
slug: live-pr-badges
date: 2026-10-30T13:17:00-03:00
git_commit: 73c67cc766ff65b810fc23f08e2ade0cbac30210
branch: fix/live-pr-badges
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

## Symptom and reproduction
User: "debug then" after live showcase exposed plain PR badges. Root observed FTown installed Chrome app and new Chrome tab at https://ftown.ia.br/dashboard, three encrypted bridges ready, local bridge0.19.62, linked PR158 merged; accessibility label remains `PR #158 in fmktech/ftown: https://github.com/fmktech/ftown/pull/158` after normal/hard reload and fresh tab. Expected merged badge, actual neutral link. PR160 and prive144 also plain. No source changes yet.

## Hypotheses
### H1: Production deployment lacks the provider
- Layer: tooling/build.
- Prediction: production alias points to a commit without PullRequestStatusProvider.
- Verification: Vercel alias/deployment API and GitHub source.
- Evidence: production READY dpl_28Dc7NUa4VHPZEh87B7dWsFcoMkM, git SHA73c67cc766ff65b810fc23f08e2ade0cbac30210; Dashboard contains PullRequestStatusProvider and SessionWorkspace.
- Verdict: REJECTED. Deployed source includes the provider. This does not independently rule out browser cache, but no browser behavior can supply the missing bridge handler.

### H2: Installed bridge lacks the command because its feature release failed
- Layer: release/integration.
- Prediction: installed artifact lacks handler, direct RPC fails, published package belongs to earlier commit.
- Verification: inspect installed distribution; sanitized encrypted localApplication probe; npm metadata; failed publish log.
- Evidence:
  - Installed /Users/fkesheh/.ftown/cli/package.json version0.19.62; dist/command-rpc.js lacks get_pull_request_statuses; dist/pull-request-status.js absent.
  - RPC: {"status":403,"code":"permission_denied","error":"permission_denied","outcomeUnknown":false}
  - npm view ftown@0.19.62 gitHead version --json: {"gitHead":"0657a8eaef2670a4b3f39164acbecf84e83dd7b5","version":"0.19.62"}
  - Publish41087077663: "ftown@0.19.62 has a different or missing gitHead. Bump bridge/package.json and its lockfile before releasing this commit."
- Verdict: PROVEN. PR160 published0.19.62 before PR158 merged with the same version; immutable-version protection correctly refused overwrite. Frontend neutral fallback hides unsupported command and equality prevents update discovery.

### H3: Frontend scheduling is necessary to produce the failed lookup
- Layer: code/state.
- Prediction: bypassing frontend scheduling allows status command to succeed on installed bridge.
- Verification: direct encrypted localApplication RPC using actual session ID, bypassing all React effects.
- Evidence: {"status":403,"code":"permission_denied","error":"permission_denied","outcomeUnknown":false}
- Verdict: REJECTED as cause of this reproduction. Failure persists without frontend scheduling. A separate scheduling suspicion is outside this bounded repair.

## Deterministic reproduction
Use installed bridge0.19.62 with current local pointer and actual session a321895d-59ae-4575-b2ec-d7087392757b. Call localApplication(loadPointer(), application route command get_pull_request_statuses, payload bridgeId from pointer and sessionIds containing current session). Do not log pointer, tokens or identities. Response is403 permission_denied. Open production dashboard with PR158 linked: neutral PR #158 despite merged state. Verified before any source mutation. Supporting release reproduction: current main package version0.19.62 conflicts with npm gitHead0657a8e; release preflight fails deterministically.

## 5 Whys
1. Badge stays neutral because uncached command failure intentionally retains ordinary PR link.
2. Command fails because installed artifact has no PR-status handler.
3. Installed latest package predates feature despite both reporting0.19.62.
4. PR160 published0.19.62 first; PR158 release then failed immutable-version preflight.
5. Parallel PRs reused a manually selected release version; integration allowed the collision to reach main, where the publish guard caught it only after merge. Release identity must be checked against the integrated base before landing, in addition to retaining publish safety.

## Falsification
Isolation: direct encrypted RPC reproduces denial without browser/provider scheduling. Absence/counterfactual: execute current source PullRequestStatusService against the same PR and local gh authentication. Exact result: [{"state":"merged","stale":false}]. Thus gh auth/API access and merged-state interpretation work with feature source while installed release lacks it. The missing release hypothesis survives; this source test does not by itself prove the full live encrypted UI path after installation.

## Root Cause
The bridge release was blocked by a version collision, leaving users on a same-numbered older artifact. H1 is rejected by production deployment/source evidence; H3 by frontend-independent denial. Recovery requires a distinct publishable version and prevention requires integration-time version validation. The existing immutable npm guard must remain intact. Live resolution cannot be claimed before the new artifact is released, installed and original UI reproduction passes.

## Ownership and initial briefs
Native workers reused, same task-owned shared checkout; no app writes until debug gate is fulfilled (3hypotheses,1rejected,1proven,5Whys,falsification). Root owns this investigation and all live UI/E2E/runtime experiments. Do not touch original dirty /Users/fkesheh/projects/ftown, user services/data, secrets or unrelated agents. Workers use rtk and Semble for discovery, no recursive agents.

W1 /root/pr_status_impl Tier1 gpt-6.1-terra xhigh: exclusive Git setup lease only. Fetch main; create NEW shared task checkout /tmp/ftown-live-pr-badges on fix/live-pr-badges from current origin/main, preserve old task checkout. Record SHA/branch. Read backend command/protocol/service and local encrypted client APIs to propose safe root read-only production RPC probe for current session a321895d-59ae-4575-b2ec-d7087392757b. Do not read/print credentials; do not restart/update bridge. No app changes or commits, tests/servers/CI. Return setup and bounded findings, release Git lease; root then assigns implementation exactfiles once proven.

W2 /root/pr_status_ui Tier1 gpt-6.1-terra xhigh: read-only frontend tracing using old checkout until W1 setup complete, then new shared checkout. Inspect Dashboard provider wiring and hook effects/visibility/ready states, identify falsifiable reason live data yields plain badge. Read-only no source edits/Git/servers/browser/E2E; root owns live UI and probe execution. May author scratch unit reproduction ONLY after root assigns exact path. Return file:line evidence, concrete focused experiment proposal and no speculative fix. No resource leases beyond read.

R1 reserved independent review Tier2 gpt-6.1-sol max once evidence/contract ready. All application ownership unassigned until proof; root only docs. No parallel writers; original checkout read-only.

## Repair brief / ownership (pre-freeze review)
Task R-release, owner /root/pr_status_impl, Tier1 gpt-6.1-terra xhigh, shared checkout /tmp/ftown-live-pr-badges. Root integration/Git/E2E owner; reviewer /root/pr_status_review Tier2 gpt-6.1-sol max read-only. No other writer. Root alone owns this investigation.
Writable proposed set: bridge/package.json, bridge/package-lock.json, scripts/release/publish-packages.mjs, scripts/release/publish-packages.test.mjs, scripts/ci/run-job.sh, scripts/ci/bridge-version.test.mjs (new), .github/workflows/bridge-version-bump.yml, docs/npm-release.md. Only version fields change in package manifests. Dependencies: proof gate complete; independent contract review before writes. Worker alone owns any dependency install/build output in this checkout after review; no shared servers/databases/environment changes.
Contract: export assertUnpublishedVersion(version, lookup = lookupVersion) from publish-packages.mjs; return undefined on both PACKAGE_NAMES absent, throw actionable Error if either exists, propagate lookup failures. Existing releasePlan exact-commit retry unchanged. Add CLI action check-version invoking this helper without requiring git commit/tag/network beyond two exact npm metadata reads. scripts/ci/run-job.sh bridge-version invokes node scripts/release/publish-packages.mjs check-version only inside existing packageChanged branch after version/lock validation. Add workflow path scripts/release/** so guard changes are checked; no merge_group or repository protection mutations. Use registry lookup existing structured-E404 semantics, never treat auth/network/malformed responses as absence. Tests injected, no real npm publish/tag/restarts. Recovery version next patch absent from BOTH npm names and bridge-v tag, expected0.19.63; if unavailable escalate proposed next patch before edits.
UX unchanged: supported new bridge returns merged and updater notices greater semver; oldbridge remains neutral/backoff. No changes to authorization, frontend polling, scheduling or badge component. Documentation must state new registry check detects already-published collisions at check time, not atomic protection against concurrent merges; strict current-base checks/merge queue remain operational requirement. Keep post-merge immutable guard.
Acceptance: record red test on old code and green on new; test absentboth succeeds, either-name existence fails including samegitHead, lookup errors fail, unchanged releasePlan retry succeeds. Integration fixture must exercise actual bridge-version branch with npm/runtime/git controlled locally and assert registrycheck invoked only for package changes, collision fails and unmodified package skips; avoid real apt/install/network. Commands node --test scripts/release/publish-packages.test.mjs scripts/ci/bridge-version.test.mjs; relevant release and CI unit suites; bridge build if dependencies available. Root executes any E2E/runtime. Handoff exact changed files, red/green outputs, limitations and explicit all leases released. No commits/pull/rebase/stash/push, no recursive agents. Others share checkout: never revert their changes or write outside exact ownership; escalate contract changes to root.

### Root verification plan / leases
Confirmed lookupVersion(ftown,0.19.63) and lookupVersion(ftown-bridge,0.19.63) both absent; checkReleaseTag false. Root alone owns runtime scratch, no current services started. UI planning worker released all leases, no changes. After W1 build: create fresh /tmp/ftown-harness-check.* HOME/data, env-i with pinned Node PATH; setup built CLI there; start built bridge --local --api-url http://127.0.0.1:9 --data-dir isolatedpath --bridge-id harness-check. No inherited DB/cloud/session selectors; ephemeral loopback listener. Assert harness --json status bridge up/id/PID, built artifact PR command/module present; stop exact captured process, verify exit, delete only owned scratch. This validates task artifact without restarting installed bridge; live production verification remains pending release/install.

### Contract freeze
R1 approved pre-freeze. check-version CLI branch must precede git rev-parse so no incidental Git requirement. Integrate new bridge-version.test.mjs into existing e2e CI unit invocation in scripts/ci/run-job.sh (not recursively from bridge-version). ReleasePlan/tag retry behavior unchanged. Runtime fixture copies real run-job with inert setup-runtime and controlled npm/git. Ownership validated: one writer W1 for exact nine files above; root investigation, R1 read-only. W1 now authorized implementation/build/dependency lease; Git and E2E remain root. Native worker IDs /root/pr_status_impl (Tier1 terra xhigh) and /root/pr_status_review (Tier2 sol max), no parallel writes.

## Implementation and verification handoff
W1 changed the eight source/test/release-doc files named in the brief, synchronized0.19.63 manifests only, and released all writes/build/dependency leases. R1 independently approved final diff without fixes; all task workers completed and hold no leases. No native close control exists; completed agents are idle, not running.
Regression red: /tmp/ftown-live-pr-version-red.log records old CI branch accepting collision/no npm calls and absent helper (additional package artifact test lacked pre-build dist). Green: focused3/3, then `node --test scripts/release/*.test.mjs scripts/ci/boat-runner.test.mjs scripts/ci/bridge-version.test.mjs`35/35; Node24.22.1 npmci/build and diffcheck pass. Root executed real check-version successfully: Both npm package names are available at0.19.63.
Root isolated runtime: fresh env-i HOME/data, local-only bridge, no cloud/database selectors; setup exit0, harnessstatus up/expectedbridgeId/ownedPID matched; built PR module/command present. Exact processes stopped and scratch deleted. Additional encrypted RPC probe initially used empty sessionIds and correctly received Invalid status request (probe mistake, minimum1 per command contract); corrected nonexistent isolated session ID produced command_response success=true, statuses=[] without a GitHub query. This contrasts installed artifact403 denial and confirms new handler works through encryption. Cleanup succeeded for every attempt.
No application behavior changed beyond release identity; no new full browser suite run for release-only repair. Existing feature CI passed prior to release failure. Original live dashboard still awaits merged/released/installed artifact; status remains root-cause-proven rather than falsely resolved. Full live showcase must be repeated after publication and upgrade. This PR is ready for review; no merge or production bridge restart has been performed.
