import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserAccess } from './browser-access.js';
import type { Command, CommandResponse } from './types.js';

const origin = 'https://ftown.ia.br';
const other = 'https://preview.example.com';
const bootstrap = () => ({ version: 1 as const, userId: 'local', bridgeId: 'bridge-1', hostname: 'laptop', localPort: 1234, localNonce: 'admin-secret' });
async function fixture(execute: (c: Command) => Promise<CommandResponse> = async c => ({ requestId: c.requestId, success: true })) {
  const dataDir = mkdtempSync(join(tmpdir(), 'browser-access-'));
  let revoked = 0;
  const opts = { dataDir, allowedOrigins: [origin, other], bootstrap, execute, onRevoke: () => { revoked++; } };
  let access = new BrowserAccess(opts);
  const server = createServer((req, res) => { void access.handle(req, res, req.headers.authorization === 'Bearer admin' && !req.headers.origin); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  async function call(path: string, method = 'GET', body?: unknown, token = '', requestOrigin = origin) {
    const response = await fetch(`http://127.0.0.1:${address!.port}/api/browser/${path}`, { method, headers: { ...(requestOrigin ? { Origin: requestOrigin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const admin = (path: string, method = 'GET', body?: unknown) => call(path, method, body, 'admin', '');
  async function pair(remember = true) {
    await admin('window', 'POST', {});
    const request = await call('pairings', 'POST', { remember });
    assert.equal(request.status, 201);
    await admin(`pairings/${request.body.id}/decision`, 'POST', { approve: true });
    const result = await call(`pairings/${request.body.id}`, 'GET', undefined, request.body.pollToken);
    return { ...request.body, token: result.body.credential as string };
  }
  return { get access() { return access; }, dataDir, call, admin, pair, get revoked() { return revoked; }, restart() { access.close(); access = new BrowserAccess(opts); }, async close() { access.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dataDir, { recursive: true, force: true }); } };
}

test('HTTP consent gates access, binds origin, persists only hashes, revokes and survives restart', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('pairings', 'POST', { remember: true })).status, 409);
    assert.equal((await f.call('bootstrap', 'POST', {})).status, 401);
    assert.equal((await f.call('window', 'POST', {}, 'admin')).status, 401);
    assert.equal((await f.call('pairings', 'POST', { remember: true }, '', 'https://evil.test')).status, 403);
    const p = await f.pair();
    const good = await f.call('bootstrap', 'POST', {}, p.token);
    assert.equal(good.status, 200); assert.equal(good.body.localNonce, p.token);
    assert.equal(f.access.authorize(p.token, origin), true);
    assert.equal((await f.call('bootstrap', 'POST', {}, p.token, other)).status, 401);
    assert.equal((await f.call(`pairings/${p.id}`, 'GET', undefined, p.pollToken, other)).status, 401);
    assert.equal((await f.call(`pairings/${p.id}`, 'GET', undefined, p.token)).status, 401);
    assert.equal((await f.call(`pairings/${p.id}`, 'GET', undefined, p.pollToken)).body.credential, p.token);
    assert.equal((await f.admin(`pairings/${p.id}/decision`, 'POST', { approve: false })).status, 409);
    const disk = readFileSync(join(f.dataDir, 'browser-devices.json'), 'utf8');
    assert.ok(!disk.includes(p.token)); assert.ok(!disk.includes(p.pollToken));
    f.restart(); assert.equal(f.access.authorize(p.token, origin), true);
    const devices = await f.admin('devices');
    const id = devices.body.devices[0].id;
    assert.equal((await f.admin(`devices/${id}`, 'DELETE')).status, 200);
    assert.equal(f.revoked, 1); assert.equal(f.access.authorize(p.token, origin), false);
    f.restart(); assert.equal(f.access.authorize(p.token, origin), false);
  } finally { await f.close(); }
});

test('denial, expiry, replacement, session-only credentials and pairing caps', async () => {
  const f = await fixture(); const now = Date.now;
  try {
    const session = await f.pair(false); f.restart(); assert.equal(f.access.authorize(session.token, origin), false);
    await f.admin('window', 'POST', {});
    const p = await f.call('pairings', 'POST', { remember: false });
    await f.admin(`pairings/${p.body.id}/decision`, 'POST', { approve: false });
    assert.deepEqual((await f.call(`pairings/${p.body.id}`, 'GET', undefined, p.body.pollToken)).body, { status: 'denied' });
    await f.admin('window', 'POST', {});
    assert.equal((await f.call(`pairings/${p.body.id}`, 'GET', undefined, p.body.pollToken)).status, 401);
    const expiring = await f.call('pairings', 'POST', { remember: false });
    const timestamp = now(); Date.now = () => timestamp + 120_001;
    assert.equal((await f.admin(`pairings/${expiring.body.id}/decision`, 'POST', { approve: true })).status, 404);
    assert.equal((await f.call('pairings', 'POST', { remember: false })).status, 409);
    Date.now = now;
    await f.admin('window', 'POST', {});
    for (let i = 0; i < 5; i++) assert.equal((await f.call('pairings', 'POST', { remember: false })).status, 201);
    assert.equal((await f.call('pairings', 'POST', { remember: false })).status, 429);
  } finally { Date.now = now; await f.close(); }
});

test('same request shares in-flight execution, conflicts reject, device namespaces differ', async () => {
  let calls = 0; let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async c => { calls++; await pending; return { requestId: c.requestId, success: true, data: calls }; });
  try {
    const p = await f.pair();
    const body = { type: 'list_sessions', payload: { bridgeId: 'bridge-1' }, requestId: 'one' };
    const a = f.call('commands', 'POST', body, p.token);
    const b = f.call('commands', 'POST', body, p.token);
    const conflict = await f.call('commands', 'POST', { ...body, type: 'list_loops' }, p.token);
    assert.equal(conflict.status, 409); assert.equal(calls, 1);
    release(); assert.deepEqual((await a).body, (await b).body);
    assert.equal((await f.call('commands', 'POST', body, p.token)).status, 200); assert.equal(calls, 1);
    assert.equal((await f.call('commands', 'POST', { ...body, payload: { bridgeId: 'other' } }, p.token)).status, 403);
    assert.equal((await f.call('commands', 'POST', { ...body, type: 'nonsense' }, p.token)).status, 400);
    const p2 = await f.pair(false); await f.call('commands', 'POST', body, p2.token); assert.equal(calls, 2);
  } finally { release(); await f.close(); }
});

test('events preserve bounded history, wake longpoll, cap requests and terminate on revoke', async () => {
  const f = await fixture();
  try {
    const p = await f.pair();
    const waiter = f.call('events?cursor=0', 'GET', undefined, p.token);
    const second = f.call('events?cursor=0', 'GET', undefined, p.token);
    assert.equal((await f.call('events?cursor=0', 'GET', undefined, p.token)).status, 429);
    f.access.publish('sessions', { sessionId: 'abc' });
    assert.deepEqual((await waiter).body.events, [{ channel: 'sessions', data: { sessionId: 'abc' } }]); await second;
    for (let i = 0; i < 300; i++) f.access.publish('sessions', { i });
    const result = await f.call('events?cursor=1', 'GET', undefined, p.token);
    assert.equal(result.body.reset, true); assert.equal(result.body.events.length, 256);
    const waiting = f.call(`events?cursor=${result.body.cursor}`, 'GET', undefined, p.token);
    const id = (await f.admin('devices')).body.devices[0].id;
    await f.admin(`devices/${id}`, 'DELETE'); assert.equal((await waiting).status, 401);
  } finally { await f.close(); }
});


test('CORS preflights require exact origin, methods and headers including private network permission', async () => {
  const f = await fixture();
  try {
    // Exercise IncomingMessage/ServerResponse through a real HTTP listener.
    const server = createServer((req, res) => { void f.access.handle(req, res, false); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    try {
      const url = `http://127.0.0.1:${address.port}/api/browser/bootstrap`;
      const headers = { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type', 'Access-Control-Request-Private-Network': 'true' };
      const response = await fetch(url, { method: 'OPTIONS', headers });
      assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
      assert.equal(response.headers.get('access-control-allow-credentials'), null);
      assert.equal((await fetch(url, { method: 'OPTIONS', headers: { ...headers, Origin: 'null' } })).status, 403);
      assert.equal((await fetch(url, { method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Headers': 'x-admin-token' } })).status, 403);
      assert.equal((await fetch(url, { method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Method': 'PUT' } })).status, 403);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  } finally { await f.close(); }
});

test('command capacity rejects before execution and completed cache entries expire', async () => {
  let calls = 0;
  const f = await fixture(async c => { calls++; return { requestId: c.requestId, success: true }; });
  const now = Date.now;
  try {
    const p = await f.pair();
    for (let i = 0; i < 1000; i++) {
      const result = await f.call('commands', 'POST', { type: 'list_sessions', payload: {}, requestId: String(i) }, p.token);
      assert.equal(result.status, 200);
    }
    assert.equal((await f.call('commands', 'POST', { type: 'list_sessions', payload: {}, requestId: 'overflow' }, p.token)).status, 429);
    assert.equal(calls, 1000);
    const timestamp = now(); Date.now = () => timestamp + 600_001;
    assert.equal((await f.call('commands', 'POST', { type: 'list_sessions', payload: {}, requestId: 'overflow' }, p.token)).status, 200);
    assert.equal(calls, 1001);
  } finally { Date.now = now; await f.close(); }
});
