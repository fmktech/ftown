import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { CentrifugoClient } from './centrifugo-client.js';
import { secureFixture } from './security/bridge/fixtures.test.js';
import { loadLocalIdentity } from './security/bridge/identity.js';
import { seal } from './security/crypto.js';
import type { SecureApplication } from './security/protocol.js';
import { signHeadAnnouncement } from './security/ledger/announce.js';
import { generateAuthKey } from './security/ledger/proof.js';
import { UpdateAdmission, UpdateResponseTicket } from './update-admission.js';
import { UpdateEffects } from './update-effects.js';

const email = 'owner@example.test';
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'centri-security-'));
  const secure = await secureFixture(directory, async () => new Response('{}'));
  const identity = await loadLocalIdentity(directory, secure.pointer.ownerId!);
  const subscriptions = new Map<string, EventEmitter>();
  const transport = Object.assign(new EventEmitter(), { state: 'connected', publish: async (_channel: string, _data: unknown) => {}, newSubscription: (channel: string) => {
    const sub = Object.assign(new EventEmitter(), { state: 'unsubscribed', subscribe() { this.state = 'subscribed'; this.emit('subscribed'); }, unsubscribe() { this.state = 'unsubscribed'; this.emit('unsubscribed'); } }); subscriptions.set(channel, sub); return sub;
  } });
  const client = new CentrifugoClient('ws://127.0.0.1:1/unused', '', async () => '');
  Object.defineProperty(client, 'client', { value: transport }); client.setSecurity(secure.security);
  t.after(async () => { await secure.security.close(); await rm(directory, { recursive: true, force: true }); });
  const packet = async (channel: string, data: SecureApplication) => seal(identity, secure.security.endpoint, {
    type: 'ftown_encrypted', version: 1, senderId: identity.endpoint.id, recipientId: secure.security.endpoint.id,
    ownerId: identity.endpoint.ownerId, bridgeId: 'bridge', channel, purpose: 'application', messageId: randomUUID(),
    createdAt: Date.now(), expiresAt: Date.now() + 60000, receiverEpoch: secure.security.receiverEpoch }, new TextEncoder().encode(JSON.stringify(data)));
  return { client, subscriptions, packet, transport };
}
const settle = async (condition: () => boolean) => { for (let count = 0; count < 100 && !condition(); count++) await new Promise(resolve => setTimeout(resolve, 5)); };

test('cloud commands require both authenticated owner publication and endpoint ciphertext; plaintext never dispatches', async t => {
  const f = await fixture(t); let executed = 0;
  f.client.subscribeSecureCommands(email, async () => { executed++; return {}; });
  const channel = `commands:rpc#${email}`; const subscription = f.subscriptions.get(channel)!;
  const requestId = randomUUID();
  const encrypted = await f.packet(channel, { type: 'application', route: { kind: 'command', requestId, command: 'list_sessions', sessionId: null },
    data: { type: 'list_sessions', requestId, payload: { bridgeId: 'bridge' } }, mcp: null });
  for (const info of [undefined, {}, { user: '' }, { user: 'other@example.test' }]) subscription.emit('publication', { info, data: encrypted });
  subscription.emit('publication', { info: { user: email }, data: { type: 'list_sessions', requestId, payload: {} } });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(executed, 0);
  subscription.emit('publication', { info: { user: email }, data: encrypted });
  await settle(() => executed === 1); assert.equal(executed, 1);
});

test('secure readiness is bound to current connected and subscribed transport', async t => {
  const f = await fixture(t); f.client.subscribeSecureCommands(email, async () => ({}));
  await f.client.waitUntilSecureCommandsReady(50);
  f.transport.state = 'disconnected'; f.transport.emit('disconnected', { code: 0, reason: 'test' });
  const waiting = f.client.waitUntilSecureCommandsReady(50);
  f.transport.emit('disconnected', { code: 0, reason: 'test' }); await assert.rejects(waiting, /disconnected/);
  f.transport.state = 'connected'; f.transport.emit('connected', { transport: 'test' });
  await assert.rejects(f.client.waitUntilSecureCommandsReady(5), /timed out/);
  f.subscriptions.get(`commands:rpc#${email}`)!.emit('subscribed'); await f.client.waitUntilSecureCommandsReady(50);
});

