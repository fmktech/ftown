# Clickable compact PR badge: bounded architecture review

Tier 2 `gpt-6.1-sol` / `max`; shared checkout `/Users/fkesheh/projects/ftown-e2e-performance`. Sole writable file is this report. Read `PullRequestLink.tsx`, `SessionList.tsx:1056-1323`, `session-pull-request.test.ts`, the two specified prior investigations, URL parser and Semble-located `e2e/tests/session-tools.spec.ts`. No implementation, runtime, providers, tests or Git work.

**Recommend a native compact anchor as a sibling of the preserved draggable selection button, aligned through a small row/header CSS subgrid.** Keep the existing button element, handlers, selected details and row identity. A passive hidden placeholder reserves the current badge's exact intrinsic width; the real sibling anchor occupies the matching header/PR grid cell. This permits a native URL while preserving the user's small green 10px bordered badge.

## Scope and appearance

The new user instruction supersedes the prior deliberate passive-badge rule. Preserve the same text `PR #118`, `var(--accent)`, font size10, 1px muted border, radius3 and `1px 4px` graphic padding. Keep its current visual order after the flexible ellipsized session name, before an optional collapsed-descendant count and the status/time/actions group. Default terminal-header PR link and portaled menu PR action remain unchanged.

The original `button[draggable="true"]` is a public test/capture selector and must remain the same selection/drag target. Preserve `[data-session-row=session.id]`, depth indentation, selected/unselected padding9/6px, selected border/background, row dimensions, flexing `min-width:0` name, optional details and existing44px mobile actions. No sibling link should become a new right-hand column consuming extra width beyond the space the compact badge already occupies.

## Exact DOM and layout boundary

Use these semantic siblings inside the existing row wrapper:

```text
row wrapper: shared grid columns, header/details rows
  original draggable selection button: spans all columns and both rows; subgrid
    header: same subgrid columns
      tree/icon/name-or-input group
      passive badge placeholder (hidden visually and from accessibility tree)
      optional descendant count
      existing status/time/actions group
    details: spans all columns; existing selected content
  native compact PR anchor: matching header/PR cell; outside selection button
```

Only header layout is reorganized into shared tracks: flexible content, intrinsic PR width, optional count and intrinsic metadata/actions. Preserve the current 6px gaps within the name/badge/count group and 8px gap before metadata; empty optional cells must not leave extra gaps. `subgrid` lets the placeholder and actual link share the same natural width without reading DOM rectangles. Keep body content spanning the existing width.

The sibling anchor must not alter grid sizing. Position it within the explicit header/PR grid area over the placeholder's reserved cell. Center the visible graphic in the real header content box: account for the existing selection button's top padding, selected header bottom margin and active drag-top border through the same declarative values, rather than an independent hardcoded Y/right offset. The header track must size naturally for 20px desktop actions,44px mobile actions and a rename input; do not assume the whole selected button is a single header-height row. Hover/focus should use existing tokens; visible focus is allowed, rest-state badge styling stays identical.

Keep `PullRequestLink({ url, badge? })`'s default header output unchanged. Its compact `badge` output becomes a native parsed anchor. A small separately named `PullRequestBadgePlaceholder({ url? })` export from the same file can reuse its private compact graphic/style and render only an `aria-hidden`/`visibility:hidden` noninteractive span. Both return null for invalid/missing URLs. This is an internal UI interface; do not duplicate parser logic or compact appearance constants in SessionList.

An absolutely positioned sibling over a passive placeholder is semantically valid. A measured rectangle/ResizeObserver version adds layout effects, invalidation for timestamp/rename/selection/font/resize changes and per-row lifecycle work. The shared-track version avoids those dependencies. A fixed right offset is unreliable because timestamp, descendant count and mobile actions have variable widths. A whole row/background-button rewrite is unnecessary for this bounded badge change.

## URL and event contract

