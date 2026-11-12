import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { CentrifugoClient } from './centrifugo-client.js';
import { secureFixture } from './security/bridge/fixtures.test.js';
import { loadLocalIdentity } from './security/bridge/identity.js';
import { applicationJson } from './security/bridge/security.js';
import { AtomicSnapshot } from './security/bridge/snapshot.js';
import { generateEndpoint, open, seal } from './security/crypto.js';
import { BridgeSecurityError } from './security/bridge/errors.js';
import type { EndpointIdentity, LocalEventPage, SecureApplication, SecureEnvelope } from './security/protocol.js';
import { LocalApiServer } from './local-api-server.js';

const email = 'owner@example.test';
const BROWSERS = 3;
/** Policy snapshot reads for one relay publication to three browsers (the local CLI is provisioned too), prepare() included. */
// Was 1 + 3 per recipient (13 with the local CLI as a fourth recipient): now one read for the readers and their keys, plus the
// per-packet re-check in prepare().
const SNAPSHOT_READS_PER_PUBLICATION = 1 + BROWSERS;
/** Whether the relay publication carries an envelope for the local-cli endpoint. */
const RELAY_SEALS_TO_LOCAL_CLI = false;

/** The real client, pipeline, security service and policy store; only the relay socket is replaced. */
async function publicationFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'publication-seal-'));
  const secure = await secureFixture(directory, async () => new Response('{}'));
  const security = secure.security;
  const cli = await loadLocalIdentity(directory, secure.pointer.ownerId!);
  const browsers: EndpointIdentity[] = [];
  for (let index = 0; index < BROWSERS; index++) {
    const browser = await generateEndpoint(secure.pointer.ownerId!, 'browser');
    const invite = await security.policy.createInvitation(await security.policy.principal(cli.endpoint.id), { label: `browser-${index}` });
    await security.policy.consumeInvitation({ type: 'enroll', candidate: browser.endpoint, invitationId: invite.invitationId,
      invitationSecret: invite.secret, label: `browser-${index}` });
    browsers.push(browser);
  }
  const published: { channel: string; envelope: SecureEnvelope }[] = [];
  const transport = Object.assign(new EventEmitter(), { state: 'connected',
    publish: async (channel: string, envelope: SecureEnvelope) => { published.push({ channel, envelope }); },
    newSubscription: () => Object.assign(new EventEmitter(), { state: 'unsubscribed', subscribe() {}, unsubscribe() {} }) });
  const client = new CentrifugoClient('ws://127.0.0.1:1/unused', '', async () => '');
  Object.defineProperty(client, 'client', { value: transport });
  client.setSecurity(security);
  t.after(async () => { await security.close(); await rm(directory, { recursive: true, force: true }); });
  /** Resolves once the outbound pipeline has prepared and handed over everything enqueued so far. */
  const drained = async () => { await (client as unknown as { outbound: { idle(): Promise<void> } }).outbound.idle(); };
  const opened = async (browser: EndpointIdentity, item: { channel: string; envelope: SecureEnvelope }) => JSON.parse(new TextDecoder().decode(
    await open(browser, security.endpoint, item.envelope, { ownerId: browser.endpoint.ownerId, bridgeId: 'bridge', channel: item.channel,
      recipientId: browser.endpoint.id, purpose: 'application' }))) as { route: { kind: string }; data: Record<string, unknown> };
  return { security, client, cli, browsers, published, drained, opened, directory, transport, ownerId: secure.pointer.ownerId! };
}
const recipientsOf = (published: { envelope: SecureEnvelope }[]) => published.map(item => item.envelope.recipientId).sort();

test('one relay publication: policy snapshot reads, recipients, and every browser opens its own envelope', async t => {
  const f = await publicationFixture(t);
  const reads = t.mock.method(AtomicSnapshot.prototype, 'read');
  await f.client.publishHookEvent(email, 'session', { hook_event_name: 'Stop', marker: 'counted' });
  await f.drained();
  const measured = reads.mock.callCount();
  reads.mock.restore();
  t.diagnostic(`policy snapshot reads per publication with ${BROWSERS} browsers: ${measured}`);
  const expected = [...f.browsers.map(browser => browser.endpoint.id), ...(RELAY_SEALS_TO_LOCAL_CLI ? [f.cli.endpoint.id] : [])].sort();
  assert.deepEqual(recipientsOf(f.published), expected);
  for (const browser of f.browsers) {
    const mine = f.published.filter(item => item.envelope.recipientId === browser.endpoint.id);
    assert.equal(mine.length, 1);
    const application = await f.opened(browser, mine[0]);
    assert.equal(application.route.kind, 'publication');
    assert.equal(application.data.marker, 'counted');
  }
  assert.equal(measured, SNAPSHOT_READS_PER_PUBLICATION);
});

