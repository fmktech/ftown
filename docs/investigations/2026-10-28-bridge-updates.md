# Bridge and app updates, rebuilt on current main

Base: `ce62d9d3c118528df70b9e49aceea4aaf1e28819`. The obsolete local
`feat/version-update` branch was deleted at the user's request. This implementation
does not reuse its prototype. Shared checkout: `ftown-bridge-updates`, branch
`feat/bridge-update-flow`. Root owns architecture, coordination and E2E execution.

## Product and security contract (reviewed wire/UX; runtime API freeze below)

The dashboard shows each approved bridge's installed version and whether a stable
release is available. Opening the bridge's visible, keyboard-accessible More menu
offers **Updates…**. A compact dialog shows current/latest versions, checking,
offline, unknown/older-bridge, permission, unsupported-launch and busy explanations.
The positive action is **Update and restart**, with an explicit confirmation that
the bridge will briefly disconnect. No automatic installation or page reload.

Initial assisted-update support is deliberately bounded: an explicitly opted-in
`ftown start --allow-updates` from the canonical installed CLI on POSIX, using the
default data directory and an unsupervised, single-bridge HOME. Windows, Solo,
source/dev, unmanaged/direct package launches, custom/shared instances and service
managers receive pinned manual setup/start guidance. Running/pending sessions,
actual live/pending runner generations and in-flight launches block handoff.
An update never stops sessions on the user's behalf. The UI must not promise
generic session survival, transactional setup rollback, or completed installation
merely because a request was accepted.

### Wire and authority

`bridge/src/update-protocol.ts` is the shared compiler-enforced wire contract.
`get_bridge_update` requires existing encrypted **read** authority and an explicit
matching `bridgeId`. `update_bridge` requires existing encrypted **control**
authority, matching `bridgeId`, an exact canonical stable `targetVersion`, and a
UUID `operationId`. Only these two commands are added; no plaintext update endpoint,
arbitrary URL, shell, registry, package name or command is accepted from clients.
The bridge computes `canUpdate` from real current permission and support/busy state.
UI roster metadata is never authority. Execution revalidates immediately before
mutation and before shutdown. Revocation prevents commitment.

`manualCommand` has the exact grammar `npx ftown@<version> setup`, where version is
canonical numeric stable semver or literal `latest` when unknown. Only recovery may
append the literal ` --repair`. Consumers validate the whole string before Copy.

Stable release metadata comes from a fixed HTTPS npm registry/package. Latest
checks are cached/coalesced and bounded; explicit refresh does not permit a request
storm. Failures retain installed-version visibility and report unknown availability.
Execution independently rechecks latest and rejects stale targets, prereleases,
noncanonical versions and downgrades. Fixed npm arguments use `shell: false`.
Same operation ID and same target are idempotent; same ID with a different target
fails. A second operation while staging/restarting fails. UI never retries a
mutation automatically, including after an RPC timeout.

### Lifecycle invariants

1. Authorize, validate target and support, persist operation identity, and acknowledge
   acceptance through the existing audited encrypted transport.
2. Stage the exact package in a private directory while the old bridge remains
   available. Validate the package identity/version, Node compatibility, entrypoints
   and native modules. Staging failure keeps the existing bridge running.
3. Freeze session launch admission, drain in-flight launch work, inspect both stored
   sessions and runner generations, and revalidate authority. A busy/revoked result
   releases admission and fails without shutdown.
4. Prepare a one-shot, builtin-only POSIX helper outside the runtime that setup
   replaces. Require private IPC prepared acknowledgement. Only after the update
   request has two successful signals may commitment stop the old process: the
   original successful result was audited and its sealing was awaited; then the
   exact HTTP response emitted `finish` or its cloud publication resolved. This is
   OS/broker handoff, not proof of browser consumption. Error-sealed replies,
   premature close and publication failure cannot arm the ticket. Release the
   request's own drain token before scheduling update work; never await the job
   from that request. Prepared is not install authority: require an explicit private
   commit acknowledgement. If cancellation or commit becomes uncertain, prove the
   owned helper exited before unfreezing admission.
5. The helper waits for the exact old process exit, invokes the staged package's
   existing setup, then starts the installed exact-version CLI with normalized
   nonsecret original options. It never runs old and replacement bridges together.
   The staged candidate must advertise private restart/readiness protocol 1 before
   commitment. Readiness is explicit private IPC after startup/session resurrection,
   with the same owner, endpoint and bridge identity, not pointer existence or an
   arbitrary timer. Update restart forbids bootstrap/new-pairing fallback; failed
   existing authentication is an installed-but-offline failure.
6. Use bounded stage/setup/start deadlines and an atomic private operation receipt.
   A failure after setup begins records exact-version repair/start guidance. Existing
   setup is not transactional and rejects downgrade; do not claim rollback or
   silently run older setup. UI reports uncertain/reconnecting until a fresh
   authenticated status from the same bridge confirms the target version.

### Browser application updates

The UI has a build-frozen identity shared by its client bundle and a no-store
`GET /api/version` response. Package version `0.1.0` and a waiting service worker
are insufficient identity. Check on mount/visibility and a bounded interval; unknown,
offline and equal versions remain quiet. A changed identity shows **App update
available** with **Reload** and **Later**. Warn that reloading reconnects the terminal
and unsent dialog input may be lost. Reload only on explicit action. Preserve
existing push/service worker behavior. App update detection is separate from bridge
release detection and does not require bridge control authority.

