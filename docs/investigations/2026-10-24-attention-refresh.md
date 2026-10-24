---
type: investigation
symptom: "why attention doesnt survive a refresh?"
slug: attention-refresh
date: 2026-10-24
git_commit: 35fcf47d2ddbf251ca539c67e395a0095471d577
branch: fix/attention-refresh
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

# Attention disappears after refresh

## Symptom
User report: “why attention doesnt survive a refresh?”
Expected: unresolved attention survives reload; a user message or explicit dismissal clears it.
Observed: the live PWA loses both the top attention entry and popup after refresh.

## Reproduction
1. Installed ftown sessions attention for session a8b5c8f9-1fdf-4e70-912c-cf2fda24c73c, title Refresh persistence check, message This attention request should remain visible after refreshing ftown.
2. Response: event83471db3-3ff2-4def-ab4b-d90ff05fc03b, sequence10, createdAt2026-10-24T10:41:34.447Z.
3. Root CUA AX observation: `button ftown: Refresh persistence check. This attention request should remain visible after refreshing ftown.` and `button Dismiss notification`.
4. Root Cmd+R, then wait for loaded PWA and screenshot: top entry/popup absent; session shows Thinking; no session selected. Reproduced2026-10-24.
5. Root read-only installed client GET /api/sessions/a8b5c8f9-1fdf-4e70-912c-cf2fda24c73c/attention?includeResolved=true&limit=100, filter exact event ID:
```json
{"found":true,"id":"83471db3-3ff2-4def-ab4b-d90ff05fc03b","sequence":10,"type":"agent_needs_input","createdAt":"2026-10-24T10:41:34.447Z","acknowledgedAt":null,"resolvedAt":null,"resolution":null,"hasMore":false}
```

## Hypotheses
### H1: UI attention uses only live in-memory state and never hydrates saved requests.
- Layer: state/data.
- Prediction: the alert disappears on a fresh UI mount while its persisted record stays unresolved.
- Verification: live recipe above plus direct source inspection by /root/session_ui.
- Evidence: ui/src/hooks/useAllSessionEvents.ts39 initializes `new Map`; publication callback54-94 is the only insertion path; full unmount168 resets. No snapshot hydration request. UI dismiss182-188 only removes map entry. Root live evidence shows empty UI and saved unresolved event.
- Verdict: PROVEN.
- Rationale: reset plus absent recovery produces the observed exact difference without a durable state change.

### H2: Refresh/reconnect resolves the bridge record.
- Layer: integration.
- Prediction: saved event gains resolvedAt after refresh.
- Verification: exact post-refresh read above.
- Evidence: `"resolvedAt":null,"resolution":null`.
- Verdict: REJECTED.
- Rationale: the durable request remains open after the UI loses it.

### H3: The attention request exists only as a realtime publication and was never stored.
- Layer: persistence.
- Prediction: the event cannot be retrieved after delivery/refresh.
- Verification: exact post-refresh read above.
- Evidence: `"found":true,"id":"83471db3-3ff2-4def-ab4b-d90ff05fc03b","sequence":10`.
- Verdict: REJECTED.
- Rationale: persisted retrieval succeeds for the same event that disappeared.

## 5 Whys
1. Refresh removes the notice because the React map restarts empty.
2. The map is populated only by live publications received during that mount.
3. The dashboard does not read the bridge's durable unresolved attention state.
4. UI attention and bridge attention were implemented as separate lifecycle projections; dismissal also changes only the UI map.
5. The durable-state contract was not integrated/tested across page reload, so delivery-only tests missed restored and cleared state.

## Falsification
Adjacent-cause check: compare durable state before/after refresh and verify the same bridge/session remains available. The event remains open, while PR132 association and session snapshot still appear. This rejects request-resolution, missing-session, and failed-persistence explanations; event-only UI hydration survives the check.

## Root Cause
The dashboard's attention state is an event-only projection of a durable bridge ledger with no reload restoration. A correct fix must restore unresolved attention and persist the user actions that clear it; replaying events or caching locally alone could resurrect dismissed requests.

## Coordination
Shared checkout: /Users/fkesheh/projects/ftown-simplify-all.
Workers explicitly gpt-6.1-sol/high, previous leases released before reuse.
- /root/session_ui: read-only diagnosis; bounded implementation after exact ownership and reviewed contract.
- /root/npx_review: read-only ledger diagnosis and independent review.
- /root/npx_implementation: safe branch prep completed; future validation and sole Git landing owner.
- /root: investigation/ownership documents and sole live/E2E executor.
Four preexisting dirty investigation notes preserved byte-identically; baseline /tmp/ftown-attention-refresh-notes-before.json.

