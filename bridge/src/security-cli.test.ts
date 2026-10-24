import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invitationLink, runSecurity } from './security-cli.js';
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
  assert.ok(!output.includes('#invite='));
});
