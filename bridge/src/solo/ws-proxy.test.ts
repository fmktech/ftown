import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { WebSocket, WebSocketServer } from 'ws';

import {
  HOP_BY_HOP_HEADERS,
  handleHubUpgrade,
  parseHubTarget,
  proxyHttpRequest,
} from './ws-proxy.js';

// ---------- helpers ----------

function withTimeout<T>(promise: Promise<T>, ms = 5000, label = 'test timeout'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function onceEvent(emitter: NodeJS.EventEmitter, event: string): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('no port'));
      else resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

interface RawResult {
  data: string;
  closed: boolean;
  error?: string;
}

/** Send a raw HTTP upgrade request over a bare socket and collect the bytes back.
 * Resolves as soon as response headers are complete (a successful 101 keeps
 * the tunnel open forever) and always destroys the probe socket. */
function sendRawUpgrade(port: number, path: string): Promise<RawResult> {
  return new Promise<RawResult>((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    let settled = false;
    const finish = (result: RawResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ data, closed: false, error: 'timeout' }), 5000);
    sock.on('connect', () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${Buffer.from('the sample nonce').toString('base64')}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n',
      );
    });
    sock.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.includes('\r\n\r\n')) finish({ data, closed: false });
    });
    sock.on('close', () => finish({ data, closed: true }));
    sock.on('error', (error: Error) => finish({ data, closed: false, error: String(error) }));
  });
}

function httpGetJson(port: number, path: string, headers: Record<string, string>): Promise<{
  statusCode: number | undefined;
  headers: http.IncomingHttpHeaders;
  rawHeaders: string[];
  body: Record<string, unknown>;
}> {
  return withTimeout(
    new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              rawHeaders: res.rawHeaders,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
            });
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on('error', reject);
    }),
    5000,
    `GET ${path} through proxy timed out`,
  );
}

/** Pre-attached ordered message queue — MUST be attached before awaiting
 * 'open': the stub's header echo can be emitted in the same tick as open,
 * before a post-open listener registration would run. */
function messageQueue(ws: WebSocket): () => Promise<string> {
  const queue: string[] = [];
  const waiters: Array<(value: string) => void> = [];
  ws.on('message', (data: Buffer) => {
    const text = data.toString('utf8');
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(text);
    else queue.push(text);
  });
  return () =>
    new Promise<string>((resolve) => {
      const buffered = queue.shift();
      if (buffered !== undefined) resolve(buffered);
      else waiters.push(resolve);
    });
}

// ---------- shared fixture: stub upstream + two fronts (live + dead target) ----------

let stubPort = 0;
let frontLivePort = 0;
let frontDeadPort = 0;
let deadPort = 0;
let upstreamWs: WebSocket | null = null;

const serversToClose: http.Server[] = [];

before(async () => {
  // Stub "centrifugo": plain GET echoes received headers; upgrade hands the
  // socket to a noServer WebSocketServer that sends the request headers it
  // saw (as JSON) and then echoes every frame back.
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    upstreamWs = ws;
    ws.send(JSON.stringify(req.headers));
    ws.on('message', (data: Buffer) => ws.send(data.toString('utf8')));
  });
  const stub = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-marker': 'upstream',
      'x-echo-url': req.url ?? '',
      // hop-by-hop on purpose: must NOT survive the proxy
      'keep-alive': 'timeout=5',
      'proxy-authenticate': 'Basic realm="stub"',
    });
    res.end(JSON.stringify(req.headers));
  });
  stub.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  stubPort = await listen(stub);
  serversToClose.push(stub);

  // Grab an ephemeral port and free it → guaranteed-refused "dead" upstream.
  const probe = http.createServer(() => {});
  deadPort = await listen(probe);
  await closeServer(probe);

  const frontLive = http.createServer((req, res) => proxyHttpRequest(req, res, stubPort, 'http'));
  frontLive.on('upgrade', (req, socket, head) => handleHubUpgrade(req, socket, head, stubPort, 'http'));
  frontLivePort = await listen(frontLive);
  serversToClose.push(frontLive);

  const frontDead = http.createServer(() => {});
  frontDead.on('upgrade', (req, socket, head) => handleHubUpgrade(req, socket, head, deadPort, 'http'));
  frontDeadPort = await listen(frontDead);
  serversToClose.push(frontDead);
});