test('cloud delivery starts a verified ticket only after publish resolves and cancels on rejection', async t => {
  for (const reject of [false, true]) {
    const f = await fixture(t); const admission = new UpdateAdmission(); const effects = new UpdateEffects(admission);
    let starts = 0, cancels = 0, publishStarted = false; let finish!: () => void;
    f.transport.publish = async () => { publishStarted = true; await new Promise<void>(resolve => { finish = resolve; }); if (reject) throw new Error('offline'); };
    const channel = `commands:rpc#${email}`; const requestId = randomUUID();
    const payload = { bridgeId: 'bridge', operationId: randomUUID(), targetVersion: '1.2.3' };
    f.client.subscribeSecureCommands(email, async message => {
      effects.attachTicket(message, new UpdateResponseTicket(() => { starts++; }, () => { cancels++; }));
      return { type: 'command_response', response: { requestId, success: true, data: { bridgeId: 'bridge', operation: { id: payload.operationId, targetVersion: payload.targetVersion } } } };
    }, effects);
    const encrypted = await f.packet(channel, { type: 'application', route: { kind: 'command', requestId, command: 'update_bridge', sessionId: null }, data: { type: 'update_bridge', requestId, payload }, mcp: null });
    f.subscriptions.get(channel)!.emit('publication', { info: { user: email }, data: encrypted });
    await settle(() => publishStarted); assert.equal(publishStarted, true); assert.equal(starts, 0); finish();
    await settle(() => starts + cancels > 0); assert.equal(starts, reject ? 0 : 1); assert.equal(cancels, reject ? 1 : 0);
  }
});

test('terminal keys reject foreign publishers, missing identity and plaintext before authenticated ordered delivery', async t => {
  const f = await fixture(t); const inputs: string[] = []; const sizes: number[] = [];
  const channel = `terminal-input:session#${email}`;
  f.client.subscribeToTerminalInput(email, 'session', (_id, data) => inputs.push(data), (_id, cols) => sizes.push(cols));
  const subscription = f.subscriptions.get(channel)!;
  const input = await f.packet(channel, { type: 'application', route: { kind: 'terminal', sessionId: 'session', frameType: 'input', pairId: null },
    data: { kind: 'input', sessionId: 'session', data: 'safe' }, mcp: null });
  subscription.emit('publication', { info: { user: 'foreign' }, data: input });
  subscription.emit('publication', { data: input });
  subscription.emit('publication', { info: { user: email }, data: { type: 'input', data: 'plaintext' } });
  subscription.emit('publication', { info: { user: email }, data: input });
  const resize = await f.packet(channel, { type: 'application', route: { kind: 'terminal', sessionId: 'session', frameType: 'resize', pairId: null },
    data: { kind: 'resize', sessionId: 'session', cols: 120, rows: 40 }, mcp: null });
  subscription.emit('publication', { info: { user: email }, data: resize });
  await settle(() => sizes.length === 1); assert.deepEqual(inputs, ['safe']); assert.deepEqual(sizes, [120]);
});

// ---- Pipelined outbound publish and command-rejected log ----

/**
 * Client with a stubbed seal/authorize step (cheap and deterministic regardless of machine load) and a
 * fake transport whose publish() resolves after `state.replyMs`. Real sealing is covered by the tests above.
 */
