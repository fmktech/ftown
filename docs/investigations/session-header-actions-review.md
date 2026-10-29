# Session header actions independent review

Reviewed `ui/src/components/Terminal.tsx` and `e2e/tests/session-lifecycle.spec.ts` against the investigation brief. No concrete application-source defect identified in static review. Existing action nodes and handlers are passed through unchanged; the rendered DOM places the action cluster after the transport, usage, and running status. Responsive rendering and the actual action transitions still require root's runtime and screenshot checks.

## Coverage gap

`e2e/tests/session-lifecycle.spec.ts:67-87` measures the content wrapper, not the individual metadata elements or their DOM order relative to the action. Its shell-only UI-created session at lines 179-185 does not arrange any token usage. Consequently, the test can pass if an actual dense usage label overflows its wrapper and overlaps the action, or if metadata is reordered inside the wrapper. Focused coverage should render real persisted usage with a long model name, assert the usage and action order, and measure the actual metadata and action boxes at narrow and wide widths. Check running status and transport similarly where present.

An existing source-honest fixture path is `e2e/tests/usage.spec.ts:93-119` and `e2e/helpers/bridge-fixtures.ts:46`: seed a Claude transcript with a chosen model, then create a shell session through the bridge API with the matching `claudeSessionId` and working directory. `bridge/src/terminal-pump.ts:145-163` collects and publishes persisted usage after completion; wait for the usage to render before checking the completed Rerun header. Clean up the session and seeded files. The current UI-created lifecycle session does not provide that native ID, so this is a fixture change rather than an assertion alone. Live hook usage is restricted to pi sessions by `bridge/src/hook-usage.ts:37-42`.

No app code, tests, Git state, dependencies, servers, or E2E resources were changed or run by this reviewer. Report lease released.

## H2 review

The new fixture uses the existing Claude transcript and bridge API contracts, waits for completed status before the usage GET, and checks the rendered persisted usage and running status themselves for containment, horizontal separation, and DOM order at each requested width. It deletes the created session, transcript and unique working directory in a `finally` block. No concrete fixture or application defect identified statically. The earlier dense-usage coverage gap is addressed, pending root's focused runtime and screenshot review.

The transport badge is not included in the individual-node checks in `e2e/tests/session-lifecycle.spec.ts:90-104`; this remains a narrower coverage limitation for that metadata item. No E2E or browser execution was performed by this reviewer. Report lease released.

## H3 review

The new retrying computed `min-height` assertion waits for the target value after each viewport change before the bounding-box snapshot. It addresses the transition observed by root while retaining the existing mobile 44-pixel actual-height assertion and all geometry thresholds. No concrete defect identified in this delta. Runtime and visual closure remain with root; no browser or E2E execution was performed by this reviewer. Report lease released.
