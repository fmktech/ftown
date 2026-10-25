# Independent security review — account-trust browser/UI slice

Reviewer `/root/account_server_review`, explicitly reused `gpt-6.1-sol` / `high`. Shared checkout `/Users/fkesheh/projects/ftown-simplify-all`, branch `feat/account-trust-pairing`, base `8425849`. Production source was initially STOP-WRITE. Root subsequently reopened a bounded UI repair lease after accepting the two findings below. This reviewer writes only this report; application/test code stays read-only. No installs, Git mutations, generated output, servers, databases, browser/E2E, CI or recursive agents.

## Current verdict

**PASS after bounded repair re-review. Both original findings are closed; no unresolved blocking UI security finding remains in this review.** This is focused static security closure, not a combined supported-runtime, real IndexedDB, browser/E2E or visual sign-off.

The initial review required two concrete account freshness/fail-closed fixes. No cross-owner enrollment, secret disclosure, self-authorizing login, or MCP scope-expansion defect was found in the remaining reviewed paths. The historical findings below retain the original line references and attack cases; the repair closure records the final implementation and evidence.

## Threat model

Browser IndexedDB contains separate nonextractable HPKE and ECDSA private keys, durable signed trust pins and a pending candidate's local enrollment secret. A trusted tab receives signed public history through cookie-authenticated same-origin reads; incoming fragment secrets must be scrubbed before login continuation or telemetry. Attackers may control delivery responses/availability, replay invalid or stale history, retain an expired account authority context, substitute candidate/owner keys, or use a logged-in but unapproved browser to authorize itself. Boundaries reviewed are URL fragments to per-tab continuation, login/session to non-authorizing discovery, public history to verified durable IndexedDB CAS, account connectivity state to actual encrypted send/receive, explicit user confirmation to roster mutation, legacy HPKE-admin pin to migration, and selected MCP consent to exact-bridge receipts. Endpoint software/unlocked-browser compromise and globally guaranteed malicious-service revocation are not claimed defenses; the stated process restart and elapsed-connectivity rules still must hold.

## Closed findings from initial snapshot

1. **[MEDIUM] Cached account trust is usable after restart without a valid read, and actual runtime paths have no elapsed-grace guard** — `ui/src/lib/account-security-client.ts:108-112`, `ui/src/lib/secure-endpoint-runtime.ts:80-87`, `ui/src/hooks/useAccountSecurity.ts:15-17`.
   - Attack: a delivery/network adversary makes the first account GET after reload unavailable; `read()` loads the old durable pin and enters `ready/offline` immediately. No successful authenticated verified read has occurred in that process. During a running page, a stalled GET leaves the previous `ready` snapshot unchanged, while runtime admission/send/decrypt only checks pin/status. Neither path uses a monotonic clock. Thus account-derived browser access can outlive the frozen restart or elapsed-connectivity boundary; changing or freezing the wall clock also defeats its only elapsed check.
   - Severity: medium because this extends previously approved authority under specific delivery/clock conditions; it does not forge a new signing key or independently defeat an honest bridge's own learned revocation.
   - Minimal fix: per-process unready state; renew only after successful authenticated full-history verification and durable CAS; monotonic plus wall/persisted highwater checks. Enforce that authority at actual account-derived handshake/application send and plaintext admission, including after crypto awaits and immediately before queued broker publication. Preserve independently pinned legacy/local/Solo authority by explicitly distinguishing account-derived bridge IDs/tombstones.
   - Acceptance: a fresh client with a recent stored pin and failed GET stays blocked; a valid read enables running-process grace; frozen wall plus 24-hour monotonic elapsed blocks send/receive; paused/stalled refresh does not bypass the check; independent legacy/Solo operation remains available.

2. **[MEDIUM] A network failure clears the effect of a previously received invalid/rollback history without a valid recovery read** — `ui/src/lib/account-security-client.ts:106-117`.
   - Attack: after a valid pin, delivery returns invalid, conflicting or older history. The client exposes `error` but retains the old durable pin without an in-process blocked latch. On the next refresh a network exception enters the cached-trust branch at lines108-112 and exposes `ready/offline` again. No successful matching read has restored trust, contrary to the frozen fail-closed rule.
   - Severity: medium because it resurrects previously approved authority after an integrity failure; no new key approval or cross-owner access is fabricated.
   - Minimal fix: latch received trust-integrity failures for the process, clear that latch only on a successful authenticated verified matching/extending read, and have the runtime authority guard consult it. Network/auth availability must never be treated as proof of recovery.
   - Acceptance: valid read → invalid/rollback response → network failure remains blocked with unchanged durable head/freshness; valid matching continuation recovers without root replacement. Restart independently still requires its first valid read.

