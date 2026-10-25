import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { matchesPendingBridgeDecision, readPendingBridgeStatus, selectBridgePairingMode,
  submitPendingBridgeDecision, waitForPendingBridgeDecision, writePendingBridgeStatus } from './pending-approval.js';
import type { PendingBridgeDecision, PendingBridgeStatus } from '../pending-approval-protocol.js';

const hash = (n: number) => Buffer.alloc(32, n).toString('base64url');
const status = (): Extract<PendingBridgeStatus, { phase: 'comparing' | 'confirming' }> => ({ version: 1, requestId: hash(1),
  processNonce: hash(2), expiresAt: new Date(Date.now() + 300000).toISOString(), phase: 'comparing', offerHash: hash(3), comparisonCode: '1234-ABCD-5678' });

test('local confirmation is private, exact, and independent of the API pointer; CLI never changes status', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-compare-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const state = status(); await writePendingBridgeStatus(dir, state);
  const path = join(dir, 'security', 'pending-approval-status.json'); const before = await readFile(path, 'utf8');
  await assert.rejects(submitPendingBridgeDecision(dir, 'confirm', '1234-ABCD-9999'), { code: 'account_enrollment_invalid' });
  await submitPendingBridgeDecision(dir, 'confirm', state.comparisonCode);
  const decision = await waitForPendingBridgeDecision(dir, state, AbortSignal.timeout(1000));
  assert.equal(decision.decision, 'confirm'); assert.ok(matchesPendingBridgeDecision(state, decision));
  assert.equal(await readFile(path, 'utf8'), before); assert.deepEqual(await readPendingBridgeStatus(dir), state);
  for (const name of ['pending-approval-status.json', 'pending-approval-confirmation.json']) {
    assert.equal((await stat(join(dir, 'security', name))).mode & 0o777, 0o600);
  }
});
test('restarts, changed offer, request, expiry, comparison, and terminal state cannot consume a stale confirmation', async () => {
  const state = status();
  const decision: PendingBridgeDecision = { version: 1, requestId: state.requestId, processNonce: state.processNonce,
    expiresAt: state.expiresAt, decision: 'confirm', offerHash: state.offerHash, comparisonCode: state.comparisonCode };
  for (const changed of [{ ...decision, requestId: hash(4) }, { ...decision, processNonce: hash(4) },
    { ...decision, offerHash: hash(4) }, { ...decision, expiresAt: new Date().toISOString() }, { ...decision, comparisonCode: 'FFFF-FFFF-FFFF' }]) {
    assert.equal(matchesPendingBridgeDecision(state, changed), false);
  }
  assert.equal(matchesPendingBridgeDecision(state, decision, Date.parse(state.expiresAt)), false);
  assert.equal(matchesPendingBridgeDecision({ ...state, phase: 'approved', comparisonCode: null }, decision), false);
});
test('waiting attempt can be rejected before an offer, and old decisions do not authorize the next process', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-reject-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const state: PendingBridgeStatus = { ...status(), phase: 'waiting', offerHash: null, comparisonCode: null };
  await writePendingBridgeStatus(dir, state); await submitPendingBridgeDecision(dir, 'reject');
  const rejected = await waitForPendingBridgeDecision(dir, state, AbortSignal.timeout(1000)); assert.equal(rejected.decision, 'reject');
  const restarted = { ...state, processNonce: hash(9) }; await writePendingBridgeStatus(dir, restarted);
  await assert.rejects(waitForPendingBridgeDecision(dir, restarted, AbortSignal.timeout(20)), { name: 'AbortError' });
  await writePendingBridgeStatus(dir, { ...state, phase: 'expired' });
  await assert.rejects(submitPendingBridgeDecision(dir, 'reject'), { code: 'account_enrollment_expired' });
});
test('startup mode selection requires deliberate account or bootstrap and normalizes only routing', async () => {
  let prompts = 0; const prompt = async () => { prompts++; return '  ALICE@Example.test  '; };
  assert.deepEqual(await selectBridgePairingMode({ account: ' ALICE@Example.test ', interactive: false }, prompt), { method: 'pending-v1', accountHint: 'alice@example.test' });
  assert.deepEqual(await selectBridgePairingMode({ interactive: false }, prompt), { method: 'bootstrap' });
  assert.deepEqual(await selectBridgePairingMode({ bootstrap: true, interactive: true }, prompt), { method: 'bootstrap' });
  assert.equal(prompts, 0);
  assert.deepEqual(await selectBridgePairingMode({ interactive: true }, prompt), { method: 'pending-v1', accountHint: 'alice@example.test' });
  assert.deepEqual(await selectBridgePairingMode({ interactive: true }, async () => ''), { method: 'bootstrap' });
  await assert.rejects(selectBridgePairingMode({ account: 'bad email', interactive: false }, prompt), { code: 'account_enrollment_invalid' });
  await assert.rejects(selectBridgePairingMode({ account: 'alice@example.test', bootstrap: true, interactive: false }, prompt), /cannot be combined/);
  await assert.rejects(selectBridgePairingMode({ interactive: false, previousPending: true }, prompt), /--bootstrap explicitly/);
  assert.deepEqual(await selectBridgePairingMode({ interactive: false, previousPending: true, bootstrap: true }, prompt), { method: 'bootstrap' });
});
