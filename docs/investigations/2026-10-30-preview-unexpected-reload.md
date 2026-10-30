---
type: investigation
symptom: "Preview spontaneously refreshes without agent file edits"
slug: preview-unexpected-reload
date: 2026-10-30T13:48:54-03:00
git_commit: 73c67cc766ff65b810fc23f08e2ade0cbac30210
branch: fix/preview-stable-frame
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---
# Preview spontaneously refreshes without agent file edits

## Symptom
- User report relayed by root: “preview spontaneously refreshes without agent file edits”. Observed in `ftown.ia.br/dashboard` cloud dashboard; the terminal badge says Local. Root reports selected session and Revision 02 file unchanged (mtime 1793378740, 12,979 bytes).
- Expected: same verified document and iframe survive ordinary trust refresh/poll/render and temporary visibility pause. Changed file or manual refresh resets it; loss or replacement of authority and target/client changes must invalidate it.
- Delta: a previously verified unchanged frame is removed and restarted. The evidence below proves a reproducible cause in this code path; no instrumentation was added to the user's live tab, so it does not prove every observed reload had this trigger.

## Reproduction
Node 24.22.1, clean environment; in `ui/` run `npm test -- src/hooks/useSessionPreview.test.ts`. The three newly added regression cases keep client, descriptor, revision, data and authorized `readable=true` fixed. After a verified initial response, each separately changes the security notification generation, page visibility, or panel visibility. Current result:
```
Test Files  1 failed (1)
Tests       3 failed | 5 passed (8)
expected { kind: 'loading' } to match object { kind: 'ready', …(2) }
```
The `<iframe>` is conditional on `state.kind === 'ready'` (`ui/src/components/SessionWorkspace.tsx:77`), so entering loading removes the DOM instance even if the subsequently reloaded key equals the previous key. The initial status after an effect restart cannot carry `knownRevision`: `complete` is initialized null inside the effect (`ui/src/hooks/useSessionPreview.ts:41,57`). The tests hold second status pending to expose this transition deterministically.

The independent real-crypto probe in the same test file exercises the actual runtime: run `npm test -- src/hooks/useSessionPreview.test.ts -t 'identical pinned bridges'`. It creates genuine endpoints, completes an authenticated handshake, verifies ready, subscribes, and calls `replacePins` with an identical cloned pin. Result:
```
Test Files  1 passed (1)
Tests       1 passed | 7 skipped (8)
```
Assertions prove the status remains `ready` and exactly one change notification fires. This probe and the regression tests are the only tracked source/test changes, all in `ui/src/hooks/useSessionPreview.test.ts`; production source remains untouched. `npm exec tsc -- --noEmit` passed.

## Hypotheses

#### H1: One lifecycle fence conflates benign pause/notification events with loss of document authority, discarding a verified frame.
- **Layer**: state/data and integration.
- **Prediction**: a ready-to-ready generation increment, hidden document, or hidden panel turns ready into loading despite identical target/content; the real runtime emits a notification for equal pins.
- **Verification method**: three controlled hook regressions and a separate actual crypto/runtime equal-pin probe, as above.
- **Evidence**:
  ```
  3 failed | 5 passed (8)
  expected { kind: 'loading' } to match object { kind: 'ready', …(2) }
  1 passed | 7 skipped (8)  [real crypto equal-pin notification probe]
  ```
  `ui/src/hooks/useSessionPreview.ts:22-25` puts visibility and every `securityGeneration` increment into one epoch; `:41` discards complete data when the polling effect restarts and `:100` switches to loading on epoch mismatch. `SessionWorkspace.tsx:77` removes the frame on loading. The cloud's normal path is `useAccountSecurity.ts:15-17` periodic/focus refresh → `account-security-client.ts:172-174,93` emits a new ready snapshot → `useBrowserIdentity.ts:28-38` constructs a fresh pins array → `DashboardClient.tsx:74-77` calls `replacePins` → `secure-endpoint-runtime.ts:45-60` always notifies listeners even for identical pins → `Dashboard.tsx:202-203,1080` increments/passes securityGeneration. The successful actual-runtime probe directly verifies the final notification with ready status; the deterministic hook test verifies the next link. `SessionWorkspace.tsx:24-28` independently passes panel visibility into the same boundary.
- **Verdict**: PROVEN for these controlled triggers and corresponding source path.
- **Rationale**: each changed lifecycle input alone forces ready→loading, with no file or protocol change; the component consequently removes the frame. Routine account trust refresh can cause the generation input to change even when the selected bridge remains ready.

#### H2: Ordinary Dashboard rerenders alone change the real RPC callback identity and cause this reload.
- **Layer**: integration.
- **Prediction**: unrelated renders replace `sendCommand` without client/core replacement.
- **Verification method**: inspect real `useBridgeRpc` construction; ordinary unchanged poll is exercised by existing hook test.
- **Evidence**:
  ```
  useBridgeRpc.ts:210-215: coreRef is initialized only when null; core = coreRef.current
  useBridgeRpc.ts:280-285: const sendCommand = useCallback(..., [core])
  ✓ keeps the document key on unchanged polls, remounts on manual refresh, and pauses while hidden
  ```
- **Verdict**: REJECTED as the explanation for ordinary Dashboard rerenders with stable core/client. A genuinely replaced callback would restart the current effect, but that is not how the real callback is made on each render.
- **Rationale**: `core` and the callback are stable across routine rerenders, whereas H1 reproduces with both fixed.

