import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EndpointKind, EndpointPublic } from '../protocol.js';
import { z } from 'zod';
import { legacyDateTimeSchema } from '../../zod-compat.js';
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
  await assert.rejects(f.store.consumeInvitation({ ...message, candidate: endpoint('local-cli') }), { code: 'invitation_invalid' });
  f.setNow(f.now + 300_001);
  await assert.rejects(f.store.consumeInvitation(message), { code: 'invitation_expired' });
  assert.equal((await f.store.list(await f.store.principal(f.browser.id))).length, 1);
});

test('revocation invalidates outstanding principals and removes the endpoint from recipients', async t => {
  const f = await fixture(t);
  const invitation = await f.store.createInvitation(await f.store.principal(f.browser.id), { label: 'Second' });
  const second = endpoint('browser');
  await f.store.consumeInvitation({ type: 'enroll', candidate: second, invitationId: invitation.invitationId, invitationSecret: invitation.secret, label: 'Second' });
  const principal = await f.store.principal(second.id);
  await f.store.revalidate(principal, 'read');
  await f.store.revoke(await f.store.principal(f.browser.id), second.id);
  await assert.rejects(f.store.revalidate(principal), { code: 'endpoint_revoked' });
  await assert.rejects(f.store.principal(second.id), { code: 'approval_required' });
  assert.ok(!(await f.store.recipients()).some(device => device.endpoint.id === second.id));
});

test('legacy policy.json with mcp array, mcp devices and mcp provenance loads and migrates clean', async t => {
  const f = await fixture(t);
  await f.store.close();
  const file = join(f.directory, 'security', 'policy.json');
  const legacy = JSON.parse(await readFile(file, 'utf8')) as { devices: Array<{ endpoint: { id: string } }>; mcp?: unknown[]; provenance: Record<string, string> };
  const mcpEndpoint = { ...endpoint('browser'), kind: 'mcp' };
  const mcpDevice = { endpoint: mcpEndpoint, label: 'MCP client', permissions: ['read'], approvedAt: new Date(f.now).toISOString(),
    grantId: 'legacy-grant', expiresAt: new Date(f.now + 86_400_000).toISOString() };
  const pendingApproved = { ...mcpDevice, endpoint: { ...mcpEndpoint } };
  legacy.mcp = [{ approved: pendingApproved, approvalId: '3f1c2a52-6d0e-4b8a-9c77-0a1b2c3d4e5f', requestId: 'consent',
    expiresAt: new Date(f.now + 300_000).toISOString(), activeExpiresAt: mcpDevice.expiresAt, active: true }];
  legacy.devices.push(mcpDevice as never);
  legacy.provenance[mcpEndpoint.id] = 'mcp';
  legacy.provenance[f.browser.id] = 'mcp';
  await writeFile(file, JSON.stringify(legacy));
  const restarted = new BridgePolicyStore(f.directory, 'bridge', f.bridge, f.options);
  t.after(() => restarted.close());
  const actor = await restarted.principal(f.browser.id);
  const devices = await restarted.list(actor);
  assert.deepEqual(devices.map(device => device.endpoint.id), [f.browser.id]);
  await assert.rejects(restarted.principal(mcpEndpoint.id), { code: 'approval_required' });
  await restarted.createInvitation(actor, { label: 'Forces a write' });
  const migrated = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> & { devices: Array<{ endpoint: { kind: string } }>; provenance: Record<string, string> };
  assert.deepEqual(migrated.mcp, []);
  assert.ok(migrated.devices.every(device => device.endpoint.kind !== 'mcp'));
  assert.ok(!Object.keys(migrated.provenance).includes(mcpEndpoint.id));
  assert.ok(!Object.values(migrated.provenance).includes('mcp'));
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

// Frozen copy of the previous (origin/main, MCP-era) release's policy schemas; never update it to follow the current ones.
const boundedId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const oldEndpointSchema = z.object({
  version: z.literal(1), id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  ownerId: z.string().min(1).max(200), kind: z.enum(['bridge', 'browser', 'mcp', 'local-cli']),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
}).strict().superRefine((endpoint, context) => {
  const raw = Buffer.from(endpoint.publicKey, 'base64url');
  if (raw.length !== 65 || raw[0] !== 4 || raw.toString('base64url') !== endpoint.publicKey
    || createHash('sha256').update(raw).digest('base64url') !== endpoint.id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid endpoint fingerprint' });
  }
});
const permissionSchema = z.enum(['read', 'control', 'admin']);
const approvedSchema = z.object({
  endpoint: oldEndpointSchema, label: z.string().max(100), permissions: z.array(permissionSchema).max(3),
  approvedAt: legacyDateTimeSchema, grantId: boundedId.nullable(), expiresAt: legacyDateTimeSchema.nullable(),
}).strict();
const oldId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const oldTimestamp = z.number().int().nonnegative().finite();
const oldAccountDevice = z.object({ endpoint: oldEndpointSchema, signingPublicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  label: z.string().max(200), approvedAt: legacyDateTimeSchema }).strict();
const oldAccountBridge = z.object({ bridgeId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), endpoint: oldEndpointSchema,
  label: z.string().max(200), approvedAt: legacyDateTimeSchema }).strict();
const oldStoredAccountSchema = z.object({
  // The original validates history with parseAccountHistory; account-crypto is not a policy schema, so it is left opaque here.
  history: z.unknown(),
  checkpoint: z.object({ version: z.literal(1), ownerId: z.string().guid(), rootId: oldId, head: oldId,
    revision: z.number().int().min(0).max(1024),
    devices: z.array(oldAccountDevice).max(128), bridges: z.array(oldAccountBridge).max(128),
    revokedDeviceIds: z.array(oldId).max(1024),
    revokedBridgeIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)).max(1024),
  }).strict(),
  lastServerReadAt: oldTimestamp, lastObservedAt: oldTimestamp,
}).strict();
const legacyPendingSchema = z.object({ approved: approvedSchema, approvalId: z.string().guid(), requestId: boundedId,
  expiresAt: legacyDateTimeSchema, activeExpiresAt: legacyDateTimeSchema, active: z.boolean() }).strict();
