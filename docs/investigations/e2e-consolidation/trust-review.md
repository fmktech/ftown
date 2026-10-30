# Trust-suite consolidation review

E2E-02; Tier 2, `gpt-6.1-sol`, `max`; shared checkout `/private/tmp/ftown-e2e-consolidation`, baseline `73c67cc`. Proposal only: no test/application implementation, runtime, servers, dependency installation, database or Git mutation. The only authored file is this report. Line references below refer to the unmodified baseline.

## Recommendation and preservation rule

Keep one real account-trust journey, one real automatic-approval journey and the independent display-name journey. Remove the second complete viewport execution of each trust journey only after moving its distinct mobile actions and rendering checks into the retained journey at the same live state. Use real UI, native browser IndexedDB, real bridge processes and the existing signed protocols; do not replace enrollment with seeded authority or mocks.

The primary account-trust page starts at 1280; its second browser remains 390. The primary automatic-approval page starts at 1280 and visits 390; its candidates remain 390. All cryptographic, persistence, network-failure, cancellation, transport and revoke assertions below remain browser assertions in their existing feature owner. Unit coverage is supporting evidence, never the replacement for them.

The proposed first-wave removals are:

| Removed execution | Exact surviving owner |
| --- | --- |
| Entire `account trust: ... (390)` instance generated at `e2e/tests/account-trust.spec.ts:133-355` | The retained account-trust test currently named `(1280)`, including A01-A16 below and the explicit mobile schedule below. |
| Entire `automatic device approvals: ... (390)` instance generated at `e2e/tests/pending-approvals.spec.ts:12-205` | The retained automatic-approval test currently named `(1280)`, including P01-P13 below and explicit mobile navigation/review/reject/confirmation actions below. |

Retain the entire display-name test, including shell/reconnect/phone Access prelude (`e2e/tests/device-display-names.spec.ts:46-60`), in the first wave. Its repeated assertions have a survivor in A10, but assertion redundancy alone does not prove its readiness/pin-restoration setup is removable. Investigate and measure it separately before any deletion.

Do not combine the display-name journey with the revoke journey: independent accounts and grant snapshots keep the name invariance failure local and avoid coupling rename assertions to later revocation or pending-approval fixtures.

## Account-trust assertion matrix

All rows survive in the retained account-trust test. Removing only the 390 parameter currently removes a duplicate execution of every row except A13, which already runs only under the 1280 parameter. Mobile UI assertions/actions are made explicit in the proposed schedule; a desktop-only retained test with no such edits is not equivalent.

