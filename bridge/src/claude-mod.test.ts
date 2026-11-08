import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MailDeliveryService, MAIL_WAKE_TEXT } from './mail-delivery.js';
import { MailStore } from './mail-store.js';
import { nativeWake } from './security/bridge/native-wake.js';
import type { Session } from './types.js';

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

test('a busy poll is ignored without touching plugin state; the next non-busy poll decides', async () => {
  const f = fixture();
  f.setFetch(async () => ({ ok: true, status: 200, text: JSON.stringify({ messages: [{ id: 'one' }], busy: true }) }));
  await f.fire('session.start'); await f.tick(); await f.tick();
  assert.equal(f.prompts.length, 0, 'mid-turn: the Stop hook delivers this mail, so no wake is queued');
  f.setFetch(async () => ({ ok: true, status: 200, text: JSON.stringify({ messages: [{ id: 'one' }] }) }));
  await f.tick();
  assert.equal(f.prompts.length, 1);
  // The wake was admitted, so `one` is handled; busy and non-busy polls afterwards must not re-wake.
  f.setFetch(async () => ({ ok: true, status: 200, text: JSON.stringify({ messages: [{ id: 'one' }], busy: true }) }));
  await f.tick();
  f.setFetch(async () => ({ ok: true, status: 200, text: JSON.stringify({ messages: [{ id: 'one' }] }) }));
  await f.tick(); await f.tick();
  assert.equal(f.prompts.length, 1, 'a busy poll must not clear the handled set');
});

test('the wake prompt is the bridge MAIL_WAKE_TEXT, not a directive to read mail', async () => {
  const f = fixture(); f.setMessages([{ id: 'one' }]);
  await f.fire('session.start'); await f.tick();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0], MAIL_WAKE_TEXT);
  assert.doesNotMatch(f.prompts[0], /You have unread/);
  assert.equal(f.prompts[0].startsWith('[ftown mail]'), false);
});

