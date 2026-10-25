# Account trust UI pre-freeze review

Reviewer: `/root/security_ui_impl`, explicitly selected `gpt-6.1-sol` / `high`. Shared checkout; review only. Sources: account contract, account-protocol.ts, protocol.ts amendments, ownership manifest and existing pair/login/identity/security/consent components. No application edits, tests, servers, browser, database or Git operations.

## Verdict

**PASS after central freeze closure.** Root explicitly resolved historical approver membership at the authenticated approval head versus candidate membership in the latest verified continuation. A approves B, A revokes itself, and B resumes within the request lifetime remains a valid enrollment; the core now implements and tests this sequence.

The first review's concrete gaps are resolved in the revised candidate: same-membership bundle resealing during the five-minute enrollment; separate public request/signing-proof validation; explicit fragment encoding/comparison code; large public history fetched outside the bounded HPKE envelope; verified bootstrap does not manufacture a server-read timestamp; adoption names an exact head and the bridge fetches history; legacy browser grants/invitations cannot bypass adoption.

The minor response shapes were frozen explicitly: POST `/api/security/account/enrollments` returns `AccountEnrollmentStatus`; pairing lookup adds `enrollment: AccountEnrollmentRequest | null`. Core method signatures cover the UI integration.

## Threat model and boundary review

Data includes nonextractable browser signing/HPKE keys, fragment-only enrollment secrets, signed account history, account-scoped pairing requests and MCP grants. Authenticated users, other tenants and an untrusted relay/history service can supply public metadata or ciphertext; candidate and approver links cross browser boundaries. The reviewed protections must prevent substituted keys, account takeover through unsigned lookup data, stale-root reset, leaked secrets and migration bypass. Same-origin application code remains trusted; signed history is not Byzantine consensus and the stated offline limitation remains visible.

No additional confirmed vulnerability was identified at this interface-only stage. Implementations are not yet reviewed or verified.

## UI integration constraints

- `/pair` currently redirects before a client can capture a fragment; its replacement must render a client capture gate before login/navigation. Scrub `#account` immediately and retain the validated continuation per tab. Exclude `/pair` and `/devices/approve` from analytics before capture, alongside `/connect`. Login accepts only bounded local continuations and never receives the secret in query/returnTo.
- One explicit first-bridge confirmation creates genesis only in the documented initial bootstrap context. A fresh browser on an established account first requests approval; empty API history never resets a stored root. Show the exact request comparison code and candidate identity before signing.
- Treat CAS conflict as refresh/verify/reconsider, not an automatic stale mutation retry. Membership append plus relay delivery can partially succeed; retain the same request/key and recover its existing membership without another addition.
- Account approval and a live bridge connection are separate UI states. Approved/offline, waiting for the bridge's 30-second refresh, expired enrollment, revoked device, conflicting history and recovery-required must be distinct. No terminal content before verified trust and handshake.
- Migration is an explicit action through a legacy pinned admin connection. A failed adoption stays visibly pending; do not claim the bridge has adopted merely because its roster addition exists. Preserve local recovery and Solo; account-device revocation replaces per-bridge remote revocation for account grants.
- Security Devices shows one account roster without requiring a bridge selector. Activity keeps its bridge filter. Explain that any approved device controls current/future account bridges and can approve devices. Block last-admin revoke and explain that losing every signing key has no automatic password reset.
- MCP keeps a single selected-computer consent with existing signed receipts. Selected bridges must be online and ready; show the blocking computer and a retry action. No implicit future-computer scope, admin permission or account signing authority for the gateway.
- Desktop/mobile use the existing tokens, stacked small-screen cards, controls at least44px, readable wrapped comparison codes and labels, safe-area scrolling, focus restoration and status/error announcements. Preserve the user's pending enrollment across ordinary login continuation without logging its fragment.

## Absence checklist (contract coverage, implementation pending)

