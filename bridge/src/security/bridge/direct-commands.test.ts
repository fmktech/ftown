import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { generateEndpoint, open, parseSecureEnvelope, seal } from '../crypto.js';
import type { ApplicationJson, InboundTransportContext, SecureApplication, VerifiedApplication } from '../protocol.js';
import { BridgeSecurityService } from './security.js';
import { EncryptedPeerChannel, type DirectCommandDispatch } from './direct.js';
import { BridgeStartingError } from './errors.js';
import { FrameAssembler, isFrame } from '../../direct-transport/framing.js';

const owner = '7bac2a7f-c58e-4845-856f-8283fb07ad96';

async function fixture(t: { after(fn: () => Promise<void>): void }, dispatch?: DirectCommandDispatch, transport: 'webrtc' | 'loopback-ws' = 'webrtc') {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-direct-commands-'));
  const identity = await generateEndpoint(owner, 'bridge');
  const client = await generateEndpoint(owner, 'local-cli');
  const security = new BridgeSecurityService(identity, 'bridge', dir, { relayUserId: 'owner@example.test' });
  t.after(async () => { await security.close(); await rm(dir, { recursive: true, force: true }); });
  await security.policy.provisionLocalEndpoint(client.endpoint);
  const pairId = randomUUID();
  const route: InboundTransportContext = { transport, bridgeId: 'bridge', pairId, channel: `direct:${transport}:bridge:${pairId}` };
  const wire: string[] = [];
  let closures = 0;
  // Resolves each time something is written to the wire, so tests wait on the answer itself.
  let wake: (() => void) | null = null;
  const channel = new EncryptedPeerChannel(security, route, json => { wire.push(json); wake?.(); }, () => {}, () => {}, () => { closures++; wake?.(); }, dispatch);
  t.after(async () => channel.close());
  const envelope = (purpose: 'hello' | 'application', body: unknown, receiverEpoch: string | null, messageId: string = randomUUID()) => seal(client, identity.endpoint, {
    type: 'ftown_encrypted', version: 1, senderId: client.endpoint.id, recipientId: identity.endpoint.id, ownerId: owner, bridgeId: 'bridge', channel: route.channel,
    purpose, messageId, createdAt: Date.now(), expiresAt: Date.now() + 60000, receiverEpoch }, new TextEncoder().encode(JSON.stringify(body)));
  /** Everything the bridge wrote, reassembled and opened by the client (the welcome is skipped). */
  const received = async (): Promise<SecureApplication[]> => {
    const assembler = new FrameAssembler();
    const applications: SecureApplication[] = [];
    for (const item of wire) {
      const whole = isFrame(item) ? assembler.push(item) : item;
      if (whole === null) continue;
      const packet = parseSecureEnvelope(JSON.parse(whole));
      if (packet.purpose !== 'application') continue;
      const bytes = await open(client, identity.endpoint, packet, { ownerId: owner, bridgeId: 'bridge', recipientId: client.endpoint.id,
        channel: route.channel, purpose: 'application' });
      applications.push(JSON.parse(new TextDecoder().decode(bytes)) as SecureApplication);
    }
    return applications;
  };
  const until = async (done: () => Promise<boolean> | boolean): Promise<void> => {
    while (!(await done())) await new Promise<void>(resolve => { wake = resolve; });
    wake = null;
  };
  await channel.receive(JSON.stringify(await envelope('hello', { type: 'hello', challenge: randomUUID() }, null)));
  const command = async (type: string, payload: { [key: string]: ApplicationJson }): Promise<string> => {
    const requestId = randomUUID();
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
    await channel.receive(JSON.stringify(await envelope('application', { type: 'application', route: { kind: 'command', requestId, command: type, sessionId },
      data: { type, requestId, payload: { ...payload, bridgeId: 'bridge' } }, mcp: null }, security.receiverEpoch, requestId)));
    return requestId;
  };
  const answer = async (requestId: string) => (await received()).find(app => app.route.kind === 'response' && app.route.requestId === requestId);
  return { channel, command, received, answer, until, wire, pairId, closures: () => closures };
}

