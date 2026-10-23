# Centrifugo security migration — 2026-10-23

Owner: `/root/canonical_start`, explicit `gpt-6.1-sol` / `high`, shared checkout.
Scope: reviewed ownership manifest plus approved `.dockerignore` and root-only
`bridge/scripts/centrifugo-security-smoke.mjs`. No npm/lock/Node-image edits, Git
mutations, real server/container/browser execution, global installs or deployment.

## Why 6.10.2

Centrifugo 5.4.9 uses `centrifugal/protocol` 0.13.4, inside the affected range of
[GHSA-4r3x-2rwr-6w65](https://github.com/centrifugal/centrifugo/security/advisories/GHSA-4r3x-2rwr-6w65).
6.9.2 includes decoder hardening, but is not a sufficient current target: later
[recovery deadlock](https://github.com/centrifugal/centrifugo/security/advisories/GHSA-xcch-wm46-g65g)
fixes land in 6.9.7; 6.10.1 updates Go for current security fixes and 6.10.2 also
updates the image CA bundle. The existing deployment is not patched until the
new matching image/config is deployed; old installed Solo packages also need an
explicit package upgrade/setup and restart.

Primary inputs: [v6 migration](https://centrifugal.dev/docs/getting-started/migration_v6),
[official converter source](https://github.com/centrifugal/centrifugal.dev/blob/main/src/components/converterv6.jsx),
[all release entries](https://github.com/centrifugal/centrifugo/releases), and
[6.10.2 release](https://github.com/centrifugal/centrifugo/releases/tag/v6.10.2).
No new feature/engine/transport is adopted.

## Intermediate release and behavior review

The v6.0.0–6.10.2 release entries were checked for configuration, protocol,
authentication, default and security changes. Material verdicts:

| Range/change | FTown usage and verdict |
| --- | --- |
| 6.0.0 nested configuration; unified TLS | Used in four committed configs and generated Solo config: translated together; legacy renderer verifies nested secret fields. |
| 6.0.0 removes SockJS/Tarantool | Not used: FTown uses bidirectional JSON WebSocket and memory engine. |
| 6.0.1–6.2.5 Go/dependency updates, consumer/Redis changes | No Redis, Kafka, cloud async consumer or outbox adoption. Existing JSON SDK traffic retained. JWT expiration cap does not affect short-lived FTown tokens. |
| 6.3.0 flags override environment; ping/pong changes, fixed in 6.3.1 | Only config-path argv is used. Explicit ping 10s/pong 5s preserved; root checks real connection/reconnect. |
| 6.4.0–6.6.2 optional filters/HTTP2/consumer changes; writer regression repaired | No optional new features enabled; target includes the repaired writer. |
| 6.7.0–6.8.4 JWKS/SSRF, Go, decompression fixes | FTown uses HMAC, no dynamic JWKS. Target includes fixes; existing compression/message limits retained. |
| 6.9.0 headers emulation allowlist becomes explicit | No proxy/header-emulation configuration in these configs; do not add an allowlist or proxy. |
| 6.9.1 admin URL-token fallback removed | No FTown use; HTTP API callers already use X-API-Key. Fly/Solo admin remain disabled. |
| 6.9.2 decoder/admin throttling fixes | Included; legacy/E2E admin settings retained, hardened Fly surface unchanged. |
| 6.9.3 sustained connection-rate fix; command-size enforcement | Preserve configured Fly rate 50 and limits; malformed/oversize inputs may now be rejected correctly. |
| 6.9.4–6.9.7 recovery/refresh/UTF-8/cache/origin fixes | Relevant recovery fixes included; root tests presence, history/reconnect and owner-isolation. No map/delta/Redis feature adoption. |
| 6.10.0 strict client JSON, new API error detail/codes, invalid UTF-8 rejection | FTown uses official JSON SDKs and serializes JSON payloads. Legacy method/params API and result/error reply still supported by upstream handler_legacy.go. Root checks channels/presence. |
| 6.10.1 Go 1.27.3; 6.10.2 image CA bundle | Both included; current image trust-store repair is why the target is 6.10.2. |

Named namespaces do **not** inherit `channel.without_namespace`. All six namespace
objects retain their exact previous explicit values, including sessions' zero
history/nonrecovery and distinct Fly/legacy versus development/E2E terminal
retention. Misleading Solo inheritance comments were corrected without adding
permissions or retention settings. The existing bridge publisher-identity check
remains necessary: user-limited channels protect subscriptions, not arbitrary
client publishing. No app firewall code was changed.

## Pins and mappings

Docker tag `centrifugo/centrifugo:v6.10.2` resolves to multiarchitecture index
`sha256:34b84f823515927266ce3abfb840fd9e0acabb58805e7e896f5de731217a627d`
(linux amd64/arm64), verified read-only against Docker Registry v2.
Published official release archive SHA256s, retrieved through GitHub release API:

| Solo platform | Archive SHA256 |
| --- | --- |
| darwin-amd64 | cdb1ce846103750cc2eb24b2998aeaacb97dc189a7584b00f11a9bcb7d7bc2b5 |
| darwin-arm64 | ca1c7b02763280a97a4605a6a359ef90c831f6520727b48b09eab8281f07c792 |
| linux-amd64 | fea3767686d2bcc55df02094cc323268d9a02bb255eb60884d9e74ce4162eb45 |
| linux-arm64 | 5bfaf520235db64ea1339247f4d6b14c0738979fedae187c57aa24c1861db5c2 |

These are upstream archive checksums, not hashes of locally executed binaries.
Solo continues to verify archives and versioned cache entries before use.

Mappings: token → `client.token`; origins/auth/limits/ping/pong → `client`;
channel defaults → `channel.without_namespace`; namespaces → `channel.namespaces`;
WebSocket options → `websocket`; bind/ports/ACME → `http_server`;
API → `http_api`; admin → `admin`; health → `health.enabled`;
engine → `engine.type`; logging → `log.level`. Internal port is encoded as the
v6 string type. No old key is intentionally left as a warning-only fallback.

Fly's entrypoint aliases existing `CENTRIFUGO_TOKEN_HMAC_SECRET_KEY` to
`CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY` only when the native name is unset.
Explicit native values win; empty native values fail closed. Secrets are not
printed or placed in argv. GitHub/Fly external secret names are unchanged.
The legacy renderer keeps all four existing placeholders/names and validates
nested fields. Its remote helper checks Docker/systemd binary version before
backup/install/restart and rejects old/ambiguous/prerelease versions. Operators
must upgrade that host binary/image manually; this script never recreates a
container or installs a binary on a live host.

## Worker checks and remaining root gates

Passed isolated checks:

- 34/34 pure configuration/secret-alias/mocked Docker+systemd guard tests.
- 15/15 name-filtered hub-manager configuration/platform/archive-safety tests;
  nested startHub parsing is exercised with a fake child and fake health fetch.
  HTTP-listener tests were deliberately not executed by the worker.
- Shell syntax, smoke-script syntax and all four changed YAML documents parse.
- Exact config checker rejects unknown/missing root/nested keys, changed audience,
  permission/history drift and public health/API exposure. Workflow validation
  rejects upstream unknown-key warnings even when checkconfig exits zero.

Root/integrator still owns compile/full units and real validation. Run the Fly
validation workflow with **deploy=false** for the pinned image build/checkconfig,
endpoint/origin checks. It selects Node 24.22.1 before the pure checks. Validate
all four configs with actual 6.10.2 and fail unknown-key warnings.

After combined build, root-only minimal Solo hub smoke:

```sh
node bridge/scripts/centrifugo-security-smoke.mjs --archive /absolute/path/to/official-current-platform-archive.tar.gz
```

Omit `--archive` to fetch the official archive. The script has a 90-second ceiling,
uses temporary HOME/data and a loopback child, verifies embedded archive checksum
and cache reuse, mode 0600, valid/wrong-audience JWTs, owner/foreign subscription,
owner publish/history/reconnect, disabled API/admin, health and owned-child cleanup.
No real provider/cloud/database is contacted. Worker authored and syntax-checked
it, but did not execute it. Root's hosted realtime/auth suite must also exercise
existing `/api` channels/presence envelopes and bridge foreign-publisher rejection
with an owner-positive control; reuse idor-channels/direct-transport coverage.
Upstream v6.10.2 [mux.go line 266](https://github.com/centrifugal/centrifugo/blob/v6.10.2/internal/app/mux.go#L266)
explicitly registers the base API prefix through `apiHandler.OldRoute()`, alongside
the new per-method routes. The existing E2E helpers therefore exercise supported
legacy behavior rather than an assumed compatibility shim.

Rollback restores a **matching image/binary + config/package pair**. Existing
memory-engine history is lost on restart, as before. No durable FTown session/mail
schema migration or secret rotation occurs. No production deployment or separately
installed CLI audit is claimed by this change.


Source status: frozen; all worker processes/checks complete, no active resource
leases. Real binary/config/runtime execution remains with root. The report does
not claim those pending gates have passed.