- Use existing `parsePullRequestUrl`; canonical HTTPS github.com PR only, `_blank`, `rel="noopener noreferrer"`, full repository/number/URL accessible name and title. Keep the visible compact number unchanged; hide only the duplicate placeholder from accessibility.
- Native pointer/touch/Enter/default context-menu navigation must remain. Do not call `preventDefault`, `window.open`, selection, attention dismissal or mobile terminal switching. Since the anchor is a sibling, selection-button handlers cannot receive its bubbling events. A local propagation stop may protect an ancestor handler if needed, but must not cancel the native action.
- The anchor must not be a descendant of a button or role-button. Mark native link dragging false if necessary so dragging the badge does not start a URL drag; row dragging from the original selection region stays unchanged. Keep its existing context menu/long-press behavior on that selection region.
- Keep existing tree/menu/name-edit handlers and draggable button keyboard behavior. The new anchor follows the button subtree in DOM tab order; test actual Tab reachability from the existing Session actions control rather than assuming it is the button's immediate next stop. Enter opens the native link; Space retains normal anchor behavior. Focus must remain visible at the compact badge without clipping.

## Bounded checks and ownership

Proposed implementation owner may write only `ui/src/components/{PullRequestLink.tsx,SessionList.tsx,session-pull-request.test.ts}` and `e2e/tests/session-tools.spec.ts`, plus its handoff. Header/menu/attention logic and the broader tree stay in scope only to preserve their existing behavior; no hook, backend, parser or unrelated layout changes.

Update the passive unit case to require one real sibling anchor, canonical/safe attributes, unchanged compact graphic styles, an inaccessible noninteractive placeholder, no anchor inside the original button, preserved draggable identity/name and no select callback from badge activation. Assert menu/header behavior and invalid/replaced/cleared URLs remain. Keep attention after ordinary completion/failure/elicitation and deliberate selection/dismissal coverage.

The existing focused runtime path is `e2e/tests/session-tools.spec.ts`, desktop1280 and touch-mobile390 cases. It currently asserts the badge is passive at lines182-186 and later; revise those obsolete assertions while retaining the menu regression. Use intercepted GitHub popup destinations already present: test badge keyboard Enter and real click/tap, canonical URL/new-tab safety, unchanged observer selection and explicit attention, then deliberate normal row selection, PR replace/clear/reload and draggable identity. Keep44px mobile action/menu bounds, no overflow and capture actual row screenshots including long names/selected details/child counts. Compare the compact badge font/border/padding and original row/name geometry at both widths; no enlarged visible PR button is accepted.

Root alone executes `playwright test tests/session-tools.spec.ts tests/session-needs-attention.spec.ts` (existing four-case focused gate), unit/static/build and rendered comparison after the writer releases. New unit assertions cannot establish grid geometry in jsdom; actual browser evidence is required before claiming exact appearance preserved.

Bounded architecture report complete; sole report lease released. No source changes or runtime operations. Root may freeze the exact CSS/DOM ownership contract and dispatch the idle integration worker.

## Released implementation source review

Read the released four-file implementation and handoff against the frozen badge contract. **No application-source blocker found.** The compact graphic and placeholder share the same parsed URL and style; the native link is a sibling of the preserved draggable selection button, with canonical safe new-tab attributes, a full accessible name, visible keyboard focus and native navigation. The header/default link is unchanged. SessionList shares the conditional PR/count/header tracks through subgrid, keeps the prior indentation, name ellipsis, selected details and existing action handlers, and aligns the overlay with the same selected/drag padding values. No measurement effect, new state, nested anchor or `window.open` was added. Native sibling events do not invoke the selection button or attention dismissal.

The unit changes check native DOM/URL/style and no-selection behavior, invalid URLs, replacement/clear and the retained header/menu behavior. The focused browser changes retain the real CLI/attention/hooks/menu path, add actual badge keyboard and pointer/touch popups while preserving observer selection and outstanding attention, and compare the actual anchor/placeholder geometry and compact styles. Long names, selected details, child counts, thinking state and mobile actions are represented; exact appearance remains a browser/visual gate.

**One P2 test setup correction is required:** `e2e/tests/session-tools.spec.ts` near208 waits for the new child row to be visible before clicking “Collapse children.” `SessionList.tsx:596–623` deliberately collapses each newly seen parent by default, and selecting that parent only opens its bridge group. Explicitly activate the real “Expand children” control and assert the child visible before retaining the existing collapse, hidden-count and badge-geometry checks. Do not relax visibility assertions or change production tree defaults. Reported directly to root for the same implementation worker.

Source review otherwise accepted. Root alone must establish exact selected/unselected desktop/mobile geometry, original row/name dimensions, native popup behavior, unchanged selection/attention and required passing checks. No tests/runtime/browser/Git/application writes by the reviewer. Sole report lease released pending the concrete test setup repair and actual runtime/rendered evidence.