| # | Item | Verdict | Evidence / limitation |
|---|---|---|---|
|1|Authentication|checked-clean|Browser session and owner-authenticated bridge reads required.|
|2|Function authorization|checked-clean|Previous active roster signer; explicit initial bootstrap; no MCP account signer.|
|3|Object authorization / IDOR|checked-clean|Owner UUID, root, request, candidate and exact head bind all operations.|
|4|Input validation|checked-clean|Strict bounded canonical schemas; separate request/signature parser added.|
|5|Injection|n.a.|No query/shell implementation in reviewed contracts; server implementation must be checked separately.|
|6|XSS|checked-clean|UI integration will retain escaped React text and finite local redirects; no raw HTML requirement.|
|7|Secrets|checked-clean|Nonextractable keys; fragment secret excluded from HTTP/logs/analytics; per-tab capture required.|
|8|Unsafe deserialization|checked-clean|Strict bounded JSON parsing only.|
|9|SSRF|checked-clean|Bridge fetches history from configured authenticated API, not caller-supplied URL.|
|10|File uploads|n.a.|No upload surface.|
|11|Abuse|checked-clean|Enrollment TTL, request-ID collision protection, rate/capacity bounds specified.|
|12|Errors|checked-clean|Typed sanitized account failures; no raw secret-bearing exceptions.|
|13|CORS|n.a.|No new cross-origin UI API is requested; credential/origin behavior remains an implementation review gate.|
|14|CSRF / headers|checked-clean|Same-origin cookie mutations mandated; client fragment capture must precede redirects/telemetry.|
|15|Dependencies|n.a.|No new package proposed by the UI contract.|

Least privilege: account browsers are intentionally administrators for current/future account computers and must be described as such. MCP remains selected-bridge read/control without account signing/admin authority. Local recovery cannot change account signing authority.

Report lease released after handoff; no application write lease acquired.

## Independent neutral-core review

**PASS: no blocking finding in `bridge/src/security/account-crypto.ts` and its tests against frozen v1.** This is a source review, not a supported-browser execution claim. Root reported28 pure tests passing on local Node24.12; supported-runtime/browser verification remains a later gate. Reviewer did not run checks or mutate application files.

Threat scope: malicious public enrollment/history JSON and relay ciphertext attempt substituted browser/signing keys, wrong owners, stale/forked pins, secret transcript substitution, or enrollment replay. Caller-supplied already-trusted history/pins and initial out-of-band bootstrap remain separate authority decisions; the pure core does not manufacture these decisions or server-read freshness.

Reviewed evidence:

- Browser-neutral imports and standard WebCrypto only; ECDSA generation defaults to nonextractable private keys. Signing verifies the public/private pairing and uses64-byte P1363 over domain-separated canonical bytes (`account-crypto.ts:173–191,255–259`). Existing HPKE receives the full key pair, preserving compatibility with nonextractable private keys (`crypto.ts:193–220`). Browser IndexedDB structured-clone persistence still needs the live UI gate.
- Strict exact schemas, canonical base64url, valid imported curve points/fingerprints, separate signing and HPKE public points, owner/revision/head/time checks, previous-state signer validation, last-admin rejection and permanent ID tombstones are enforced (`account-crypto.ts:39–146,162–244,297–332`). Empty/older/replaced/forked pinned histories fail closed. Independent external signature/hash fixtures and negative history cases are present.
- Browser enrollment signs the complete public request; separate request parsing verifies that proof. Link parsing is bounded, canonical and secret-safe; comparison bytes include exact request and secret (`account-crypto.ts:334–431`). Public encoding/parsing helpers do not log or perform HTTP/navigation; immediate fragment scrub and analytics exclusion are caller obligations.
- Approval envelopes bind owner, exact candidate, request, context, approver and lifetime. HMAC covers the exact request, approved head/time and approver endpoint. Public history stays outside ciphertext. The opener verifies the bundled historical head/approver and candidate membership there and in the latest continuation (`account-crypto.ts:433–510`). It returns no server-read timestamp.
- Tests explicitly cover changed key/request/secret/context/ciphertext, HMAC transcript substitution, historical approver revocation, latest candidate revocation, expired response/same-request resealing, pending bridge export/import/owner normalization and history larger than the transport packet. Reseal storage authorization remains a server integration obligation.

Least privilege: this module exports no HTTP, storage, network or account-reset capability and no private key export. Optional extractable generation/import is explicit for OS-local bridge persistence; browser callers must use default false. Account administrator scope and selected-bridge MCP scope remain the frozen product decision.