const sessions = (count: number): DirectCommandDispatch => async (message: VerifiedApplication) => ({ type: 'command_response',
  response: { requestId: message.envelope.messageId, success: true, data: { sessions: Array.from({ length: count }, (_, index) => ({ id: `s${index}`, title: 'x'.repeat(200) })) } } });

test('an authorized channel that serves commands says so; one that does not stays silent', async t => {
  const serving = await fixture(t, sessions(1));
  await serving.until(async () => (await serving.received()).length === 1);
  assert.deepEqual((await serving.received())[0].data, { kind: 'capabilities', commands: true });
  assert.deepEqual((await serving.received())[0].route, { kind: 'terminal', sessionId: '', frameType: 'capabilities', pairId: serving.pairId });

  const plain = await fixture(t);
  await plain.channel.drain();
  assert.deepEqual(await plain.received(), []);
});

for (const transport of ['webrtc', 'loopback-ws'] as const) {
  test(`a read command is answered on the ${transport} channel`, async t => {
    const seen: string[] = [];
    const f = await fixture(t, async message => {
      const route = message.application.route;
      seen.push(route.kind === 'command' ? route.command : route.kind);
      return sessions(2)(message);
    }, transport);
    const requestId = await f.command('list_sessions', {});
    await f.until(async () => !!(await f.answer(requestId)));
    const reply = (await f.answer(requestId))!.data as { type: string; response: { success: boolean; data: { sessions: unknown[] } } };
    assert.equal(reply.type, 'command_response');
    assert.equal(reply.response.data.sessions.length, 2);
    assert.deepEqual(seen, ['list_sessions']);
    assert.equal(f.closures(), 0);
  });
}

test('an answer too large for one message is framed and reassembles', async t => {
  const f = await fixture(t, sessions(1200));
  const requestId = await f.command('list_sessions', {});
  await f.until(async () => !!(await f.answer(requestId)));
  assert.ok(f.wire.filter(isFrame).length > 1, 'the answer was split');
  assert.ok(f.wire.every(item => item.length <= 32_100), 'every message fits a data channel');
  const reply = (await f.answer(requestId))!.data as { response: { data: { sessions: unknown[] } } };
  assert.equal(reply.response.data.sessions.length, 1200);
});

test('a command that changes something is never served on a direct channel', async t => {
  let dispatched = 0;
  const f = await fixture(t, async message => { dispatched++; return sessions(0)(message); });
  await f.command('stop_session', { sessionId: 's1' });
  await f.until(() => f.closures() > 0);
  assert.equal(dispatched, 0);
});

test('connection setup commands are not accepted on a direct channel', async t => {
  let dispatched = 0;
  const f = await fixture(t, async message => { dispatched++; return sessions(0)(message); });
  const requestId = randomUUID();
  void requestId;
  await f.command('terminal_watch', { sessionId: 's1' });
  await f.until(() => f.closures() > 0);
  assert.equal(dispatched, 0);
});

test('a bridge that is still starting answers so, and the channel stays up', async t => {
  const f = await fixture(t, async () => { throw new BridgeStartingError(); });
  const requestId = await f.command('list_sessions', {});
  await f.until(async () => !!(await f.answer(requestId)));
  assert.deepEqual((await f.answer(requestId))!.data, { status: 503, body: { error: 'bridge_starting', code: 'bridge_starting' } });
  assert.equal(f.closures(), 0);
});

test('without a dispatcher a command goes unanswered and terminal traffic is unaffected', async t => {
  const f = await fixture(t);
  const requestId = await f.command('list_sessions', {});
  await f.channel.drain();
  assert.equal(await f.answer(requestId), undefined);
  assert.equal(f.closures(), 0);
});
