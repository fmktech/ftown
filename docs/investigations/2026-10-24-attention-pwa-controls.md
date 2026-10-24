# PWA attention notifications and mobile bridge controls

## Request and acceptance
User requests removal of the in-page attention popup in favor of PWA system notifications; add a dismiss × to each top Needs attention entry; enlarge bridge headers/controls on mobile.

- Reuse existing opt-in Web Push/service worker delivery. Do not create duplicate system notifications on page hydration/reconnect or request permission automatically. Sidebar attention remains the durable pending-state view, including when notification permission is unavailable.
- Dismiss × is an accessible independent control on each attention entry. It must not select/open the session, must call the existing durable dismissal, and must preserve a newer concurrent request or other sessions.
- Mobile bridge rows get readable sizing and at least44px touch targets for expand/collapse and any drag handle; preserve desktop compactness and hierarchy/drag behavior. No horizontal overflow at narrow widths.
- Root alone runs focused E2E/browser and visual checks; workers may run unit/static checks when assigned. Always PR, no merge.

## Ownership and dispatch
Shared checkout /Users/fkesheh/projects/ftown-simplify-all. Prior workers completed and leases released; reused native workers explicitly gpt-6.1-sol/high.
- /root/session_ui: read-only UI discovery then sole application/test writer after exact scope is frozen.
- /root/npx_review: read-only notification-path discovery, pre-freeze review and final review.
- /root/npx_implementation: sole Git prep/landing owner and assigned isolated unit/static validation.
- /root: coordination documents, E2E, visual verification and cleanup.
Four unrelated dirty investigation notes must stay byte-identical. No implementation writes authorized during initial discovery.

## Frozen implementation contract
Independent reviewer confirmed existing push pipeline already delivers fresh explicit attention via Web Push in foreground or closed app; hydration does not enqueue push. Service worker deduplicates via receipt state and notification click navigates without resolving. Keep explicit enrollment and owner privacy unchanged. OS notification dismissal itself does not resolve the dashboard ledger; the sidebar × does. Supported configured/opted-in hosted agent sessions use system notifications; unsupported/unsubscribed clients still have the top pending list. No backend/SW/runtime change or bridge version bump needed.

Sole implementation worker /root/session_ui owns11exactfiles (manifest), including deletion of obsolete popup/helper and their tests after exhaustive caller inspection. SessionList adds optional onDismissSessionAttention(sessionId):void; Dashboard passes existing durable clear callback. Top-entry wrapper contains separate native navigation and44px dismiss buttons, preserves full accessible message/name and three-line preview, and never navigates from dismissal. Mobile bridge drag/toggle/clear targets>=44px, label14px/icons18px, row comfortable spacing/minimum52px, desktop remains compact. Truncated bridge labels retain their full hostname accessibly. No new dependencies or exported storage/protocol changes.

Acceptance: popup absent; each × resolves only target through existing durable API, persists after refresh, and never selects session; existing open/reselect/prompt/PR behaviors remain. Mobile390touch and320px no overflow,>=44px measured controls, bridge collapse/expand works. Existing push-notifications.spec.ts validates real routes/service worker with external OS/provider boundaries simulated; root will run it alongside the two attention specs. Workers do not execute E2E or servers.

Branch fix/attention-pwa-controls starts at mergedPR133 main0e3e8c7; four unrelated dirty notes and both new coordinationfiles preserved. Baseline /tmp/ftown-attention-pwa-controls-notes-before.json. Ownership validation found no overlapping paths.

Validation-only scope addition: e2e/tests/push-notifications.spec.ts is the12th sole-writer file. Extend existing real-service-worker test to cover foreground dispatch before closing the page, preserving opt-in, closed-page display, deduplication and click checks. OS/provider boundaries remain simulated; no external sends. Root owns isolated Boatbx_rwwb34fs, small2vCPU/4GB, TTL3600, no-env/no-snapshots, exact base archive; install zsh prerequisite before E2E. All14paths mechanically validated with no overlap.

## Frozen handoff and review

Implementation worker stopped writing and released its twelve-file scope. Independent source review approved the frozen diff, including existing push reuse and independent durable dismissal. Runtime, static, unit and rendered checks remain pending. Integration worker receives only isolated unit/static/bridge-dist execution; root retains installs, E2E, UI production build, services, databases and cleanup.

## Static and unit validation

Boat bx_rwwb34fs: focused UI 28/28, full UI 447/447 across 39 files, UI and E2E TypeScript checks, and unchanged bridge 0.19.52 build passed. One Boat API connection reset occurred before command submission; bounded retry passed. Source stayed frozen. Check/dist lease released before root began E2E.

## Runtime and visual gate

Root ran the production UI build and all six focused browser tests in Boat bx_rwwb34fs after verifying every effective deployment selector targeted the sandbox-local ftown PostgreSQL database and localhost services. Build passed; browser tests passed 6/6 in 32.5 seconds (no retries), covering desktop/mobile attention, persistent dismissal, CLI/PR association, foreground/closed-page push-worker display, opt-in, owner binding and receipt deduplication. OS/provider boundaries were simulated; no external notification send is claimed. Source hashes match the reviewed snapshot.

Root visually inspected desktop and mobile output, including 390px and 320px bridge controls, restored attention, and the mobile PR menu. All accepted: independent visible dismiss controls, readable bridge labels, no horizontal overflow, and compact desktop layout. Tests measure 44px touch controls and minimum52px mobile headers. Production UI/bridge processes stopped, PID files removed, localhost ports443/3000/5432/8000 closed, and Docker services/volumes removed. Evidence is retained at /tmp/ftown-attention-pwa-controls-evidence/ and its .tgz archive. Sandbox deletion bdop_99489e45700946ebb1212e860452b994 completed at 2026-10-24T12:33:58.684Z.

No app/test edits occurred after source review or checks; four unrelated dirty notes remain byte-identical. Implementation and read-only review workers are complete/retired. The integration worker has the sole final Git/index/push/PR lease; no merge is authorized. Final PR URL and retirement are recorded in the external task handoff to avoid dirtying the committed report.