async function publishFixture(t: { after(fn: () => Promise<void>): void }, recipientCount: number) {
  const directory = await mkdtemp(join(tmpdir(), 'centri-pipeline-'));
  const secure = await secureFixture(directory, async () => new Response('{}'));
  const sealedTags: string[] = [];
  const security = secure.security;
  security.sealPublication = async (_channel, application) => {
    sealedTags.push(JSON.stringify((application as { data: unknown }).data));
    const id = randomUUID();
    const packets: unknown[] = Array.from({ length: recipientCount }, (_, k) => ({ type: 'ftown_encrypted', recipientId: `recipient-${k}`, messageId: `${id}/${k}` }));
    packets.splice(1, 0, { type: 'ftown_enrollment', recipientId: 'not-encrypted', messageId: `${id}/enroll` });
    return packets as never;
  };
  const principalCalls: string[] = [];
  security.policy.principal = async (recipientId: string) => { principalCalls.push(recipientId); return {} as never; };
  const published: { channel: string; recipientId: string; messageId: string }[] = [];
  const principalCallsAtPublish: number[] = [];
  let calls = 0;
  const state = { inFlight: 0, maxInFlight: 0, replyMs: (_call: number) => 50 };
  const transport = Object.assign(new EventEmitter(), { state: 'connected',
    publish: async (channel: string, data: { recipientId?: string; messageId?: string }) => {
      const call = calls++; principalCallsAtPublish.push(principalCalls.length);
      published.push({ channel, recipientId: String(data.recipientId), messageId: String(data.messageId) });
      state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try { await new Promise(resolve => setTimeout(resolve, state.replyMs(call))); } finally { state.inFlight--; }
    },
    newSubscription: () => Object.assign(new EventEmitter(), { state: 'unsubscribed', subscribe() {}, unsubscribe() {} }) });
  const client = new CentrifugoClient('ws://127.0.0.1:1/unused', '', async () => '');
  Object.defineProperty(client, 'client', { value: transport }); client.setSecurity(security);
  t.after(async () => { await security.close(); await rm(directory, { recursive: true, force: true }); });
  return { client, published, state, sealedTags, recipientCount, principalCalls, principalCallsAtPublish };
}

const settleLong = async (condition: () => boolean) => { for (let count = 0; count < 3000 && !condition(); count++) await new Promise(resolve => setTimeout(resolve, 5)); };

function captureWarnings(t: { after(fn: () => Promise<void>): void }) {
  const lines: string[] = []; const original = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  t.after(async () => { console.warn = original; });
  return lines;
}

