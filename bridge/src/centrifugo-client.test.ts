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

const email = 'owner@example.test';
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'centri-security-'));
  const secure = await secureFixture(directory, async () => new Response('{}'));
  const identity = await loadLocalIdentity(directory, secure.pointer.ownerId!);
  const subscriptions = new Map<string, EventEmitter>();
  const transport = { state: 'connected', publish: async () => {}, newSubscription: (channel: string) => {
    const sub = Object.assign(new EventEmitter(), { subscribe() {}, unsubscribe() {} }); subscriptions.set(channel, sub); return sub;
  } };
  const client = new CentrifugoClient('ws://127.0.0.1:1/unused', '', async () => '');
  Object.defineProperty(client, 'client', { value: transport }); client.setSecurity(secure.security);
  t.after(async () => { await secure.security.close(); await rm(directory, { recursive: true, force: true }); });
  const packet = async (channel: string, data: SecureApplication) => seal(identity, secure.security.endpoint, {
    type: 'ftown_encrypted', version: 1, senderId: identity.endpoint.id, recipientId: secure.security.endpoint.id,
    ownerId: identity.endpoint.ownerId, bridgeId: 'bridge', channel, purpose: 'application', messageId: randomUUID(),
    createdAt: Date.now(), expiresAt: Date.now() + 60000, receiverEpoch: secure.security.receiverEpoch }, new TextEncoder().encode(JSON.stringify(data)));
  return { client, subscriptions, packet };
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
