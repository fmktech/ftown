# Independent contract review

Reviewer: `/root/auth_review`, Tier 2, `gpt-6.1-sol`, `max`. Base: `73c67cc`. Application and tests read-only.

## Gate

**Approved with the account-authority subscription correction accepted by root.** No shared runtime API redesign is required. Keep existing security notifications and encrypted request/hash checks.

D1's handoff demonstrates a real authenticated runtime staying ready while identical `replacePins` emits a notification. Source confirms the broad Dashboard generation (`ui/src/components/Dashboard.tsx:203`), effect-local completed document (`ui/src/hooks/useSessionPreview.ts:41`) and conditional iframe (`ui/src/components/SessionWorkspace.tsx:77`). Separate document lifetime from request cancellation; ignoring notifications or preserving only the same string key does not fix the destroyed DOM instance.

## Required correction and exact interface

Runtime notifications alone cannot establish that account authority never disappeared. `AccountSecurityClient.update` synchronously notifies its own subscribers (`ui/src/lib/account-security-client.ts:92`); pins are derived through React (`ui/src/hooks/useBrowserIdentity.ts:28`) and applied later in an effect (`ui/src/components/DashboardClient.tsx:77`). An account loss/recovery batched before that effect can leave final pins/ready state unchanged without a runtime notification during the loss.

Use the existing subscriber through the existing owner path:

```ts
// ui/src/hooks/useSessionPreview.ts
export type SessionPreviewAuthoritySubscriber =
  (listener: () => void) => () => void;

// Add to hook Options and SessionWorkspace Props:
subscribeAuthority?: SessionPreviewAuthoritySubscriber;

// Dashboard's existing SessionWorkspace invocation:
subscribeAuthority={accountClient?.subscribe}
```

`SessionWorkspace` forwards this stable function unchanged. Extend I1's ownership of `Dashboard.tsx` only for this wiring. The account client remains owned by its current creator; the hook must never dispose it or the shared runtime.

Subscribe to both `runtime.onChange` and `subscribeAuthority` with the same synchronous authority-check/latch callback, even while the page or panel is hidden. Subscribe before an initial check; unsubscribe both listeners when their sources/selected target change or the hook unmounts. Changing the subscriber source is a hard cache-owner boundary. Guard reentrant checks: `assertBridgeAccess` can block and synchronously notify subscribers itself (`account-security-client.ts:44`, `:74`).

## Display and authorization invariants

- Retain at most one complete, hash-verified document for the exact client, runtime/browser identity, user, bridge, session and registration. A hard boundary erases it and invalidates all old requests **inside the event callback**, before React state scheduling. Use a persistent monotonically changing frame nonce/auth epoch so even a batched revoke/reapprove followed by the same bytes cannot reuse the pre-loss iframe.
- At each notification, inspect the selected runtime identity, selected pin's full endpoint and canonically sorted permissions, selected state and `assertCanSend`. Missing/changed pin, endpoint/key/permission changes, loss of ready/read access, failed account authority, client/user/target replacement or `readable=false` are hard boundaries. A final `ready` boolean is insufficient to reverse a latched loss.
- A benign notification cancels/fences pending status/chunk/digest work and conceals the **same mounted** frame pending a new authenticated status. A matching unchanged revision and byte count reveals that frame. A changed revision remains concealed until every byte and its digest are verified. Denial, unavailable, unregistered and current-generation errors purge it. Concealment is not an authorization substitute: iframe scripts may continue running, so actual loss requires destruction.
- Page/panel visibility is a soft scheduling pause. Cancel timers and old work, preserve document/key/iframe, and resume with `knownRevision`. A stale completion or exception must neither restore erased content nor clear a newer owner's cache. Manual refresh changes the frame nonce after successful current-generation validation even when content is unchanged. Ordinary unchanged polls remain quiet.
- If no observable security runtime is supplied, do not infer durable authority from a mock `readable=true` across a security-generation change. Keep the conservative hard-clear fallback or provide a representative observable-runtime test fixture. Production preservation must use the actual authority signals above.

## Expanded preview

The proposed workspace expansion is compatible with this repair. Keep the iframe and terminal in their existing mounted ancestry; change layout/visibility rather than conditionally replacing them. Preserve split ratio across expand/collapse, keep sidebar/navigation present, and reset expansion for a new selected bridge/session/registration or Close. Use one native 44px toggle with the specified Expand/Collapse accessible names so focus and node identity survive. Handle Escape on the expanded workspace/toolbar, with no global iframe key interception or browser Fullscreen API.