### UX acceptance

Reuse existing colors, buttons, modal and menu conventions. The bridge More button
must be visible on touch devices, at least 44×44 CSS pixels, named with its bridge,
and must not expand/select the bridge when activated. Preserve right-click support.
Menus/dialogs need Escape, focus management, keyboard activation and mobile layout.
Show installed version without widening the sidebar or displacing the bridge name.
Use **Stop running sessions before updating** for busy; never offer an implicit
stop-all action. Unsupported/older bridges get copyable terminal instructions.
Errors must be bounded user-facing copy, never raw install logs/secrets.

## Validation and coordination

Implementation briefs and exclusive ownership are recorded alongside this document.
Workers may run assigned unit/static checks. Root alone starts E2E, services,
databases, sandboxes and CI reruns. Runtime validation must use a scratch HOME and
isolated local database, never the user's running bridge. Use fixture releases and
dependency injection for installer failure/restart checks; never publish a fake npm
release or update a real user bridge for testing. Required evidence includes target
and authority rejection, busy/admission races, acknowledgment/audit ordering,
pre-handoff failure preserving the process, helper failure receipts, authenticated
reconnect reconciliation, app build detection, desktop/mobile menu rendering and
the repository's build/test gates.

Independent pre-freeze review: `/root/site_review` (`gpt-6.1-sol`, `max`) reviewed
the wire/UX and identified the three lifecycle clarifications incorporated above.
The shared wire contract is frozen; internal helper/release APIs will be frozen
before dependent runtime implementation. Review discovery is retained in common
Git receipt `bridge-updates-runtime-discovery.md`.

## Frozen internal APIs and constants

`update-runtime-contract.ts` defines the reviewed package/helper boundary. The named
methods in `UpdateReleaseApi` and `UpdateHandoffApi` are named function exports from
`update-release.ts` and `update-handoff.ts` respectively. Re-export their types if
useful, but do not invent a competing contract. `update-handoff.ts` uses builtin-only
runtime imports so its copied `.mjs` survives replacement of the installed runtime;
all shared contract imports must be type-only. Package manifests advertise
`ftownUpdateProtocol: 1`; a candidate missing that capability is rejected while the
old bridge stays online.

Runtime-owned stagingRoot is `HOME/.ftown/updates`. Stage jobs are private UUID
children, never caller-supplied paths. The helper module owns atomic, 0600 receipt
storage at `updates/operation.json` and a single `HOME/.ftown/update-reservation.json`
reservation. `reserveUpdate` precedes staging; ordinary setup/start call
`assertUpdateReservationAllowed` before mutation. It rejects live/unknown foreign
owners, reclaims only proven-dead exact owners, and admits only the matching private
helper setup/restart context. Transfer reservation ownership to the prepared helper
without leaving an unowned gap. Cancellation must prove helper exit; releasing a
foreign/unknown reservation never succeeds silently. Local opt-in declares an
unsupervised single-bridge HOME; it is not automatic discovery of old arbitrary
processes or external supervisors.

R1/P1 clarification: ordinary `prepareHandoff` rejection guarantees no owned helper
remains. If exit cannot be proven, throw an Error tagged `code: 'handoff_uncertain'`;
the coordinator preserves stage/reservation and keeps admission closed. A rejected
`cancel()` is likewise never evidence that reopening admission is safe.

Budgets: metadata 15s/1MiB; metadata cache 30min with explicit refresh minimum 30s;
stage/setup each 5min; helper preparation/commit/old exit each 15s; replacement ready
60s. One active operation. Logs are private and bounded, never returned over RPC.
Releases use fixed `https://registry.npmjs.org/ftown/latest`, validated fixed-origin
ftown tarball, canonical numeric semver, SHA integrity and gitHead. Install in private
prefix using argv arrays, isolated npm config/cache and a secret-free install env;
validate engine compatibility, exact name/version/integrity, protocol and native
loads. No client-supplied registry or hidden production test override.

The restart descriptor is reconstructed on the bridge, has no bootstrap token, and
preserves mode, default dataDir, cwd, API origin, bridge/owner/endpoint. The helper
owns its exact process/nonce IPC, commit ACK, old-process exit, existing setup,
exact installed runtime launch, ready ACK and post-commit failure receipts. It never
retries a failed setup/start loop. Coordinator reads/writes receipts through these
shared functions, exposes the wire status, and owns authorization/admission and
transport tickets. Root approved the independent review's compact two-worker split
with receipt/reservation APIs added to give those shared files exactly one owner.

Readiness review clarification: an update replacement keeps mutation/launch admission
closed until the helper's final ready ACK. The helper validates identity and persists
the successful receipt while retaining the reservation, then treats the ACK send
attempt as irreversible: the replacement may already admit work. Only a successful
ACK send callback permits reservation release. After any ACK attempt, helper errors
must never kill the replacement; ACK/release uncertainty retains the live helper and
reservation with truthful uncertainty. Before ACK attempt, failure may terminate the
owned replacement with bounded proof. This supersedes the earlier release-before-ACK
brief ordering, which left no reservation to retain on uncertain delivery. Preserve the
existing trusted nonsecret `FTOWN_ALLOW_INSECURE_API` setting for a supported saved
HTTP API origin in the replacement only; npm staging remains sanitized.