after(async () => {
  for (const server of serversToClose.splice(0)) await closeServer(server).catch(() => {});
});

// ---------- S20 goldens ----------

describe('parseHubTarget (S20 single-parse goldens)', () => {
  describe('allowlist positives', () => {
    it('matches the exact public path', () => {
      assert.deepEqual(parseHubTarget('/hub/connection/websocket'), { isHubUpgradePath: true });
    });

    it('matches with a query string (pathname only)', () => {
      assert.deepEqual(parseHubTarget('/hub/connection/websocket?token=abc'), {
        isHubUpgradePath: true,
      });
    });
  });

  describe('golden negatives — everything else parses false', () => {
    const negatives: Array<[string, string]> = [
      ['protocol-relative double slash', '//hub/connection/websocket'],
      ['percent-encoded slashes', '/hub%2Fconnection%2Fwebsocket'],
      ['case variation', '/HUB/connection/websocket'],
      ['trailing segment/slash', '/hub/connection/websocket/'],
      ['doubled hub prefix', '/hub//connection/websocket'],
      ['NUL suffix', '/hub/connection/websocket\u0000bad'],
      ['plain root', '/'],
      ['bare prefix', '/hub/'],
      ['empty url', ''],
      ['unrelated path', '/api/solo/bootstrap'],
    ];

    for (const [label, url] of negatives) {
      it(`rejects ${label}: ${JSON.stringify(url)}`, () => {
        assert.deepEqual(parseHubTarget(url), { isHubUpgradePath: false });
      });
    }

    it('never throws on garbage input', () => {
      assert.doesNotThrow(() => parseHubTarget('http://[::z'));
      assert.deepEqual(parseHubTarget('http://[::z'), { isHubUpgradePath: false });
    });
  });

  it('exports the contract hop-by-hop list exactly', () => {
    assert.deepEqual([...HOP_BY_HOP_HEADERS], [
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
    ]);
  });
});

// ---------- WebSocket upgrade proxy ----------

describe('handleHubUpgrade', () => {
  it('completes a real WS handshake through /hub/connection/websocket with sanitized headers', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${frontLivePort}/hub/connection/websocket?token=abc`, {
      perMessageDeflate: true, // client OFFERS deflate — must not survive P3
      headers: { 'x-forwarded-for': '9.9.9.9', 'x-custom': 'ws-yes' },
    });
    const nextMessage = messageQueue(ws);
    try {
      await withTimeout(onceEvent(ws, 'open'), 5000, 'ws open timed out');

      const seen = (JSON.parse(await withTimeout(nextMessage(), 5000, 'no header echo from stub')) as Record<
        string,
        unknown
      >);
      assert.equal(seen['host'], `127.0.0.1:${stubPort}`); // P2/P4 rewrite
      assert.equal(seen['x-forwarded-proto'], 'http'); // set by proxy from param
      assert.equal(seen['x-custom'], 'ws-yes'); // end-to-end headers pass
      assert.equal(seen['sec-websocket-version'], '13'); // recomputed handshake
      assert.equal(typeof seen['sec-websocket-key'], 'string');
      assert.ok((seen['sec-websocket-key'] as string).length > 0);      assert.ok(!('sec-websocket-extensions' in seen)); // deflate offer dropped
      assert.ok(!('x-forwarded-for' in seen)); // inbound XFF never relayed
      assert.equal(String(seen['connection']).toLowerCase(), 'upgrade');
      assert.equal(ws.extensions, ''); // no compression negotiated client-side
    } finally {
      ws.close();
    }
  });

  it('round-trips application frames client↔upstream', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${frontLivePort}/hub/connection/websocket`);
    const nextMessage = messageQueue(ws);
    try {
      await onceEvent(ws, 'open');
      await nextMessage(); // header echo

      ws.send('frame-roundtrip-1');
      assert.equal(await withTimeout(nextMessage(), 5000, 'frame echo timeout'), 'frame-roundtrip-1');
    } finally {
      ws.close();
    }
  });

  it('forwards upstream-initiated pings untouched and passes the auto-pong back (P5)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${frontLivePort}/hub/connection/websocket`);
    const nextMessage = messageQueue(ws);
    try {
      await onceEvent(ws, 'open');
      await nextMessage(); // header echo
      assert.ok(upstreamWs, 'upstream connection captured');

      const pingReachedClient = onceEvent(ws, 'ping');
      const pongReachedUpstream = onceEvent(upstreamWs, 'pong');
      upstreamWs.ping();
      await withTimeout(Promise.all([pingReachedClient, pongReachedUpstream]), 5000, 'control-frame round trip timeout');
    } finally {
      ws.close();
    }
  });

  it('relays the upstream-computed Accept for the CLIENT key verbatim (RFC 6455 example)', async () => {
    // Key dGhlIHNhbXBsZSBub25jZQ== must yield s3pPLMBiTxaQ9kYGzzhZRbK+xOo= —
    // computed BY THE STUB UPSTREAM (proxy recomputes nothing locally), which
    // only validates at the client if the proxy preserved the client's key.
    const result = await sendRawUpgrade(frontLivePort, '/hub/connection/websocket');
    assert.match(result.data, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
    assert.match(result.data, /[Ss]ec-[Ww]eb[Ss]ocket-[Aa]ccept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  });

  it('404s non-allowlist upgrade paths without touching the hub', async () => {
    const result = await sendRawUpgrade(frontLivePort, '/hub/other');
    assert.match(result.data, /^HTTP\/1\.1 404 /);
    assert.match(result.data, /"error":"not found"/);
  });

  it('404s trailing-slash variant over a real socket (S20 integration)', async () => {
    const result = await sendRawUpgrade(frontLivePort, '/hub/connection/websocket/');
    assert.match(result.data, /^HTTP\/1\.1 404 /);
  });

  it('destroys cleanly (502-style close) when the upstream port is dead', async () => {
    const result = await sendRawUpgrade(frontDeadPort, '/hub/connection/websocket');
    // Either we got the clean 502 written before destroy, or the socket was
    // destroyed outright — both are acceptable; crashing is not.
    const clean =
      result.data.startsWith('HTTP/1.1 502') ||
      (result.closed && result.data === '') ||
      result.error !== undefined;
    assert.ok(clean, `unexpected outcome: data=${JSON.stringify(result.data)} error=${result.error ?? 'none'}`);
  });
});