const legacyInvitationSchema = z.object({ id: z.string().guid(), secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().max(100), permissions: z.array(permissionSchema).max(3), expiresAt: legacyDateTimeSchema,
  consumedBy: z.string().nullable(), provenance: z.enum(['legacy', 'local-recovery']).default('legacy') }).strict();
const originMainPolicySchema = z.object({ version: z.literal(1), ownerId: z.string(), bridgeId: z.string(), bridgeEndpointId: z.string(),
  generation: z.number().int().nonnegative(), devices: z.array(approvedSchema).max(1000),
  invitations: z.array(legacyInvitationSchema).max(256), mcp: z.array(legacyPendingSchema).max(1000),
  account: oldStoredAccountSchema.nullable().default(null),
  provenance: z.record(z.string(), z.enum(['legacy', 'local-recovery', 'account', 'local-cli', 'mcp'])).default({}),
}).strict().superRefine((state, context) => {
  if (new Set(state.devices.map(device => device.endpoint.id)).size !== state.devices.length
    || new Set(state.mcp.map(item => item.approved.grantId)).size !== state.mcp.length
    || state.devices.some(device => device.endpoint.ownerId !== state.ownerId
      || (device.endpoint.kind === 'mcp') !== (device.grantId !== null)
      || new Set(device.permissions).size !== device.permissions.length)
    || state.mcp.some(item => !state.devices.some(device => JSON.stringify(device) === JSON.stringify(item.approved)))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid policy relationship' });
  }
});

test('policy.json written by the new code still parses under the origin/main schema (downgrade safety)', async t => {
  const f = await fixture(t);
  await f.store.close();
  const parsed = originMainPolicySchema.parse(JSON.parse(await readFile(join(f.directory, 'security', 'policy.json'), 'utf8')));
  assert.deepEqual(parsed.mcp, []);
  assert.equal(parsed.devices.length, 1);
});
