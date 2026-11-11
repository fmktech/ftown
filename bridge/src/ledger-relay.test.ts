import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { UnauthorizedError } from 'centrifuge';
import {
  HEAD_ANNOUNCE_SPACING_MS, HEAD_ANNOUNCE_WARN_SPACING_MS, HttpStatusError, MISSING_RELAY_URL_MESSAGE, RELAY_LEDGER_MAX_SPACING_MS, UNKNOWN_ENDPOINT_REFRESH_SPACING_MS, createAccountRelay, subscribeApprovalRequired, createLedgerServer, httpStatusOf, isRefusal,
  parseRelayUrl, parseRetryAfter, readSavedRelayUrl, registerBridgeEndpoint, relayTokenFailureMessage, saveRelayUrl, type AccountRelayDeps, type AccountRelaySecurity,
} from './ledger-relay.js';
import type { LedgerHeadRelation, LedgerRelation } from './security/ledger/ledger.js';
import { generateAuthKey } from './security/ledger/proof.js';
import { HEAD_ANNOUNCE_MAX_AGE_MS, verifyHeadAnnouncement, type HeadAnnouncement } from './security/ledger/announce.js';
import type { LedgerCheckpoint } from './security/ledger/protocol.js';
import type { ServerLedgerRead } from './security/bridge/security.js';
import type { EndpointPublic } from './security/protocol.js';

const API = 'https://ftown.example';
const ACCOUNT = 'A'.repeat(43);
const LEDGER = { genesis: { payload: 'g' }, transitions: [] };
/** What the fake store holds: our chain and its head. */
const STORED = { ledger: LEDGER, checkpoint: { head: 'local-head' } };
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A one-hour JWT-shaped relay token. */
const JWT = `${b64({ alg: 'HS256' })}.${b64({ sub: ACCOUNT, iat: 1_000, exp: 4_600 })}.sig`;

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
interface Call { url: string; init: RequestInit | undefined; body: Record<string, unknown> | null }

