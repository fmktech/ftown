# Implementation briefs

All work uses `/Users/fkesheh/projects/ftown-bridge-updates` on
`feat/bridge-update-flow`. Others share this checkout: never revert their edits,
write outside ownership, run Git mutations or recursively dispatch workers. Escalate
contract changes to root; root pauses dependents and reviews/re-freezes them. Native
worker IDs, ownership and leases live in the adjacent ownership JSON. No worker
starts E2E/browser runs, servers, test databases, sandbox runtime or CI. Root owns
those resources and execution. Node: `/Users/fkesheh/.nvm/versions/node/v24.22.1/bin`;
prefix every shell command with `rtk`. Root installed package dependencies, and
retains the exclusive install/lockfile lease until integration.

## U1 — app and bridge update UI

Tier 1, `gpt-6.1-terra`, `xhigh`, `/root/site_capture`.

Outcome: an approved connected bridge exposes its authenticated installed version
and update information through the existing dashboard RPC. A visible touch/keyboard
More menu opens Updates. Users can explicitly request a supported bridge update and
track it through disconnect/reconnect. The app independently detects a newer UI
build and offers an explicit reload. No automatic mutations or reloads.

Ownership: `ui/src/`, `ui/next.config.ts`, `ui/public/sw.js` only if necessary,
`e2e/tests/bridge-updates.spec.ts`, and `docs/investigations/bridge-updates-ui-handoff.md`.
Root owns package installs, lockfiles and shared contract. Read-only dependencies:
`bridge/src/update-protocol.ts`, product/security contract in
`2026-10-28-bridge-updates.md`, existing discovery report in common Git receipts,
and existing E2E fixtures. Do not change bridge sources or common E2E helpers/config.

Interfaces: import the exact shared `BridgeUpdateStatus`, `BridgeUpdateAccepted`,
`GetBridgeUpdatePayload`, `UpdateBridgePayload` types; extend existing UI CommandType
union with `get_bridge_update` and `update_bridge`. Use Dashboard's one existing
`useBridgeRpc` instance and targeted `{bridgeId}` payloads. The existing
`CommandResponse` wrapper remains authoritative: successful reads carry
`BridgeUpdateStatus`, successful mutations carry `BridgeUpdateAccepted`; errors
have `success:false`, safe `error` and optional `data.code`. Browser code must
validate untrusted response structure before rendering; it cannot infer update
authority from roster permissions or presence. No new transport, command channel,
credential storage or plaintext endpoint. Version information is private to the
existing approved bridge read permission.

Per-file behavior: isolate async update state in a new hook/controller so SessionList
does not become an updater. In Dashboard wire hook to the existing RPC and connection/
bridge security state. SessionList adds compact version/state, visible bridge More
button and Updates entry while preserving expansion, drag/drop, counts, security
controls and right-click. Use a dedicated update dialog component. New `GET
/api/version` must return `{buildId:string}` with explicit no-store headers and use
the same build-frozen identity as its bundled client; choose a sanitized deployment
commit/build identifier or random build-time fallback once in next config. Runtime
environment cannot change that identity. Exclude version API from SW caching; retain
push behavior. The app banner lives in the existing authenticated dashboard/shell.

State details: coalesce reads per bridge; do not query unapproved/offline bridges or
create parallel RPC subscriptions. Initial reads and visibility/reconnect checks;
normal periodic interval at least 60s, active update reconciliation at least 3s.
Clear stale per-connection capabilities when disconnected. A timeout/unsupported
command on an older bridge yields manual instructions, never a success/no-update
claim. Generate one operation UUID per explicit action. Disable duplicate actions.
On timeout retain that operation and poll status; never resend mutation automatically.
Success requires an authenticated status from the same bridge with target installed
version and a matching successful operation; current version alone without matching
operation may be shown as current but not as this operation's successful completion.
Unmount aborts timers and prevents stale replies from overwriting a newer connection.
App version check: mount, visible document, 5-minute interval; bounded request,
validate identity, quiet on offline/error, Later suppresses the same advertised ID
for this tab. Reload only explicit click; disclose unsent input loss/reconnect.