## Decisive checks and handoff

1. Hook: equal-ready runtime notifications and page/panel pauses preserve the document; fresh status carries `knownRevision`; no old status/chunk/digest/error can commit after a fence.
2. Hook: account authority fails/notifies then recovers/notifies in one `act`, with no runtime notification and final ready/equal pins. Old cache/key must not return; cover changed endpoint/permissions and pending work too.
3. Workspace: benign verification hides/reveals the **same iframe node**; a batched hard loss disconnects the old node. Expanded/collapsed iframe and terminal are the **same actual nodes**, with ratio/focus restoration and no refresh.
4. Dashboard wiring: verify the existing account subscriber reaches the workspace/hook. Root-owned focused E2E checks interaction state, sidebar/layout and terminal identity; manual refresh and real content edits still reset the preview.

D1 reports three preservation regressions red, five existing cases passing, the separate real-crypto notification probe passing, and typecheck passing. These are supplied discovery results, not checks run by this reviewer. No runtime, tests, services, CI, Git or source changes were performed here. Only this report was written. Review lease released; root owns the final frozen brief and runtime gates.

## R2 final implementation review

**Approved: no blocking findings.** Root confirmed the application source final/released before this closure. Reviewed the hook, workspace, Dashboard wiring, preview CSS and focused tests; the E2E file was subsequently reacquired by I1 for the additional root-requested geometry/screenshot/periodic-refresh assertions, which were also inspected as present. Browser execution remains root-owned.

- The accepted account-authority correction is wired at `Dashboard.tsx:1080` and forwarded unchanged by `SessionWorkspace.tsx:29`. The hook subscribes to runtime and account sources before its initial check, retains those subscriptions during soft pauses, guards reentrant checks and cleans up only its own listeners (`useSessionPreview.ts:70`). A nested authority update invalidates the snapshot rather than trusting an unstable result.
- Hard events clear the completed document and increment the epoch synchronously in the callback (`useSessionPreview.ts:85`); changing client/runtime/user/target/readability/subscriber also clears ownership (`:43`). The fingerprint includes browser identity, selected pin endpoint, canonical permissions, ready/read checks and the existing `assertCanSend` authority gate (`:25`). Persistent nonce allocation prevents the same bytes from resurrecting an old frame after a batched loss/recovery.
- Benign notifications retain the completed document with `verifying=true`; the workspace conceals that iframe without changing its key (`SessionWorkspace.tsx:81`). A fresh matching unchanged response reveals it. Status/chunk/digest awaits and the error catch are fenced against stale epochs; late failures cannot purge a newer cache. Visibility pauses retain document ownership while stopping polling, and resume sends `knownRevision`. No-runtime clients retain the conservative generation-clear behavior.
- Expansion changes pane visibility and split styling while retaining the terminal and iframe ancestry (`SessionWorkspace.tsx:66`). The same toggle button changes its name/text, preserves focus, and supports scoped Escape collapse. Target/registration/Close reset expansion; split state is retained. Preview controls remain at least 44px (`globals.css:394`); no fullscreen API, global iframe key handler or new preview capability was introduced.

The focused regressions are meaningful: an account-only loss/recovery in one batch rejects an old response and allocates a different frame key (`useSessionPreview.test.ts:139`); changed permissions, stale digest, late rejection and batched key restoration are covered (`:156`, `:213`, `:230`, `:243`). The component test checks **actual iframe/terminal nodes**, conceal/reveal, focus and ratio restoration, and removal of the old iframe on batched hard loss (`SessionWorkspace.test.tsx:32`). Dashboard subscriber wiring was independently inspected in source.

I1 reports **45/45 focused tests and UI typecheck passing**, with commands and environment recorded in `handoff.md`. The E2E assertions preserve the real CLI/encrypted browser flow and add same-node/counter checks across periodic account refresh, tab changes and expansion, plus sidebar/full-main geometry. This review does not claim browser geometry, visual results or the periodic cloud observation have run; root is executing those gates.

Only this report changed during R2. No application edits, tests, installs, services, E2E, CI or Git operations were performed by this reviewer. Review lease released.
