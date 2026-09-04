/**
 * ftown Solo — frozen contract v2 for the single-port LAN deployment mode.
 * REVISION 2 — gauntlet round 1 findings applied (see SOLO_CONTRACT_REVISION).
 *
 * PRODUCT DEFINITION (do not renegotiate in module code):
 * `ftown-bridge --solo` binds ONE HTTP port on the LAN and serves:
 *   - /api/solo/*  → solo bootstrap/token endpoints (bridge-owned)
 *   - /api/*       → the existing local API (unchanged)
 *   - /healthz     → liveness of front + hub + panel
 *   - /hub/*       → managed Centrifugo child, proxied, WS UPGRADES ONLY
 *   - anything else → the panel: a managed Next.js STANDALONE child process
 *
 * The panel is NOT a static export: the ui app is output:'standalone' with an
 * auth()-gated server page, so static export is impossible without re-
 * architecting it. Solo instead fetches the published standalone bundle,
 * spawns it on a private port like the hub, and the front reverse-proxies
 * everything not bridge-owned to it. UI auth is dual-mode: hosted builds use
 * NextAuth; solo builds authenticate with the access key against /api/solo/*.
 *
 * No external account service, no docker, no second public port. A tunnel
 * provider may point at this SAME port; nothing may assume loopback-only
 * access. This file is TYPES + CONSTANTS + TABLES ONLY — no logic. Every
 * cross-module value must appear here; a name absent from this file does not
 * exist.
 */

/** Contract revision — bump on any material change (re-gauntlet required). */
export const SOLO_CONTRACT_REVISION = 5;

// ---------- Ports ----------

/** Default public LAN port (--port overrides). Children NEVER use fixed
 * ports: hub and panel bind 127.0.0.1:0 (OS-assigned ephemeral), eliminating
 * child port collisions entirely. */
export const DEFAULT_SOLO_PORT = 8040;

// ---------- Health probes (pinned) ----------
//
// hub:   GET http://127.0.0.1:<hubPort>/health    (native centrifugo endpoint)
// panel: HEAD http://127.0.0.1:<panelPort>/        (any status <500 = up)
// Poll interval 5s, probe timeout 1s; 'up' requires one success, 'down' after
// one failure following a prior success or after grace period (10s) at boot.

// ---------- Lifecycle (integrator, frozen) ----------
//
// L1. Boot: parse args → rotate-key short-circuit (S11) → create SoloConfig
//     (children get port 0) → front.listen(port) → print URLs/banner → async
//     ensure(hub) + ensure(panel).
// L2. Shutdown (SIGINT/SIGTERM identical): front.stopListening() (stop accept,
//     destroy open WS upgrades after 5s grace) → panel.kill() → hub.kill()
//     (children get SIGTERM then SIGKILL after 3s) → flush config files.
//     Orphaned children must be detectable+reaped on next boot (stale pidfile
//     under dataDir/solo/ checked before spawn).
// L3. EADDRINUSE on the front port: fail fast with a clear error naming the
//     port. Never auto-retry, never pick another port silently.
// L4. --rotate-key alone: regenerate key, persist hash (0600), print new
//     banner, exit 0 WITHOUT starting any listener. With --solo: rotate, then
//     continue normal boot. Bundles/dataDir untouched either way.

// ---------- Identity & crypto constants ----------

/** Access key entropy: 32 random bytes, hex-encoded (64 chars). */
export const ACCESS_KEY_BYTES = 32;

/** Hub JWT time-to-live, seconds. Refresh via POST /api/solo/token. */
export const HUB_JWT_TTL_SECONDS = 12 * 60 * 60;

/** Fixed solo subject. Solo mode is single-user by definition. */
export const SOLO_USER_ID = 'solo';

/**
 * Audience claim REQUIRED in every hub JWT and configured as token_audience
 * in the hub config. Minting without aud, or configuring a different value,
 * makes every WS handshake fail with an audience mismatch.
 */
export const HUB_JWT_AUDIENCE = 'ftown:centrifugo';

/** Centrifugo release to download (pinned; checksums embedded below). */
export const CENTRIFUGO_VERSION = 'v5.4.9';

/**
 * Embedded sha256 digests for the pinned centrifugo release assets, sourced
 * from the release's official checksums.txt at prep time (never fetched at
 * install time). Keyed by platform triple derived from process.platform/arch:
 * darwin-arm64, darwin-amd64, linux-amd64, linux-arm64.
 */
