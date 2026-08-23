/**
 * ftown Solo — solo-server: the single public front server.
 *
 * Composes the routing table from contract.ts (ROUTING PRECEDENCE):
 *   1. exact /api/solo/bootstrap | /api/solo/token | /healthz
 *   2. /hub/*  → WS upgrade proxy only (P1), everything else 404
 *   3. other /api/* AND unknown /api/solo/* → existing local API child,
 *      with the S18 mechanism applied before forwarding (Host is rewritten
 *      by ws-proxy; Origin is replaced here) so the hosted loopback-Host and
 *      Origin guards pass byte-for-byte with ZERO edits to hosted files
 *   4. everything else → panel child, or the byte-static placeholder page
 *      on GET / while the panel is not yet healthy (S12)
 *
 * Security invariants implemented here: S2 (auth gate before handlers),
 * S3 (rate limiting), S12 (placeholder while children start), S13 (no
 * X-Forwarded-* relay — enforced inside ws-proxy), S14 (no-store everywhere
 * incl. placeholder plus a passthrough guard for proxied responses arriving
 * without cache headers), S18 mechanism, S19 (host validation + absolute-form
 * rejection).
 */

import { randomInt } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  HUB_JWT_TTL_SECONDS,
  SOLO_USER_ID,
  type SoloBootstrap,
  type SoloConfig,
  type SoloHealth,
  type SoloTokenResponse,
} from './contract.js';
import { mintHubJwt, verifyAccessKey } from './solo-auth.js';
import { handleHubUpgrade, parseHubTarget, proxyHttpRequest } from './ws-proxy.js';

// ---------- Health sources ----------

/** Managers expose isHealthy(); the front polls them synchronously per request. */
export interface HubHealthSource {
  isHealthy(): boolean;
}

export interface PanelHealthSource {
  isHealthy(): boolean;
}

// ---------- Rate limiter (S3) ----------

export interface RateLimitDecision {
  limited: boolean;
  /** Jittered seconds for the Retry-After header (meaningful only when limited). */
  retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  /** Key-failure threshold within the window (>= triggers). Contract default 10. */
  keyFailureThreshold?: number;
  /** Per-peer request backstop threshold (> triggers). Contract default 240. */
  backstopThreshold?: number;
  /** Sliding-window size in ms for both counters. Default 60_000. */
  windowMs?: number;
  /** Base Retry-After seconds when limited. Default 60. */
  retryAfterBaseSeconds?: number;
  /** ± jitter applied to the Retry-After value. Default 5. */
  retryAfterJitterSeconds?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

/**
 * Sliding-window limiter owned by the front server:
 *   - key failures: >=10 failures/60s per peer → limited
 *   - backstop: >240 /api/solo/* requests/min per peer → limited
 * A successful auth resets that peer's failure count. NO XFF parsing in v1 —
 * peers come exclusively from the injected peerAddress seam (S3).
 */
export class RateLimiter {
  private readonly keyFailures = new Map<string, number[]>();
  private readonly backstopHits = new Map<string, number[]>();

  constructor(private readonly options: RateLimiterOptions = {}) {}

  private get windowMs(): number {
    return this.options.windowMs ?? 60_000;
  }

  /** Record one /api/solo/* request for `peer` and evaluate the backstop (>240/min). */
  hitBackstop(peer: string): RateLimitDecision {
    const now = (this.options.now ?? Date.now)();
    const hits = this.slide(this.backstopHits.get(peer) ?? [], now);
    hits.push(now);
    this.backstopHits.set(peer, hits);
    const threshold = this.options.backstopThreshold ?? 240;
    return this.decision(hits.length > threshold);
  }

  /** Record one failed auth for `peer` and evaluate the failure window (>=10/min). */
  recordKeyFailure(peer: string): RateLimitDecision {
    const now = (this.options.now ?? Date.now)();
    const failures = this.slide(this.keyFailures.get(peer) ?? [], now);
    failures.push(now);
    this.keyFailures.set(peer, failures);
    const threshold = this.options.keyFailureThreshold ?? 10;
    return this.decision(failures.length >= threshold);
  }

  /** Successful auth: the peer's failure count resets. Backstop is unaffected. */
  resetKeyFailures(peer: string): void {
    this.keyFailures.delete(peer);
  }

  private slide(stamps: number[], now: number): number[] {
    const cutoff = now - this.windowMs;
    let start = 0;
    while (start < stamps.length && stamps[start] <= cutoff) start++;
    return stamps.slice(start);
  }

