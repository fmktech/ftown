---
type: investigation
symptom: "Messages sent to a Codex child were reported as sent, but the child repeatedly read no mail."
slug: codex-hook-mail-marked-before-receipt
date: 2026-11-17T11:47:38Z
investigator: Foad Kesheh
git_commit: 3063254fcd6df13872f75907aa2e54e62c783d9c
branch: fix/codex-child-mail
repository: fmktech/ftown
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related: []
---
# Codex hook mail is acknowledged before the agent's explicit read

## Symptom
- **Observed**: Parent report: `ftown harness mail send <child> --type task|fyi "..."` returned `mail <id> sent` seven times (IDs `mwkkldr5-1804a1`, `mwkkoatr-78f34f`, `mwkkrix3-54b357`, `mwkksl7g-ab9942`, `mwkktyns-fc6417`, `mwkkua9b-17127d`, `mwkl3hpx-3ba295`; 2026-11-17 10:49–11:05Z); the Codex child repeatedly ran `ftown harness mail read` and got `(no mail)`. The child's mail to its parent arrived.
- **Expected**: Sent mail remains visible to the recipient's `ftown harness mail read` until that command reads it.
- **Delta**: A Codex hook or native queue path may hide or mark mail delivered before the agent explicitly reads its inbox.

The parent board identified the recipient as archived Codex session `claude-picker` (`d4ba69d8-7354-47d1-bf32-a8a5f47a0bbf`). The supported read command `FTOWN_SESSION_ID=d4ba69d8-7354-47d1-bf32-a8a5f47a0bbf ftown harness mail read --all --peek --json` returned `ftown harness: Session not found` after the session was archived. Thus the seven historical rows could not be retrieved through the supported CLI; the source-level mechanisms and a deterministic regression reproduction are being investigated.

## Reproduction
1. Arrange an active Codex session with one waking undelivered message.
2. Hold `wakeCodex`'s native queue call open after it claims the message; invoke ordinary `readMail` before resolving the queue call.
3. Resolve native queue with `{ status: 'accepted' }`; inspect mailbox status and retry ordinary read.
4. Run Codex `hook-pump` against one undelivered message; inspect request flags and the resulting mailbox status.

Reproduced in a test-only experiment in `bridge/src/mail-delivery.test.ts` against the unmodified implementation. Command: `cd bridge && node --import tsx --test src/mail-delivery.test.ts`; exit code 1, 95 tests total, 93 passed and 2 failed. At line 1058 the ordinary read during the in-flight Codex claim returned `[]`, expected `['queued during wake']`. At line 1070 accepted native queue delivery set `deliveredAt` to `2026-11-17T11:46:27.755Z`, expected `undefined` before explicit read. The 11/11 baseline hook-pump test also passed on Node 24.12.0 (package engine minimum for Node 24 is 24.22.1). No production source was changed during reproduction.

## Hypotheses

#### H1: Codex transport admission hides or acknowledges mail before the agent's explicit inbox read.
- **Layer**: code-logic / state-data / integration
- **Prediction**: An in-flight native claim makes default reads omit still-undelivered messages; after `codex queue` reports a queued receipt, the bridge marks messages delivered. The hook-pump also drains before it emits output. Therefore a subsequent explicit read can return no mail without the agent having read the inbox.
- **Verification method**: Deterministic test-only reproduction against the existing `MailDeliveryService`; inspect native queue response contract, hook-pump request flags, and delivery state.
- **Evidence**:
  ```
  bridge/src/mail-delivery.ts:340-343 filters claimed IDs in `available`.
  bridge/src/mail-delivery.ts:599-613 uses `available(...)` for ordinary reads and marks the returned messages delivered.
  bridge/src/mail-delivery.ts:765-769 claims pending Codex IDs before starting the queue call.
  bridge/src/native-mail.ts:126-135 treats `Queued message <uuid> for thread <uuid>.` as `accepted`.
  bridge/src/mail-delivery.ts:798-810 calls `markDelivered(..., 'cli')` after accepted queue output.
  bridge/src/harness-commands.ts:523-555 fetches hook mail without `peek` and prints it into Stop/UserPromptSubmit/SessionStart output.
  bridge/src/cli-client.ts:91-98 only sets `peek=1` when explicitly requested.
  bridge/src/harness-hook-pump.test.ts:151-167 currently asserts deliveredAt after hook output.
  ```