UX: >=44×44 More target named `Actions for <hostname>`, aria-haspopup/expanded,
stop propagation, preserve current menu dismissal/focus; Updates entry named
`Updates…`. Dialog includes current/latest versions, state, concise support reason,
copyable fixed-package setup command plus start guidance, Check again, Close, and
eligible **Update and restart**. Confirmation explicitly says all sessions must be
stopped and bridge briefly disconnects; no stop-all. Busy copy **Stop running sessions
before updating**. Unsupported launch explains `ftown start --allow-updates` requires
an unsupervised single-bridge installation; show manager/manual instructions when
unsupported. No raw installer logs or secrets. At 390px wide there is no horizontal
overflow; preserve name visibility. Escape closes and restores focus; keyboard actions
and live status announcements work. App banner **App update available**, **Reload**,
**Later**, concise unsent-input warning. No giant modal appears automatically.

Acceptance: meaningful component/hook unit tests for real async state transitions,
two-bridge isolation, read-only/unsupported/busy, double-click, uncertain acceptance,
authenticated reconciliation, app build equality/change/error/explicit reload.
Run UI focused Vitest and `npx tsc --noEmit` once relevant types exist; do not invent
network bypasses or test-only production environment knobs. Author focused Playwright
coverage using existing paired bridge fixtures for desktop/mobile visible menu,
version read, unsupported manual state, authorization denial and app update banner
(network route fixture acceptable for app deployment identity, never for claiming
actual update/restart success). Root executes E2E and rendered review after handoff.
Provide exact commands/selectors, paths, assertions, remaining limitations, and
explicit release of file leases. Root coordinates integration; `/root/site_integration`
is the designated final landing worker after all writers stop.

## P1 — release staging, one-shot helper and package capability

Tier 1, `gpt-6.1-terra`, `xhigh`, `/root/site_integration` (also final landing owner,
but no Git mutation until separately leased after writers stop).

Outcome: download/validate only the exact current stable ftown release into a private
job; keep active runtime unchanged until the old process exits after an explicit
prepared/commit exchange. Then existing setup installs it and the matching canonical
CLI starts once. Same bridge/owner/endpoint/version readiness creates a successful
durable receipt. All failure phases are bounded and truthful.

Exact writable files: `bridge/src/update-release.ts`, `bridge/src/update-release.test.ts`,
`bridge/src/update-handoff.ts`, `bridge/src/update-handoff.test.ts`,
`bridge/scripts/bridge-update-smoke.mjs`, `bridge/package.json`, `bridge/package-lock.json`,
`README.md`, `docs/investigations/bridge-updates-package-handoff.md`. Read-only:
both shared update contract modules, main product contract, current setup/start/
installation implementation and runtime discovery common-Git receipt. Consume
frozen signatures in `UpdateReleaseApi`/`UpdateHandoffApi`; implement each as named
exports. Runtime writer consumes these exact names and owns all calling integration.
Do not change their code or contracts. Root leases package metadata only to you;
set package version and lock root version to 0.19.58 and `ftownUpdateProtocol:1`.
Do not add dependencies unless essential and root grants a serialized install.

Per-file behavior: release module uses bounded fixed HTTPS metadata, strict stable
version/gitHead/integrity/engines/artifact-origin validation, no arbitrary client spec.
Private staging is separate from installed runtime; npm engine-strict and fixed
registry, sanitized install env excluding cloud/provider tokens and inherited npm
config. Native load probes use the same Node executable as restart and clean up
native datachannel resources. Validate protocol1, exact package identity/version and
integrity before accepting candidate. Rejecting/aborting removes only this owned
uncommitted stage. No shell eval or downgrade. Add injectable function-level seams
for unit fixtures; no production registry override/environment backdoor.

