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

  const headers = sanitizeRequestHeaders(req.headers, targetPort, forwardedProto);
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
