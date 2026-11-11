# Passkey ledger (v2) — contract

Status: final for release 0.21.0. Supersedes `docs/investigations/2026-10-25-account-trust-contract.md` (v1 roster, password sessions, refresh tokens, SAS/TOFU pairing). v1 is deleted from the code, not kept beside v2.

Provenance: written from the frozen design notes and from the code as implemented. Where they differ, the code is described. Statements marked "not verified" were not confirmed by reading or running code.

Paths are relative to the repository root. `bridge/src/security/ledger/` is the shared core (imported by the UI as `@security/ledger/*`). It is ES2017 and uses WebCrypto only.

## 1. Goals and threat model

Goals:
- One account root: a WebAuthn passkey (ES256, P-256). Every change to the account (add/remove a browser, a computer, or another passkey) is a record signed by a passkey.
- The server holds no password and no refresh token. It issues sessions and relay tokens only to a caller that proves possession of a key listed in a ledger the server has verified.
- Each bridge keeps and verifies the ledger on disk. The server stores a copy and relays it but cannot create or alter a record.
- Solo and `--local` keep working unchanged (section 12).

Adversaries and what the design gives:
- Compromised or malicious server (or database): cannot forge a ledger record, cannot bind a bridge or browser to another account (pairing proof, authority consent, section 5 and 11), cannot make a replica go back to a shorter chain (section 6). It can withhold or delay records, serve a stale or forked chain to a replica that has not seen the newer one, and see the public ledger. [Superseded in part by 2026-11-10-append-only-ledger.md: a replica now refuses a valid different history instead of choosing between them; see its threat analysis.] It can mint relay/session tokens only for keys that the ledger it holds lists. (The server's own copy is protected against a database-only writer by the sealed checkpoint; see "Server reads: sealed checkpoint" in the amendment at the end.)
- Network attacker: same as the server for the parts that are unauthenticated; the ledger is self-authenticating, so a tampered ledger does not verify.
- Stolen browser or computer: the owner removes it with a passkey-signed record; access stops at the next ledger update (bridges) and at the next relay token (at most 1 h, section 9).
- Lost or compromised passkey: not recoverable inside the account (section 5).

Not in scope: a compromised page served by the server (section 14), loss of the Apple/keychain account, a malicious operator of the device that holds the passkey.

## 2. Ledger v2 format

Defined in `bridge/src/security/ledger/protocol.ts` (types) and `ledger.ts` (parse/verify).

Domains (all prepended to the signed/hashed bytes):
- `LEDGER_DOMAIN = 'ftown-account-trust-v2\n'` for ledger records.
- `SIGNIN_DOMAIN = 'ftown-signin-v2\n'` for the sign-in identification nonce.
- `AUTHORITY_CONSENT_DOMAIN = 'ftown-authority-consent-v2\n'` for authority consent.
- Possession proofs use `'ftown-auth-proof-v1\n'` (`proof.ts`); the pairing code and proof use `'ftown-pair-code-v2\n'` and `'ftown-pair-proof-v2\n'` (`pairing.ts`).

Types:
- `LedgerAuthority { credentialId, publicKey (raw 65-byte P-256 point, base64url), label, addedAt }`.
- `LedgerDevice { endpoint: EndpointPublic, authPublicKey, label, approvedAt }` — a browser; `endpoint.kind` must be `browser`.
- `LedgerBridge { bridgeId, endpoint, authPublicKey, label, approvedAt }` — a computer; `endpoint.kind` must be `bridge`.
- `LedgerGenesis { type:'ftown_account_genesis', version:2, rpId, origins[], handle (WebAuthn user.id, 32 random bytes), createdAt, authority }`.
- `LedgerOperation`: `add_device | revoke_device | add_bridge | revoke_bridge | add_authority`. There is no `revoke_authority` (section 5). `add_authority` carries `consent: PasskeySignature`.
- `LedgerTransition { type:'ftown_account_transition', version:2, accountId, revision, previousHead, issuedAt, credentialId, operation }`.
- `PasskeySignature { authenticatorData, clientDataJSON, signature (DER) }`, all base64url. `Signed<T> { payload, signature }`. `Ledger { genesis: Signed<LedgerGenesis>, transitions: Signed<LedgerTransition>[] }`.
- `LedgerCheckpoint { version:2, accountId, revision, head, authorities, devices, bridges, revokedDeviceIds, revokedBridgeIds }` — the derived state of one verified chain.

Hashing and identity:
- Canonical bytes: JSON with recursively sorted object keys, array order kept, finite numbers only.
- `ledgerChallenge(payload) = SHA-256(UTF-8(LEDGER_DOMAIN + canonical(payload)))`. This value is both the WebAuthn challenge of that record and its head.
- `accountId = base64url(ledgerChallenge(genesis.payload))`; it equals the genesis head and is revision 0. The genesis hash does not cover signatures. `EndpointPublic.ownerId` carries `accountId` for ledger endpoints (`crypto.ts` accepts the 43-character base64url form besides UUID and `solo:` forms; the regex is at `bridge/src/security/crypto.ts:46`).

Structural rules enforced by `parseLedger`/`verifyLedger` (all failures throw `LedgerError`, codes `invalid_ledger | ledger_other_account | ledger_revoked | ledger_limit`; no untrusted text is put in the message):
- Strict shapes: exact key sets, canonical base64url, 65-byte uncompressed P-256 points, labels up to 200 characters with no C0/C1 controls, zero-width, bidi controls, BOM or unpaired surrogates (a signed label is refused, never rewritten). `rpId` is a lowercase DNS name; `origins` are 1..16 distinct canonical `URL.origin` strings, `https`, or `http` only for `localhost`.
- Chain: `revision = previous + 1`, `previousHead` equals the previous head, `issuedAt` non-decreasing and not more than 30 s in the future (`maxFutureSkewMs`), `approvedAt`/`addedAt` not after the record's `issuedAt`.
- Key hygiene: endpoint id equals `SHA-256(endpoint.publicKey)`; every key is a valid curve point; `authPublicKey` differs from the endpoint key; no key is shared across roster members; endpoint `ownerId` equals the accountId.
- Tombstones: revoked device ids and bridge ids are permanent. A revoked id can never be added again; a new bridge needs a new bridgeId, a new browser needs new keys.
- Limits (`LEDGER_LIMITS`): 2,097,152 bytes, 1024 transitions, 8 authorities, 128 devices, 128 bridges, label 200, offline grace 86,400,000 ms.
- `verifyLedger(ledger, now)` verifies exactly one chain from genesis and returns the last checkpoint. It has no pin argument; fork choice is `chooseLedger` (section 6).

## 3. Passkey signature rule

`verifyPasskeyAssertion` (`webauthn.ts`) is pure, never throws, and returns true only if all hold:
- `clientDataJSON.type === 'webauthn.get'`; `clientDataJSON.challenge` equals base64url of the expected challenge; the challenge is at least 16 bytes.
- `clientDataJSON.origin` is one of `genesis.origins`; `crossOrigin` is absent or `false`.
- `authenticatorData[0..32)` equals `SHA-256(genesis.rpId)`; flags UP and UV are both set.
- ECDSA P-256/SHA-256 verifies over `authenticatorData || SHA-256(clientDataJSON)` after DER to r||s conversion (strict DER). Low-S is not required for passkey signatures; the signature counter is ignored (synced passkeys report 0); signature bytes are never used as a key or deduplicated.

A record is valid only if its `credentialId` is an authority of the previous state (genesis: its own authority) and the assertion verifies against that authority's key with the genesis `rpId`/`origins`. The account is therefore permanently bound to the genesis origin and rpId.

Callers (`ui/src/lib/passkey.ts`): `get()` always uses `userVerification: 'required'`; `create()` uses `pubKeyCredParams: [{alg:-7}]` only, `residentKey: 'required'`, `userVerification: 'required'`, `attestation: 'none'`, `user.id` = the genesis handle, and `excludeCredentials` listing every known authority. Ceremonies refuse a non-secure context (`secure_context_required`) and an iframe (`passkey_embedded`). The module exports no generic "sign these bytes" function: a passkey signs only a ledger record (`signLedgerRecord`), an identification nonce (`identifyPasskey`, challenge `signInChallenge(nonce) = SHA-256(SIGNIN_DOMAIN + nonce)`, signature discarded) or an authority consent (`signAuthorityConsent`). The sign-in domain differs from the ledger domain, so an identification assertion can never act as a ledger record signature.

Test data: all vectors are produced by a software authenticator (`bridge/src/security/ledger/testing.ts`) or are fixed offline vectors ("NOT captured from a real authenticator", `webauthn.test.ts`). No assertion from a real iCloud Keychain passkey has been added as a fixed vector. Not verified against a real authenticator by tests; the first production ceremony is the first real check.

## 4. Authority consent

`add_authority` is `{ authority, consent }`. `verifyLedger` requires `verifyPasskeyAssertion` of the NEW authority's key over `authorityConsentChallenge(accountId, authority) = SHA-256(AUTHORITY_CONSENT_DOMAIN + canonical({accountId, credentialId, publicKey}))`, signed with the same rpId/origins. Without a valid consent the ledger is `invalid_ledger`.

Why: otherwise a malicious server could build its own account that lists a victim's public key as an authority, and the victim's browser would then enroll itself and later computers into the attacker's account. Invariant: a credential is an authority of an account only if it signed that account's genesis or a consent bound to that accountId.

Companion rule in the browser (`ledger-client.ts`, `checkIdentified`): an unbound browser binds to the ledger fetched by handle only if the passkey it just used is an authority there and `genesis.handle` equals the passkey's user handle (not re-verified here beyond reading the code path).

Adding a passkey takes three separate gestures: create the new passkey, the new passkey signs the consent, an existing authority signs `add_authority`.

## 5. Authorities are add-only; lost or compromised passkey

There is no `revoke_authority` and no `revokedCredentialIds`. A passkey that was ever added stays an authority of that account forever.

Consequences:
- A lost passkey is not an incident by itself when another authority exists; keep at least two (recommended: a second passkey or a hardware key).
- A compromised passkey (an attacker can sign) cannot be removed. The response is: create a new account with a new passkey, then on every computer run `ftown start --new-identity` and pair it again with the new account. Because the server hosts at most one account (section 8, `accounts_singleton`), the new account can only be created after the old account row is deleted from the database (the other account tables reference it with `ON DELETE CASCADE`); no shipped command does this, so it is a manual SQL step: confirm before use. [Superseded in part: a server may now host many accounts; see the amendment at the end.]
- If every passkey is lost, the account is unrecoverable; same recovery as above.

## 6. Fork choice and sticky revocations

[Superseded by 2026-11-10-append-only-ledger.md: this whole section's fork choice is replaced. A chain is adopted only if it extends the local one; a different valid history is never adopted and the owner chooses. The server is now a sequencer (`expectHead`).]

Every replica (server, each bridge, each browser) runs the same pure `chooseLedger(local, candidate, now, cache?)`. There is no sequencer, no compare-and-set on a head, and no rollback state. [Superseded by 2026-11-10-append-only-ledger.md]

Order, strict and total on distinct valid chains of one account:
1. Different genesis (different accountId) or an invalid candidate: `reject`.
2. Candidate equals local, or is a prefix of local: `keep` (a shorter chain never replaces a longer one; decided from heads before any signature work).
3. Candidate extends local: `adopt` after verifying only the new records (with a vouched cache).
4. Fork (diverges after a common prefix): the longer chain wins; on equal length the chain with more `revoke_device`/`revoke_bridge` records wins; then the lexicographically smaller head wins. A fork that wins returns `discarded`, the local records after the common prefix. [Superseded by 2026-11-10-append-only-ledger.md: "longer chain, more revokes, smaller head" no longer exists. A diverged chain is kept out (`keep`/`diverged`) unless it carries the owner's `resolve_fork`.]

Only a passkey holder can create a fork (for example two browsers signing offline). The browser shows `discarded` entries ("Sign again" per entry); a discarded removal must be re-signed by the owner. [Superseded by 2026-11-10-append-only-ledger.md: `discarded` is non-empty only after an owner-chosen resolution, or for a signed change the server never took.]

Sticky revocations:
- `ledgerRevocations(ledger)` returns every device endpoint id and bridgeId revoked anywhere in a chain.
- Every replica stores the union of those ids over every chain for which `chooseLedger` returned `keep` or `adopt` (a losing but valid candidate contributes; `reject` contributes nothing). [Superseded by 2026-11-10-append-only-ledger.md: there is no losing chain. A kept diverged chain contributes only its `seen` removals (signed by a fork-point authority).] The server stores it in `account_ledger.sticky`; bridges in `security/ledger.json` (`sticky`); browsers in IndexedDB `ftown-ledger`.
- `applyRevocations(checkpoint, sticky)` removes those ids from `devices`/`bridges` and adds them to the revoked lists. Every trust decision uses its output: `verifyAuthProof` inputs (server `StoredLedger.trusted`), `confirmPairedLedger`, `assertBridgeAccess`, the bridge policy projection, relay token issuance, and `requireAccount`/`requireBridge`. Its output is never passed as the `chooseLedger` cache (it no longer describes the chain).
- Sticky sets are bounded (8 x 1024 ids); an over-limit set is rejected before it can be persisted.
- A revocation seen on a losing chain stays effective locally even if the winning chain lacks it. The browser surfaces such ids as "Removed on this browser only — not yet applied to your account" and the owner can sign the removal again on the winning chain. [Superseded by 2026-11-10-append-only-ledger.md: sticky entries are no longer created by fork loss, because there is no fork loss. They come from `seen` and from adopted chains.]

## 7. Key-possession proof

`proof.ts`. Replaces passwords and refresh tokens.

`AuthProof { accountId, kind: 'device'|'bridge', keyId, nonce, purpose: 'session'|'relay', audience, signature }`:
- `keyId` is `endpoint.id` for a device and `bridgeId` for a bridge.
- Signature: ECDSA P-256/SHA-256 over `'ftown-auth-proof-v1\n' + JSON.stringify({accountId, audience, keyId, kind, nonce, purpose})`; raw r||s, 86 base64url characters, canonical, low-S enforced.
- `audience` is the exact server origin: `new URL(apiUrl).origin` on the bridge, `location.origin` in the browser. It must be `https`, or `http` only on loopback. The server compares it with `publicOrigin()` (`FTOWN_PUBLIC_URL`), never with request headers.
- `verifyAuthProof(checkpoint, proof, {audience, purpose})` is true only if accountId, audience and purpose match, the key is a current non-revoked member of the checkpoint (callers pass the sticky-applied checkpoint), the signature is canonical and low-S, and it verifies. A bridge key is never valid for purpose `session`. It never throws.
- Replay protection is only the server's atomic nonce consumption (section 8). The proof itself has no timestamp.
- Device keys are non-extractable (IndexedDB database `ftown-device-auth`); bridge auth keys are stored as JWK in `security/ledger-identity.json` (mode 0600).

## 8. Server contract (`ui/`)

Environment (see the runbook for values): `FTOWN_PUBLIC_URL` (required in production; canonical origin, https or loopback http; a present empty or malformed value fails closed), `FTOWN_RP_ID` (optional, defaults to the hostname of the public origin), `NEXT_PUBLIC_FTOWN_PUBLIC_URL` and `NEXT_PUBLIC_FTOWN_RP_ID` (browser side, inlined at build time), `FTOWN_BOOTSTRAP_SECRET` (at least 32 characters), `REGISTRATION_ENABLED`, `CENTRIFUGO_TOKEN_SECRET`, `AUTH_SECRET` (each at least 32 characters, not containing `change-me`), `NEXT_PUBLIC_CENTRIFUGO_URL`, `DATABASE_URL`. [Superseded in part: `FTOWN_BOOTSTRAP_SECRET` no longer exists; see the amendment at the end.]

Database (migration `ui/migrations/0011_passkey_ledger.sql`, one transaction, applied by `ui/scripts/migrate.mjs`):
- Created: `accounts(account_id PK, handle UNIQUE, created_at)`, `account_ledger(account_id PK FK, revision, head, ledger jsonb, sticky jsonb, version, updated_at)`, `auth_nonces(nonce_hash PK, purpose, expires_at)`, `pair_mailbox(request_id PK, account_id FK, sealed, expires_at)`.
- Single-account rule: unique index `accounts_singleton ON accounts ((true))` — at most one row can exist. [Superseded: removed by migration 0012; see "Amendment 2026-11-10: many accounts per server" at the end.]
- Dropped and recreated keyed by `account_id` (rows not migrated, only while the old identity column still exists): `security_endpoint_directory`, `security_device_display_names`, `push_subscriptions`, `push_events`, `push_deliveries`.
- Dropped: `security_pending_approvals`, `security_account_enrollments`, `security_account_history`, `pairing_requests`, `bridge_refresh`, `users`. Rate-limit rows with scope `login` and `register` are deleted; the table is kept.

Rate limiting uses `consumeRateLimit(scope, key, {maxAttempts, lockoutMs})` (key = client IP unless noted; the client IP is trusted from proxy headers on Vercel or with `FTOWN_TRUSTED_PROXY=1`, else the constant `unknown`). Exact windowing semantics of `consumeRateLimit` not verified.

Routes (all responses `Cache-Control: no-store` where stated in code):

| Route | Auth | Behaviour |
|---|---|---|
| `POST /api/auth/nonce` | none | Body `{purpose:'session'|'relay'}` (max 256 bytes). 200 `{nonce, expiresAt}`; 32 random bytes, stored only as SHA-256, valid 60 s, single use. 400 invalid purpose; 429 after 120 per minute per IP (`auth-nonce`); 503 on failure. |
| `POST /api/account/ledger` | none (the ledger is self-authenticating) | Body `{ledger, bootstrap?}`, capped at 2,621,440 bytes (413), 30 per minute per IP (`ledger-write`, 429). Runs `offerLedger`. 201 `{decision:'created', ledger, discarded}` on account creation; 200 `{decision:'adopt'|'keep', ledger, discarded}`; 409 `{error:'ledger_rejected', ledger}` for a rejected chain of an existing account; 403 `{error:'registration_closed'}` when a reject comes with no stored account (this includes a ledger that does not parse; closed registration, wrong or missing bootstrap secret, an account already exists, bad origin/rpId, no `add_device`); 400 bad body; 503 on store error. After `created`/`adopt`, publishes to the relay (section 10). | [Superseded: no `bootstrap` field; see the amendment at the end.] [Superseded by 2026-11-10-append-only-ledger.md: body is `{ledger, expectHead?}`; 409 now has three reasons (`diverged`, `ledger_rejected`, `head_changed`) and there is a 404 `account_unknown`.]
| `GET /api/account/ledger?accountId=` or `?handle=` | none; public by design | Exactly one parameter, 43 base64url characters. 200 `{ledger}`; 404 `{error:'not_found'}`; 400; 429 after 120 per minute per IP (`ledger-read`); 503 for a corrupt row or store failure. The ledger holds only public keys, labels, origins and timestamps. |
| `POST /api/auth/relay-token` | proof | Body `{proof, head, hostname?, localPort?}` (max 16 KiB). See section 9. |
| `POST /api/auth/token` | NextAuth session | Mints the browser relay token; 200 `{token, centrifugoUrl, accountId, expiresAt}`; 401 without a trusted session. Note: the method is POST. |
| `PUT /api/pair/:requestId` | session | Body `{sealed}` (max 300 KiB; sealed at most 256 KiB). 204 stored (TTL 10 min; re-PUT by the same account overwrites); 400 invalid id; 401; 409 the id belongs to another account; 413. |
| `GET /api/pair/:requestId` | none; `requestId` is 43 base64url characters (32 bytes) | 200 `{sealed}` (not deleted, may be re-read until expiry); 404 `{status:'pending'}`; 410 `{status:'expired'}`; 429 at 200 per 10 minutes per requestId (`pair-read`) and 120 per minute per IP (`pair-read-ip`). |
| NextAuth credentials provider `ledger` | proof JSON in `credentials.proof` (max 2048 characters) | Accepts only `kind:'device'`, `purpose:'session'`. Order: `parseAuthProof`, consume nonce, read ledger, `verifyAuthProof` against `stored.trusted` and `publicOrigin()`. Session JWT, `session.user = {id: accountId, endpointId}`, 12 h. A cookie without a valid accountId/endpointId is invalidated. |
| `/api/security/endpoints`, `/api/security/device-names`, `/api/push/**`, `/api/version` | session or bridge relay JWT | Kept, rekeyed by `account_id`. `requireAccountOrBridge`: a Bearer relay JWT is a bridge (checked against the CURRENT trusted ledger: HS256, audience `ftown:centrifugo`, `sub` a 43-character accountId, `info.bridgeId`, `info.ownerId === sub`, bridge in `stored.trusted.bridges`); otherwise the session. Per-route capability details not re-verified in this document. |

`requireAccount()` re-reads the ledger on every call and requires the session's device to be in `stored.trusted.devices`; a session JWT therefore does not outlive a device removal on the server.

Account creation (the only path that creates a row): `offerLedger` with no stored account accepts a candidate only if all hold, checked cheapest first before any signature work: `REGISTRATION_ENABLED === 'true'` (unset means enabled outside production, disabled in production); `bootstrap` equals `FTOWN_BOOTSTRAP_SECRET` (at least 32 characters, SHA-256 + timing-safe comparison); no account exists; the chain contains at least one `add_device`; genesis `origins` is exactly `[publicOrigin()]` and `rpId` equals `FTOWN_RP_ID` or the public hostname; the chain verifies. The insert is one statement guarded by `NOT EXISTS (SELECT 1 FROM accounts)` plus the singleton index; a concurrent second genesis gets a reject. The browser additionally refuses creation unless `location.origin` equals `NEXT_PUBLIC_FTOWN_PUBLIC_URL` (`origin_mismatch`). [Superseded: no bootstrap secret and no single-account condition; see the amendment at the end for the current order.]

Existing account: `chooseLedger` with the stored checkpoint as cache; optimistic concurrency on `(version, revision, head)`, one retry, then `account_ledger_conflict` (503). [Superseded by 2026-11-10-append-only-ledger.md, section (c): an offer is written only if it extends the stored chain or carries an applicable `resolve_fork`; answers are 200 keep/adopt, 201, 409 `diverged` / `ledger_rejected` / `head_changed`, 404 `account_unknown`, 429. The 409 `ledger_rejected` row above no longer covers a valid different history.] `readLedger` cross-checks the denormalised columns and the two hashes (genesis to `account_id`, last record to `head`); it does not re-verify signatures on every read. Auth decisions use a MAC-sealed checkpoint, and a row whose checkpoint cannot be trusted is healed by verifying the stored chain from genesis; a chain that does not verify is corruption (503), never "absent". [Superseded: see "Server reads: sealed checkpoint" in the amendment at the end.]

## 9. Relay tokens

`POST /api/auth/relay-token`, order of operations:
1. Per-IP limit: 120 per minute (`relay-token-ip`).
2. Body parse (bounded). Proof parsed (`parseAuthProof`); `purpose` must be `relay`. For `kind:'bridge'`, `hostname` must be a valid label and `localPort` a valid advert, else 400; the token's `info` is `{bridgeId, ownerId: accountId, hostname?, connectedAt, ...localPort advert}`. A device token carries no `info`.
3. `consumeNonce(nonce, 'relay')` before any ledger work; a false result is 401 `{error:'unauthorized'}`.
4. `readLedger`; none gives 401.
5. `verifyAuthProof(stored.trusted, proof, {audience: publicOrigin(), purpose: 'relay'})`. On failure: if the key id is in `trusted.revokedBridgeIds` or `trusted.revokedDeviceIds`, 401 `{error:'key_revoked', ledger}` (signed evidence); otherwise a plain 401 with no ledger.
6. Per-key limit after a valid proof: 30 per 10 minutes per `accountId:keyId` (`relay-token-key`, 429).
7. 200 `{token, expiresAt, centrifugoUrl}`; the full `ledger` is added only when the body `head` differs from the stored raw head. 503 if `NEXT_PUBLIC_CENTRIFUGO_URL` is unset.

JWT (`relay-jwt.ts`): HS256 with `CENTRIFUGO_TOKEN_SECRET`, claims `sub = accountId`, `iat`, `exp = iat + 3600`, audience `ftown:centrifugo`, optional `info`. Lifetime exactly 1 hour. There is no refresh token: revocation cuts relay access in at most one token lifetime (a token already issued stays valid until it expires; Centrifugo-side disconnect on revocation is not done by this code, not verified).

Bridge side (`bridge/src/relay-token.ts`, `token-provider.ts`): nonce, proof (`kind:'bridge'`, `purpose:'relay'`, audience = API origin), POST with the local head. 200 with a `ledger` is offered to the replica before the token is returned. 401 `key_revoked` offers the evidence ledger and throws a terminal `UnauthorizedError`. A plain 401 triggers one POST of the bridge's own chain to `POST /api/account/ledger` (once per local head) and one retry. [Superseded by 2026-11-10-append-only-ledger.md, section (e): the blind POST is gone in bridge 0.22.0. A plain 401 starts a checked re-offer: a fresh read first, a POST with `expectHead` only if the server is behind, never creating an account.] Other failures are plain errors (body capped at 200 characters). The provider shares one in-flight exchange, reuses a token until 1 minute before its `exp - iat` lifetime (monotonic clock), arms a cooldown of 15 s doubling to 10 min with +-20% jitter after transient failures, and remembers a refusal for 10 minutes or until the local head changes.

## 10. Channels and replication

Channel helpers (`channels.ts`): `accountChannel(kind, accountId)` is `${kind}#${accountId}`; `sessionChannel(kind, sessionId, accountId)` is `${kind}:${sessionId}#${accountId}`. Kinds: `sessions:updates`, `commands:rpc`, `bridges:presence`, `bridges:security`, `bridges:ledger`. The ledger channel is `bridges:ledger#<accountId>` (the design notes called it `account:ledger`; the code wins). Account ids containing `#`, `:`, `,` or whitespace are refused. Inline `…#email` channel names are gone.

Messages on `bridges:ledger#<accountId>`: `{type:'ledger', ledger}` when the serialized message is at most 60 KiB, else `{type:'ledger_head', head, revision}`. Receivers shape-check strictly and accept only publications whose publisher is the account itself (`info.user`/owner check).

Replication has no polling:
- Server push: after `created` or `adopt` the server publishes (best effort, 3 s timeout, never throws) with a 60-second connection JWT whose `sub` is the accountId.
- Browser: subscribes to the ledger channel in `useCentrifugo`; a `ledger` message is offered to the replica, a `ledger_head` triggers a read only if the head is ahead of the local raw chain (higher revision, or same revision and a different head). Every (re)subscribe and every relay token renewal (hourly) calls `refresh()`. Reads start at least 2 s apart; extra requests share one trailing read; `force` skips the spacing but joins a read in flight.
- Bridge: every relay-token response carries a newer ledger if the head differs (token-renewal piggyback); a ledger message is offered as source `relay`; every (re)subscribe triggers a refresh read of `GET /api/account/ledger?accountId=`. Relay-triggered work runs at most one at a time, at least 1 s apart, doubling up to 60 s while it changes nothing (an adopted ledger resets it); only the newest pending item is kept. Requests from an endpoint the replica does not list (`approval_required`, not a revoked one) pull a refresh at most every 2 s, single-flight with one trailing refresh.
- Every candidate, whatever its source, goes through `chooseLedger`; nothing here decides trust.

The `bridges` Centrifugo namespace allows client publishing (`allow_publish_for_client: true`, `centrifugo/config.prod.json`). Any connection of the account, and anyone holding a valid relay token for it, can publish to the ledger channel; this is accepted because a publication is only a hint or a self-authenticating chain (section 14). No relay-side rate limit for that channel was found in the config; the receivers' throttles above are the bound. [Amendment 2026-11-10 lists this publish gap as a blocker before opening registration to strangers.]

## 11. Browser flows

Implemented in `ui/src/lib/ledger-client.ts` (`LedgerClient`), `ledger-replica.ts`, `passkey.ts`, `device-auth-key.ts`, pages `ui/src/app/login`, `ui/src/app/pair`, and the Security panel (`SecurityDevices.tsx`).

- Create account (`/login`, "First time setup"; needs `NEXT_PUBLIC_FTOWN_PUBLIC_URL`; `origin_mismatch` otherwise). Three buttons, three gestures: 1 create passkey (new 32-byte handle); 2 sign the genesis (nothing is sent yet); 3 add this browser — signs `add_device`, then one POST `{ledger, bootstrap}` with the genesis and the first device, then signs in. The setup secret is held in memory only, sent with the creating POST and dropped when it returns; a refused POST can be retried with the same signed chain without another prompt ("Retry with this secret"). A pending creation can be discarded. [Superseded: the section is now "Create an account", with no setup secret; see the amendment at the end.]
- Sign in, known browser: no passkey prompt. If the replica lists this browser's endpoint and auth key, it refreshes the ledger (soft failures tolerated), requests a `session` nonce, signs a proof, and calls NextAuth `signIn('ledger', {proof})`. `/login` does this on load unless the signed-out flag is set.
- Sign in, new browser: gesture 1 `identifyPasskey` (assertion over a local nonce only to learn the user handle); `GET /api/account/ledger?handle=`; verify; the passkey must be an authority and `genesis.handle` must match. Gesture 2 signs `add_device` for this browser, POSTs the chain, then signs in. A browser already listed signs in after gesture 1 only.
- Sign out: clears the NextAuth session, detaches the push subscription, sets a signed-out flag so `/login` does not sign straight back in. The browser stays a member of the account. To stop a browser signing in at all, remove it in Security.
- Add a passkey: three gestures (section 4).
- Remove browser or computer: Security panel, confirmation text, one passkey gesture, `revoke_device` / `revoke_bridge`, POST of the new chain. [Superseded by 2026-11-10-append-only-ledger.md, section (d): the signed record is no longer put into the local chain before the server accepts it. It is the one pending write, sent with `expectHead`, and the removal is enforced locally by the block meanwhile.] The sign-in key of a removed browser is refused at the server after the server stores the record; a removed browser sees `device_revoked` and can "Reset this browser" (new endpoint and auth keys) and sign in again as a new device.
- Local-only removal: if this browser saw a removal on a chain that later lost a fork, `snapshot.localOnly` lists the ids; they stay untrusted here and are shown as "Removed on this browser only — not yet applied to your account". The owner signs the removal again. [Superseded by 2026-11-10-append-only-ledger.md: `localOnly` is no longer produced by a lost fork. A signed removal the server has not accepted is enforced by the local block, and a removal seen on a refused history is enforced through `seen`.]
- Discarded entries: after a fork is adopted, `snapshot.discarded` lists the local records that lost, each with "Sign again" (one prompt each); additions that are already present or were removed since are marked settled. [Superseded by 2026-11-10-append-only-ledger.md: entries now come from a signed change that was dropped (another change landed first, a divergence, a refusal, or "Discard this change") and from an owner-chosen resolution.]
- Approve a computer (`/pair#req=…`): the page requires a session (otherwise `/login?returnTo=/pair`, fragment kept in session storage, never in the query). The owner TYPES the 6 digits shown in the computer's terminal; the page compares with `pairComparisonCode`. A wrong code blocks approval; after 5 wrong codes (counted per request id in session storage) the link is discarded. On a match: refresh, append `add_bridge` (one passkey gesture), seal the approval to the bridge's endpoint key, PUT it to the mailbox.
- Trust gate for bridge access: `assertBridgeAccess(bridgeId, endpointId)` throws `account_bridge_revoked` unless the sticky-applied replica lists that bridge with exactly that endpoint id.

## 12. Bridge flows

### 12.1 Startup decision table (account mode)

Order in `bridge/src/index.ts`, logic in `ledger-startup.ts`:

| Step | Condition | Result |
|---|---|---|
| 1 | `ftown start` without `--solo`/`--local` (account mode) | continue; `--solo`/`--local` skip all of this table |
| 2 | `--new-identity` | `beginIdentityReset(dataDir, 'manual')` |
| 2 | v1 account state on disk and a normal start | print "Old account data from a previous ftown version was cleared…", `beginIdentityReset('manual')` |
| 2 | v1 account state on disk and the start was launched by the update helper | change nothing, print "ftown was updated to the passkey ledger; run `ftown start` to pair this computer.", exit 1 |
| 2 | any mode: a reset marker is pending (revoked restart or crash) | complete it (section 12.4) |
| 3 | no identity keys | create `security/ledger-identity.json` (ECDH endpoint key + ECDSA auth key, JWK, 0600) |
| 3 | keys exist, no ledger replica | pairing (12.2); not allowed during an update restart ("An update restart cannot pair this computer…", exit 1) |
| 3 | identity bound, replica empty | fetch the server ledger and `adoptBound` (account must equal the bound one and the roster must list this bridge's keys); failure exits 1 (a rejected ledger prints "The server's account ledger does not list this computer…") |
| 3 | identity bound, replica holds another account | throws `ledger_store_wrong_account`; nothing is reset |
| 3 | identity unbound, replica lists these keys | bind the identity to that account |
| 3 | identity unbound, replica does not list them | delete the stale `ledger.json`, pair |
| 4 | own status `revoked` (signed, or sticky) | revoked restart: identity reset, re-exec `ftown start` without `--bridge-id`/`--new-identity` (12.4) |
| 4 | own status `absent` (not listed with exactly these keys) | print "This computer is not in your account's ledger. Run `ftown start --new-identity` to pair it again.", exit 1. Never an automatic reset |
| 4 | own status `active` | continue |
| 5 | `startLedger()`: read the server ledger and offer it as `server` | a fetch failure is logged, not fatal; a revocation found here restarts as revoked |
| 5 | first relay token fails with a proven revocation | revoked restart |
| 5 | first relay token refused (401/403) | print the refusal (for an unaccepted key: run `ftown start --new-identity`), exit 1 |
| 5 | first relay token fails temporarily (network, timeout, 5xx, cooldown) | start offline with the saved relay URL (`security/relay-url.json`), keep retrying in the background; exit 1 only if no relay URL was ever saved |
| 6 | register this bridge's own endpoint (`PUT /api/security/endpoints`, relay token) | refusal exits 1; a temporary failure retries in the background (15 s doubling to 10 min) |

The relay URL comes from `FTOWN_CENTRIFUGO_URL` if set and valid, else the `centrifugoUrl` of the last relay-token response, else the saved one. Only `wss://` is accepted (`ws://` only for loopback hosts or when the API itself is plain http).

### 12.2 Pairing

1. A fresh `BridgePairRequest` `{version:2, requestId (32 random bytes), bridgeId, endpointPublicKey, authPublicKey, label (hostname, sanitised), expiresAt}` and a 32-byte secret are created; lifetime 10 minutes (`PAIR_LIFETIME_MS`).
2. The bridge prints `https://<api origin>/pair#req=<base64url JSON>` (the secret lives only in the fragment) and "Type this code on the page to confirm it is this computer: NNNNNN" where the code is 6 decimal digits derived from `SHA-256('ftown-pair-code-v2\n' + canonical(request))` (first 4 bytes mod 10^6).
3. The owner opens the link on a device that has a session (or signs in), types the code, approves with the passkey. The page appends `add_bridge` (endpoint id `SHA-256(endpointPublicKey)`, `ownerId = accountId`) and PUTs a sealed approval: HPKE-sealed to the bridge endpoint key, purpose `enrolled`, expiring with the request, containing `{version:2, requestId, accountId, head, proof}` with `proof = HMAC-SHA256(secret, 'ftown-pair-proof-v2\n' + accountId + '\n' + head + '\n' + requestId)`. The sealed bundle does not contain the ledger.
4. The bridge polls `GET /api/pair/<requestId>` every 5 s until the request expires (404 pending, 410 expired; a malformed body is terminal). `openPairApproval` checks expiry, that the sealed message targets its own endpoint key, the request id, and the HMAC proof.
5. The bridge fetches the ledger with `GET /api/account/ledger?accountId=` (transient failures retried until expiry), then `adoptPaired` runs `confirmPairedLedger`: the ledger verifies from genesis, its accountId equals the approved one, it contains `approval.head`, this request's bridge (bridgeId, endpoint id, auth key) is a member of `applyRevocations(checkpoint, sticky).bridges`, and its `add_bridge` is not after `approval.head`. Only then is the identity bound to the account and the ledger stored.
6. The bridge prints "Paired with account <first 8 characters of accountId> (passkey "<label>")".

Failures: expiry exits 1 with "Pairing link expired. Run `ftown start` to try again."; a bad bundle or ledger is terminal ("Pairing did not complete. Run `ftown start` to try again."). Because the HMAC key is the link secret, which the server never sees, a server cannot bind the bridge to another account.

### 12.3 Offline grace and clock rules

Applies to authorising ACCOUNT browsers on the bridge (`policy.ts`); the bridge's own local API and the `local-cli` endpoint are not subject to it.

- Access for an account device requires: a trusted ledger view, own status `active`, the device present in `trusted.devices` with the same key, and offline grace.
- Grace holds only if all of these: the last server contact (`lastServerReadAt`, persisted in `ledger.json`) is at most 24 h old by the wall clock; the wall clock has not gone back more than 30 s before that contact or before the observed high-water mark (`security/ledger-clock.json`, persisted after each contact and on close, so a rollback across a restart is caught); and, after a contact in this process, monotonic elapsed time since the contact is at most 24 h.
- A server contact is every relay-token response (and a successful ledger read). It sets `lastServerReadAt = now`, restarts the monotonic bound and raises the high-water mark. A forward clock jump cannot extend access beyond the corrected time.
- If `ledger-clock.json` is unreadable, the clock is untrusted until a server contact happens in this process.
- Failure codes: `account_offline_expired` (no view, no contact, or grace lapsed), `account_bridge_revoked` (own status not active), `account_device_revoked` (revoked or key changed).
- This measures connectivity, not a revocation deadline: a bridge that is online but receives no update (withheld by the server) keeps trusting its last ledger.
- Restart: the persisted contact time survives a restart, so a bridge that restarts offline within 24 h of its last contact still serves account browsers; a clean first contact after restart re-anchors it.
- In account mode the bridge never removes an account device on request (`account_managed`), and invitations are refused (`account_managed`); membership changes only through ledger records.

### 12.4 Revoked restart and identity reset

On proof that the bridge is revoked (own status `revoked`), `createRevokedRestart` logs "This computer was removed from your ftown account. Creating a new identity; pair it again with the link below.", writes the reset marker (`security/identity-reset.json`, reason `revoked`), shuts the bridge down without killing sessions, and re-executes the same entry script with the original arguments minus `--bridge-id` and `--new-identity` (so the next run pairs). If an update owns the process, it exits 1 and `ftown start` finishes the reset later; if re-exec is unavailable it prints "Run `ftown start` to pair this computer again." and exits 0.

`completePendingIdentityReset` deletes, then writes a new random UUID to `<dataDir>/bridge-id`:
- `<dataDir>/refresh-token`
- `<dataDir>/browser-devices.json`
- in `<dataDir>/security/`: `account-enrollment.json`, `pending-approval-status.json`, `pending-approval-confirmation.json`, `local-cli-identity.json`, `policy.json`, `bridge-identity.json`, `ledger.json`, `ledger-clock.json`, `relay-url.json`, `ledger-identity.json`, and any `*.tmp` leftovers.

Kept: sessions, transcripts and everything else under the data directory. A pending marker is completed on the next start in any mode; Solo/`--local` start fresh identities afterwards.

## 13. What Solo and `--local` keep

Unchanged: invitations (`createInvitation`, `consumeInvitation`, `security_invite`), the `enroll` handshake, `provisionLocalEndpoint`, the `local-cli` identity, `BrowserInvitation`, `/connect`, `/local`, `LocalDashboard`, owner ids `solo:<bridgeId>`, Solo's `security/bridge-identity.json`, key-based Solo auth and its hub token minting, the `ftown security` / local pair CLIs. `--new-identity` is refused with `--solo`/`--local`. Account mode refuses invitations. The account-only code (ledger, passkey, relay token by proof) is never entered in these modes.

## 14. Bounds and accepted residual risks

Bounds: ledger 2 MiB / 1024 transitions; body 2,621,440 bytes; sealed pair approval 256 KiB; pair link 10 minutes; nonce 60 s; relay token 1 h; browser session 12 h; offline grace 24 h; future skew 30 s; label 200 characters.

Accepted:
1. Blind signing by the page. The passkey prompt shows no transition details; the page that asks for the signature is served by the server. A compromised server or page can ask for a signature over a different record than the one the owner believes. Mitigations: the typed pairing code, the visible Security panel, and replicas accepting only valid chains. No local confirmation on the bridge for sensitive operations in this release.
2. Apple/keychain trust. Whoever controls the synced keychain controls the account. A compromised passkey cannot be removed (section 5).
3. Domain binding. The genesis fixes `rpId` and `origins`; Vercel previews and `localhost` cannot use the production passkey. A change of domain is a new account.
4. Relay token validity up to 1 h after removal. Server-side routes re-check the ledger on every call, bridges drop the browser on the next ledger update, but an issued relay token keeps working until it expires.
5. Client-publishable ledger channel. Any connection with a valid relay token for the account can publish to `bridges:ledger#<accountId>`. Receivers verify every chain from genesis, accept only the account's own publisher, and throttle (browser 2 s, bridge 1 s doubling to 60 s, unknown-endpoint refresh 2 s), so publishing can cost CPU and reads but cannot change trust. The 60 KiB size choice only affects whether a full ledger or a head is sent.
6. Pairing code grinding. An attacker who observes the owner's genuine link can search for a request with the same 6-digit code (about 10^6 hashes) and present a different bridge; the typed code and the passkey approval are the only barrier, links expire in 10 minutes (the mailbox entry is not deleted when read, so an approval can be read again until it expires), and the code is typed, not shown on the page. The attacker still needs the owner to open the attacker's link.
7. Public ledger read. `GET /api/account/ledger` needs no authentication; it reveals public keys, labels, origins and timestamps for anyone who knows the (256-bit) accountId or handle, at 120 reads per minute per IP.
8. Withholding and staleness. A server (or relay) can delay or withhold records; a replica never rolls back once it has seen a longer chain, but a replica that never saw a revocation cannot enforce it. [Superseded by 2026-11-10-append-only-ledger.md: a replica never drops a record it holds, whatever the length of another chain.]
9. Single account per server (database-enforced); one operator. [Superseded: see the amendment at the end.]

Not verified: behaviour with a real iCloud Keychain / hardware-key authenticator end to end; Centrifugo-side disconnection of a revoked key; exact `consumeRateLimit` windowing; capabilities of each kept `/api/security/*` and `/api/push/*` route beyond the auth helpers.


## Amendment 2026-11-10: many accounts per server

The text above describes the first release: one account per server, created with a setup secret. Where it conflicts with this section, this section wins. The ledger, proofs, channels, relay token, pairing protocol and everything under `bridge/` are unchanged.

### Removed

- The bootstrap secret: env `FTOWN_BOOTSTRAP_SECRET`, the `bootstrap` field of `POST /api/account/ledger` (a stray field is ignored), and the "Setup secret" field on `/login`.
- The singleton: unique index `accounts_singleton` (dropped by `ui/migrations/0012_multi_account.sql`) and the "no account exists yet" admission condition. `accounts.handle` stays unique.

### Genesis admission

Applies when the server holds no account for the chain's `accountId`. The first failing check answers; the checks run in this order. Before them, `POST /api/account/ledger` applies the `ledger-write` limit (30 per minute per client IP) and the 2,621,440-byte body cap. A body without `ledger` is 400 `invalid_request`.

| # | Check | `error` | HTTP |
|---|---|---|---|
| 0 | the chain parses | `invalid_ledger` | 400 |
| 1 | `REGISTRATION_ENABLED` allows creation (in production only the exact value `true`) | `registration_closed` | 403 |
| 2 | at most 16 records including genesis, at most 131072 bytes serialized | `creation_too_large` | 413 |
| 3 | at least one `add_device` | `invalid_ledger` | 400 |
| 4a | the server has a usable public origin and RP ID (otherwise the error is logged) | `server_misconfigured` | 503 |
| 4b | genesis `origins` is exactly `[publicOrigin()]` and `rpId` equals the server RP ID | `origin_mismatch` | 400 |
| 5 | the chain verifies from genesis (signatures included) | `invalid_ledger` | 400 |
| 6 | creation budget: per IP per hour, then global per day | `rate_limited` | 429 |
| 7 | account count below the soft cap | `server_full` | 503 |
| 8 | insert; another account already holds the handle | `handle_taken` | 409 |

Signature verification (5) comes before the creation budget (6). The budget is spent only by a chain that verified, so unsigned or malformed junk cannot drain it. Checks 0 to 4 are cheap and run before any signature work; 2 bounds the work that 5 does. The per-IP budget is consumed first. If it refuses, the global budget is not touched, so one throttled client cannot drain the global budget. Two identical creations racing is not an error: the loser is re-read and treated as a replica offer. The cap is soft: count and insert are separate statements, so concurrent creations can overshoot it by a few. A store or database failure is 503 `ledger_unavailable`.

### Creation limits

| Env var | Default | Meaning |
|---|---|---|
| `FTOWN_MAX_ACCOUNTS` | 1000 | Soft cap on accounts on the server. |
| `FTOWN_ACCOUNT_CREATE_PER_IP_HOUR` | 5 | Creation attempts per client IP per hour (scope `account-create-ip`). |
| `FTOWN_ACCOUNT_CREATE_GLOBAL_DAY` | 200 | Creation attempts per day across all clients (scope `account-create-global`, one key). |

Each value must be a plain positive integer, at most 2,147,483,646. Anything else that is set (0, negative, decimal, exponent, hex, too large) is ignored with one `console.warn` per process per variable, and the default applies, so a typo never disables a limit. Unset or blank is the default, silently. An attempt counts when it reaches check 6, that is, when its chain verified, whether or not it later succeeds. Over budget answers 429 `rate_limited` with a `Retry-After` header. Offers for an existing account are not subject to these limits or to the creation size rule.

Rate-limit keys that use the client address bucket IPv6 by /64: `2001:db8:1:2:...` becomes `2001:db8:1:2::/64`. An IPv4-mapped IPv6 address is its IPv4 address, and an IPv4 address loses any port. This applies to every per-IP key in the ledger route (`ledger-write`, `ledger-read`, `account-create-ip`). One IPv6 subscriber usually holds a whole /64, so a client cannot get a fresh budget by changing the low 64 bits. All clients of one /64 share a budget.

### Per-account limits

- Pairing mailbox, `PUT /api/pair/[requestId]`: 30 writes per 10 minutes per account (`pair-write`, 429 `rate_limited`), and at most 20 unexpired rows per account (429 `pair_mailbox_full`). Each write first deletes that account's expired rows. Rows live 10 minutes.
- Session relay token, `POST /api/auth/token`: 120 per minute per account (`relay-token-session`, 429 `rate_limited`).
- Ledger writes to an existing account, `POST /api/account/ledger` (scope `ledger-adopt-account`, key = `accountId`): 60 per 10 minutes by default (env `FTOWN_ACCOUNT_WRITES_PER_10MIN`), fixed window, 429 `rate_limited` with `Retry-After`. It is consumed only when the offered chain verified and leads to a real row write: the server adopts it, or keeps its own chain and adds new revocation ids to the sticky set. A reject, or a keep that changes nothing, spends nothing. [Superseded by 2026-11-10-append-only-ledger.md, section (c): only an adopted chain spends the budget. The sticky-only write for removals seen on a diverged chain is outside it.] A third party cannot use it to lock the owner out: a chain that is invalid, or a replay of the stored or an older chain, does not change the row and does not spend the budget. A chain that does change the row has to be a valid, passkey-signed chain, which only a holder of the account's keys can produce; replaying a public fork that carries revocations the server has not recorded yet spends the budget once, because the server records them. The browser shows "Too many changes in a short time. Wait a few minutes and try again." (Security panel).

### Server reads: sealed checkpoint

Why. Sessions are stateless JWTs signed with `AUTH_SECRET`. If the server trusted any value the database holds, a writer of the database alone could make it authorize a key. Verifying the whole chain on every request would be too slow. So the server stores a checkpoint of the verified chain and seals it with a key the database does not hold.

What is stored (migration `0012_multi_account.sql`, columns on `account_ledger`):
- `checkpoint`: text, the canonical JSON of the raw checkpoint of the chain, as `verifyLedger` returned it. No sticky revocations are applied to it.
- `checkpoint_mac`: text, lowercase hex HMAC-SHA256.
- They are written in the same statement as `ledger`, `sticky`, `head`, `revision` on every create and every write.
- The columns are nullable for rows that predate them.

What the MAC covers. The message is the lines `ftown-checkpoint-v1`, `account_id`, `revision`, `head`, hex SHA-256 of the canonical sticky set, and the checkpoint text, joined with `\n`. The canonical sticky set is `{"deviceIds":[...],"bridgeIds":[...]}` with those two keys in that order; the column's own text is not used because `jsonb` reorders keys. The key is `HKDF-SHA256(AUTH_SECRET, salt = empty, info = "ftown-checkpoint-v1", 32 bytes)`. The comparison is constant time. A MAC therefore binds the checkpoint to its account, revision, head and sticky set.

When the server trusts it. An auth decision (`readTrustedCheckpoint`) reads one small row. It trusts the checkpoint only if the MAC verifies and the checkpoint names exactly the row's `account_id`, `head` and `revision`. Then it parses no chain and checks no signature. The trusted checkpoint is `applyRevocations(raw, sticky)`, computed on every read from the raw checkpoint and the sticky set, never stored. `chooseLedger` for an offer uses the same MAC-checked raw checkpoint as its cache for the stored chain.

Heal path. If the checkpoint is absent, stale (head or revision differ from the row), tampered (MAC does not verify), or the MAC key changed (`AUTH_SECRET` rotated, or another instance wrote the row with a different secret), the server verifies the stored chain from genesis, checks that it matches the row's account, head and revision, and writes a fresh checkpoint and MAC. The write is guarded by `version`, `revision` and `head`. If the row moved meanwhile it re-reads, up to 3 rounds, then fails with `account_ledger_conflict` (503). A stored chain that does not verify is `account_ledger_corrupt` (503), never "absent". The heal uses the sticky set as it is in the row.

Threat model. A writer of the database alone, without `AUTH_SECRET`, cannot get a key authorized that the passkey-signed chain does not list. It cannot write a checkpoint the server will trust, and the heal derives the checkpoint from the stored chain, which must verify from the passkey-signed genesis. What such a writer can still do:
- Replay an older, internally consistent row (chain, sticky, checkpoint and MAC from a backup). The server then trusts the older state until a newer chain arrives.
- Remove sticky-only revocations. The sticky set is not passkey-signed. If it is edited, the MAC fails and the heal re-seals the edited set. Only revocations that exist solely on a discarded fork can be dropped this way; revocations of the winning chain are in the raw checkpoint.
- Serve a tampered `ledger` column to clients. Clients verify every chain from genesis themselves and reject it. The server does not verify signatures on a read whose MAC is valid; it checks only the two hashes (genesis to `account_id`, last record to `head`) and the columns.

Consequences for operations: rotating `AUTH_SECRET` is safe for stored accounts (each row is healed on its first read, one chain verification) but invalidates all sessions. Two instances with different `AUTH_SECRET` values re-heal each other's rows. See `docs/runbooks/multi-account-operations.md`.

### Account name

`/login` asks for an "Account name" (required, at most 64 characters after sanitising). It is used only as the WebAuthn `userName`, so passkeys of different accounts can be told apart in the operating system picker. It is not stored in the ledger and is never sent to the server.

### What stays the same

The ledger format and `accountId = hash(genesis)`; the bridge and its pairing client; channel names (`...#<accountId>`); authorities are add-only; one account per browser profile (a browser that already belongs to an account must sign in to it or be reset in Security).

### Browsers re-offer their chain

> **What changed (2026-11-10, append-only ledger; see 2026-11-10-append-only-ledger.md).** The re-offer itself stays: a browser, and now also a bridge, sends its own chain with `expectHead` when a read shows the server is a strict prefix of it. What changed is the rule behind it. There is no "outranks" or "wins": a chain is re-offered only when the server is `behind` (a prefix), and a server holding a valid different history answers 409 `diverged` and nothing is written. The browser no longer puts a user-signed record into its local chain before the server accepts it (it is the one pending write). Bridges now re-offer (the blind POST is gone), and every client POST for a held account carries `expectHead`. Statements below about outranking, fork choice, longest chain, joining the local chain early and bridges not re-offering are superseded and are marked where they occur.

Why. The server's copy of an account can fall behind a browser's chain: a database rollback to a signed prefix, a write the server refused, or a write that failed in transit. A replica never accepts a chain that loses fork choice, but before this change nothing pushed the winning chain back to the server until the next user-signed change. [Superseded by 2026-11-10-append-only-ledger.md: there is no fork choice. The server is brought forward only by a chain that extends its own.] A removal could stay unapplied on the server for that whole time.

When. A signed-in browser re-offers its verified local chain when a server read, or the answer to a POST, shows the server holding a chain that the local chain outranks. The server's head is recorded only after the replica ran fork choice on that chain, so a head different from the local head means the server lost. [Superseded by 2026-11-10-append-only-ledger.md: the trigger is "the server's chain is a strict prefix of the local chain". A different head can also mean a different valid history, which blocks the re-offer and raises the two-histories screen.] Equal heads send nothing. The triggers are:

- Any read of the account's ledger: opening the Security panel, its "Refresh access" button, every relay token renewal, every subscription to the ledger channel, sign-in of a known device, and the read each write and each pairing makes before it signs.
- A user-signed write that failed after its record joined the local chain (network error, 5xx, 429). It arms a retry timer. [Superseded by 2026-11-10-append-only-ledger.md: the record never joins the local chain before the server accepts it. It is the pending write and is retried as such.]
- The retry timer, and "Retry now" in the panel.
- The answer to a re-offer or a user write that carries the server's chain (409).

Relay messages (`ledger_head`, or a pushed chain the local one outranks) never cause a POST. Anyone holding a relay token can publish on the channel, so a message is not proof of the server's state. It only starts a read, paced to at most one per 2 seconds, and that read decides. A re-offer also always reads again before it sends, even when a trigger just recorded the server's head.

Safety rules.
- Fresh read immediately before the POST. If the read says the account is gone (404), nothing is sent. If it shows the server is no longer behind, nothing is sent.
- Fork choice decides. The browser sends only a chain that outranks the server's; the server runs `chooseLedger` on it like on any offer. [Superseded by 2026-11-10-append-only-ledger.md: the browser sends only a chain that extends the server's.]
- Never when the browser is unbound or signed out, during an account creation, or when this browser's own keys are not a trusted device of the account in its local chain (revoked, replaced, not enrolled).
- Never for another account: the chain sent is the bound account's own chain.
- Never creates an account. A re-offer carries `expectHead`, and the server answers 404 instead of running genesis admission.
- No passkey prompt. The records are already signed and public.

Wire shape. `POST /api/account/ledger` with `{ ledger, expectHead }`. `expectHead` is the server head the browser just read, a 43-character head; any other value is 400 `invalid_request`. The server checks it on the row it is about to write, before fork choice and before the account's write budget:

| Condition | Answer |
|---|---|
| no account for the chain | 404 `{ error: "account_unknown" }`, no creation budget spent |
| stored head is not `expectHead` | 409 `{ error: "head_changed", ledger }` with the stored chain, nothing written |
| stored head is `expectHead` | the normal replica answer (200 with `decision`, `ledger`, `discarded`), subject to the per-account write limit. [Superseded by 2026-11-10-append-only-ledger.md: also 409 `diverged` and 409 `ledger_rejected`.] |

After `head_changed` the browser runs fork choice on the returned chain and, if the server is still behind, sends again once in the same run. The `ledger-write` limit of the route (30 per minute per IP) still applies.

Pacing. The same (local head, server head) pair is sent at most once per 30 seconds. After a failure the next try waits 30 seconds, doubling to at most 10 minutes, each wait with a random factor of plus or minus 20 percent. A `Retry-After` from the server is honoured when it is later than that wait, up to one hour. Success, a server that is no longer behind, or a 404 resets the backoff. The first failure at each larger step is logged once with `console.warn` in the browser. One run at a time, one retry timer per tab.

What the user sees. In the Security panel a removal that is in the browser's chain but not in the server's is shown as "Removal not saved to the server yet" (on the computer row), with the text "Removal not saved to the server yet. It can still connect. Retrying…" and a "Retry now" button (the label becomes "Retrying…" while it runs). A removed browser shows the same group. "Retry now" does a fresh read and one attempt that skips the 30-second pair window and the backoff wait. It still sends only a chain that outranks the server's, still needs a trusted device, and needs no passkey. The notice disappears when the server holds the removal.

Limits.
- A client with no local copy of the chain (a new browser, a re-paired bridge) cannot detect a rollback. It reads the server's chain, adopts it, and has nothing to send. [Superseded in part by 2026-11-10-append-only-ledger.md, section (h): once it is a member and a computer is online, the on-connect comparison finds a rolled-back server.]
- Bridges do not re-offer a chain they hold ahead of the server. They read it. The one POST a bridge makes is the plain one in `onUnauthorized` (no `expectHead`), sent once per local head after the relay token request is refused. An account with no browser tab open therefore stays rolled back. [Superseded by 2026-11-10-append-only-ledger.md: bridge 0.22.0 re-offers with `expectHead` and has no blind POST, so a rolled-back account is repaired by any online member computer.]
- Between a rollback and the next browser connecting, the server authorizes the key the rollback revived. [Still true, with "or the next member computer" added.]
- "Longest chain wins" also means a longer fork without a revocation beats a shorter one with it. Replicas that saw the revocation keep enforcing it as sticky; replicas that never saw it (for example a database restored from before it) do not. [Superseded by 2026-11-10-append-only-ledger.md: no chain wins by length. A removal seen on a refused history is enforced through `seen`, and a resolution must carry every removal.]
- Backoff, pair memory and the retry timer are per tab. Several tabs of one profile each run their own schedule, and only a tab whose in-memory replica holds a record can re-offer it.

### Known gaps

Registration is open to anyone with a passkey when `REGISTRATION_ENABLED=true`. The following are not closed.

a. Relay client publish is not limited per user in Centrifugo. A foreign account can publish ciphertext or noise into another account's channels. Receivers drop it, but it is a flooding and history-poisoning vector. Close it before opening registration to strangers.
b. Centrifugo connection limits are global and shared by all accounts.
c. Without a trusted proxy (`FTOWN_TRUSTED_PROXY`, Vercel or Fly), `clientIp()` returns the constant `unknown`. Per-IP limits are then shared by everyone, and the global daily cap becomes the effective creation limit.
d. Pairing: the 6-digit code is `pairComparisonCode(request)`, a hash of the request that is part of the link itself (`bridge/src/security/ledger/pairing.ts`). It does not depend on the link's `secret`. Anyone who has the link can therefore compute the code, and a leaked link is enough to pair that computer into their own account within the 10-minute lifetime. The terminal prints which account it paired with ("Paired with account ..."); check it.
e. A rejected creation can leave an orphan passkey in the user's authenticator.
f. There is no account deletion and no cleanup of abandoned accounts.
g. A push endpoint already registered to one account cannot be claimed by another (409 `subscription_limit_or_conflict`).
h. A browser re-sends a chain the server is behind on (see "Browsers re-offer their chain"), and the Security panel shows a removal the server has not stored. Still open: bridges do not re-offer, and a rolled-back account with no browser tab open stays rolled back. [Superseded by 2026-11-10-append-only-ledger.md: closed for bridges 0.22.0. A rolled-back account is repaired by any online replica with history.] A browser that closes before its retry runs sends it the next time it reads the ledger.
i. For a few seconds after a pairing, the approving browser can get "Encrypted request rejected" from the new computer. Seen in e2e; the cause was not investigated.
j. There is no e2e coverage of `registration_closed`, creation `rate_limited` and `server_full`; they have unit tests only.