Helper must have only builtin runtime imports; copy to private immutable job .mjs.
It owns reservation/receipt helpers per frozen spec and private IPC representation.
`prepareHandoff` does not run setup; wait exact nonce/operation/version/PID prepared
ACK. `commit()` resolves only exact commit ACK. Helper does not install until exact
old process has exited. `cancel()` proves its owned helper exited even after an
uncertain commit; if proof fails reject and leave reservation/admission closed.
After old exit run staged existing CLI setup, then exact installed CLI start with
private restart context, no spent token, no new pairing. Require matching readiness
identity after runtime's actual startup. Bounded failures retain repair receipt,
stop only the helper-owned failed child, and never auto-rollback/downgrade/retry.
Match real canonical paths, owner/mode/type, avoid symlink/foreign-lock deletion,
atomic 0600 receipts. Coordinator uses reservation before stage; setup/start guard
admits only matching private helper context. Preserve necessary nonsecret launch
configuration; never log whole env/descriptor or copy install secrets into scripts.

README documents explicit opt-in/single-bridge unsupervised POSIX/default-home support,
busy restrictions, manual managers/Solo/Windows, explicit browser reload, no rollback
promise, exact-version repair/start commands and private receipt location.

Acceptance: unit tests validate metadata/spec injection rejection, version/prerelease/
downgrade/candidate capability mismatch, abort/failure cleanup, native failure, lock
ownership, no setup before old exit or without commit, exact readiness identity,
bounded setup/start failure receipt and own-child cleanup. Unit tests may use faked
spawn/FS boundaries without live services. Implement process smoke at the assigned
script for root execution only: private temporary HOME/job, real helper IPC, controlled
fixture setup/replacement executables and no network registry/user config. It must
demonstrate success and pre-/post-commit failures through actual OS children, cleanup
only owned resources, and print bounded results. Also give root steps for installed
real bridge `ftown harness status` in isolated environment. Do not start smoke/E2E
yourself. Handoff files, unit results, exact smoke command, honest fixture limits and
released package/file leases; remain available for concrete review fixes.

## R1 — authenticated update coordinator and bridge lifecycle integration

Tier 1, `gpt-6.1-terra`, `xhigh`, native runtime worker. Scope is one coherent existing
bridge lifecycle, with release/helper APIs supplied by P1 and wire/UI by U1. Root owns
final architectural choices; do not broaden to general supervisor/installer redesign.

Outcome: real encrypted read/control commands expose versions and accept one explicit
update; no updater effect occurs before audit/seal plus transport handoff. Supported
launches safely freeze admission/drain, stage through P1, commit helper and gracefully
exit. Unsupported, busy, revoked, stale target, duplicate/conflicting or failed requests
remain safe with truthful status. Replacement verifies private protocol and identity,
forbids new pairing, and signals real readiness after startup/resurrection.

Exact writable paths are enumerated in ownership JSON: coordinator/admission/effect
modules and matching tests; command-rpc/types/permissions/security execute; local API/
Centrifugo; start/index/setup; runner/create-session/store/pump/resurrection; runtime
inventory and relevant existing tests. Read-only P1 files, frozen update types, UI,
package metadata and root coordination. No other files without root ownership transfer.

Wire semantics frozen in product contract: read permission for get_bridge_update,
control for update_bridge. Strict explicit target and strict primitive fields;
CommandResponse success data exact shared types, failure safe error plus data.code.
get status computes actual control capability using current policy revalidation;
permission failure cannot leak protected status or enable mutation. Execution rechecks
target latest/server authority, support, reservation and quiescence. Preserve existing
security/audit paths; no plaintext allowlist shortcut or HTTP update endpoint.

Coordinator owns metadata caching/coalescing and validated stable comparison, current
running package version, status mapping, receipt load/reconciliation and UUID idempotency.
Reserve operation synchronously before awaits; duplicate same ID+target returns same
operation, conflict ID/target rejects, concurrent different operation rejects. Persist
accepted staging identity but do not perform updater effects until exact accepted
request is audited and transport handed off. A failed/unacknowledged ticket cancels
the reserved operation and releases its resources; operation status must not stay
staging forever. Never mark failed request receipt as update success. Keep bounded
errors; no raw stage logs/secrets in RPC.