| # | Core absence item | Verdict | Note |
|---|---|---|---|
|1|Authentication|checked-clean|ECDSA history/proof, HPKE Auth and secret HMAC; HTTP caller authentication outside module.|
|2|Function authorization|checked-clean|Signer active in previous state; approver active at authenticated bundled head.|
|3|Object authorization / IDOR|checked-clean|Exact owner/root/request/candidate/head/channel/purpose bindings.|
|4|Input validation|checked-clean|Strict exact bounded structures, canonical encodings and validated keys/times.|
|5|Injection|n.a.|No SQL, subprocesses, paths or template sinks.|
|6|XSS|n.a.|No rendering/DOM API.|
|7|Secrets|checked-clean|No logging/network; nonextractable browser defaults; sanitized error constructors.|
|8|Unsafe deserialization|checked-clean|Bounded strict JSON; no executable deserializer.|
|9|SSRF|n.a.|No outbound requests.|
|10|File uploads|n.a.|No files/uploads.|
|11|Abuse|checked-clean|History/device/bridge/link bounds and enrollment expiry; HTTP rate limits remain server-owned.|
|12|Errors|checked-clean|Finite typed account codes; enrollment failures mask native crypto exceptions and supplied values.|
|13|CORS|n.a.|No HTTP handler.|
|14|CSRF / headers|n.a.|No cookie or HTTP surface.|
|15|Dependencies|checked-clean|Uses existing neutral crypto/WebCrypto; no new package.|

Core review report lease released after handoff. All application files remain read-only until root opens the UI implementation lease.

## Implementation handoff — 2026-10-25

UI production, test/helper, and documentation write leases released; STOP-WRITE.
Independent production closure: account-server reviewer accepted the startup-read,
monotonic grace, integrity-failure latch, and cross-tab self-revocation repairs.
No browser/server/database/E2E/Git/dependency operations were executed by this worker.

Implemented separate native nonextractable HPKE/ECDSA persistence, atomic durable
history/head/clock CAS, explicit initial computer/account bootstrap, fragment-safe
login continuation, one browser approval for current/future account computers,
account Devices/revoke/last-admin/recovery UI, explicit legacy migration and
single selected-computer MCP consent. Actual account transport admission checks
freshness and exact membership before/after asynchronous crypto and at publication;
independent legacy/local/Solo authority retains its own rules. Observation flush is
best effort on pagehide/dispose, never renews server-read freshness, and does not
claim guaranteed unload persistence. Startup always requires a valid account GET.

Checks on local Node24.12 (supported-runtime repeat remains root-owned):

- Focused10 UI Vitest files:57 passed,0 failed.
- UI `npx tsc --noEmit --incremental false`:passed.
- E2E strict `npx tsc --noEmit -p tsconfig.json`:passed after final fixture edits.
- React/mobile checklist applied:stable owner-scoped resources, cleanup/disposal,
  escaped finite errors, accessible confirmation/status,44px new controls,
  wrapped mobile cards and no new UI framework/dependencies.

Root runtime command after the coordinated service harness is ready:
`cd e2e && npx playwright test tests/account-trust.spec.ts tests/e2ee-security.spec.ts tests/direct-transport.spec.ts --project=chromium --workers=1`.
The new account spec registers an isolated account per desktop/mobile case, starts
three no-token bridges with private HOME/USERPROFILE/data directories, mirrors the
existing explicit CLI setup and zsh guards, reads private links only through the
explicit local pair-link command, and cleans every owned context/process/home.
It exercises one first-computer confirmation, one phone approval across two
computers, a third computer becoming usable automatically, real native key flags,
reload, delayed stale-GET/two-tab IndexedDB continuity, cross-owner/proof tamper,
cloud terminal opacity, last admin and revocation on every task-owned bridge.

MCP migration uses only the dedicated E2E_MCP_USER_EMAIL/password and the two
E2E_MCP_*_BRIDGE_HOME fixtures registered by the harness. The shared original run
account/bridges remain legacy. Cleanup accepts account provenance only for an
exact tracked endpoint/bridge after explicit adoption confirmation; ordinary
legacy cleanup still rejects unexpected account authority. Existing MCP grants
are separately scoped and no account signing authority is issued to the gateway.