## Repair contract
- Reuse the bridge attention ledger as source of truth, with typed owner-targeted get_session_attention and resolve_session_attention RPC commands supported by hosted and local browser transports.
- Require explicit matching bridgeId, an owned existing sessionId, and a known eventId for mutations. Never fall back to an arbitrary session.
- Read returns the highest-creation-sequence unresolved unacknowledged explicit agent_needs_input request plus durable identifier/sequence and timestamp; no new storage/schema.
- Session-level dismissal atomically resolves unresolved explicit agent_needs_input incidents through the displayed known event's sequence, preserving all newer incidents. This prevents hidden superseded notices resurfacing on reload. Invalid IDs cause no writes.
- Stamp committed ledger attentionId and attentionSequence into hook publications. Live explicit notices and restored snapshots both use creation-sequence ordering; an older duplicate cannot displace a newer request. Do not mistake harness notification_id for ledger identity.
- Hydrate after initial subscription/reconnect. Fence stale reads by account/client/session ownership and observation generations. Newer events, user prompt and dismissal must win against an earlier pending read.
- Persist dismissal before hiding; if RPC fails, keep the notice retryable. On success clear only the originally captured current notice, never newer attention. User-prompt hooks continue resolving attention on the bridge even when UI is closed.
- Keep tool/permission notice semantics, navigation retention, top-entry text, PR badge/menu and mobile behavior.
- No localStorage-only patch, no new dependencies, no arbitrary timer/TTL clearing. Older bridges degrade without blocking the dashboard; durability requires the new bridge runtime.

## Acceptance gates
Discriminating reload regression must fail against baseline and pass after repair. Unit coverage for bridge ownership, invalid IDs, snapshot filtering, atomic dismissal bounds, UI stale reads/user changes, failed dismiss and prompt persistence. Root executes focused desktop/mobile E2E including refresh after arrival, dismiss, and message, plus live hook regression and rendered screenshots. Workers run static/unit checks only. Patch bump bridge runtime/package lock as required by bridge/AGENTS.md.

## Validation resources
Boat sandbox bx_3snb3bmu, small2vCPU/4GB, TTL3600, no-env/no-snapshots. Root owns creation, dependency installs, E2E and cleanup; exact baseline archive35fcf47d2ddbf251ca539c67e395a0095471d577 transferred. No existing local services touched.

### Pre-freeze review refinements
Independent reviewer /root/npx_review identified legacy ledger/tool lifecycle mismatch and duplicate occurrence ordering. Accepted: hydrate explicit agent_needs_input requests only; preserve existing event-only legacy permission/ask/elicitation behavior. Resolve-through affects explicit requests only. Highest creation sequence determines the current explicit request in both live and restored paths; duplicate older incidents cannot replace newer requests. Scope remains22implementationfiles+2rootdocs.

### Dispatch and environment evidence
Freeze approved by /root/npx_review after explicit-only and creation-sequence refinements; /root/session_ui receives all22exactimplementationfiles, one writer, version/lock lease only. root owns both coordinationfiles. Ownership mechanically validated across24paths. Native IDs and gpt-6.1-sol/high selections recorded in manifest. Git prep finished branch fix/attention-refresh at35fcf47; indexempty and original4notes byte-identical. Boat no-env base installs (bridge, UI, E2E and Chromium) completed exit0 onNode24.22.1, no timeout/OOM. Root retains all E2E/resources; worker may not start servers or browser tests.

### Concrete review findings during implementation
1. Ordinary PostToolUse/Stop observations must not invalidate pending explicit-attention hydration. Only attention-affecting observations fence canonical reads. Add deferred-read/activity regression.
2. A null canonical snapshot followed by a recovered old stamped publication can resurrect a dismissed request. Snapshot response contract revision2 adds the ledger creation-sequence watermark atomically with current attention. Reconcile same/older explicit live IDs with canonical current ID/none; preserve only newer sequences. Cover both replay-before-read-completes and replay-after-read-completes. Prompt/dismiss/account-generation fences remain necessary because resolution need not advance creation sequence. Affected implementation paused for quick independent review of the amendment; no extra files or schema.

Revision2 independently approved by /root/npx_review. Atomic store read/dismiss returns {attention, sequence: ledger.sequence}; RPC also returns sessionId. UI tracks canonical activeId/throughSequence, applies snapshots to stamped current requests at or below watermark, preserves newer requests and fresh unstamped/legacy notices, and rejects stale replay except canonical activeID. Prompt/dismiss-success tombstones override that exception; failed dismissal never advances durable-dismiss watermark. Source writer rebriefed/resumed, same exact22files.

