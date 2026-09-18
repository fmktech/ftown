# Local browser approval and management — implementation contract

## Module map / API style inventory
Existing LocalApiServer binds ephemeral 127.0.0.1, validates Host and bearer admin token,
uses plural /api/sessions resources, UUID IDs, camelCase properties, raw named envelopes
({sessions}, {session}), {error: string} HTTP errors, no version prefix. Existing command-rpc
uses Command {type,payload,requestId}, CommandResponse {requestId,success,data?,error?};
session/loop controllers own all mutations. Existing direct loopback terminal uses port/nonce.
UI Dashboard/hooks consume subscription-style events and command responses.

New browser API uses /api/browser/*, existing envelopes with additive error code/requestId.
Local admin routes (no Origin + existing process admin bearer) open a 2 minute pairing window
and approve/revoke; browser routes require exact allowed Origin and per-device bearer tokens.
Unpaired request/poll is the sole public exception during a CLI-opened window. No wildcard CORS.
Credentials are bound to exact Origin and bridge. Persist only hashes for remembered devices;
session devices stay memory-only. UI credentials go only to 127.0.0.1, never Vercel APIs.

## Frozen API and module seam
Parent owns LocalApiServer wiring, index.ts and loopback-server auth wiring.
Backend module: bridge/src/browser-access.ts exports class BrowserAccess.
Constructor opts: { dataDir: string; allowedOrigins: string[]; bootstrap: () => BrowserBootstrap;
 execute: (command: Command) => Promise<CommandResponse>; onRevoke?: () => void }.
Export BrowserBootstrap = { version: 1; userId: string; bridgeId: string; hostname: string;
 localPort: number; localNonce: string } (module overrides localNonce with presented browser token).
Methods:
- handle(req: IncomingMessage, res: ServerResponse, admin: boolean): Promise<void>
  handles ONLY /api/browser/* (parent enforces loopback Host; admin=true ONLY valid existing
  admin bearer with absent Origin). Module owns browser CORS/preflight, parsing and route auth.
- authorize(token: string, origin: string): boolean (used for terminal websocket auth)
- publish(channel: string, data: unknown): void (bounded local event history, live publication)
- close(): void (cancel timers/longpoll, clear ephemeral pairing state).
Backend owns browser-access.ts and browser-access.test.ts only. New local-pair-cli.ts owned
by parent, uses endpoints below; no other backend files owned by backend worker.

Admin operations, all require admin=true, never browser-accessible:
POST /api/browser/window {} -> { expiresAt: ISO }; replaces pending window.
GET /api/browser/pairings -> { pairings: [{id,code,origin,remember,expiresAt}] }; max 5 pending.
POST /api/browser/pairings/:id/decision {approve:boolean} -> {ok:true}; repeat same decision safe.
GET /api/browser/devices -> {devices:[{id,origin,createdAt}]}; cap 100 remembered devices.
DELETE /api/browser/devices/:id -> {ok:true}; idempotent, invokes onRevoke.

Browser operations require exact allowlisted Origin; OPTIONS permits only GET,POST,DELETE
and Authorization,Content-Type; no cookies; private-network preflight supported when requested.
POST /api/browser/pairings {remember:boolean} -> 201 {id,code,pollToken,expiresAt};
window must be active. Code random 6 digits, pollToken random 32 bytes, max 5 outstanding;
rate-limit unpaired requests 10/minute per origin; 2 minute expiry. No command access yet.
GET /api/browser/pairings/:id Authorization: Bearer pollToken ->
{status:'pending'|'denied'|'approved', credential?:string}; approved delivers random 32-byte
credential to this polling token only, repeat polls safe until expiry. Origin must match.
POST /api/browser/bootstrap {} bearer device credential -> BrowserBootstrap;
localNonce is that credential (terminal auth validates through authorize).
POST /api/browser/commands Command -> CommandResponse; validate shape, same bridge only;
requestId idempotency scoped device+id, duplicate same body shares result; different body 409.
Cache max 1000 results /10 min; do not evict pending operations. Overflow 429 before execution.
Never retry commands automatically across cloud/local routes after uncertain delivery.
GET /api/browser/events?cursor=N bearer credential ->
{cursor:number,reset:boolean,events:[{channel:string,data:unknown}]}; max256 events/2MiB history,
longpoll up to20s, reset=true when cursor fell behind. Per-device max2 pending polls.
Data is existing typed publication payload; generic unknown because multiple existing channel
contracts share this transport. Consumer refreshes authoritative session/loop snapshots on reset.
Errors use {error:string,code:string,requestId:string}, 400 invalid,401 unauthorized,
403 forbidden,404 not found,409 conflict/window closed,429 capped,503 not ready.
No new version machinery: additive fields ignored; incompatible semantics require new routes.

UI implementation: existing Dashboard is reused in /local without NextAuth. Entry points on
login and hosted dashboard link to /local. Ask for port printed by ftown-bridge pair; no scanning.
Use http://127.0.0.1:<validatedPort> only. Pairing polls, matching code, approval pending message,
remember-browser default true, session-only option, forget button. Store credential keyed port
and use only after authenticated bootstrap returns same bridge id. Restore on reload independent
of cloud. Local adapter exposes existing subscription/RPC semantics to shared hooks, backed by
commands HTTP and events longpoll. Presence is current local bootstrap bridge+local advert.
Use existing HybridTerminalTransport with loopback terminal. No fake cloud login/JWT.
Connection indicator must identify local mode accurately; do not probe Fly in local mode.
Existing cloud dashboard should offer a paired-local entry even while cloud presence is empty.
Full local management includes session list/create/remove/stop/retry/rename and loop commands
through existing Command types. Correct results/events must reach existing hooks.

## Ownership and sequencing
T1 Backend auth/API: browser-access.ts, browser-access.test.ts.
T2 UI: ui/src/lib/local-browser-client.ts, its tests; ui/src/app/local/page.tsx;
ui/src/components/LocalDashboard.tsx; UI wiring/hooks/type interfaces necessary to reuse Dashboard.
T3 Parent integration: bridge/src/index.ts, local-api-server.ts, centrifugo-client.ts,
direct-transport/loopback-server.ts, local-pair-cli.ts plus tests, docs.
T1/T2 needs shared contract (this document frozen); independent after freeze.
T1/T2 before T3 runtime smoke test. Graph acyclic. Disjoint ownership (T2 ui only,T1 exact files).
T4 independent non-author security review after implementation; read-only review task.

## Walkthrough / acceptance
CLI opens window -> UI requests pairing -> both show matching code -> CLI approval ->
UI polls credential -> bootstrap -> subscribe events -> list/create/remove -> terminal IO.
Reject/expiry/revocation disallow all access. Unrelated origins cannot pair, poll, or control.
Fly unreachable must not block local controller mutation completion or live updates.
Bridge --local starts without cloud onboarding (parent implementation), shares data/controllers.
Test actual HTTP pairing gate, one-shot consent, remembered reload/revocation, request dedup;
assembled smoke creates/removes a shell session while cloud is unavailable. No deployment.

## Integration verification

- Bridge suite: 796 tests pass; production TypeScript build passes.
- UI suite: 267 tests pass; production Next build, lint and types pass using
  dummy build-only authentication secrets (no production credentials needed).
- Assembled local integration uses real HTTP, WebSocket, approval, RPC,
  controllers, SessionStore and disconnected publication transport; only process
  execution is replaced by a runner fake. It covers session create/list/remove,
  event delivery, terminal input, revocation, subsequent new-browser reconnect,
  hostile origins/Host headers and local port reuse/fallback.
- Independent non-author backend and UI review completed. Fixed early local RPC
  timeout and bootstrap refresh after a bridge changes identity mode on restart.
- No live bridge restart, deployment or PWA caching is part of this validation.


## Cloud-authorized local access (additive follow-up)

The API style/envelopes and device model above remain unchanged. Cloud access
already grants the owner the bridge's per-process local nonce via signed
connection info in authenticated owner-only presence. That capability can also
create an origin-bound remembered browser device; unauthenticated local access
still requires explicit terminal approval.

Typed operation: POST /api/browser/cloud-devices,
request {bridgeId:string, credential:string} -> {credential:string}.
Authorization: exact allowed Origin AND bearer equal to this bridge's cloud
local nonce AND request bridgeId equal to its actual identity. Disabled in
--local and --solo. Credential is browser-generated random32-byte base64url,
persisted as a hash only. Identical credential + origin + bridge is idempotent;
conflicting binding409. Same error envelope: invalid400, invalid proof401,
origin/bridge403, conflicting binding409, device cap429, storage failure503.
No collection/pagination. Maximum100 devices bounds creation. Additive route;
existing pair/bootstrap/commands APIs unchanged.

Journey: authenticated cloud presence -> bounded loopback exchange -> verified
bootstrap -> remembered local device -> /local restores without approval or
cloud login. Snapshot/join hooks prepare it proactively; clicking This computer
awaits pending preparation. Failed remote-loopback attempts never affect cloud
use. Cloud nonce is never logged, persisted in browser storage, or put in a URL.

Follow-up verification: 798 bridge tests and 271 UI tests pass; both production
builds pass. Added proof/origin/identity/idempotency tests and browser handoff,
revocation, retry and remembered-access tests.