Visual routes/checkpoints:main page encryption diagram; `/pair` comparison;
`/devices/approve` pending/confirm; Security→Devices account list/last admin;
MCP selected-computer consent. The new spec saves desktop390px/mobile screenshots
and asserts no horizontal overflow. Root alone verifies rendered results.

Known documented boundaries:server controls public-history ordering/delivery;
24h grace is not a guaranteed malicious-service revocation deadline; key loss
has no password reset recovery. Hosted `/dashboard` uses account trust on local
HTTP/WebSocket/WebRTC/relay; standalone `/local` remains explicit independent
legacy/local recovery. No unsupported account-derived `/local` claim is made.

### Test-fixture closure

Root's supported-runtime full UI suite exposed a stale complete module mock in
`ui/src/components/LocalDashboard.test.ts`: the account-storage import now reads
additional browser-identity exports. Replaced it with a typed partial import,
overriding only the two local identity/pin operations under test. All four local
handshake/discovery/revocation/retry assertions are unchanged. Focused local
Vitest4/4 and UI TypeScript passed. Application files remain unchanged;
test/report leases released, STOP-WRITE. Root repeats its supported-runtime gate.

### First live account approval — investigation in progress

Observed root-owned E2E: first computer confirmation stayed disabled for30s.
The page displays the comparison code and first-browser explanation, plus the
finite `account_storage_unavailable` alert. Expected: valid matching private
link and authenticated account storage allow explicit confirmation.

H1(request object ordering/JSONB) REJECTED: the captured private request and
lookup200 enrollment are equal structurally and in insertion-order serialization,
including candidate keys. Core enrollmentShape also rebuilds both parsed inputs
in its fixed field order. No PairClient change is justified.

H2(account-history HTTP outage/authorization) REJECTED for this observed failure:
the trace has successful authenticated session bodies with valid UUID owners and
lookup200, but contains zero `/api/security/account` requests. read() awaits keys()
before its GET, so account HTTP was not reached. Console contains only the
unrelated Vercel analytics script404/MIME rejection; no captured crypto pageError.

H3(pre-GET browser keys/IndexedDB initialization failure) INCONCLUSIVE pending
native operation evidence. Requested a root-only passive crypto/IDB observer
recording operation/store names, success and sanitized native error names, never
values/keys/URLs/fragments. No application/test edits made; investigation has not
crossed the source-edit gate. Root remains sole runtime executor.

Reproduction evidence:root-owned account-trust1280 case under trusted TLS8444,
`/tmp/ftown-account-e2e-round1/...1280--chromium/{trace.zip,error-context.md}`.
Falsification:direct trace comparison rejected the original ordering hypothesis;
rendered exact-link UI independently corroborates that rejection.

### Opt-in native storage diagnostic handoff

STOP-WRITE:only `e2e/helpers/account-pairing.ts`,
`e2e/tests/account-trust.spec.ts` and this report changed. With
`FTOWN_E2E_STORAGE_DIAGNOSTICS=1`, only the1280px account case installs a passive
native observer before login. The bounded1000-event attachment
`account-storage-diagnostics` records crypto/IDB operation names, allowlisted
store names, allowlisted native error names/numeric codes, and function-name plus
line/column stack frames with all URLs/filenames/messages omitted. The one safe
environment event contains isSecureContext, subtle availability and indexedDB
type. Native arguments/results/errors are forwarded unchanged. No app outcomes
or business assertions changed; unavailable diagnostics do not mask the test.
E2E strict TypeScript passed. No runtime/browser/server/E2E execution by worker.
Root-only invocation:prefix the existing focused Playwright command with
`FTOWN_E2E_STORAGE_DIAGNOSTICS=1` and select the1280 case. Instrumentation is
optional and removable after the native failure is identified.

### Root cause proven: native fetch receiver

H3(browser storage/crypto initialization failure) REJECTED by the root-owned
native diagnostic:secure context true, all HPKE/ECDSA generation and stored-key
validation succeeded, IDB stores/schema/reads/writes/transactions succeeded,
and account-trust read completed before the missing HTTP request.

