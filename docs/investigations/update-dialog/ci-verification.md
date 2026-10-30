# Root CI repair verification

Failed CI run41102306295, PR167 head bd6d4e3 / tested merge50a3223170d04acdda2fb1ea9ea55d4bc50a8214. Node24.22.1 Linux. Five failing tests: update rows at1280/390, lifecycle header geometry twice, manual preview refresh. 66passed/2skipped. Full log downloaded to `/tmp/ftown-update-ci-failure.log`; artifact `/tmp/ftown-pr167-ci-artifacts`. No blind CI rerun.

Root ran `ci-repro.ts` using actual components at1280/900/390/320. Before fixes: production row selector matched0 despite relative lookup1 and installed1.0.0; Stop/Rerun minHeight auto despite actual32px desktop/44px mobile. Exit1,12 failed assertions. After fixes: production selector1, legacy negative-control0; exact min-height and physical dimensions match all widths. Exit0. Root reran visual-smoke.ts: all1280/390/320 passed. Both commands used Node24.22.1, ephemeral localhost server, no bridge or DB; browser/server cleanup completed.

Worker deterministic hook unit regression failed before product changes when current-epoch unchanged result retained old key after manual refresh + benign notification. Repair passes21 hook tests plus UI typecheck; other focused UI tests40/40 and E2E typecheck pass. R2 independently approved both repairs; no authorization/content-retention relaxation.

CI preview artifact shows version2 Count1 retained after manual refresh. Trace refresh click starts398960.709, completes399017.396; account GET starts399019.117 and succeeds30.001ms later. This corroborates but does not prove exact internal epoch sequence.

## Linux runtime resource lease
Root exclusively created Boat development sandbox `bx_bjk7x4j9`, default4CPU/8GB, no inherited account env, TTL3600s. Base revision archived read-only as bd6d4e3 to `/home/user/ftown-pr167`. No other sandbox/service reused. Root process19043 runs `linux-repro.sh preview`, using existing CI preflight to reject inherited overrides, assert localhost-only PostgreSQL and TLS endpoints, canonical scratch homes, and vacant ports before writes. Database exists only in sandbox Docker. Script preserves normal stop-services/browser-home/docker-volume cleanup. This repo's current CI uses Boat; no unrelated provider migration performed. Root runtime result and sandbox cleanup pending.