| ID | Distinct assertion(s) and baseline location | Surviving assertion / required treatment |
| --- | --- | --- |
| A01 | UI login, explicit first-computer pairing, nonextractable HPKE/ECDSA private keys and exactly one initial account device, `:139-147`; pairing helper `e2e/helpers/account-pairing.ts:101-110`. | Keep all. Login remains a real credentials form. First-account bootstrap also remains a mobile action in P02. |
| A02 | Navigation at 1280/900/390/320: mounted dashboard navigation and Security; mobile connect/approval controls; all visible mobile targets >=44px; Escape restores menu focus and hides navigation; exactly one push controller survives resize; diagnostics visible, no nested button, >=44px on mobile; no horizontal document overflow, `:20-59`. | Keep the complete helper and one invocation at `:148`. It currently performs exactly the same four-width loop in both parameter cases. Do not narrow the width list or omit push-instance persistence. |
| A03 | Access selected by default, computers heading, current shared-computer explanation, last-admin remove disabled and explanation visible, no overflow, `:149-156`. | Assert the same states at 1280 and 390 in the retained live first-device state; capture both views. |
| A04 | Second existing computer approved; newly logged-in mobile browser automatically creates a pending request, still has null trust after private-link request generation, `:158-183`. | Keep all, including `phoneAutomaticRequestId`, both existing computers and phone 390. Exercise second-computer pairing with the primary page at 390 to preserve mobile `/pair` interaction. |
| A05 | Reload restores exact private link without Generate/Refresh, matching comparison code, exact endpoint ID, and an actual GET poll to the same enrollment path, `:184-197`. | Keep unchanged. Retain boolean private-link comparison so assertion diagnostics cannot print the fragment. Candidate is 390 in both current parameter cases. |
| A06 | Different signed-in owner opening the private link is scrubbed to `/devices/approve`, sees waiting state, has no approve action and retains null trust, `:198-205`. | Keep unchanged; the foreign context is desktop in both current parameter cases. |
| A07 | Tampered signing proof produces a visible nonempty alert even in the approved browser's authenticated context, `:206-211`. | Keep unchanged, including real malformed link navigation. |
| A08 | Exact scrubbed approval URL and correct comparison code, no overflow, approval confirmation view, `:212-214`. | At this existing state, check URL/code and render at both 1280 and 390; return to 1280 for first approval, then 390 for retry. This preserves actual desktop and mobile approver clicks. |
| A09 | Real enrollment POST commits, then its successful response is deliberately lost; error visible and action enabled; membership added exactly once; retry succeeds, error clears, revision unchanged and membership still exactly once, `:215-240`. | Keep complete route-fetch/abort/retry mechanism and all state assertions. First approval click at 1280; after the error and one-member assertion, resize to 390, check alert/action/code remain visible and click retry. Do not replace with a pre-commit failure or only check final success. |
| A10 | Both existing computers appear, approval heading/stale error disappear, phone identity differs from approver, phone keys nonextractable, create a session on each computer, actual mobile reconnect document load, same endpoint/computers/running sessions restored, `:241-258`. | Keep unchanged with phone at 390 and both computers. Equivalent assertions exist in the display-name prelude, but its demonstrated fixture-readiness function means names stays unchanged. |
| A11 | Actual desktop reconnect document load restores approver identity, both computers and both existing sessions, `:260-270`. | Restore primary page to 1280 before this block; retain complete branch body unconditionally in the retained journey. Mobile reconnect in A10 does not replace desktop reconnect. |
| A12 | Hold an old account GET in a sibling native browser tab; approve a third/future computer; revision advances; delayed old response visibly fails as rollback/trust/conflict; newer head/read time/observed time and original endpoint survive; previously approved phone sees and controls future computer without another enrollment, `:271-296`. | Keep complete real two-tab race, delayed response, release in `finally`, three computers and native durable state assertions. Repeated 390 primary execution adds no distinct race or storage mechanism. |
| A13 | Future-computer shell and terminal marker round trip, forced cloud transport (direct sockets blocked, RTCPeerConnection disabled), UI says Cloud, observed encrypted envelope, neither session name nor marker appears in captured frames, `:161-168`, `:296-303`. | Keep all transport forcing and both frame directions on phone. A create-session row alone does not replace the terminal marker/privacy checks. |
| A14 | Obsolete automatic request cannot be approved; if still active, reject only this test-owned request. Fresh real unapproved browser creates exactly one visible layout request and retains null trust, `:304-329`. | Keep desktop-only setup and ownership checks unchanged. The explicit pending fixture is required by the prior 900x760 regression (`docs/investigations/2026-10-29-device-names-layout.md:10-13`); never delete it to shorten setup. |
| A15 | Access map: selected Access tab, each of three computers current/shared, pending heading and exact single pending row; four sizes 1280x900/900x760/390x844/320x760; settled geometry; header <=64px, content/document no overflow, scrollTop 0, exactly three bridge nodes, node heights >=44px, desktop nodes inside content, mobile controls >=44px. Browser/computer Enter selection sets `aria-pressed`, exactly one correctly scoped details region, remove affordance visible, computer details visible, no nested button; measurements attached, `:64-130`. | Keep whole helper and one invocation. It already executes once only in the retained 1280 parameter case. Screenshots/geometry at 900 with an actual pending panel are distinct coverage and are not duplicate screenshots to delete. |
| A16 | Phone listed; remove and confirm action; roster no longer includes it; last-admin remove disabled again; every task-owned bridge removes phone grant; reloaded phone shows revoked alert and cannot create a session, `:333-346`. | Inspect roster/remove affordance at 1280, resize same selected state to 390 and perform actual Remove + Confirm at 390. Render confirmation at both sizes before mobile confirm; keep document no-overflow checks. Retain all three-bridge polling and phone reload denial. |

