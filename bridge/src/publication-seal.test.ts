import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { CentrifugoClient } from './centrifugo-client.js';
import { secureFixture } from './security/bridge/fixtures.test.js';
import { loadLocalIdentity } from './security/bridge/identity.js';
import { AtomicSnapshot } from './security/bridge/snapshot.js';
import { generateEndpoint, open } from './security/crypto.js';
import type { EndpointIdentity, SecureEnvelope } from './security/protocol.js';

const email = 'owner@example.test';
const BROWSERS = 3;
/** Policy snapshot reads for one relay publication to three browsers (the local CLI is provisioned too), prepare() included. */
const SNAPSHOT_READS_PER_PUBLICATION = 13;
/** Whether the relay publication carries an envelope for the local-cli endpoint. */
const RELAY_SEALS_TO_LOCAL_CLI = true;

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