  private decision(limited: boolean): RateLimitDecision {
    if (!limited) return { limited: false, retryAfterSeconds: 0 };
    const base = this.options.retryAfterBaseSeconds ?? 60;
    const jitter = this.options.retryAfterJitterSeconds ?? 5;
    const bounded = base < jitter ? 0 : jitter;
    const seconds = Math.max(1, base + randomInt(-bounded, bounded + 1));
    return { limited: true, retryAfterSeconds: seconds };
  }
}

// ---------- Placeholder page (S12/S14) ----------

/**
 * Byte-static pre-panel page. ZERO request-derived bytes (S14); the only HTML
 * the front ever generates. Auto-refreshes so the browser lands on the real
 * panel as soon as it becomes healthy behind '/'.
 */
export const PLACEHOLDER_HTML =
  '<!doctype html>\n' +
  '<html lang="en">\n' +
  '<head>\n' +
  '<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  '<meta http-equiv="refresh" content="2">\n' +
  '<title>ftown Solo</title>\n' +
  '<style>\n' +
  'html,body{margin:0;height:100%;background:#0b0e14;color:#c9d4e3;' +
  "font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}\n" +
  'body{display:flex;align-items:center;justify-content:center}\n' +
  '.card{text-align:center;padding:2rem 3rem;border:1px solid #1f2937;border-radius:12px;' +
  'background:#111827}\n' +
  '.dot{display:inline-block;width:10px;height:10px;margin-right:.6rem;border-radius:50%;' +
  'background:#38bdf8;animation:pulse 1.2s ease-in-out infinite}\n' +
  '@keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}\n' +
  '</style>\n' +
  '</head>\n' +
  '<body><main class="card"><p><span class="dot"></span>Starting ftown Solo\u2026</p></main></body>\n' +
  '</html>\n';

// ---------- Server options ----------

export interface SoloServerOptions {
  config: SoloConfig;
  /** Port of the EXISTING local API server (bridge API) on loopback. */
  localApiPort: number;
  hub: HubHealthSource;
  panel: PanelHealthSource;
  /** TTL override passed through to mintHubJwt. Defaults to HUB_JWT_TTL_SECONDS. */
  mintTtlSeconds?: number;
  /** Injectable limiter (tests). A fresh RateLimiter is created when omitted. */
  rateLimiter?: RateLimiter;
  /**
   * Source-IP seam (S3). Default: req.socket.remoteAddress. Tests inject this
   * to simulate distinct peers without sockets.
   */
  peerAddress?: (req: IncomingMessage) => string;
  /**
   * Acceptable Host headers for centrifugoUrl derivation (S19 tunnel seam).
   * When provided (non-empty), bootstrap host validation checks membership
   * here INSTEAD of the socket-local-address comparison.
   */
  allowedHosts?: readonly string[];
  /** Bind address override (tests bind 127.0.0.1 for strict S19 semantics). */
  host?: string;
}

export interface SoloServerHandle {
  port: number;
  close(): Promise<void>;
}

// ---------- Small helpers ----------

const NO_STORE = 'no-store';
const JSON_TYPE = 'application/json; charset=utf-8';
const HUB_WS_PATH = '/hub/connection/websocket';
const WILDCARD_ADDRESSES = new Set(['0.0.0.0', '::', '']);

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  // S14: every /api/solo/* response carries no-store — including errors.
  res.writeHead(status, { 'content-type': JSON_TYPE, 'cache-control': NO_STORE });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function send429(res: ServerResponse, retryAfterSeconds: number): void {
  res.writeHead(429, {
    'content-type': JSON_TYPE,
    'cache-control': NO_STORE,
    'retry-after': String(retryAfterSeconds),
  });
  res.end(JSON.stringify({ error: 'rate limited' }));
}

/** Loopback check used by scheme derivation (peer must be loopback for wss). */
function isLoopbackAddress(address: string): boolean {
  if (address === '::1' || address === 'localhost') return true;
  if (address.startsWith('::ffff:')) return isLoopbackAddress(address.slice('::ffff:'.length));
  return address.startsWith('127.');
}

/** Bearer extraction per RFC 6750 (case-insensitive scheme, single token). */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

interface SplitHost {
  hostname: string;
  port: number | null;
}

/** Split a Host header into lowercase hostname + numeric port (IPv6 aware). */
function splitHostHeader(hostHeader: string): SplitHost {
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close !== -1) {
      const hostname = trimmed.slice(0, close + 1).toLowerCase();
      const rest = trimmed.slice(close + 1);
      if (rest.startsWith(':')) {
        const port = Number.parseInt(rest.slice(1), 10);
        return { hostname, port: Number.isFinite(port) ? port : null };
      }
      return { hostname, port: null };
    }
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon !== -1) {
    const port = Number.parseInt(trimmed.slice(colon + 1), 10);
    if (Number.isFinite(port)) {
      return { hostname: trimmed.slice(0, colon).toLowerCase(), port };
    }
  }
  return { hostname: trimmed.toLowerCase(), port: null };
}