### Required viewport schedule for retained account-trust journey

1. Bootstrap at 1280; run unchanged navigationEvidence (which visits all four widths and restores the starting size). In the first-device Access dialog, check A03 at 1280 and 390. Close at 390.
2. Approve the second existing computer at 390 via the existing helper, then restore 1280. All new-phone private-link creation/reload remains on the existing fixed 390 phone.
3. On the primary private-link approval page, render A08 at 1280 and 390, return to 1280 for the first approval click, then resize the failed-but-retryable live state to 390, verify error/action/code still visible and click retry. Keep the same pending request, keys and route interception across resize.
4. Restore primary to 1280 before desktop reconnect and the native two-tab history race. Keep desktop-only fresh pending-row setup and the complete four-size access-map helper. That helper already restores 1280.
5. At revocation, inspect the listed phone and selected details at 1280. Resize to 390, click Remove; verify the actual confirmation UI at 390 and 1280 (visible/enabled confirm, no overflow), return to 390 and confirm. Keep bridge grant removal and revoked phone reload assertions intact.

This preserves desktop/mobile affordance rendering and actual mobile connect, private approval, retry and revoke actions while executing viewport-independent trust mutations once.

## Automatic-approval assertion matrix

All rows survive in one pending-approval test. P09/P10 already exist only in its 1280 instance and remain unchanged. All candidates are already 390 in both current executions.

| ID | Distinct assertion(s) and baseline location in `e2e/tests/pending-approvals.spec.ts` | Surviving assertion / required treatment |
| --- | --- | --- |
| P01 | Landing encryption diagram visible, no overflow, full-page and diagram evidence, `:20-24`. | Visit 1280 and 390 before the same login, assert each, retain width-suffixed images. No extra account/bridge needed. |
| P02 | First login remains waiting for device approval; explicit first-account computer confirmation creates exactly one device, `:25-29`. | Assert waiting view at both sizes; execute this test's first-computer pairing at 390, then return to 1280. A01 separately preserves desktop first-bootstrap action. |
| P03 | Real automatic creation commits but response is dropped; waiting view has no comparison code/private-link textbox; reload restores same request and endpoint, trust remains null; sibling tab selects same request, `:31-50`. | Keep complete route interception, real reload and sibling. Candidate remains 390; this is not equivalent to private-link reload A05. |
| P04 | Pending-review navigation entry visible, row exists exactly once, Review produces matching code on trusted browser, candidate and sibling, both pages do not overflow, `:52-66`. | Open the review entry at 1280, verify row, close Security; resize to 390 and open menu/review entry again, verify same row and click Review. Check identical review code/rendering at 1280 and 390 without regenerating the offer. Capture both. |
| P05 | Candidate trust null before/after trusted confirmation; visible “Confirmed here. Waiting for confirmation”; separate local candidate confirmation action, `:67-83`. | Keep exactly this order. Execute trusted confirmation at 390; candidate is 390. A code match alone never replaces the one-sided denial assertion. |
| P06 | Real finish commits then response is lost; at least two outbound final actions are byte-identical; approval recovers without another confirmation click, no alert, candidate and sibling both reach real computer, pending request clears, `:73-93`. | Keep complete route action inspection/abort and exact replay assertion; no manual retry replacing automatic recovery. |
| P07 | Approved keys nonextractable; endpoint appears exactly once in checkpoint; stale approval-required alert absent, `:94-97`. | Keep unchanged. Although some key flags also occur in A10, this is the automatic-approval admission path's own result. |
| P08 | An unapproved same-owner browser opening an approval URL cannot approve; own pending request is retained. Trusted Reject yields rejected message, reload preserves rejected request and endpoint and null trust, `:99-110`. | Keep unchanged with trusted UI at 390 for actual Reject; candidates already remain 390. Do not conflate this negative boundary with A06's different owner. |
| P09 | Start a genuinely new request after rejection, hold valid approved history, second native tab locally cancels after remote finalization; both tabs remain cancelled/untrusted, reload stays cancelled/untrusted, `:112-148`. | Preserve full 1280-only block, held-history condition, cancellation ordering, native IDB checks, gate release and route cleanup. A12 is an older-history pin race and cannot replace this admission race. |
| P10 | Real CLI local IPC cancellation after candidate confirmation while reviewer has not confirmed: phase waiting→comparing→confirming, matching code, reviewer action enabled; rejectPending yields server cancelled, UI cancelled/no approve action; exact account history unchanged, `:150-174`. | Keep full existing 1280-only block. Browser cancellation does not exercise CLI watcher/IPC. |
| P11 | Virgin computer uses account inbox and local confirmation, waiting/comparing phases and matching code; actual CLI confirm followed by trusted browser approve; success, bridge pointer established, approved browser sees computer, `:177-192`. | Keep real `startAccountTestBridge(origin, user.email)`, local CLI commands and pointer polling. Render code/Review at 1280 and 390, require code/action visible and no overflow, then perform browser approval at 1280 per root's implementation brief. P05 preserves actual mobile automatic-browser confirmation using the same reviewer control. No private-link helper substitution. |
| P12 | Approved candidate can create session on newly approved computer; candidate endpoint remains same, no overflow on candidate/trusted view, screenshot, `:193-196`. | Keep unchanged. This tests automatic-computer propagation to an automatic-browser candidate, unlike A12's private-link path. |
| P13 | Context/bridge cleanup and failure propagation, `:197-203`. | Keep unchanged, as for `account-trust.spec.ts:347-352`. Removing executions must not skip stopping task-owned resources. |