export const CENTRIFUGO_SHA256: Readonly<Record<string, string>> = {
  'darwin-arm64': 'b0bef645acffe29ae9eb07fd98e93ac14d9c1cdd26b568b6cf9b8f20c6f653f4',
  'darwin-amd64': 'ab221e476f8e9abd69f9943c2d3e7fefc232b90c5c23ccff60b89cae82f3fd50',
  'linux-amd64': '75d2fac2dcea005bb3cb1b4636b3825d98c97709c94d10755c892dbe1c9956c2',
  'linux-arm64': 'ba6df455ee0064399dd13652575fbbefa3d00bbe647d0555cb3669c1060821e5',
};

/**
 * Frozen top-level channel-option DEFAULTS — copied byte-for-byte from the
 * production hub config's top-level keys (centrifugo/config.json, the same
 * keys namespaces without their own override inherit). Several HUB_NAMESPACES
 * entries below (terminal-input, commands, events lacking force_recovery/
 * allow_history_for_subscriber, bridges lacking history_size/ttl/
 * force_recovery) rely on these top-level defaults for presence/join_leave/
 * history/recovery behavior — omitting them means those namespaces silently
 * fall back to Centrifugo's OWN stricter defaults instead of production's.
 * Deliberately excludes non-channel-option top-level keys (token secrets,
 * api/admin/address/port/allowed_origins, log/proxy settings) and the two
 * top-level publish/subscribe defaults (`allow_publish_for_subscriber:
 * false`, `allow_subscribe_for_client: false`) that every HUB_NAMESPACES
 * entry already overrides to true, so their top-level value never applies.
 */
export const HUB_CHANNEL_DEFAULTS: Readonly<Record<string, unknown>> = {
  allow_history_for_subscriber: true,
  presence: true,
  join_leave: true,
  force_push_join_leave: true,
  allow_presence_for_subscriber: true,
  history_size: 500,
  history_ttl: '24h',
  force_recovery: true,
};

/**
 * Frozen Centrifugo `namespaces` block for the managed hub — copied
 * byte-for-byte (names + options) from the production hub config at
 * centrifugo/config.json, which targets the SAME pinned CENTRIFUGO_VERSION
 * (v5.4.9), so no key-format translation was needed. Every namespace prefix
 * used by a real channel (bridges:presence#solo, commands:rpc#solo,
 * loops:updates#solo, sessions:*, terminal:*, terminal-input:*, events:*)
 * MUST have a matching entry here or Centrifugo rejects the subscribe with
 * code 102 "unknown channel" — this list existing at all is the fix for that
 * bug; hub-manager.test.ts drift-guards it against centrifugo/config.json so
 * the two can never silently diverge again.
 */
export const HUB_NAMESPACES: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  {
    name: 'terminal',
    allow_publish_for_subscriber: true,
    allow_subscribe_for_client: true,
    allow_user_limited_channels: true,
    allow_history_for_subscriber: true,
    history_size: 10000,
    history_ttl: '24h',
    force_recovery: true,
    allow_publish_for_client: true,
  },
  {
    name: 'sessions',
    allow_publish_for_subscriber: true,
    allow_subscribe_for_client: true,
    allow_user_limited_channels: true,
    history_size: 0,
    history_ttl: '0s',
    force_recovery: false,
    allow_publish_for_client: true,
  },
  {
    name: 'loops',
    allow_publish_for_subscriber: true,
    allow_subscribe_for_client: true,
    allow_user_limited_channels: true,
    history_size: 0,
    history_ttl: '0s',
    force_recovery: false,
    allow_publish_for_client: true,
  },
  {
    name: 'terminal-input',
    allow_publish_for_subscriber: true,
    allow_subscribe_for_client: true,
    allow_user_limited_channels: true,
    allow_publish_for_client: true,
  },
  {
    name: 'events',
    allow_publish_for_subscriber: true,
    allow_subscribe_for_client: true,
    allow_user_limited_channels: true,
    history_size: 100,
    history_ttl: '1h',
    allow_publish_for_client: true,
  },
  {
    name: 'commands',
    allow_publish_for_subscriber: true,
    allow_subscribe_for_client: true,
    allow_user_limited_channels: true,
    allow_publish_for_client: true,
  },
  {
    name: 'bridges',
    allow_publish_for_subscriber: true,
    allow_subscribe_for_client: true,
    allow_user_limited_channels: true,
    presence: true,
    join_leave: true,
    force_push_join_leave: true,
    allow_presence_for_subscriber: true,
    allow_publish_for_client: true,
  },
];

