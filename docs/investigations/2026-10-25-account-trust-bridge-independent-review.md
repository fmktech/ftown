# Independent security review — account-trust bridge slice

Reviewer `/root/account_server_review`, explicitly reused `gpt-6.1-sol` / `high`. Shared checkout `/Users/fkesheh/projects/ftown-simplify-all`, branch `feat/account-trust-pairing`, base `8425849`. Bridge implementation was STOP-WRITE; application code remained read-only. Writable scope was this report only. Frozen contract v1 including v1.1 local-display and v1.2 exact-loopback exceptions was applied. No recursive workers, installs, Git mutations, generated files, servers, databases, browser/E2E or CI execution.

## Verdict

**PASS focused static security review: no confirmed blocking bypass, authority race or destructive migration defect found.** This is not a combined runtime/E2E sign-off. Root owns the supported-runtime bridge gate and the real first-bridge, recovery, direct-peer and browser integration checks.

## Threat model

The bridge handles its persisted HPKE private key, pending enrollment fragment secret, short-lived pairing credentials, owner-authenticated service tokens, signed public account history and terminal/control traffic. An untrusted delivery service may substitute or replay history and enrollment wrappers; remote endpoints may attempt unauthorized root installation, bypass account revocation through old grants/invitations, or keep queued input/output and direct channels alive. Boundaries reviewed are local protected storage to bootstrap identity, public pairing responses to a proof-bound owner/root, configured authenticated history fetches to durable account policy, existing HPKE-authenticated browser administrator to explicit adoption, and policy state to admission/dispatch/egress. OS-local recovery remains an intentional independent authority for one bridge. A malicious service withholding updates or forking old valid state is the frozen design's documented limit; offline grace is not a guaranteed revocation deadline.

## Reviewed boundaries and evidence

- **Virgin versus bound bootstrap:** `bridge/src/index.ts:384-403` creates pending material only when no bound identity exists and no explicit legacy `--token` path was chosen. `:440-495` checks immutable owner, performs a separate authenticated configured history GET, opens the proof-bound approval, saves the same normalized key/root, then persists credentials and starts account policy. Existing identities survive reauthentication; a legacy token does not implicitly confer account authority.
- **Private pending material:** `bridge/src/security/bridge/pending-enrollment.ts:36-58` keeps the pending point/private key on request expiry while rotating only challenge/request/secret. The record is written through `AtomicSnapshot`; `snapshot.ts:24-38` uses a private directory, exclusive 0600 temporary file, fsync, rename and parent fsync. Corrupt/missing-key records fail closed rather than silently replacing a bound key (`identity.ts:41-53`).
- **Secret display:** public start uploads only `enrollment.request`, never the secret (`pairing-client.ts:107-112`). The fragment URL uses operator configuration rather than `verificationUri`; only explicit TTY display receives it, with operational logger receiving instructions (`:114-133`). `pendingPairingLink` validates the unexpired local record and constructs the fragment only for explicit local `ftown security --data-dir ... pair-link` (`pending-enrollment.ts:60-81`, `security-cli.ts:18-22`, `ftown-cli.ts:34`).
- **Authenticated delivery:** `account-client.ts:9-56` allows HTTPS or exact literal localhost/127.0.0.1/[::1] HTTP, rejects credentials/query/fragment and nonliteral loopback aliases, anchors the endpoint to the configured origin, disables redirects, bounds time/body size, and separates unavailable network/auth responses from invalid successful content. The index fetch closure uses the current rotating connect token (`index.ts:450-453,489`).
- **Durable policy:** `policy.ts:279-300` atomically persists history, checkpoint, clocks, device projection and provenance in the same snapshot. First adoption clears all legacy browser grants and invitations. Independently recovered browsers remain per-bridge until they join account membership; joining converts provenance and subsequent revocation cannot fall back to a local grant (`:283-295`). Known tombstones cannot be locally revived (`:141-144`).
- **Adoption:** `security.ts:294-309` admits only an existing browser administrator and fetches public history itself. `policy.ts:303-331` verifies pinned continuity, exact requested root/revision/head, exact bridge point/owner and exact actor membership. It rechecks the actor after cryptographic await inside the serialized transaction. Local CLI/recovery cannot install a root; already pinned policy cannot switch root.
- **Freshness/failure:** `account-state.ts:28-65` starts without restart grace, uses persisted wall highwaters plus monotonic elapsed time and refuses backward movement. Only a valid authenticated history read renews connectivity. `security.ts:274-292` blocks account-derived access on invalid successful history, emits affected endpoint revocations, and treats network unavailability as running-process grace only. A null response cannot reset a pin. Polling is 30 seconds and uses a single in-flight refresh.
- **Admission, queues and egress:** `policy.ts:66-108` checks current account connectivity, own bridge membership, device tombstones, key, generation and permission. `security.ts:165-197,229-244` rechecks admission/egress after crypto. Existing dispatch guards remain in `execute.ts:12-26`, `command-rpc.ts:80`, `local-api-server.ts:222,255`, `index.ts:865` and `centrifugo-client.ts:276-284`; queued cloud publication checks the recipient again immediately before publish (`centrifugo-client.ts:165-172`). `security/bridge/direct.ts:16,30-53` tears down learned revoked peers and validates queued direct input/output through current policy.
- **Recovery and MCP separation:** after adoption remote browsers cannot create local invitations (`policy.ts:110-124`); OS-local capability identity/local CLI can create distinctly marked per-bridge recovery invitations. Account member per-bridge revocation is rejected in favor of account revocation (`:222-229`). Existing fixed-expiry MCP grants/local CLI survive account outages; MCP never receives admin/signing authority (`:172-219`).

