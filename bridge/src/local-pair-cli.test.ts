import assert from 'node:assert/strict';
import test from 'node:test';
import { localAdminRequest } from './local-pair-cli.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateIdentity } from './security/bridge/identity.js';
import { BridgeSecurityService, applicationJson } from './security/bridge/security.js';
import { executeSecurePacket } from './security/bridge/execute.js';
import { generateEndpoint } from './security/crypto.js';
import type { EnrollmentPacket, SecureEnvelope } from './security/protocol.js';

test('legacy bearer-only local admin operations reject before fetching or following redirects', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Plaintext admin request attempted'); });
  const pointer = { port: 1234, token: 'hook-only-secret', bridgeId: 'bridge' };
  await assert.rejects(localAdminRequest(pointer, 'window', 'POST', {}), /Upgrade required/);
  await assert.rejects(localAdminRequest(pointer, 'redirect'), /Upgrade required/);
  await assert.rejects(localAdminRequest(pointer, 'devices'), { code: 'upgrade_required' });
  await assert.rejects(localAdminRequest(pointer, 'devices/device', 'DELETE'), { code: 'upgrade_required' });
  assert.equal(requests, 0);
});

test('local admin device inspection and revocation use the pinned encrypted CLI identity', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ftown-local-admin-'));
  const ownerId = '7bac2a7f-c58e-4845-856f-8283fb07ad96';
  const identity = await loadOrCreateIdentity(dataDir, ownerId, 'bridge');
  const client = await loadOrCreateIdentity(dataDir, ownerId, 'local-cli');
  const other = await generateEndpoint(ownerId, 'local-cli');
  const security = new BridgeSecurityService(identity, 'bridge', dataDir, { relayUserId: 'owner@example.test' });
  await security.policy.provisionLocalEndpoint(client.endpoint);
  await security.policy.provisionLocalEndpoint(other.endpoint);
  t.after(async () => { await security.close(); await rm(dataDir, { recursive: true, force: true }); });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://127.0.0.1:1234/api/security/envelope');
    assert.equal(init?.redirect, 'error');
    assert.ok(!JSON.stringify(init?.headers).includes('hook-only'));
    const packet = JSON.parse(String(init?.body)) as SecureEnvelope | EnrollmentPacket;
    const reply = await executeSecurePacket(security, packet, { transport: 'local-http', channel: 'local-http:bridge', bridgeId: 'bridge', pairId: null }, async message => {
      assert.equal(message.principal.endpoint.id, client.endpoint.id);
      const app = message.application;
      if (app.route.kind !== 'command') throw new Error('Expected a command');
      const data = app.data as { payload: { endpointId?: string } };
      if (app.route.command === 'security_devices') return applicationJson({ type: 'command_response', response: { requestId: app.route.requestId, success: true,
        data: { devices: await security.listDevices(message.principal) } } });
      assert.equal(app.route.command, 'security_revoke');
      await security.revokeEndpoint(message.principal, data.payload.endpointId!);
      return { type: 'command_response', response: { requestId: app.route.requestId, success: true, data: { revoked: true } } };
    });
    return new Response(JSON.stringify(reply));
  });
  const pointer = { port: 1234, token: 'hook-only', bridgeId: 'bridge', ownerId, dataDir, endpoint: identity.endpoint };
  const before = await localAdminRequest<{ devices: { endpoint: { id: string } }[] }>(pointer, 'devices');
  assert.equal(before.devices.length, 2);
  await localAdminRequest(pointer, `devices/${other.endpoint.id}`, 'DELETE');
  const after = await localAdminRequest<{ devices: { endpoint: { id: string } }[] }>(pointer, 'devices');
  assert.deepEqual(after.devices.map(device => device.endpoint.id), [client.endpoint.id]);
});
