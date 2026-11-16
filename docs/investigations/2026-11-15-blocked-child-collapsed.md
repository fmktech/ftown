---
type: investigation
symptom: "Blocked handoff child is missing from the sidebar even though the API reports usage_limit"
slug: blocked-child-collapsed
date: 2026-11-15T17:30:00Z
investigator: Foad Kesheh
git_commit: 6a68d5cca8e5ad52ce1f307585b5a226abd57593
branch: feat/session-handoff
repository: fmktech/ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-11-15-shell-stop-session-blocked.md
---

# Blocked child stays collapsed in the sidebar

## Symptom

- **Observed**: `e2e/tests/session-handoff.spec.ts:80` on CI run 43739720144 timed out waiting for `#dashboard-sidebar button[draggable="true"]` filtered by the exact child name `Handoff child mwi3g4zl` (desktop) and `Handoff child mwi3gw81` (mobile). The accessibility tree shows the parent, an "Expand children" control, and the text `Handoff parent mwi3g4zl 1`. The child name is absent.
- **Expected**: The blocked child row is visible in the sidebar, with the blocked badge, without an extra expand click.
- **Delta**: The child exists and is blocked, and the parent advertises one hidden descendant, but the child button is not rendered.

## Reproduction

1. The spec creates a shell parent and a muse child with `parentSessionId`, then polls until `block.reason` is `usage_limit` and the parent inbox has an escalation.
2. It then looks for the child row. The failure is at line 80, so both polls passed.
3. Desktop error context:

```
Locator: locator('#dashboard-sidebar button[draggable="true"]').filter({ has: getByText('Handoff child mwi3g4zl', { exact: true }) })
Error: element(s) not found
button "Expand children Shell agent Handoff parent mwi3g4zl 1 Idle now Session actions":
  - button "Expand children": ▸
  - text: Handoff parent mwi3g4zl 1
```

Verified: 2026-11-15 from artifact `playwright-report-2`. The same shape failed on mobile.

## Hypotheses

#### H1: The first time a session becomes a parent, the sidebar collapses it, and the flattened tree omits the child

- **Layer**: code-logic
- **Prediction**: If H1 is true, the accessibility tree contains "Expand children" and the collapsed descendant count, and it does not contain the child name. The count element renders only while collapsed. If H1 is false, the child button is present (and the locator fails for some other attribute).
- **Verification method**: Compare the error context with `flattenSessionTree` and the default-collapse effect.
- **Evidence**:

```
ui/src/components/SessionList.tsx:221-236
  flattenSessionTree skips the subtree when collapsedSessions has the parent

ui/src/components/SessionList.tsx:600-626
  the first time a session is seen as a parent, it is added to collapsedSessions

ui/src/components/SessionList.tsx:1262-1279
  the descendant count is rendered only when isCollapsed && descendantCount > 0
  title: "1 hidden child session"
```

The error context shows "Expand children" and the count `1`, and it does not list the child button.

- **Verdict**: PROVEN
- **Rationale**: The count badge cannot render unless the parent is collapsed, and the flatten function then drops the child. That matches the missing locator.

#### H2: The child session was never created, or it was archived before the sidebar rendered

- **Layer**: state-data
- **Prediction**: If H2 is true, the poll for `usage_limit` would fail, and the parent would not show a hidden child. If H2 is false, the poll passes and the parent shows one descendant.
- **Verification method**: The Playwright failure line and the accessibility tree.
- **Evidence**:

```
e2e/tests/session-handoff.spec.ts:68-80
  the usage_limit poll and the escalation poll are before the row assertion
  the thrown stack is line 80

error context:
  text: Handoff parent mwi3g4zl 1
  button "Expand children"
```

- **Verdict**: REJECTED
- **Rationale**: The test only reaches the locator after the API reports `usage_limit` and the escalation. The parent row's hidden-child count is 1.

#### H3: The child row is rendered but is not draggable, so the locator misses it

- **Layer**: observation
- **Prediction**: If H3 is true, the accessibility tree still contains a button whose name includes `Handoff child mwi3g4zl`, without `draggable`. If H3 is false, no such button exists.
- **Verification method**: Read the full sidebar section of the desktop error context.
- **Evidence**: The sidebar lists the parent button and "Expand children". It has no node whose name includes `Handoff child`.
- **Verdict**: REJECTED
- **Rationale**: The child control is absent, not present-but-not-draggable. Absence is what H1 predicts.

## 5 Whys

Symptom: The blocked child row is not in the sidebar.
Why 1? Because the parent is in `collapsedSessions`, and `flattenSessionTree` skips that subtree.
Why 2? Because the first time a session is seen with a child, the list adds it to `collapsedSessions` and `seenParents`.
Why 3? Because orchestrator subagents are folded by default so a long child list stays compact.
Why 4? Because that default has no exception for a child the bridge has marked blocked.
Why 5? Because collapse is only a display preference, and a failure signal never forces the child card onto the board.

## Falsification

- Check performed: adjacent-cause. A wrong child name, or a row that exists but is not draggable, would also fail this locator.
- Result: The parent name in the tree is `Handoff parent mwi3g4zl`, so the suffix matches the child name the locator uses. No button with the child name exists at all. The count `1` is the collapsed-only badge (`SessionList.tsx:1262`). If the parent were expanded, that badge would be absent and the child button would be in the flatten output.
- Conclusion: hypothesis survived.

## Root Cause

- Immediate cause: `SessionList` default-collapses a new parent (`SessionList.tsx:600-626`) and `flattenSessionTree` then omits the blocked child.
- Architectural root: sidebar collapse is a persisted display preference with no exception for a bridge failure, so the blocked card the coordinator must see is hidden.
- Rejected H2: the API poll passed and the parent shows one hidden child.
- Rejected H3: the child button is not in the accessibility tree.

## Fix

- `ui/src/components/SessionList.tsx` — when a child gains a block, expand its parent once for that transition so the blocked row is on the board. A later manual collapse stays collapsed. An unblocked child stays folded.
- Regression test: a SessionList render with a blocked child shows the child name; a child with no block stays hidden under the collapsed parent.

## Resolution

- `SessionList` expands a parent once per blocked-child transition, after the default fold. A later manual collapse stays collapsed. An unblocked child stays folded.
- `ui/src/components/SessionList.blocked-child.test.tsx`: the blocked-child assertion failed before the effect (child text absent) and passes after it. The ordinary-child assertion passed before and after.
