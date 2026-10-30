# Final verification

Root-owned final runtime and full bridge regression passed after W5 and integration with main254f6a6. Independent review approved in review.md. Bridge version0.19.67; npm release check confirms both names available at that version. No deployment/installation or merge performed.

## Results
- Node24.22.1 build passed (worker).
- Final fullbridge suite:1150 total,1146 passed,4 existing skips,0 failures,13892ms. Command from bridge: `node --import tsx --test --test-concurrency=4 'src/**/*.test.ts'`. FTOWN_BRIDGE_POINTER,FTOWN_DATA_DIR,FTOWN_HOOK_PORT,FTOWN_HOOK_TOKEN,FTOWN_SESSION_ID unset for fixture isolation. Log /tmp/ftown-pr-events-final-tests.log.
- Root `node --experimental-strip-types docs/investigations/pr-agent-events/runtime-smoke.ts`: PASS actual fixture-gh process/status service/watcher/controller/mail, authenticated encryptedHTTP parked longpoll, taskownedCLIharnessstatus, stoppedqueue/no wake, failure->pending->pass->merge, restartdedup, in-flightunlink and501 backgroundURLs under continuousforegroundchurn within shared quota. Final listener55862 closed and scratchcleanup completed. No realGitHub/userbridge/DB access.
- `node scripts/release/publish-packages.mjs check-version`: both npm names available at0.19.67. No publication performed by this command.
- Worker focusedtests/build/diffcheck history in implementation.md. Reviewer regressions cover mailbox/legacy/retry exception isolation, punctuationordering, unsupported PRnumber, malformed merge and atomic commit ambiguity.

## Environment and limits
Task checkout /tmp/ftown-pr-events; original dirty checkout untouched. LocalMac used after memorypressure38%free and load~5 did not show sustained pressure. Node_modules reused through tasklocal symlink from /tmp/ftown-pr-ci-status/bridge with matching dependencylock; excluded fromGit. No extra dependencies or testdatabase.
An initial fullsuite had9 CLI failures due to inherited FTOWN pointer/data selectors. IsolatedthreeCLI files passed22/22 after unsetting those selectors; no applicationfix forenvironment, finalfullsuite clean.

Durability covers atomic inboxenqueue across processrestart, not hardwarepowerloss/arbitraryexternalcorruption or guaranteedagentprocessing. Delivery admitted while running may finishafterstop; no autostart. GitHub statuses are sampled aggregate rollups with sharedquota/backoff; unobserved transitions between polls are not promised. Existing registrywide malformed-session enumeration failure remains outside this change.

PR/automaticCI result pending publication.