Restore trusted to 1280 before P09/P10. After P10 completes, carry out P11/P12 at the stated widths, finishing the actual computer confirmation at 1280. Retain test timeout and all bounded assertion timeouts; there is no production polling/crypto timing change in this plan.

## Display-name assertion matrix

| ID | Baseline assertions in `e2e/tests/device-display-names.spec.ts` | Proposed surviving owner |
| --- | --- | --- |
| N01 | Real UI login, explicit account bootstrap, real 390 second browser/private-link approval and completion, target computer visible, exact phone endpoint, `:28-45`. | Keep in display-name test. No seeded authority, shared account or dependence on another test. |
| N02 | Approved phone Access shows shared computer, `:58-60`. | Keep unchanged in first wave. A later prelude-removal experiment must preserve this exact positive mobile access/readiness check in addition to N07. |
| N03 | Dashboard sees computer; actual account API trust snapshot; bridge grant for exact phone label/source account must first exist; exact whole bridge grant snapshot, `:61-69`. | Keep before any rename and compare whole snapshots at N09. Removing terminal prelude must not remove grant readiness poll. |
| N04 | Browser rename to reserved-looking “Browser” is shown on node; computer rename to Unicode “Office 💻”; success status and real label captured, `:19-23`, `:70-75`. | Keep all. This is feature behavior, not duplicate trust setup. |
| N05 | 900 helper initially hidden, visible in edit mode, inside scroll bounds with no horizontal overflow; 767 breakpoint Rename/Reset/editor/Save/Cancel targets >=44px, `:76-95`. | Keep all widths, conditional helper visibility and target measurements. General access-map geometry is not an equivalent editor-state assertion. |
| N06 | Security dialog no horizontal overflow at 1280/390/320; visible mobile button/summary/input heights >=44px; screenshots, `:96-102`. | Keep unchanged. Access-map tests use a different selected state/controls and do not replace these. |
| N07 | Native phone reload and Access show both synchronized names, `:103-105`. | Keep unchanged plus N02's moved shared-computer assertion. |
| N08 | Foreign signed-in account cannot list target browser's name; PUT for either browser or computer returns 404, `:106-114`. | Keep real foreign login, GET and both PUT requests. A06 concerns trust authority and does not replace names IDOR checks. |
| N09 | Reset computer name removes custom text; reset browser restores original label; account trust and complete bridge grants byte/structure-equivalent to snapshots, `:115-120`. | Keep unchanged, including both targets and exact full snapshot comparisons. |

