import http from 'node:http';
import crypto from 'node:crypto';

import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * ws-proxy — P1-P5 proxying for solo mode (contract v4).
 *
 * S20 SINGLE-PARSE SEAM — the ONE coherent interpretation of routing-table row
 * "GET /hub/connection/websocket → proxied to hub" + P1 + the hub-config note:
 *
 *   1. The PUBLIC request path is matched against ^/hub/connection/websocket$
 *      (case-sensitive, exact — no trailing segments, no percent-encoded
 *      slashes, no double slashes, no NUL suffixes; query strings allowed).
 *   2. On match, the FORWARD path sent to the hub is the public path with the
 *      single leading '/hub' prefix stripped → '/connection/websocket', which
 *      is centrifugo's default path (no hub path options needed).
 *
 * (P1's regex describes the public allowlist; stripping happens only for
 * forwarding. Anything else under /hub is never forwarded — solo-server 404s
 * it; this module exposes only parse + forwarding.)
 */

/** Public path allowlist (P1) — exact match required. */
export const HUB_UPGRADE_PUBLIC_PATH = '/hub/connection/websocket';

/** Forward path to the hub after stripping the single leading '/hub'. */
export const HUB_UPSTREAM_WS_PATH = '/connection/websocket';

/**
 * Inbound hop-by-hop headers stripped per P3 — exact contract list.
 */
export const HOP_BY_HOP_HEADERS: readonly string[] = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

const HOP_BY_HOP = new Set<string>(HOP_BY_HOP_HEADERS);

const BAD_GATEWAY_BODY = '{"error":"upstream unavailable"}';

/**
 * Split a Host-header value into hostname + explicit port (or null when the
 * header carries no port). Handles bracketed IPv6 literals (`[::1]:8080`).
 */
function splitHostHeader(host: string): { hostname: string; port: string | null } {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return { hostname: host, port: null };
    const hostname = host.slice(0, end + 1);
    const rest = host.slice(end + 1);
    return { hostname, port: rest.startsWith(':') ? rest.slice(1) : null };
  }
  const idx = host.lastIndexOf(':');
  if (idx === -1) return { hostname: host, port: null };
  return { hostname: host.slice(0, idx), port: host.slice(idx + 1) };
}

/**
 * Same-origin enforcement (front-proxy owns this — Centrifugo must never see
 * an Origin header, see hub-manager.ts). Returns false on any parse failure
 * or mismatch. `hostHeader` with no explicit port is treated as matching
 * whichever of 80/443 the Origin's scheme implies (default-port equivalence).
 */
export function isSameOrigin(originHeader: string, hostHeader: string | undefined): boolean {
  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return false;
  }
  if (!hostHeader) return false;

  const defaultPort = originUrl.protocol === 'https:' ? '443' : '80';
  const originHost = originUrl.hostname.toLowerCase();
  const originPort = originUrl.port !== '' ? originUrl.port : defaultPort;

  const { hostname: reqHostname, port: reqPort } = splitHostHeader(hostHeader.trim().toLowerCase());
  const effectiveReqPort = reqPort !== null ? reqPort : defaultPort;

  return reqHostname === originHost && effectiveReqPort === originPort;
}

/** Write a bare 403 directly to the raw socket and tear it down (no upstream opened). */
function writeOriginForbidden(socket: Duplex): void {
  try {
    socket.end(
      'HTTP/1.1 403 Forbidden\r\n' +
        'content-length: 0\r\n' +
        'connection: close\r\n' +
        '\r\n',
    );
    // Safety net: some peers never read/ack the response and would otherwise
    // hold the socket open forever. socket.end() lets the write flush first;
    // this just guarantees eventual cleanup if that never happens.
    setTimeout(() => socket.destroy(), 1000).unref();
  } catch {
    // Socket already gone — nothing to relay the error to.
    socket.destroy();
  }
}

/**
 * S20 seam: parse req.url ONCE and decide whether it targets the proxied hub
 * upgrade path. Percent-decoded / differently-cased / extra-segment variants
 * are NOT the allowlist path (goldens pinned in tests).
 */
export function parseHubTarget(url: string): { isHubUpgradePath: boolean } {
  try {
    const { pathname } = new URL(url, 'http://solo.invalid');
    return { isHubUpgradePath: pathname === HUB_UPGRADE_PUBLIC_PATH };
  } catch {
    return { isHubUpgradePath: false };
  }
}

/**
 * P3/P4 inbound header sanitizer shared by both proxy paths:
 * - drops every hop-by-hop header in HOP_BY_HOP_HEADERS,
 * - drops every sec-websocket-* header (upstream handshake recomputes;
 *   handleHubUpgrade re-adds a fresh key/version so no deflate survives),
 * - drops every inbound x-forwarded-* header (never relayed — S13),
 * - rewrites Host to 127.0.0.1:<targetPort> (P2),
 * - sets X-Forwarded-Proto from the caller-supplied scheme (P4).
 *
 * NOTE: Origin/Cookie are deliberately NOT touched here — this sanitizer is
 * shared with proxyHttpRequest (local API / panel), where forwardToLocalApi
 * in solo-server.ts relies on Origin surviving (rewritten to loopback, S18
 * mechanism). handleHubUpgrade strips Origin/Cookie itself, scoped to just
 * the hub proxy hop (see below).
 */
function sanitizeRequestHeaders(
  headers: IncomingHttpHeaders,
  targetPort: number,
  forwardedProto: string,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower.startsWith('sec-websocket-')) continue;
    if (lower.startsWith('x-forwarded-')) continue;
    out[lower] = value as OutgoingHttpHeaders[string];
  }
  out['host'] = `127.0.0.1:${targetPort}`;
  out['x-forwarded-proto'] = forwardedProto;
  return out;
}

