import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCommand, classifyHttp, classifyTerminal } from './permissions.js';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgePolicyStore, LOCAL_RECOVERY_AUTHORITY } from './policy.js';
import type { EndpointKind, EndpointPublic } from '../protocol.js';

test('reads cannot consume inboxes or register native wake targets, while POST history search remains read-only', () => {
  assert.equal(classifyHttp('GET', '/api/sessions/session/inbox').permission, 'control');
  assert.equal(classifyHttp('GET', '/api/sessions/session/inbox?peek=1').permission, 'read');
  assert.equal(classifyHttp('GET', '/api/sessions/session/inbox?peek=1&peek=0').permission, 'control');
  assert.equal(classifyHttp('GET', '/api/sessions/session/inbox?peek=1&adapter=opencode&nativeSessionId=agent').permission, 'control');
  assert.equal(classifyHttp('POST', '/api/sessions/session/grep').permission, 'read');
  assert.equal(classifyCommand('mcp_request', { request: { method: 'GET', path: '/api/sessions/session/inbox' } }).permission, 'control');
});

test('real read-only MCP principal cannot authorize the control update operation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ftown-update-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ownerId = '7bac2a7f-c58e-4845-856f-8283fb07ad96';
  const endpoint = (kind: EndpointKind): EndpointPublic => {
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(key.x!, 'base64url'), Buffer.from(key.y!, 'base64url')]);
    return { version: 1, ownerId, kind, id: createHash('sha256').update(raw).digest('base64url'), publicKey: raw.toString('base64url') };
  };
  const policy = new BridgePolicyStore(directory, 'bridge', endpoint('bridge'));
  t.after(() => policy.close());
  const browser = endpoint('browser'); const invitation = await policy.createInvitation(LOCAL_RECOVERY_AUTHORITY, { label: 'Browser' });
  await policy.consumeInvitation({ type: 'enroll', candidate: browser, invitationId: invitation.invitationId, invitationSecret: invitation.secret, label: 'Browser' });
  const mcp = endpoint('mcp'); const now = Date.now();
  await policy.approveMcp(await policy.principal(browser.id), { requestId: 'request', grantId: 'grant', endpoint: mcp, permissions: ['read'], expiresAt: new Date(now + 30000).toISOString(), activeExpiresAt: new Date(now + 60000).toISOString() });
  await policy.activateMcp(await policy.principal(mcp.id, true), 'grant');
  const principal = await policy.principal(mcp.id);
  await policy.revalidate(principal, classifyCommand('get_bridge_update').permission);
  await assert.rejects(policy.revalidate(principal, classifyCommand('update_bridge').permission), { code: 'permission_denied' });
});

test('actual operations determine permission and unknown methods/routes/frames deny by default', () => {
  assert.equal(classifyCommand('get_bridge_update').permission, 'read');
  assert.equal(classifyCommand('get_pull_request_statuses').permission, 'read');
  assert.equal(classifyCommand('update_bridge').permission, 'control');
  assert.equal(classifyCommand('get_history', { sessionId: 'session' }).permission, 'read');
  assert.equal(classifyCommand('bridge_exec', { mutating: false }).permission, 'control');
  assert.equal(classifyCommand('security_activity').permission, 'admin');
  assert.equal(classifyTerminal('attach').permission, 'read');
  assert.equal(classifyTerminal('input').permission, 'control');
  assert.equal(classifyTerminal('resize').permission, 'control');
  for (const [method, path] of [
    ['GET', '//evil/api/sessions'], ['GET', '/api/sessions/../archive'], ['GET', '/api/sessions/%73ession'],
    ['POST', '/api/sessions/session/usage'], ['PUT', '/api/sessions/session'], ['GET', '/api/browser/devices'],
    ['DELETE', '/api/sessions/session/attention'],
  ]) assert.throws(() => classifyHttp(method, path), { code: 'permission_denied' });
  for (const command of ['unknown', 'security_activate_mcp', 'security_update_policy']) assert.throws(() => classifyCommand(command), { code: 'permission_denied' });
  for (const frame of ['screen', 'output', 'arbitrary']) assert.throws(() => classifyTerminal(frame), { code: 'permission_denied' });
});