No display-name source/import change is proposed for the first wave. A later candidate removal of `:46-57` must first prove the rename journey passes without shell/reconnect setup, including N02/N03's positive phone Access/grant readiness, and preserve every N01-N09 assertion. Historical `rtk git log -8 --oneline -- e2e/tests/device-display-names.spec.ts` identifies its introducing squash commit `a5303b4` (`Add account-wide device display names (#154)`). More decisively, `docs/plans/2026-10-29-device-names.md:43-49` records: final grants changed after an early baseline; waiting for the phone account grant still failed at 15s; merely opening phone Access stayed Connecting before any rename; the successful 46.5s run added the shell + explicit reconnect + verified phone sharing before baseline. The prelude has a demonstrated readiness/pin-restoration purpose. Retain it; duplicate postconditions alone do not justify deletion. The separate layout investigation also proves the importance of dense pending-state fixtures (`docs/investigations/2026-10-29-device-names-layout.md:15-18`, `:30-36`).

## Supporting unit/security evidence inspected

These existing tests confirm why viewport-independent duplicate execution can be removed; none is proposed for deletion or as a substitute for the surviving E2E assertions:

- `ui/src/lib/account-security-client.test.ts:66-96`: ordinary login cannot establish unpinned trust, exact explicit first bootstrap, one browser learns future computers without another enrollment.
- Same file `:99-123`: older/empty history and late sibling-tab reads cannot replace newer head/read clock; `:149-154`: last-admin and cross-owner mutations fail before submit; `:177-198`, `:238-252`: startup current-read requirement, integrity latch and cross-tab revocation denial.
- Same file `:299-350`: same durable enrollment after lost response/remount; no expired/different-key replacement; publication retry does not add twice; `:378-392`: losing/aborted atomic admission never exposes ready.
- `ui/src/lib/browser-identity.test.ts:47-52`, `:55-77`: secure context/durable storage required and cleanup cannot delete a newer enrollment.
- `ui/src/lib/pending-approval-client.test.ts:98-134`, `:159-178`: both local confirmations required, exact reload/finish replay, two-tab request/offer coordination, changed anchor blocked. `:244-259` and `:271-298`: held-history cancellation wins admission, stale comparison cannot confirm replacement, admission-winning CAS loss is handled correctly. Real native browser cancellation race remains P09 because the unit storage is injected.
- `ui/src/lib/pending-approval-storage.test.ts:21-44`, `:53-78`: cross-tab CAS, nonextractable structured-cloned HKDF key, atomic trust/candidate completion, cancellation/transcript/trust changes block held completion and stale replay.
- `bridge/src/security/pending-approval-crypto.test.ts:87-111`, `:132-188`, `:266-272`, `:319-347`: real WebCrypto authority/role/transcript binding, secret-free wire objects, both confirmation provenance, revoked candidate/signer denial and strict state parsing. These are protocol assertions, independent of CSS viewport.

Helpers retain their exact public interfaces: `startAccountTestBridge`, `approveAccountComputer`, `createAccountShell`, `accountBrowserState`, `pendingBrowserRequest`, `usePrivateApprovalLink` in `e2e/helpers/account-pairing.ts`. `createAccountShell` proves a created visible session, not terminal round trip (`:114-121`); the actual marker helper in `e2e/helpers/app.ts:164-179` proves bidirectional PTY delivery. Keep that distinction in A13.

## Measurement hypotheses and execution gate

Historical passing report `/tmp/ftown-e2e-investigation/results.json`, from the prior sample cited in coordination (cross-revision evidence only):

| Test execution | Seconds | Disposition |
| --- | ---: | --- |
| account-trust 1280 | 151.219 | Keep, add existing-state mobile views/actions. |
| account-trust 390 | 131.731 | Remove duplicate ceremony after mobile transfer. |
| pending-approvals 1280 | 71.851 | Keep all unique races, add existing-state mobile views/actions. |
| pending-approvals 390 | 40.377 | Remove duplicate ceremony after mobile transfer. |
| device-display-names | 46.588 | Keep unchanged in first wave; defer prelude experiment. |

H1: Removing the two complete duplicate journeys eliminates 172.108 historical test-seconds before added viewport checks. It avoids five bridge startups/setup/teardowns, six isolated browser contexts and three registered account users. No savings claim depends on weakening cryptography, transport selection, poll intervals or security state.

H2 (deferred): Display-name prelude removal could avoid one shell creation, its cleanup, a real document reconnect and repeated Access opening. Its necessity and saving are not yet measured; do not include this change or any presumed saving in the first-wave result.

