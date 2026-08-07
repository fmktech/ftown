---
type: investigation
symptom: "GET /api/sessions/:id transiently returns 500 while a session parent update is being persisted"
slug: session-read-transient-json-500
date: 2026-08-06T21:32:35-03:00
investigator: Foad Kesheh
git_commit: a51d588ead0714c43eb726a0a31f12a57df15858
branch: feat/fticket-orchestration
repository: fmktech/ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-08-06-drop-between-children-does-not-enter-group.md
---

# Session reads transiently return a JSON 500 during parent updates

## Symptom

- **Observed**: CI reported `Expected: 200`, `Received: 500` at `e2e/tests/session-lifecycle.spec.ts:58`. The bridge artifact records, byte-for-byte:

  ```text
  [Bridge] Received command: update_session_parent (requestId: 3080e514-b7ca-441e-b8ef-2871ec855964)
  [LocalApiServer] API route error: Unexpected end of JSON input
  ```

- **Expected**: `GET /api/sessions/:id` returns a complete persisted session with status 200 while an update is in progress or after it completes.
- **Delta**: a reader can observe an incomplete `session.json`, causing `JSON.parse` to throw and the loopback API boundary to convert that exception into status 500.

## Reproduction

1. Construct one `SessionStore` session with a small initial JSON document.
2. In parallel, use one writer to call `saveSession` 120 times with a 2 MB field and one reader to call `loadSession` 8,000 times.
3. Run under Node 24.12.0, the same major version as the failing CI job.

Verified 2026-08-06T21:30:00-03:00 — the single-writer reproduction deterministically triggered the symptom:

```text
{"parseErrors":238,"finalPromptPrefix":"119:","finalPromptLength":2000004}
```

The original CI reproduction is GitHub Actions run `31134540427`, job `92730879358`, test `drag a root between two children to enter their subgroup`.

## Hypotheses

#### H1: In-place `writeFile` publication lets `loadSession` read a truncated or partially written JSON document

- **Layer**: state-data
- **Prediction**: If H1 is true, a single writer racing a reader will produce transient `SyntaxError` failures, while the final document after the writer completes will be valid.
- **Verification method**: Run the single-writer reproduction against the real `SessionStore`, then inspect `bridge/src/session-store.ts:48-60`.
- **Evidence**:

  ```text
  {"parseErrors":238,"finalPromptPrefix":"119:","finalPromptLength":2000004}
  ```

  ```ts
  await writeFile(this.sessionFilePath(session.id), JSON.stringify(session, null, 2), 'utf-8');
  // concurrent loadSession:
  const data = await readFile(filePath, 'utf-8');
  return JSON.parse(data) as Session;
  ```

- **Verdict**: PROVEN
- **Rationale**: The real store fails with one writer, so write/write interleaving is unnecessary. The final file parses, proving readers are observing the in-place publication window rather than a permanently invalid session object.

#### H2: The UI sends malformed JSON in the parent-update request

- **Layer**: dependency-integration
- **Prediction**: If H2 is true, the failing request must pass through an HTTP body parser and fail before `update_session_parent` is accepted.
- **Verification method**: Correlate the CI log with the transport and failing test call sites.
- **Evidence**:

  ```text
  [Bridge] Received command: update_session_parent (requestId: 3080e514-b7ca-441e-b8ef-2871ec855964)
  [LocalApiServer] API route error: Unexpected end of JSON input
  ```

  `e2e/tests/session-lifecycle.spec.ts:56-59` issues a bodyless GET, and `bridge/src/local-api-server.ts:535-544` loads the session without parsing a request body. The update had already been decoded and accepted by the Centrifugo command transport.
- **Verdict**: REJECTED
- **Rationale**: The 500 belongs to a bodyless session GET after the update command was accepted; the only JSON parser on that GET path is persisted-session parsing.

#### H3: Multiple concurrent writers leave `session.json` permanently corrupt

- **Layer**: code-logic
- **Prediction**: If H3 is true, the race requires at least two writers or the final load after all writes will remain malformed.
- **Verification method**: Reduce the reproduction to exactly one writer and load the final file after all concurrent work completes.
- **Evidence**:

  ```text
  {"parseErrors":238,"finalPromptPrefix":"119:","finalPromptLength":2000004}
  ```

- **Verdict**: REJECTED
- **Rationale**: One writer is sufficient to create 238 transient parse errors, and the final 2,000,004-character prompt loads successfully. The defect is read-during-publication, not permanent multi-writer corruption.

## 5 Whys

Symptom: `GET /api/sessions/:id` returned 500 during a parent update.

1. Why? Because `loadSession` attempted to parse an incomplete JSON document.
2. Why? Because `saveSession` truncated and rewrote the live `session.json` path in place.
3. Why? Because readers and writers have no shared lock or atomic publication boundary.
4. Why? Because the store treated completion of `writeFile` as sufficient durability without specifying what concurrent readers may observe.
5. Why? Because the file-backed persistence contract lacked an invariant that committed session snapshots must be published atomically.

## Falsification

- **Check performed**: absence test — remove concurrent publication by completing the same 120 writes before starting the same 8,000 reads.
- **Result**:

  ```text
  {"parseErrors":0}
  ```

- **Conclusion**: H1 survived. With the publication race absent, the symptom disappears; with one concurrent writer present, it reappears while the eventual file remains valid.

## Root Cause

- **Immediate cause**: `saveSession` overwrites the live session path with `writeFile` while `loadSession` reads that same path (`bridge/src/session-store.ts:48-60`). CI captured the resulting `Unexpected end of JSON input` immediately after `update_session_parent`.
- **Architectural root**: the session-store persistence contract does not guarantee atomic visibility of committed JSON snapshots to concurrent readers.
- **Rejected H2**: the failing call is a bodyless GET and the update command was already accepted, so malformed inbound update JSON cannot explain the persisted JSON parse error.
- **Rejected H3**: a single writer reproduces the failure and leaves a valid final file, so permanent multi-writer corruption is not required.
- **Falsification**: serializing writes before reads yielded zero parse failures, while overlapping one writer and one reader yielded 238.

## Fix

- Publish each serialized session to a unique temporary file in the same directory, then atomically rename it over `session.json`.
- Add a store-level concurrency regression test that repeatedly reads while a large snapshot is updated; it must fail before the fix and pass afterward.
- Keep the API test strict: status 500 is a real persistence defect and must not be hidden by retrying it.

## Resolution

- **Diff summary**: `SessionStore.saveSession` now writes a complete snapshot to a unique same-directory temporary file and atomically renames it over the live path. Failed writes clean up their temporary file.
- **Regression test**: `bridge/src/session-store.test.ts` — `never exposes a partial JSON snapshot to concurrent readers` failed before the fix with repeated `Unexpected end of JSON input` / `Unterminated string in JSON` errors and passes after it.
- **Reproduction after fix**:

  ```text
  {"parseErrors":0,"finalPromptPrefix":"119:","finalPromptLength":2000004}
  ```

- **Verification**: the original one-writer/8,000-reader recipe no longer triggers the symptom; targeted regression passes. Full bridge and E2E verification is recorded in the PR checks.
