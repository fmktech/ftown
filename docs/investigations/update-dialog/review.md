# R1 — pre-implementation contract review

Reviewed W1 against `BridgeUpdatesDialog.tsx`, `useBridgeUpdates.ts`, and `bridge/src/update-protocol.ts`. The component and protocol boundaries, exact eligibility predicate, native dialog lifecycle, manual-command allowlist, and assigned ownership are compatible. No shared interface change is needed.

Material clarification before freeze:

- Treat `availability: "unknown"` as **Update availability unknown**, not automatically as a failed check. `status: null` without an error message also represents the controller's initial idle state; reserve **Couldn’t check for updates** for an actual failure indication (for example a non-loading null status with the controller's unavailable/permission message). Loading takes precedence over stale availability. Keep controller messages visible without inventing an error for missing data.
- A failed or active update operation must not be presented as an unqualified healthy status, even if its retained status says `current`. Keep its actual phase and `view.message` prominent; distinguish a confirmed `view.complete` from a previous succeeded operation, as the existing component does. The status headline and phase must not contradict one another.
- Retain the existing unsupervised single-bridge eligibility context in the collapsed setup guidance, alongside the managed-installation instruction, even though the concise `unsupported_launch` warning is shortened. It explains the safe manual path and is part of the existing technical guidance.

Confirmation must guard eligibility at the click handler as well as disabling the control, and do nothing when eligibility has changed; the stated W1 race acceptance already requires this. Optional Node values remain independently optional. R1 owns only this report; source is read-only and no resource leases were acquired.

## R1 — W2 header icon contract review

Approved. The specified props and conditions preserve the existing `Dashboard.tsx` session-action behavior, callbacks, relaunch label/title, group label, and accessible action names. `HeaderTooltip` supports native-button children, hover and keyboard focus, Escape dismissal, and portal positioning without adding tab stops. The focused browser fixture should exercise the tooltip and real responsive button dimensions as specified. No material interface change is needed.

## R1 — combined final review, pending repair and root visual evidence

One material finding: `BridgeUpdatesDialog.tsx` derives `operationLabel` from `status.operation` before considering `view.operation`. The controller retains prior status while initiating a new operation, so an older failed or succeeded status can display “Update failed” or “Previous operation recorded” together with “Requesting update…”. When a new `view.operation` exists, only use a status phase if its operation id and target match; otherwise display an active operation label. Add a regression test for mismatched previous operation and a new pending request.

Dashboard extraction preserves the conditions and callbacks, and the header controls use accessible names, native buttons and `HeaderTooltip`. The dialog focus ring remains visible: `globals.css` provides `:focus-visible` box-shadow via `--focus-ring`, independent of the utility that removes the outline. Command allowlist, eligibility and callback guard remain intact. The React best-practices review found no material hooks, component, bundle or accessibility issue beyond the status finding. The focused harness exercises actual components at three widths and interaction flows; it does not replace a live bridge/database E2E. Root's browser and visual evidence is pending. R1 did not execute tests, servers, or browser runs.

### Operation identity repair closure

Reviewed the repair and regression test: a pending operation now uses a recorded phase only when both operation ID and target match. Prior failed/succeeded phases no longer displace the in-progress state, and a matching restarting phase remains visible. W1 reports 14/14 component tests and UI typecheck passing after the change. Finding closed; approval remains conditional on root's browser/visual gate.

### Final approval

Root reports the combined actual-component browser harness passed at 1280, 390, and 320 pixels, with desktop and mobile modal, header, Node-warning and confirmation screenshots inspected; see `verification.md`. The operation finding is closed and no further material issues remain in the reviewed scope. Approved. Report lease released; no application or shared-resource leases held.
