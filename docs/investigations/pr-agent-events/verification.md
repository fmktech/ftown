# Verification

Pending implementation. Root exclusively owns runtime/E2E execution and any service resources.

Environment: task checkout /tmp/ftown-pr-events (canonical /private/tmp/ftown-pr-events), base7d0437a. Original dirty checkout is unchanged. Node24.22.1 available at /Users/fkesheh/.nvm/versions/node/v24.22.1/bin. Memory pressure query38% free and load~5 on this host did not demonstrate sustainedpressure; focused bridge-only runtime is appropriate locally. No database/deployment mutations are needed. Dependency locks match /tmp/ftown-pr-ci-status/bridge except packageversion; existing node_modules reused read-only.

Required runtime fixture: private temporary home/data; loopback ephemeral listener and ghfixture only; explicitly no real GitHub calls, existing bridge token, productiondatabase or user session. Test current-head failure->pending->pass->merge mail with dashboardabsent, inbox drain, retry/restart/pruning dedup, unlink/deletion fences, stopped noautostart and CLI harness status against taskownedserver. Teardown all fixture processes/directories in finally.

Final gates pending: implementation focusedunit/static evidence, independent code review, root runtime smoke, appropriate bridge regression suite, release classification/version/build checks, PR publication and automaticCI.

## Root runtime evidence before W3
Initial fixture actual gh process/status/controller/watcher/mail sequence passed. Extended fixture command ran with Node24.22.1 and FTOWN_BRIDGE_POINTER,FTOWN_DATA_DIR,FTOWN_HOOK_PORT,FTOWN_HOOK_TOKEN,FTOWN_SESSION_ID unset: PASS authenticated encryptedHTTP longpoll, taskownedCLIharnessstatus, stoppedqueue/no wake, failure->pending->pass->merge, restartdedup, in-flightunlink,501backgroundURLs under continuousforegroundchurn respecting <=60launches. Ephemeral listener50335 closed and scratch finally cleanup completed; no realGitHub/userbridge/DB.
Initial fullbridge suite1139total:1126pass9fail4skip. All9 failures CLI fixtures overridden by inherited FTOWN_BRIDGE_POINTER/DATA_DIR; isolated22 CLI tests passed with FTOWN selectorsunset. No source change forenvironment. Final cleanenv regression pendingW3.
