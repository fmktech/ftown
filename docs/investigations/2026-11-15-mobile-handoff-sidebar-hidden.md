---
type: investigation
symptom: "Mobile handoff e2e times out on the new session row even though that session is open"
slug: mobile-handoff-sidebar-hidden
date: 2026-11-15T17:54:04Z
investigator: Session handoff worker
git_commit: da61eb86fa4f5d6db38d6d2c31b0e851038c7d32
branch: feat/session-handoff
repository: fmktech/ftown
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-11-15-blocked-child-collapsed.md
  - docs/investigations/2026-11-15-shell-stop-session-blocked.md
---

# Mobile handoff leaves the new sidebar row hidden

## Symptom

- **Observed**: CI run 43742376440, job direct-transport-e2e (3/3) 132898150837, head `da61eb86fa4f5d6db38d6d2c31b0e851038c7d32`. `e2e/tests/session-handoff.spec.ts:94` failed only for `mobile blocked session handoff`. Playwright waited 60s and reported the locator resolved to the row button 121 times with `unexpected value "hidden"`. The accessibility tree at failure has tab `Terminal` selected and region `Session workspace: Handoff child mwi4gm5c handoff` with text `Session running`. The screenshot shows the Terminal tab, the menu button, and `[lost tty]`, with no sidebar. The same spec's desktop case passed in 3.8s. Lifecycle, CRUD, resurrection, and needs-attention passed on this head.
- **Expected**: After Hand off, the new session row `Handoff child <suffix> handoff` is visible in `#dashboard-sidebar`.
- **Delta**: The new session exists, is selected, and its sidebar button is mounted. On the phone that button is not visible because the Workspace list is not the selected tab.

Verbatim error:

```
Error: expect(locator).toBeVisible() failed

Locator:  locator('#dashboard-sidebar button[draggable="true"]').filter({ has: getByText('Handoff child mwi4gm5c handoff', { exact: true }) })
Expected: visible
Received: hidden
Timeout:  60000ms

Call log:
  - Expect "toBeVisible" with timeout 60000ms
  - waiting for locator('#dashboard-sidebar button[draggable="true"]').filter({ has: getByText('Handoff child mwi4gm5c handoff', { exact: true }) })
    121 × locator resolved to <button draggable="true" title="Drop on an edge to reorder within that subgroup, or in the center of a root session to move under it">…</button>
        - unexpected value "hidden"
```

## Reproduction

1. PR 237 head `da61eb8`, workflow run 43742376440, shard `direct-transport-e2e (3/3)`.
2. `e2e/tests/session-handoff.spec.ts` creates a shell parent and a muse child, waits until `block.reason` is `usage_limit` and the parent inbox has an escalation, then on a 390×844 viewport opens Workspace, the parent Overview, and Hand off with harness `shell`.
3. Line 94 waits for the new sidebar row. Desktop (same test body, 1280×900) passed. Mobile failed as quoted above.
4. Artifact `playwright-report-2` from that run: `test-results/session-handoff-mobile-blo-14eae-s-the-session-off-on-mobile-chromium/error-context.md` and `test-failed-1.png`.

Verified: 2026-11-15T17:54:04Z from that artifact. The earlier line 80 child-row assertion passed on this head (the failure is only line 94).

## Hypotheses

#### H1: Handoff did not create the new session, so the row never rendered

- **Layer**: dependency
- **Prediction**: If H1 is true, the accessibility tree will not name the new session, and the locator will be `element(s) not found`. If H1 is false, the new session name will be on screen and the locator will resolve.
- **Verification method**: Read `error-context.md` and the failure screenshot from the job artifact.
- **Evidence**:

```
- tab "Terminal" [selected]
- main:
  - 'region "Session workspace: Handoff child mwi4gm5c handoff"':
    - text: Handoff child mwi4gm5c handoff Local Session running
121 × locator resolved to <button draggable="true" ...>
    - unexpected value "hidden"
```

- **Verdict**: REJECTED
- **Rationale**: The new session is the open workspace, and the sidebar button for its exact name was found on every retry. Creation succeeded.

#### H2: The new session is a child of a collapsed parent, so the row is omitted the way the blocked child was before da61eb8

- **Layer**: state-data
- **Prediction**: If H2 is true, `flattenSessionTree` omits the child and the locator is `element(s) not found`, with an Expand children control, matching `docs/investigations/2026-11-15-blocked-child-collapsed.md`. If H2 is false, the button is in the DOM.
- **Verification method**: Compare this artifact with the previous investigation's "element(s) not found" error.
- **Evidence**:

```
Received: hidden
121 × locator resolved to <button draggable="true" title="Drop on an edge to reorder within that subgroup, or in the center of a root session to move under it">…</button>
        - unexpected value "hidden"
```

Previous collapsed failure was `Error: element(s) not found` at line 80, with `button "Expand children"`. This failure is a resolved, hidden button at line 94. Desktop on this same head passed line 94 in 3.8s, so the row is rendered when the sidebar is on screen.

- **Verdict**: REJECTED
- **Rationale**: A collapsed child is not mounted. This button is mounted and hidden.

#### H3: Hand off selects the new session, and on a phone that selection shows the Terminal tab, which sets the sidebar to `hidden`

