import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { generateEndpoint, seal } from '../crypto.js';
import type { InboundTransportContext, SecureApplication } from '../protocol.js';
import { BridgeSecurityService } from './security.js';
import { EncryptedPeerChannel } from './direct.js';
import type { DirectMessage } from '../../direct-transport/contract.js';

const owner = '7bac2a7f-c58e-4845-856f-8283fb07ad96';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-direct-'));
  const identity = await generateEndpoint(owner, 'bridge');
  const client = await generateEndpoint(owner, 'local-cli');
  const security = new BridgeSecurityService(identity, 'bridge', dir, { relayUserId: 'owner@example.test' });
  t.after(async () => { await security.close(); await rm(dir, { recursive: true, force: true }); });
  await security.policy.provisionLocalEndpoint(client.endpoint);
  const route: InboundTransportContext = { transport: 'webrtc', bridgeId: 'bridge', pairId: randomUUID(), channel: '' };
  route.channel = `direct:webrtc:bridge:${route.pairId}`;
  const sent: string[] = [];
  const deliveries: DirectMessage[] = [];
  let closures = 0;
  const channel = new EncryptedPeerChannel(security, route, json => sent.push(json), frame => deliveries.push(frame), () => {}, () => { closures++; });
  t.after(async () => channel.close());
  const envelope = (purpose: 'hello' | 'application', body: unknown, receiverEpoch: string | null) => seal(client, identity.endpoint, { type: 'ftown_encrypted', version: 1,
    senderId: client.endpoint.id, recipientId: identity.endpoint.id, ownerId: owner, bridgeId: 'bridge', channel: route.channel, purpose, messageId: randomUUID(),
    createdAt: Date.now(), expiresAt: Date.now() + 60000, receiverEpoch }, new TextEncoder().encode(JSON.stringify(body)));
  await channel.receive(JSON.stringify(await envelope('hello', { type: 'hello', challenge: randomUUID() }, null)));
  sent.length = 0; // drop the hello response
  const input = async (data: string) => {
    const app: SecureApplication = { type: 'application', route: { kind: 'terminal', sessionId: 's', frameType: 'input', pairId: route.pairId },
      data: { kind: 'input', sessionId: 's', data }, mcp: null };
    return JSON.stringify(await envelope('application', app, security.receiverEpoch));
  };
  // Replaces sealTo with a deferred-gated stub; each call records its frame and waits for release().
  const sealed: string[] = [];
  const gates: Array<() => void> = [];
  security.sealTo = (async (_recipient: string, application: SecureApplication) => {
    sealed.push((application.data as { data?: string }).data ?? '');
    await new Promise<void>(resolve => gates.push(resolve));
    return { sealed: sealed.length } as never;
  }) as typeof security.sealTo;
  const release = () => { while (gates.length) gates.shift()!(); };
  return { channel, input, sent, sealed, deliveries, release, closures: () => closures };
}

const out = (data: string): DirectMessage => ({ kind: 'input', sessionId: 's', data });

test('inbound frame is delivered while an outbound seal is still pending', async t => {
  const f = await fixture(t);
  f.channel.send(out('out-1'));
  await tick();
  assert.deepEqual(f.sealed, ['out-1']);
  const inbound = f.channel.receive(await f.input('in-1'));
  const outcome = await Promise.race([inbound.then(() => 'done' as const), new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 2000))]);
  assert.deepEqual(f.deliveries, [{ kind: 'input', sessionId: 's', data: 'in-1' }]);
  assert.equal(outcome, 'done');
  f.release(); await f.channel.drain();
});

test('three inbound frames are delivered in order while outbound is pending', async t => {
  const f = await fixture(t);
  f.channel.send(out('out-1'));
  await tick();
  const frames = [await f.input('a'), await f.input('b'), await f.input('c')];
  const all = Promise.all(frames.map(json => f.channel.receive(json)));
  await Promise.race([all, new Promise(resolve => setTimeout(resolve, 2000))]);
  assert.deepEqual(f.deliveries.map(frame => 'data' in frame ? frame.data : ''), ['a', 'b', 'c']);
  f.release(); await f.channel.drain();
});

test('outbound frames are sealed and sent strictly in send order', async t => {
  const f = await fixture(t);
  for (const name of ['o1', 'o2', 'o3']) f.channel.send(out(name));
  await tick();
  assert.deepEqual(f.sealed, ['o1']);
  f.release(); await tick();
  assert.deepEqual(f.sealed, ['o1', 'o2']);
  f.release(); await tick();
  f.release(); await f.channel.drain();
  assert.deepEqual(f.sealed, ['o1', 'o2', 'o3']);
  assert.deepEqual(f.sent.map(json => (JSON.parse(json) as { sealed: number }).sealed), [1, 2, 3]);
});

test('an inbound failure tears the channel down', async t => {
  const f = await fixture(t);
  await f.channel.receive('not json');
  assert.equal(f.closures(), 1);
  assert.deepEqual(f.deliveries, []);
});