#### H3: An unchanged status response itself requests a new frame or changes its key.
- **Layer**: protocol/data.
- **Prediction**: a regular unchanged response changes ready/key without any boundary change.
- **Verification method**: existing unchanged-poll test and code branch.
- **Evidence**:
  ```
  ✓ keeps the document key on unchanged polls, remounts on manual refresh, and pauses while hidden
  useSessionPreview.ts:62-65: only `manual` changes the existing key for unchanged.
  ```
- **Verdict**: REJECTED in the stable-input controlled case.
- **Rationale**: an ordinary unchanged poll preserves the key; H1 reproduces with no status result required.

## 5 Whys
1. The preview reloads because React receives loading and unmounts its iframe.
2. It receives loading because a shared epoch changes and the verified document is local to the restarted polling effect.
3. That epoch changes for benign page/panel visibility and every security-runtime notification, not just authority changes.
4. The implementation uses a single lifecycle fence for cancellation, polling eligibility, authentication identity, and displayed-document validity.
5. The contract lacked an explicit distinction between preserving a verified display and invalidating in-flight work versus revoking the right to retain that display; the implementation therefore treated every notification as a hard document boundary.

## Falsification
- Isolation: with a fixed revision, client, user, target and ready authorization, changing only the notification counter or only visibility reproduces ready→loading. No file change, status response or external service is needed.
- Absence counterexample: with all boundary inputs fixed, the existing unchanged-poll test passes and preserves the frame key. This rejects a general unchanged-status explanation; it does not rule out a separate transient error or actual file change in other incidents.
- Real-cloud path evidence: the actual encrypted runtime test establishes ready before equal `replacePins` and receives one event without a readiness change. Source links periodic trust refresh to that event, but no live notification timestamp was captured, so correlation with a particular observed live reload remains to be checked by root.

## Root Cause and constrained repair proposal
The single epoch treats benign scheduling/notification changes as hard invalidation of a previously verified document and couples that cached document's lifetime to the polling effect. Split *display authority* from *poll/in-flight cancellation*: keep only one verified complete document under an exact client/user/bridge/session/registration and effective authorization identity, while page/panel pauses stop scheduling and invalidate outstanding async generations without replacing that document. Resume with `knownRevision`, so unchanged results retain the mounted iframe and new content/manual refresh remounts. Keep cached document only while an independently verified effective authority remains unchanged; clear immediately on client/user/target/preview ID changes, missing/cleared registration, connection/security loss, endpoint/key replacement, changed read permission, revoked/expired account authority or failed response. Every await still needs stale-generation fencing.

Security notifications may report account-authority changes independently of pin equality. `secure-endpoint-runtime.ts:80-89` calls `accountAuthority` before allowing use; suppressing all equal-pin notifications or ignoring `securityGeneration` is unsafe without explicitly preserving account-authority loss and transient/batched revoke/reapprove events. The caller needs a scoped, synchronous effective-authority check/latch (including selected endpoint identity/key, read permission, account access and client identity), not merely a React-render-time `ready` boolean. A meaningful security transition should invalidate cached content and all in-flight generations even if readiness recovers in the same batch. Consider pin comparison only for notifications proven semantically identical across all relevant authority dimensions, with tests for permission/key/expiry and account authority changes; do not suppress refresh/freshness semantics.

File ownership proposed to root: `ui/src/hooks/useSessionPreview.ts` and its test for separate cache/cancellation generations; `Dashboard.tsx`/`SessionWorkspace.tsx` only if contract supplies a scoped authority signal and for independently requested expanded preview; component tests for iframe DOM continuity and compact/page visibility. Add regressions for benign same-pin refresh, selected-bridge revocation/reapproval within one batch, endpoint replacement, permission/account-expiry loss during pending chunks/digest, client/user/session/preview switch, clear/offline/error, late responses, manual refresh and actual changed digest. Root owns actual cloud/browser runtime verification. No application changes made in D1.


## Root proposal reviewed: conservative security revalidation
A security notification can invalidate the request generation while preserving the previously verified iframe only as a **hidden, pending** document. On a fresh authenticated status for the same selected target and same verified revision/size, reveal the same iframe; on new revision, remain hidden until new bytes are verified; on denial, unregistered, unavailable, transport error, or hard boundary, unmount and erase it. Never trust an old in-flight status/chunk/digest after a notification. A hidden iframe still executes JavaScript and retains its DOM: this is a temporary pending state, not a substitute for destroying content on actual loss. Capture actual authorization/key/permission/endpoint loss synchronously from runtime events and latch it even if loss and reapproval are batched; `ready` alone is not sufficient, and equal pins do not prove account authority. Page/panel pauses are a separate soft stop preserving frame/cache and resuming with `knownRevision`. Require runtime/DOM tests for synchronous hiding, revocation, changed keys/permissions, failed authority and loss/reapproval in one batch; root to freeze exact interface before source edits.

## I1 implementation and validation
Implemented separate retained verified-document lifetime and request epoch, synchronous selected runtime/account-authority checks, benign-notification concealment plus authenticated revalidation, and actual hard-loss cache invalidation. Pauses retain the document and resume with `knownRevision`; new verified content/manual refresh change the persistent nonce. Added workspace expansion without moving/unmounting iframe or terminal. The three investigation regressions failed before implementation and now pass using a representative observable runtime for the security-notification case; missing-runtime clients conservatively hard-clear on generation changes. Added tests for same-node hide/reveal, account loss/recovery in one batch, bridge key loss/restoration, permission loss and stale request/digest completion. Relevant UI suite 45/45 and tsc pass. Root still owns runtime/E2E verification, so investigation remains root-cause-proven until that gate is evaluated.