/** Routes by path; each route answers from its queue (the last answer repeats). */
function fakeFetch(routes: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ url, init, body });
    const queue = routes[`${init?.method ?? 'GET'} ${path}`];
    if (!queue || queue.length === 0) throw new Error(`no route ${init?.method} ${path}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json', ...reply.headers } });
  };
  return { impl, calls, paths: () => calls.map(call => `${call.init?.method ?? 'GET'} ${new URL(call.url).pathname}`) };
}

function fakeSecurity(initialHead: string | null = 'local-head') {
  const log: string[] = [];
  /** noteServerHead calls, kept apart from `log`. */
  const heads: string[] = [];
  const state = { head: initialHead, revision: initialHead === null ? null : 3 as number | null, own: 'active', serverBehind: false };
  const headListeners = new Set<() => void>();
  /** judgeHeadAnnouncement calls (keyIds), kept apart from `log`. */
  const judged: string[] = [];
  let judgement: (announcement: HeadAnnouncement) => Promise<LedgerHeadRelation | null> = async () => 'same';
  let offerResult: () => Promise<'adopt' | 'keep' | 'reject'> = async () => 'keep';
  let relation: LedgerRelation | null = 'same';
  let serverRead: () => ServerLedgerRead = () => ({ kind: 'read', outcome: { decision: 'keep', relation: 'same', head: state.head, revision: 3 } });
  let headRelation: LedgerHeadRelation | null = 'same';
  let refreshEffect: () => void = () => undefined;
  let refreshGate: Promise<void> = Promise.resolve();
  const security: AccountRelaySecurity = {
    offerLedgerResult: async (candidate, source) => {
      log.push(`offer:${source}:${JSON.stringify(candidate)}`);
      const decision = await offerResult();
      if (decision === 'adopt') state.head = `${state.head}+`;
      return { decision, relation, head: null, revision: null };
    },
    readServerLedger: async () => { log.push('read'); return serverRead(); },
    noteServerHead: server => { heads.push(`${server.head}@${server.revision}`); return headRelation; },
    noteServerContact: () => { log.push('contact'); },
    refreshLedger: async () => { log.push('refresh'); refreshEffect(); await refreshGate; },
    ledgerStatus: () => ({ head: state.head, revision: state.revision, own: state.own, serverBehind: state.serverBehind }),
    judgeHeadAnnouncement: async announcement => { judged.push(announcement.keyId); return judgement(announcement); },
    onLedgerHead: listener => { headListeners.add(listener); return () => { headListeners.delete(listener); }; },
  };
  return {
    security, log, heads, state, judged, headListeners,
    /** What an adopt does in the real service: a new head, then the head listeners. */
    adopt: (head: string, revision: number) => { state.head = head; state.revision = revision; for (const listener of Array.from(headListeners)) listener(); },
    setJudge: (fn: (announcement: HeadAnnouncement) => Promise<LedgerHeadRelation | null>) => { judgement = fn; },
    setOffer: (fn: () => Promise<'adopt' | 'keep' | 'reject'>) => { offerResult = fn; },
    setRelation: (value: LedgerRelation | null) => { relation = value; },
    setServerRead: (fn: () => ServerLedgerRead) => { serverRead = fn; },
    setHeadRelation: (value: LedgerHeadRelation | null) => { headRelation = value; },
    setRefresh: (fn: () => void) => { refreshEffect = fn; },
    setRefreshGate: (gate: Promise<void>) => { refreshGate = gate; },
  };
}
const serverBehind = (head = 'server-head'): ServerLedgerRead => ({ kind: 'read', outcome: { decision: 'keep', relation: 'behind', head, revision: 2 } });

/** Manual timers and a manual monotonic clock. */
function fakeTimers() {
  const clock = { t: 10_000 };
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  const schedule = (run: () => void, ms: number) => {
    const timer = { at: clock.t + ms, run, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  const live = () => timers.filter(timer => !timer.cancelled);
  /** Advances the clock to the next live timer and runs it. */
  const fire = () => {
    const next = live().sort((a, b) => a.at - b.at)[0];
    assert.ok(next, 'a timer is scheduled');
    next.cancelled = true;
    clock.t = Math.max(clock.t, next.at);
    next.run();
    return next;
  };
  return { clock, schedule, live, fire };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const NONCE: Reply[] = [{ status: 200, body: { nonce: 'n'.repeat(43), expiresAt: 1 } }];
const TOKEN = (extra: Record<string, unknown> = {}): Reply => ({ status: 200, body: { token: JWT, expiresAt: 1, ...extra } });

describe('createAccountRelay: relay token by proof', () => {
  let authPrivateKey: CryptoKey;
  before(async () => { authPrivateKey = (await generateAuthKey(false)).privateKey; });

  function relay(routes: Record<string, Reply[]>, overrides: Partial<AccountRelayDeps> = {}, head: string | null = 'local-head',
    setup: (sec: ReturnType<typeof fakeSecurity>) => void = () => undefined) {
    const fetcher = fakeFetch({ 'POST /api/auth/nonce': NONCE, ...routes });
    const sec = fakeSecurity(head);
    setup(sec);
    const logs: string[] = [];
    const clock = { t: 1_000 };
    const timers: Array<{ ms: number; run: () => void }> = [];
    const deps: AccountRelayDeps = {
      apiUrl: API, accountId: ACCOUNT, bridgeId: 'studio', authPrivateKey, security: sec.security,
      store: { read: async () => STORED }, server: createLedgerServer({ apiUrl: API, fetchImpl: fetcher.impl }),
      hostname: () => 'studio.local', localPort: () => 4321, fetchImpl: fetcher.impl, log: line => logs.push(line), now: () => clock.t,
      schedule: (run, ms) => { timers.push({ ms, run }); return () => undefined; }, random: () => 0.5,
      ...overrides,
    };
    return { relay: createAccountRelay(deps), fetcher, sec, logs, clock, timers };
  }
  const relayTokenCalls = (r: ReturnType<typeof relay>) => r.fetcher.paths().filter(path => path === 'POST /api/auth/relay-token').length;
  const ledgerPosts = (r: ReturnType<typeof relay>) => r.fetcher.calls.filter(call => call.init?.method === 'POST' && new URL(call.url).pathname === '/api/account/ledger');

  it('signs a relay proof with the local head and presence, and notes server contact after the token', async () => {
    const r = relay({ 'POST /api/auth/relay-token': [TOKEN()] });
    assert.equal(await r.relay.tokens.getToken(), JWT);
    const request = r.fetcher.calls.find(call => call.url === `${API}/api/auth/relay-token`)!;
    assert.equal(request.body?.head, 'local-head');
    assert.equal(request.body?.hostname, 'studio.local');
    assert.equal(request.body?.localPort, 4321);
    const proof = request.body?.proof as Record<string, unknown>;
    assert.deepEqual([proof.accountId, proof.kind, proof.keyId, proof.purpose, proof.audience], [ACCOUNT, 'bridge', 'studio', 'relay', API]);
    assert.deepEqual(r.sec.log, ['contact']);
  });

  it('reuses the token without another exchange or contact until it nears expiry', async () => {
    const r = relay({ 'POST /api/auth/relay-token': [TOKEN()] });
    await r.relay.tokens.getToken();
    await r.relay.tokens.getToken();
    assert.equal(relayTokenCalls(r), 1);
    assert.deepEqual(r.sec.log, ['contact']);
  });

  it('notes no server contact when the exchange fails', async () => {
    for (const reply of [{ status: 503, body: { error: 'down' } }, { status: 401, body: { error: 'unauthorized' } }]) {
      const r = relay({ 'POST /api/auth/relay-token': [reply], 'POST /api/account/ledger': [{ status: 409 }] });
      await assert.rejects(r.relay.tokens.getToken());
      assert.equal(r.sec.log.includes('contact'), false, String(reply.status));
    }
  });

  it('offers a ledger from the token response as a server ledger before returning the token', async () => {
    const r = relay({ 'POST /api/auth/relay-token': [TOKEN({ ledger: LEDGER })] });
    assert.equal(await r.relay.tokens.getToken(), JWT);
    assert.deepEqual(r.sec.log, [`offer:server:${JSON.stringify(LEDGER)}`, 'contact']);
  });

  it('an invalid or failing ledger offer never aborts the token fetch', async () => {
    for (const offer of [async () => 'reject' as const, async (): Promise<'reject'> => { throw new Error('store broken'); }]) {
      const r = relay({ 'POST /api/auth/relay-token': [TOKEN({ ledger: { bogus: true } })] });
      r.sec.setOffer(offer);
      assert.equal(await r.relay.tokens.getToken(), JWT);
      assert.equal(r.sec.log.at(-1), 'contact');
      assert.equal(r.logs.length, 1);
    }
  });

  it('401 key_revoked: offers the evidence ledger to the replica (which alone decides), then fails with UnauthorizedError and no cooldown', async () => {
    const r = relay({ 'POST /api/auth/relay-token': [{ status: 401, body: { error: 'key_revoked', ledger: LEDGER } }], 'POST /api/account/ledger': [{ status: 200, body: {} }] });
    await assert.rejects(r.relay.tokens.getToken(), UnauthorizedError);
    assert.deepEqual(r.sec.log, [`offer:server:${JSON.stringify(LEDGER)}`]);
    assert.equal(r.relay.tokens.cooldownRemainingMs(), 0);
    assert.deepEqual(ledgerPosts(r), []);
  });

  it('plain 401: onUnauthorized never posts blindly; with the server not behind (or unknown, 404) nothing is posted and nothing retried', async () => {
    for (const read of [
      { kind: 'read', outcome: { decision: 'keep', relation: 'same', head: 'local-head', revision: 3 } },
      { kind: 'read', outcome: { decision: 'keep', relation: 'diverged', head: 'other-head', revision: 9 } },
      { kind: 'unknown_account', reason: 'Ledger read failed (404)' },
      { kind: 'failed', reason: 'fetch failed' },
    ] as ServerLedgerRead[]) {
      const r = relay({ 'POST /api/auth/relay-token': [{ status: 401, body: { error: 'unauthorized' } }], 'POST /api/account/ledger': [{ status: 200, body: {} }] },
        {}, 'local-head', sec => sec.setServerRead(() => read));
      await assert.rejects(r.relay.tokens.getToken(), UnauthorizedError);
      assert.deepEqual(ledgerPosts(r), [], read.kind);
      assert.equal(relayTokenCalls(r), 1, read.kind);
      assert.deepEqual(r.sec.log, ['read'], 'a fresh read decides');
    }
  });

  it('plain 401 with the server behind us: one POST of our chain with expectHead after the fresh read, then one token retry', async () => {
    const r = relay({
      'POST /api/auth/relay-token': [{ status: 401, body: { error: 'unauthorized' } }, TOKEN()],
      'POST /api/account/ledger': [{ status: 200, body: { decision: 'adopt', ledger: LEDGER } }],
    }, {}, 'local-head', sec => sec.setServerRead(() => serverBehind('server-head')));
    assert.equal(await r.relay.tokens.getToken(), JWT);
    assert.deepEqual(r.fetcher.paths(), ['POST /api/auth/nonce', 'POST /api/auth/relay-token', 'POST /api/account/ledger', 'POST /api/auth/nonce', 'POST /api/auth/relay-token']);
    assert.deepEqual(ledgerPosts(r).map(call => call.body), [{ ledger: LEDGER, expectHead: 'server-head' }]);
    assert.deepEqual(r.sec.log, ['read', `offer:server:${JSON.stringify(LEDGER)}`, 'contact'], 'read first; the answered chain goes to the replica');

    for (const status of [404, 409, 429, 503]) {
      const refused = relay({ 'POST /api/auth/relay-token': [{ status: 401, body: { error: 'unauthorized' } }], 'POST /api/account/ledger': [{ status, body: { error: 'x' } }] },
        {}, 'local-head', sec => sec.setServerRead(() => serverBehind()));
      await assert.rejects(refused.relay.tokens.getToken(), UnauthorizedError);
      assert.equal(relayTokenCalls(refused), 1, String(status));
      assert.equal(ledgerPosts(refused).length, 1, String(status));
    }
  });

  it('a plain 401 is remembered: no re-proof for 10 minutes, and the pair window and backoff bound the re-offers', async () => {
    const r = relay({ 'POST /api/auth/relay-token': [{ status: 401, body: { error: 'unauthorized' } }], 'POST /api/account/ledger': [{ status: 503 }] },
      {}, 'local-head', sec => sec.setServerRead(() => serverBehind()));
    await assert.rejects(r.relay.tokens.getToken(), UnauthorizedError);
    await assert.rejects(r.relay.tokens.getToken(), UnauthorizedError);
    assert.deepEqual([relayTokenCalls(r), ledgerPosts(r).length], [1, 1]);
    r.clock.t += 600_000;
    await assert.rejects(r.relay.tokens.getToken(), UnauthorizedError);
    assert.deepEqual([relayTokenCalls(r), ledgerPosts(r).length], [2, 2], 'after the backoff the next refusal may re-offer again (fresh read first)');
  });

  it('never posts when our own bridge is not active in our chain', async () => {
    const r = relay({ 'POST /api/auth/relay-token': [{ status: 401, body: { error: 'unauthorized' } }], 'POST /api/account/ledger': [{ status: 200, body: {} }] },
      {}, 'local-head', sec => { sec.setServerRead(() => serverBehind()); sec.state.own = 'absent'; });
    await assert.rejects(r.relay.tokens.getToken(), UnauthorizedError);
    assert.deepEqual(ledgerPosts(r), []);
  });

  it('a token response carrying a server chain that is behind ours starts the re-offer (fresh read, then expectHead)', async () => {
    const r = relay({ 'POST /api/auth/relay-token': [TOKEN({ ledger: { older: true } })], 'POST /api/account/ledger': [{ status: 200, body: {} }] },
      {}, 'local-head', sec => { sec.setRelation('behind'); sec.setServerRead(() => serverBehind('older-head')); });
    assert.equal(await r.relay.tokens.getToken(), JWT);
    await settle();
    // The re-offer starts while the token is handed back; its first step is a fresh read of the server.
    assert.deepEqual(r.sec.log.filter(line => line !== 'contact'), ['offer:server:{"older":true}', 'read']);
    assert.deepEqual(ledgerPosts(r).map(call => call.body), [{ ledger: LEDGER, expectHead: 'older-head' }]);
  });

  it('a token response without a chain reports the server head: behind re-offers, unknown reads the server, same does nothing', async () => {
    for (const [relation, expected] of [['same', []], ['behind', ['read']], ['unknown', ['refresh']]] as const) {
      const r = relay({ 'POST /api/auth/relay-token': [TOKEN()], 'POST /api/account/ledger': [{ status: 200, body: {} }] },
        {}, 'local-head', sec => { sec.setHeadRelation(relation); sec.setServerRead(() => serverBehind()); });
      await r.relay.tokens.getToken();
      await settle();
      assert.deepEqual(r.sec.heads, ['local-head@null'], relation);
      assert.deepEqual(r.sec.log.filter(line => line !== 'contact'), expected, relation);
    }
    const named = relay({ 'POST /api/auth/relay-token': [TOKEN({ head: 'H'.repeat(43), revision: 4 })] });
    await named.relay.tokens.getToken();
    assert.deepEqual(named.sec.heads, [`${'H'.repeat(43)}@4`]);
  });

  it('a server read that already showed the server behind (startup) re-offers as soon as the relay wiring starts', async () => {
    const r = relay({ 'POST /api/account/ledger': [{ status: 200, body: {} }] }, {}, 'local-head', sec => {
      sec.state.serverBehind = true;
      sec.setServerRead(() => serverBehind('startup-head'));
    });
    await settle();
    assert.deepEqual(r.sec.log, ['read']);
    assert.deepEqual(ledgerPosts(r).map(call => call.body), [{ ledger: LEDGER, expectHead: 'startup-head' }]);
  });

  it('a refused relay connection reconnects when the key is accepted again', async () => {
    const reconnects: string[] = [];
    const r = relay({ 'POST /api/auth/relay-token': [{ status: 401, body: { error: 'unauthorized' } }, TOKEN()], 'POST /api/account/ledger': [{ status: 409 }] },
      { reconnect: () => reconnects.push('reconnect') });
    await assert.rejects(r.relay.connectionToken(), UnauthorizedError);
    assert.deepEqual(reconnects, []);
    r.clock.t += 600_000;
    assert.equal(await r.relay.tokens.getToken(), JWT);
    assert.deepEqual(reconnects, ['reconnect']);
    r.clock.t += 3_600_000;
    await r.relay.tokens.getToken();
    assert.deepEqual(reconnects, ['reconnect'], 'only after a refusal');
  });

  it('learns the relay URL from the token response, reports a new one, falls back to the saved one; the override wins', async () => {
    const saved: string[] = [];
    const named = relay({ 'POST /api/auth/relay-token': [TOKEN({ centrifugoUrl: 'wss://relay.ftown.example/connection/websocket' })] },
      { savedRelayUrl: 'wss://old.ftown.example/ws', onRelayUrl: url => saved.push(url) });
    assert.equal(named.relay.relayUrl(), 'wss://old.ftown.example/ws');
    await named.relay.tokens.getToken();
    assert.equal(named.relay.relayUrl(), 'wss://relay.ftown.example/connection/websocket');
    assert.deepEqual(saved, ['wss://relay.ftown.example/connection/websocket']);

    const same = relay({ 'POST /api/auth/relay-token': [TOKEN({ centrifugoUrl: 'wss://old.ftown.example/ws' })] },
      { savedRelayUrl: 'wss://old.ftown.example/ws', onRelayUrl: url => saved.push(url) });
    await same.relay.tokens.getToken();
    assert.equal(saved.length, 1, 'an unchanged URL is not saved again');

    const plain = relay({ 'POST /api/auth/relay-token': [TOKEN({ centrifugoUrl: 'ws://relay.ftown.example/connection/websocket' })] });
    await plain.relay.tokens.getToken();
    assert.equal(plain.relay.relayUrl(), null);

    const override = relay({ 'POST /api/auth/relay-token': [TOKEN({ centrifugoUrl: 'wss://other.example/ws' })] }, { relayUrlOverride: 'wss://mine.example/ws' });
    await override.relay.tokens.getToken();
    assert.equal(override.relay.relayUrl(), 'wss://mine.example/ws');

    const bad = relay({ 'POST /api/auth/relay-token': [TOKEN()] }, { relayUrlOverride: 'ws://mine.example/ws' });
    assert.equal(bad.relay.relayUrl(), null);
    assert.equal(bad.logs.length, 1);
  });
});

describe('createAccountRelay: relay ledger channel (spaced, latest wins)', () => {
  async function relayWith(head: string | null) {
    const sec = fakeSecurity(head);
    const timers = fakeTimers();
    const reconnects: string[] = [];
    const authPrivateKey = (await generateAuthKey(false)).privateKey;
    const fetcher = fakeFetch({ 'POST /api/account/ledger': [{ status: 200, body: {} }] });
    const r = createAccountRelay({
      apiUrl: API, accountId: ACCOUNT, bridgeId: 'studio', authPrivateKey, security: sec.security, store: { read: async () => STORED },
      server: createLedgerServer({ apiUrl: API, fetchImpl: fetcher.impl }), hostname: () => 'h', localPort: () => undefined, fetchImpl: fetcher.impl,
      now: () => timers.clock.t, schedule: timers.schedule, reconnect: () => reconnects.push('reconnect'), log: () => undefined,
    });
    return { r, sec, fetcher, timers, reconnects };
  }
  const offer = (n: number) => ({ type: 'ledger' as const, ledger: { n } });

  it('runs the first message at once, then keeps only the latest until at least 1 s has passed', async () => {
    const { r, sec, timers } = await relayWith('H1');
    r.onLedgerMessage(offer(1));
    await settle();
    r.onLedgerMessage(offer(2));
    r.onLedgerMessage(offer(3));
    await settle();
    assert.deepEqual(sec.log, ['offer:relay:{"n":1}']);
    const timer = timers.fire();
    assert.equal(timer.at - 10_000, 1_000);
    await settle();
    assert.deepEqual(sec.log, ['offer:relay:{"n":1}', 'offer:relay:{"n":3}']);
  });

  it('backs off 1 s, 2 s, 4 s ... up to 60 s while nothing is adopted, and an adopt resets it', async () => {
    const { r, sec, timers } = await relayWith('H1');
    const gaps: number[] = [];
    let last = timers.clock.t;
    r.onLedgerMessage(offer(0));
    await settle();
    for (let i = 1; i <= 8; i++) {
      r.onLedgerMessage(offer(i));
      await settle();
      timers.fire();
      await settle();
      gaps.push(timers.clock.t - last);
      last = timers.clock.t;
    }
    assert.deepEqual(gaps, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, RELAY_LEDGER_MAX_SPACING_MS, RELAY_LEDGER_MAX_SPACING_MS]);
    sec.setOffer(async () => 'adopt');
    r.onLedgerMessage(offer(9));
    await settle();
    timers.fire();
    await settle();
    r.onLedgerMessage(offer(10));
    await settle();
    const next = timers.fire();
    assert.equal(next.at - last - RELAY_LEDGER_MAX_SPACING_MS, 1_000, 'after an adopt the spacing is 1 s again');
  });

  it('leading edge: after a quiet second the next relay ledger runs at once, with a fresh backoff', async () => {
    const { r, sec, timers } = await relayWith('H1');
    r.onLedgerMessage(offer(0));
    await settle();
    for (let i = 1; i <= 4; i++) {
      r.onLedgerMessage(offer(i));
      await settle();
      timers.fire();
      await settle();
    }
    // The burst has backed off to 16 s; one quiet second later the next message is applied at once.
    timers.clock.t += 1_000;
    r.onLedgerMessage(offer(5));
    await settle();
    assert.equal(sec.log.at(-1), 'offer:relay:{"n":5}');
    assert.deepEqual(timers.live(), []);
    r.onLedgerMessage(offer(6));
    await settle();
    assert.equal(timers.live()[0].at - timers.clock.t, 1_000, 'the burst that follows starts again at 1 s');
  });

  it('a ledger_head equal to the local head does nothing; a different one refreshes through security, spaced', async () => {
    const { r, sec, fetcher, timers } = await relayWith('H1');
    r.onLedgerMessage({ type: 'ledger_head', head: 'H1', revision: 3 });
    await settle();
    assert.deepEqual(sec.log, []);
    assert.deepEqual(timers.live(), []);
    r.onLedgerMessage({ type: 'ledger_head', head: 'H2', revision: 4 });
    await settle();
    assert.deepEqual(sec.log, ['refresh']);
    r.onLedgerMessage({ type: 'ledger_head', head: 'H3', revision: 5 });
    await settle();
    assert.deepEqual(sec.log, ['refresh'], 'the second waits for the spacing');
    timers.fire();
    await settle();
    assert.deepEqual(sec.log, ['refresh', 'refresh']);
    assert.deepEqual(fetcher.calls, []);
  });

  it('relay input alone never POSTs: a relayed chain behind ours only causes a paced server read', async () => {
    const { r, sec, fetcher, timers } = await relayWith('H1');
    sec.setRelation('behind');
    r.onLedgerMessage(offer(1));
    await settle();
    assert.deepEqual(sec.log, ['offer:relay:{"n":1}'], 'the read waits for the relay spacing');
    timers.fire();
    await settle();
    assert.deepEqual(sec.log, ['offer:relay:{"n":1}', 'refresh']);
    r.onLedgerMessage({ type: 'ledger_head', head: 'H0', revision: 1 });
    r.onLedgerSubscribed();
    await settle();
    while (timers.live().length > 0) { timers.fire(); await settle(); }
    assert.deepEqual(fetcher.calls, [], 'the server read showed nothing behind: no POST');
  });

  it('a relay-triggered read that shows the server behind re-offers our chain after one more fresh read', async () => {
    const { r, sec, fetcher } = await relayWith('H1');
    sec.setServerRead(() => serverBehind('S1'));
    sec.setRefresh(() => { sec.state.serverBehind = true; });
    r.onLedgerSubscribed();
    await settle();
    assert.deepEqual(sec.log.slice(0, 2), ['refresh', 'read']);
    assert.deepEqual(fetcher.calls.map(call => call.body), [{ ledger: LEDGER, expectHead: 'S1' }]);
  });

  it('every (re)subscribe of the ledger channel refreshes through security, spaced', async () => {
    const { r, sec, timers } = await relayWith(null);
    r.onLedgerSubscribed();
    r.onLedgerSubscribed();
    await settle();
    assert.deepEqual(sec.log, ['refresh']);
    timers.fire();
    await settle();
    assert.deepEqual(sec.log, ['refresh', 'refresh']);
  });

  it('an adopted ledger does not reconnect a relay that was never refused', async () => {
    const { r, sec, reconnects } = await relayWith('H1');
    await assert.rejects(r.connectionToken()); // a transient failure, not a refusal
    sec.setRefresh(() => { sec.state.head = 'H2'; });
    r.onLedgerSubscribed();
    await settle();
    assert.deepEqual(reconnects, []);
  });

  it('a request from an unknown endpoint pulls the ledger at once, outside the relay spacing', async () => {
    const { r, sec, timers } = await relayWith('H1');
    r.onLedgerSubscribed();
    await settle();
    r.onLedgerMessage(offer(1));
    await settle();
    assert.deepEqual(sec.log, ['refresh'], 'the relay offer waits for its spacing');
    r.onUnknownEndpoint();
    await settle();
    assert.deepEqual(sec.log, ['refresh', 'refresh']);
    assert.equal(timers.live().length, 1, 'only the relay timer');
  });

  it('unknown-endpoint refreshes: single-flight, at most one per 2 s, one trailing refresh for requests meanwhile', async () => {
    const { r, sec, timers } = await relayWith('H1');
    let release!: () => void;
    sec.setRefreshGate(new Promise<void>(resolve => { release = resolve; }));
    r.onUnknownEndpoint();
    r.onUnknownEndpoint();
    r.onUnknownEndpoint();
    await settle();
    assert.deepEqual(sec.log, ['refresh']);
    assert.deepEqual(timers.live(), []);
    release();
    await settle();
    assert.deepEqual(timers.live().map(timer => timer.at - timers.clock.t), [UNKNOWN_ENDPOINT_REFRESH_SPACING_MS]);
    r.onUnknownEndpoint();
    await settle();
    assert.equal(timers.live().length, 1);
    timers.fire();
    await settle();
    assert.deepEqual(sec.log, ['refresh', 'refresh']);
    timers.clock.t += UNKNOWN_ENDPOINT_REFRESH_SPACING_MS;
    r.onUnknownEndpoint();
    await settle();
    assert.deepEqual(sec.log, ['refresh', 'refresh', 'refresh']);
  });

  it("subscribes to the security service's approval-required signal when it offers one", () => {
    const listeners: Array<(endpointId: string) => void> = [];
    const withSignal = { onApprovalRequired(listener: (endpointId: string) => void) { listeners.push(listener); return () => undefined; } };
    let calls = 0;
    assert.equal(subscribeApprovalRequired(withSignal, () => { calls++; }), true);
    listeners[0]('unknown-endpoint');
    assert.equal(calls, 1);
    assert.equal(subscribeApprovalRequired({}, () => undefined), false);
  });

  it('stop cancels pending relay work', async () => {
    const { r, sec, timers } = await relayWith('H1');
    r.onLedgerMessage(offer(1));
    await settle();
    r.onLedgerMessage(offer(2));
    await settle();
    r.stop();
    assert.deepEqual(timers.live(), []);
    r.onLedgerMessage(offer(3));
    await settle();
    assert.deepEqual(sec.log, ['offer:relay:{"n":1}']);
  });
});

describe('createAccountRelay: head announcements (CONTRACT §13)', () => {
  const head = (n: number): string => Buffer.alloc(32, n).toString('base64url');
  const NOW = 1_750_000_000_000;
  async function announcing(publish: 'none' | 'ok' | 'fail' = 'ok') {
    const sec = fakeSecurity(head(1));
    const timers = fakeTimers();
    const logs: string[] = [];
    const key = await generateAuthKey(false);
    const fetcher = fakeFetch({ 'POST /api/account/ledger': [{ status: 200, body: {} }] });
    const r = createAccountRelay({
      apiUrl: API, accountId: ACCOUNT, bridgeId: 'studio', authPrivateKey: key.privateKey, security: sec.security, store: { read: async () => STORED },
      server: createLedgerServer({ apiUrl: API, fetchImpl: fetcher.impl }), hostname: () => 'h', localPort: () => undefined, fetchImpl: fetcher.impl,
      now: () => timers.clock.t, wallClock: () => NOW + timers.clock.t, schedule: timers.schedule, log: line => logs.push(line),
    });
    const published: HeadAnnouncement[] = [];
    if (publish !== 'none') {
      r.setLedgerPublisher(async announcement => {
        published.push(announcement);
        if (publish === 'fail') throw new Error('Ledger channel not subscribed');
      });
    }
    // The checkpoint a receiver would hold: this bridge as a member with its auth key.
    const checkpoint = { version: 2, accountId: ACCOUNT, revision: 3, head: head(1), authorities: [], devices: [],
      bridges: [{ bridgeId: 'studio', endpoint: {} as never, authPublicKey: key.publicKey, label: 'Studio', approvedAt: 1 }],
      revokedDeviceIds: [], revokedBridgeIds: [] } satisfies LedgerCheckpoint;
    return { r, sec, timers, logs, published, fetcher, checkpoint };
  }
  /** Signing is real WebCrypto work: wait until `done` holds (bounded). */
  async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  }
  /** A received announcement (shape only: the fake security judges it). */
  const received = (keyId: string, n: number, kind: 'device' | 'bridge' = 'device'): { type: 'head_announcement'; announcement: HeadAnnouncement } => ({
    type: 'head_announcement',
    announcement: { type: 'ledger_head', version: 1, accountId: ACCOUNT, kind, keyId, head: head(n), revision: n, at: NOW, signature: 'A'.repeat(86) },
  });

  it('announces a signed head when the ledger channel subscribes; callers never wait for it', async () => {
    const { r, published, timers, checkpoint } = await announcing();
    assert.equal(r.onLedgerSubscribed(), undefined);
    await until(() => published.length === 1);
    assert.equal(published.length, 1);
    const [announcement] = published;
    assert.deepEqual({ ...announcement, signature: '' }, {
      type: 'ledger_head', version: 1, accountId: ACCOUNT, kind: 'bridge', keyId: 'studio', head: head(1), revision: 3, at: NOW + timers.clock.t, signature: '',
    });
    assert.equal(await verifyHeadAnnouncement(checkpoint, announcement, NOW + timers.clock.t), true, 'signed with the bridge auth key');
    assert.equal(await verifyHeadAnnouncement(checkpoint, announcement, NOW + timers.clock.t + HEAD_ANNOUNCE_MAX_AGE_MS + 1), false);
  });

  it('announces after every adopt, at most once per 5 s, coalescing to the latest head', async () => {
    const { r, sec, published, timers } = await announcing();
    r.onLedgerSubscribed();
    await until(() => published.length === 1);
    sec.adopt(head(2), 4);
    sec.adopt(head(3), 5);
    sec.adopt(head(4), 6);
    await settle();
    assert.equal(published.length, 1, 'the next waits for the spacing');
    const announceTimers = timers.live().filter(timer => timer.at - timers.clock.t === HEAD_ANNOUNCE_SPACING_MS);
    assert.equal(announceTimers.length, 1, 'one pending announcement, not three');
    while (timers.live().length > 0) { timers.fire(); await settle(); }
    await until(() => published.length === 2);
    assert.deepEqual(published.map(item => [item.head, item.revision]), [[head(1), 3], [head(4), 6]]);
    // A quiet 5 s later the next adopt is announced at once.
    timers.clock.t += HEAD_ANNOUNCE_SPACING_MS;
    sec.adopt(head(5), 7);
    await until(() => published.length === 3);
    assert.deepEqual(published.map(item => item.revision), [3, 6, 7]);
  });

  it('only an active member announces: nothing while revoked, absent, unpaired or without a head', async () => {
    for (const own of ['revoked', 'absent', 'unpaired']) {
      const { r, sec, published, timers } = await announcing();
      sec.state.own = own;
      r.onLedgerSubscribed();
      sec.adopt(head(2), 4);
      while (timers.live().length > 0) { timers.fire(); await settle(); }
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(published, [], own);
    }
    const { r, sec, published } = await announcing();
    sec.state.head = null; sec.state.revision = null;
    r.onLedgerSubscribed();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(published, []);
  });

  it('without a publisher announcing is a silent no-op; once set, the next adopt is announced', async () => {
    const { r, sec, published, timers, logs } = await announcing('none');
    r.onLedgerSubscribed();
    sec.adopt(head(2), 4);
    await settle();
    assert.deepEqual(timers.live().filter(timer => timer.at - timers.clock.t === HEAD_ANNOUNCE_SPACING_MS), []);
    assert.deepEqual(logs, []);
    r.setLedgerPublisher(async announcement => { published.push(announcement); });
    sec.adopt(head(3), 5);
    await until(() => published.length === 1);
    assert.deepEqual(published.map(item => item.revision), [5]);
  });

  it('a failed publish is ignored (best effort) and logged at most once a minute', async () => {
    const { r, sec, published, timers, logs } = await announcing('fail');
    r.onLedgerSubscribed();
    await until(() => logs.length === 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Could not announce the ledger head: Ledger channel not subscribed/);
    for (let i = 0; i < 5; i++) {
      timers.clock.t += HEAD_ANNOUNCE_SPACING_MS;
      sec.adopt(head(10 + i), 10 + i);
      await until(() => published.length === 2 + i);
    }
    assert.equal(published.length, 6);
    assert.equal(logs.length, 1, 'no second line within the minute');
    timers.clock.t += HEAD_ANNOUNCE_WARN_SPACING_MS;
    sec.adopt(head(20), 20);
    await until(() => logs.length === 2);
    assert.equal(logs.length, 2);
  });

  it('stop cancels a pending announcement and unsubscribes from the head signal', async () => {
    const { r, sec, published, timers } = await announcing();
    r.onLedgerSubscribed();
    await until(() => published.length === 1);
    sec.adopt(head(2), 4);
    r.stop();
    assert.deepEqual(timers.live(), []);
    assert.equal(sec.headListeners.size, 0);
    r.onLedgerSubscribed();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(published.length, 1);
  });

  it('a verified announcement with an unknown head queues exactly one paced server read; same and behind do nothing', async () => {
    const { r, sec, fetcher, timers } = await announcing();
    sec.setJudge(async () => 'same');
    r.onLedgerMessage(received('laptop'.padEnd(43, 'A'), 3));
    sec.setJudge(async () => 'behind');
    r.onLedgerMessage(received('laptop'.padEnd(43, 'A'), 2));
    await settle();
    assert.deepEqual(sec.log, []);
    sec.setJudge(async () => 'unknown');
    r.onLedgerMessage(received('laptop'.padEnd(43, 'A'), 9));
    await settle();
    assert.deepEqual(sec.log, ['refresh']);
    assert.deepEqual(sec.judged.length, 3);
    // An announcement never leads to a POST, nor to any request of the relay's own.
    assert.deepEqual(fetcher.calls, []);
    while (timers.live().length > 0) { timers.fire(); await settle(); }
    assert.deepEqual(sec.log, ['refresh']);
  });

  it('a burst of unknown heads from a member is bounded by the relay spacing: one read now, one for the rest', async () => {
    const { r, sec, timers, fetcher } = await announcing();
    sec.setJudge(async () => 'unknown');
    for (let n = 0; n < 200; n++) r.onLedgerMessage(received('laptop'.padEnd(43, 'A'), 10 + n));
    await settle();
    assert.equal(sec.judged.length, 200, 'one judgement (one signature check) per message');
    assert.deepEqual(sec.log, ['refresh']);
    timers.fire();
    await settle();
    assert.deepEqual(sec.log, ['refresh', 'refresh'], 'the rest were coalesced into one trailing read');
    assert.deepEqual(timers.live().filter(timer => timer.at > timers.clock.t), []);
    assert.deepEqual(fetcher.calls, []);
  });

  it('dropped announcements and our own echo cause nothing; our own is not even judged', async () => {
    const { r, sec, timers } = await announcing();
    sec.setJudge(async () => null);
    r.onLedgerMessage(received('laptop'.padEnd(43, 'A'), 9));
    r.onLedgerMessage(received('studio', 9, 'bridge'));
    sec.setJudge(async () => { throw new Error('boom'); });
    r.onLedgerMessage(received('other-bridge', 9, 'bridge'));
    await settle();
    assert.deepEqual(sec.judged, ['laptop'.padEnd(43, 'A'), 'other-bridge']);
    assert.deepEqual(sec.log, []);
    assert.deepEqual(timers.live(), []);
  });

  it('the unsigned ledger_head notice keeps its behaviour beside announcements', async () => {
    const { r, sec } = await announcing();
    r.onLedgerMessage({ type: 'ledger_head', head: head(1), revision: 3 });
    await settle();
    assert.deepEqual(sec.log, []);
    assert.deepEqual(sec.judged, []);
    r.onLedgerMessage({ type: 'ledger_head', head: head(2), revision: 4 });
    await settle();
    assert.deepEqual(sec.log, ['refresh']);
    assert.deepEqual(sec.judged, []);
  });
});

describe('createAccountRelay: reconnect after a terminal 401 once a ledger is adopted', () => {
  it('reconnects on an adopted relay ledger, once', async () => {
    const sec = fakeSecurity('H1');
    const timers = fakeTimers();
    const reconnects: string[] = [];
    const fetcher = fakeFetch({ 'POST /api/auth/nonce': NONCE, 'POST /api/auth/relay-token': [{ status: 401, body: { error: 'unauthorized' } }], 'POST /api/account/ledger': [{ status: 409 }] });
    const r = createAccountRelay({
      apiUrl: API, accountId: ACCOUNT, bridgeId: 'studio', authPrivateKey: (await generateAuthKey(false)).privateKey, security: sec.security,
      store: { read: async () => STORED }, server: createLedgerServer({ apiUrl: API, fetchImpl: fetcher.impl }), hostname: () => 'h',
      localPort: () => undefined, fetchImpl: fetcher.impl, now: () => timers.clock.t, schedule: timers.schedule,
      reconnect: () => reconnects.push('reconnect'), log: () => undefined,
    });
    await assert.rejects(r.connectionToken(), UnauthorizedError);
    sec.setOffer(async () => 'adopt');
    r.onLedgerMessage({ type: 'ledger', ledger: LEDGER });
    await settle();
    assert.deepEqual(reconnects, ['reconnect']);
    r.onLedgerMessage({ type: 'ledger', ledger: LEDGER });
    await settle();
    timers.fire();
    await settle();
    assert.deepEqual(reconnects, ['reconnect']);
  });
});

describe('saved relay URL', () => {
  it('round-trips through security/relay-url.json (0600) and ignores anything unusable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-url-'));
    try {
      assert.equal(readSavedRelayUrl(dir, API), null);
      saveRelayUrl(dir, 'wss://relay.ftown.example/ws');
      assert.equal(readSavedRelayUrl(dir, API), 'wss://relay.ftown.example/ws');
      assert.equal(statSync(join(dir, 'security', 'relay-url.json')).mode & 0o777, 0o600);
      saveRelayUrl(dir, 'wss://next.ftown.example/ws');
      assert.equal(readSavedRelayUrl(dir, API), 'wss://next.ftown.example/ws');
      for (const content of ['{broken', JSON.stringify({ version: 2, url: 'wss://a.example' }), JSON.stringify({ version: 1, url: 'ws://far.example' })]) {
        writeFileSync(join(dir, 'security', 'relay-url.json'), content);
        assert.equal(readSavedRelayUrl(dir, API), null, content);
      }
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'security', 'relay-url.json'), 'utf8')), { version: 1, url: 'ws://far.example' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a ws:// URL saved for an http API is accepted only for that API', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-url-'));
    try {
      mkdirSync(join(dir, 'security'));
      saveRelayUrl(dir, 'ws://192.168.1.10:8000/ws');
      assert.equal(readSavedRelayUrl(dir, 'http://192.168.1.10:3000'), 'ws://192.168.1.10:8000/ws');
      assert.equal(readSavedRelayUrl(dir, API), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('createLedgerServer', () => {
  it('reads the public ledger by accountId, uncached and with a timeout', async () => {
    const f = fakeFetch({ 'GET /api/account/ledger': [{ status: 200, body: { ledger: LEDGER } }] });
    assert.deepEqual(await createLedgerServer({ apiUrl: `${API}/`, fetchImpl: f.impl }).fetchLedger(ACCOUNT), LEDGER);
    assert.equal(f.calls[0].url, `${API}/api/account/ledger?accountId=${ACCOUNT}`);
    assert.equal(f.calls[0].init?.cache, 'no-store');
    assert.ok(f.calls[0].init?.signal instanceof AbortSignal);
  });

  it('throws on a non-200, an oversized or a malformed answer', async () => {
    const cases: Array<[Reply, RegExp]> = [
      [{ status: 404, body: { error: 'not_found' } }, /\(404\)/],
      [{ status: 200, body: { ledger: LEDGER }, headers: { 'content-length': String(4 * 1024 * 1024) } }, /too_large/],
      [{ status: 200, body: { nope: 1 } }, /malformed/],
      [{ status: 200, body: [LEDGER] }, /malformed/],
    ];
    for (const [reply, error] of cases) {
      const f = fakeFetch({ 'GET /api/account/ledger': [reply] });
      await assert.rejects(createLedgerServer({ apiUrl: API, fetchImpl: f.impl }).fetchLedger(ACCOUNT), error);
    }
    const small = fakeFetch({ 'GET /api/account/ledger': [{ status: 200, body: { ledger: LEDGER } }] });
    await assert.rejects(createLedgerServer({ apiUrl: API, fetchImpl: small.impl, maxBytes: 10 }).fetchLedger(ACCOUNT), /too_large/);
  });

  it('posts { ledger, expectHead } and reports the status, the bounded JSON body and Retry-After', async () => {
    const f = fakeFetch({ 'POST /api/account/ledger': [
      { status: 409, body: { error: 'head_changed', ledger: LEDGER } },
      { status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': '120' } },
      { status: 200, body: { ledger: LEDGER }, headers: { 'content-length': String(4 * 1024 * 1024) } },
    ] });
    const server = createLedgerServer({ apiUrl: API, fetchImpl: f.impl });
    assert.deepEqual(await server.postLedger(LEDGER, 'E'.repeat(43)), { status: 409, body: { error: 'head_changed', ledger: LEDGER }, retryAfterMs: null });
    assert.deepEqual(f.calls[0].body, { ledger: LEDGER, expectHead: 'E'.repeat(43) });
    assert.equal(f.calls[0].init?.cache, 'no-store');
    assert.deepEqual(await server.postLedger(LEDGER, 'E'.repeat(43)), { status: 429, body: { error: 'rate_limited' }, retryAfterMs: 120_000 });
    assert.deepEqual(await server.postLedger(LEDGER, 'E'.repeat(43)), { status: 200, body: null, retryAfterMs: null }, 'an oversized body is not read');
  });

  it('reads Retry-After as seconds or an HTTP date', () => {
    assert.equal(parseRetryAfter('30'), 30_000);
    assert.equal(parseRetryAfter(' 7 '), 7_000);
    assert.equal(parseRetryAfter(new Date(1_000_000 + 90_000).toUTCString(), 1_000_000), 90_000);
    assert.equal(parseRetryAfter(new Date(0).toUTCString(), 1_000_000), 0);
    for (const value of [null, '', 'soon', '-5', '1.5']) assert.equal(parseRetryAfter(value), null, String(value));
  });

  it('turns a timeout into a readable error', async () => {
    const hang: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
    await assert.rejects(createLedgerServer({ apiUrl: API, fetchImpl: hang, timeoutMs: 5 }).fetchLedger(ACCOUNT), /timed out after 5ms/);
  });
});

describe('registerBridgeEndpoint', () => {
  const endpoint: EndpointPublic = { version: 1, id: 'e'.repeat(43), ownerId: ACCOUNT, kind: 'bridge', publicKey: 'p'.repeat(87) };

  it("publishes only this bridge's own endpoint with the relay token", async () => {
    const f = fakeFetch({ 'PUT /api/security/endpoints': [{ status: 204 }] });
    await registerBridgeEndpoint({ apiUrl: API, token: 'jwt', endpoint, bridgeId: 'studio', label: 'Studio', fetchImpl: f.impl });
    assert.deepEqual(f.calls[0].body, { endpoint, bridgeId: 'studio', label: 'Studio', protocolVersion: 1 });
    assert.equal((f.calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer jwt');
  });

  it('throws an HttpStatusError when the directory refuses it', async () => {
    const f = fakeFetch({ 'PUT /api/security/endpoints': [{ status: 403, body: { error: 'forbidden' } }] });
    const error = await registerBridgeEndpoint({ apiUrl: API, token: 'jwt', endpoint, bridgeId: 'studio', label: 'Studio', fetchImpl: f.impl })
      .then(() => assert.fail('should reject'), (e: unknown) => e);
    assert.ok(error instanceof HttpStatusError);
    assert.equal(error.status, 403);
  });
});

describe('errors, URLs and messages', () => {
  it('tells refusals (401/403, UnauthorizedError) from temporary failures', () => {
    assert.equal(isRefusal(new UnauthorizedError('no')), true);
    assert.equal(isRefusal(new HttpStatusError('x', 403)), true);
    assert.equal(isRefusal(new Error('Relay token failed (403): no')), true);
    assert.equal(isRefusal(new Error('Relay token rejected (401): no')), true);
    for (const error of [new Error('Relay token failed (503): down'), new Error('fetch failed'), new Error('Token refresh cooling down for 15s after 1 failed attempts'), new HttpStatusError('x', 429)]) {
      assert.equal(isRefusal(error), false, error.message);
    }
    assert.equal(httpStatusOf(new Error('Relay token failed (502): x')), 502);
    assert.equal(httpStatusOf('nothing'), null);
  });

  it('accepts wss, and ws only for a local relay or a plain-http API', () => {
    assert.equal(parseRelayUrl('wss://relay.example/connection/websocket', API), 'wss://relay.example/connection/websocket');
    assert.equal(parseRelayUrl('ws://relay.example/ws', API), null);
    assert.equal(parseRelayUrl('ws://localhost:8000/connection/websocket', API), 'ws://localhost:8000/connection/websocket');
    assert.equal(parseRelayUrl('ws://127.0.0.1:8000/ws', API), 'ws://127.0.0.1:8000/ws');
    assert.equal(parseRelayUrl('ws://192.168.1.10:8000/ws', 'http://192.168.1.10:3000'), 'ws://192.168.1.10:8000/ws');
    for (const value of ['https://relay.example', 'wss://user:pw@relay.example', '', 'not a url', 42, null, `wss://r.example/${'x'.repeat(2100)}`]) {
      assert.equal(parseRelayUrl(value, API), null, String(value).slice(0, 40));
    }
  });

  it('startup failure lines name the fix', () => {
    assert.match(relayTokenFailureMessage(new UnauthorizedError('no'), API), /--new-identity/);
    assert.match(relayTokenFailureMessage(new Error('Relay token failed (403): no'), API), /refused this computer/);
    assert.match(relayTokenFailureMessage(new Error('Relay token failed (503)'), API), /\(Relay token failed \(503\)\)\. Check the connection/);
    assert.match(MISSING_RELAY_URL_MESSAGE, /FTOWN_CENTRIFUGO_URL/);
  });
});