test('the local CLI gets no relay envelope, and its local events poll still returns the publication', async t => {
  const f = await publicationFixture(t);
  const server = new LocalApiServer();
  server.setSecurity(f.security, { protocolVersion: 1, ownerId: f.ownerId, bridgeId: 'bridge', endpoint: f.security.endpoint, relayUserId: email },
    async () => null);
  // index.ts wires the local events ring to the client's plaintext local listeners exactly like this.
  f.client.onLocalPublication((channel, data) => server.recordPublication(channel, data));
  // The local CLI is still an approved reader: policy.recipients() keeps its semantics for every other caller.
  assert.ok((await f.security.policy.recipients()).some(device => device.endpoint.id === f.cli.endpoint.id));
  const readers = await f.security.policy.readers();
  assert.deepEqual(readers.map(reader => reader.endpoint), (await f.security.policy.recipients()).map(device => device.endpoint));
  assert.deepEqual(readers.find(reader => reader.endpoint.id === f.browsers[0].endpoint.id), await f.security.policy.principal(f.browsers[0].endpoint.id));
  await f.client.publishHookEvent(email, 'session', { hook_event_name: 'Stop', marker: 'for-everyone' });
  await f.client.publishSessionUpdate(email, { id: 'session', name: 'n', command: '', status: 'running', bridgeId: 'bridge', createdAt: '', updatedAt: '' });
  await f.drained();
  assert.equal(f.published.length, 2 * BROWSERS);
  assert.ok(f.published.every(item => item.envelope.recipientId !== f.cli.endpoint.id), 'no relay envelope is addressed to the local CLI');
  assert.deepEqual([...new Set(recipientsOf(f.published))], f.browsers.map(browser => browser.endpoint.id).sort());

  const route = { transport: 'local-events' as const, bridgeId: 'bridge', channel: 'local-events:bridge', pairId: null };
  const requestId = randomUUID();
  const application: SecureApplication = { type: 'application', route: { kind: 'http', method: 'GET', path: '/api/browser/events?after=0', requestId },
    data: {}, mcp: null };
  const poll = await seal(f.cli, f.security.endpoint, { type: 'ftown_encrypted', version: 1, senderId: f.cli.endpoint.id,
    recipientId: f.security.endpoint.id, ownerId: f.ownerId, bridgeId: 'bridge', channel: route.channel, purpose: 'application', messageId: requestId,
    createdAt: Date.now(), expiresAt: Date.now() + 60000, receiverEpoch: f.security.receiverEpoch }, new TextEncoder().encode(JSON.stringify(application)));
  const verified = await f.security.acceptApplication(poll, route);
  const page = await server.dispatchSecure(verified) as unknown as LocalEventPage;
  assert.equal(page.events.length, 2);
  assert.equal((page.events[0].data as { marker?: string }).marker, 'for-everyone');
  // The page itself is sealed to the local CLI on the local route, which it can open.
  const reply = await f.security.sealTo(f.cli.endpoint.id, { type: 'application', route: { kind: 'response', requestId }, data: applicationJson(page), mcp: null }, route);
  assert.equal(reply.recipientId, f.cli.endpoint.id);
  const openedReply = JSON.parse(new TextDecoder().decode(await open(f.cli, f.security.endpoint, reply, { ownerId: f.ownerId, bridgeId: 'bridge',
    channel: route.channel, recipientId: f.cli.endpoint.id, purpose: 'application' }))) as { data: LocalEventPage };
  assert.equal(openedReply.data.events.length, 2);
});

/** Records what sealPublication sealed, so a test can tell "never sealed" from "sealed, then dropped by prepare()". */
function recordSealed(f: Awaited<ReturnType<typeof publicationFixture>>) {
  const sealed: string[][] = [];
  const original = f.security.sealPublication.bind(f.security);
  f.security.sealPublication = async (channel, application) => {
    const packets = await original(channel, application);
    sealed.push(packets.flatMap(packet => packet.type === 'ftown_encrypted' ? [packet.recipientId] : []).sort());
    return packets;
  };
  return sealed;
}