Implement trusted two-signal tickets at exact seams identified by discovery:
executeSecurePacket success after awaited complete AND seal, then local secure HTTP
finish or resolved Centrifugo publish. Error sealed reply cannot arm; HTTP close/error
and publish reject cancel; own request drain token released before job starts. Track
admitted mutations through response completion; freeze new mutation/launch admission
at commitment, drain already admitted work with bounds, excluding read/event long polls.
Cover actual launch functions (create/relaunch), local HTTP revive, watcher/resurrection
reattach and final runner generation fence. Stored running/pending records OR active/
pending runner work OR incomplete resurrection block; idle-looking TUIs still count.
No stop-all, no generic PTY preservation promise. Flush/await owned store/pump writes
as needed. Reopen admission only on proven-safe pre-handoff failure/helper exit.

Start eligibility: local `--allow-updates`, POSIX, real canonical copied CLI, default
data directory, unsupervised single bridge HOME declaration; Solo/dev/direct-package/
Windows/custom paths manual. Normal starts/setup respect reservation before mutations.
Normalize descriptor from current trusted runtime, never original secret argv. Private
restart context is parsed before onboarding, must match existing identity, disallows
token/bootstrap/new pairing fallback and altered/alternate pointer/port ownership.
Replacement `reportUpdateReady` only after auth/security, required transport, pointer
and resurrection. No timer/log alone equals readiness. Reuse existing shutdown and
close security before exit; helper waits for exit before setup. Add all new shipped
modules to installation inventory. Preserve ordinary non-update behavior.

Acceptance: unit/static tests of target/permission rejection, status control flag,
busy/racing create/revive/reattach, idempotency, revoked principal after stage, audit/
seal/publication failure and order, no effects on invalid/error replies, bounded
drains and cancellation, readiness after resurrection and no onboarding fallback.
Use dependency-injected fakes for coordinator tests; actual runtime smoke is root-only.
Run focused bridge unit tests and no-emit compile (`node_modules/.bin/tsc --noEmit`)
after P1 exports exist. Do not run full `npm run build` while P1 may need dist; root
serializes generated outputs. Handoff changed files, checks, root smoke steps and
known limitations, release all file leases. Final integration owner site_integration.

## R2 — encrypted command, audit and transport integration

Tier 1, `gpt-6.1-terra`, `xhigh`, `/root/site_capture`, following its completed U1
handoff. R1 explicitly released the exact R2 files without edits. Ownership JSON is
authoritative; no R1 start/index/setup/coordinator/session edits by R2.

Outcome: wire both update commands into current policy/command handling and provide
trusted two-signal update tickets over BOTH encrypted local HTTP and cloud transport.
Keep existing encrypted behavior identical when optional observer is absent.

Frozen boundary: root-owned `security/bridge/execution-observer.ts` exports
`SecureExecutionObserver` (`admitted`, `sealed`, `delivered`, `failed`). R1's existing
`UpdateAdmission` and `UpdateResponseTicket` in update-admission.ts are read-only.
R2 implements `UpdateEffects` in update-effects.ts with constructor
`new UpdateEffects(admission: UpdateAdmission)`, implementing SecureExecutionObserver,
plus `attachTicket(message: VerifiedApplication, ticket: UpdateResponseTicket): void`.
Bind to the actual admitted verified request (not just browser fields). Use current
semantic permission classification to hold an admission token for every mutating
command/HTTP operation, including consuming inbox reads. No read-only long-poll drain.

Extend `executeSecurePacket` with optional final observer after its existing optional
admission callback; observer.admitted after authenticated acceptance but BEFORE any
self-revocation/dispatch mutation. On original successful dispatch/audit, explicitly
await seal, then observer.sealed(message, data). Error-sealed/catch paths call failed,
never sealed-success. Existing self-revocation receipt path must release any admitted
token through transport completion/failure without accidentally authorizing an update.
Observer.sealed validates successful accepted command response before arming its
ticket. Actual request correlation and message identity must match. Business-failed
responses cannot arm tickets. A failing hook must fail safe without duplicate effects.

