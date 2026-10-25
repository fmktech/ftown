import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEndpoint, open, seal } from '../crypto.js';
import { createAccountGenesis, generateAccountSigningIdentity, signAccountTransition, verifyAccountHistory } from '../account-crypto.js';
import type { AccountHistory, AccountOperation } from '../account-protocol.js';
import type { EndpointIdentity } from '../protocol.js';
import { BridgeSecurityService } from './security.js';
import { LOCAL_RECOVERY_AUTHORITY } from './policy.js';
import { AccountReadUnavailable } from './account-client.js';
import { BridgeSecurityError } from './errors.js';
import { executeSecurePacket } from './execute.js';

const ownerId = '7bac2a7f-c58e-4845-856f-8283fb07ad96';
const day = 86_400_000;
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'ftown-account-policy-'));
  const bridge = await generateEndpoint(ownerId, 'bridge');
  const first = await generateEndpoint(ownerId, 'browser');
  const second = await generateEndpoint(ownerId, 'browser');
  const firstSigning = await generateAccountSigningIdentity();
  const secondSigning = await generateAccountSigningIdentity();
  let wall = Date.now(); let monotonic = 0;
  let history: AccountHistory = { genesis: await createAccountGenesis(ownerId, first.endpoint, firstSigning, 'First', wall), transitions: [] };
  let checkpoint = await verifyAccountHistory(history, null, wall);
  let readFailure: Error | null = null;
  const options = { relayUserId: 'owner@example.test', now: () => wall, monotonicNow: () => monotonic,
    readAccountHistory: async () => { if (readFailure) throw readFailure; return history; } };
  const security = new BridgeSecurityService(bridge, 'bridge', directory, options);
  t.after(async () => { await security.close(); await rm(directory, { recursive: true, force: true }); });
  async function enroll(identity: EndpointIdentity) {
    const invite = await security.policy.createInvitation(LOCAL_RECOVERY_AUTHORITY, { label: 'Legacy' });
    await security.policy.consumeInvitation({ type: 'enroll', candidate: identity.endpoint, invitationId: invite.invitationId,
      invitationSecret: invite.secret, label: 'Legacy' });
  }
  await enroll(first); await enroll(second);
  async function append(operation: AccountOperation, signer = first, signing = firstSigning) {
    const record = await signAccountTransition(checkpoint, signer.endpoint.id, signing, operation, wall);
    history = { ...history, transitions: [...history.transitions, record] };
    checkpoint = await verifyAccountHistory(history, checkpoint, wall);
  }
  await append({ type: 'add_bridge', bridge: { bridgeId: 'bridge', endpoint: bridge.endpoint, label: 'Computer', approvedAt: new Date(wall).toISOString() } });
  const head = () => ({ rootId: checkpoint.rootId, revision: checkpoint.revision, head: checkpoint.head });
  const actor = () => security.policy.principal(first.endpoint.id);
  return { directory, bridge, first, second, firstSigning, secondSigning, security, options, enroll, append, head, actor,
    history: () => history, checkpoint: () => checkpoint,
    time: () => wall, move(wallDelta: number, monotonicDelta = wallDelta) { wall += wallDelta; monotonic += monotonicDelta; },
    failReads(error: Error | null) { readFailure = error; } };
}

