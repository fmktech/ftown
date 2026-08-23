/**
 * solo-server tests - offline, real loopback only.
 *
 * Upstream stubs:
 *   - a fake "local API" server that records every seen request (headers +
 *     path) and can be scripted to answer with a marker status/body. This
 *     asserts the S18 Host/Origin rewriting and body/status passthrough.
 *   - a fake panel upstream for fallback routing.
 *   - a fake hub used only to prove upgrade wiring (nothing reaches it
 *     unless the P1 path + Upgrade headers line up).
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { after, describe, it } from 'node:test';

import { SOLO_USER_ID, type SoloConfig } from './contract.js';
import { generateAccessKey, verifyHubJwt } from './solo-auth.js';
import {
  PLACEHOLDER_HTML,
  RateLimiter,
  createSoloServer,
  type SoloServerHandle,
} from './solo-server.js';

// ---------- tiny loopback helpers ----------

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

type Responder = (req: RecordedRequest, res: http.ServerResponse) => void;

interface StubServer {
  port: number;
  requests: RecordedRequest[];
  respondWith(responder: Responder): void;
  close(): Promise<void>;
}

function startStub(responder?: Responder): Promise<StubServer> {
  const requests: RecordedRequest[] = [];
  let current: Responder = responder ?? ((_req, res) => res.end());
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      current(recorded, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address !== null && typeof address === 'object');
      resolve({
        port: address.port,
        requests,
        respondWith(next: Responder) {
          current = next;
        },
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function parseJson(res: RawResponse): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

interface TestStack {
  solo: SoloServerHandle;
  localApi: StubServer;
  panel: StubServer;
  key: string;
  config: SoloConfig;
}

async function startStack(opts?: {
  hubHealthy?: boolean;
  panelHealthy?: boolean;
  peerAddress?: (req: IncomingMessage) => string;
  allowedHosts?: readonly string[];
  mintTtlSeconds?: number;
  rateLimiter?: RateLimiter;
  hubPort?: number;
}): Promise<TestStack> {
  const localApi = await startStub((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"from":"local-api"}');
  });
  const panel = await startStub((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>panel</html>');
  });
  const { raw, hash } = generateAccessKey();
  const config: SoloConfig = {
    port: 0,
    hubPort: opts?.hubPort ?? 5999,
    panelPort: panel.port,
    dataDir: '/tmp/ftown-solo-server-test',
    accessKeyHash: hash,
    hubSecret: 'test-hub-secret',
  };
  const solo = await createSoloServer({
    config,
    localApiPort: localApi.port,
    hub: { isHealthy: () => opts?.hubHealthy ?? true },
    panel: { isHealthy: () => opts?.panelHealthy ?? true },
    mintTtlSeconds: opts?.mintTtlSeconds,
    rateLimiter: opts?.rateLimiter,
    peerAddress: opts?.peerAddress,
    allowedHosts: opts?.allowedHosts,
    host: '127.0.0.1',
  });
  return { solo, localApi, panel, key: raw, config };
}

async function stopStack(stack: TestStack): Promise<void> {
  await stack.solo.close();
  await stack.localApi.close();
  await stack.panel.close();
}

function authHeaders(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

// ---------- auth gate ----------

describe('auth gate on /api/solo/* (S2)', () => {
  it('missing Authorization gives 401 {"error"} with no-store', async () => {
    const stack = await startStack();
    after(() => stopStack(stack));
    const res = await request(stack.solo.port, '/api/solo/bootstrap');
    assert.equal(res.status, 401);
    assert.ok(typeof parseJson(res)['error'] === 'string');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(stack.localApi.requests.length, 0, 'request must not reach any child');
  });

  it('bad key and malformed scheme give 401', async () => {
    const stack = await startStack();
    after(() => stopStack(stack));
    const badKey = await request(stack.solo.port, '/api/solo/token', {
      method: 'POST',
      headers: { authorization: `Bearer ${'f'.repeat(64)}` },
    });
    assert.equal(badKey.status, 401);
    assert.equal(badKey.headers['cache-control'], 'no-store');

    const badScheme = await request(stack.solo.port, '/api/solo/bootstrap', {
      headers: { authorization: `Basic ${stack.key}` },
    });
    assert.equal(badScheme.status, 401);
  });

  it('gate covers UNKNOWN /api/solo/* paths too (they proxy only after auth)', async () => {
    const stack = await startStack();
    after(() => stopStack(stack));
    const noAuth = await request(stack.solo.port, '/api/solo/frobnicate');
    assert.equal(noAuth.status, 401);
    assert.equal(stack.localApi.requests.length, 0);

    const withAuth = await request(stack.solo.port, '/api/solo/frobnicate', {
      headers: authHeaders(stack.key),
    });
    assert.equal(withAuth.status, 200);
    assert.equal(withAuth.body, '{"from":"local-api"}');
    assert.equal(stack.localApi.requests.length, 1, 'fell through to the existing bridge API');
  });

  it('/healthz is unauthenticated and aggregates both health sources', async () => {
    const downStack = await startStack({ hubHealthy: false, panelHealthy: false });
    after(() => stopStack(downStack));
    const down = await request(downStack.solo.port, '/healthz');
    assert.equal(down.status, 200);
    assert.deepEqual(parseJson(down), { ok: true, hub: 'down', panel: 'down' });
    assert.equal(down.headers['cache-control'], 'no-store');

    const upStack = await startStack({ hubHealthy: true, panelHealthy: true });
    after(() => stopStack(upStack));
    const up = await request(upStack.solo.port, '/healthz');
    assert.deepEqual(parseJson(up), { ok: true, hub: 'up', panel: 'up' });
  });
});

// ---------- rate limiting ----------

describe('rate limiting (S3)', () => {
  it('10 key failures within the window give 429 + jittered Retry-After (55..65)', async () => {
    const stack = await startStack();
    after(() => stopStack(stack));
    for (let i = 1; i <= 12; i++) {
      const res = await request(stack.solo.port, '/api/solo/bootstrap', {
        headers: { authorization: 'Bearer wrong-key' },
      });
      if (res.status === 429) {
        assert.ok(i >= 10, `limited before threshold at attempt ${i}`);
        const retryAfter = Number.parseInt(String(res.headers['retry-after']), 10);
        assert.ok(
          Number.isFinite(retryAfter) && retryAfter >= 55 && retryAfter <= 65,
          `Retry-After ${retryAfter} outside 60 +/- 5`,
        );
        assert.equal(res.headers['cache-control'], 'no-store');
        return;
      }
      assert.equal(res.status, 401);
    }
    assert.fail('never rate limited despite >= 10 failures');
  });

  it('a successful auth resets the failure count', async () => {
    const stack = await startStack();
    after(() => stopStack(stack));
    for (let i = 0; i < 9; i++) {
      const bad = await request(stack.solo.port, '/api/solo/bootstrap', {
        headers: { authorization: 'Bearer wrong-key' },
      });
      assert.equal(bad.status, 401);
    }
    const good = await request(stack.solo.port, '/api/solo/bootstrap', {
      headers: authHeaders(stack.key),
    });
    assert.equal(good.status, 200, 'valid key passes and resets failures');
    // 9 fresh failures must NOT trip the limiter (window was reset).
    for (let i = 0; i < 9; i++) {
      const bad = await request(stack.solo.port, '/api/solo/bootstrap', {
        headers: { authorization: 'Bearer wrong-key' },
      });
      assert.equal(bad.status, 401);
    }
  });

  it('per-peer backstop (>240/min on /api/solo/*) fires regardless of key validity', async () => {
    const stack = await startStack({ rateLimiter: new RateLimiter({ backstopThreshold: 5 }) });
    after(() => stopStack(stack));
    for (let i = 0; i < 5; i++) {
      const res = await request(stack.solo.port, '/api/solo/bootstrap', {
        headers: authHeaders(stack.key),
      });
      assert.equal(res.status, 200);
    }
    const limited = await request(stack.solo.port, '/api/solo/bootstrap', {
      headers: authHeaders(stack.key),
    });
    assert.equal(limited.status, 429);
    assert.ok(String(limited.headers['retry-after']).length > 0);
    assert.equal(parseJson(limited)['error'], 'rate limited');
  });

  it('RateLimiter slides its window (injectable clock) and jitters Retry-After', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ now: () => now, retryAfterJitterSeconds: 5 });
    for (let i = 0; i < 9; i++) {
      assert.equal(limiter.recordKeyFailure('p').limited, false);
    }
    assert.equal(limiter.recordKeyFailure('p').limited, true);
    // Slide past the window: failures age out.
    now += 61_000;
    assert.equal(limiter.recordKeyFailure('p').limited, false);

    // Backstop uses strict inequality: exactly 240 hits pass, 241st trips.
    for (let i = 0; i < 240; i++) {
      assert.equal(limiter.hitBackstop('q').limited, false);
    }
    const tripped = limiter.hitBackstop('q');
    assert.equal(tripped.limited, true);
    assert.ok(tripped.retryAfterSeconds >= 55 && tripped.retryAfterSeconds <= 65);

    // Peers are independent.
    assert.equal(limiter.hitBackstop('r').limited, false);
    // Success resets only the failure counter, never the backstop.
    limiter.resetKeyFailures('p');
    now += 61_000;
    for (let i = 0; i < 9; i++) limiter.recordKeyFailure('p');
    assert.equal(limiter.recordKeyFailure('p').limited, true);
  });
});

// ---------- bootstrap / token ----------

describe('bootstrap endpoint', () => {
  it('happy shape: userId, verifiable token, centrifugoUrl ws://host/hub/connection/websocket', async () => {
    const stack = await startStack({ peerAddress: () => '203.0.113.7' });
    after(() => stopStack(stack));
    const host = `127.0.0.1:${stack.solo.port}`;
    const res = await request(stack.solo.port, '/api/solo/bootstrap?x=1', {
      headers: authHeaders(stack.key),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const body = parseJson(res);
    assert.equal(body['userId'], SOLO_USER_ID);
    const centrifugoUrl = String(body['centrifugoUrl']);
    assert.ok(centrifugoUrl.startsWith(`ws://${host}/hub/connection/websocket`));

    const token = String(body['token']);
    const verification = verifyHubJwt(token, { secret: stack.config.hubSecret });
    assert.deepEqual(verification, { valid: true });
  });

  it('wss requires BOTH x-forwarded-proto https AND loopback peer (contract scheme rule)', async () => {
    const loopbackHttps = await startStack({ peerAddress: () => '::1' });
    after(() => stopStack(loopbackHttps));
    const wssRes = await request(loopbackHttps.solo.port, '/api/solo/bootstrap', {
      headers: { ...authHeaders(loopbackHttps.key), 'x-forwarded-proto': 'https' },
    });
    assert.match(String(parseJson(wssRes)['centrifugoUrl']), /^wss:\/\//);

    const lanHttps = await startStack({ peerAddress: () => '192.168.1.55' });
    after(() => stopStack(lanHttps));
    const wsRes = await request(lanHttps.solo.port, '/api/solo/bootstrap', {
      headers: { ...authHeaders(lanHttps.key), 'x-forwarded-proto': 'https' },
    });
    assert.match(String(parseJson(wsRes)['centrifugoUrl']), /^ws:\/\//);
  });

  it('S19: Host not equal to the socket local address:port is rejected 400', async () => {
    const stack = await startStack();
    after(() => stopStack(stack));
    const spoofed = await request(stack.solo.port, '/api/solo/bootstrap', {
      headers: { ...authHeaders(stack.key), host: 'evil.example:' + String(stack.solo.port) },
    });
    assert.equal(spoofed.status, 400);

    const wrongPort = await request(stack.solo.port, '/api/solo/bootstrap', {
      headers: { ...authHeaders(stack.key), host: '127.0.0.1:1' },
    });
    assert.equal(wrongPort.status, 400);

    const good = await request(stack.solo.port, '/api/solo/bootstrap', {
      headers: { ...authHeaders(stack.key), host: `127.0.0.1:${stack.solo.port}` },
    });
    assert.equal(good.status, 200);
  });

  it('S19 seam: allowedHosts accepts tunnel hostnames verbatim', async () => {
    const stack = await startStack({ allowedHosts: ['tunnel.example'] });
    after(() => stopStack(stack));
    const res = await request(stack.solo.port, '/api/solo/bootstrap', {
      headers: { ...authHeaders(stack.key), host: 'tunnel.example' },
    });
    assert.equal(res.status, 200);
    assert.equal(
      parseJson(res)['centrifugoUrl'],
      `ws://tunnel.example/hub/connection/websocket`,
    );

    const rejected = await request(stack.solo.port, '/api/solo/bootstrap', {
      headers: { ...authHeaders(stack.key), host: 'other.example' },
    });
    assert.equal(rejected.status, 400);
  });

  it('absolute-form request lines are rejected 400 (S19)', async () => {
    const stack = await startStack();
    after(() => stopStack(stack));
    const absolute = `http://127.0.0.1:${stack.solo.port}/api/solo/bootstrap`;
    const res = await request(stack.solo.port, absolute, { headers: authHeaders(stack.key) });
    assert.equal(res.status, 400);
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('mintTtlSeconds overrides the JWT TTL; token response carries ISO expiresAt', async () => {
    const stack = await startStack({ mintTtlSeconds: 120 });
    after(() => stopStack(stack));
    const boot = parseJson(
      await request(stack.solo.port, '/api/solo/bootstrap', { headers: authHeaders(stack.key) }),
    );
    const [, payloadSeg] = String(boot['token']).split('.');
    const payload = JSON.parse(Buffer.from(payloadSeg ?? '', 'base64url').toString('utf8')) as {
      exp: number;
      iat: number;
    };
    assert.equal(payload.exp - payload.iat, 120);

    const tokenRes = await request(stack.solo.port, '/api/solo/token', {
      method: 'POST',
      headers: authHeaders(stack.key),
    });
    assert.equal(tokenRes.status, 200);
    assert.equal(tokenRes.headers['cache-control'], 'no-store');
    const tokenBody = parseJson(tokenRes);
    assert.deepEqual(verifyHubJwt(String(tokenBody['token']), { secret: stack.config.hubSecret }), {
      valid: true,
    });
    const expiresAtMs = Date.parse(String(tokenBody['expiresAt']));
    assert.ok(Number.isFinite(expiresAtMs));
    assert.ok(expiresAtMs > Date.now());
  });
});

// ---------- routing precedence + proxying ----------

describe('routing precedence', () => {
  it('/hub/* plain HTTP is 404 at the front and never reaches the hub child', async () => {
    const stack = await startStack();
    after(() => stopStack(stack));
    // S20 goldens: variants are NOT the allowlist path -> front 404s them.
    for (const path of ['/hub/connection/websocket', '/hub/connection', '/hub/', '/hub//connection/websocket']) {
      const res = await request(stack.solo.port, path);
      assert.equal(res.status, 404, path);
      assert.ok(typeof parseJson(res)['error'] === 'string');
    }
    assert.equal(stack.panel.requests.length, 0);

    // Case variation escapes the /hub/ prefix entirely: routing sends it to
    // the panel child like any other non-solo path (never to the hub).
    stack.panel.respondWith((_req, res) => res.end('panel-case'));
    const upper = await request(stack.solo.port, '/HUB/connection/websocket');
    assert.equal(upper.status, 200);
    assert.equal(stack.panel.requests.length, 1);
  });

  it('other /api/* bypasses the solo auth gate and reaches the existing bridge API', async () => {
    const stack = await startStack();
    after(() => stopStack(stack));
    const res = await request(stack.solo.port, '/api/devices');
    assert.equal(res.status, 200);
    assert.equal(res.body, '{"from":"local-api"}');
    assert.equal(stack.localApi.requests[0]?.url, '/api/devices');
  });

  it('S18 mechanism: local API sees loopback Host and replaced Origin', async () => {
    const stack = await startStack();
    after(() => stopStack(stack));
    await request(stack.solo.port, '/api/pairings', {
      headers: { origin: 'http://attacker.example:9999' },
    });
    const seen = stack.localApi.requests[0];
    assert.ok(seen);
    assert.equal(seen.headers['host'], `127.0.0.1:${stack.localApi.port}`);
    assert.equal(seen.headers['origin'], `http://127.0.0.1:${stack.localApi.port}`);

    await request(stack.solo.port, '/api/no-origin-header');
    const second = stack.localApi.requests[1];
    assert.ok(second);
    assert.equal(second.headers['origin'], undefined);
  });

  it('body/status passthrough both directions (marker 418 from the bridge API)', async () => {
    const stack = await startStack();
    after(() => stopStack(stack));
    stack.localApi.respondWith((req, res) => {
      res.writeHead(418, { 'content-type': 'text/plain' });
      res.end(`echo:${String(req.url)}:done`);
    });
    const res = await request(stack.solo.port, '/api/teapot?deep=true', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(res.status, 418);
    assert.equal(res.body, 'echo:/api/teapot?deep=true:done');
  });

  it('panel fallback routing rewrites Host; panel responses lacking cache headers get no-store (S14)', async () => {
    const stack = await startStack();
    after(() => stopStack(stack));
    stack.panel.respondWith((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>panel-page</html>');
    });
    const res = await request(stack.solo.port, '/dashboard');
    assert.equal(res.status, 200);
    assert.equal(res.body, '<html>panel-page</html>');
    assert.equal(res.headers['cache-control'], 'no-store', 'passthrough guard adds no-store');
    const seen = stack.panel.requests[0];
    assert.ok(seen);
    assert.equal(seen.url, '/dashboard');
    assert.equal(seen.headers['host'], `127.0.0.1:${stack.panel.port}`);

    // Upstream cache headers are preserved untouched (guard only fills gaps).
    stack.panel.respondWith((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'max-age=3600' });
      res.end('<html>cachable</html>');
    });
    const cached = await request(stack.solo.port, '/cached');
    assert.equal(cached.headers['cache-control'], 'max-age=3600');
  });

  it('panel down: "/" gets the byte-static placeholder; other paths get 502 panel unavailable', async () => {
    const stack = await startStack({ panelHealthy: false });
    after(() => stopStack(stack));
    const placeholder = await request(stack.solo.port, '/');
    assert.equal(placeholder.status, 200);
    assert.match(String(placeholder.headers['content-type']), /^text\/html/);
    assert.equal(placeholder.headers['cache-control'], 'no-store');
    assert.equal(placeholder.body, PLACEHOLDER_HTML, 'must be byte-static equality');
    assert.ok(PLACEHOLDER_HTML.includes('<meta http-equiv="refresh" content="2">'));
    assert.ok(PLACEHOLDER_HTML.includes('Starting ftown Solo'));

    const other = await request(stack.solo.port, '/login');
    assert.equal(other.status, 502);
    assert.equal(parseJson(other)['error'], 'panel unavailable');

    // Panel-bound paths never hit the panel stub while it is flagged down.
    assert.equal(stack.panel.requests.length, 0);
  });

  it('panel up: "/" proxies to the panel instead of the placeholder (S12 handoff)', async () => {
    const stack = await startStack({ panelHealthy: true });
    after(() => stopStack(stack));
    const res = await request(stack.solo.port, '/');
    assert.equal(res.status, 200);
    assert.equal(res.body, '<html>panel</html>');
    assert.equal(stack.panel.requests.length, 1);
  });

  it('every /api/solo/* response carries no-store including errors', async () => {
    const stack = await startStack();
    after(() => stopStack(stack));
    const cases: Array<{ path: string; method: string; headers?: Record<string, string> }> = [
      { path: '/api/solo/bootstrap', method: 'GET' },
      { path: '/api/solo/bootstrap', method: 'GET', headers: authHeaders(stack.key) },
      { path: '/api/solo/token', method: 'POST', headers: authHeaders(stack.key) },
      { path: '/api/solo/unknown', method: 'GET', headers: authHeaders(stack.key) },
    ];
    for (const testCase of cases) {
      const res = await request(stack.solo.port, testCase.path, {
        method: testCase.method,
        headers: testCase.headers,
      });
      assert.equal(res.headers['cache-control'], 'no-store', `${testCase.method} ${testCase.path}`);
    }
  });
});

// ---------- hub upgrade wiring ----------

interface UpgradeOutcome {
  upgraded: boolean;
  status?: number;
}

function upgradeRequest(port: number, path: string): Promise<UpgradeOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: UpgradeOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.from('the sample nonce').toString('base64'),
      },
    });
    req.on('upgrade', (res) => {
      settle({ upgraded: true, status: res.statusCode });
      req.destroy();
    });
    req.on('response', (res) => {
      res.resume();
      settle({ upgraded: false, status: res.statusCode });
    });
    req.on('error', () => settle({ upgraded: false }));
    req.end();
  });
}

describe('hub upgrade wiring (P1 allowlist at the front)', () => {
  it('forwards /hub/connection/websocket upgrades to config.hubPort and relays 101', async () => {
    const hubUpgrades: number[] = [];
    const hub = http.createServer((_req, res) => res.end());
    hub.on('upgrade', (_req, socket) => {
      hubUpgrades.push(1);
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n',
      );
      socket.end();
    });
    await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
    const hubAddress = hub.address();
    assert.ok(hubAddress !== null && typeof hubAddress === 'object');
    const stack = await startStack({ hubPort: hubAddress.port });
    after(() => stopStack(stack));
    after(
      () =>
        new Promise<void>((done) => {
          hub.closeAllConnections?.();
          hub.close(() => done());
        }),
    );

    const outcome = await upgradeRequest(stack.solo.port, '/hub/connection/websocket');
    assert.equal(outcome.upgraded, true);
    assert.equal(outcome.status, 101);
    assert.equal(hubUpgrades.length, 1);
  });

  it('non-allowlist upgrade paths are rejected without touching the hub child', async () => {
    const hubUpgrades: number[] = [];
    const hub = http.createServer((_req, res) => res.end());
    hub.on('upgrade', (_req, socket) => {
      hubUpgrades.push(1);
      socket.end();
    });
    await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
    const hubAddress = hub.address();
    assert.ok(hubAddress !== null && typeof hubAddress === 'object');
    const stack = await startStack({ hubPort: hubAddress.port });
    after(() => stopStack(stack));
    after(
      () =>
        new Promise<void>((done) => {
          hub.closeAllConnections?.();
          hub.close(() => done());
        }),
    );

    const wrongPath = await upgradeRequest(stack.solo.port, '/hub/connection/other');
    assert.equal(wrongPath.upgraded, false);
    const outsideHub = await upgradeRequest(stack.solo.port, '/elsewhere');
    assert.equal(outsideHub.upgraded, false);
    // The front answered both itself; the hub never saw an upgrade.
    assert.equal(hubUpgrades.length, 0);
  });
});
