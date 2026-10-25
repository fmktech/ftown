# Encrypted endpoints and MCP operations

The hosted MCP process is a trusted plaintext endpoint. Standard MCP clients use
HTTPS/OAuth; bridge-facing content uses pinned, locally approved HPKE endpoints.
The public endpoint directory provides discovery metadata and grants no access.

Apply `ui/migrations/0006_endpoint_security.sql` before starting the upgraded
gateway or UI. This additive migration creates empty security tables and indexes;
it does not rewrite existing users, bridge credentials or OAuth records. DDL uses
five-second lock and thirty-second statement limits. Existing MCP grants require
fresh consent. An upgraded bridge requires explicit device enrollment.

Set the UI's server-only `FTOWN_PUBLIC_URL` to its exact canonical public HTTPS
origin, for example `https://ftown.ia.br`: no trailing slash, path, credentials,
query or fragment. Cookie-authenticated consent, browser-directory and push
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
and explicitly approving supported endpoints. Lost browser keys require fresh
local bridge invitation approval; account password reset cannot recover keys.

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