const FAILED = '[Centrifugo] Encrypted publication failed';
/** console.error lines of the outbound pipeline's failure record. */
function captureFailures(t: TestContext) {
  const errors = t.mock.method(console, 'error', () => undefined);
  return () => errors.mock.calls.map(call => call.arguments.map(String).join(' ')).filter(line => line.startsWith(FAILED));
}

test('a recipient revoked after the publication was enqueued gets nothing; the others still go out and the drop is recorded', async t => {
  const f = await publicationFixture(t);
  const sealed = recordSealed(f);
  const failures = captureFailures(t);
  const [first, revoked, last] = f.browsers;
  const admin = await f.security.policy.principal(f.cli.endpoint.id);
  // Enqueue: the readers of this publication are read from the policy now, before the revocation below is applied.
  void f.client.publishHookEvent(email, 'session', { hook_event_name: 'Stop', marker: 'in-flight' });
  await f.security.revokeEndpoint(admin, revoked.endpoint.id);
  await f.drained();
  assert.deepEqual(sealed, [f.browsers.map(browser => browser.endpoint.id).sort()], 'the revoked browser was still a reader when the publication was sealed');
  assert.deepEqual(f.published.map(item => item.envelope.recipientId), [first.endpoint.id, last.endpoint.id], 'only the revoked recipient is dropped, order kept');
  for (const browser of [first, last]) {
    const application = await f.opened(browser, f.published.find(item => item.envelope.recipientId === browser.endpoint.id)!);
    assert.equal(application.data.marker, 'in-flight');
  }
  // One record for the one dropped packet, as before this branch: label and fixed error code only.
  assert.deepEqual(failures(), [`${FAILED}: events/unknown: approval_required: Bridge security: approval_required`]);
  for (const browser of f.browsers) assert.ok(!failures().join().includes(browser.endpoint.publicKey));
});

test('a policy failure at the egress check withholds that packet only, and is recorded', async t => {
  const f = await publicationFixture(t);
  const failures = captureFailures(t);
  const [first, broken, last] = f.browsers;
  const principal = f.security.policy.principal.bind(f.security.policy);
  f.security.policy.principal = async endpointId => {
    if (endpointId === broken.endpoint.id) throw new BridgeSecurityError('storage_unavailable');
    return principal(endpointId);
  };
  await f.client.publishHookEvent(email, 'session', { hook_event_name: 'Stop' });
  await f.drained();
  assert.deepEqual(f.published.map(item => item.envelope.recipientId), [first.endpoint.id, last.endpoint.id]);
  assert.deepEqual(failures(), [`${FAILED}: events/unknown: storage_unavailable: Bridge security: storage_unavailable`]);
});

// ---- Revocation windows: whenever the policy change lands, the target gets no envelope handed to the relay after it ----

type Change = 'revoke' | 'unread';
type Fixture = Awaited<ReturnType<typeof publicationFixture>>;
/** 'revoke' removes the device. 'unread' keeps it approved without `read` (no API does that; written straight to the policy). */
async function applyChange(f: Fixture, change: Change, target: EndpointIdentity): Promise<number> {
  if (change === 'revoke') {
    await f.security.revokeEndpoint(await f.security.policy.principal(f.cli.endpoint.id), target.endpoint.id);
  } else {
    const snapshot = (f.security.policy as unknown as { snapshot: { transact(update: (state: { generation: number;
      devices: { endpoint: { id: string }; permissions: string[] }[] }) => void): Promise<void> } }).snapshot;
    await snapshot.transact(state => {
      state.devices.find(device => device.endpoint.id === target.endpoint.id)!.permissions = ['control', 'admin'];
      state.generation++;
    });
  }
  return f.published.length;
}
/** Wraps an async method so that `after` runs once, right after a call for which `when` holds has returned. */
function afterFirst(owner: object, name: string, after: () => Promise<unknown>, when: (...args: unknown[]) => boolean = () => true): () => boolean {
  const holder = owner as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = holder[name];
  assert.equal(typeof original, 'function', `${name} exists`);
  let fired = false;
  holder[name] = async (...args: unknown[]) => {
    const result = await original.apply(owner, args);
    if (!fired && when(...args)) { fired = true; await after(); }
    return result;
  };
  return () => fired;
}
const dropCode = { revoke: 'approval_required', unread: 'permission_denied' } as const;