H4(browser fetch invoked with AccountSecurityClient receiver) PROVEN. Root's
native Chromium probe observed `Reflect.apply(fetch, {}, ['data:text/plain,probe'])`
throw TypeError `Failed to execute 'fetch' on 'Window': Illegal invocation`;
the same capability succeeds with globalThis or undefined. AccountSecurityClient
stores native fetch in a property and invokes `this.fetcher(...)`, supplying the
class instance. json() catches that synchronous failure and masks it as unavailable
before a network request can exist. The newly written receiver-sensitive default-
fetch regression fails on unchanged source:expected unapproved, received error.

5 Whys:first computer button disabled because account status is error; account
status errors because history retrieval is unavailable; retrieval fails before
HTTP because native fetch rejects the class receiver; the dependency was stored
and invoked as an object method instead of a global capability; Node/arrow mocks
accepted arbitrary receivers, leaving this browser-native boundary untested.

Falsification:the same validated link/lookup values are identical, all native
storage operations succeed, and changing only the receiver in root's isolated
browser probe changes failure to success. Thus the receiver hypothesis survives
independent storage/data checks. Exactly one immediate cause is proven.

Planned minimal fix:invoke the captured fetch capability with globalThis as its
receiver for both account reads and writes, retaining all credentials/origin,
validation, binding and trust checks. Regression uses a native-like receiver-
checking fetch through the production default constructor; it checks actual GET
and enrollment POST behavior. Remove temporary diagnostics after retaining this
evidence; application error sanitation remains unchanged.

Receiver repair STOP-WRITE:the account fetch call now explicitly uses globalThis.
Receiver-sensitive regression observed RED on old source and GREEN after the
one-call fix; focused account client/pair/hook tests22/22 pass. UI TypeScript and
strict E2E TypeScript pass (local Node24.12 provisional). Temporary native
observer and its spec wiring were removed completely. PairClient/shared crypto/
request comparison are unchanged. Exact changed paths:account-security-client.ts,
account-security-client.test.ts, account-pairing.ts and account-trust.spec.ts
(diagnostic removal only), plus this report. Leases released; root owns the
supported browser rerun. No worker runtime/browser/server/E2E/Git execution.

### MCP migration observation race — bounded investigation

Root round3:8/9 focused runtime cases passed, last MCP case's one-shot local
provenance check found no account source immediately after UI row count0; the
same test's later cleanup observed sourceaccount on that tracked endpoint.
H1(roster append permanently hides an unadopted bridge) REJECTED by source:
AccountDevices rows use legacyBridges and hide only after migrate resolves or
an authenticated devices response has account provenance. migrate reuses an
existing same-key roster bridge on retry and rechecks the legacy administrator.
H2(bridge never committed adoption) REJECTED by later authenticated local devices
account provenance and the trace's subsequent migration-confirmed UI snapshot.
H3(one-shot fixture observation races the asynchronous migration) PROVEN as the
immediate test failure:helper reads only once, sees the earlier state, throws,
and cleanup sees the committed later state. A row-count observation is not the
bridge's durable state authority. No production defect is proven.

5 Whys:test fails because the exact sourceaccount check is false; it is false
because the immediate read observes a transition before its committed state is
visible to that check; the helper treats one sample as final; its synchronization
uses UI absence instead of the service's eventual committed-state predicate;
the fixture did not model the asynchronous append/adopt boundary. Falsification:
production retry remains available after a failed adoption, and later sourceaccount
proves this was not a permanent policy/ownership denial.

Bounded repair:poll the same authenticated OS-local sourceaccount predicate with
a deadline; retain exact endpoint/home tracking. Mark only this explicit migration
attempt for cleanup so a later observed committed account grant is retired with
the dedicated task-owned fixture, never per-bridge revoked. Unknown account
provenance on ordinary legacy grants remains an error. Add client/component
regressions proving append-before-adopt failure retains the retry action and
reuses the same roster membership. No production behavior change is justified.