test('300 publications at ~200/s with a 50 ms reply never hit the capacity warning and all packets are published', async t => {
  // Old chain: one packet in flight => ~1/(3 x 50 ms) = ~7 pub/s, so the 100-slot queue overflowed.
  const total = 300; const warnings = captureWarnings(t);
  const f = await publishFixture(t, 3); const recipients = f.recipientCount;
  for (let i = 0; i < total; i++) {
    void f.client.publishTerminalData(email, 'session', `chunk-${i}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await settleLong(() => f.published.length >= total * recipients);
  assert.deepEqual(warnings.filter(line => line.includes('Encrypted publication capacity reached')), []);
  assert.equal(f.published.length, total * recipients);
  assert.ok(f.state.maxInFlight > 1, `expected pipelined publishes, max in flight was ${f.state.maxInFlight}`);
});

test('packets reach the transport in publication order even when replies arrive in reverse', async t => {
  captureWarnings(t); const total = 20; // below the old 100-slot cap, so old code must pass this too
  const f = await publishFixture(t, 3); const recipients = f.recipientCount;
  f.state.replyMs = call => Math.max(5, 300 - call * 5); // later packets reply first
  for (let i = 0; i < total; i++) void f.client.publishTerminalData(email, 'session', `tag-${i}`);
  await settleLong(() => f.published.length >= total * recipients);
  assert.equal(f.published.length, total * recipients);
  assert.deepEqual(f.sealedTags, Array.from({ length: total }, (_, i) => JSON.stringify({ type: 'output', data: `tag-${i}` })));
  // Publications in enqueue order, recipients in sealed order within each.
  assert.deepEqual(f.published.map(p => p.recipientId), f.published.map((_, n) => `recipient-${n % recipients}`));
  const publicationIds = f.published.map(p => p.messageId.split('/')[0]);
  for (let i = 0; i < total; i++) assert.equal(new Set(publicationIds.slice(i * recipients, (i + 1) * recipients)).size, 1);
  assert.equal(new Set(publicationIds).size, total);
});

test('only encrypted packets are published, each authorized once before its publication is sent', async t => {
  captureWarnings(t); const total = 10;
  const f = await publishFixture(t, 3); const recipients = f.recipientCount;
  for (let i = 0; i < total; i++) void f.client.publishTerminalData(email, 'session', `tag-${i}`);
  await settleLong(() => f.published.length >= total * recipients);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.published.length, total * recipients);
  assert.ok(f.published.every(p => p.recipientId !== 'not-encrypted' && !p.messageId.endsWith('/enroll')));
  assert.deepEqual(f.principalCalls, f.published.map(p => p.recipientId));
  f.published.forEach((_, n) => assert.ok(f.principalCallsAtPublish[n] >= (Math.floor(n / recipients) + 1) * recipients,
    `publish ${n} sent after only ${f.principalCallsAtPublish[n]} principal calls`));
});

test('a rejected command response is logged with its code and message', async t => {
  const warnings = captureWarnings(t);
  const f = await fixture(t);
  f.transport.publish = async () => { throw { code: 108, message: 'not available' }; };
  const channel = `commands:rpc#${email}`; const requestId = randomUUID();
  f.client.subscribeSecureCommands(email, async () => ({}));
  const encrypted = await f.packet(channel, { type: 'application', route: { kind: 'command', requestId, command: 'list_sessions', sessionId: null },
    data: { type: 'list_sessions', requestId, payload: { bridgeId: 'bridge' } }, mcp: null });
  f.subscriptions.get(channel)!.emit('publication', { info: { user: email }, data: encrypted });
  await settle(() => warnings.some(line => line.includes('Encrypted command rejected')));
  assert.ok(warnings.some(line => line.includes('Encrypted command rejected: 108: not available')), warnings.join('\n'));
});

function ledgerFixture(onLedgerMessage: (m: unknown) => void) {
  const subscriptions = new Map<string, EventEmitter>();
  const transport = Object.assign(new EventEmitter(), { state: 'connected', removeSubscription: () => {}, newSubscription: (channel: string) => {
    const sub = Object.assign(new EventEmitter(), { subscribe() {}, unsubscribe() {} }); subscriptions.set(channel, sub); return sub;
  } });
  const client = new CentrifugoClient('ws://127.0.0.1:1/unused', '', async () => '', { onLedgerMessage });
  Object.defineProperty(client, 'client', { value: transport });
  return { client, subscriptions };
}

test('account ids and Solo id build channel names; ledger channel only in account mode', () => {
  const got: unknown[] = [];
  const account = ledgerFixture(m => got.push(m));
  account.client.joinBridgesChannel('acct_123', 'bridge');
  assert.deepEqual([...account.subscriptions.keys()].sort(), ['bridges:ledger#acct_123', 'bridges:presence#acct_123']);
  const solo = new CentrifugoClient('ws://127.0.0.1:1/unused', '', async () => '');
  const subs: string[] = [];
  Object.defineProperty(solo, 'client', { value: Object.assign(new EventEmitter(), { state: 'connected', newSubscription: (c: string) => { subs.push(c); return Object.assign(new EventEmitter(), { subscribe() {}, unsubscribe() {} }); } }) });
  solo.joinBridgesChannel('solo', 'bridge');
  assert.deepEqual(subs, ['bridges:presence#solo']);
});

test('ledger messages dispatch only when owner-published and strictly shaped', () => {
  const got: unknown[] = [];
  const f = ledgerFixture(m => got.push(m));
  f.client.joinBridgesChannel('acct_1', 'bridge');
  const sub = f.subscriptions.get('bridges:ledger#acct_1')!;
  const owner = { user: 'acct_1' };
  sub.emit('publication', { info: owner, data: { type: 'ledger', ledger: { genesis: {} } } });
  sub.emit('publication', { info: owner, data: { type: 'ledger_head', head: 'abc', revision: 3 } });
  assert.equal(got.length, 2);
  const bad: unknown[] = [null, 'x', [], {}, { type: 'ledger' }, { type: 'ledger', ledger: null }, { type: 'ledger', ledger: {}, extra: 1 },
    { type: 'ledger_head', head: '', revision: 1 }, { type: 'ledger_head', head: 'a', revision: -1 }, { type: 'ledger_head', head: 'a', revision: 1.5 },
    { type: 'ledger_head', head: 1, revision: 1 }, { type: 'ledger_head', head: 'a', revision: 1, x: 1 }, { type: 'other' }];
  for (const data of bad) sub.emit('publication', { info: owner, data });
  sub.emit('publication', { info: { user: 'someone' }, data: { type: 'ledger_head', head: 'abc', revision: 3 } });
  sub.emit('publication', { data: { type: 'ledger_head', head: 'abc', revision: 3 } });
  assert.equal(got.length, 2);
});

test('onLedgerSubscribed fires on each (re)subscribe, errors are contained, and Solo registers nothing', () => {
  let calls = 0;
  const subscriptions = new Map<string, EventEmitter>();
  const transport = Object.assign(new EventEmitter(), { state: 'connected', removeSubscription: () => {}, newSubscription: (channel: string) => {
    const sub = Object.assign(new EventEmitter(), { subscribe() {}, unsubscribe() {} }); subscriptions.set(channel, sub); return sub;
  } });
  const client = new CentrifugoClient('ws://127.0.0.1:1/unused', '', async () => '', { onLedgerMessage: () => {}, onLedgerSubscribed: () => { calls++; throw new Error('boom'); } });
  Object.defineProperty(client, 'client', { value: transport });
  client.joinBridgesChannel('acct_1', 'bridge');
  const sub = subscriptions.get('bridges:ledger#acct_1')!;
  sub.emit('subscribed'); assert.equal(calls, 1);
  sub.emit('subscribing'); sub.emit('subscribed'); assert.equal(calls, 2);
  const solo = ledgerFixture(() => {});
  const bare = new CentrifugoClient('ws://127.0.0.1:1/unused', '', async () => '', { onLedgerSubscribed: () => { calls++; } });
  Object.defineProperty(bare, 'client', { value: Object.assign(new EventEmitter(), { state: 'connected', newSubscription: (c: string) => { assert.ok(!c.startsWith('bridges:ledger')); return Object.assign(new EventEmitter(), { subscribe() {}, unsubscribe() {} }); } }) });
  bare.joinBridgesChannel('solo', 'bridge'); assert.equal(calls, 2); void solo;
});

// Head announcements (CONTRACT §13) on the ledger channel.
const ANNOUNCE_ACCOUNT = Buffer.alloc(32, 7).toString('base64url');
async function announcementFixture() {
  const subscriptions = new Map<string, EventEmitter & { state: string }>();
  const published: Array<{ channel: string; data: unknown }> = [];
  const got: unknown[] = [];
  const transport = Object.assign(new EventEmitter(), { state: 'connected', removeSubscription: () => {},
    publish: async (channel: string, data: unknown) => { published.push({ channel, data }); },
    newSubscription: (channel: string) => {
      const sub = Object.assign(new EventEmitter(), { state: 'unsubscribed', subscribe() { this.state = 'subscribed'; this.emit('subscribed'); }, unsubscribe() { this.state = 'unsubscribed'; } });
      subscriptions.set(channel, sub); return sub;
    } });
  const client = new CentrifugoClient('ws://127.0.0.1:1/unused', '', async () => '', { onLedgerMessage: m => got.push(m) });
  Object.defineProperty(client, 'client', { value: transport });
  const key = await generateAuthKey(false);
  const announcement = await signHeadAnnouncement(key.privateKey, {
    accountId: ANNOUNCE_ACCOUNT, kind: 'bridge', keyId: 'studio', head: Buffer.alloc(32, 9).toString('base64url'), revision: 4, at: 1_750_000_000_000,
  });
  return { client, transport, subscriptions, published, got, announcement };
}

test('a signed head announcement from the owner dispatches as head_announcement; malformed ones and other publishers never do', async () => {
  const f = await announcementFixture();
  f.client.joinBridgesChannel(ANNOUNCE_ACCOUNT, 'studio');
  const sub = f.subscriptions.get(`bridges:ledger#${ANNOUNCE_ACCOUNT}`)!;
  const owner = { user: ANNOUNCE_ACCOUNT };
  sub.emit('publication', { info: owner, data: f.announcement });
  assert.deepEqual(f.got, [{ type: 'head_announcement', announcement: f.announcement }]);
  // The unsigned 3-key notice keeps its meaning.
  sub.emit('publication', { info: owner, data: { type: 'ledger_head', head: 'abc', revision: 3 } });
  assert.deepEqual(f.got.at(-1), { type: 'ledger_head', head: 'abc', revision: 3 });
  const a = f.announcement;
  const bad: unknown[] = [{ ...a, extra: 1 }, { ...a, signature: a.signature.slice(1) }, { ...a, version: 2 }, { ...a, revision: 1025 }, { ...a, head: 'abc' },
    { ...a, kind: 'browser' }, { ...a, at: -1 }, { type: 'ledger_head', head: 'abc' }, { type: 'ledger_head', head: 'abc', revision: 3, at: 1 }];
  for (const data of bad) sub.emit('publication', { info: owner, data });
  assert.equal(f.got.length, 2);
  // Another account's client, an empty user and a server-API publish (no info) are dropped before parsing.
  for (const info of [{ user: 'someone' }, { user: '' }, undefined]) sub.emit('publication', { info, data: f.announcement });
  assert.equal(f.got.length, 2);
});

test('publishLedgerAnnouncement publishes the announcement on the subscribed ledger channel only', async () => {
  const f = await announcementFixture();
  await assert.rejects(f.client.publishLedgerAnnouncement(ANNOUNCE_ACCOUNT, f.announcement), /Ledger channel not subscribed/);
  f.client.joinBridgesChannel(ANNOUNCE_ACCOUNT, 'studio');
  const sub = f.subscriptions.get(`bridges:ledger#${ANNOUNCE_ACCOUNT}`)!;
  sub.state = 'subscribing';
  await assert.rejects(f.client.publishLedgerAnnouncement(ANNOUNCE_ACCOUNT, f.announcement), /Ledger channel not subscribed/);
  sub.state = 'subscribed';
  f.transport.state = 'connecting';
  await assert.rejects(f.client.publishLedgerAnnouncement(ANNOUNCE_ACCOUNT, f.announcement), /Ledger channel not subscribed/);
  f.transport.state = 'connected';
  await assert.rejects(f.client.publishLedgerAnnouncement(ANNOUNCE_ACCOUNT, { ...f.announcement, revision: -1 }), /Invalid head announcement/);
  await assert.rejects(f.client.publishLedgerAnnouncement(ANNOUNCE_ACCOUNT, { ...f.announcement, extra: 1 } as never), /Invalid head announcement/);
  const other = Buffer.alloc(32, 8).toString('base64url');
  await assert.rejects(f.client.publishLedgerAnnouncement(other, f.announcement), /Ledger channel not subscribed/);
  // Subscribed to another account's ledger channel: an announcement of this account is not published there.
  f.client.joinBridgesChannel(other, 'studio');
  await assert.rejects(f.client.publishLedgerAnnouncement(other, f.announcement), /Invalid head announcement/);
  assert.deepEqual(f.published, []);
  await f.client.publishLedgerAnnouncement(ANNOUNCE_ACCOUNT, f.announcement);
  assert.deepEqual(f.published, [{ channel: `bridges:ledger#${ANNOUNCE_ACCOUNT}`, data: f.announcement }]);
  const disabled = new CentrifugoClient('ws://127.0.0.1:1/unused', '', async () => '', { disabled: true, onLedgerMessage: () => {} });
  await assert.rejects(disabled.publishLedgerAnnouncement(ANNOUNCE_ACCOUNT, f.announcement), /Ledger channel not subscribed/);
});
