import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerFtownOpencodePlugin as registerNative } from '../opencode-plugin/ftown.js';

// Unit business mocks sit behind the injected encrypted-CLI transport seam. Hooks retain their separate credential.
function registerFtownOpencodePlugin(api: any, options: any = {}) {
  return registerNative(api, { ...options, proxy: async (path: string, init: RequestInit = {}) => {
    const port = options.env?.FTOWN_HOOK_PORT || '4321';
    const headers = new Headers(init.headers);
    return options.fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
  } });
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t: { after: (fn: () => void) => void }) {
  let now = 0; let seq = 0;
  let messages = [{ id: 'm1', body: 'private task body', from: 'parent' }];
  const requests: { url: string; init?: RequestInit }[] = [];
  const prompts: { path: { id: string }; body: { parts: { text: string }[] } }[] = [];
  const timers = new Map<number, () => void>();
  let submit: (call: unknown) => Promise<unknown> = async () => ({ data: {} });
  let peek: () => Promise<unknown> = async () => ({ messages });
  let root = { id: 'ses_root', parentID: undefined as string | undefined };
  const hooks = registerFtownOpencodePlugin({ session: {
    get: async () => ({ data: root }),
    prompt: async (call: any) => { prompts.push(call); return submit(call); },
  } } as any, {
    env: { FTOWN_SESSION_ID: 'ftown-session', FTOWN_HOOK_PORT: '4321', FTOWN_HOOK_TOKEN: 'secret' },
    now: () => now,
    schedule: (fn: () => void) => { const id = ++seq; timers.set(id, fn); return id; },
    cancel: (id: number) => { timers.delete(id); },
    readBridgePointer: async () => null,
    fetch: async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return { ok: true, json: async () => url.includes('/inbox') ? peek() : { ok: true } };
    },
  } as any);
  t.after(() => hooks.dispose());
  return { hooks, requests, prompts, timers,
    setMessages(value: typeof messages) { messages = value; },
    setSubmit(value: typeof submit) { submit = value; },
    setPeek(value: typeof peek) { peek = value; },
    setRoot(value: typeof root) { root = value; },
    event: (type: string, properties: unknown) => hooks.event({ event: { type, properties } }),
    async advance(ms = 5_000) { now += ms; const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); await tick(); await tick(); },
  };
}

describe('OpenCode native mail wake', () => {
  it('uses authenticated heartbeat peeks and native pointer only, without consuming mail', async t => {
    const f = fixture(t);
    await f.event('session.created', { info: { id: 'ses_root' } });
    assert.equal(f.prompts.length, 1);
    assert.equal(f.prompts[0].path.id, 'ses_root');
    const text = f.prompts[0].body.parts[0].text;
    assert.match(text, /ftown harness mail read/); assert.ok(!text.includes('private task body'));
    const peeks = f.requests.filter(request => request.url.includes('/inbox'));
    assert.ok(peeks.length); for (const request of peeks) {
      const query = new URL(request.url).searchParams;
      assert.equal(query.get('peek'), '1'); assert.equal(query.get('wait'), '0');
      assert.equal(query.get('adapter'), 'opencode'); assert.equal(query.get('nativeSessionId'), 'ses_root');
      assert.equal(new Headers(request.init?.headers).get('authorization'), null);
    }
    await f.event('session.idle', { sessionID: 'ses_root' }); await f.advance();
    assert.equal(f.prompts.length, 1, 'same unread IDs never repeat');
  });

  it('polls independently while idle and while a native prompt is in flight, preserving concurrent arrivals', async t => {
    const f = fixture(t); const pending = deferred<unknown>(); f.setSubmit(() => pending.promise);
    await f.event('session.created', { info: { id: 'ses_root' } });
    assert.equal(f.prompts.length, 1);
    f.setMessages([{ id: 'm1', body: 'private task body', from: 'parent' }, { id: 'm2', body: 'later', from: 'parent' }]);
    await f.advance(); assert.equal(f.prompts.length, 1); assert.equal(f.requests.filter(r => r.url.includes('/inbox')).length, 2);
    pending.resolve({ data: {} }); await tick(); await f.advance();
    assert.equal(f.prompts.length, 2, 'new unread ID gets a later wake');
    assert.ok(f.requests.filter(r => r.url.includes('/inbox')).every(r => new URL(r.url).searchParams.get('peek') === '1'));
    f.setMessages([]); await f.advance();
    f.setMessages([{ id: 'm3', body: 'another', from: 'parent' }]); await f.advance();
    assert.equal(f.prompts.length, 3, 'idle poll wakes without another lifecycle event');
  });

  it('keeps heartbeats while busy and submits once after idle even with duplicate boundary events', async t => {
    const f = fixture(t); f.setMessages([]);
    await f.event('session.created', { info: { id: 'ses_root' } });
    await f.event('session.status', { sessionID: 'ses_root', status: { type: 'busy' } });
    f.setMessages([{ id: 'm2', body: 'later', from: 'parent' }]); await f.advance();
    assert.equal(f.prompts.length, 0);
    await Promise.all([f.event('session.status', { sessionID: 'ses_root', status: { type: 'idle' } }), f.event('session.idle', { sessionID: 'ses_root' })]);
    assert.equal(f.prompts.length, 1);
    const events = f.requests.filter(r => r.url.endsWith('/hook')).map(r => JSON.parse(String(r.init?.body)).hook_event_name);
    assert.ok(events.includes('PreToolUse')); assert.ok(events.includes('Stop'));
  });

  it('retries explicit rejection with bounded backoff, but suppresses ambiguous failures', async t => {
    const f = fixture(t); f.setSubmit(async () => ({ error: 'rejected', response: { status: 400 } }));
    await f.event('session.created', { info: { id: 'ses_root' } }); await tick();
    await f.event('session.idle', { sessionID: 'ses_root' }); assert.equal(f.prompts.length, 1);
    await f.advance(); assert.equal(f.prompts.length, 2);
    f.setSubmit(async () => { throw new Error('connection lost after submission'); });
    await f.advance(10_000); assert.equal(f.prompts.length, 3);
    await f.advance(60_000); assert.equal(f.prompts.length, 3);
  });

  it('ignores subagents and foreign-session events and never mistakes a message ID for a session ID', async t => {
    const f = fixture(t);
    await f.event('session.created', { info: { id: 'ses_child', parentID: 'ses_root' } });
    await f.event('message.updated', { info: { id: 'msg_1', sessionID: 'ses_child', role: 'user' } });
    assert.equal(f.requests.length, 0);
    await f.event('message.updated', { info: { id: 'msg_2', sessionID: 'ses_root', role: 'user' } });
    await f.event('session.idle', { sessionID: 'ses_root' });
    assert.equal(f.prompts[0].path.id, 'ses_root');
    await f.event('session.idle', { sessionID: 'ses_foreign' });
    assert.ok(f.requests.filter(r => r.url.endsWith('/hook')).every(r => JSON.parse(String(r.init?.body)).session_id === 'ses_root'));
  });

  it('shutdown invalidates pending callbacks and clears polling; manual runs stay inert', async t => {
    const f = fixture(t); const pending = deferred<unknown>(); f.setSubmit(() => pending.promise);
    await f.event('session.created', { info: { id: 'ses_root' } });
    await f.event('session.deleted', { sessionID: 'ses_root' }); assert.equal(f.timers.size, 0);
    pending.resolve({ data: {} }); await tick(); await f.advance(); assert.equal(f.prompts.length, 1);
    const manual = registerFtownOpencodePlugin({} as any, { env: {}, fetch: () => { throw new Error('must not fetch'); } });
    await manual.event({ event: { type: 'session.created', properties: { info: { id: 'manual' } } } }); manual.dispose();
  });
});