- **Layer**: code-logic
- **Prediction**: If H3 is true, `handleHandoff` calls `handleSelectSession`, which sets `mobileTab` to `terminal` when the new session has no waiting item or preview. The sidebar class is `hidden` unless `mobileTab === "sessions"`, with `md:flex` keeping it visible on desktop. The failure tree will show Terminal selected and the new session workspace, and the row button will be hidden for the whole timeout. If H3 is false, the Workspace tab will still be selected, or the sidebar will not use `hidden`.
- **Verification method**: Read `ui/src/components/Dashboard.tsx` selection and sidebar class, and compare with the artifact.
- **Evidence**:

```tsx
const handleSelectSession = useCallback((id: string | null) => {
  ...
  if (id) {
    ...
    setMobileTab(waiting || previewShown ? "preview" : "terminal");
  }
}, [sessions, isDismissed]);

const handleHandoff = useCallback(async (sessionId: string, input: ...) => {
  const created = await handoffSession(sessionId, input);
  handleSelectSession(created.id);
  scheduleTerminalRenderAdjustment();
}, ...);
```

```tsx
<aside
  id="dashboard-sidebar"
  className={`dashboard-sidebar shrink-0 flex-col ${mobileTab === "sessions" && !inboxOpen ? "flex" : "hidden"} md:flex`}
>
```

```tsx
<main ... className={`flex-1 flex-col min-h-0 min-w-0 ${mobileTab !== "sessions" || inboxOpen ? "flex" : "hidden"} md:flex`}>
```

The spec already switches to Workspace before the first sidebar read (line 78) and to Overview before Hand off (line 83). It does not return to Workspace after `handleSelectSession` leaves that tab. `handleSelectSession` also sets `inboxOpen` to false, so the inbox is not what hides the sidebar. The new shell has no waiting item in the failure tree (Terminal, not Waiting), so the tab becomes `terminal`.

- **Verdict**: PROVEN
- **Rationale**: The artifact shows Terminal selected and the new session open, the locator finds the row as hidden for 60s, and the sidebar is `hidden` exactly when the phone tab is not Workspace. Desktop keeps the sidebar through `md:flex`, which is why the same assertion passed there.

## 5 Whys

Symptom: The mobile handoff spec cannot see the new session's sidebar row.
Why 1? Because the row is mounted inside `#dashboard-sidebar` while that aside has the `hidden` class.
Why 2? Because `handleHandoff` selects the new session, and `handleSelectSession` sets the phone tab to `terminal` when that session has no waiting item or open preview.
Why 3? Because on a phone the Workspace list and the Terminal are different tabs, and entering a session is defined as opening its terminal. That is the same path as creating a session.
Why 4? Because the handoff spec shares one body for desktop and mobile and, after Hand off, asserts the sidebar row is visible without returning to the Workspace tab. It only switches tabs on the way to Overview.
Why 5? Because the spec treats the post-handoff board check as viewport-independent, while the phone layout hides the board whenever a session is entered. The product behavior matches session creation. The assertion does not.

## Falsification

- **Check performed**: adjacent-cause plus absence. The collapsed-child cause (H2) and a failed create (H1) would omit the button. The artifact finds the button and marks it hidden, and the desktop run of the same assertion passed in 3.8s on this head. Desktop is the absence case for the phone-only `hidden` class: `md:flex` keeps the sidebar up, and the bug does not occur. An inbox overlay would also hide the sidebar, but `handleSelectSession` closes the inbox, and the failure tree is the terminal workspace, not the inbox.
- **Result**: The alternatives predict a missing button or a desktop failure. Neither happened. The phone-only hide matches the Terminal tab in the screenshot and the `hidden` class at `Dashboard.tsx` when `mobileTab !== "sessions"`.
- **Conclusion**: H3 survived.

## Root Cause

- Immediate cause: After a successful handoff, `handleHandoff` (`ui/src/components/Dashboard.tsx`) selects the new session, `handleSelectSession` sets `mobileTab` to `terminal`, and the sidebar class becomes `hidden` below the `md` breakpoint. The spec then calls `toBeVisible` on that sidebar row. Evidence: error-context quoted above; sidebar class on the `#dashboard-sidebar` aside; desktop pass of the same line.
- Architectural root: Phone navigation shows one surface at a time, and entering a session leaves the Workspace list. The shared handoff spec asserts the list as if it stayed on screen.
- Rejected H1: the new session workspace is open and the button resolved 121 times.
- Rejected H2: the button is mounted; a collapsed child would be absent, and desktop would have failed too.

## Fix

- `e2e/tests/session-handoff.spec.ts` — after Hand off, wait until the open workspace region is the new session (true on the failing snapshot), then on mobile click Workspace before asserting the sidebar row. This follows the spec's own line 78, which already knows the list is only on that tab. Do not change `handleSelectSession`: opening the new session is the same behavior as create.
- Regression: the spec itself is the discriminating check (CI already failed it with `hidden`). A Dashboard unit test locks the mechanism: handoff on a phone selects Terminal, the sidebar class is `hidden`, and Workspace removes `hidden` while the new row stays mounted.