/**
 * Panel (UI standalone) bundle source. Published as a GitHub release asset of
 * THIS repository named `ftown-ui-standalone-<version>.tar.gz`, where version
 * matches the ui package version. Integrity: the release workflow publishes a
 * `<asset>.sha256` sidecar fetched over HTTPS from the same release — TLS to
 * github.com is the trust root for first-party artifacts (third-party
 * centrifugo gets EMBEDDED digests above instead).
 */
export const PANEL_BUNDLE_URL_TEMPLATE =
  'https://github.com/fmktech/ftown/releases/download/ui-v<version>/ftown-ui-standalone-<version>.tar.gz';

// ---------- Config ----------

export interface SoloConfig {
  /** Public LAN port for the solo front (the ONLY public port). */
  port: number;
  /** Private hub port — centrifugo binds 127.0.0.1 only. */
  hubPort: number;
  /** Private panel port — next standalone binds 127.0.0.1 only. */
  panelPort: number;
  /** Bridge data dir (~/.ftown/data). Secrets/bundles cached under here. */
  dataDir: string;
  /** sha256 hex of the raw access key. Raw key is never persisted. */
  accessKeyHash: string;
  /** HMAC-SHA256 secret signing Centrifugo connection JWTs. */
  hubSecret: string;
}

// ---------- Wire shapes ----------

/**
 * GET /api/solo/bootstrap — everything the panel needs to connect.
 * Auth: Authorization: Bearer <access-key>.
 */
export interface SoloBootstrap {
  userId: typeof SOLO_USER_ID;
  /**
   * Absolute websocket URL of the proxied hub, e.g.
   * ws://192.168.1.10:53698/hub/connection/websocket
   * Scheme derivation: wss:// ONLY when X-Forwarded-Proto is https AND the
   * socket peer address is loopback (a locally-running tunnel sets both);
   * otherwise ws://. Host comes from the request Host header verbatim.
   */
  centrifugoUrl: string;
  /** Fresh hub JWT (same as POST /api/solo/token returns). */
  token: string;
}

/** POST /api/solo/token — mint a fresh hub JWT. Body: empty. */
export interface SoloTokenResponse {
  token: string;
  /** ISO timestamp — informational only; JWT exp remains source of truth. */
  expiresAt: string;
}

/** GET /healthz — UNAUTHENTICATED, liveness only, no secrets, no versions. */
export interface SoloHealth {
  ok: true;
  hub: 'up' | 'down';
  panel: 'up' | 'down';
}

// ---------- Endpoint & routing table ----------
//
// | Method | Path                          | Auth            | Body/Result        |
// |--------|-------------------------------|-----------------|--------------------|
// | GET    | /api/solo/bootstrap           | Bearer key      | SoloBootstrap      |
// | POST   | /api/solo/token               | Bearer key      | SoloTokenResponse  |
// | GET    | /healthz                      | none            | SoloHealth         |
// | GET    | /hub/connection/websocket     | upgrade ONLY    | proxied to hub     |
// | *      | /hub/* (anything else)        | rejected        | 404                |
// | *      | /api/* (all other)            | per local API   | existing bridge API|
// |        |   — SOLO GUARD SUB: see S18   |                 |                    |
// | *      | /* (everything else)          | none            | proxied to panel   |
// | *      | /* (everything else)          | none            | proxied to panel   |
//
// ROUTING PRECEDENCE (exact match first, then longest-prefix): solo endpoints
// → /hub allowlist → /api/* to the EXISTING local API handler (the front and
// local-api-server compose; the bridge API is never shadowed by the panel) →
// everything else to the panel child.
//
// Errors: {"error": string} with 401 (bad key), 429 (rate limited), 404, 502
// (private child down) — matching local-api-server conventions.
//
// Pre-panel placeholder: while the panel child is not yet healthy, GET /
// (and only /) is served by the FRONT itself as a minimal inline HTML page
// ("Starting ftown Solo…", auto-refresh meta tag). This is the only HTML the
// front ever generates.