for (const change of ['revoke', 'unread'] as const) {
  const single = async (t: TestContext, arrange: (f: Fixture, strike: () => Promise<unknown>) => (() => boolean) | Promise<() => boolean>,
    sealedForTarget: boolean) => {
    const f = await publicationFixture(t);
    const failures = captureFailures(t);
    const sealed = recordSealed(f);
    const [first, second, target] = f.browsers;
    const fired = await arrange(f, () => applyChange(f, change, target));
    await f.client.publishHookEvent(email, 'session', { hook_event_name: 'Stop', marker: 'window' });
    await f.drained();
    assert.equal(fired(), true, 'the policy change happened inside the window');
    assert.equal(sealed[0].includes(target.endpoint.id), sealedForTarget);
    assert.equal(f.published.filter(item => item.envelope.recipientId === target.endpoint.id).length, 0, 'no envelope for the target reaches the relay');
    assert.deepEqual(f.published.map(item => item.envelope.recipientId), [first.endpoint.id, second.endpoint.id], 'the others are delivered, in order');
    assert.deepEqual(failures(), sealedForTarget ? [`${FAILED}: events/unknown: ${dropCode[change]}: Bridge security: ${dropCode[change]}`] : []);
  };

  test(`window 0 (${change} before enqueue): nothing is sealed for the target`, t => single(t, async (_f, strike) => {
    await strike();
    return () => true;
  }, false));

  test(`window 1 (${change} right after the recipient snapshot read, before any seal): 0 envelopes to the target`, t =>
    single(t, (f, strike) => afterFirst(f.security.policy, 'readers', strike), true));

  test(`window 1.5 (${change} after the first recipient's seal, before the target's): 0 envelopes to the target`, t =>
    single(t, (f, strike) => afterFirst(f.security, 'replyBytes', strike, recipient => (recipient as { id: string }).id === f.browsers[0].endpoint.id), true));

  test(`window 2 (${change} after sealPublication returned, before the packets are handed over): 0 envelopes to the target`, t =>
    single(t, (f, strike) => afterFirst(f.security, 'sealPublication', strike), true));

  test(`window 3 (${change} while prepared packets wait for in-flight room): 0 envelopes to the target afterwards, order of the rest kept`, async t => {
    const f = await publicationFixture(t);
    const failures = captureFailures(t);
    const [first, second, target] = f.browsers;
    const total = 40;
    // The relay stops acknowledging: 64 packets go in flight, the rest of the prepared packets wait for room.
    const waiters: (() => void)[] = [];
    let hold = true;
    const publish = f.transport.publish;
    f.transport.publish = async (channel, envelope) => { await publish(channel, envelope); if (hold) await new Promise<void>(resolve => waiters.push(resolve)); };
    for (let index = 0; index < total; index++) void f.client.publishHookEvent(email, 'session', { hook_event_name: 'Stop', index });
    for (let spin = 0; spin < 2000 && f.published.length < 64; spin++) await new Promise(resolve => setTimeout(resolve, 2));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.published.length, 64, 'the in-flight window is full');
    const handedOverBefore = await applyChange(f, change, target);
    assert.equal(handedOverBefore, 64);
    hold = false;
    for (const wake of waiters.splice(0)) wake();
    await f.drained();
    const after = f.published.slice(handedOverBefore);
    assert.equal(after.filter(item => item.envelope.recipientId === target.endpoint.id).length, 0, 'no envelope for the target reaches the relay after the change');
    for (const browser of [first, second]) {
      const indexes: unknown[] = [];
      for (const item of f.published.filter(candidate => candidate.envelope.recipientId === browser.endpoint.id)) indexes.push((await f.opened(browser, item)).data.index);
      assert.deepEqual(indexes, Array.from({ length: total }, (_, index) => index), 'every publication, in enqueue order');
    }
    // Recipients keep their relative order inside each publication.
    assert.deepEqual(after.map(item => item.envelope.recipientId).filter(id => id !== target.endpoint.id).slice(-2), [first.endpoint.id, second.endpoint.id]);
    // Every dropped packet goes through the pipeline's failure record: the first is logged at once, the rest are summarized by its window.
    assert.deepEqual(failures(), [`${FAILED}: events/unknown: ${dropCode[change]}: Bridge security: ${dropCode[change]}`]);
  });
}