// ---------- plain HTTP proxy ----------

describe('proxyHttpRequest', () => {
  it('proxies GET with status/body intact and strips inbound + response hop-by-hop headers', async () => {
    const result = await httpGetJson(frontLivePort, '/some/path?x=1', {
      'x-forwarded-for': '10.1.2.3',
      'x-forwarded-proto': 'https', // inbound XFF scheme must NOT be relayed
      'x-custom': 'http-yes',
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['x-marker'], 'upstream');
    assert.equal(result.headers['x-echo-url'], '/some/path?x=1');
    // Response-side hop-by-hop stripping (node ≥19 injects its own
    // Keep-Alive header, so absence of "keep-alive" is not observable here —
    // proxy-authenticate and te are headers node never adds spontaneously):
    assert.ok(!('proxy-authenticate' in result.headers));
    assert.ok(!result.rawHeaders.some((h) => h.toLowerCase() === 'te'));
    assert.ok(!result.rawHeaders.some((h) => h.toLowerCase() === 'trailer'));

    // Request-side assertions via the upstream header echo:
    assert.equal(result.body['host'], `127.0.0.1:${stubPort}`);
    assert.equal(result.body['x-forwarded-proto'], 'http');
    assert.equal(result.body['x-custom'], 'http-yes');
    assert.ok(!('x-forwarded-for' in result.body));
    assert.ok(!('keep-alive' in result.body)); // node adds its own Connection hop header (legit per-hop), but never keep-alive/te/upgrade
    assert.ok(!('te' in result.body));
    assert.ok(!('upgrade' in result.body));
  });

  it('returns {"error":...} with 502 when the private child is down', async () => {
    const deadFront = http.createServer((_req, res) => proxyHttpRequest(_req, res, deadPort, 'http'));
    const deadFrontPort = await listen(deadFront);
    try {
      const body = await withTimeout(
        new Promise<string>((resolve, reject) => {
          const req = http.get({ host: '127.0.0.1', port: deadFrontPort, path: '/anything' }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              assert.equal(res.statusCode, 502);
              resolve(Buffer.concat(chunks).toString('utf8'));
            });
          });
          req.on('error', reject);
        }),
        5000,
        '502 flow timed out',
      );
      assert.deepEqual(JSON.parse(body), { error: 'upstream unavailable' });
    } finally {
      await closeServer(deadFront).catch(() => {});
    }
  });
});