H3: Added viewport rendering/actions reuse established state and add no bridge/account enrollment. Their actual cost should be recorded per phase. Historical worker1 executed account 1280 and 390 serially; worker2 began names roughly 159s into the run, followed by both pending cases. Removing account390 therefore does not reduce historical wall time by its full duration. On that unchanged schedule, pending390 removal alone lowers the final Playwright lane from 318.635s to approximately 278.258s before names savings/added checks. Historical job execution was 513s, roughly 194s outside Playwright; these trust changes alone do not demonstrate whole-job <300s. Exact-revision baseline and root's setup/scheduling work are necessary.

Add named `test.step` phases while preserving variable lifetimes and cleanup: account `bootstrap/navigation`, `private request reload and authority boundaries`, `lost response approval`, `existing-computer reconnect`, `future computer and stale tab`, `cloud terminal privacy`, `responsive access map`, `mobile revoke`; pending `landing/bootstrap`, `request reload/two tabs`, `mobile two-sided confirmation and finish replay`, `untrusted URL/reject`, `browser admission cancellation race`, `CLI cancellation`, `mobile computer approval`. Emit timing through Playwright steps; do not add retry loops or application timeouts. Leave names unchanged in this wave.

Implementation gate: root freezes this mapping and assigns one writer to exactly `e2e/tests/account-trust.spec.ts` and `e2e/tests/pending-approvals.spec.ts`. No names/helper/production module edit is required. Worker may run strict E2E TypeScript only (`rtk npx tsc --noEmit -p tsconfig.json` in `e2e`); root alone executes the changed two-file browser selection and combined suite against the exact baseline snapshot, checks screenshots at both approver widths plus 900x760 with live pending panel, reviews JSON step timings and failures, and verifies cleanup. Broad checks remain root's coordination decision. If any surviving assertion depends on removed setup, report the concrete state dependency before redesigning it.

## Independent pre-freeze implementation-brief review

Reviewed root's pending `implementation-brief.md` after this matrix. **Accept its two-file scope and contracts with this report incorporated as the coverage requirement.** No missing security invariant or shared interface change was found. Account desktop first approval/mobile retry, mobile second-computer pairing, mobile revoke, mobile pending-browser approval/reject and desktop final-computer confirmation preserve distinct actual action coverage. The final computer review must also render its code/action at 390 before desktop confirmation (P11).

Four details should be explicit in the brief before dispatch: P01 landing diagram/evidence at both 1280 and 390; A03 initial Access/last-admin state at both widths; A09 mobile retry retains visible error/code/enabled action before clicking; A16 actual revoke confirmation renders at both widths before mobile confirm. These are already required by the incorporated matrix; spelling them out prevents accidental interpretation as optional screenshots. Root alone implements the brief clarification; reviewer did not edit it.

Names history review above confirms the root's decision to leave that entire test unchanged. No prelude removal is included in the accepted first-wave contract.

## Handoff

Report complete; no checks executed beyond source/report reads and historical JSON inspection. No runtime claim is made. No application/test source changed. Sole report write lease released; STOP-WRITE. No process, server, database, Git or dependency lease was acquired.

## E2E-04 independent source review

**ACCEPT SOURCE; no blocking finding.** Reviewed the stopped writer's actual two-spec diff against baseline `73c67cc`, the frozen implementation brief and A01-A16/P01-P13 above. This accepts source equivalence, not type correctness, browser behavior or the execution-time goal; those remain root gates. The display-name prelude remains intact.

Reviewed snapshots (SHA-256):

| File | SHA-256 |
| --- | --- |
| `e2e/tests/account-trust.spec.ts` | `2000e5ec0746ade0d815d7c0abf87348b4f2232e2d1b7a9710a9e342508b7253` |
| `e2e/tests/pending-approvals.spec.ts` | `bfb7209e3909bfbe9a729548f4526ca75c754c72ed872d31fe8be9a55117435a` |
| `e2e/tests/device-display-names.spec.ts` | `408a901d1a071a232a5a20b29b8ca989453be9d5247b8774a5b5a75ef6997aa7` (byte-identical to baseline) |

