import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { api, fetchInbox, loadPointer, resolveSessionId, sendMail } from './cli-client.js';
import { secureFixture } from './security/bridge/fixtures.test.js';
import type { Session } from './wire-types.js';

test('shared request encrypts bodies and caller metadata, preserves API errors, and rejects old pointers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ftown-cli-secure-'));
  let request: RequestInit | undefined;
  const secure = await secureFixture(directory, (async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:1234/api/sessions'); request = init;
    return new Response('{"ok":true}');
  }) as typeof fetch);
  try {
    assert.deepEqual(await api(secure.pointer, 'POST', '/api/sessions', { text: 'literal $ value' },
      { 'X-Ftown-Session-Id': 'caller' }, undefined, secure.fetch), { ok: true });
    assert.deepEqual(request?.headers, { 'x-ftown-session-id': 'caller' });
    assert.equal(request?.body, '{"text":"literal $ value"}');
    await assert.rejects(api({ port: 1234, token: 'old' }, 'GET', '/api/sessions'), { code: 'upgrade_required' });
  } finally { await secure.security.close(); rmSync(directory, { recursive: true, force: true }); }
  const denied = mkdtempSync(join(tmpdir(), 'ftown-cli-denied-'));
  const rejected = await secureFixture(denied, (async () => new Response('{"error":"denied"}', { status: 403 })) as typeof fetch);
  try { await assert.rejects(api(rejected.pointer, 'GET', '/api/sessions', undefined, undefined, undefined, rejected.fetch), /denied/); }
  finally { await rejected.security.close(); rmSync(denied, { recursive: true, force: true }); }
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

test('mail groups preserve inbox queries and send payload through authenticated envelopes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ftown-cli-mail-'));
  const original = globalThis.fetch; const calls: Array<{ url: string; init?: RequestInit }> = [];
  const secure = await secureFixture(directory, (async (url, init) => { calls.push({ url: String(url), init });
    return new Response(init?.method === 'POST' ? '{"id":"m1"}' : '{"messages":[]}'); }) as typeof fetch);
  globalThis.fetch = secure.fetch;
  try {
    assert.deepEqual(await fetchInbox(secure.pointer, 'self', { peek: true, all: true, limit: 7 }), []);
    assert.match(calls[0].url, /wait=0&peek=1&limit=7&all=1/);
    assert.deepEqual(await sendMail(secure.pointer, 'parent', { body: 'done', type: 'result' }), { id: 'm1' });
    assert.equal(calls[1].init?.body, '{"body":"done","type":"result"}');
  } finally { globalThis.fetch = original; await secure.security.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('session resolution retains exact/name/prefix and ambiguity behavior', () => {
  const sessions = [{ id: 'abcdef123', name: 'build api' }, { id: 'abcdefgh4', name: 'build ui' }] as Session[];
  assert.equal(resolveSessionId(sessions, 'build api'), 'abcdef123');
  assert.equal(resolveSessionId(sessions, 'abcdef12'), 'abcdef123');
  assert.throws(() => resolveSessionId(sessions, 'build'), /Ambiguous/);
  assert.throws(() => resolveSessionId(sessions, 'missing'), /No session/);
});
