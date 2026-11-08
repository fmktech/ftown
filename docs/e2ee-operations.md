# Encrypted endpoints operations

Bridge-facing content uses pinned, locally approved HPKE endpoints. The public
endpoint directory provides discovery metadata and grants no access.

Apply `ui/migrations/0006_endpoint_security.sql` before starting the upgraded
UI. This additive migration creates empty security tables and indexes; it does
not rewrite existing users or bridge credentials. DDL uses five-second lock and
thirty-second statement limits. An upgraded bridge requires explicit device
enrollment.

Set the UI's server-only `FTOWN_PUBLIC_URL` to its exact canonical public HTTPS
origin, for example `https://ftown.ia.br`: no trailing slash, path, credentials,
query or fragment. Cookie-authenticated account, pairing, browser-directory and
push mutations accept a single canonical `Origin` matching either the existing
request URL's origin or this operator-configured public origin. This supports TLS
proxies where Next reconstructs an internal listener origin; `Host` and forwarded
headers cannot add trusted origins. If the setting is absent, only the request
origin is accepted. A present but malformed or empty value fails closed even for
that request origin. Canonical HTTP loopback origins are permitted for local
mutation checks.

Rollback retains additive tables. An old client or bridge does not regain
plaintext access: restore connectivity by fixing forward and explicitly approving
supported endpoints. Lost browser keys require another trusted account device to
approve a replacement, or explicit local bridge recovery; account password reset
cannot recover keys.

## Account trust rollout (0.19.54)

Apply `ui/migrations/0007_account_trust.sql` before the upgraded UI. It adds two
empty public history/enrollment tables, indexes and nullable JSONB columns on
`pairing_requests`; existing users, credentials and pairings are not rewritten.
The nullable additions take a brief exclusive metadata lock, bounded by the
migration's five-second lock and thirty-second statement limits. Deploy schema
first. Rolling the app back leaves new trust records intact; fix forward instead
of deleting established trust history.

A browser keeps separate nonextractable HPKE and signing keys. First bridge
approval or explicit migration pins the account root; storing self-signed public
history in PostgreSQL alone grants no access. Later browser installations need
one existing trusted device approval, and current/future account bridges use the
verified roster. Enrollment links carry their proof secret only in the fragment,
which never reaches server storage. Requests expire after five minutes; an
approved encrypted response may be resealed by the same approver while the
request is still valid. Server checks public bindings; candidates independently
verify the secret HMAC, encrypted head and full signed history.

An adopted bridge removes legacy browser grants and outstanding invitations
atomically. Local CLI recovery remains separate. Account revocation applies when
learned, without cascading to independently approved devices.

History is bounded to 1,024 transitions and 2 MiB; active rosters to 128 browsers
and 128 bridges. Browser enrollment rows have a hard 128-slot cap per account.
Each new request cleans up to 1,000 globally expired enrollment rows; an inactive
installation does not imply an automatic physical deletion deadline. Clients
refresh signed history every thirty seconds, fail closed on known rollback or
conflict, and preserve clock highwaters. Running clients allow up to twenty-four
hours without a successful matching account read; after restart an authenticated
refresh is required before account-derived access. A malicious service can
withhold updates, so this is not a guaranteed global revocation deadline.

Losing every signing key requires explicit recovery/rebootstrap of each bridge;
OS-local access cannot restore account signing authority. There is no automatic
root reset when a server returns an empty history. This rollout provisions no
new environment secret, does not migrate Zod, and performs no production schema
execution or deployment by itself.

This rollout cannot remove plaintext already observed by earlier relays or push
providers. Pre-upgrade broker history lasts until its configured expiry. Existing
`push_events.payload` rows may retain historical plaintext; the existing push
store has no automatic expiry, so those rows remain until an operator explicitly
purges them. This additive migration does not rewrite that history. New push
writes, readback projection, delivery and service-worker display use fixed generic
text even if a legacy stored event contained details. An optional historical purge
is a separate operator action and must preserve any required delivery bookkeeping.

## Dependency record

Added coupled packages `@hpke/core` 1.9.0 and `@hpke/common` 1.10.1, pinned in both
bridge and UI. Names/versions, MIT licenses and publisher repository were verified
against npm metadata. Core/common release notes and the official nonce-reuse
advisory were reviewed: versions through core 1.7.4 are affected; this version is
patched. Full keypairs avoid private-key export/public-derivation behavior, and
browser key generation explicitly requests non-extractable keys. The common
1.10.1 information-length change is not relied on: our domain information is
fixed and packet sizes are capped. No preexisting package versions or lockfile
metadata changed; each lock adds only these two packages. Pure tests include the
published RFC9180 Auth P-256/HKDF-SHA256/AES-256-GCM vector and tamper/context cases.
Browser/Node and deployed-flow verification remain separate gates. Reverting the
dependency addition alone restores the old graph but cannot support the new
persisted encryption identities; retain keys and fix forward for that data.

Official references: [core](https://www.npmjs.com/package/@hpke/core),
[release notes](https://github.com/dajiaji/hpke-js/blob/main/packages/core/CHANGES.md),
[security advisory](https://github.com/dajiaji/hpke-js/security/advisories/GHSA-73g8-5h73-26h4),
[RFC test vectors](https://github.com/cfrg/draft-irtf-cfrg-hpke/blob/master/test-vectors.json).