/** Strip hop-by-hop headers from an upstream response before relaying (P3). */
function sanitizeResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    out[lower] = value as OutgoingHttpHeaders[string];
  }
  return out;
}

function writeJsonError(socket: Duplex, statusCode: number, statusText: string, error: string): void {
  try {
    socket.end(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
        'content-type: application/json\r\n' +
        `content-length: ${Buffer.byteLength(error)}\r\n` +
        'connection: close\r\n' +
        '\r\n' +
        error,
    );
  } catch {
    // Socket already gone — nothing to relay the error to.
  }
}

/**
 * P2/P3/P4 plain-HTTP proxy hop to 127.0.0.1:<targetPort>. Request and response
 * body streams are piped both directions; status/headers propagate minus
 * hop-by-hop. Upstream failure yields {"error":...} with 502 (headers not yet
 * sent) or destroys the response.
 */
export function proxyHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  targetPort: number,
  forwardedProto = 'http',
): void {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: targetPort,
      path: req.url ?? '/',
      method: req.method ?? 'GET',
      headers: sanitizeRequestHeaders(req.headers, targetPort, forwardedProto),
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, sanitizeResponseHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
    },
  );
  req.pipe(upstream);
  upstream.on('error', () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(BAD_GATEWAY_BODY),
      connection: 'close',
    });
    res.end(BAD_GATEWAY_BODY);
  });
}

/**
 * WebSocket upgrade proxy (P1/P2/P3/P5): validates the S20 allowlist first,
 * then opens an HTTP upgrade to 127.0.0.1:<targetPort> at
 * HUB_UPSTREAM_WS_PATH with sanitized headers. All inbound sec-websocket-*
 * are stripped (no extension offer survives — compression stays off), then
 * the handshake identity is re-set: version 13 plus the CLIENT'S OWN
 * Sec-WebSocket-Key (fresh random fallback). Preserving the client key lets
 * the UPSTREAM handshake compute a Sec-WebSocket-Accept that validates
 * end-to-end while this module recomputes nothing locally. On upstream 101
 * the upstream-computed sec-websocket-* headers are relayed verbatim, then
 * both sockets are piped so protocol pings/pongs pass untouched (P5).
 */
export function handleHubUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  targetPort: number,
  forwardedProto = 'http',
): void {
  if (!parseHubTarget(req.url ?? '').isHubUpgradePath || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    writeJsonError(socket, 404, 'Not Found', '{"error":"not found"}');
    return;
  }

  // Same-origin enforcement (front owns this — Centrifugo's allowed_origins
  // is deliberately empty; see hub-manager.ts). No Origin header at all means
  // a non-browser client (server-to-server) — allowed through unchecked.
  const originHeader = req.headers.origin;
  if (typeof originHeader === 'string' && !isSameOrigin(originHeader, req.headers.host)) {
    console.error(`[ftown-solo] rejected WS upgrade: origin "${originHeader}" does not match host "${req.headers.host ?? ''}"`);
    writeOriginForbidden(socket);
    return;
  }

  const headers = sanitizeRequestHeaders(req.headers, targetPort, forwardedProto);
  // Hub-scoped only (see sanitizeRequestHeaders note): Centrifugo must never
  // see Origin (the front now owns that check — hub-manager.ts allowed_origins
  // is deliberately empty) or Cookie (hub authenticates via JWT only).
  delete headers['origin'];
  delete headers['cookie'];
  headers['connection'] = 'Upgrade';
  headers['upgrade'] = 'websocket';
  const clientKey = req.headers['sec-websocket-key'];
  headers['sec-websocket-key'] =
    typeof clientKey === 'string' && clientKey.length > 0
      ? clientKey
      : crypto.randomBytes(16).toString('base64');
  headers['sec-websocket-version'] = '13';

  const killBoth = (a: Duplex, b: Duplex): void => {
    a.destroy();
    b.destroy();
  };

  const upstream = http.request({
    host: '127.0.0.1',
    port: targetPort,
    path: HUB_UPSTREAM_WS_PATH,
    method: 'GET',
    headers,
  });

  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    // Relay upstream's 101 + its OWN sec-websocket-* accept headers (P3).
    const lines = ['HTTP/1.1 101 Switching Protocols', 'connection: Upgrade', 'upgrade: websocket'];
    for (const name of ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
      const value = upstreamRes.headers[name];
      if (value !== undefined) {
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
    }
    try {
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length > 0) socket.write(head);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
    } catch {
      upstreamSocket.destroy();
      socket.destroy();
      return;
    }
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    upstreamSocket.on('error', () => killBoth(upstreamSocket, socket));
    socket.on('error', () => killBoth(upstreamSocket, socket));
    upstreamSocket.on('close', () => socket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
  });

  // Hub answered with a plain HTTP response (e.g. rejected handshake): relay
  // it once, then close.
  upstream.on('response', (upstreamRes) => {
    const chunks: Buffer[] = [];
    upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk));
    upstreamRes.on('end', () => {
      const body = Buffer.concat(chunks);
      const relayed = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage ?? ''}`.trimEnd()];
      for (const [name, value] of Object.entries(sanitizeResponseHeaders(upstreamRes.headers))) {
        if (name === 'content-length') continue;
        if (value !== undefined) relayed.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
      relayed.push(`content-length: ${body.length}`, 'connection: close', '');
      try {
        socket.end(relayed.join('\r\n') + '\r\n' + (body.length > 0 ? body : ''));
      } catch {
        socket.destroy();
      }
    });
    upstreamRes.on('error', () => socket.destroy());
  });

  // Private child down: clean 502-style close instead of a hang/crash.
  upstream.on('error', () => {
    writeJsonError(socket, 502, 'Bad Gateway', BAD_GATEWAY_BODY);
  });

  upstream.end();
}