// ---------- Hub config keys (written by hub-manager, frozen values) ----------
//
// token_hmac_secret_key   = hubSecret
// token_audience          = HUB_JWT_AUDIENCE
// allowed_origins         = []            // allow all — bearer+JWT gated; the
//                                         // panel is served from arbitrary
//                                         // LAN IPs/tunnel domains by design
// websocket_compression   = false         // proxy must not negotiate deflate
// client.allowed          = false         // no anonymous connections
// health                  = true
// ...HUB_CHANNEL_DEFAULTS = spread          // top-level presence/join_leave/
//                                         // history/force_recovery defaults
//                                         // several namespaces below rely on
//                                         // inheriting (production parity)
// namespaces              = HUB_NAMESPACES  // REQUIRED: every namespaced
//                                         // channel (bridges:presence#solo,
//                                         // commands:rpc#solo, loops:updates
//                                         // #solo, sessions:*, terminal:*,
//                                         // terminal-input:*, events:*) gets
//                                         // Centrifugo code 102 ("unknown
//                                         // channel") without this.
// allow_user_limited_channels = true      // needed for the `#solo` channel
//                                         // boundary suffix every client uses
// client_channel_limit           = 256    // matches production; solo opens
// client_queue_max_size          = 67108864  // enough concurrent namespaced
// client_stale_close_delay       = "30s"     // channels/queue depth that the
// websocket_message_size_limit   = 33554432  // panel's terminal streams need
// ping_interval = "10s", pong_timeout = "5s" // matches P5 below, explicit
//                                         // rather than relying on defaults
// Admin API, server API: disabled. Hub listens on 127.0.0.1:hubPort with its
// DEFAULT paths (/connection/websocket) — the proxy strips the /hub prefix,
// so no centrifugo path options are needed.

// ---------- Proxy rules (ws-proxy.ts, frozen) ----------
//
// P1. Only ^/hub/connection/websocket$ (after stripping the /hub prefix) is
//     forwarded; plain HTTP under /hub/* never reaches the hub (404 at front).
// P2. Target hardcoded to 127.0.0.1:<hubPort>. Never configurable.
// P3. Strip inbound hop-by-hop headers: connection, keep-alive, proxy-authenticate,
//     proxy-authorization, te, trailer, transfer-encoding, upgrade (re-set for
//     upgrades), sec-websocket-* (let the 'ws' upstream handshake recompute
//     Sec-WebSocket-Accept), permessage-deflate extension offer dropped.
// P4. Rewrite Host to 127.0.0.1:<hubPort>; set X-Forwarded-Proto from rule S-scheme.
// P5. Forward protocol-level ping/pong untouched (centrifugo ping 10s/pong 5s).

// ---------- Security invariants (implementation + tests enforce) ----------
//
// S1.  Access key comparison constant-time; raw key never persisted and never
//      written by the bridge to any file/log EXCEPT the one-time startup
//      banner (deliberate UX delivery; documented exception).
// S2.  /api/solo/* require Bearer key before any handler logic. /hub/* serves
//      upgrades only (P1). The panel child is unauthenticated BY THE FRONT —
//      the panel itself redirects to its /local key screen when bootstrap has
//      not run (dual-mode auth); this is accepted and covered by the UI brief.
// S3.  Rate limiting (solo-server-owned, NO XFF parsing in v1):
//        - key failures: >=10 failures/60s per source IP → 429 + Retry-After: 60
//        - global per-IP backstop on /api/solo/*: >240 req/min → 429
//      Source IP = socket peer address via an INJECTED peerAddress(req) seam
//      (default: socket.remoteAddress) so offline tests can simulate distinct
//      peers. 256-bit key space makes online guessing non-viable; per-IP is
//      acceptable behind tunnels (shared loopback source) because the UI
//      caches the key — self-lockout requires repeated genuine auth failures.
// S4.  Archive extraction rejects absolute entry paths, ".." segments, and
//      symlink/hardlink entries (zip-slip); extraction target must resolve
//      inside its dataDir subdirectory (realpath containment).
// S5.  See proxy rules P1-P5 (hardcoded target, header policy, prefix allowlist).
// S6.  Centrifugo downloads verified against CENTRIFUGO_SHA256 (embedded).
//      Panel bundle verified against its published .sha256 sidecar over HTTPS.
//      Digest mismatch aborts install with a clear error; nothing executes.
// S7.  accessKeyHash + hubSecret persist 0600 under dataDir.
// S8.  No cookies for solo auth anywhere (Bearer + fragment only) → CSRF-immune.
//      The panel build must not mount SessionProvider (see UI module brief).
// S9.  Plain HTTP on LAN is an accepted residual risk: a passive LAN observer
//      captures the Bearer key from any authenticated call, and an active MITM
//      additionally controls the unauthenticated panel HTML (key harvesting) —
//      this MUST be stated prominently in the solo README. Tunnel providers
//      terminate TLS. Front logs one console warning when binding a
//      non-loopback interface.
// S10. Hub JWTs: alg fixed HS256, claims sub=SOLO_USER_ID, aud=HUB_JWT_AUDIENCE,
//      iat, exp. Nothing parses or accepts other algorithms/claims shapes.
// S11. Key rotation is OUT OF HTTP SCOPE in v1: `ftown-bridge --solo --rotate-key`
//      regenerates offline (new banner print). No rotation endpoint exists.
// S12. Boot sequence (frozen): front LISTENS FIRST → prints URLs immediately →
//      async ensure(hub binary→config→spawn→health) and ensure(panel bundle→
//      spawn→health). /healthz reflects live state; pre-panel GET / gets the
//      placeholder page. URLs never depend on children being ready.
// S13. Inbound X-Forwarded-* are consumed only for scheme derivation (loopback
//      peer required) and never relayed to children except that single field.
// S14. Every /api/solo/* response sets Cache-Control: no-store (live 12h JWTs
//      in bodies). The pre-panel placeholder page is BYTE-STATIC — zero
//      request-derived bytes — and also no-store. Panel-proxy responses that
//      arrive without cache headers get a no-store passthrough guard.
// S15. No secret (raw key, accessKeyHash, hubSecret, JWT) ever appears in any
//      process argv or environment variable: hubSecret reaches centrifugo
//      EXCLUSIVELY via its 0600 config file path; children get only -c <path>.
// S16. The front and all managers never log: Authorization headers, presented
//      keys, JWTs, or /hub request URLs including query strings.
// S17. Extraction hardening beyond S4: only regular-file and directory entries
//      are extracted (explicit type allowlist); per-entry uncompressed cap,
//      total uncompressed cap, and entry-count cap abort the install on
//      exceed (decompression-bomb defense).
// S18. SOLO VS HOSTED API GUARDS: in solo mode the local API's loopback-Host
//      guard is substituted by the injected peerAddress seam (any source is
//      fine — Bearer is mandatory) and its Origin check is DROPPED (Bearer-
//      only, no cookies → CSRF-immune). Hosted mode keeps both guards
//      byte-for-byte unchanged. Constant-time Bearer verification is
//      mandatory in both modes.
// S19. centrifugoUrl host derivation validates the request Host against the
//      socket's local address:port (injectable allowlist seam for tunnels);
//      absolute-form request lines are rejected 400. Host reflection into the
//      bootstrap body must not be steerable by a third party.
// S20. Routing and ws-prefix stripping consume ONE parsed representation of
//      req.url; golden tests pin //hub, percent-encoded slashes, case
//      variation, trailing segments, and unicode against the allowlist.
// S21. PANEL_SOLO build-surface minimization: the solo panel build contains NO
//      mutating server endpoints (route handlers/server actions) and performs
//      no request-derived outbound fetches; the build asserts absence of
//      middleware and /api/auth artifacts from the standalone output. Next.js
//      stays current on security patches — post-tunnel this surface faces the
//      internet directly.