Extend LocalApiServer.setSecurity with optional fourth observer, and
CentrifugoClient.subscribeSecureCommands with optional third observer; each passes it
to executeSecurePacket. Local /api/security/envelope registers finish/close/error
before jsonResponse, uses delivered only on finish, failed on premature close/error.
Cloud uses delivered only after awaited client.publish resolves, failed on rejection.
Release this request's mutation admission token BEFORE markDelivered schedules update;
failure cancels ticket and releases its token in a safe finalization path. Never await
the updater inside transport callbacks. Keep long-running admitted mutation tokens
until work has actually stopped; a timeout is not evidence that it stopped. Bound
pending update ticket acceptance so a lost response does not leave staging forever.

Extend CommandRpcDeps with `updates?: BridgeUpdateCoordinator` and
`updateEffects?: UpdateEffects`. get_bridge_update requires verified read, explicit
matching bridgeId, strict refresh boolean/no extra payload fields, calls snapshot.
update_bridge requires verified control, exact payload fields, calls request. On new
ticket call updateEffects.attachTicket before returning accepted response. If either
dependency is unavailable, fail safely; never create an executable orphan ticket.
Add command names to bridge type union and semantic permission sets (read/control).
Map BridgeUpdateError to safe data.code; wrong target ignored/refused as current
targeted pattern requires. No plaintext permission bypass/HTTP updater. Do not relax
existing browser token boundaries. R1 owns actual coordinator construction and these
dependency injections in index.ts, and calls both APIs with this observer.

Also export `CentrifugoClient.waitUntilSecureCommandsReady(timeoutMs: number):
Promise<void>`. It resolves only for the current connected client AND subscribed
secure commands channel, with bounded wait; timeout/disconnect rejects. Clear stale
readiness on disconnect/unsubscribe so an old subscription cannot satisfy it. R1
calls this for cloud replacement after resurrection before private ready ACK; local
mode skips it. No fixed startup sleep counts as transport readiness.

Acceptance: scoped unit tests for policy read/control, strict payload/target,
actual handler request->ticket; audit and seal ordering including async seal reject,
HTTP finish vs close/error, publication success/rejection, failed business response,
same ticket called once, admission drain waits for actual mutation and excludes reads,
release-before-start ordering. Real policy denied update tested without fake allowall.
Run scoped bridge unit/static tests only; no E2E/runtime/browser/server/DB/Git/install.
Handoff `docs/investigations/bridge-updates-transport-handoff.md` includes changed files,
check commands/results and leases released. Escalate shared contract changes to root.

## Common implementation and handoff requirements

No placeholders, skipped assertions, broadened retry loops, fake success paths or
test-only unsafe registry/env overrides in production. Use dependency injection
for bounded unit fixtures. Every user-visible success must follow the corresponding
real state change. Do not expose secrets in logs/artifacts. Keep public errors
sanitized and finite. Resource timeouts are finite; cleanup affects task-owned
resources only. Unit/static tests may run in assigned scope; all test servers,
process-level restart smokes and browser E2E are root-executed after writers stop.
Handoff lists exact changed files, test commands/results, concrete review findings,
manual/root smoke instructions and released leases. Stop writing after handoff.

## V1 — independent review

Tier 2, `gpt-6.1-sol`, `max`, `/root/site_review`. Read-only review of the bounded
update feature against frozen contracts and worker handoffs; sole writable output
`docs/investigations/bridge-updates-review.md`. P1/R1/U1 have released source leases;
R2 may still be finishing transport tests, so begin with helper/release/coordinator/
startup/UI and defer final R2 judgment until its handoff. No edits, Git, installs,
tests, runtime, E2E, browser, servers, DB or subdelegation. Root executes verification.

Review security and actual lifecycle first: source-controlled fixed npm target and
integrity/native/protocol validation, sanitized child environment, reservations and
unknown PID/helper ownership, prepared/commit/old-exit ordering, post-commit failures,
no pairing/identity change, real readiness, complete admission/drain coverage,
revocation after awaits, plaintext bypass, UUID concurrency/receipt behavior. Inspect
P1's two disclosed limitations (bounded child close after kill; stale short-lived
reservation guard) and report material operational impact, not speculative redesign.
Then UI stale capabilities/operation reconciliation, build identity immutability,
mobile keyboard/focus behavior and truthfulness; root will perform rendered review.
Tests must exercise failures/races, not just restate implementation. Identify missing
concrete runtime cases for root. Return prioritized blockers with exact files/lines,
cause, reproduction/test expectation and minimal repair scope. No broad architecture
expansion. Review closure uses the same reviewer after per-owner fixes. Final handoff
states reviewed revision/diff scope, unresolved findings and report lease release.