test('production device list projects trusted grant sources before and after adoption without persisting output metadata', async t => {
  const f = await fixture(t);
  const cli = await generateEndpoint(ownerId, 'local-cli');
  await f.security.policy.provisionLocalEndpoint(cli.endpoint);
  const mcp = await generateEndpoint(ownerId, 'mcp');
  await f.security.approveMcp(await f.actor(), { requestId: 'source-consent', grantId: 'source-grant', endpoint: mcp.endpoint,
    permissions: ['read'], expiresAt: new Date(f.time() + 300000).toISOString(), activeExpiresAt: new Date(f.time() + day).toISOString() });
  const file = join(f.directory, 'security', 'policy.json');
  // Historical grants may predate provenance metadata; absence remains the legacy contract.
  const legacyState = JSON.parse(await readFile(file, 'utf8'));
  delete legacyState.provenance[f.second.endpoint.id];
  await writeFile(file, JSON.stringify(legacyState));
  const listAsCli = async () => f.security.listDevices(await f.security.policy.principal(cli.endpoint.id));
  const beforeRead = await readFile(file, 'utf8');
  const before = await listAsCli();
  assert.equal(before.find(item => item.endpoint.id === cli.endpoint.id)!.source, 'local');
  for (const id of [f.first.endpoint.id, f.second.endpoint.id, mcp.endpoint.id]) {
    assert.equal(Object.hasOwn(before.find(item => item.endpoint.id === id)!, 'source'), false);
  }
  assert.equal(await readFile(file, 'utf8'), beforeRead);

  await f.security.adoptAccount(await f.actor(), f.head());
  const after = await listAsCli();
  assert.equal(after.find(item => item.endpoint.id === f.first.endpoint.id)!.source, 'account');
  assert.equal(after.find(item => item.endpoint.id === cli.endpoint.id)!.source, 'local');
  assert.equal(Object.hasOwn(after.find(item => item.endpoint.id === mcp.endpoint.id)!, 'source'), false);
  assert.ok(!after.some(item => item.endpoint.id === f.second.endpoint.id));
  const asAccountBrowser = await f.security.listDevices(await f.actor());
  assert.equal(asAccountBrowser.find(item => item.endpoint.id === f.first.endpoint.id)!.source, 'account');

  const invitation = await f.security.createInvitation(await f.security.policy.principal(cli.endpoint.id), { label: 'Local recovery' });
  await f.security.policy.consumeInvitation({ type: 'enroll', candidate: f.second.endpoint, invitationId: invitation.invitationId,
    invitationSecret: invitation.secret, label: 'Local recovery' });
  assert.equal((await listAsCli()).find(item => item.endpoint.id === f.second.endpoint.id)!.source, 'local');
  const persisted = await readFile(file, 'utf8');
  const records = JSON.parse(persisted) as { devices: object[]; mcp: Array<{ approved: object }> };
  assert.ok(records.devices.every(item => !Object.hasOwn(item, 'source')));
  assert.ok(records.mcp.every(item => !Object.hasOwn(item.approved, 'source')));

  const reloaded = new BridgeSecurityService(f.bridge, 'bridge', f.directory, f.options);
  try {
    const devices = await reloaded.listDevices(await reloaded.policy.principal(cli.endpoint.id));
    assert.equal(devices.find(item => item.endpoint.id === f.first.endpoint.id)!.source, 'account');
    assert.equal(devices.find(item => item.endpoint.id === f.second.endpoint.id)!.source, 'local');
    assert.equal(devices.find(item => item.endpoint.id === cli.endpoint.id)!.source, 'local');
    assert.equal(Object.hasOwn(devices.find(item => item.endpoint.id === mcp.endpoint.id)!, 'source'), false);
    assert.equal(await readFile(file, 'utf8'), persisted);
  } finally { await reloaded.close(); }
});

test('adoption atomically pins exact history, removes legacy grants/invitations and keeps OS-local recovery independent', async t => {
  const f = await fixture(t);
  const cli = await generateEndpoint(ownerId, 'local-cli');
  await f.security.policy.provisionLocalEndpoint(cli.endpoint);
  const invite = await f.security.createInvitation(await f.actor(), { label: 'Outstanding legacy' });
  assert.deepEqual(await f.security.adoptAccount(await f.actor(), f.head()), f.head());
  await assert.rejects(f.security.policy.principal(f.second.endpoint.id), { code: 'approval_required' });
  await assert.rejects(f.security.createInvitation(await f.actor(), { label: 'Bypass' }), { code: 'account_approval_required' });
  await assert.rejects(f.security.policy.consumeInvitation({ type: 'enroll', candidate: f.second.endpoint, invitationId: invite.invitationId,
    invitationSecret: invite.secret, label: 'Bypass' }), { code: 'invitation_invalid' });
  await assert.rejects(f.security.revokeEndpoint(await f.actor(), f.first.endpoint.id), { code: 'account_approval_required' });
  const recovery = await f.security.createInvitation(await f.security.policy.principal(cli.endpoint.id), { label: 'Recovery' });
  await f.security.policy.consumeInvitation({ type: 'enroll', candidate: f.second.endpoint, invitationId: recovery.invitationId,
    invitationSecret: recovery.secret, label: 'Recovery' });
  assert.ok((await f.security.policy.principal(f.second.endpoint.id)).permissions.includes('admin'));
  const state = JSON.parse(await readFile(join(f.directory, 'security', 'policy.json'), 'utf8'));
  assert.equal(state.account.checkpoint.head, f.head().head);
  assert.equal(state.provenance[f.first.endpoint.id], 'account');
  assert.equal(state.provenance[f.second.endpoint.id], 'local-recovery');
  assert.equal(state.invitations[0].provenance, 'local-recovery');
  assert.ok(!JSON.stringify(state).includes(invite.secret));
  // Joining the account upgrades provenance rather than retaining an independent local bypass.
  await f.append({ type: 'add_device', device: { endpoint: f.second.endpoint, signingPublicKey: f.secondSigning.publicKey,
    label: 'Second', approvedAt: new Date(f.time()).toISOString() } });
  await f.security.refreshAccount();
  await f.append({ type: 'revoke_device', endpointId: f.second.endpoint.id });
  await f.security.refreshAccount();
  await assert.rejects(f.security.policy.principal(f.second.endpoint.id), { code: 'account_device_revoked' });
});

