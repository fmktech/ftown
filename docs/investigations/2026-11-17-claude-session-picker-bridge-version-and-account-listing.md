---
type: investigation
symptom: "The dashboard New Session modal shows Couldn't load Claude sessions. with Retry."
slug: claude-session-picker-bridge-version-and-account-listing
date: 2026-11-17T00:00:00-03:00
investigator: Codex
git_commit: d206785b727916449bd80e08f0132d5c6e8ac2e5
branch: fix/claude-session-picker
repository: fmktech/ftown
status: resolved
hypotheses_formed: 5
hypotheses_rejected: 4
hypotheses_proven: 1
related: []
---

# Claude session picker reports a generic load failure

## Symptom
- **Observed**: “Couldn't load Claude sessions.” with Retry in the New Session modal (owner screenshot report).
- **Expected**: Show sessions from the selected Claude account, show an empty list when its projects directory is absent, keep usable sessions when individual transcript files cannot be read, and explain that the bridge needs an upgrade when the RPC is unsupported.
- **Delta**: The picker turns an unsupported RPC into its generic load error and its request cannot select an account.

## Reproduction
1. Inspect the production-reported version 0.30.29's published command handler and native session listing.
2. Exercise the 0.30.29 bridge's directory-error failure class against an isolated temporary home: use a non-directory at the Claude projects path, which makes `readdir` reject with `ENOTDIR`.
3. Render the modal with the `work` Claude account selected; verify the picker is absent on the pre-fix PR #270 predicate and present after the fix.
4. Exercise account path selection, absent paths, directory read errors, unreadable individual files, and old-bridge schema errors in regression tests.

Evidence collected 2026-11-17: `npm pack ftown-bridge@0.30.29` succeeded. Its `command-rpc.js` contains `get_accounts` and `list_native_sessions`; its native listing returns empty only for `ENOENT`, rethrows other directory errors, and catches each individual file read. The separate 0.30.4 artifact does not contain the RPC, but that is not the running production version.

## Hypotheses

#### H1: The reported 0.30.4 bridge does not implement the picker RPC, and the picker hides that compatibility failure behind its generic message.
- **Layer**: dependency
- **Prediction**: The 0.30.4 artifact will have no `list_native_sessions` dispatch case; the current UI will render the generic error for its unknown-command response.
- **Verification method**: Inspect the published 0.30.4 tarball and the UI error branch; regression test the response at the component boundary.
- **Evidence**:
  ```
  npm pack ftown-bridge@0.30.4 --pack-destination /tmp
  ftown-bridge-0.30.4.tgz
  tar -xOf .../package/dist/command-rpc.js | rg -n "Unknown command type|list_native_sessions"
  609:                        error: `Unknown command type: ${command.type}`,
  ```
  The current component tests only successful RPC responses; source at `ui/src/components/ClaudeSessionPicker.tsx:31-32` throws on every unsuccessful response and `:64-67` renders the reported text.
- **Verdict**: REJECTED
- **Rationale**: The parent confirmed the running bridge is 0.30.29; inspecting that artifact shows both `get_accounts` and `list_native_sessions`, so this does not explain the current screenshot.

#### H2: A projects-directory read error is the multi-account regression introduced by PRs #269, #268, or #270.
- **Layer**: code-logic
- **Prediction**: One of those PRs will change the native session list path or directory error handling, and reverting that change will remove the regression.
- **Verification method**: Inspect PR file/patch history and compare the published bridge listing; reproduce the ENOTDIR failure path against the deployed 0.30.29 package.
- **Evidence**:
  ```
  package 0.30.29 native-session-list.js: `if (error.code === 'ENOENT') return []; throw error;`
  Reproduction against extracted 0.30.29 package: `0.30.29 reproducer: rejected with ENOTDIR`
  package 0.30.29 command-rpc.js: awaits listNativeSessions without a local error-to-empty conversion
  ui/src/components/ClaudeSessionPicker.tsx:31-32 throws for unsuccessful RPC responses; :64-67 renders the generic message
  ```
- **Verdict**: REJECTED
- **Rationale**: ENOTDIR is a real path to the generic error, but none of PRs #269, #268, or #270 changed this listing implementation; it does not explain the account-picker regression.

#### H3: One malformed or unreadable transcript causes the entire Claude list to fail.
- **Layer**: state-data
- **Prediction**: A per-file parse/read error will escape `listClaude` and reject the RPC.
- **Verification method**: Read the per-file processing loop and its error boundary; exercise an unreadable-file fixture in regression coverage.
- **Evidence**:
  ```
  bridge/src/native-session-list.ts:24-37 wraps each readFile/parse loop in try/catch and continues to push that session summary
  bridge/src/native-session-list.ts:16-17 only catches ENOENT for the project directory; other readdir errors escape
  ```
- **Verdict**: REJECTED
- **Rationale**: Individual transcript failures are already isolated. A directory-level read error is a distinct edge case and will be made best-effort as required.

#### H4: A trailing separator on the home working directory creates a different Claude project slug and causes the generic load error.
- **Layer**: code-logic
- **Prediction**: A request for `/home/` will map to a different slug from `/home`, and a fixture stored under the canonical slug will be missed before the fix.
- **Verification method**: Run the native-session-list regression test with a transcript under the slash-free slug and a slash-terminated request path.
- **Evidence**:
  ```
  Regression test: “normalizes trailing separators in a Claude working directory before resolving its project” passes with one matching session after canonical resolution.
  The old slug expression replaced each raw non-alphanumeric character, including the trailing slash, with '-'.
  ```