Root accepted both findings and sent the original UI worker a bounded repair assignment. Detailed runtime guidance was sent directly: distinguish account source; check before/after asynchronous crypto and actual transmission, not only through a React render/effect or periodic timer. No application patch was made by the reviewer.

## Clean boundary evidence

- `browser-identity.ts:33-63,128-158` generates separate nonextractable ECDSA/HPKE key pairs, atomically adds and reloads the winning account identity across tabs, checks stored algorithms/public keys, and validates signing-key pair possession. No private export is used for browser keys.
- Trust persistence verifies signed continuity against the current durable pin and CASes head plus both clock highwaters inside an IndexedDB readwrite transaction (`browser-identity.ts:65-105`). A stale tab cannot overwrite a newer head or lower persisted clocks. Known null history does not reset a pin (`account-security-client.ts:91-103`).
- Ordinary login/GET exposes an unpinned account as `unapproved` even if its genesis names this installation's keys. Only explicit first-bridge confirmation or authenticated legacy migration invokes `establish`; recovery of a partially committed genesis requires these exact local HPKE/signing keys (`account-security-client.ts:121-143,161-175,215-227`). Established remote history cannot authorize a fresh browser from login alone.
- Device approval verifies the exact server request and opens the secret/HMAC-bound ciphertext against separately fetched full history before bootstrap persistence (`:193-212`). One account roster derives current/future bridge pins; unsigned directory entries only discover/flag keys (`useBrowserIdentity.ts:34-37`, `secure-message-client.ts:79-87`).
- Incoming fragment capture scrubs synchronously before async parsing/session requests; per-tab sessionStorage continuation is size/time/path bounded and excludes fragments from safe login destinations (`account-security-client.ts:238-272`, `PairClient.tsx:27-41`, `DeviceApproval.tsx:102-116`, `login/page.tsx:34-35`). Pair and device routes are excluded from analytics (`auth-mode.tsx:90-94`, `layout.tsx:40-41`). React text/input rendering and fixed error messages avoid turning candidate labels/server exceptions into HTML.
- Pair approval requires the exact fragment request to equal the looked-up bridge request and an explicit comparison confirmation (`PairClient.tsx:62-95`); the new UI rejects legacy pair downgrade. Browser approval cannot occur from an unapproved installation (`DeviceApproval.tsx:81-82`).
- Account revoke uses signed append/CAS; UI explicitly confirms account-wide removal and disables last-admin removal, while core/server enforce it independently (`SecurityDevices.tsx:152-179`). Migration checks an existing local bridge pin/admin, adds the exact bridge point, and verifies the returned adopted head (`account-security-client.ts:215-227`).
- MCP consent obtains independent encrypted receipts only for the selected bridges through existing authenticated runtime commands, requires all selected bridges ready, keeps read/control/fixed expiry, and submits no future-bridge/account signing capability (`McpSecureApproval.tsx:42-66,85-104`). Callback origin/path is checked before navigation. The unchanged server/bridge receipt enforcement was separately reviewed.

## Least-privilege review

No new IAM policy, database grant, OAuth scope, dependency or service secret is introduced by this browser slice. HPKE and signing keys have separate algorithms/usages and remain nonextractable. Account devices intentionally hold account admin authority under the flat-roster contract; bridge directory/session login is non-authorizing. The UI retains independent legacy/local/Solo pins, and the freshness repair must preserve that scope. MCP receives only selected existing bridge read/control receipts and no roster signing authority. Fragment continuation remains in tab-local sessionStorage rather than query strings or analytics; generated candidate requests/secret remain in local IndexedDB as specified for request lifetime.

## Absence checklist

