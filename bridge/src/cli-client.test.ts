import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { api, fetchInbox, loadPointer, resolveSessionId, sendMail } from './cli-client.js';
import type { Session } from './wire-types.js';

test('shared request preserves caller headers/body, loopback URL and API errors', async () => {
  const pointer = { port: 1234, token: 'local' };
  let request: RequestInit | undefined;
  const fake = (async (url: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(url, 'http://127.0.0.1:1234/api/test'); request = init;
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await api(pointer, 'POST', '/api/test', { text: 'literal $ value' }, { 'X-Ftown-Session-Id': 'caller' }, undefined, fake), { ok: true });
  assert.deepEqual(request?.headers, { Authorization: 'Bearer local', 'X-Ftown-Session-Id': 'caller', 'Content-Type': 'application/json' });
  assert.equal(request?.body, '{"text":"literal $ value"}');
  await assert.rejects(api(pointer, 'GET', '/api/test', undefined, undefined, undefined, (async () => new Response('{"error":"denied"}', { status: 403 })) as typeof fetch), /denied/);
  await assert.rejects(api(pointer, 'GET', '/api/test', undefined, undefined, undefined, (async () => new Response('not json', { status: 500 })) as typeof fetch), /HTTP 500/);
});

test('pointer is read lazily and validates its local port', () => {
  const previous = process.env.HOME; const home = mkdtempSync(join(tmpdir(), 'ftown-pointer-')); process.env.HOME = home;
  try {
    assert.throws(loadPointer, /Bridge not running/);
    mkdirSync(join(home, '.ftown')); const path = join(home, '.ftown/bridge.json');
    writeFileSync(path, '{"port":1234,"token":"new"}'); assert.equal(loadPointer().token, 'new');
    writeFileSync(path, '{"port":70000,"token":"new"}'); assert.throws(loadPointer, /Invalid/);
  } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; rmSync(home, { recursive: true, force: true }); }
});

test('mail groups use the same inbox query and send payload helpers', async () => {
  const original = globalThis.fetch; const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url, init) => { calls.push({ url: String(url), init }); return new Response(init?.method === 'POST' ? '{"id":"m1"}' : '{"messages":[]}'); }) as typeof fetch;
  try {
    const pointer = { port: 1234, token: 'local' };
    assert.deepEqual(await fetchInbox(pointer, 'self', { peek: true, all: true, limit: 7 }), []);
    assert.match(calls[0].url, /wait=0&peek=1&limit=7&all=1/);
    assert.deepEqual(await sendMail(pointer, 'parent', { body: 'done', type: 'result' }), { id: 'm1' });
    assert.equal(calls[1].init?.body, '{"body":"done","type":"result"}');
  } finally { globalThis.fetch = original; }
});

test('session resolution retains exact/name/prefix and ambiguity behavior', () => {
  const sessions = [{ id: 'abcdef123', name: 'build api' }, { id: 'abcdefgh4', name: 'build ui' }] as Session[];
  assert.equal(resolveSessionId(sessions, 'build api'), 'abcdef123');
  assert.equal(resolveSessionId(sessions, 'abcdef12'), 'abcdef123');
  assert.throws(() => resolveSessionId(sessions, 'build'), /Ambiguous/);
  assert.throws(() => resolveSessionId(sessions, 'missing'), /No session/);
});
