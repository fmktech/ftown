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
import type { EndpointIdentity, LocalEventPage, SecureApplication, SecureEnvelope } from './security/protocol.js';
import { LocalApiServer } from './local-api-server.js';

const email = 'owner@example.test';
const BROWSERS = 3;
/** Policy snapshot reads for one relay publication to three browsers (the local CLI is provisioned too), prepare() included. */
const SNAPSHOT_READS_PER_PUBLICATION = 10;
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
  return { security, client, cli, browsers, published, drained, opened, directory, ownerId: secure.pointer.ownerId! };
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