## Source repair and first desktop visual closure

The P2 default-collapse setup finding is closed: the released test explicitly activates the native Expand control, verifies expanded state and visible child, then retains Collapse, hidden-count and strict geometry assertions. A subsequent trace-backed test correction selects the exact session-name text inside the draggable button, because the generic button-center point now legitimately lands on its sibling badge. Dedicated badge Enter/click/tap popups, canonical destinations, observer selection, outstanding attention and the later deliberate selection/menu/reload/clear checks remain; no production change, forced click or assertion relaxation was introduced.

Independently viewed `/tmp/ftown-fleet-media-20261027/badge-desktop-r1.png`, which root identifies as final application source with strict anchor/placeholder geometry passed. **Accept this desktop selected/long-name/collapsed-child state visually:** the small green bordered PR badge remains between the name ellipsis and child-count/status/time/actions, aligned within the row with no visible overflow, enlarged graphic or overlap. This image alone cannot establish native navigation, focus, other states or exact pre-change row dimensions. Final mobile/interaction evidence and remaining selected/unselected/thinking views remain root-owned pending gates. No reviewer runtime/tests/browser/Git/source writes; both current report leases released after this bounded review.

## Thinking-state matcher source closure

**Approve the bounded test-only matcher correction.** `SessionList.tsx:1296–1320` renders the fixed aria-hidden `◌` glyph immediately before the actual selected thinking label. The focused test now uses anchored `^◌\s*thinking\.\.\.$`, retaining exact thinking-state text and admitting only its real decorative prefix/spacing. It cannot match a tool-use label or arbitrary preceding/following content. The received PostToolUse hook check, selected badge geometry/screenshot and outstanding-attention assertions remain. Root's actual snapshot already established that the thinking state existed; the prior failure was the text matcher, not evidence of a production status defect. No application change, relaxed timeout, skipped state or removed assertion. Source closure complete; actual final desktop/mobile focused cases and rendered evidence remain root-owned pending gates. No reviewer runtime/tests/browser/Git/source writes; report lease released.

## Desktop/mobile archived visual acceptance

Independently viewed the desktop1280px and mobile390px `selected-long-name-with-child-count`, `unselected-session-pr-badge`, and `attention-with-pr-menu` images under `/tmp/ftown-fleet-media-20261027/badge-final-evidence/test-results/`. **Accept these actual final-source states visually.** The compact green bordered badge preserves its order beside an ellipsized name and before count/status/time/actions, with aligned selected/unselected rows, no visible overlap or horizontal overflow, and unchanged restrained graphic size. The actual focused badge ring is clear and fits beside its neighbors. Attention remains separate and visible while the observer is selected; the mobile menu stays within the viewport with legible actions and a visible focused PR item.

Evidence correction sent to root: both supplied `test-failed-1.png` images show empty session lists after cleanup; they cannot establish selected thinking-state visuals. This does not indicate an application defect. Source and the root-provided live snapshot establish the matcher correction; the final run's new `selected-thinking-pr-badge-{desktop,mobile}.png` remains the precise pending visual state. The final12 run supplies complete native navigation/attention/regression evidence; archived states are reused because application source is unchanged. No reviewer runtime/tests/browser/Git/source writes; only this report changed, and its lease is released after this bounded visual handoff.

## Final thinking-state visual acceptance

**Accept the final desktop/mobile thinking-state renders; no P1/P2 finding remains.** Independently viewed both dedicated `selected-thinking-pr-badge` screenshots under `/tmp/ftown-fleet-media-20261027/final-evidence/screenshots/`. They show the actual selected row with long-name ellipsis, aligned compact PR badge, collapsed-child count, status/time/actions and the real `◌ thinking...` detail below. Header and detail remain separated without overlap or visible overflow; the outstanding attention stays visible. This replaces the previously missing thinking-image evidence rather than reinterpreting the empty post-cleanup failure screenshots.

Root reports the final combined12 focused cases passed in35.9s, closing native navigation/keyboard/touch, strict geometry, selection/attention and landing regression gates for the reviewed source. Together with the accepted earlier states and fleet media, all assigned source/visual review gates are closed. Only this report changed; no reviewer runtime/tests/browser/provider/Git/source writes. All reviewer file/resource leases are released and this concrete review assignment is complete; reviewer may be retired.
