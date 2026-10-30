---
type: investigation
symptom: CI preview refresh leaves Count1 iframe instead of resetting Count0
slug: preview-refresh-race
date: 2026-10-30
branch: fix/browser-device-actions
git_commit: 9be92a4
status: fixed
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---
## Evidence / gate
CI41102606566 previewline162: iframeCount1remains afterexplicitRefresh; traceclickcompleted75ms, accountGET overlaps (188283-188313). HypothesisH1 manualintentlostoneffectreplacement PROVEN: P1pairedunitexperiment ui/src/hooks/useSessionPreview.test.ts256-280, controlnotificationfalsePASS, unchangedauthoritynotificationtrueFAIL sameiframekey at279. SeedverifiedHTML/nonce, manualdeferredstatus, emit samefingerprint auth.notify, resolveoldinvalidated/newunchangedresponses. HTMLretained/verifyingclears butkeyunchanged. Command Node24 Vitest -t manual refresh survives an unchanged authority notification:1pass1fail13skip. Appsourceunchanged duringproof.
H2 malformed/absentpreviewdata REJECTED: identical validunchangedstatus+HTML resetskey incontrol, sameHTMLretainednotificationcase; CIiframeCount1visible. H3 genuineauthorityloss REJECTED: testusesunchangedfingerprint andruntime remainsready/readable; onlynotificationdiffers. Falsificationpairedcontrolremovesnotification causingkeyadvance; supportsrace independentofnetworkload.
5Whys: iframe notreset because manualflagfalse inacceptednewpoll; acceptednewpoll belongsreplacement effect; oldeffect consumedpendingManual into localbool beforeRPC thenepochchange invalidatedresponse; replacement initialisespendingManualfalse; userrefreshintent incorrectly lives inephemeral transporteffect ratherthan same-target authorized storelifetime.
## Ownership / proposed repair (awaitreview)
P1 /root/pr_status_impl Tier1terra xhigh owns previewtest.ts onlyuntilfreeze; product useSessionPreview.ts reservednext. Rootownslog/Git/E2E, R1Tier2solmax readonlyarchitecture. UI1cardfilesseparate alreadyreleased. Nooverlap.
Proposal preservemanualrequest intent across same-target unchangedauthorityeffectreplacement using store request/completionsequence counters. Pollcapturesrequestsequence, onlycurrentvalidatedresponseconsumes capturedintent; oldepochresponsesneverconsume/commit. Trueidentity/client/runtime/user/readable/subscriberchange andactualauthorityloss/fingerprintchange resetpendingintent withexistingclear. Visibilitypause maypreserve sameauthorizedtargetintent but nohiddenpolling. Repeatedclicks duringinflightcoalesceintoonependingnewrequest; finallyimmediatepoll onlyfor requestnewerthanthatcaptured atstart, notfor samependingretry, avoidingerror/stalerevisiontightloop. Successfulunchanged remountskeyonce iffrequestpending; verifiedchangedHTML alreadyremounts andacknowledgesintent. Terminalerror/unavailable/unregistered mayconsume capturedintent consistentlywithpreviousone-shotmanualsemantics, futureclickstillworks. Preserveallparse/chunk/hash/authority/epochvalidation andGETbudget cadence. Testredrace/control, lateoldreplyignored, realauthority/targetchangeclearsintent, repeatedclickcoalescing anderrornospin. Workerunit/static only; rootexactpreviewE2E inisolatedLinux. NoGit/E2E/server/deps/recursiveagents; otherssharecheckoutnooutsidewrites.

## Contract freeze / GO
R1approved exactlyproposed sequencecontract. P1nowowns ui/src/hooks/useSessionPreview.ts and .test.ts exclusively; allotherfilesreadonly. Acknowledge capturedsequence onlyafterepoch-currentvalidatedready/unchanged or acceptedterminalerror/unavailable/unregistered; stale_revision retainsintent fornormalcadence. Immediatefollowup onlynewersequenceaftercapture, multipleclickscoalesce. Trueclear resets counters, unchangedauthority/visibilityretains. Unitregressionsallrequired; rootE2Eonly. Navigationbaselinepassed unchanged4.7sdesktop/2.3smobile, previewbaselinepassed42.1s butdeterministicunitraceproven, no navigationedit. Rootinitialresourceleases unchanged.

## Implementation handoff
P1 released both owned files. The former red paired race/control now passes. Hook/workspace/parser tests: 26 passed; UI TypeScript and diff check passed. Coverage includes late old responses, repeated-click coalescing, error no-spin, stale-revision normal cadence, and true authority/target clearing. R1 final source review pending; root real preview E2E is included in the isolated six-case repair run.

Independent review: R1 approved the final card and preview repairs with no findings. UI1, P1 and R1 completed their assignments and released all file/resource leases. Root retains only integration and isolated E2E resources. Native completion is their retirement control; no unrelated sessions were touched.

## Final isolated verification
Root Linux run: all six E2E cases passed in 2.8 minutes, workers=2 and retries=0. Account-trust passed in 2.7 minutes; cross-browser names in 51.4 seconds; preview desktop/mobile and navigation desktop/mobile all passed. Also 83 focused UI unit tests, production build/typecheck, database/rate-limit/security/MCP smokes passed. Log /tmp/pr168-fixed-repro.log. No navigation changes, assertion weakening or retry/timeout increases were needed. Services and isolated browser trust were cleaned up by the guarded wrapper.