- **Verdict**: PROVEN
- **Rationale**: The test-only experiment reproduces both failure modes against unchanged production code: the explicit read returns no queued message while the native claim is active, and queue acceptance sets `deliveredAt` before an explicit read. This establishes a deterministic cause for the reported Codex symptom.

#### H2: The inbox API generally omits undelivered messages, even with no active Codex claim.
- **Layer**: code-logic
- **Prediction**: Both ordinary and peek reads return no message when the store contains an undelivered message and there is no claim.
- **Verification method**: Inspect `readMail`'s paths with claims absent.
- **Evidence**:
  ```
  bridge/src/mail-delivery.ts:575-585: peek returns `mailStore.listUndelivered(session.id)` immediately.
  bridge/src/mail-delivery.ts:599-603: ordinary reads begin with the undelivered list; `available` only removes IDs in an active `codexClaims` set.
  ```
- **Verdict**: REJECTED
- **Rationale**: Without an active claim, both paths start from undelivered messages; general unread filtering cannot explain the symptom.

#### H3: Mail delivery waits until the recipient is idle before exposing pending messages.
- **Layer**: code-logic / integration
- **Prediction**: During an active turn, reads block or return empty until an idle event, even if no Codex claim exists.
- **Verification method**: Inspect `readMail` wait handling and the peek path.
- **Evidence**:
  ```
  bridge/src/mail-delivery.ts:575-585: peek immediately returns undelivered mail before participation/idle logic.
  bridge/src/mail-delivery.ts:587-597: only non-peek long polling uses a bounded wait; it does not wait for an idle transition.
  bridge/src/harness-commands.ts:418-441: explicit CLI read sends `wait: 0`.
  ```
- **Verdict**: REJECTED
- **Rationale**: No idle wait gates a zero-wait read. A Codex claim can hide mail, but that is H1, not idle gating.

## 5 Whys
Symptom: Codex child reports no mail after parent sends it.
Why 1? A queued message is omitted from the default read during a Codex native claim and then stamped delivered when the queue command reports acceptance.
Why 2? Ordinary reads filter claimed IDs and accepted queue output triggers `markDelivered`.
Why 3? Native transport admission is treated as equivalent to agent receipt.
Why 4? Transport handoff and explicit agent acknowledgment share one delivered state.
Why 5? The delivery contract has no acknowledgment boundary reserved for an explicit inbox read.

## Falsification
- **Check performed**: Absence/isolation check: compare reads with an active Codex claim to an undelivered batch outside the claim path.
- **Result**: The regression experiment fails exactly while `wakeCodex` holds the claim; existing ordinary drain coverage (`bridge/src/mail-delivery.test.ts:1380-1405`) receives all three undelivered messages when no Codex claim is present. H2 general unread filtering and H3 idle gating are rejected by source paths and existing tests.
- **Conclusion**: H1 survives; the behavior is specific to Codex claim/queue admission and the test demonstrates it without a production edit. Historical mailbox rows remain unavailable because the recipient session is archived.

## Root Cause
**Immediate cause**: `wakeCodex` stores claimed message IDs in `codexClaims`; ordinary `readMail` filters them through `available()`, and after Codex CLI reports a `Queued message ... for thread ...` receipt, `wakeCodex` calls `markDelivered` before the agent's explicit read. The unmodified-source reproduction proves the immediate cause: read during claim returned `[]` rather than `['queued during wake']`, and accepted queue set `deliveredAt` to `2026-11-17T11:46:27.755Z` (experiment in `bridge/src/mail-delivery.test.ts:1047-1073`).

**Architectural root**: Transport admission is modeled as delivery acknowledgment. The bridge has no distinct state or acknowledgment step for “prompt was queued” versus “agent read inbox.”

**Rejected H2**: With no native claim, inbox reads start from undelivered messages; existing ordinary-drain test reads all three messages (`bridge/src/mail-delivery.test.ts:1380-1405`).

**Rejected H3**: CLI reads use `wait: 0`, and peek returns before participation or idle checks (`bridge/src/harness-commands.ts:418-441`, `bridge/src/mail-delivery.ts:575-597`).

