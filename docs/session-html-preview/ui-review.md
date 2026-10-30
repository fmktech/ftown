# Independent P2 UI/wiring review

Scope: bounded read-only review of the combined preview UI against frozen v1, base `9693fbb`; no app edits, runtime, E2E or service execution. Owner `/root/auth_review`, Tier 2 `gpt-6.1-sol` / `max`. This report is the only newly written review file.

## Concrete corrections

1. **Compact/touch terminal controls depend on the wrong view state.** Dashboard's MobileControlBar condition in the new SessionWorkspace integration uses `mobileTab !== "preview"` (`Dashboard.tsx`, immediately after the Terminal). Desktop compact view instead reads/writes `compactTab` in `SessionWorkspace.tsx:21,26,57`; choosing its Terminal tab does not change Dashboard's mobileTab. After registration sets global mobileTab to preview, this leaves the visible compact terminal without its touch controls. The same predicate hides controls on touch-capable wide desktop splits although Terminal is visible. Minimal correction: render the bar for any selected session and let its containing terminal pane's `hidden` state (`SessionWorkspace.tsx:65–72`) govern visibility. Existing coarse-pointer CSS still governs whether controls are applicable.

2. **Separator ARIA values can fall outside their advertised range.** `SessionWorkspace.tsx:73` rounds current ratio but rounds minimum upward and maximum downward, while CSS/keyboard clamp to the unrounded bounds (`session-preview.ts:43–49`, workspace `:53–55`). At main width655, the minimum is approximately37.09; Home renders aria-valuenow37 with aria-valuemin38. Use consistent numeric precision/bounds for current/min/max, or clamp both rendered ratio and advertised values to the same representable range. No layout redesign is needed.

Both corrections were sent to root for U1 ownership; reviewer has not edited application files. The role-query repair is separately complete: all authorized literal Workspace/Terminal queries now use tab while retaining their original class/behavior assertions.

## Verified wiring

- **Terminal stays mounted:** SessionWorkspace keeps one terminal-pane div and the same children position (`SessionWorkspace.tsx:71–72`); preview and tab changes affect sibling/hidden state. Existing Terminal initializes xterm once (`Terminal.tsx:202–204,370`) and session subscription changes remain in its existing effect (`:374–405`).
- **Refit path exists:** workspace invokes the provided refit on open/compact/view/width changes (`:35`) and divider actions (`:39,44`); Terminal's existing ResizeObserver fits after actual size changes, with its onResize handler sending dimensions (`Terminal.tsx:272–275,402–404`). Thus the synchronous drag refit is complemented by a post-layout measurement.
- **Visibility semantics:** Dashboard tracks choices by bridge/session and registration ID, prunes absent registrations, preserves a closed choice for the same ID, and treats a replacement ID as newly open (`Dashboard.tsx:341–370`). Selecting a session derives that session's own choice. Workspace navigation is retained and Preview disappears on clear.
- **RPC lifecycle:** preview consumes the existing sendCommand; target identity/client/user/visibility/readability/document visibility/security generation fence the hook (`useSessionPreview.ts:18–36,97–100`). Every status/chunk/digest await checks that generation before continuing/committing (`:57–59,71–81`). The sequential loop schedules the next poll only after completion, coalesces manual refresh and stops timers on cleanup (`:43,49–52,87–96`).
- **Revision behavior:** knownRevision is sent only for a complete verified document; unchanged preserves its key except manual refresh (`:57,62–65`). New bytes are fully assembled, digest-checked and UTF-8-decoded before commit; stale data is abandoned (`:67–84`; `session-preview.ts:20–37`). Prior same-target content remains while updating, while wrong-target/offline state is fenced before old bytes can render.
- **Layout:** split sizing subtracts the8px separator and enforces240px minima; actual main width below640 selects compact behavior. Pointer capture, drag shield and cleanup exist (`SessionWorkspace.tsx:25,36–50,73,78`). Frame is a single sandboxed srcDoc with fixed policy from the shared helper; P3 owns final security review.

Nonblocking observation: Dashboard passes its global securityGeneration to the hook. Runtime onChange fires even for another bridge or replacePins without a selected-target identity change (`secure-endpoint-runtime.ts:46–68`), so those events conservatively reload the current preview. This is safe but can reset interactive state; a selected-target trust token would avoid unrelated resets if root chooses a later refinement. No new shared API is required for the two corrections above.

Gate: source wiring is otherwise sound; approval awaits the two small U1 corrections and root's runtime/visual evidence. Report write lease released; app/test files remain released and read-only unless root returns a concrete repair assignment.

## U2 closure — both findings resolved; source approved

- `Dashboard.tsx:1094–1096` now renders the selected session's control bar inside the terminal pane without consulting global mobileTab. The existing pane hidden state controls its visibility in mobile/compact views. The new Dashboard regression selects compact Terminal after Preview and requires the controls inside its visible panel; the old predicate would leave them absent.
- `SessionWorkspace.tsx:73` now applies the same one-decimal conversion to ARIA min/current/max. The new 655px-width regression checks Home equals37.1 and End equals62.9, both within bounds, while the underlying240px layout constraints remain unchanged. It would catch the original mixed rounding.

U1 reports both regressions failed before repair, then the27-test Dashboard/workspace suite and UI tsc passed under Node24. Root separately reports installed E2E typechecking has no introduced spec/helper diagnostics; only the pre-existing UI store alias errors remain, with compiler configuration unchanged. Reviewer verified the exact source changes and both regression bodies, without rerunning tests or broadening the audit.

Final source gate: **approved, no remaining blocking P2 findings**. Root runtime/visual results remain the execution gate. This closure report lease is released.