Static source evidence:

- A read-only counter comparison of trimmed assertion-bearing source lines (`expect(` / `expect.poll(`) against `git show 73c67cc:<path>` found no removed baseline assertion line in either changed spec. The two outer viewport iterations are removed; all former desktop-only blocks now execute unconditionally. Manual control-flow review found no early return or new condition that bypasses their assertions.
- `account-trust.spec.ts:1-130` is byte-identical to baseline, preserving every four-width navigation/access-map measurement, target-size/focus/keyboard assertion, single pending row, current edge and screenshot attachment. The real pending-request fixture remains at `:325-350`; it is not replaced with a synthetic row.
- Account first-device Access/last-admin checks render at both sizes (`:149-159`); closing at 390 means the second real `approveAccountComputer` executes on mobile (`:160-163`). Primary viewport is restored immediately afterward.
- Private approval comparison renders at both widths (`:216-224`); first real POST executes at 1280 (`:238-244`), and the same failed-but-retryable request retains error/code/enabled action before an actual 390 retry (`:245-255`). Exact committed membership count and unchanged retry revision remain. Both reconnect actions still wait for a real document load (`:266-290`); primary is explicitly restored to 1280 before desktop reconnect.
- Real sibling-tab stale history, newer durable head/timestamps, future computer, forced cloud terminal marker/privacy and gate release remain (`:291-353`). `thirdId` remains inside the callback that also consumes it for access-map evidence; all later grant-revocation checks use the outer `bridges` list. Step scoping loses no resource/reference.
- Revocation checks desktop remove availability, performs Remove at 390, renders the same live confirmation at 390 and 1280, returns to 390 and actually confirms (`:355-371`). All three bridge grant removals and revoked-phone reload/session denial remain (`:372-379`).
- Pending landing diagram has both widths and unique image names (`pending-approvals.spec.ts:20-29`); waiting renders both widths and explicit initial bootstrap executes at 390 before returning to desktop (`:31-40`). The lost-create/reload/same-request/same-endpoint/sibling flow remains unchanged (`:42-61`).
- Pending review entry opens at desktop, explicitly closes Security before resizing, then opens through actual mobile navigation and clicks Review (`:63-76`). Matching reviewer code renders both widths; actual trusted-only confirmation is mobile and candidate trust remains null until its separate local click (`:77-109`). Exact automatic finish replay, no second confirmation click, both admitted tabs and single membership remain (`:110-124`). `approved` is deliberately returned from the awaited step for the later endpoint check; it does not return from the outer test.
- Trusted remains 390 for actual Reject and rejected candidate reload (`:127-138`), then explicitly returns to 1280 before native browser admission cancellation and CLI IPC cancellation (`:140-205`). Gate release, cancelled trust denial, history equality and route cleanup remain in their original order. Final computer review/code renders both widths before reset to desktop, real CLI confirmation, explicit confirming phase and actual desktop approval (`:208-237`).
- Each test still records allocated contexts/bridges before later operations, preserves primary failure and serially attempts all context/bridge cleanup in outer `finally` (`account-trust.spec.ts:381-386`; `pending-approvals.spec.ts:239-244`). Held account/history gates retain `finally` release. Screenshot names introduced within a single journey are width-qualified; phase names contain no user credentials or secret URLs. No retry, skip, force-click, fixed sleep, timeout increase or production timing change was introduced in the reviewed specs.

Root verification remains material: typecheck the step return type and full E2E imports; execute actual modal resize/close/reopen/click transitions; inspect both approver widths and the 900x760 dense pending panel; record combined-suite timings and cleanup. No browser result or performance result is inferred from the assertion-line comparison.

E2E-04 review complete. Only this report was changed by the reviewer; no tests, runtime, servers, database, dependency or Git mutation executed. Sole report write lease released; STOP-WRITE.

## E2E-07 bounded waiting-layout repair review