## R1 bounded repair and real installed-runtime smoke

Same R1 Terra/xhigh owner, only `bridge/src/bridge-update.ts`, its test, its handoff,
and new `bridge/scripts/bridge-update-real-smoke.mjs`. No other source writes. First
handle P1's `update_process_uncertain` tag exactly like unproven helper termination:
explicitly freeze admission even if staging had not reached freeze, keep stage and
reservation and truthful uncertain status. Never discard or reopen; test this case.

Author (do not execute) one root-run smoke for actual package staging and installed
runtime replacement, complementing P1's synthetic IPC/failure smoke. All inputs live
under one new canonical temporary HOME/work directory. Create a fixture copy of the
current built package/assets with canonical package name ftown, protocol1 and exactly
one higher patch version, then pack locally with scripts disabled (dist is already
built). No registry publication, real credentials, test DB, global HOME changes or
production test overrides. Use `createUpdateReleaseApi`'s existing function dependency
injection to supply only that fixture's validated metadata/tarball bytes; keep its
real npm execution/native checks. Dependencies may install from the fixed registry
under root execution; no fake native-load success. Root runs on isolated Linux.

Install the current real package into scratch HOME using existing setup, and run an
old controller that imports the canonical installed runBridge and starts a real
empty local bridge in the same process. Poll bounded real `ftown harness status`/
authenticated local command until callable; obtain actual bridge/owner/endpoint/
port from the owned local identity. Use actual reservation/receipt/prepareHandoff
APIs with the staged real candidate and matching descriptor, commit, then signal the
old process's real graceful SIGTERM shutdown. The helper must run real setup and
launch the real replacement, whose normal private ready signal verifies identity.
This tests the programmatic handoff boundary, not a mocked browser update success.

Assert real npm/native staging succeeds, old process exited before replacement,
receipt succeeded at target version, same bridge/owner/endpoint/local port persisted,
and actual installed replacement `ftown harness status` is callable. Do not treat a
log/timer as success. Bound every subprocess and capture private logs without secrets;
on failure print safe phase/evidence. Track exact task-owned PIDs; stop replacement
and helper if still owned, prove exits before deleting scratch HOME. No tmux server
kill, broad process kill or production access. Distinguish this controlled fixture
release from a published upgrade in the handoff. Root alone executes the script.
If a required seam cannot work without application change, report the exact issue
instead of introducing an unsafe env flag or bypass. No need to cover every failure
again: synthetic smoke and units own failure cases; this one proves the real staged
package/setup/installed bridge path. Provide exact root command and release leases.

## E2E fixture repair — P1 integration owner

Tier 1, `gpt-6.1-terra`, `xhigh`, `/root/site_integration`. Shared checkout
`/Users/fkesheh/projects/ftown-bridge-updates`; others share this checkout: never
revert others or edit outside ownership. Only writable files are
`e2e/tests/bridge-updates.spec.ts` and
`docs/investigations/bridge-updates-package-handoff.md`. No prerequisite writers
remain on these files. Root retains all runtime/E2E/DB/ports/Boat/Git leases.

Root's actual desktop and mobile failures show two bridges, with only one encrypted
connection approved. The first row is the unapproved bridge (Unknown); the second
shows v0.19.58. `login(sharedEmail())` approves only the default pointer bridge.
Use the existing `readBridgePointer` helper and exact `data-bridge-row` ID for that
approved bridge, matching established session fixture semantics. Preserve real RPC,
installed-version assertion, no-opt-in disabled mutation assertion, screenshots,
44px hit target, Escape/focus, and overflow assertions. Do not pair all bridges or
relax encryption, assertions, timeouts, or retries. Add an assertion that no app
update banner appears for the unchanged served production build before the explicitly
mocked app-update test, if stable under the existing hook initialization contract.
Read-only references: `e2e/helpers/app.ts`, existing bridge pointer helper,
`ui/src/hooks/useBridgeUpdates.ts`. No application changes expected.