## Findings

None confirmed. No speculative hardening suggestion is ranked as a vulnerability. The static review did not reopen the already independently reviewed neutral cryptographic core or the frozen honest-delivery limitation.

## Least-privilege review

No new IAM, OAuth scope, database grant, package dependency or service credential was introduced by this slice. History access uses the existing owner-bound bridge connect token and only public read capability. Account devices deliberately receive read/control/admin under the approved flat-roster contract; MCP remains read/control with fixed expiry and no account signing key. Local recovery is a distinct bridge-local capability, cannot sign the roster or overwrite its root, and cannot retain a shadow grant after its endpoint joins the account. Pending and bound private key material stays in the existing OS-local protected snapshot boundary. Explicit pair-link output intentionally reveals the local pending secret to the operator and does not widen an HTTP/API response.

## Absence checklist

| # | Item | Verdict | Evidence / scope |
|---|------|---------|------------------|
| 1 | Authentication | checked-clean | Existing HPKE-authenticated principals for adoption/control; bootstrap requires candidate private-key proof plus fragment HMAC; history fetched with current owner credential. |
| 2 | Function authorization | checked-clean | Adoption requires browser admin; local CLI cannot install root; remote browser invite blocked after adoption; MCP has no admin capability. |
| 3 | Object authorization / IDOR | checked-clean | Owner/bridge/endpoint/head/request bindings checked across bootstrap/adoption/policy; reauthentication preserves exact bound identity. |
| 4 | Input validation | checked-clean | Shared strict signed parsers, strict local snapshot schemas, bounded history/network body, exact head schema, TTL, URL and wrapper checks. |
| 5 | Injection | checked-clean | New paths use fixed security filenames under operator data directory; no request-derived shell/query/template sink. Existing command execution remains behind current policy checks. |
| 6 | Output encoding / XSS | n.a. | Bridge slice emits encrypted JSON and terminal/local CLI output; no HTML/DOM renderer introduced. |
| 7 | Secrets | checked-clean | Public start only; fragment excluded from operational logger; private local snapshots 0600; configured authenticated GET disables redirects; explicit TTY/pair-link is the authorized display surface. |
| 8 | Unsafe deserialization | checked-clean | JSON plus strict Zod/shared cryptographic parsers; no evaluator or arbitrary class deserializer. |
| 9 | SSRF | checked-clean | New history fetch target derives only from operator configuration, not received enrollment URLs; strict HTTPS/exact local exception and manual redirects. |
| 10 | File uploads | n.a. | No remote upload feature; private local snapshot writes are fixed-path and atomic. |
| 11 | Rate limiting / abuse | checked-clean | No new public listener; existing bounded replay/admission/queue policies retained. History request timeout/body bounds, one in-flight refresh and 30-second schedule bound new delivery work. |
| 12 | Errors / info leak | checked-clean | Account network errors sanitized, typed account failures mapped to bounded bridge errors; no new response/log includes pending secret/private key. |
| 13 | CORS | n.a. | No new HTTP handler or CORS policy in this slice; existing local HTTP encrypted boundary remains unchanged. |
| 14 | Headers / CSRF | n.a. | No browser cookie or form endpoint introduced. Adoption rides the existing authenticated encrypted command with bridge/channel/epoch/replay checks. |
| 15 | Dependency risk | n.a. | No new dependency; reused existing crypto/Zod/runtime APIs. |

## Evidence and remaining gates

Reused root-provided bridge handoff evidence: 49 focused pure/mock tests, production compile and strict TypeScript passed. Inspected the new tests for same-key pending restoration/expiry/0600 mode, explicit local link display, exact-head/wrong-key/absent-actor adoption, actor revocation during fetch, restart refresh, rollback/monotonic grace, learned device revocation/queued authority, invalid-history blocking, encrypted adoption response and reader URL/redirect/body bounds. No redundant run was started. Root is independently executing the supported Node24.22.1 bridge gate.

Remaining root-owned validation: real CLI virgin pairing and persisted-key restart, actual 30-second delivery/revocation across browser/cloud/direct transports, migration from an existing browser pin with outstanding invitations, local recovery/Solo and MCP fixed-expiry regressions, and focused browser/bridge E2E including rendered mobile UX. The supplied 49-test evidence uses pure/mock tests and cannot prove those integration surfaces. Root must retain configured-selector/resource preflight and cleanup evidence.

Report handoff complete. No application write authority was acquired. This report lease is released; reviewer stops writing after handoff.