**ACCEPT SOURCE; isolated runtime closure pending.** The root-owned controlled run's JSON confirms account-trust passed in 143.671s and automatic approvals failed only at the initial waiting-loop overflow assertion, before pairing/approval (`/tmp/ftown-e2e-consolidation-evidence/consolidated-failed-results.json`). Offline trace inspection confirms the 390 resize completed at trace time 199504.692ms and the failing document-width evaluation began at 199509.612ms, 4.920ms later. The inspected failure PNG shows the mobile waiting page. This supports a layout-settling explanation; the screenshot alone does not establish that the predicate eventually passes.

The repair at `e2e/tests/pending-approvals.spec.ts:36-37` checks the exact existing document-wide predicate `document.documentElement.scrollWidth <= innerWidth` with `expect.poll(...).toBe(true)`, bounded at 2000ms with intervals 25/50/100ms. Both waiting viewports remain. It changes when final geometry is sampled after deliberate resize; it does not narrow the measured element, relax the width comparison, alter UI/authority, skip a negative case, retry a test, use a fixed sleep, or increase the overall test timeout. Persistent overflow still fails within the explicit bound. The generic `noOverflow` helper and all other call sites are untouched.

Current pending SHA-256: `09f9089e09475fcd69bd6775c9391d37e4a5c267d0a456aebaaa69cde88e5ec2`. Mechanically replacing its one new comment/poll span with the prior `await noOverflow(trusted);` reproduces the exact E2E-04 accepted SHA-256 `bfb7209e3909bfbe9a729548f4526ca75c754c72ed872d31fe8be9a55117435a`. Account-trust and names hashes remain identical to the E2E-04 reviewed snapshots. Thus this repair contains no additional assertion/control-flow change.

Root should run the isolated pending journey with zero test retries, verify the same overflow predicate succeeds within its bound, and require every later approval/replay/cancellation/desktop/mobile/computer assertion to complete. A source acceptance does not convert the failed run into a pass or establish the 300s execution target.

E2E-07 source review complete; ready for root result review. Only this report changed. Reviewer performed offline source/hash/JSON/trace/PNG reads, no test, browser/server, database, dependency or Git mutation. Sole report write lease released; STOP-WRITE.

## E2E-07 runtime update and E2E-08 helper review

Root reports the repaired isolated pending journey passed in 82.270s with no retry, closing the E2E-07 reproduction. This is root-owned runtime evidence, not a reviewer-executed run. The later 15s action-budget run exposed three different readiness failures: disabled session creation in account-trust/names and an absent requested bridge option in pending approvals. Those are the bounded scope of the frozen E2E-08 amendment.

**E2E-08 ACCEPT SOURCE; three-spec runtime closure pending.** Reviewed only `createAccountShell` against the frozen amendment. Current `e2e/helpers/account-pairing.ts` SHA-256 is `7092dc4e0ab8da780c7d170825542b38c2aa7df21cc2a815eba6f876720bd6eb`. Reversing only the new readiness span reproduces the complete helper file from `73c67cc` byte-for-byte; no other helper behavior changed.

- `:115-117` waits at most 60s for the exact Create a new session button to become enabled, then executes its original normal click. Enablement does not bypass visibility, stability or pointer interception checks: a blocked click still encounters the configured 15s action budget. No forced action or click retry was added.
- `:119-121` polls for an option whose `getAttribute("value") === bridgeId`, comparing the unchanged string argument directly rather than interpolating a selector. It never accepts an arbitrary available computer. The subsequent normal `selectOption(bridgeId)` still selects that exact target and retains its 15s interaction budget; disappearing/disabled/blocked selection cannot silently choose another target.
- Both readiness assertions are explicitly bounded at 60s with nonsecret messages. They replace prior implicit waits within a test lasting up to 300s; no test/action timeout or production polling interval is increased. Missing readiness remains a failure rather than a skipped action.
- Function signature, shell selection, name fill, Create Session click, Workspace handling and 30s exact session-row assertion remain unchanged (`:114`, `:118`, `:122-126`). There are no new authority mutations, fixture allocations, cleanup changes or relaxed postconditions.

Root should run all three isolated account specs with the 15s action budget intact and require real target session creation plus existing security/grant invariants. Source acceptance does not establish that bridge readiness arrives within the chosen bound or close other runtime causes.

E2E-08 review complete. Only this report changed; no tests, runtime, server/browser, database, dependency or Git mutation executed. Sole report write lease released; STOP-WRITE.
