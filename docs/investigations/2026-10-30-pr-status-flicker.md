---
type: investigation
symptom: "PR #164 · CI running (orange) -> PR #164 green then back"
slug: pr-status-flicker
date: 2026-10-30
branch: fix/compact-pr-badges
git_commit: b9bf547
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---
## Symptom
User reports orange running -> plain green PR -> running. Expected known status remains visible during refresh/reconnect; green neutral must not imply CI success.
## Hypotheses
H1 state/cache: ready-bridge candidate disappearance deletes known status; reconnect fetch restores it. Prediction direct controller setInputs([]) after known in_progress makes get undefined. PROVEN; see proof below.
H2 render: stale in_progress is rendered green/neutral even with retained status. Prediction retained stale running object renders absent status. REJECTED; see counterexample below.
H3 backend: ordinary fetch failure discards last known status. Prediction rejected read while inputs stable makes get undefined. REJECTED; see counterexample below.
## Ownership / investigation brief
Same shared checkout /tmp/ftown-live-pr-badges existing open PR164. Prior workers stopped. Root owns log/contracts/Git/E2E. UI1 /root/pr_status_ui Tier1 gpt-6.1-terra xhigh owns ONLY new ui/src/hooks/usePullRequestStatuses.test.tsx for bounded experiments/regression until proofgate. Readonly hook, provider and component. Reproduce H1 deterministic fake clock/transport: knownrunning -> notready candidates[] -> samecandidate ready -> restoredstatus after next eligible fetch; verify existing60secondrequestfloor unchanged. H2 render existing tests/explicit staleRunning component evidence; H3 rejected request with stable inputs should retainstale. Use existing Vitestsetup, mocked transport, no services/E2E/realGitHub. No application edits until root records proofgate and explicitimplementationbrief. Otherssharecheckout never revert their edits/outofscope, no Git/deps/server/browser/recursiveagents. Return exact red/green evidence, candidate boundary design proposal and leases. Reviewer /root/pr_status_review Tier2 sol max readonly after diagnosis. No parallel writers.

## Proof gate before application edits
H1 PROVEN (state/cache): existing hook characterization passes known in_progress -> readyIds=[] -> get undefined; same readybridge returns but next query waits60seconds then restores running. Desired regression fails `expected undefined to match {state: in_progress, stale: true}`. Unit command Vitest usePullRequestStatuses.test.tsx:15passed/1failed. Application source unchanged at this stage; only experiment tests added. This proves a mechanism matching live report, not a captured live reconnect event.
H2 REJECTED (render): retained stale-running component test passes aria Last known CI running, var(--status-pending), SVG retained. No green fallback if status object survives.
H3 REJECTED (integration): rejected refresh while candidate inputs stable passes retained in_progress/stale/unavailable. Bridge refresh fail also only changes reason/nextAttempt, not state (pull-request-status.ts refresh fail); ordinary error cannot explain cache deletion.
## 5 Whys
1. Plain green appears because renderer receives no status and uses neutral accent.
2. No status because UI controller deletes its cached value when candidate owner disappears.
3. Owner disappears when bridge temporarily leaves ready IDs even while session still links same PR.
4. One ready-only candidate set serves both refresh scheduling and cache retention.
5. Availability and linked-data ownership were conflated; temporary transport readiness must govern polling, not invalidate known linked state.
## Falsification
Stable-input rejected-fetch and stale-running render counterexamples both retain orange running. Temporary readiness removal alone reproduces deletion and restoration without GitHub or backend changes. Hypothesis survives. useSessions.ts184-198 removes sessions on trust revoked/key_changed and account change; ordinary offline leaves linked rows. Actual session/URL removal must continue purging cache and rejecting late replies.

## Frozen implementation brief
R1 approved boundary. UI1 Tier1 terra xhigh now owns ui/src/hooks/usePullRequestStatuses.ts, existing ui/src/hooks/usePullRequestStatuses.test.tsx (earlier brief incorrectly called it new), and docs/investigations/pr-ci-status/visual-smoke.ts. Root owns investigation; reviewer read-only, no overlapping writer. Samecheckout/PR164.
Preserve exported statusCandidates ready-query dedup semantics. Add private full-linked candidate derivation with canonical URL/safe session validation, stable ordering, NO cross-bridge URL dedup. Controller setInputs(readyCandidates:Candidate[], enabled:boolean, linkedCandidates:Candidate[]=readyCandidates) uses bothlists in inputkey/generation. Retain cache only while exact bridgeId+canonicalURL exists among full linked owners; do not reassign provenance until newbridge acceptedreply. Mark retained nonmerged stale/reason unavailable when cachedowner is not ready-query owner, preserve merged. Remove truly unlinked/removed owner data; existing useSessions removes trustrevoked/keychanged/accountcleared rows so no provider/security/API changes. Keep due/reads/cursor and60s floor/five-minute backoff unchanged; noextraGitHub calls. Fence late responses on eitherlist change. Hook suppliesfull list from existing visible/selectedsessions, not readyfiltered; dependencykey containsbothlists. No persistent browsercache/new backend state/protocol changes.
Update characterization of bad deletion into durable regression; retain red evidence above. Tests readyempty/reready retainedrunning+noearlyRPC, actualunlink/ownerremoval purge, duplicatePR multiownerretention/provenance, immutablemerged, late reply rejection. Existing tests remain. Focused UI suites and TypeScript byworker. Visualfixture: expose controlled readyIds toggle; root will drive ready->[]->ready, verify running row keeps orange/statusicon and stale accessible label; mergedrow remains stable, noextraRPC beforedeadline; preserve prior geometry/link/menu checks. Worker editsfixture but root alone runs it. No Git/server/E2E/deps byworker, otherssharecheckout no reverts/outofscope. Handoff exactchanges/checks/allleasesreleased then R1diffreview and rootruntime.

## Resolution
UI1 implemented full linked ownership distinct from ready polling in hook and regression/visual fixture only. Prior failing keep-stale regression passes; focused UI suite50/50 and TypeScript passed. Root executed mocked browser fixture with exact ready->empty->ready flow in desktop260px, narrow210px and mobile390px; running remains pending-colored with SVG and stale accessible label, merged unchanged, noextraRPC. Existing geometry/keyboard/link/menu checks pass; screenshot visually inspected. Browser/server cleaned by fixture finally, no DB/GitHub/production calls. R1 independent final review approved without findings; all workers completed/releasedleases. Root updates existingPR164; live deployment pending merge. Resolution refers to reproduced defect in branch, not unobserved production deployment. No bridge cache change or additional polling introduced.
