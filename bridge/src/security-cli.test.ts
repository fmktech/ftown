import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invitationLink, runSecurity } from './security-cli.js';
import type { BridgeInvitation } from './security/protocol.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { waitForPendingBridgeDecision, writePendingBridgeStatus } from './security/bridge/pending-approval.js';

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
  for (const command of ['invite', 'devices', 'revoke', 'proxy', 'pair-status', 'pair-confirm', 'pair-reject']) assert.ok(output.includes(command));
  assert.ok(!output.includes('#invite='));
});
test('explicit CLI status/confirm/reject use the selected instance with no listener or pointer', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-pair-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const value = Buffer.alloc(32).toString('base64url');
  const state = { version: 1 as const, requestId: value, processNonce: value, expiresAt: new Date(Date.now() + 60000).toISOString(),
    phase: 'comparing' as const, offerHash: value, comparisonCode: '1234-5678-ABCD' };
  await writePendingBridgeStatus(dir, state);
  const previous = process.stdout.write; let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    assert.equal(await runSecurity(['--data-dir', dir, 'pair-status']), 0); assert.deepEqual(JSON.parse(output.trim()), state);
    assert.equal(await runSecurity(['--data-dir', dir, 'pair-confirm', state.comparisonCode]), 0);
    assert.equal((await waitForPendingBridgeDecision(dir, state, AbortSignal.timeout(1000))).decision, 'confirm');
    assert.equal(await runSecurity(['--data-dir', dir, 'pair-reject']), 0);
    assert.equal((await waitForPendingBridgeDecision(dir, state, AbortSignal.timeout(1000))).decision, 'reject');
  } finally { process.stdout.write = previous; }
});
