# Encrypted endpoints and MCP operations

The hosted MCP process is a trusted plaintext endpoint. Standard MCP clients use
HTTPS/OAuth; bridge-facing content uses pinned, locally approved HPKE endpoints.
The public endpoint directory provides discovery metadata and grants no access.

Apply `ui/migrations/0006_endpoint_security.sql` before starting the upgraded
gateway or UI. This additive migration creates empty security tables and indexes;
it does not rewrite existing users, bridge credentials or OAuth records. DDL uses
five-second lock and thirty-second statement limits. Grants from before the
encrypted-endpoint release require fresh consent; existing encrypted MCP grants
remain usable. An upgraded bridge requires explicit device enrollment.

Set the UI's server-only `FTOWN_PUBLIC_URL` to its exact canonical public HTTPS
origin, for example `https://ftown.ia.br`: no trailing slash, path, credentials,
query or fragment. Cookie-authenticated account, pairing, consent, browser-directory and push
mutations accept a single canonical `Origin` matching either the existing request
URL's origin or this operator-configured public origin. This supports TLS proxies
where Next reconstructs an internal listener origin; `Host` and forwarded headers
cannot add trusted origins. If the setting is absent, only the request origin is
accepted. A present but malformed or empty value fails closed even for that
request origin. Canonical HTTP loopback origins are permitted for local mutation
checks; MCP's public login and gateway origins still require HTTPS.

Every configured MCP `fleet.machines[].id`, including local and HTTP adapters,
must equal that machine's actual authenticated `bridgeId`; use `label` for a human
alias. Read the ID from the bridge's security information or its private local
pointer. The matching `access[].machines` entries must use the same ID. Legacy
aliases are not silently mapped or approved: they do not match account ownership
or a bridge pin and require a configuration upgrade before fresh consent. Legacy
SSH/`--proxy` adapters return `upgrade_required` and never send application data.

Provision the gateway wrapping key **once**, independently of the deployment
runtime bundle. This command generates a random 32-byte key and sends it directly
to Fly's secret import standard input; never save the output as an artifact:

```sh
node --input-type=module -e 'import {randomBytes} from "node:crypto"; process.stdout.write("FTOWN_MCP_KEY_ENCRYPTION_SECRET="+randomBytes(32).toString("base64url")+"\nFTOWN_MCP_KEY_ENCRYPTION_KEY_ID=v1\n")' | fly secrets import --app ftown-mcp
```

Normal deployments verify the two secret names already exist and preserve their
values. The wrapping key does not enter PostgreSQL, the UI, source, logs or the
generated runtime bundle. It must be backed up in the operator's existing secret
manager. Missing/wrong keys fail closed; the service never regenerates a key to
make unreadable identities appear to work. Key rotation requires explicitly
rewrapping existing rows before changing the active key ID; this release does
not silently rotate or discard identities.

Private MCP identity, pinned bridge keys and approved permissions are encrypted
together with AES-256-GCM. Authenticated context binds version, account, consent
request, immutable grant, endpoint, expiry and wrapping-key ID. Pending consent
keys are stable across retries, and approved active expiry is fixed at consent.
Bridge approvals expire pending activation and never acquire browser admin power.

Gateway security history records all authenticated protocol/tool attempts and
batch children without raw arguments/results. Bridge history is independent
evidence of received operations. A timeout or incomplete record is an unknown
outcome, not proof that a mutation did not execute. Rows are bounded to 10,000 per
owner, with admission rejected when live in-flight rows exhaust capacity. A
thirty-second process lease heartbeat reconciles expired owners and removes old
finished records in batches of 1,000, including inactive accounts. Thirty-day
retention is the logical read boundary; a backlog larger than one cleanup batch
is removed over subsequent ticks. Live started rows are retained until their
process lease expires or their result is saved.

Rollback retains additive tables and the original wrapping key. An old client or
bridge does not regain plaintext access: restore connectivity by fixing forward
and explicitly approving supported endpoints. Lost browser keys require another
trusted account device to approve a replacement, or explicit local bridge
recovery; account password reset cannot recover keys.

## Account trust rollout (0.19.54)

Apply `ui/migrations/0007_account_trust.sql` before the upgraded UI. It adds two
empty public history/enrollment tables, indexes and nullable JSONB columns on
`pairing_requests`; existing users, credentials, pairings and MCP grants are not
rewritten. The nullable additions take a brief exclusive metadata lock, bounded
by the migration's five-second lock and thirty-second statement limits. Deploy
schema first. Rolling the app back leaves new trust records intact; fix forward
instead of deleting established trust history.

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
atomically. Local CLI recovery and already-approved fixed-expiry MCP grants
remain separate. Account revocation applies when learned, without cascading to
independently approved devices or previous MCP grants. MCP still requires all
selected bridges online for its existing exact-bridge receipts; future bridges
require new consent.

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