test('adoption rejects changed heads, wrong bridge key, absent actor membership and local-cli root installation without changing old authority', async t => {
  const f = await fixture(t);
  const file = join(f.directory, 'security', 'policy.json'); const before = await readFile(file, 'utf8');
  await assert.rejects(f.security.adoptAccount(await f.actor(), { ...f.head(), revision: 0 }), { code: 'account_trust_conflict' });
  await assert.rejects(f.security.adoptAccount(await f.security.policy.principal(f.second.endpoint.id), f.head()), { code: 'account_device_revoked' });
  assert.equal(await readFile(file, 'utf8'), before);
  const cli = await generateEndpoint(ownerId, 'local-cli'); await f.security.policy.provisionLocalEndpoint(cli.endpoint);
  await assert.rejects(f.security.adoptAccount(await f.security.policy.principal(cli.endpoint.id), f.head()), { code: 'account_approval_required' });
  const otherBridge = await generateEndpoint(ownerId, 'bridge');
  const changed: AccountHistory = { genesis: f.history().genesis, transitions: [await signAccountTransition(
    await verifyAccountHistory({ genesis: f.history().genesis, transitions: [] }, null), f.first.endpoint.id, f.firstSigning,
    { type: 'add_bridge', bridge: { bridgeId: 'bridge', endpoint: otherBridge.endpoint, label: 'Wrong key', approvedAt: new Date(f.time()).toISOString() } }, f.time())] };
  const otherCheckpoint = await verifyAccountHistory(changed, null);
  const service = new BridgeSecurityService(f.bridge, 'bridge', f.directory, { ...f.options, readAccountHistory: async () => changed });
  try {
    await assert.rejects(service.adoptAccount(await f.actor(), { rootId: otherCheckpoint.rootId, revision: otherCheckpoint.revision, head: otherCheckpoint.head }), { code: 'wrong_context' });
    assert.equal(await f.security.policy.accountTrust(), null);
  } finally { await service.close(); }
});

test('an actor revoked while the authenticated history fetch waits cannot finish adoption', async t => {
  const f = await fixture(t);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; });
  const service = new BridgeSecurityService(f.bridge, 'bridge', f.directory, { ...f.options,
    readAccountHistory: async () => { entered(); await held; return f.history(); } });
  const pending = service.adoptAccount(await f.actor(), f.head());
  await reading;
  await f.security.policy.revoke(await f.actor(), f.first.endpoint.id);
  release();
  try { await assert.rejects(pending, { code: 'endpoint_revoked' }); assert.equal(await service.policy.accountTrust(), null); }
  finally { await service.close(); }
});

test('restarting a pinned bridge requires a new valid read and invalid/older histories never reset or renew trust', async t => {
  const f = await fixture(t);
  await f.security.adoptAccount(await f.actor(), f.head());
  const pinned = await f.security.policy.accountTrust();
  const restarted = new BridgeSecurityService(f.bridge, 'bridge', f.directory, f.options);
  try {
    await assert.rejects(restarted.policy.principal(f.first.endpoint.id), { code: 'account_offline_expired' });
    await restarted.refreshAccount();
    await restarted.policy.revalidate(await restarted.policy.principal(f.first.endpoint.id), 'control');
    const genesisOnly = { genesis: f.history().genesis, transitions: [] };
    await assert.rejects(restarted.policy.applyAccountRead(genesisOnly), { code: 'account_trust_rollback' });
    assert.deepEqual((await restarted.policy.accountTrust())!.checkpoint, pinned!.checkpoint);
  } finally { await restarted.close(); }
});

test('offline grace is running-process bounded by wall and monotonic clocks, including rollback after the last-read time', async t => {
  const f = await fixture(t);
  await f.security.adoptAccount(await f.actor(), f.head());
  f.failReads(new AccountReadUnavailable());
  f.move(20 * 3_600_000); await assert.rejects(f.security.refreshAccount(), AccountReadUnavailable);
  await f.security.policy.revalidate(await f.actor(), 'control');
  f.move(-19 * 3_600_000, 1);
  await assert.rejects(f.actor(), { code: 'account_offline_expired' });
  f.move(20 * 3_600_000, 1); f.failReads(null); await f.security.refreshAccount();
  await f.security.policy.revalidate(await f.actor(), 'read');
  f.move(0, day);
  await assert.rejects(f.actor(), { code: 'account_offline_expired' });
});

