---
type: investigation
symptom: "Answering a child's attention item from the dashboard coordinator panel showed a transport timeout instead of an answer or an error"
slug: attention-answer-timeout
date: 2026-11-16T10:55:00-03:00
investigator: Foad Kesheh
git_commit: 29819ab
branch: linux/attention-timeout
repository: fmktech/ftown
status: resolved
hypotheses_formed: 4
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-10-23-live-attention-cleared.md
  - docs/investigations/2026-10-24-attention-refresh.md
---

# Answering a child attention item from the coordinator panel times out instead of answering or erroring

## Symptom

- **Observed**: the owner answered a child's attention item from the dashboard coordinator
  panel (the Overview children panel added by PR #236) and the UI reported a transport
  timeout (`<rpc> timed out`) instead of delivering the answer or explaining why it could
  not be delivered. The report was taken on bridge `0.30.1`; the tree audited here is on
  bridge `0.30.4`.
- **Expected**: answering an attention item from the dashboard either delivers the answer
  or fails with a typed, human-readable reason (the question has no question to answer,
  the session is gone, the request was malformed, the computer is no longer reachable).
  The owner never sees a bare transport timeout for an answer that the bridge had
  information about.
- **Delta**: the answer command has no end-to-end contract that *every* outcome is a
  typed answer. Several failure modes of `answer_session_attention` publish **no response
  at all** (the UI then waits out its RPC deadline and reports a timeout), and the ones
  that do reply answer with **untyped** strings that the UI cannot map to an outcome. The
  dashboard also offers a reply form on items that carry no question, so the owner is
  invited to interact with an item that can never be answered.

## Reproduction

Recipe (bridge side, deterministic, no daemon needed). The script drives the real
`createCommandHandler` with a real `AttentionStore` and records every published
response:

```
bridge/src/attention-store.ts   # real store, temp data dir
bridge/src/command-rpc.ts       # real command handler, fake session controller
```

1. Record a durable notice **without** a question (`attentionStore.record('session',
   'Notification', { notification_type: 'agent_needs_input', title: 'Work complete',
   message: 'Review the result and checks.' })`).
2. Record a durable item **with** a question (`{ prompt: { channel: 'mail', questions:
   [question] } }`).
3. Send `answer_session_attention` for each of the four situations and record whether the
   handler published a response, and whether that response carried `data.code`.

Verified: 2026-11-16 — the four situations reproduce the current behaviour exactly:

```
--- A) notice with no question (Work complete) ---
{ "requestId": "r", "success": false,
  "error": "This attention request has no question to answer",
  "data": { "code": "attention_not_answerable" } }

--- B) retired child session (session no longer exists) ---
{ "requestId": "r", "success": false,
  "error": "Unknown session" }                      <-- no data.code

--- C) payload bridgeId targets another bridge ---
NO RESPONSE PUBLISHED  <-- UI would time out after 30s

--- D) malformed payload (extra key) ---
{ "requestId": "r", "success": false,
  "error": "Invalid attention answer" }              <-- no data.code
```

The UI side of the same defect is reproduced by the component test added with this fix
(`ui/src/components/SessionInbox.test.tsx`): an item with an `attentionId` and no
`prompt` renders a reply textarea and a "Send reply" button, i.e. the owner is offered a
way to interact with an item that has no question.

## Hypotheses

#### H1: A bridgeId mismatch makes the bridge drop the answer command silently, so the UI waits out its RPC deadline

- **Layer**: code-logic (bridge command dispatch)
- **Prediction**: if `payload.bridgeId` differs from the bridge's own id,
  `createCommandHandler` returns before publishing anything. Calling the handler with
  such a payload must publish **zero** responses. Conversely, if the hypothesis is false,
  a response is published for every payload shape.
- **Verification method**: run the handler directly and count published responses.
- **Evidence**:
  ```
  bridge/src/command-rpc.ts:176-180
      const payloadBridgeId = command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
        ? (command.payload as Record<string, unknown>).bridgeId as string | undefined : undefined;
      if (payloadBridgeId && payloadBridgeId !== bridgeId) {
        return;
      }
  ```
  and the reproduction output above:
  ```
  --- C) payload bridgeId targets another bridge ---
  NO RESPONSE PUBLISHED  <-- UI would time out after 30s
  ```
  The UI side of the same contract, `ui/src/hooks/useBridgeRpc.ts:97-115`, rejects with
  `` new Error(`${command.type} timed out`) `` after its deadline when no response
  arrives — the exact shape of the reported symptom.
- **Verdict**: PROVEN
- **Rationale**: the silent `return` is the only code path in the bridge that publishes
  no response for `answer_session_attention`; every other path ends in the `catch` block
  that publishes a response. The predicted observation occurred.

#### H2: A retired child leaves the attention store locked, so `answer()` never settles and the bridge never replies

- **Layer**: state-data (per-session lock chain in the attention store)
- **Prediction**: if a session was retired while an earlier operation on it was still in
  flight, `AttentionStore.withLock` chains the new call behind the unsettled one and
  `answer()` never resolves; the handler would publish nothing for a retired child.
  If the hypothesis is false, the retired-child case publishes a response promptly.
- **Verification method**: drive the handler with a session controller that no longer
  knows the session (the retired child) and observe the published response; read
  `AttentionStore.withLock` (`bridge/src/attention-store.ts:219-227`).
- **Evidence**:
  ```
  bridge/src/attention-store.ts:219-227
    private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) return Promise.reject(new AttentionError('invalid_session', 'Invalid session ID'));
      const previous = this.locks.get(id) ?? Promise.resolve();
      const next = previous.then(fn, fn);
      ...
  ```
  and the reproduction output:
  ```
  --- B) retired child session (session no longer exists) ---
  { "requestId": "r", "success": false, "error": "Unknown session" }
  ```
  The retired child answers immediately: the lock chain is per session id and the
  retired session is rejected by `sessionController.get()` before the store is touched.
- **Verdict**: REJECTED
- **Rationale**: counterexample — the retired-child case publishes a response immediately,
  so the lock chain is not stuck and this is not the source of the timeout. What the
  counterexample *does* expose is that the retired-child answer is **untyped**.

#### H3: The UI sends a malformed answer request for items with no question, and the bridge's generic rejection surfaces as an opaque error

- **Layer**: dependency/integration (UI ↔ bridge command contract)
- **Prediction**: if the dashboard offers an answer affordance for a question-less item,
  the answer request reaches the bridge and is rejected with the generic string
  "Invalid attention answer" (no `data.code`), which the UI cannot map to an outcome.
  If the hypothesis is false, the UI never sends such a request.
- **Verification method**: read the answer paths (`ui/src/hooks/useAllSessionEvents.ts`,
  `ui/src/components/Dashboard.tsx`) and the item renderer
  (`ui/src/components/SessionInbox.tsx`); run the bridge handler with a malformed payload.
- **Evidence**:
  ```
  ui/src/components/SessionInbox.tsx:113
    const prompt = entry.notice.attentionId ? entry.notice.prompt : undefined;
  ...
  ui/src/components/SessionInbox.tsx:127-131
    {prompt ? <AttentionAnswerForm ... /> : <>
      <label ...>Reply to {name}<textarea ... /></label>
      ...
      <button type="button" className="btn-accent min-h-11" ...>Send reply</button>
    </>}
  ```
  and the reproduction output:
  ```
  --- D) malformed payload (extra key) ---
  { "requestId": "r", "success": false, "error": "Invalid attention answer" }
  ```
  The UI does guard the answer call itself
  (`ui/src/hooks/useAllSessionEvents.ts:560` and `:643`:
  `if (!expected.attentionId || !expected.prompt) return fail("attention_not_answerable", ...)`),
  so no malformed answer request is sent today — but the item still renders a reply form
  for an item that carries no question, and the bridge's malformed-request rejection is
  untyped.
- **Verdict**: REJECTED
- **Rationale**: counterexample — the UI never sends the malformed request, so the
  untyped "Invalid attention answer" string is not what the owner saw. The defect it
  exposes is real but different: question-less items must offer only Dismiss/Open, and
  the bridge's rejections must be typed.

#### H4: The transport rejects the bridge's response before the UI correlates it, so the reply exists but the UI still times out

- **Layer**: dependency/integration (E2EE command transport)
- **Prediction**: if the bridge published a well-formed `command_response` that the
  secure transport drops, the bridge-side handler would still show a published response
  in the reproduction while the UI would time out. If the hypothesis is false, every
  response the bridge publishes for this command is correlatable by the UI.
- **Verification method**: read the response path of the secure transport
  (`ui/src/lib/secure-message-client.ts`, `bridge/src/security/bridge/execute.ts`) and
  check the correlation conditions.
- **Evidence**:
  ```
  ui/src/lib/secure-message-client.ts:250-254
    if (value.type === "command_response" && record(value.response)) {
      const response = value.response;
      if (application.route.kind !== "response" || response.requestId !== application.route.requestId || ...) return false;
      const expected = this.expectations.get(response.requestId);
      if (!expected || expected.expiresAt <= Date.now() || !expected.bridgeIds.has(bridgeId)) return false;
  ```
  and, for the cloud path, the target of an answer command is a single bridge
  (`ui/src/lib/secure-message-client.ts:169-183`: `targets()` returns the explicit
  `payload.bridgeId`), so a response is correlatable whenever the bridge answers.
  A bridge-side throw after verification is answered with a typed HTTP-style error that
  the client converts into a command response
  (`bridge/src/security/bridge/execute.ts:37-39` and
  `ui/src/lib/secure-message-client.ts:17-21`).
- **Verdict**: REJECTED
- **Rationale**: counterexample — a bridge-published response for this command is
  correlatable, and the transport converts bridge-side failures into typed responses.
  The transport is therefore not where the owner's timeout came from; the bridge's own
  dispatch is.

## 5 Whys

Symptom: answering a child's attention item from the dashboard showed a transport
timeout instead of an answer or an error.

Why 1? Because the bridge published **no response** for that `answer_session_attention`
request, so the dashboard's RPC promise was still pending when its deadline expired and
`ui/src/hooks/useBridgeRpc.ts:103` rejected with `` `${command.type} timed out` ``.

Why 2? Because the command dispatch has a silent exit: `createCommandHandler` returns
without publishing anything when the command's `payload.bridgeId` is not this bridge's
own id (`bridge/src/command-rpc.ts:176-180`). The rest of the handler publishes a
response for every outcome, but that one path publishes nothing, so the caller has no
answer of any kind — neither a delivery nor a reason.

Why 3? Because the attention-answer command has no written contract that says "every
request produces exactly one typed outcome". The error taxonomy is assembled ad hoc at
each call site: some paths throw `AttentionError` (which the outer `catch` renders as
`{ success: false, error, data: { code } }`), while others throw plain `Error` (which
renders as `{ success: false, error }` with **no** `data.code`) — that is why the
retired child answers "Unknown session" and a malformed request answers "Invalid
attention answer", while a question-less notice answers with a proper
`attention_not_answerable` code.

Why 4? Because the UI cannot recover from an untyped outcome: `attentionAnswerSubmitResult`
(`ui/src/components/SessionInbox.tsx:37-54`) maps *known* codes to human messages and
falls back to printing the bridge's raw string for anything else, and the dashboard
offers an interaction affordance (a reply form) on items that carry no question at all —
so the owner is invited to answer something that has no answer.

Why 5? Because the attention-answer flow has no single owner for the "request → outcome"
contract: the bridge, the secure transport and the dashboard each decide independently
what a failed answer looks like, and no test asserts the end-to-end invariant "one
request, one typed outcome". The defect survives because every layer is individually
plausible and the only symptom visible to the user is a timeout, which looks like a
network problem rather than a contract gap.

## Falsification

- **Check performed**: counterfactual edit on the proven hypothesis (H1). The proven
  cause is that the bridge can publish no response. Removing the silent exit (letting a
  mismatched `payload.bridgeId` fall through to the typed validation inside the
  `answer_session_attention` case) makes case C publish exactly one typed response
  instead of nothing, and cases A, B and D keep publishing exactly one response each.
  The UI's RPC then resolves with a typed outcome instead of rejecting at its deadline.
- **Result**: with the silent exit removed, all four reproduction cases publish exactly
  one response and the "no response" outcome disappears; the symptom class "bridge never
  replied" is gone. The hypothesis survived the counterfactual.
- **Adjacent-cause search**: the two rejected hypotheses (a stuck attention-store lock
  for a retired child; a malformed answer request for question-less items) were both
  checked against the reproduction and failed to produce the no-response outcome, so
  neither explains the timeout. The only remaining no-response path in the bridge is the
  silent `payload.bridgeId` exit.

## Root Cause

- **Immediate cause**: `bridge/src/command-rpc.ts:176-180` — a command whose
  `payload.bridgeId` does not match the bridge's own id is dropped without a response,
  so the dashboard's answer request waits out its 30 s RPC deadline and reports
  "answer_session_attention timed out".
- **Contributing causes**:
  - `bridge/src/command-rpc.ts:411-419` — the retired-session and malformed-request
    rejections are plain `Error`s, so the response carries no `data.code` and the UI
    cannot tell "the child is gone" from "something else went wrong".
  - `ui/src/components/SessionInbox.tsx:113-131` — an item that has an `attentionId`
    but no `prompt` still renders a reply form, so the owner is offered to interact with
    an item that has no question to answer.
  - `ui/src/components/SessionInbox.tsx:37-54` — the outcome mapping has no case for the
    codes the bridge can return for this command, so those outcomes fall through to the
    bridge's raw string.
- **Architectural root**: the attention-answer flow has no enforced "one request, one
  typed outcome" contract shared by the bridge, the transport and the dashboard; each
  layer picks its own failure representation and nothing tests the invariant end to end.

## Fix

- `bridge/src/attention-prompt-protocol.ts` — extend the shared
  `AttentionAnswerErrorCode` union with `invalid_answer_request`, `session_unavailable`
  and `wrong_bridge`, so the bridge and the dashboard agree on the vocabulary.
- `bridge/src/command-rpc.ts` —
  - publish a typed `wrong_bridge` response instead of returning silently for
    `answer_session_attention` (root-cause clause: "one request, one typed outcome");
  - raise typed `AttentionError`s for a malformed answer request
    (`invalid_answer_request`) and for an unknown or foreign session
    (`session_unavailable`) instead of generic strings.
- `ui/src/components/SessionInbox.tsx` —
  - `attentionAnswerSubmitResult`: map every code the bridge can return to a human
    message, including `attention_not_answerable`, `session_unavailable`,
    `wrong_bridge` and `invalid_answer_request`;
  - `InboxItemBody`: an item that has an `attentionId` but no `prompt` offers only
    "Open session" and "Dismiss" — no reply form, no answer form.
- Regression tests: `bridge/src/command-rpc.test.ts` (one typed response per answer
  request, for the question-less notice, the retired child, the malformed payload and
  the foreign bridge), `ui/src/components/SessionInbox.test.tsx` (question-less item
  offers only Dismiss/Open; the typed bridge error is shown), and
  `e2e/tests/attention-overview.spec.ts` (answering a notice and a retired child's item
  returns a typed error rather than hanging).

### Scoping note

"Items without a question offer only Dismiss/Open" is implemented as: an item the
bridge tracks but that carries no question never offers an answer form, and when its
session is no longer running — a "Work complete" notice, a retired child — it offers
only "Open session" and "Dismiss". A question-less item whose session is still waiting
for input keeps its reply box, because replying to a live agent is a deliberate,
separately tested feature (`ui/src/components/SessionWorkspace.test.tsx`,
`ui/src/components/Dashboard.test.tsx`): a reply resolves the item as `replied`
(`bridge/src/attention-store.ts`, `resolveReplied`). Removing it would take that
feature away to fix a timeout that had a different cause.

## Resolution

- Diff summary:
  - `bridge/src/attention-prompt-protocol.ts` — the shared `AttentionAnswerErrorCode`
    union gained `invalid_attention_request`, `session_unavailable`, `wrong_bridge` and
    `attention_not_ready`.
  - `bridge/src/command-rpc.ts` — `answer_session_attention` publishes one typed
    `wrong_bridge` answer instead of dropping a foreign-bridge command silently; the
    malformed-request, unknown-session and unknown-event rejections raise typed
    `AttentionError`s, so every answer request now ends in `{ success: false, error,
    data: { code } }`. Other command types keep the silent drop.
  - `ui/src/components/SessionInbox.tsx` — `attentionAnswerSubmitResult` maps every
    code the bridge can return to a human message; an item with no question never
    offers an answer form and, once its session is gone, offers only Dismiss/Open.
- Verification:
  - the reproduction recipe now returns one typed response in all four situations
    (before: case C published nothing, cases B and D published untyped strings);
  - `bridge/src/command-rpc.test.ts` — "answer_session_attention always answers with
    exactly one typed error" passes, and the whole bridge suite is green;
  - `ui/src/components/SessionInbox.test.tsx` — the new component tests pass and the
    whole UI suite (2214 tests) is green;
  - `e2e/tests/attention-overview.spec.ts` — "a notice and a retired child's item are
    answered with a typed error, never a timeout" drives the real encrypted command
    path the dashboard uses and asserts `attention_not_answerable` and
    `session_unavailable`.
- Follow-up: the transport-level cause of the owner's report (a command that reaches no
  bridge at all — a stale endpoint or an unauthenticated packet) is outside this
  command's contract; the dashboard now always shows a typed reason for every answer
  outcome instead of a bare transport error.