test('each recipient of one publication gets its own message id and encapsulation, bound to that recipient and header', async t => {
  const f = await publicationFixture(t);
  await f.client.publishHookEvent(email, 'session', { hook_event_name: 'Stop', marker: 'bound' });
  await f.drained();
  const envelopes = f.published.map(item => item.envelope);
  const channel = f.published[0].channel;
  assert.equal(envelopes.length, BROWSERS);
  assert.equal(new Set(envelopes.map(envelope => envelope.messageId)).size, BROWSERS, 'one message id per recipient');
  assert.equal(new Set(envelopes.map(envelope => envelope.enc)).size, BROWSERS, 'one encapsulation per recipient');
  assert.equal(new Set(envelopes.map(envelope => envelope.ciphertext)).size, BROWSERS);
  const [a, b] = f.browsers;
  const forA = envelopes.find(envelope => envelope.recipientId === a.endpoint.id)!;
  const forB = envelopes.find(envelope => envelope.recipientId === b.endpoint.id)!;
  const context = (recipient: EndpointIdentity) => ({ ownerId: f.ownerId, bridgeId: 'bridge', channel, recipientId: recipient.endpoint.id, purpose: 'application' as const });
  const opens = (recipient: EndpointIdentity, envelope: SecureEnvelope) => open(recipient, f.security.endpoint, envelope, context(recipient));
  await opens(a, forA);
  // Cross-recipient swap: A's envelope is useless to B, as it is and relabelled, and B's ciphertext does not open under A's header.
  await assert.rejects(opens(b, forA), { code: 'wrong_context' });
  await assert.rejects(opens(b, { ...forA, recipientId: b.endpoint.id }), { code: 'authentication_failed' });
  await assert.rejects(opens(a, { ...forA, enc: forB.enc, ciphertext: forB.ciphertext }), { code: 'authentication_failed' });
  // Tampered authenticated header fields.
  const tampered: Partial<SecureEnvelope>[] = [{ messageId: forB.messageId }, { createdAt: forA.createdAt - 1 }, { expiresAt: forA.expiresAt + 1 },
    { receiverEpoch: 'epoch' }];
  for (const change of tampered) await assert.rejects(opens(a, { ...forA, ...change }), { code: 'authentication_failed' });
});

test('a revoked recipient is absent from the next publication although its key is still in the import cache', async t => {
  const f = await publicationFixture(t);
  const sealed = recordSealed(f);
  const [first, revoked, last] = f.browsers;
  await f.client.publishHookEvent(email, 'session', { hook_event_name: 'Stop', marker: 'before' });
  await f.drained();
  assert.deepEqual(recipientsOf(f.published), f.browsers.map(browser => browser.endpoint.id).sort());
  await f.security.revokeEndpoint(await f.security.policy.principal(f.cli.endpoint.id), revoked.endpoint.id);
  f.published.length = 0;
  const imports = t.mock.method(crypto.subtle as unknown as { importKey(...args: unknown[]): Promise<unknown> }, 'importKey');
  const rawImports = () => imports.mock.calls.filter(call => call.arguments[0] === 'raw' && call.arguments[1] instanceof Uint8Array
    && Buffer.from(call.arguments[1]).toString('base64url') === revoked.endpoint.publicKey).length;
  await f.client.publishHookEvent(email, 'session', { hook_event_name: 'Stop', marker: 'after' });
  await f.client.publishHookEvent(email, 'session', { hook_event_name: 'Stop', marker: 'after' });
  await f.drained();
  const remaining = [first.endpoint.id, last.endpoint.id].sort();
  assert.deepEqual(sealed.slice(1), [remaining, remaining], 'nothing is even sealed for the revoked browser');
  assert.deepEqual(recipientsOf(f.published), [...remaining, ...remaining].sort());
  // Its public key is still cached: sealing to it directly needs no import. The cache holds bytes, the policy decides recipients.
  const envelope = await seal(f.security.identity, revoked.endpoint, { type: 'ftown_encrypted', version: 1, senderId: f.security.endpoint.id,
    recipientId: revoked.endpoint.id, ownerId: f.ownerId, bridgeId: 'bridge', channel: 'probe', purpose: 'application', messageId: randomUUID(),
    createdAt: 1, expiresAt: 2, receiverEpoch: null }, new Uint8Array());
  assert.equal(envelope.recipientId, revoked.endpoint.id);
  assert.equal(rawImports(), 0);
  imports.mock.restore();
});
