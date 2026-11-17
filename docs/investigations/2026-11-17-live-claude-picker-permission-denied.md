---
type: investigation
symptom: "The hosted New Session modal shows Couldn't load Claude sessions for the Default account and an existing project working directory."
slug: live-claude-picker-permission-denied
date: 2026-11-17T13:20:00-03:00
investigator: Codex
git_commit: 9669548cf147cdd7534a2010360d9d2be7de42a3
branch: fix/claude-picker-live
repository: fmktech/ftown
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-11-17-claude-session-picker-bridge-version-and-account-listing.md
---

# Hosted Claude picker reports a generic load failure

## Symptom
- **Observed**: “Couldn't load Claude sessions.” with Retry in the New Session modal, Default account selected, and working directory `/Users/example/projects/legbi-v3`.
- **Expected**: The authenticated dashboard's read-only session-list RPC returns session summaries (or an empty successful list) for the selected working directory.
- **Delta**: The modal renders a generic failure because the live bridge rejects the list command before its native session-list handler runs.

## Reproduction
1. Open the installed FTown dashboard app at `https://ftown.ia.br/dashboard`; it is the hosted dashboard, with Local selected and bridge `a24d2e44-d63f-4fa4-ad53-4b9a594e23cf` shown as v0.30.32.
2. Open New Session, keep Shell Type = Claude Code and Account = Default account, and set Working Directory to `/Users/example/projects/legbi-v3`. The modal displays “Couldn't load Claude sessions.”
3. Send the same command over the live bridge's encrypted local API session path using its current installed CLI identity:
   ```
   rpc=list_native_sessions
   payload={"bridgeId":"a24d2e44-d63f-4fa4-ad53-4b9a594e23cf","workingDir":"/Users/example/projects/legbi-v3","harness":"claude"}
   ```
   Captured response: `{"status":403,"body":{"error":"permission_denied","code":"permission_denied","outcomeUnknown":false}}`.
   The adjacent read-only `get_accounts` command over the same live path returns `{"success":true}`. Verified 2026-11-17.

## UI and deployment provenance
- The owner UI is the installed FTown dashboard PWA at `ftown.ia.br/dashboard`, not a local panel. The New Session modal showed Local and bridge v0.30.32.
- The dashboard HTML references Vercel deployment ID `dpl_8zoSCarepZJWwbUj4w9rH8TTTCUP`; GitHub's `main` Vercel status points to deployment `8zoSCarepZJWwbUj4w9rH8TTTCUP` and is successful on `9669548cf147cdd7534a2010360d9d2be7de42a3`. PR #273's head `9e66cd945e2b363fe2d8298472fdd4a8c7955272` is an ancestor of that main commit. Therefore the observed hosted deployment includes #273.

## Hypotheses

#### H1: The bridge security permission classifier omits `list_native_sessions`, so the picker is rejected as an unknown command before dispatch.
- **Layer**: code-logic / security integration
- **Prediction**: The exact live payload will receive `permission_denied`; the deployed classifier will omit the command from read/control/admin sets; an existing read RPC through the same local API identity will succeed.
- **Verification method**: Capture the exact RPC over encrypted local API against the live bridge; inspect the installed v0.30.32 classifier and repository source; issue adjacent read RPC.
- **Evidence**:
  ```
  Live bridge response: {"status":403,"body":{"error":"permission_denied","code":"permission_denied","outcomeUnknown":false}}
  Installed bridge package: ~/.ftown/cli/package.json => version 0.30.32, gitHead 9669548cf147cdd7534a2010360d9d2be7de42a3
  bridge/src/security/bridge/permissions.ts:7-13: list_native_sessions is absent from readCommands, controlCommands, and adminCommands.
  Adjacent live request: {"rpc":"get_accounts","response":{"success":true}}
  ```
- **Verdict**: PROVEN
- **Rationale**: The live payload receives the predicted structured denial, the installed source uses the same omission, and the neighboring allowed read command succeeds through the identical local transport.

#### H2: A project-directory or transcript read error causes the session-list handler to reject.
- **Layer**: state-data
- **Prediction**: If true, the RPC reaches native listing and its response reflects a filesystem error; a missing or unreadable Claude project directory should fail.
- **Verification method**: Inspect the installed `native-session-list` implementation and compare it with the captured response's security-layer code.
- **Evidence**:
  ```
  bridge/src/native-session-list.ts:12-14 catches any Claude project-root readdir error and returns [];
  bridge/src/native-session-list.ts:20-36 catches individual transcript read/parse errors.
  The live response is HTTP 403 permission_denied, which is returned by security admission before command dispatch.
  ```
- **Verdict**: REJECTED
- **Rationale**: The filesystem code would return an empty list, while the actual response is the security classifier's denial before filesystem code can run.