it('competing roots disable native wakes and fence delayed peeks while known-root lifecycle forwarding survives', async t => {
  const f = fixture(t); f.setMessages([]);
  await f.event('session.created', { info: { id: 'ses_root' } });
  const pending = deferred<unknown>(); f.setPeek(() => pending.promise);
  await f.advance();
  await f.event('session.created', { info: { id: 'ses_other_root' } });
  pending.resolve({ messages: [{ id: 'late', body: 'late', from: 'parent' }] }); await tick();
  assert.equal(f.prompts.length, 0); assert.equal(f.timers.size, 0);
  await f.event('session.idle', { sessionID: 'ses_root' });
  const hooks = f.requests.filter(r => r.url.endsWith('/hook')).map(r => JSON.parse(String(r.init?.body)));
  assert.ok(hooks.some(hook => hook.hook_event_name === 'Stop' && hook.session_id === 'ses_root'));
  const reads = f.requests.filter(r => r.url.includes('/inbox')).length; await f.advance();
  assert.equal(f.requests.filter(r => r.url.includes('/inbox')).length, reads);
});
it('ordinary model/session errors preserve later idle polling and native mail delivery', async t => {
  const f = fixture(t); f.setMessages([]);
  await f.event('session.created', { info: { id: 'ses_root' } });
  await f.event('session.error', { sessionID: 'ses_root' });
  f.setMessages([{ id: 'after-error', body: 'later', from: 'parent' }]); await f.advance();
  assert.equal(f.prompts.length, 1); assert.equal(f.prompts[0].path.id, 'ses_root');
});

it('late-loaded plugin disables native wake when another pre-existing root is verified', async t => {
  const f = fixture(t); f.setMessages([]);
  await f.event('message.updated', { info: { id: 'msg_first', sessionID: 'ses_root', role: 'user' } });
  await f.event('session.idle', { sessionID: 'ses_root' });
  const pending = deferred<unknown>(); f.setPeek(() => pending.promise); await f.advance();
  f.setRoot({ id: 'ses_other_existing', parentID: undefined });
  await f.event('session.idle', { sessionID: 'ses_other_existing' });
  pending.resolve({ messages: [{ id: 'late', body: 'late', from: 'parent' }] }); await tick();
  assert.equal(f.prompts.length, 0); assert.equal(f.timers.size, 0);
  await f.event('session.idle', { sessionID: 'ses_root' });
  const hooks = f.requests.filter(r => r.url.endsWith('/hook')).map(r => JSON.parse(String(r.init?.body)));
  assert.equal(hooks.at(-1).session_id, 'ses_root'); assert.equal(hooks.at(-1).hook_event_name, 'Stop');
});
