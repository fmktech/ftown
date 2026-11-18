import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBridgeOption, PEER_GROUPS } from './peers-cli.js';
import { classifyHttp } from './security/bridge/permissions.js';
import { LocalApiServer } from './local-api-server.js';
import type { PeerControl } from './peer-control.js';
import type { BridgeSecurityService } from './security/bridge/security.js';
import type { VerifiedApplication } from './security/protocol.js';

test('--bridge is taken from anywhere before --, in both spellings, and the last one wins', () => {
  assert.deepEqual(extractBridgeOption(['list', '--bridge', 'desk']), { args: ['list'], target: 'desk' });
  assert.deepEqual(extractBridgeOption(['--bridge=desk', 'screen', 'abc', '-n', '20']), { args: ['screen', 'abc', '-n', '20'], target: 'desk' });
  assert.deepEqual(extractBridgeOption(['list', '--bridge', 'a', '--bridge=b']), { args: ['list'], target: 'b' });
  assert.deepEqual(extractBridgeOption(['list']), { args: ['list'], target: null });
});

test('text after -- is never read as --bridge', () => {
  assert.deepEqual(extractBridgeOption(['keys', 'abc', '--', '--bridge', 'x']), { args: ['keys', 'abc', '--', '--bridge', 'x'], target: null });
});

test('--bridge without a value is an error', () => {
  assert.throws(() => extractBridgeOption(['list', '--bridge']), /requires a bridge/);
  assert.throws(() => extractBridgeOption(['list', '--bridge', '--json']), /requires a bridge/);
  assert.throws(() => extractBridgeOption(['list', '--bridge=']), /requires a bridge/);
});

test('forwarding covers the session-control groups, never local-machine or security ones', () => {
  for (const group of ['sessions', 'board', 'events', 'worktrees', 'plan', 'brief', 'attention', 'status']) assert.ok(PEER_GROUPS.has(group), group);
  for (const group of ['security', 'setup', 'start', 'env', 'accounts', 'quota', 'harness', 'bridges']) assert.ok(!PEER_GROUPS.has(group), group);
});

test('the peers routes are classified: list is read, forwarding is control, anything else is refused', () => {
  assert.equal(classifyHttp('GET', '/api/peers').permission, 'read');
  assert.equal(classifyHttp('GET', '/api/peers?probe=1').permission, 'read');
  assert.equal(classifyHttp('POST', '/api/peers/http').permission, 'control');
  assert.throws(() => classifyHttp('POST', '/api/peers'));
  assert.throws(() => classifyHttp('GET', '/api/peers?other=1'));
  assert.throws(() => classifyHttp('GET', '/api/peers/http'));
  assert.throws(() => classifyHttp('POST', '/api/peers/http?x=1'));
});

test('the peer list answers the CLI as an HTTP response the CLI can read', async () => {
  const server = new LocalApiServer();
  const peers = [{ bridgeId: 'peer-1', label: 'Desk', endpointId: 'ep-2', approvedAt: '2026-11-10T12:00:00.000Z', direct: false }];
  const probes: boolean[] = [];
  server.setSecurity({ bridgeId: 'bridge-1', revalidate: async () => {} } as unknown as BridgeSecurityService,
    { bridgeId: 'bridge-1' } as Parameters<LocalApiServer['setSecurity']>[1], async () => null);
  server.setPeerControl({ list: async (probe: boolean) => { probes.push(probe); return peers; } } as unknown as PeerControl);
  const ask = (path: string) => server.dispatchSecure({
    principal: { endpoint: { id: 'cli-1', ownerId: 'owner-1', kind: 'local-cli', publicKey: '', createdAt: 0 }, permission: 'admin' },
    application: { type: 'application', route: { kind: 'http', requestId: 'req-1', method: 'GET', path }, data: {}, mcp: null },
  } as unknown as VerifiedApplication);
  // The shape cli-client's apiResponse requires: without `status` the CLI fails with "Invalid encrypted API response".
  assert.deepEqual(await ask('/api/peers'), { status: 200, body: { bridgeId: 'bridge-1', peers } });
  assert.deepEqual(await ask('/api/peers?probe=1'), { status: 200, body: { bridgeId: 'bridge-1', peers } });
  assert.deepEqual(probes, [false, true]);
});
