import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

type Response = { ok: boolean; status: number; text: string };
type Hook = (api: unknown, event: Record<string, unknown>, next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<unknown>;
const code = readFileSync(new URL('../claude-mod/hooks/register.js', import.meta.url), 'utf8');
const register = new Function(code.replace('export function register', 'function register') + '\nreturn register;')() as (on: (name: string, handler: Hook) => void) => void;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const hooks = new Map<string, Hook>();
  const timers: Array<() => Promise<void>> = [];
  const requests: Array<{ url: string; token: string; body: Record<string, unknown> }> = [];
  const prompts: string[] = [];
  let identity = 'native-1';
  let readIdentity = async () => identity;
  let now = 0;
  let messages: Array<{ id: string; body?: string }> = [];
  const env: Record<string, string> = { FTOWN_SESSION_ID: 'ftown-1', FTOWN_HOOK_PORT: '1234', FTOWN_HOOK_TOKEN: 'test-token', HOME: '/scratch' };
  let fetch: (url: string) => Promise<Response> = async () => ({ ok: true, status: 200, text: JSON.stringify({ messages }) });
  let submit: () => Promise<unknown> = async () => ({ text: 'accepted' });
  const api = {
    env: { get: async (name: string) => env[name] },
    session: { id: () => readIdentity() },
    clock: { now: async () => now, every: (_delay: number, callback: () => Promise<void>) => { assert.equal(_delay, 5000); timers.push(callback); return { cancel() {} }; } },
    fs: { read: async (path: string) => { assert.equal(path, '/scratch/.ftown/bridge.json'); return JSON.stringify({ port: 2345, token: 'new-token' }); } },
    http: { fetch: async (url: string, options: { body: string; headers: { Authorization: string } }) => { requests.push({ url, token: options.headers.Authorization, body: JSON.parse(options.body) as Record<string, unknown> }); return fetch(url); } },
    prompt: { submit: ({ text }: { text: string }) => { prompts.push(text); return submit(); } },
  };
  register((name, handler) => hooks.set(name, handler));
  const fire = async (name: string) => hooks.get(name)?.(api, {}, async (event) => event);
  return {
    api, env, timers, requests, prompts, fire,
    setIdentity: (value: string) => { identity = value; },
    setReadIdentity: (value: typeof readIdentity) => { readIdentity = value; },
    setMessages: (value: typeof messages) => { messages = value; },
    setFetch: (value: typeof fetch) => { fetch = value; },
    setSubmit: (value: typeof submit) => { submit = value; },
    tick: async (advance = 5000) => { now += advance; for (const callback of timers) await callback(); await settle(); },
  };
}

test('manual sessions are inert; native wakes contain no body and never drain inbox', async () => {
  const manual = fixture(); delete manual.env.FTOWN_SESSION_ID;
  await manual.fire('session.start'); assert.equal(manual.timers.length, 0);
  const f = fixture(); f.setMessages([{ id: 'mail-1', body: 'PRIVATE MAIL BODY' }]);
  await f.fire('session.start'); await f.tick(); await f.tick();
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0], /ftown harness mail read/);
  assert.doesNotMatch(f.prompts[0], /PRIVATE MAIL BODY|mail-1/);
  for (const request of f.requests) {
    assert.equal(new URL(request.url).pathname, '/hook');
    assert.equal(request.body.hook_event_name, 'FtownNativeWake');
    assert.equal(request.body.adapter, 'claude-mod'); assert.equal(request.body.session_id, 'native-1');
    assert.equal(request.body.registerWake, true);
    assert.equal(request.token, 'Bearer test-token');
  }
  f.setMessages([]); await f.tick(); f.setMessages([{ id: 'mail-2' }]); await f.tick();
  assert.equal(f.prompts.length, 2);
});

test('identity is fenced again inside deferred submission', async () => {
  const f = fixture(); let reads = 0;
  f.setMessages([{ id: 'one' }]);
  f.setReadIdentity(async () => ++reads >= 4 ? 'native-2' : 'native-1');
  await f.fire('session.start'); await f.tick();
  assert.equal(f.prompts.length, 0, 'identity changed after polling but before deferred submit');
  await f.tick();
  assert.equal(f.prompts.length, 1);
});

test('heartbeats continue while one wake waits; new arrivals get a later wake', async () => {
  const f = fixture(); let release: (result: unknown) => void = () => {};
  f.setSubmit(() => new Promise((resolve) => { release = resolve; }));
  f.setMessages([{ id: 'one' }]); await f.fire('session.start'); await f.tick();
  f.setMessages([{ id: 'one' }, { id: 'two' }]); await f.tick(); await f.tick();
  assert.equal(f.requests.length, 3); assert.equal(f.prompts.length, 1);
  release({ text: 'accepted' }); await settle(); f.setSubmit(async () => ({ text: 'accepted' })); await f.tick();
  assert.equal(f.prompts.length, 2);
});

test('definite drops retry with a bound; unknown admission does not duplicate or keep renewing lease', async () => {
  const f = fixture(); f.setMessages([{ id: 'one' }]); f.setSubmit(async () => ({ drop: 'policy' }));
  await f.fire('session.start');
  for (let n = 0; n < 10; n += 1) await f.tick(60000);
  assert.equal(f.prompts.length, 3);
  assert.equal(f.requests.at(-1)!.body.registerWake, false);
  const unknown = fixture(); unknown.setMessages([{ id: 'one' }]); unknown.setSubmit(async () => { throw new Error('transport uncertain'); });
  await unknown.fire('session.start'); await unknown.tick(); await unknown.tick(60000);
  assert.equal(unknown.prompts.length, 1);
  assert.equal(unknown.requests.at(-1)!.body.registerWake, false);
});

test('identity changes fence pending receipt and polling callbacks; clear/resume retain polling', async () => {
  const f = fixture(); const releases: Array<(result: unknown) => void> = [];
  f.setSubmit(() => new Promise((resolve) => { releases.push(resolve); }));
  f.setMessages([{ id: 'one' }]); await f.fire('session.start'); await f.tick();
  await f.fire('session.end'); f.setIdentity('native-2'); await f.tick();
  assert.equal(f.prompts.length, 2, 'an unresolved old-generation promise must not block the new identity');
  releases[0]({ text: 'accepted' }); await settle(); await f.tick();
  assert.equal(f.prompts.length, 2, 'old finally must not clear the new pending submission');
  releases[1]({ text: 'accepted' }); await settle(); await f.tick();
  assert.equal(f.prompts.length, 2);
  assert.equal(f.requests.at(-1)!.body.session_id, 'native-2');
});

test('bridge restart recovers using current pointer; identity conflicts never submit', async () => {
  const f = fixture(); f.setMessages([{ id: 'one' }]);
  f.setFetch(async (url) => {
    if (new URL(url).port === '1234') throw new Error('old port closed');
    return { ok: true, status: 200, text: JSON.stringify({ messages: [{ id: 'one' }] }) };
  });
  await f.fire('session.start'); await f.tick();
  assert.equal(f.prompts.length, 1); assert.equal(f.requests.at(-1)!.token, 'Bearer new-token');
  const conflict = fixture(); conflict.setFetch(async () => ({ ok: false, status: 409, text: '{}' }));
  await conflict.fire('session.start'); await conflict.tick();
  assert.equal(conflict.prompts.length, 0); assert.equal(conflict.requests.length, 1);
});