Migration observation repair STOP-WRITE. Production remains unchanged. The helper
now polls the exact authenticated bridge/endpoint/sourceaccount predicate for up
to30s with bounded intervals. The dedicated MCP test registers that exact tracked
migration intent before clicking, so an ACK/UI failure cannot strand committed
account provenance during cleanup. Cleanup still reads actual provenance and
never issues per-bridge revocation for a sourceaccount entry; ordinary unplanned
account-source entries remain errors. Explicit sourceaccount verification and
all business/security assertions remain intact.

New client regression proves failed adoption after the roster append can retry
without a duplicate membership; component regression proves the row remains
visible/pending, returns an enabled retry after failure, and hides only on success.
Focused client+security-panel tests29/29 PASS; UI TypeScript PASS; strict E2E
TypeScript PASS (local Node24.12 provisional). Exact changed files:
account-security-client.test.ts, security-panel.test.tsx, secure-browser.ts,
e2ee-security.spec.ts and this report. No application body changes and no
worker browser/E2E/server/Git execution. All leases released; root can retain
its8 unaffected runtime passes and rerun only the dedicated MCP case.

### Round4 falsifies the migration timing diagnosis

The unchanged strict sourceaccount predicate remained false for30s. This rejects
H3 from the previous section; the earlier inference from aggregated cleanup was
insufficient evidence of a later public sourceaccount response. Do not retain
that timing explanation as a proven product cause.

Independent reviewer identified, and this worker directly corroborated, the
actual bridge output gap:BridgePolicyStore.list():161-162 returns state.devices
unchanged; account projection at:293-295 writes `state.provenance[id]='account'`
separately and pushes an ApprovedEndpoint without source. policySchema stores
that provenance separately. Therefore security_devices cannot expose the frozen
public sourceaccount discriminator, even though the policy correctly knows it
and rejects per-bridge account revocation. This explains both the persistent
predicate failure and cleanup rejection; it is not an approval propagation race.

Read-only CLI inspection rejects the cache hypothesis:localApplication reloads
its local identity and performs a fresh hello/epoch on every call. cli-client's
securityCommand does mask unsuccessful inner command details as a generic Error,
so ordinary error aggregation alone cannot distinguish that rejection.

Root notified to route the bounded source projection repair to the bridge owner.
No helper/spec/application edits made in this diagnostic turn; strict predicates
and security assertions remain unchanged. Additional instrumentation is held
because the concrete production cause is now identified. Report-only lease
released; STOP-WRITE pending root's bridge repair/verification.

### Selected-only MCP assertion diagnosis

Round5:all8 other runtime cases passed. The selected-only assertion inspected
only JSON-RPC error/isError, while this aggregate tool reports per-machine errors.
H1(default-all consent accidentally granted secondary) REJECTED:component starts
selected=[]; trace consent contains exactly1 machine and1 receipt, and secondary
is disjoint from that submitted machine set. H2(actual secondary authorization
bypass) REJECTED:trace response for RPC20 has sessions=[],total0 and exactly1
secondary error codeforbidden/outcomeUnknownfalse; no session data is disclosed.
H3(wrong fixture response-shape assumption) PROVEN:server.ts633-694 explicitly
catches each machine error into structuredContent.errors, returning a normal
successful aggregate RPC. MCP owner's independent read corroborates the exact
forbidden result and pre-dispatch authorization check.

5 Whys:test fails because top-level error is absent; it is absent because the
aggregate operation succeeded in collecting a denial; denial is per machine so
other authorized machines can still return results; test assumed a single-target
error convention for a fleet aggregate; fixture lacked a contract-derived exact
per-machine denial assertion. Falsification:exact single consent and the forbidden
entry/zero data refute selection widening and authority bypass.

Test-only repair:assert exact checked bridge IDs, real selected primary session
and no primary errors, and exact secondary forbidden denial plus zero sessions/
total. Production remains unchanged; no generic empty-result acceptance.

Selected-only test repair STOP-WRITE. Changed only e2ee-security.spec.ts and this
report. Strict E2E TypeScript passed. Exact checked-ID assertion guards consent
scope; selected primary must return the created session with no errors; secondary
must return exactly forbidden/outcomeUnknownfalse, sessions[] and total0.
Production/assertion scope otherwise unchanged. Root owns MCP-only runtime rerun;
worker executed no browser/E2E/server/Git operation. Leases released.