- **Verdict**: REJECTED
- **Rationale**: The slug mismatch is real, but when the resulting project directory is absent, the bridge returns an empty list for ENOENT rather than failing. The mismatch causes a missed list, not the generic Retry error.

#### H5: PR #270 hides the Claude session picker whenever a non-default Claude account is selected.
- **Layer**: code-logic
- **Prediction**: With a registered non-default Claude account selected, the account control will show that account but the picker will be absent; the regression test will fail on the pre-fix render predicate and pass when the picker is enabled for the selected account.
- **Verification method**: Inspect the PR #270 diff and run the targeted NewSessionModal test first against the pre-fix predicate, then against the fix.
- **Evidence**:
  ```
  PR #270 changed the predicate from (shellType === "claude" || shellType === "zai") to (shellType === "claude" && selectedAccount === "default" || shellType === "zai").
  Pre-fix test: `shows Claude sessions for the selected non-default account` failed: Unable to find [data-testid="claude-session-picker-account"] after the Account select reached `work`.
  Post-fix same test: 1 passed, 32 skipped.
  ```
- **Verdict**: PROVEN
- **Rationale**: The source diff and red/green regression test directly demonstrate the account-dependent render regression.

## 5 Whys
Symptom: The multi-account modal no longer offers Claude session resumption for a registered non-default account.
Why 1? The Claude session picker is rendered only when `selectedAccount === "default"`.
Why 2? PR #270 added account selection and narrowed the old Claude picker condition without adding account-scoped picker behavior.
Why 3? The session-list RPC still used the default Claude config directory and accepted no account identifier.
Why 4? Account-aware session resumption was omitted from the multi-account UI integration and its regression coverage.
Why 5? The multi-account acceptance path covered creating sessions but not resuming Claude sessions from each account.

## Falsification
- **Check performed**: Compare the three PR diffs, reproduce directory and account-list cases, and run the non-default-account modal test with and without the changed render condition.
- **Result**: The 0.30.29 package rejects with `ENOTDIR` when the projects root is a file; the current fix returns an empty list. Missing paths and unreadable individual transcripts are independently handled. PR #270 is the only one of #269/#268/#270 that changes the modal; its new default-only predicate makes the targeted test fail. Restoring account-aware picker rendering makes the same test pass.
- **Conclusion**: H5 is proven as the multi-account regression. H1–H4 are rejected as explanations for that account-picker regression. The reported generic error remains a generic RPC failure state; the screenshot contains no exact bridge errno.

## Root Cause
- **Immediate cause**: PR #270 changed the New Session modal predicate to show the Claude session picker only for the default account (`ui/src/components/NewSessionModal.tsx`, PR patch at the session picker condition). The regression test failed on that predicate and passed after the fix.
- **Architectural root**: The multi-account UI accepted a selected Claude account but did not carry that selection through the session-resume path or preserve picker availability.
- **Rejected H1**: The actual bridge is 0.30.29 and contains both `get_accounts` and `list_native_sessions`; only account-scoped payloads are unsupported there.
- **Rejected H2**: Non-ENOENT directory errors can cause the generic error, but PRs #269/#268/#270 did not introduce that behavior.
- **Rejected H3**: Individual transcript reads are caught and summarized independently.
- **Rejected H4**: A missing project directory from a trailing-slash slug returns an empty list, not an RPC error.
- **Falsification**: The pre-fix UI test fails after the Account select reaches `work`; the post-fix same test passes. Bridge tests also cover absent directories, non-readable directory paths, and unreadable transcript files.

## Fix
- Update `list_native_sessions` to accept an optional selected account; use its registered config directory for Claude projects, treating missing/unreadable directories as empty.
- Keep each unreadable transcript isolated from the remaining list.
- Render an actionable bridge-upgrade message for unsupported list RPCs and account-scoped payloads rejected by older bridge schemas.
- Add bridge and UI regression coverage, including account path, missing directory, unreadable transcript, partial results, and unsupported RPC.

## Resolution
- Diff: PR #273 re-enables the picker for a selected non-default Claude account, passes the account ID through the RPC, resolves the registered `configDir`, handles missing/unreadable project directories as empty and individual unreadable transcript files as partial results, normalizes working-directory separators, and shows a bridge-upgrade message for unsupported RPC/account payloads. Bridge version is 0.30.31.
- Regression test: `ui/src/components/NewSessionModal.test.tsx`, “shows Claude sessions for the selected non-default account”. It failed on the pre-fix PR #270 condition after the Account selector reached `work` because the picker test element was absent; it passed after the fix.
- Local verification: `bridge/npm run build`; bridge targeted tests (37 passed); UI picker/modal tests (38 passed); `git diff --check`.
- CI verification on PR #273: all unit, minimal-unit, macOS-unit, Docker smoke, direct-transport E2E shards, bridge-version, artifact, scan, and Vercel checks passed.
- The screenshot only exposes the picker's generic message, not its original RPC error code. The investigation reproduces the known 0.30.29 `ENOTDIR` failure path, while the PR regression is independently proven by the failing/passing non-default-account modal test.
- Follow-up: none.