// ---------- Module ownership (disjoint files; integrator touches index.ts) --
//
// solo/solo-auth.ts(+test)   — key gen/hash/constant-time verify (S1);
//                              hub JWT mint/verify (S10)
// solo/hub-manager.ts(+test) — binary ensure (S6), config write (frozen keys),
//                              spawn/health/stop lifecycle
// solo/panel-manager.ts(+test)— bundle fetch/verify/extract (S4,S6), standalone
//                              spawn/health/stop lifecycle
// solo/ws-proxy.ts(+test)    — P1-P5 HTTP + upgrade proxying
// solo/solo-server.ts(+test) — front server: routing table, auth gate (S2,S3),
//                              scheme derivation, placeholder page (S12),
//                              composition of the three managers + proxy
// ui/src/lib/auth-mode.tsx   — dual-mode auth context (NextAuth | solo key):
//                              signInState, signOut, tokenRefresher callbacks
// ui/src/hooks/useCentrifugo.ts — EXTEND (owned file this build): optional
//                              tokenRefresher param replacing hardcoded
//                              /api/auth/token; onUnauthorized callback
//                              replacing '/login' redirect
// ui/src/app/local/page.tsx (+ ui/src/components/local/*) — #k fragment
//                              capture → localStorage, bootstrap call, states:
//                              no-key form / bad-key / starting(healthz poll) /
//                              ready(renders Dashboard) 
// ui/src/components/DashboardClient.tsx — EXTEND: signOut via auth-mode ctx;
//                              providers.tsx — conditional SessionProvider
// ui solo build flag        — PANEL_SOLO=1 at build time: root app/page.tsx
//                              becomes a redirect to /local (marketing landing
//                              and middleware are hosted-only); NextAuth pages
//                              (/login etc.) excluded from the solo build; nav
//                              links to /dashboard|/devices hidden in solo mode
//                              (their hosted APIs are unreachable through the
//                              proxy — accepted, documented in the UI brief)
// integrator (index.ts)      — --solo/--port/--rotate-key flags, lifecycle L1-L4,
//                              console URL banner (S1 exception)