### Validation and review repair
Discriminating RED on baseline useAllSessionEvents.ts failed with saved attention undefined (one selected assertion failure, no tooling issue); patched file restored and hashed. Final reviewer identified delayed prompt ordering: canonical snapshot of new requestB may arrive before older UserPromptSubmit, so tombstoning the current snapshot sequence incorrectly clearsB. Same-file repair makes stamped explicit prompt handling invalidate/read canonical state instead of locally resolving an unbounded current sequence; unstamped/legacy immediate clearing remains. /root/session_ui reacquires only hook and hooktest; remote baseline checks remain isolated and owned by /root/npx_implementation. Root will transfer repaired files before GREEN/E2E.

### Repair closure and initial GREEN
Source reviewer /root/npx_review approved all22files after two-file prompt-order repair; both prompt names have deterministic newer-request preservation regression. Source/version leases released. Remote repaired hook SHA1f88e56352294c95648d70684758d76e210f8866031b4bf5feffeb249759350d, test SHA45675b66fc37f6c400eb4c4ad258f8901e0e8fdb42a90aef47657c9b479c1b7d. Bridge0.19.52 build passed and focused bridge tests53/53 passed. Initial focusedUI72/72 preceded the two-file repair and is explicitly superseded by pending finalUIchecks. RED proof remains valid and discriminating.

### Final unit/static verification
All checks ran in isolated Boatbx_3snb3bmu: focusedUI74/74, fullUI450/450 across41files, focusedbridge53/53, fullbridge890passed+4existing skips, bridge0.19.52build, E2Etypecheck. UItypecheck found a missing explicit current narrowing; original source owner repaired only `if (!current || current.attention?.attentionId !== captured.attentionId) return prev;`, runtime-equivalent because capturedID is present. Root reviewed the one-line equivalent guard; affectedhook29/29 and finalUItypecheck passed. Final24remote hashes match, including all22application/testfiles; allGREENinnerexitCode0 with no timeout/OOM. Logs /tmp/ftown-attention-refresh-checks/. Checks worker released allremote resources. Root starts sole E2E run using preflighted localhost selectors and existing focused desktop/mobile specs.

### Browser environment correction
Root's first browser run passed localhost deployment preflight, isolated schema setup, productionUIbuild(46.2s), services startup and task-owned harnessstatus. All4focused cases failed before attention assertions because `/bin/zsh` was absent: commandlookup `zsh: None`, bridge log `Spawning ... /bin/zsh -l` followed by `tmux session ended without recording an exit code`; terminal marker never appeared and CLI rejected inactive sessions. Both service and infra cleanup exited0. Root preserved first-run logs/screenshots/traces, installed zsh only in the task-owned sandbox, and reran the unchanged fourcases with the same selector preflight and cleanup. Reused the unchanged successful productionUIbuild; no application/source changes made for this environment repair.

## Resolution
The bridge ledger remains authoritative. New owner-targeted snapshot/resolve RPCs restore explicit agent attention on first dashboard load and reconnect; stamped sequence/identity plus canonical watermarks protect against stale publications and delayed prompts. Dismiss persists a bounded explicit-request prefix and preserves newer requests; prompt resolution remains durable when the page is closed. Legacy blocking-notice behavior remains unchanged. Bridge version0.19.52 is required for durable restoration; older bridges retain live-only delivery until upgraded.

Root reran the unchanged focused E2E specs after installing the missing sandbox zsh:4/4passed in42.5s, desktop1280 and mobile390/touch. Verified alerts created while dashboard closed restore on opening and survive a second reload; explicit dismiss and closed-page prompt resolve exact persisted records and remain cleared after reload. Existing navigation/top preview, completion-hook and PR/menu behavior remains covered. New restored-attention screenshots reviewed on both desktop/mobile: message and popup visible and withinviewport. Existing unchanged layout evidence fromPR132 remains valid.

Final evidence: /tmp/ftown-attention-refresh-evidence/ and its .tgz, /tmp/ftown-attention-refresh-checks/, source SHA manifest /tmp/ftown-attention-refresh-source-sha.json. Root verified all22local app/test hashes match tested files. Sandbox cleanup verified all24remote snapshot hashes unchanged, no servicePIDfiles, no Dockercontainers, and ports443/3000/5432/8000closed. Evidence retrieved before task sandboxbx_3snb3bmu deletion; sandbox absent from subsequent inventory. An unrelated imobi sandbox was preserved. No user bridge/services changed.

Worker handoffs accepted: /root/session_ui completed source/repairs and released allwrites; /root/npx_review completed independent approval and released allleases; /root/npx_implementation completed unit/static verification and released allremote resources. Soleintegrationowner will commit/push the exact24ownedfiles and openPR; no merge authorized. Final PR/retirement confirmation is recorded externally after landing to avoid dirtying committed notes.