#### H3: The local browser transport is disconnected, so no RPC response can reach the picker.
- **Layer**: configuration / transport
- **Prediction**: If true, an RPC over the local encrypted API will time out or fail as bridge-offline, and adjacent reads will not complete.
- **Verification method**: Use the installed local CLI's encrypted `localApplication` path against the running bridge and issue `get_accounts` using the same bridge pointer.
- **Evidence**:
  ```
  `ftown harness status --json`: bridge=up, bridgeId=a24d2e44-d63f-4fa4-ad53-4b9a594e23cf, pid=63309.
  list_native_sessions returned an authenticated structured HTTP 403 body, not a transport timeout.
  get_accounts over the same path returned success=true.
  ```
- **Verdict**: REJECTED
- **Rationale**: The encrypted local API is operational and returns a deterministic command denial; the failure is authorization classification, not transport.

## 5 Whys
Symptom: The hosted picker shows a generic Claude session load error.
Why 1? The live bridge rejects `list_native_sessions` with code `permission_denied` before dispatch.
Why 2? `classifyCommand` denies every command absent from its explicit permission sets.
Why 3? The new picker RPC was added to command dispatch but not to the read-only permission allowlist.
Why 4? The RPC change and the encrypted endpoint permission matrix were maintained as separate lists without a regression covering the complete authenticated UI path.
Why 5? The bridge security boundary uses a deny-by-default command registry, but new read RPCs lack a required security-classification integration test at the feature seam.

## Falsification
- **Check performed**: Adjacent-command falsification over the same encrypted local API identity and live bridge.
- **Result**: `get_accounts` succeeds while the exact `list_native_sessions` request returns 403 `permission_denied`; the deployed dispatcher source shows native listing would return an empty list for filesystem errors.
- **Conclusion**: The authorization omission uniquely explains the observed response; transport failure and filesystem errors do not.

## Root Cause
- **Immediate cause**: `list_native_sessions` is missing from `readCommands` in `bridge/src/security/bridge/permissions.ts`; the bridge rejects the actual payload as `permission_denied` before `command-rpc.ts` dispatch.
- **Architectural root**: A new read command was integrated into the RPC handler but not into the separate deny-by-default security command registry, and no authenticated end-to-end command test guarded that boundary.
- **Rejected H2**: The Claude listing code catches missing/unreadable directory and transcript errors; the captured 403 is generated before that code executes.
- **Rejected H3**: The same encrypted path returns an `get_accounts` success and a structured 403 for the picker command.
- **Falsification**: Adjacent `get_accounts` succeeds over the same bridge/transport, while the picker command is denied by its missing classifier entry.

## Fix
- Add `list_native_sessions` to the read-only security command allowlist and cover the exact captured payload.
- Preserve the picker error code from a command response or typed security exception and render it below the generic message.

## Resolution
- Added `list_native_sessions` to the bridge read-only permission set; the exact captured payload is now classified as `{permission:'read',mutating:false,operation:'list_native_sessions',sessionId:null}`.
- Preserved only a bounded `SecurityError.code` through `LocalBrowserClient` and rendered `Code: permission_denied` below “Couldn't load Claude sessions.” Added bridge classifier, local subscription, and picker regression coverage.
- Bumped the bridge to 0.30.33 in `bridge/package.json` and the lockfile.
- Verification: bridge permission suite passed 16/16; PR CI passed unit-tests, unit-minimal, unit-macos (2,289 UI tests passed), all three direct-transport E2E shards, Docker, Vercel, bridge-version/artifact checks, and scan. `git diff --check` passed. UI focused tests were unavailable locally because `ui/node_modules` is absent; they ran in CI.
- The live process remains on v0.30.32 and was not restarted, per the reproduction constraint. The fix is in PR #275 and takes effect after upgrading that bridge to 0.30.33.
- Follow-up: upgrade the live bridge through the normal update path after the fix is merged/published.

## CI diagnosis
- Run `44123263103` completed with the `unit-macos` job cancelled after 15 minutes. GitHub reports `runner_id: 0`, an empty runner name, `status: completed`, and `conclusion: cancelled`; `gh run view 44123263103 --job 134180055020 --log` reports `log not found: 134180055020`. The macOS job never reached a runner, so no test command ran and there is no code failure to reproduce.
- The repository's `unit-tests`, `unit-minimal`, Docker, all three direct-transport E2E shards, bridge-version/artifact, scan, and Vercel checks passed on the same commit.
- A single targeted retry of the cancelled macOS job was requested with `gh run rerun 44123263103 --job 134180055020`. Attempt 2's macOS job `134191724707` received a runner at `2026-11-17T16:35:29Z` and completed successfully at `16:40:31Z`; no full workflow rerun was started.