/**
 * S19: the reflected Host must be THIS server's local address:port (or a
 * member of the injected allowedHosts seam). Wildcard binds accept any
 * hostname whose port matches the bound port — tunnels/LAN deployments pass
 * allowedHosts to tighten further. Absolute-form request lines are rejected
 * by the router before this runs.
 */
function isAllowedHost(
  hostHeader: string,
  bound: { address: string; port: number },
  allowedHosts?: readonly string[],
): boolean {
  if (allowedHosts !== undefined && allowedHosts.length > 0) {
    return allowedHosts.includes(hostHeader);
  }
  const split = splitHostHeader(hostHeader);
  if (split.port !== bound.port) return false;
  if (WILDCARD_ADDRESSES.has(bound.address)) return true;
  const normalizedBound = bound.address.toLowerCase();
  if (split.hostname === normalizedBound) return true;
  if (isLoopbackAddress(normalizedBound)) {
    return (
      split.hostname === 'localhost' || split.hostname === '127.0.0.1' || split.hostname === '[::1]'
    );
  }
  return false;
}

function isWebSocketUpgrade(req: IncomingMessage): boolean {
  const upgrade = req.headers.upgrade;
  if (typeof upgrade !== 'string' || upgrade.toLowerCase() !== 'websocket') return false;
  const connection = req.headers.connection;
  return typeof connection === 'string' && connection.toLowerCase().includes('upgrade');
}

/**
 * S14 passthrough guard: patch res.writeHead so any proxied response that
 * arrives WITHOUT cache headers gets Cache-Control: no-store before it
 * reaches the client. Upstream-provided cache headers pass untouched.
 */
function applyNoStorePassthrough(res: ServerResponse): void {
  const original = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
  const wrapped = (...args: unknown[]): ServerResponse => {
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg !== null && typeof arg === 'object' && !Array.isArray(arg)) {
        const headers = arg as Record<string, unknown>;
        const hasCacheHeader = Object.keys(headers).some((name) => {
          const lower = name.toLowerCase();
          return lower === 'cache-control' || lower === 'expires' || lower === 'pragma';
        });
        if (!hasCacheHeader) headers['cache-control'] = NO_STORE;
        break;
      }
    }
    return original(...args);
  };
  res.writeHead = wrapped as unknown as typeof res.writeHead;
}

// ---------- createSoloServer ----------