| # | Item | Verdict | Evidence / scope |
|---|------|---------|------------------|
| 1 | Authentication | checked-clean | Same-origin browser session gates HTTP; HPKE/signatures/HMAC establish key authority, never login alone. Server guards separately reviewed. |
| 2 | Function authorization | checked-clean after repair | Findings #1/#2 closed: process freshness, integrity latch, exact own membership and actual runtime admission checks now gate account-derived authority. |
| 3 | Object authorization / IDOR | checked-clean | Owner-scoped storage and exact candidate/head/bridge bindings; immutable account owner from session; selected MCP bridge IDs independently enforced by receipts. |
| 4 | Input validation | checked-clean after repair | Signed schemas/fragment/path/history CAS retained; per-client monotonic and persisted-wall highwaters now checked at actual account operations. |
| 5 | Injection | checked-clean | No new SQL/shell sink in browser slice; React rendering, encoded URLs and strict same-origin return paths. |
| 6 | Output encoding / XSS | checked-clean | Labels/fingerprints/URLs rendered as React text/input values; fixed error allowlist; no new raw HTML sink. |
| 7 | Secrets | checked-clean | Separate nonextractable keys; fragment scrub before continuation/auth/telemetry, no secret in server request shape/returnTo or added logging. Private link display/copy is explicit. |
| 8 | Unsafe deserialization | checked-clean | JSON/shared strict parsers and stored CryptoKeys; no evaluator/arbitrary class deserializer. |
| 9 | SSRF | n.a. | Browser uses fixed same-origin API paths; no new server-side user-controlled fetch target in this slice. |
| 10 | File uploads | n.a. | No upload surface introduced. |
| 11 | Rate limiting / abuse | checked-clean | Server endpoint controls independently reviewed; browser single-flight refresh and bounded polling retained. Stalled refresh's authority effect is covered by #1. |
| 12 | Errors / info leak | checked-clean | Fixed security-message allowlist; no plaintext private keys/fragment in added error output; HTTP body errors remain typed. |
| 13 | CORS | checked-clean | Fixed same-origin credentialed requests, no added reflective/wildcard CORS; server origin enforcement separately passed. |
| 14 | Headers / CSRF | checked-clean | Server mutations require canonical Origin; safe local login-return allowlist; account routes excluded from telemetry, existing global security headers retained. |
| 15 | Dependency risk | n.a. | No new dependency introduced in reviewed UI implementation. |

## Validation and remaining gates

Static source review reused accepted server/bridge/core knowledge and the reported passing focused UI subset. New UI tests were still being authored; this reviewer did not run or modify them. Passing unrelated tests do not close these two missing cases. Root owns supported-runtime combined type/build/test checks, real IndexedDB/two-tab behavior, anonymous fragment→login continuation, account/browser/bridge/MCP focused E2E and rendered mobile review. No runtime or visual sign-off is claimed here.

## Repair closure

Re-reviewed the original worker's stopped production changes and targeted regression tests, including the final residual repair. **Findings #1 and #2 are closed.** No application/test implementation or runtime execution was performed by this reviewer.

- `account-security-client.ts:37-87` now keeps process-only verified-read, wall/monotonic observations and a blocked latch separately from the UI snapshot. `:139-172` requires a valid authenticated current read before granting grace, blocks invalid/older/conflicting history across later network failures, and renews only after signed continuity plus durable CAS. `assertBridgeAccess` checks exact local HPKE/signing membership in the remembered verified account roster, rejects known bridge tombstones, then checks freshness. A stalled refresh cannot extend the callback's authority.
- Closure caught one remaining case within finding #1: another tab could persist this device's revocation before this tab's GET failed, and the old runtime callback needed to reject membership independently of its snapshot. The worker added the exact own-membership guard at `:46-47`, latched offline membership/storage failures at `:168`, and added the cross-tab durable-self-revocation/unavailable-GET regression (`account-security-client.test.ts:234-245`). This residual is closed.
- `secure-endpoint-runtime.ts:37,80-90,112-120,143-207` receives the stable account guard and checks actual handshake/send, post-crypto, post-decrypt and returned delivery. Candidate legacy/recovery enrollment remains under its existing independent proof boundary. Cached ready state does not bypass application sealing, and queued broker handshake/application transmission rechecks synchronously immediately before `raw.publish` (`secure-message-client.ts:108,165`).
- Both hosted consumers wire the stable bound callback and recreate runtime ownership when the account client changes (`DashboardClient.tsx:45`, `McpSecureApproval.tsx:23`). `useBrowserIdentity.ts:33-37` preserves independent legacy availability during account failure; callback classification uses the known account bridge set and permanent revoked bridge IDs so a former account bridge cannot fall through to that independent authority. Solo has no account callback.
- `flushObservation` verifies continuation against the remembered pin and uses the existing IndexedDB CAS to update only the observation highwater, never authenticated server-read freshness (`account-security-client.ts:287-300`). Hook `pagehide`/dispose uses best-effort flush (`useAccountSecurity.ts:18-22`). Browser teardown cannot guarantee an asynchronous write; the explicit restart-valid-read rule remains the safeguard, and no unload durability guarantee is claimed. Existing head/clock CAS logic remains unchanged and prevents a concurrent newer tab from being overwritten.