**Falsification**: Absence/isolation check compared unclaimed ordinary reads with the in-flight claimed case; only the claimed case fails. This supports the claim-specific root cause. Historical message records remain unavailable through the supported CLI after archival.

## Fix
The proof gate is satisfied. Explicit `ftown harness mail read` is the acknowledgment boundary; Codex native queue acceptance and Codex hook presentation can nudge/present a pointer but cannot hide or mark messages delivered. Preserve other harness behavior unless evidence requires change.

### Worker brief W1 — Codex mail acknowledgment boundary

- **Tier/model/effort**: Tier 1 development, `gpt-6.1-terra`, `medium`.
- **Checkout and ownership**: shared checkout `/Users/fkesheh/projects/ftown/.claude/worktrees/codex-mail`; worker `/root/codex_mail_fix` owns `bridge/src/mail-delivery.test.ts` for the test-only experiment only. After root records proof and reopens the gate, ownership expands to exactly `bridge/src/harness-commands.ts`, `bridge/src/harness-hook-pump.test.ts`, `bridge/src/codex-installer.ts`, `bridge/src/mail-delivery.ts`, `bridge/src/mail-delivery.test.ts`, `bridge/package.json`, and `bridge/package-lock.json`. Root owns this investigation log and integration, PR, CI, and E2E.
- **Prerequisite and experiment**: H1 is proven and the investigation gate is explicitly reopened. The regression experiment is already in `bridge/src/mail-delivery.test.ts` and fails against old code exactly as recorded above; keep it and implement the complete behavior contract below.
- **Post-gate outcome**: Codex native queue and hook transports can nudge the agent but cannot mark messages delivered or hide them from explicit reads. `ftown harness mail read` retrieves and acknowledges queued mail even during a Codex claim. Explicit read is the only Codex acknowledgment boundary.
- **Post-gate per-file behavior**:
  - `bridge/src/mail-delivery.ts`: stop filtering explicit CLI reads through `available()`; preserve claims for internal competing wake selection. In `wakeCodex`, queue a pointer telling the model to run `ftown harness mail read`; native queue acceptance can mark a nudge/attempt but must not call `markDelivered`. Explicit read remains responsible for marking messages delivered.
  - `bridge/src/mail-delivery.test.ts`: retain the regression experiment; assert explicit read returns a message during a claim and accepted native wake does not set `deliveredAt`.
  - `bridge/src/harness-commands.ts` / `bridge/src/codex-installer.ts`: give Codex an explicit non-consuming hook-pump mode (for example `hook-pump --codex`) that peeks and emits a pointer instructing explicit read; preserve the default Claude pump behavior.
  - `bridge/src/harness-hook-pump.test.ts`: test Codex mode uses `peek=1`, emits the pointer, leaves mail unread, and preserves Claude default behavior and Grok stand-down.
  - `bridge/package.json` / `bridge/package-lock.json`: bump bridge version 0.30.31 → 0.30.32; no dependency/resolution changes.
- **References**: `bridge/src/cli-client.ts` fetchInbox query behavior; `bridge/src/mail-store.ts` markDelivered; `bridge/src/mail-delivery.ts` available/readMail/wakeCodex; `bridge/src/native-mail.ts` Codex queue receipt; `bridge/src/codex-installer.ts` hook command installation.
- **Resource leases**: worker previously ran `npm ci`; it completed and released package-lock/node_modules lease. Dependencies remain installed. During implementation the worker is sole writer for assigned files and sole owner of package-lock/install operations; root will not run tests concurrently. No servers, E2E, CI, or Git operations. Others share the checkout; never revert their edits and do not edit outside assigned scope.
- **Acceptance after gate**: `cd bridge && node --import tsx --test src/mail-delivery.test.ts src/harness-hook-pump.test.ts`; `cd bridge && npm run build`. Regression fails before fix and passes after. Root executes any focused E2E, creates/pushes the PR, associates it using `ftown sessions pr`, and waits for green CI.
- **Handoff**: exact changed files, check commands/results, limitations/findings, and explicit lease release. Stop and ask root to review if the behavior contract proves insufficient. Do not commit, push, rebase, or open PR.

