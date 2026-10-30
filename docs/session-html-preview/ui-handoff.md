# U1 UI handoff

Implemented Dashboard preview over its existing BridgeRpc, with validated public descriptors and fail-closed invalid/cleared metadata, a generation-fenced sequential status/chunk loop, bounded canonical base64 assembly, SHA-256 and fatal UTF-8 verification, and fixed early CSP in an `allow-scripts`-only `srcDoc` iframe. Selected session security/connection/visibility changes invalidate reads. Unchanged polls preserve the iframe key; manual Refresh changes it. Registration visibility is tracked per session/ID and pruned with sessions. Desktop split has pointer/keyboard resize and drag shield; mobile/compact uses tabs while Terminal stays mounted.

Files: `ui/src/types.ts`, `ui/src/hooks/useSessions.ts`, `ui/src/hooks/useSessions.test.ts`, `ui/src/hooks/useSessionPreview.ts`, `ui/src/hooks/useSessionPreview.test.ts`, `ui/src/lib/session-preview.ts`, `ui/src/lib/session-preview.test.ts`, `ui/src/components/SessionWorkspace.tsx`, `ui/src/components/Dashboard.tsx`, `ui/src/app/globals.css`. Frozen protocol unchanged. No package/lock/node_modules changes.

Checks (Node 24.22.1, ui directory): `npm test -- src/lib/session-preview.test.ts src/hooks/useSessionPreview.test.ts src/hooks/useSessions.test.ts`: 85 tests passed; `npm exec tsc -- --noEmit`: passed. Tests are mock/pure UI tests and did not start a service or touch a database. React best-practices checklist reviewed for effect boundaries, stable terminal subtree, accessibility and responsive behavior. Root owns runtime, visual and E2E verification, which remain outstanding.

Selectors: `aria-label="Session preview"` (role region in desktop split, tabpanel in compact/mobile); iframe title `HTML preview: <fileName>`; controls `Open preview`, `Close preview`, `Refresh preview`; tab labels `Workspace`, `Terminal`, `Preview`; separator `Resize terminal and preview`. Status text includes `Loading preview…`, `Updating preview…`, `Preview file is missing`, `Preview exceeds the 1 MiB limit`, `Preview file is not valid UTF-8`, `Preview unavailable`, `Reconnect to load preview`. Retry is a button named `Retry`.

Root runtime reproduction: select a session, register an HTML file through the real CLI, check split geometry and keyboard resize, interactive iframe behavior, atomic replacement and unchanged state, manual refresh reset, close/reopen/new registration, missing/recovery/clear, mobile workspace tabs and terminal continuity, and sandbox negative cases. No browser, E2E, servers, CI or database operations were run by U1.

Write lease released for ui/ and this handoff; U1 is available for concrete review fixes after ownership is reassigned.

## Dashboard test fixture repair

Root's full UI gate exposed 24 `ResizeObserver is not defined` failures in `Dashboard.test.tsx`; reproduced with `npm test -- src/components/Dashboard.test.tsx`. Added a scoped jsdom `ResizeObserver` fixture that supplies an initial element measurement and cleans up after each test. Updated Workspace/Terminal role queries from button to tab to match the new accessible tab semantics, preserving the existing behavioral assertions. No production source changed in this repair.

Node 24.22.1: focused Dashboard suite passed 25/25; full `npm test` in a clean `env -i` passed 82 files and 828 tests; `npm exec tsc -- --noEmit` in the same clean environment passed. Existing jsdom navigation/canvas notices appeared but did not fail tests. No E2E, services or database setup run. Repair write lease on `ui/src/components/Dashboard.test.tsx` and this handoff released.

## U2 review fixes

Dashboard now keeps the selected session's MobileControlBar mounted inside the Terminal pane; pane visibility controls exposure in compact/mobile views. Separator ARIA min/max/current all use one-decimal precision while actual pane constraints remain unchanged. Added tests reproducing compact desktop Terminal controls after Preview and Home/End at a 655px width; both failed before the fixes and pass afterward.

Node 24.22.1 with clean `env -i`: `npm test -- src/components/Dashboard.test.tsx src/components/SessionWorkspace.test.tsx` passed 27/27 tests; `npm exec tsc -- --noEmit` passed. No E2E, browser, services or database work performed. Released U2 ownership of Dashboard.tsx, SessionWorkspace.tsx, their assigned tests and this handoff.

## U3 touch target repair

Root's focused mobile E2E found Preview tab height 40px versus the required 44px. Set `.mobile-tab` min-width and min-height to 44px; preview toolbar and state-message buttons now also have min-width 44px alongside their existing min-height. No test assertions or TS changed. Root will rerun the focused E2E; no unit, browser, E2E, services or databases were run for this CSS-only repair. Released `ui/src/app/globals.css` and this handoff.

## U4 quiet polling fix

Automatic status checks now leave cached content in its quiet ready state until a ready response starts an actual download. Manual refresh still displays the update indicator; unchanged automatic responses preserve the frame key. Added a deferred status/chunk regression that failed before the fix (automatic pending status incorrectly reported `updating: true`) and verifies quiet polling, manual indication and new-revision download indication.

Node 24.22.1, clean `env -i`: targeted hook, assembler and workspace tests passed 9/9; `npm exec tsc -- --noEmit` passed. No E2E, browser, service or database work run. Released U4 ownership of the hook, hook test and this handoff.
