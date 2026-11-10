import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNT_MANAGED_INVITE_MESSAGE, invitationLink, runSecurity, securityRefusalMessage } from './security-cli.js';
import { SecurityCommandError, securityCommand, securityCommandError } from './cli-client.js';
import type { BridgeInvitation } from './security/protocol.js';

test('invitation URLs carry the full invitation only in the dedicated connect fragment', () => {
  const invitation = { version: 1, secret: 'SECRET', ownerId: 'owner', bridgeId: 'bridge' } as BridgeInvitation;
  const url = new URL(invitationLink(invitation, 'https://example.test'));
  assert.equal(url.pathname, '/connect'); assert.equal(url.search, '');
  assert.equal(new URL(url.origin + url.pathname).href.includes('SECRET'), false);
  assert.deepEqual(JSON.parse(new URLSearchParams(url.hash.slice(1)).get('invite')!), invitation);
});

test('security help lists recovery commands without accessing a bridge or printing an invitation', async () => {
  const previous = process.stdout.write; let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
  try { assert.equal(await runSecurity(['--help']), 0); }
  finally { process.stdout.write = previous; }
  for (const command of ['invite', 'devices', 'revoke', 'proxy']) assert.ok(output.includes(command));
  // Account computers pair by a passkey link printed by `ftown start`; the v1 approval commands are gone.
  for (const command of ['pair-status', 'pair-confirm', 'pair-reject', 'pair-link']) assert.ok(!output.includes(command), command);
  assert.ok(!output.includes('#invite='));
});

test('an account bridge refuses `invite` with the account_managed reason, without contacting the bridge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-security-cli-'));
  const previous = console.error; const errors: string[] = [];
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    writeFileSync(join(dir, 'bridge.json'), JSON.stringify({ port: 1, token: 'local-token', bridgeId: 'b', ownerId: 'A'.repeat(43) }));
    assert.equal(await runSecurity(['--data-dir', dir, 'invite']), 1);
    assert.deepEqual(errors, [ACCOUNT_MANAGED_INVITE_MESSAGE]);
    assert.match(ACCOUNT_MANAGED_INVITE_MESSAGE, /account_managed/);
  } finally { console.error = previous; rmSync(dir, { recursive: true, force: true }); }
});

test("security commands surface the bridge's typed refusal instead of a generic failure", () => {
  const managed = securityCommandError({ requestId: 'r', success: false, error: 'Bridge security: account_managed', data: { code: 'account_managed' } });
  assert.ok(managed instanceof SecurityCommandError);
  assert.equal(managed.code, 'account_managed');
  assert.equal(managed.message, 'Bridge security: account_managed');
  assert.match(securityRefusalMessage(managed), /account_managed/);

  const other = securityCommandError({ success: false, error: 'Bridge security: permission_denied\u0007', data: { code: 'permission_denied' } });
  assert.equal(other.message, 'Bridge security: permission_denied');
  assert.equal(securityRefusalMessage(other), 'The bridge refused this security command: Bridge security: permission_denied');

  const coded = securityCommandError({ success: false, data: { code: 'approval_required' } });
  assert.equal(coded.message, 'Encrypted security command failed (approval_required)');
  const untyped = securityCommandError({ success: false, error: 'x'.repeat(400), data: { code: 'Not A Code!' } });
  assert.equal(untyped.code, null);
  assert.equal(untyped.message.length, 300);
});

test('securityCommand throws the typed refusal for every security command', async () => {
  for (const type of ['security_invite', 'security_devices', 'security_revoke'] as const) {
    const send = async () => ({ response: { requestId: 'r', success: false, error: 'Bridge security: account_managed', data: { code: 'account_managed' } } });
    const error = await securityCommand({ port: 1, token: 't', bridgeId: 'b' }, type, {}, send as never).then(() => assert.fail('should reject'), (e: unknown) => e);
    assert.ok(error instanceof SecurityCommandError, type);
    assert.equal(error.code, 'account_managed');
  }
  const ok = async () => ({ response: { requestId: 'r', success: true, data: { devices: [] } } });
  assert.deepEqual(await securityCommand({ port: 1, token: 't', bridgeId: 'b' }, 'security_devices', {}, ok as never), { devices: [] });
});