Run only E2E TypeScript static check (no Playwright/browser/server/runtime). Report
changed files, exact command/result, and release both leases. Root repeats only the
focused bridge-updates browser file and visual review. Escalate any contract change.

## R1 rendered manual-command repair

Tier 1 `gpt-6.1-terra` / `xhigh`, `/root/update_runtime`; shared checkout unchanged.
Only writable `bridge/src/bridge-update.ts`, `bridge/src/bridge-update.test.ts`,
`e2e/tests/bridge-updates.spec.ts`, and runtime handoff. P1 explicitly released E2E
spec. All others share checkout; no reverts/out-of-scope writes or Git.

Root rendered desktop/mobile checks passed but showed installed0.19.58, latest0.19.57,
Up to date, manual npx ftown@0.19.57 setup. Avoid recommending a downgrade. Frozen
wire shape/grammar unchanged: snapshot.manualCommand selects latest version only
when latest is strictly newer; otherwise selects the canonical installed version,
including absent registry result. Do not alter target authorization/update admission
or recovery lifecycle. Unit cases: newer, equal, installed-ahead, registry unavailable;
assert exact manual command and unchanged availability/canUpdate semantics. E2E
assert command version matches installed when latest is <= installed, with exact
strict semantic comparison (or expected package fixture version and observed latest).
Keep real status, all existing browser assertions and screenshots.

Worker runs scoped coordinator tests and bridge/E2E no-emit checks only. Root executes
E2E, build/full suite and screenshot refresh after handoff. Escalate interface changes.
Handoff exact changes/results and release all leases; no runtime/browser/DB/installs.

## V1 final verification closure

Same Tier2 Sol/max reviewer and report-only ownership. Review released R1 manual
command selection and four-way unit/displayed E2E assertions, plus readiness AST
harness repair (actual async completion, original assertions retained, paused/failed
ACK cases). All prior implementation conclusions remain accepted; no broad review
repeat. Root owns current fresh build/bridge/package/focused E2E gates. No tests,
runtime, E2E, Git or application writes; handoff concise conclusion and release.

## L1 — final integration and PR

Tier1 `gpt-6.1-terra` / `xhigh`, `/root/site_integration`, designated single Git
owner in shared checkout `/Users/fkesheh/projects/ftown-bridge-updates`, branch
`feat/bridge-update-flow`. All source writers/reviewer released leases; root passed
final checks recorded in `bridge-updates-validation.md`. No application changes
expected. Worker may write only its package handoff and ownership coordination JSON
for final landing status. Root will finish cleanup notes before dispatch.

Exclusive resources: Git index/history/fetch/push/PR in this checkout. Others share
repository; preserve dirty original `ftown` and `ftown-simplify-all` worktrees and
all existing stashes. Do not reset/stash/clean/checkout those, delete other branches,
merge PR, publish packages, trigger CI reruns, start runtime/E2E or install deps.

Fetch current origin/main and compare with known ce62d9d3c118528df70b9e49aceea4aaf1e28819
(root GitHub API verified unchanged shortly before dispatch). If main changed in
conflicting relevant files/version, report rather than silently rebasing verified
source. Confirm bridge package/lock agree0.19.58, exceeds main and fixed release
origins/protocol remain as reviewed. Check all task files/diff for whitespace,
accidental secrets, generated runtime artifacts and unrelated edits; stage exact
task paths. The common-Git agent-receipts evidence is private and must not be
staged. Use existing repo PR template if present, scale body appropriately.

Commit completed task changes, push branch, open PR to main (do not merge). Draft
body available at `/Users/fkesheh/projects/ftown/.git/agent-receipts/bridge-updates-pr-body.md`;
use --body-file preserving newlines, update exact final counts/results from
validation. Title: Add bridge update checks and opt-in assisted upgrades.
Record commit/PR link, git status, checks and release Git/file leases in handoff.
Ensure any final coordination updates are included without needless source changes.
Report auto CI status read-only if available; root alone may troubleshoot/rerun.
Do not send FTown attention or associate PR: root owns that single user notice.