// Real register.js + real nativeWake + real MailStore/MailDeliveryService busy marking, with a fake Claude
// that queues submitted prompts while mid-turn and runs the classic hook pump (drain on Stop/UserPromptSubmit).
function wakeWorld(options: { pump: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-claude-mod-'));
  const sessions: Record<string, Session> = {
    orch: { id: 'orch', name: 'orch', command: 'claude', status: 'running', bridgeId: 'b', createdAt: '', updatedAt: '', shellType: 'claude', claudeSessionId: 'native-orch' },
    worker: { id: 'worker', name: 'worker', command: 'claude', status: 'running', bridgeId: 'b', createdAt: '', updatedAt: '', shellType: 'claude', claudeSessionId: 'native-worker', parentSessionId: 'orch' },
  };
  const mailStore = new MailStore(id => join(dir, 'sessions', id));
  const store = { loadSession: async (id: string) => sessions[id] ?? null, listSessions: async () => Object.values(sessions) };
  const runner = { isRunning: () => true, write: () => true };
  const mail = new MailDeliveryService({ store, mailStore, runner, setTimeout: () => ({}), clearTimeout: () => {} });
  const orch = sessions.orch;
  const drain = async () => {
    const result = await mail.readMail(orch, { wait: 0, peek: false, all: false, limit: 50 });
    return result.kind === 'immediate' ? result.messages : [];
  };
  const submitted: string[] = [];
  const heartbeats: Array<{ ids: string[]; busy: boolean }> = [];
  const modelReads: number[] = [];
  const hookDrains: number[] = [];
  let busy = false;
  const queue: Array<(result: unknown) => void> = [];
  // Wake turns drain via real filesystem I/O (threadpool), so fixed setImmediate rounds can finish before they do
  // on a slower FS; poll() awaits these explicitly instead.
  const turns = new Set<Promise<void>>();
  const endTurn = async (): Promise<void> => {
    if (options.pump) { const drained = await drain(); if (drained.length) hookDrains.push(drained.length); }
    mail.markAgentIdle('orch'); busy = false;
    const next = queue.shift();
    if (next) { next({ text: 'accepted' }); await settle(); await runTurn(true); }
  };
  const runTurn = async (isWake: boolean): Promise<void> => {
    busy = true; mail.markAgentBusy('orch');
    if (options.pump) { const drained = await drain(); if (drained.length) hookDrains.push(drained.length); }
    if (isWake) modelReads.push((await drain()).length); // the model obeys "run `ftown harness mail read`"
    await endTurn();
  };
  const env: Record<string, string> = { FTOWN_SESSION_ID: 'orch', FTOWN_HOOK_PORT: '1', FTOWN_HOOK_TOKEN: 't', HOME: dir };
  let tick: () => Promise<void> = async () => {};
  const api = {
    env: { get: async (name: string) => env[name] },
    session: { id: async () => 'native-orch' },
    clock: { every: (_ms: number, callback: () => Promise<void>) => { tick = callback; return { cancel() {} }; }, now: async () => 0 },
    fs: { read: async (): Promise<string> => { throw new Error('no pointer'); } },
    http: { fetch: async (_url: string, init: { body: string }) => {
      try {
        const result = await nativeWake(JSON.parse(init.body) as unknown, {
          getSession: id => store.loadSession(id),
          register: (session, registration) => mail.registerNativeWake(session, registration),
          unread: id => mailStore.listUndelivered(id),
          busy: id => mail.isAgentRecentlyBusy(id),
        });
        heartbeats.push({ ids: result.messages.map(message => message.id), busy: 'busy' in result && result.busy === true });
        return { ok: true, status: 200, text: JSON.stringify(result) };
      } catch { return { ok: false, status: 409, text: '{}' }; }
    } },
    prompt: { submit: ({ text }: { text: string }) => new Promise<unknown>(resolve => {
      submitted.push(text);
      if (busy) { queue.push(resolve); return; }
      resolve({ text: 'accepted' });
      const turn = settle().then(() => runTurn(true));
      turns.add(turn); void turn.finally(() => turns.delete(turn));
    }) },
  };
  const hooks = new Map<string, Hook>();
  register((name, handler) => hooks.set(name, handler));
  return {
    submitted, heartbeats, modelReads, hookDrains, mail, mailStore, endTurn,
    start: async () => { await hooks.get('session.start')?.(api, {}, async event => event); },
    poll: async () => {
      await tick();
      for (let i = 0; i < 20; i += 1) await settle();
      while (turns.size) await Promise.all([...turns]);
    },
    send: async (from: 'orch' | 'worker', to: 'orch' | 'worker', body: string) => {
      const result = await mail.acceptMail(sessions[to], { body, from, fromName: from });
      assert.equal(result.ok, true);
    },
    beginTurn: () => { busy = true; mail.markAgentBusy('orch'); },
    done: () => { mail.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('S2 regression: mail arriving mid-turn is delivered by the Stop pump and never produces a stale wake', async () => {
  const w = wakeWorld({ pump: true });
  try {
    await w.start();
    w.beginTurn();
    await w.send('worker', 'orch', 'ack: picked up repair round 2');
    await w.poll(); await w.poll();
    assert.equal(w.submitted.length, 0, 'no wake may be queued while the session is mid-turn');
    assert.equal(w.heartbeats.length, 2, 'the plugin polled both times');
    assert.ok(w.heartbeats.every(h => h.busy && h.ids.length === 1), 'both polls saw the mail while the bridge reported busy');
    await w.endTurn(); // Stop pump drains the inbox, then the session goes idle
    assert.deepEqual(w.hookDrains, [1]);
    await w.poll(); await w.poll();
    assert.equal(w.submitted.length, 0, 'the drained mail must not wake the session afterwards');
    assert.equal(w.heartbeats.length, 4, 'the plugin polled after the Stop pump');
    assert.deepEqual(w.heartbeats.slice(2).map(h => h.busy), [false, false], 'post-Stop polls are non-busy');
    assert.deepEqual(w.modelReads, []);
  } finally { w.done(); }
});

test('wake liveness: idle mail with no pump wakes once and the consuming read returns the mail', async () => {
  const w = wakeWorld({ pump: false });
  try {
    await w.start();
    await w.send('worker', 'orch', 'hello');
    await w.poll(); await w.poll(); await w.poll();
    assert.equal(w.submitted.length, 1);
    assert.deepEqual(w.modelReads, [1]);
  } finally { w.done(); }
});

test('wake liveness: busy mail the Stop pump does not drain wakes exactly once after idle', async () => {
  const w = wakeWorld({ pump: false });
  try {
    await w.start();
    w.beginTurn();
    await w.send('worker', 'orch', 'hello');
    await w.poll(); await w.poll();
    assert.equal(w.submitted.length, 0);
    assert.equal(w.heartbeats.length, 2, 'the plugin polled both times');
    assert.ok(w.heartbeats.every(h => h.busy && h.ids.length === 1), 'both polls saw the mail while the bridge reported busy');
    await w.endTurn();
    await w.poll(); await w.poll();
    assert.equal(w.submitted.length, 1);
    assert.deepEqual(w.modelReads, [1]);
  } finally { w.done(); }
});

test('wake liveness: the session\'s own outgoing mail never wakes it, and a fresh later message does', async () => {
  const w = wakeWorld({ pump: false });
  try {
    await w.start();
    await w.send('orch', 'worker', 'task for worker');
    await w.poll(); await w.poll();
    assert.equal(w.submitted.length, 0);
    assert.equal(w.heartbeats.length, 2, 'the plugin polled both times');
    assert.ok(w.heartbeats.every(h => h.ids.length === 0 && !h.busy), 'the sender never sees its own outgoing mail as unread');
    await w.send('worker', 'orch', 'first');
    await w.poll(); await w.poll();
    assert.equal(w.submitted.length, 1);
    await w.send('worker', 'orch', 'second');
    await w.poll(); await w.poll();
    assert.equal(w.submitted.length, 2);
    assert.deepEqual(w.modelReads, [1, 1]);
  } finally { w.done(); }
});