### Dispatch record
- Worker: `/root/codex_mail_fix` (confirmed running by native agent inventory), Tier 1 `gpt-6.1-terra` / `medium`.
- Current write lease: all seven implementation files listed in W1. H1 reproduction passed and root has reopened implementation. No dependency lease.
- Next dependencies: W1 implementation → root integration/runtime/PR/CI.
- Integration owner: root (`/root`).

## Resolution

### Implemented outcome (2026-11-17)

- **Proven cause:** Codex queue admission was treated as delivery. Claimed IDs were filtered from ordinary inbox reads, the accepted native wake marked them delivered, and the Codex hook pump drained mail before reporting its pointer. The child could therefore receive `(no mail)` after the bridge had already recorded delivery. The seven original mailbox rows were not inspectable through the supported CLI after their recipient session was archived (`Session not found`); the unchanged-source test reproduction proved the mechanism deterministically.
- **Fix:** native wake/hook paths now present a pointer without consuming mail. Both `ftown harness mail read` and `ftown sessions inbox` / `mail` use non-consuming inbox pages, write before acknowledgment, and acknowledge compact ID lists only afterward. Pages and CLI output are bounded; large bodies/metadata use server-issued, one-time sequential cursors and a bound completion token. Skips, replay, cursor expiry, failed output, and bridge restart leave oversized mail unread. Codex hook installation uses the Codex-specific pointer pump.
- **Version:** bridge bumped from `0.30.31` to `0.30.32`.
- **Root verification:** focused unit set passed **196/196**; acknowledgment/cursor API cases passed **4/4**; `npm run build` passed; packaged local-bridge smoke passed (`version 0.30.32`, real local bridge, no provider/cloud/database). `git diff --check` passed. Independent closure review found no P1/P2 issues. These checks used local Node **24.12.0**, below the repo's Node 24 minimum **24.22.1**; CI remains the authoritative version-compatible gate.
- **CI/PR:** PR [#274](https://github.com/fmktech/ftown/pull/274), commit `a79bc02`; all **14** reported checks passed, including unit, Docker, scan, and all three direct-transport E2E shards.
- **Limits:** stdout completion confirms successful OS stream output, not that a downstream model consumed the tool result. Non-CLI destructive inbox/long-poll consumers retain their existing semantics.

### W3 implementation brief (2026-11-17)

- **Outcome:** close the remaining P1 mail-loss paths identified by independent review. Both supported explicit inbox CLIs (`ftown harness mail read` and `ftown sessions inbox` / `mail`) must fetch without consuming, write the complete response, then acknowledge only displayed IDs. Preserve `--peek` as non-acknowledging. Respect requested limits and guarantee a bounded response so large inboxes remain readable in pages; indicate when more messages remain. Ack responses must be compact and idempotent.
- **Owner/model:** `/root/mail_read_ack`, Tier 2, `gpt-6.1-sol`, `max`; shared checkout `/Users/fkesheh/projects/ftown/.claude/worktrees/codex-mail`. Root owns integration, listener-backed smoke, E2E/runtime checks, CI, and all Git operations.
- **Writable files:** `bridge/src/sessions-commands.ts`, `bridge/src/sessions-commands.test.ts`, `bridge/src/mail-delivery.ts`, `bridge/src/mail-delivery.test.ts`, `bridge/src/local-api-server.ts`, `bridge/src/local-api-server.test.ts`, `bridge/src/cli-client.ts`, `bridge/src/harness-commands.ts`, `bridge/src/harness-hook-pump.test.ts`, `bridge/scripts/native-mail-bridge-smoke.mjs`. No shared generated output or dependency/lockfile changes. Existing bridge API and wire types are reference contracts; request a root review before changing shared types/routes.
- **Behavior/edges:** the current maximum accepted body is 65,536 characters. Keep serialized inbox responses below 200,000 bytes, including message metadata, within the 300,000-byte encrypted transport ceiling. Honor `limit` on non-consuming reads, return a stable oldest-first page and a `moreAvailable` indication, and leave unreturned messages discoverable. Keep acknowledgment results body-free. For both CLIs, acknowledgment happens only after successful output completion; output/fetch failure leaves messages unacknowledged. `--peek` never acknowledges; `--all` concerns only undelivered messages. Do not change destructive semantics for non-CLI long-poll consumers in this bounded repair.
- **Checks:** worker may run focused unit tests for assigned files and `npm run build`; do not run servers, smoke/E2E, or CI. Root will run the packaged native mail smoke after worker handoff. Handoff must list changed files, exact checks/results, unresolved limits, and confirm all leases released. Contract changes escalate to root; no edits outside ownership.

### W4 closure repair brief (2026-11-17)

- **Trigger:** independent closure review found that a valid 65,536-character control-character body can serialize beyond the response budget and is currently only described, never retrievable. It also found that non-consuming unread `--peek` has no continuation offset.
- **Outcome:** make every accepted mail body retrievable by both supported CLIs while keeping each API response under 200KB; keep oversized mail unread until full body output succeeds. Add continuation offsets for unread peeks as well as `--all` history. Preserve ordinary non-peek acknowledgement behavior (page starts at offset 0 because successful acknowledgment removes it from unread view).
- **Owner/model:** `/root/mail_read_ack`, Tier 2, `gpt-6.1-sol`, `max`; shared checkout. Root retains Git, E2E/runtime, smoke, and CI ownership.
- **Writable files:** `bridge/src/cli-client.ts`, `bridge/src/harness-commands.ts`, `bridge/src/harness-hook-pump.test.ts`, `bridge/src/sessions-commands.ts`, `bridge/src/sessions-commands.test.ts`, `bridge/src/mail-delivery.ts`, `bridge/src/mail-delivery.test.ts`, `bridge/src/local-api-server.ts`, `bridge/src/local-api-server.test.ts`, `bridge/src/security/bridge/permissions.ts`, `bridge/src/security/bridge/permissions.test.ts`. Existing related W3 files are exclusively transferred to this worker after W3 handoff; no other file or lockfile changes.
- **Frozen API:** add `GET /api/sessions/:sessionId/inbox/:mailId/chunk?offset=N&limit=24000`. Use the existing inbox read authorization classification. Validate nonnegative safe integer offset and bounded positive limit (maximum 24,000 JS characters). Return `{message: MailMessage metadata without body, bodyChunk: string, totalChars: number, nextOffset: number|null}`; chunks are exact JavaScript-string slices and responses remain below 200KB even when JSON escaping control characters. Unknown IDs return 404, invalid ranges return 400. This endpoint is non-consuming. Explicit CLI readers detect oversized descriptors, fetch all chunks, reconstruct the complete original message, print it, then acknowledge only after stdout completes. Any chunk/fetch/output failure leaves the message unread. No partial or descriptor-only output may be presented as a successfully read mail.
- **Paging:** allow positive offsets for non-consuming unread peek and `--all`; offsets are oldest-first in the chosen view. `moreAvailable` plus `nextOffset` must be set when another page exists. Both CLIs must suggest the actual continuation command. A normal consuming read uses offset zero and acknowledges complete displayed unread messages only.
- **Clarifications:** oversized descriptors carry their page-relative `index`; after chunk reconstruction the CLI reinserts complete messages at that index to preserve FIFO output and acknowledgment order. Bound response metadata strings to at most 512 characters each; set `metadataTruncated: true` if any were shortened. The exact body remains intact, and the CLI must surface metadata truncation.
- **Acceptance:** test exact reconstruction of a 65,536-NUL body through multiple chunks, every chunk response under 200KB, malformed/out-of-range chunk requests, no acknowledgment on chunk failure, and unread-peek continuation across pages in both CLI aliases. Focused unit/static checks and build are worker-authorized; no server/smoke/E2E/CI. Worker reports files, checks, residual limits, and released leases.

### W5 closure repair brief (2026-11-17)

- **Trigger:** independent review found that W4 reassembled and acknowledged every oversized body in a page, bypassing the page byte bound; it also found that metadata over 512 characters was shortened and then acknowledged.
- **Outcome:** bound every single CLI output page and chunk response, never acknowledge content outside that output, and make oversized bodies plus metadata available through incremental CLI calls. Preserve FIFO ordering for normal page output and keep any unprinted item unread.
- **Owner/model:** `/root/mail_read_ack`, Tier 2, `gpt-6.1-sol`, `max`; shared checkout. Root keeps Git, runtime/smoke, E2E, and CI ownership.
- **Writable files:** `bridge/src/cli-client.ts`, `bridge/src/harness-commands.ts`, `bridge/src/harness-hook-pump.test.ts`, `bridge/src/sessions-commands.ts`, `bridge/src/sessions-commands.test.ts`, `bridge/src/mail-delivery.ts`, `bridge/src/mail-delivery.test.ts`, `bridge/src/local-api-server.ts`, `bridge/src/local-api-server.test.ts`, `bridge/src/security/bridge/permissions.ts`, `bridge/src/security/bridge/permissions.test.ts`, `bridge/scripts/native-mail-bridge-smoke.mjs`. No version/lockfile changes.
- **Frozen behavior:** regular inbox pages remain bounded and include complete messages only. Oversized entries are descriptors and stay unacknowledged. Add explicit CLI continuation options for a single message ID and independent body/metadata offsets. Each invocation returns one bounded body slice and one bounded exact metadata-JSON slice, plus total/next offsets; exact metadata is serialized once and chunked, never truncated. Use conservative chunk lengths so worst-case JSON escaping of both chunks remains below 100KB. The CLI prints a continuation command with both returned offsets. It acknowledges the message only after the invocation outputs the final body and metadata chunks (both next offsets null). Fetch/output failure never acknowledges. CLI must not eagerly reconstruct or output an unbounded page. The existing 200KB API inbox page cap remains; JSON formatting must also remain bounded (lower page budget if needed).
- **Endpoint detail:** reuse `GET /api/sessions/:sessionId/inbox/:mailId/chunk` with required `field=body|metadata`, `offset` (default 0), and `limit` (maximum 7,000 characters). Return `{field, chunk, totalChars, nextOffset}`; for metadata, `chunk` is a slice of the exact `JSON.stringify` serialization of the complete original non-body message fields. Unknown ID is 404; malformed/out-of-range requests are 400. CLI continuation flags name message ID, body offset, and metadata offset. Bound CLI page output to 100KB after formatting; only acknowledge complete messages included in that output.
- **Acceptance:** assert max response/output bytes for a page of 50 max-size NUL bodies, incremental delivery of all body and metadata with exact reconstruction across command calls, continuation offsets make progress, only messages actually completed/output are acknowledged, and failures leave queued mail available. Cover both `harness mail read` and `sessions inbox` / `mail`. Focused tests/build only; root runs smoke and other runtime gates.

### W6 closure repair brief (2026-11-17)

- **Trigger:** independent review found that caller-supplied final offsets can skip all prior chunks while making both `nextOffset` values null, after which the CLI acknowledges the message.
- **Outcome:** continuation must prove a contiguous sequence from the first body/metadata chunk through the last; arbitrary offsets must not qualify a message for acknowledgment.
- **Owner/model:** `/root/mail_read_ack`, Tier 2, `gpt-6.1-sol`, `max`; shared checkout. Root owns integration and all Git/runtime/CI work.
- **Writable files:** `bridge/src/cli-client.ts`, `bridge/src/harness-commands.ts`, `bridge/src/harness-hook-pump.test.ts`, `bridge/src/sessions-commands.ts`, `bridge/src/sessions-commands.test.ts`, `bridge/src/mail-delivery.ts`, `bridge/src/mail-delivery.test.ts`, `bridge/src/local-api-server.ts`, `bridge/src/local-api-server.test.ts`, `bridge/src/security/bridge/permissions.ts`, `bridge/src/security/bridge/permissions.test.ts`, `bridge/scripts/native-mail-bridge-smoke.mjs`. No other files or version/lockfile changes.
- **Frozen contract:** replace client numeric chunk offsets with one-time opaque continuation cursors. First request starts at body/metadata offsets zero. It returns one bounded slice of each plus a server-issued cursor bound to session and message. Each continuation must present the prior cursor; the server consumes it once and issues a new cursor only after advancing contiguous offsets. Arbitrary, skipped, replayed, cross-session, or cross-message cursors fail without advancing. The final chunk response issues a one-time completion token; CLI may submit that token with acknowledgment only after stdout write completion. Ack rejects missing/invalid/replayed completion token for oversized mail. Normal complete-page mail retains output-then-ack semantics. Cursor records are in-memory, store only IDs and offsets, expire after 15 minutes, and are consumed atomically; expiration/restart leaves mail unread and a fresh first read restarts at offset zero. Bound concurrent cursors per session (document the fixed cap) to prevent unbounded resource growth. Keep every invocation output <=100KB and preserve exact metadata/body chunks.
- **Acceptance:** tests attempt end-offset skipping, intermediate skipping, replay, wrong message/session, failed output before ack, and successful sequential cursor completion. Both CLIs must surface the next opaque cursor and only final output+completion token may ack. Run focused unit/build only; root owns smoke/runtime/CI.

Root cause proven. W1 and W2 implementation handoffs are complete; focused checks and builds passed. Root-owned packaged smoke, independent closure review, PR, and CI remain.

### Review finding and acknowledgment contract

The read-only reviewer found that W1's explicit CLI read still used the destructive GET path: `readMail` marks messages before `local-api-server` sends its HTTP response. A client failure in that gap could still lose mail. The accepted contract is a two-step CLI read: fetch queued messages non-consumingly; write their formatted output to stdout and wait for the stream write callback; only then send an idempotent acknowledgment for the undelivered message IDs. If fetch or output fails, no acknowledgment is sent. If acknowledgment fails, the mail remains queued unless the server committed the idempotent acknowledgment; the command reports the failure. This moves acknowledgment after the CLI has received and emitted the message content.

### Worker brief W2 — acknowledge only after CLI output and cover Codex hook installation

- **Tier/model/effort**: Tier 2, complex but bounded, `gpt-6.1-sol`, `max`.
- **Checkout and ownership**: same checkout `/Users/fkesheh/projects/ftown/.claude/worktrees/codex-mail`; W1 is complete and has released its files. W2 owns exactly `bridge/src/cli-client.ts`, `bridge/src/harness-commands.ts`, `bridge/src/local-api-server.ts`, `bridge/src/local-api-server.test.ts`, `bridge/src/mail-delivery.ts`, `bridge/src/mail-delivery.test.ts`, `bridge/src/security/bridge/permissions.ts`, `bridge/src/security/bridge/permissions.test.ts`, `bridge/src/harness-hook-pump.test.ts`, `bridge/src/codex-installer.test.ts`, and `bridge/scripts/native-mail-bridge-smoke.mjs`. No other worker owns these files. Root owns the investigation doc, integration, E2E execution, Git, PR, and CI.
- **Outcome**: `ftown harness mail read` first receives queued mail without consuming it, emits the content to stdout, waits for successful output completion, and only then acknowledges those IDs. Failed fetch/output leaves messages queued. Codex native queue admission and Codex hook pointers remain non-consuming. Installer regression coverage proves only Codex's three turn-boundary events install `hook-pump --codex`; Claude's default pump stays unchanged.
- **Frozen API contract**:
  - `GET /api/sessions/:id/inbox?wait=0&peek=1[&all=1&limit=n]` returns `{messages: MailMessage[]}` without marking delivery.
  - `POST /api/sessions/:id/inbox/ack` accepts JSON `{ids: string[]}` (nonempty, unique IDs; maximum 500) and returns `{messages: MailMessage[]}` containing only IDs newly marked delivered with `deliveredVia: 'cli'`. Unknown/already-delivered IDs are harmless no-ops. Invalid payload returns HTTP 400 using the repository's existing inbox error shape.
  - `MailDeliveryService.acknowledgeMail(sessionId: string, ids: string[]): Promise<MailMessage[]>` is the service boundary and delegates to the serialized store marking path. The route authenticates/authorizes through the existing local API security policy.
  - `cmdMailRead`: always fetches with `peek: true`; with `--peek`, emit and return without acknowledgment. Otherwise emit all selected content, wait for stdout's write callback, then acknowledge only returned messages whose `deliveredAt` is absent. `--all` may include history but must never re-acknowledge delivered rows. Do not ack on fetch, formatting, or stdout failure.
- **Per-file behavior**:
  - `cli-client.ts`: add a typed `acknowledgeInbox(pointer, id, ids)` helper for the frozen endpoint.
  - `harness-commands.ts`: implement output-then-ack sequencing for both JSON and human output; preserve `--peek`, `--all`, limits, and existing session resolution. Ack failure is reported without deleting or hiding still-pending mail.
  - `local-api-server.ts` / `permissions.ts`: route the new ack endpoint and authorize it as a control operation; keep normal GET/POST inbox routes unchanged.
  - `mail-delivery.ts`: add the typed acknowledgment service method under the per-session selection lock; preserve the W1 behavior where default read exposes messages held in Codex claims.
  - Tests: prove a normal CLI read requests peek, emits before ack, then acks only undelivered IDs; peek and failed output do not ack; ack validates limits and is idempotent; Codex claim regressions remain green; installer tests cover fresh install, legacy repair, idempotence, three Codex turn boundaries, and no mail pump in PreToolUse/PostToolUse.
  - `native-mail-bridge-smoke.mjs`: update integration assertions to verify the `mail read` acknowledgment occurs only after its non-consuming fetch and that the second read is empty.
- **Read-only references**: `bridge/src/cli-client.ts` API wrapper; `bridge/src/local-api-server.ts` inbox POST/GET routing; `bridge/src/security/bridge/permissions.ts`; `bridge/src/mail-delivery.ts` `withSelection`, `readMail`, `available`, `wakeCodex`; `bridge/src/harness-commands.ts` `cmdMailRead`; `bridge/src/codex-installer.test.ts`.
- **Resource leases**: dependencies are installed. W2 exclusively owns its listed files and any package-lock/node_modules install activity (none planned); root will not run tests concurrently. Do not run E2E/smoke, CI, servers, or Git operations. Others share the checkout; preserve unrelated edits and do not edit outside scope.
- **Checks**: `cd bridge && node --import tsx --test src/mail-delivery.test.ts src/harness-hook-pump.test.ts src/security/bridge/permissions.test.ts src/codex-installer.test.ts`; run only the ack-specific, non-listener case from `src/local-api-server.test.ts` using `--test-name-pattern`; `cd bridge && npm run build`. Root alone runs listener-backed checks and `node bridge/scripts/native-mail-bridge-smoke.mjs` after handoff, then creates/pushes PR and monitors CI.
- **Handoff**: exact files, all check results, limitations/findings, and explicit lease release. Do not commit/push/rebase/open PR; do not run E2E or CI.

### W2 ownership manifest

| Task | Owner | Tier/model/effort | Writable files | Dependency | Integration |
|---|---|---|---|---|---|
| W2 | `/root/mail_read_ack` (completed; all leases released) | Tier 2 `gpt-6.1-sol` / `max` | `bridge/src/cli-client.ts`; `bridge/src/harness-commands.ts`; `bridge/src/local-api-server.ts`; `bridge/src/local-api-server.test.ts`; `bridge/src/mail-delivery.ts`; `bridge/src/mail-delivery.test.ts`; `bridge/src/security/bridge/permissions.ts`; `bridge/src/security/bridge/permissions.test.ts`; `bridge/src/harness-hook-pump.test.ts`; `bridge/src/codex-installer.test.ts`; `bridge/scripts/native-mail-bridge-smoke.mjs` | W1 complete; two-phase read/ack contract above frozen | Root |

The W2 paths were distinct files with one owner per file. W2 released every file and build lease. Worker test/build checks are isolated; the root-only smoke script remains a separate execution lease.

### W2 handoff

- Worker `/root/mail_read_ack`, Tier 2 `gpt-6.1-sol` / `max`, completed; changed exactly the 11 files in W2 and released all file/resource leases.
- Pre-fix regression experiment: four expected failures covered missing ack route (404), validation (404 instead of 400), missing service ack, and denied permission.
- Post-fix checks: four focused unit files passed 135/135; `node --import tsx --test --test-name-pattern='LocalApiServer inbox acknowledgment' src/local-api-server.test.ts` passed 2/2; `npm run build` passed. Node was 24.12.0 (below the package minimum 24.22.1).
- Root-only local packaged smoke was authored at `bridge/scripts/native-mail-bridge-smoke.mjs` and remains unrun; root owns execution and cleanup.
