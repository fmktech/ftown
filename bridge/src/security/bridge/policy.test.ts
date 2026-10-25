import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EndpointKind, EndpointPublic, McpApproval } from '../protocol.js';
import { BridgePolicyStore, LOCAL_RECOVERY_AUTHORITY } from './policy.js';

const ownerId = '7bac2a7f-c58e-4845-856f-8283fb07ad96';
function endpoint(kind: EndpointKind): EndpointPublic {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  return { version: 1, ownerId, kind, id: createHash('sha256').update(raw).digest('base64url'), publicKey: raw.toString('base64url') };
}
async function fixture(t: { after(fn: () => Promise<void>): void }, now = Date.now()) {
  const directory = await mkdtemp(join(tmpdir(), 'ftown-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bridge = endpoint('bridge');
  let clock = now;
  const options = { now: () => clock };
  const store = new BridgePolicyStore(directory, 'bridge', bridge, options);
  const invitation = await store.createInvitation(LOCAL_RECOVERY_AUTHORITY, { label: 'My browser' });
  const browser = endpoint('browser');
  await store.consumeInvitation({ type: 'enroll', candidate: browser, invitationId: invitation.invitationId, invitationSecret: invitation.secret, label: 'Browser' });
  return { directory, bridge, store, browser, options, setNow(value: number) { clock = value; }, now };
}

test('one-use enrollment survives restart, atomically picks one concurrent candidate, and never persists its secret', async t => {
  const f = await fixture(t);
  const actor = await f.store.principal(f.browser.id);
  const invitation = await f.store.createInvitation(actor, { label: 'Next device' });
  const candidateA = endpoint('browser'); const candidateB = endpoint('browser');
  const attempts = await Promise.allSettled([candidateA, candidateB].map(candidate => f.store.consumeInvitation({ type: 'enroll',
    candidate, invitationId: invitation.invitationId, invitationSecret: invitation.secret, label: 'Next\nDevice' })));
  assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(attempt => attempt.status === 'rejected').length, 1);
  const file = join(f.directory, 'security', 'policy.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(file, 'utf8')).includes(invitation.secret));
  await f.store.close();
  const restarted = new BridgePolicyStore(f.directory, 'bridge', f.bridge, f.options);
  const devices = await restarted.list(await restarted.principal(f.browser.id));
  assert.equal(devices.length, 2);
  assert.equal(devices[1].label, 'NextDevice');
  await assert.rejects(restarted.consumeInvitation({ type: 'enroll', candidate: endpoint('browser'), invitationId: invitation.invitationId,
    invitationSecret: invitation.secret, label: 'Replay' }), { code: 'invitation_consumed' });
});

test('wrong secret/account/kind and expired invitations cannot authorize an endpoint', async t => {
  const f = await fixture(t);
  const invitation = await f.store.createInvitation(await f.store.principal(f.browser.id), { label: 'Next' });
  const message = { type: 'enroll' as const, candidate: endpoint('browser'), invitationId: invitation.invitationId, invitationSecret: invitation.secret, label: 'Next' };
  await assert.rejects(f.store.consumeInvitation({ ...message, invitationSecret: 'A'.repeat(43) }), { code: 'invitation_invalid' });
  await assert.rejects(f.store.consumeInvitation({ ...message, candidate: { ...message.candidate, ownerId: 'another-account' } }), { code: 'invitation_invalid' });
  await assert.rejects(f.store.consumeInvitation({ ...message, candidate: endpoint('mcp') }), { code: 'invitation_invalid' });
  f.setNow(f.now + 300_001);
  await assert.rejects(f.store.consumeInvitation(message), { code: 'invitation_expired' });
  assert.equal((await f.store.list(await f.store.principal(f.browser.id))).length, 1);
});

test('pending MCP can obtain identity only for hello/activation, respects fixed scopes and lifetime, and revocation invalidates principals', async t => {
  const f = await fixture(t);
  const actor = await f.store.principal(f.browser.id);
  const mcp = endpoint('mcp');
  const approval: McpApproval = { requestId: 'consent', grantId: 'grant', endpoint: mcp, permissions: ['read'],
    expiresAt: new Date(f.now + 300_000).toISOString(), activeExpiresAt: new Date(f.now + 86_400_000).toISOString() };
  const receipt = await f.store.approveMcp(actor, approval);
  assert.deepEqual(await f.store.approveMcp(await f.store.principal(f.browser.id), approval), receipt);
  await assert.rejects(f.store.principal(mcp.id), { code: 'approval_required' });
  const pending = await f.store.principal(mcp.id, true);
  assert.deepEqual(pending.permissions, []);
  await assert.rejects(f.store.revalidate(pending, 'read'), { code: 'approval_required' });
  await assert.rejects(f.store.activateMcp(pending, 'different-grant'), { code: 'permission_denied' });
  const activated = await f.store.activateMcp(pending, 'grant');
  assert.equal(activated.expiresAt, approval.activeExpiresAt);
  f.setNow(f.now + 600_000);
  assert.deepEqual(await f.store.activateMcp(await f.store.principal(mcp.id), 'grant'), activated);
  const principal = await f.store.principal(mcp.id);
  await f.store.revalidate(principal, 'read');
  await assert.rejects(f.store.revalidate(principal, 'control'), { code: 'permission_denied' });
  await assert.rejects(f.store.createInvitation(principal, { label: 'Escalation' }), { code: 'permission_denied' });
  await f.store.revoke(await f.store.principal(f.browser.id), mcp.id);
  await assert.rejects(f.store.revalidate(principal), { code: 'endpoint_revoked' });
  assert.ok(!(await f.store.recipients()).some(device => device.endpoint.id === mcp.id));
});

test('corrupt or wrong-bound storage fails closed without replacing policy', async t => {
  const f = await fixture(t);
  const file = join(f.directory, 'security', 'policy.json');
  const saved = await readFile(file, 'utf8');
  const wrongBridge = new BridgePolicyStore(f.directory, 'other-bridge', f.bridge);
  await assert.rejects(wrongBridge.principal(f.browser.id), { code: 'wrong_context' });
  assert.equal(await readFile(file, 'utf8'), saved);
  await writeFile(file, '{broken');
  await assert.rejects(f.store.createInvitation(LOCAL_RECOVERY_AUTHORITY, { label: 'Recovery' }), { code: 'storage_unavailable' });
  assert.equal(await readFile(file, 'utf8'), '{broken');
});


test('queued control principals cannot survive revoke/reapprove of the same MCP key and grant with reduced permissions', async t => {
  const f = await fixture(t);
  const mcp = endpoint('mcp');
  const approval: McpApproval = { requestId: 'consent', grantId: 'grant', endpoint: mcp, permissions: ['read', 'control'],
    expiresAt: new Date(f.now + 300_000).toISOString(), activeExpiresAt: new Date(f.now + 86_400_000).toISOString() };
  await f.store.approveMcp(await f.store.principal(f.browser.id), approval);
  await f.store.activateMcp(await f.store.principal(mcp.id, true), 'grant');
  const queued = await f.store.principal(mcp.id);
  await f.store.revoke(await f.store.principal(f.browser.id), mcp.id);
  await f.store.approveMcp(await f.store.principal(f.browser.id), { ...approval, permissions: ['read'] });
  await f.store.activateMcp(await f.store.principal(mcp.id, true), 'grant');
  await assert.rejects(f.store.revalidate(queued), { code: 'endpoint_revoked' });
  await assert.rejects(f.store.revalidate(await f.store.principal(mcp.id), 'control'), { code: 'permission_denied' });
});

test('same-candidate lost acknowledgement enrollment is idempotent and does not restore revoked authority', async t => {
  const f = await fixture(t);
  const invitation = await f.store.createInvitation(await f.store.principal(f.browser.id), { label: 'Second' });
  const message = { type: 'enroll' as const, candidate: endpoint('browser'), invitationId: invitation.invitationId,
    invitationSecret: invitation.secret, label: 'Second' };
  const first = await f.store.consumeInvitation(message);
  assert.deepEqual(await f.store.consumeInvitation(message), first);
  await f.store.revoke(await f.store.principal(f.browser.id), first.endpoint.id);
  await assert.rejects(f.store.consumeInvitation(message), { code: 'approval_required' });
});