Final worker handoff evidence: **57 focused Vitest tests passed across 10 files; UI TypeScript and strict E2E TypeScript passed on local Node24.12.0.** Inspected regressions cover startup unavailable with a stored pin, invalid history then network failure, frozen-wall monotonic expiry without timer progress, wall rollback latching/recovery, stalled GET, actual pre-publication and post-decrypt authority changes, independent legacy behavior, cross-tab self-revocation and observation-only flush. These results supersede the earlier 55-test repair subset. Root's supported Node24.22.1 and combined integration/E2E/real IndexedDB/mobile gates remain pending; no duplicate run was started here.

Final handoff complete. Exclusive report lease released; reviewer stopped writing. No application write authority was acquired.


## Narrow native-fetch runtime repair closure

Root's real Chromium diagnostic ruled out browser storage and cryptography: secure context, native HPKE/ECDSA creation/restoration, IndexedDB schema/transactions and the initial trust read succeeded. Root then proved the default native fetch failed with an arbitrary class receiver (`TypeError: Illegal invocation`) and succeeded with the global/undefined receiver. The original `this.fetcher(...)` call therefore failed synchronously before any HTTP account GET and was sanitized as account storage/network unavailability. This is a proven runtime integration defect, not a reopened trust-design finding.

Reviewed the stopped minimal repair: `ui/src/lib/account-security-client.ts:104-106` now invokes the captured capability with `this.fetcher.call(globalThis, path, init)`. All request method, same-origin credentials, redirect, cancellation and body/verification behavior remains in place. Using the global receiver matches the successful root-owned Chromium probe; injected arrow mocks remain compatible.

The production-default-constructor regression at `account-security-client.test.ts:255-270` installs a receiver-sensitive native-like function, rejects any receiver other than globalThis, omits injected fetch to exercise the real constructor default, and asserts both account GET and enrollment POST reach their intended paths. Worker recorded RED on the old call and GREEN on the one-call repair. Reused worker evidence: 22 targeted account/pair/hook tests pass plus UI and strict E2E TypeScript on local Node24.12.0. Temporary passive diagnostics were removed. Root owns the supported-runtime UI build and focused real-browser rerun; no duplicate execution occurred here.

**PASS narrow repair closure.** No additional implementation change requested. Only this report was amended by the reviewer. Report lease released and reviewer stopped writing; all application/test/runtime ownership remains with the designated producer/root.


## Narrow MCP migration observation closure

**PASS test-only closure; no production retry defect found.** Root's round3 retained eight passing focused runtime cases. The remaining MCP case observed no account provenance in its immediate one-shot helper read, while later cleanup observed committed account provenance. Production `migrate` retains the exact legacy pin, reuses an existing same-key roster bridge without another append, and retries adoption; AccountDevices derives its pending rows from legacyBridges and hides them only after acknowledgment or an authenticated account-source response. No production patch was justified.

Reviewed the stopped fixture/test changes:

- `e2e/helpers/secure-browser.ts:55-77` registers and confirms only the exact tracked browser endpoint plus bridge home. Confirmation now polls the actual authenticated OS-local `security_devices` predicate for that endpoint with `source === account`, for up to30 seconds with bounded intervals. A UI row disappearing is still insufficient to pass the committed-state assertion.
- `e2e/tests/e2ee-security.spec.ts:188-194` records the exact migration intent before the explicit click, then still requires committed provenance. This intent lets cleanup safely recognize a migration that committed even if its UI acknowledgment failed.
- Cleanup still reads actual bridge provenance first. It never issues per-bridge revoke for account grants; only an explicitly planned/confirmed exact tuple is accepted, while ordinary unexpected account provenance remains an error (`secure-browser.ts:36-52`). The dedicated task fixture remains responsible for retiring its account state; cleanup does not broaden into account-wide revocation.
- The client regression (`account-security-client.test.ts:274-290`) fails adoption after the roster append, then proves a retry succeeds with one membership/unchanged head. The component regression (`security-panel.test.tsx:154-180`) holds adoption pending after roster update, proves the row remains visible, rejects the attempt, verifies enabled retry, and hides only after success.

