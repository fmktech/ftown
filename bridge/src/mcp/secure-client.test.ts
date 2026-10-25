import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { generateEndpoint, open, seal } from '../security/crypto.js';
import type { ApplicationJson, SecureApplication, SecureEnvelope } from '../security/protocol.js';
import { SecureMcpClient, type McpRequestContext, type SecureExchange } from './secure-client.js';
import { Fleet, FleetError, configSchema } from './fleet.js';

const ownerId = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
async function fixture(control = false) {
  const mcp = await generateEndpoint(ownerId, 'mcp');
  const bridge = await generateEndpoint(ownerId, 'bridge');
  const channel = 'commands:rpc#owner@example.test';
  const permissions: ('read' | 'control')[] = control ? ['read', 'control'] : ['read'];
  const context: McpRequestContext = {
    grant: { ownerId, requestId: randomBytes(32).toString('base64url'), grantId: randomBytes(32).toString('base64url'), identity: mcp,
      bridges: [{ bridgeId: 'machine-a', endpoint: bridge.endpoint, permissions }], permissions,
      pendingExpiresAt: new Date(Date.now() + 300_000).toISOString(), activeExpiresAt: new Date(Date.now() + 1000_000).toISOString(), state: 'active' },
    action: { actionId: randomUUID(), parentActionId: null, clientId: 'client-a', grantId: '', tool: 'chats_search', operation: null },
  };
  context.action.grantId = context.grant.grantId;
  const delivered: { value: unknown; mutating: boolean }[] = [];
  const exchange: SecureExchange = async (packet, _deadline, mutating) => {
    const value = JSON.parse(new TextDecoder().decode(await open(bridge, mcp.endpoint, packet, { ownerId, bridgeId: 'machine-a', channel, recipientId: bridge.endpoint.id, purpose: packet.purpose })));
    delivered.push({ value, mutating });
    let response: unknown;
    if (packet.purpose === 'hello') response = { type: 'welcome', challenge: value.challenge, receiverEpoch: 'current-epoch' };
    else {
      const application = value as SecureApplication;
      assert.equal(packet.receiverEpoch, 'current-epoch');
      assert.equal(packet.messageId, 'requestId' in application.route ? application.route.requestId : undefined);
      const data: ApplicationJson = application.route.kind === 'command'
        ? { type: 'command_response', response: { requestId: packet.messageId, success: true, data: { grantId: context.grant.grantId } } }
        : { status: 200, body: { matches: ['example'] } };
      response = { type: 'application', route: { kind: 'response', requestId: packet.messageId }, data, mcp: null };
    }
    return seal(bridge, mcp.endpoint, { ...packet, senderId: bridge.endpoint.id, recipientId: mcp.endpoint.id, purpose: packet.purpose === 'hello' ? 'welcome' : 'application', receiverEpoch: null }, new TextEncoder().encode(JSON.stringify(response)));
  };
  return { context, bridge, delivered, exchange, channel };
}
test('read-only grant can perform POST grep after encrypted hello and exact grant activation', async () => {
  const f = await fixture();
  const result = await new SecureMcpClient(f.context, 'machine-a', f.channel, f.exchange).request({ method: 'POST', path: '/api/sessions/session-a/grep', body: { pattern: 'example' }, timeoutMs: 1000 });
  assert.deepEqual(result, { matches: ['example'] });
  assert.equal(f.delivered.length, 3);
  assert.equal(f.delivered[2].mutating, false);
  const activation = f.delivered[1].value as SecureApplication;
  assert.equal(activation.route.kind, 'command');
  assert.equal(activation.mcp?.grantId, f.context.grant.grantId);
});
test('consuming GET inbox and native wake registration require control before any dispatch', async () => {
  const f = await fixture();
  const client = new SecureMcpClient(f.context, 'machine-a', f.channel, f.exchange);
  for (const path of ['/api/sessions/session-a/inbox', '/api/sessions/session-a/inbox?peek=1&nativeSessionId=123', '/api/sessions/session-a/inbox?peek=1&peek=0']) {
    await assert.rejects(client.request({ method: 'GET', path, timeoutMs: 1000 }), { code: 'permission_denied' });
  }
  assert.equal(f.delivered.length, 0);
  await client.request({ method: 'GET', path: '/api/sessions/session-a/inbox?peek=1', timeoutMs: 1000 });
  assert.equal(f.delivered[2].mutating, false);
});
test('control inbox consumption passes mutation uncertainty through encrypted exchange', async () => {
  const f = await fixture(true);
  const exchange: SecureExchange = async (packet, deadline, mutating, signal) => {
    if (mutating) throw new FleetError('timeout', 'Bridge did not respond', true);
    return f.exchange(packet, deadline, mutating, signal);
  };
  await assert.rejects(new SecureMcpClient(f.context, 'machine-a', f.channel, exchange).request({ method: 'GET', path: '/api/sessions/session-a/inbox', timeoutMs: 1000 }), { code: 'timeout', outcomeUnknown: true });
});
test('changed bridge key, unapproved bridge and stale approval reject without plaintext fallback', async () => {
  const f = await fixture();
  await assert.rejects(new SecureMcpClient(f.context, 'machine-b', f.channel, f.exchange).request({ method: 'GET', path: '/api/sessions', timeoutMs: 1000 }), { code: 'approval_required' });
  const expired = { ...f.context, grant: { ...f.context.grant, activeExpiresAt: new Date(1).toISOString() } };
  await assert.rejects(new SecureMcpClient(expired, 'machine-a', f.channel, f.exchange).request({ method: 'GET', path: '/api/sessions', timeoutMs: 1000 }), { code: 'expired' });
  const other = await generateEndpoint(ownerId, 'bridge');
  const swapped = { ...f.context, grant: { ...f.context.grant, bridges: [{ ...f.context.grant.bridges[0], endpoint: other.endpoint }] } };
  await assert.rejects(new SecureMcpClient(swapped, 'machine-a', f.channel, f.exchange).request({ method: 'GET', path: '/api/sessions', timeoutMs: 1000 }));
  assert.equal(f.delivered.length, 0);
});
test('one shared Fleet keeps distinct grant/action contexts under concurrent execution', async () => {
  const first = await fixture(); const second = await fixture();
  const seen: string[] = [];
  const fleet = new Fleet(configSchema.parse({ concurrency: 1, machines: [{ id: 'machine-a', transport: 'relay', userId: 'owner@example.test' }] }), async (_user, _machine, _request, _signal, context) => {
    assert.ok(context); seen.push(context.grant.grantId); await new Promise(resolve => setImmediate(resolve)); return context.action.actionId;
  });
  const result = await Promise.all([fleet.scoped(first.context).request('machine-a', 'GET', '/api/sessions'), fleet.scoped(second.context).request('machine-a', 'GET', '/api/sessions')]);
  assert.deepEqual(result, [first.context.action.actionId, second.context.action.actionId]);
  assert.deepEqual(seen, [first.context.grant.grantId, second.context.grant.grantId]);
});
