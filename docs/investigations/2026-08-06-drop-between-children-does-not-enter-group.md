---
type: investigation
symptom: "when I drang a session in beteewn two child session it doesnt enter in the subgroup"
slug: drop-between-children-does-not-enter-group
date: 2026-08-06T18:13:23-03:00
investigator: Foad Kesheh
git_commit: 3ef59fd4f9e15f0991ee1df4f564cc10fea7cefb
branch: fix/drop-between-children
repository: fmktech/ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-08-06-ftown-bridge-latest-failed-to-start.md
---

# Dropping between child sessions does not enter their subgroup

## Symptom

- **Observed**: "when I drang a session in beteewn two child session it doesnt enter in the subgroup"
- **Expected**: Dropping a root session between two children should assign it to those children's parent and place it at the selected sibling boundary.
- **Delta**: The list order changes, but the dragged session remains a root because no parent mutation is sent.

## Reproduction

1. Use a bridge containing root session `root-x` and parent `parent-a`, where `parent-a` has child `child-b`.
2. Resolve the drop made on the upper edge of `child-b`, which represents the boundary before that child:

   ```sh
   npx tsx -e "import { resolveSessionDrop } from './src/lib/session-drop.ts'; console.log(JSON.stringify(resolveSessionDrop({id:'root-x',bridgeId:'bridge-1'},{kind:'session',id:'child-b',bridgeId:'bridge-1',parentSessionId:'parent-a',zone:'above'})))"
   ```

3. Current output:

   ```json
   {"type":"reorder","sessionId":"root-x","targetSessionId":"child-b","zone":"above"}
   ```

Verified 2026-08-06: the action contains no `parentSessionId`, so `SessionList` takes its reorder-only branch and never calls `onSetSessionParent`.

## Hypotheses

#### H1: Edge drops on child rows discard the child's parent and emit a reorder-only action

- **Layer**: code-logic
- **Prediction**: Resolving an edge drop whose target has `parentSessionId: "parent-a"` will return `type: "reorder"` without a parent mutation, and the component will only invoke its ordering callback.
- **Verification method**: Execute `resolveSessionDrop` with a child target and inspect the public action plus the drop-handler branch.
- **Evidence**:

  ```text
  {"type":"reorder","sessionId":"root-x","targetSessionId":"child-b","zone":"above"}

  ui/src/lib/session-drop.ts:56-62 returns only sessionId, targetSessionId, and zone.
  ui/src/components/SessionList.tsx:736-740 calls onSetSessionParent only for type "set-parent".
  ui/src/components/SessionList.tsx:763-782 reorders ids and invokes onReorderSessions for this action.
  ```

- **Verdict**: PROVEN
- **Rationale**: The deterministic resolver output and exhaustive discriminated-union branch show that an edge drop on a child cannot perform a parent mutation.

#### H2: The rendered child loses its parentSessionId before drop resolution

- **Layer**: state-data
- **Prediction**: If this were true, `handleSessionDrop` would construct the target without the child's stored parent id.
- **Verification method**: Inspect the target passed from the rendered session into `resolveSessionDrop`.
- **Evidence**:

  ```text
  ui/src/components/SessionList.tsx:724-730 passes
  parentSessionId: targetSession.parentSessionId
  directly into the resolver.
  The reproduction explicitly passes parentSessionId: "parent-a" and still produces reorder-only.
  ```

- **Verdict**: REJECTED
- **Rationale**: The parent value reaches the resolver; it is ignored by the edge-drop action construction.

#### H3: The visual gap is outside every row, so no session drop handler receives the event

- **Layer**: observation
- **Prediction**: If true, there would be a separate gap element or layout spacing between child buttons without `onDrop`.
- **Verification method**: Inspect the row element, its drop handler, and its boundary styling.
- **Evidence**:

  ```text
  ui/src/components/SessionList.tsx:887-895 attaches onDragOver and onDrop to the full-width button.
  ui/src/components/SessionList.tsx:921-935 renders the boundary as borderTop/borderBottom on that same display:block button, with no row margin or gap element.
  ```

- **Verdict**: REJECTED
- **Rationale**: The perceived gap is an edge zone inside one of the adjacent row buttons, so its session handler does receive the drop.

## 5 Whys

Symptom: Dropping between children reorders a root but does not enter the subgroup.  
Why 1? Because child-row edge drops return a reorder-only action.  
Why 2? Because `SessionDropAction.reorder` carries no destination parent.  
Why 3? Because the original resolver modeled reparenting only as a center drop and ordering only as an edge drop.  
Why 4? Because it treated parenting and ordering as mutually exclusive operations.  
Why 5? Because the drag contract represented gestures as single mutations instead of expressing the complete destination (parent plus sibling boundary).

## Falsification

- **Check performed**: Adjacent-cause search and absence test.
- **Result**: The target's `parentSessionId` is present in both the component call and the deterministic reproduction, rejecting stale/missing state. A root-target edge drop returns the same reorder shape but is correct because its destination parent is already root; only a child-target edge requires the omitted parent mutation.
- **Conclusion**: H1 survives. The defect is not event geometry or missing state; it is the incomplete action contract for child-edge destinations.

## Root Cause

- **Immediate cause**: `resolveSessionDrop` returns a reorder-only action for every edge drop (`ui/src/lib/session-drop.ts:56-62`), and `SessionList` therefore never invokes `onSetSessionParent` for the child boundary (`ui/src/components/SessionList.tsx:736-782`).
- **Architectural root**: The drag action contract makes parent mutation and sibling ordering mutually exclusive even though a drop between children requires both.
- **Rejected H2**: `targetSession.parentSessionId` is passed directly to the resolver and was present in the reproduction.
- **Rejected H3**: The apparent gap is a styled border inside a row carrying both drag-over and drop handlers.
- **Falsification survived**: Root-boundary reordering is a valid counterexample for the existing shape, but child-boundary reordering demonstrably needs additional destination-parent information.

## Fix

- Extend the edge-drop action to carry the target's parent id as its destination parent.
- In `SessionList`, apply that parent mutation before persisting the sibling order when the dragged session is not already in that subgroup.
- Regression test: `ui/src/lib/session-drop.test.ts` must prove a drop before/after a child requests both subgroup parenting and sibling ordering; browser coverage must prove the persisted parent changes.

## Resolution

- **Diff summary**: Edge-drop actions now carry their destination parent. `SessionList` sends a parent mutation when that destination differs from the dragged session's current parent, then persists the requested sibling order. Invalid attempts to move a session with children into another subgroup are rejected before highlighting or drop.
- **Unit regression**: `ui/src/lib/session-drop.test.ts` failed before the fix because the reorder action omitted `parentSessionId`; it now passes all 8 cases.
- **Browser regression**: `e2e/tests/session-lifecycle.spec.ts` failed before the fix with expected parent id versus received `null`; the same Chromium drag gesture now passes and the bridge API reports the subgroup parent.
- **Verification**: UI TypeScript check and production build pass. The focused browser test passes in 3.2 seconds.
- **Follow-up**: None required for this defect.