Reused worker evidence: client/security-panel29/29 tests PASS, UI TypeScript PASS and strict E2E TypeScript PASS on local Node24.12.0. Application implementation is unchanged. Root owns the supported-runtime unit recheck and MCP-only E2E rerun; the eight unaffected runtime passes and application build can be reused. This reviewer changed only this report and performed no test/runtime/Git operation.

Report lease released; bounded closure complete and reviewer stopped writing.


## MCP provenance diagnosis — production projection gap confirmed

The later root-owned 30-second poll also failed, rejecting the earlier timing hypothesis. The previous test-only closure correctly established retryability, but its inference that waiting would resolve provenance was not supported by the final runtime result. The following production API gap is now proven from the complete source path; it is a functional integration blocker, not a demonstrated authorization bypass.

`BridgePolicyStore.projectAccount` inserts account browser records without a source field and stores their provenance separately as `state.provenance[id] = account` (`bridge/src/security/bridge/policy.ts:293-295`). Its `list` method returns raw `state.devices` without projecting that map (`:161-162`). Persisted `approvedSchema` is strict and intentionally contains no source (`bridge/src/security/bridge/metadata.ts:17-20`). `BridgeSecurityService.listDevices` and `security_devices` command dispatch forward the raw result unchanged (`security.ts:247`, `command-rpc.ts:92`). Therefore a committed account member's response has source undefined and the exact source-account test/UI condition cannot succeed, regardless of polling duration. Cleanup sees no account marker, attempts ordinary per-bridge revoke, and the bridge correctly rejects that account-member revoke. This explains why a committed adoption and failed provenance confirmation coexist without proving a channel-cache failure.

The cache hypothesis is independently rejected: `security/bridge/local-client.ts:15` reloads the OS-local identity and `:35-39` performs a fresh authenticated hello/application for each invocation. Projection preserves local-cli devices (`policy.ts:283`), and local principals are reconstructed from current state for each message. An adoption-time policy-generation race can reject an individual in-flight command, but it cannot explain permanently absent source on repeated successful reads.

Minimal repair stays within the frozen existing `ApprovedEndpoint.source?: local | account` contract (`protocol.ts:120-121`): project source from authoritative `state.provenance` in the authorized list response. Root clarified the exact mapping: account becomes account; local-cli/local-recovery become local; legacy, missing provenance and MCP retain an absent source. Keep the strict persisted device schema unchanged. A meaningful regression must call the actual list/command path before and after adoption using retained OS-local authority and assert browser account source plus local CLI/local-recovery source; tests checking only the internal provenance map cannot detect this omission.

Root and the UI worker were notified immediately; the designated bridge worker must own implementation. No application code, tests or runtime were changed/executed by this reviewer. This integration blocker was routed to the producer; its final repair closure follows below. The previously closed browser freshness/native-fetch findings remain closed.

Bounded diagnosis complete. Report lease released; reviewer stopped writing.


## Device-source projection repair closure

**PASS narrow production repair closure. The MCP provenance integration blocker is closed in source.** Reviewed only the stopped `BridgePolicyStore.list` output projection and its new production-service regression. No authorization, persisted schema, account projection, cache or local endpoint rule changed.

`bridge/src/security/bridge/policy.ts:161-170` still authorizes the current administrator before listing. It now returns fresh output objects and derives source exclusively from authoritative stored provenance: account→account, local-cli/local-recovery→local, while legacy/missing/MCP provenance preserves the absence of the optional source property. It does not add source to strict stored device records. This matches the frozen optional-source comment rather than relabeling ordinary legacy grants as local recovery.

The regression at `account-policy.test.ts:53-100` exercises `BridgeSecurityService.listDevices` with retained OS-local identity before/after adoption, also checks the account browser's actual service output, creates local recovery, and reloads the service. It covers explicit and missing legacy provenance, absent MCP source, account and local output mappings, unchanged policy-file bytes after reads, and no source field persisted in device/MCP records. Thus it catches the original omission at the public service seam instead of merely checking the internal map.

Reused original bridge worker evidence: RED before the projection repair, GREEN after; 25 pure tests, production TypeScript and strict scoped test TypeScript pass on the provisional local runtime. Root owns supported-runtime full bridge/release checks, rebuild and a fresh full nine-case focused E2E run because production device-list output changed. No runtime result is claimed from this static closure.

No remaining change requested for this bounded repair. Only this report was amended by the reviewer; application/test code remained read-only. Exclusive report lease released; reviewer stopped writing.