test('learned device revocation closes its peers and invalidates queued work while fixed MCP/local authority survives', async t => {
  const f = await fixture(t);
  await f.append({ type: 'add_device', device: { endpoint: f.second.endpoint, signingPublicKey: f.secondSigning.publicKey,
    label: 'Second', approvedAt: new Date(f.time()).toISOString() } });
  const cli = await generateEndpoint(ownerId, 'local-cli'); await f.security.policy.provisionLocalEndpoint(cli.endpoint);
  const mcp = await generateEndpoint(ownerId, 'mcp');
  await f.security.policy.approveMcp(await f.actor(), { requestId: 'consent', grantId: 'grant', endpoint: mcp.endpoint, permissions: ['read'],
    expiresAt: new Date(f.time() + 300000).toISOString(), activeExpiresAt: new Date(f.time() + 3 * day).toISOString() });
  await f.security.policy.activateMcp(await f.security.policy.principal(mcp.endpoint.id, true), 'grant');
  await f.security.adoptAccount(await f.actor(), f.head());
  const queued = await f.actor(); const closed: string[] = []; f.security.onRevoked(id => closed.push(id));
  await f.append({ type: 'revoke_device', endpointId: f.first.endpoint.id }, f.second, f.secondSigning);
  await f.security.refreshAccount();
  assert.ok(closed.includes(f.first.endpoint.id));
  await assert.rejects(f.security.revalidate(queued), { code: 'endpoint_revoked' });
  await assert.rejects(f.actor(), { code: 'account_device_revoked' });
  assert.ok(!(await f.security.policy.recipients()).some(item => item.endpoint.id === f.first.endpoint.id));
  await f.security.policy.revalidate(await f.security.policy.principal(mcp.endpoint.id), 'read');
  f.move(2 * day); f.failReads(new AccountReadUnavailable()); await assert.rejects(f.security.refreshAccount());
  await f.security.policy.revalidate(await f.security.policy.principal(cli.endpoint.id), 'admin');
  await f.security.policy.revalidate(await f.security.policy.principal(mcp.endpoint.id), 'read');
});

test('invalid received trust closes account access immediately; a valid same-root read recovers without repinning', async t => {
  const f = await fixture(t); await f.security.adoptAccount(await f.actor(), f.head());
  const pinned = await f.security.policy.accountTrust(); const closed: string[] = []; f.security.onRevoked(id => closed.push(id));
  f.failReads(new BridgeSecurityError('invalid_account_trust'));
  await assert.rejects(f.security.refreshAccount(), { code: 'invalid_account_trust' });
  await assert.rejects(f.actor(), { code: 'invalid_account_trust' });
  assert.ok(closed.includes(f.first.endpoint.id));
  assert.equal((await f.security.policy.accountTrust())!.lastServerReadAt, pinned!.lastServerReadAt);
  f.failReads(null); await f.security.refreshAccount();
  assert.equal((await f.actor()).endpoint.id, f.first.endpoint.id);
});

test('real encrypted adoption preserves the verified actor and returns its small correlated head response', async t => {
  const f = await fixture(t); const requestId = 'adopt-request'; const context = { transport: 'local-http' as const,
    channel: 'local-http:bridge', bridgeId: 'bridge', pairId: null };
  const packet = await seal(f.first, f.bridge.endpoint, { type: 'ftown_encrypted', version: 1, senderId: f.first.endpoint.id,
    recipientId: f.bridge.endpoint.id, ownerId, bridgeId: 'bridge', channel: context.channel, purpose: 'application',
    messageId: requestId, createdAt: f.time(), expiresAt: f.time() + 120000, receiverEpoch: f.security.receiverEpoch },
  new TextEncoder().encode(JSON.stringify({ type: 'application', route: { kind: 'command', command: 'security_account_adopt', requestId, sessionId: null },
    data: { type: 'security_account_adopt', requestId, payload: { bridgeId: 'bridge', head: f.head() } }, mcp: null })));
  const reply = await executeSecurePacket(f.security, packet, context, async verified => {
    assert.equal(verified.principal.endpoint.id, f.first.endpoint.id);
    return { head: await f.security.adoptAccount(verified.principal, f.head()) } as unknown as import('../protocol.js').ApplicationJson;
  });
  const opened = JSON.parse(new TextDecoder().decode(await open(f.first, f.bridge.endpoint, reply,
    { ownerId, bridgeId: 'bridge', channel: context.channel, recipientId: f.first.endpoint.id, purpose: 'application' })));
  assert.equal(opened.route.requestId, requestId); assert.deepEqual(opened.data.head, f.head());
});