export async function createSoloServer(options: SoloServerOptions): Promise<SoloServerHandle> {
  const { config, localApiPort } = options;
  const peerAddress =
    options.peerAddress ?? ((req: IncomingMessage) => req.socket.remoteAddress ?? 'unknown');
  const limiter = options.rateLimiter ?? new RateLimiter();

  const server = http.createServer((req, res) => {
    void routeRequest(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'internal error');
      else res.destroy();
    });
  });

  // WS upgrades: P1 allowlist only. Genuine upgrades never reach the request
  // handler in Node — they arrive here. Anything non-conforming is rejected
  // at the socket without ever touching the hub.
  server.on('upgrade', (req, socket, head) => {
    if (parseHubTarget(req.url ?? '').isHubUpgradePath && isWebSocketUpgrade(req)) {
      handleHubUpgrade(req, socket, head, config.hubPort);
      return;
    }
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, options.host, () => resolve());
  });

  const bound = server.address() as AddressInfo;

  async function routeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ONE parsed representation of req.url feeds routing + proxying (S20).
    const rawUrl = req.url ?? '/';
    // S19: absolute-form request lines are rejected outright.
    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
      sendError(res, 400, 'bad request');
      return;
    }
    const path = rawUrl.split('?')[0].split('#')[0];

    // ---- (1) exact match: unauthenticated liveness -------------------------
    if (path === '/healthz' && req.method === 'GET') {
      const health: SoloHealth = {
        ok: true,
        hub: options.hub.isHealthy() ? 'up' : 'down',
        panel: options.panel.isHealthy() ? 'up' : 'down',
      };
      res.writeHead(200, { 'content-type': JSON_TYPE, 'cache-control': NO_STORE });
      res.end(JSON.stringify(health));
      return;
    }

    // ---- Auth gate BEFORE any /api/solo/* handler runs (S2/S3) -------------
    if (path === '/api/solo' || path.startsWith('/api/solo/')) {
      const peer = peerAddress(req);
      const backstop = limiter.hitBackstop(peer);
      if (backstop.limited) {
        send429(res, backstop.retryAfterSeconds);
        return;
      }
      const presented = bearerToken(req);
      if (presented === null || !verifyAccessKey(presented, config.accessKeyHash)) {
        const failure = limiter.recordKeyFailure(peer);
        if (failure.limited) send429(res, failure.retryAfterSeconds);
        else sendError(res, 401, 'unauthorized');
        return;
      }
      limiter.resetKeyFailures(peer);

      // Authenticated: exact endpoints first...
      if (path === '/api/solo/bootstrap' && req.method === 'GET') {
        handleBootstrap(req, res);
        return;
      }
      if (path === '/api/solo/token' && req.method === 'POST') {
        handleToken(res);
        return;
      }
      // ...then fall-through to the EXISTING bridge API with the S18
      // mechanism (covers unknown /api/solo/<segment> paths).
      forwardToLocalApi(req, res);
      return;
    }

    // ---- (2) /hub/* : upgrades only (P1); plain HTTP always 404 ------------
    if (path === '/hub' || path.startsWith('/hub/')) {
      if (parseHubTarget(rawUrl).isHubUpgradePath && req.method === 'GET' && isWebSocketUpgrade(req)) {
        handleHubUpgrade(req, req.socket, Buffer.alloc(0), config.hubPort);
        return;
      }
      sendError(res, 404, 'not found');
      return;
    }

    // ---- (3) remaining /api/* → the EXISTING bridge local API --------------
    if (path === '/api' || path.startsWith('/api/')) {
      forwardToLocalApi(req, res);
      return;
    }

    // ---- (4) everything else → panel, or placeholder on / pre-panel (S12) --
    const panelHealthy = options.panel.isHealthy();
    if (path === '/' && !panelHealthy) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': NO_STORE,
      });
      res.end(PLACEHOLDER_HTML);
      return;
    }
    if (!panelHealthy) {
      sendError(res, 502, 'panel unavailable');
      return;
    }
    applyNoStorePassthrough(res);
    proxyHttpRequest(req, res, config.panelPort);
  }

  /**
   * Forward to the existing local API implementing the S18 MECHANISM: mutate
   * the inbound Origin BEFORE ws-proxy builds its sanitized hop (it rewrites
   * Host itself), so the hosted loopback-Host guard AND Origin allowlist both
   * pass byte-for-byte with zero edits to hosted files. Inbound
   * X-Forwarded-* never survives (stripped inside ws-proxy, S13).
   */
  function forwardToLocalApi(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== '') {
      req.headers['origin'] = `http://127.0.0.1:${String(localApiPort)}`;
    }
    applyNoStorePassthrough(res);
    proxyHttpRequest(req, res, localApiPort);
  }

  function handleBootstrap(req: IncomingMessage, res: ServerResponse): void {
    const hostHeader = req.headers.host;
    if (
      typeof hostHeader !== 'string' ||
      hostHeader.length === 0 ||
      !isAllowedHost(hostHeader, { address: bound.address, port: bound.port }, options.allowedHosts)
    ) {
      sendError(res, 400, 'invalid host header');
      return;
    }
    // Scheme derivation: wss ONLY when X-Forwarded-Proto is https AND the
    // socket peer is loopback (a locally-running tunnel sets both); else ws.
    const forwardedProto = req.headers['x-forwarded-proto'];
    const protoIsHttps =
      typeof forwardedProto === 'string' && forwardedProto.split(',')[0]?.trim() === 'https';
    const scheme = protoIsHttps && isLoopbackAddress(peerAddress(req)) ? 'wss' : 'ws';
    const bootstrap: SoloBootstrap = {
      userId: SOLO_USER_ID,
      token: mintHubJwt({ secret: config.hubSecret, ttlSeconds: options.mintTtlSeconds }),
      centrifugoUrl: `${scheme}://${hostHeader}${HUB_WS_PATH}`,
    };
    res.writeHead(200, { 'content-type': JSON_TYPE, 'cache-control': NO_STORE });
    res.end(JSON.stringify(bootstrap));
  }

  function handleToken(res: ServerResponse): void {
    const ttl = options.mintTtlSeconds ?? HUB_JWT_TTL_SECONDS;
    const payload: SoloTokenResponse = {
      token: mintHubJwt({ secret: config.hubSecret, ttlSeconds: options.mintTtlSeconds }),
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
    res.writeHead(200, { 'content-type': JSON_TYPE, 'cache-control': NO_STORE });
    res.end(JSON.stringify(payload));
  }

  const tracked = new Set<net.Socket>();
  server.on('connection', (socket) => {
    tracked.add(socket);
    socket.on('close', () => tracked.delete(socket));
  });

  return {
    port: bound.port,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of tracked) socket.destroy();
        server.closeAllConnections?.();
      });
    },
  };
}
