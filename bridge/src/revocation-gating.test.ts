import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { UnauthorizedError } from 'centrifuge';
import { BridgeRevokedError } from './bridge-auth.js';
import { generateEndpoint } from './security/crypto.js';
import { createAccountGenesis, generateAccountSigningIdentity, signAccountTransition, verifyAccountHistory } from './security/account-crypto.js';
import type { AccountCheckpoint, AccountHistory, AccountOperation } from './security/account-protocol.js';
import {
  bridgeMode, canReexecAfterRevocation, handlesRevocation, restartForPinnedRevocation, restartForRefreshError, updateOperationActive,
  type BridgeMode,
} from './revocation-gating.js';

const OWNER_ID = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
const MODES: BridgeMode[] = ['account', 'solo', 'local'];

/** genesis(0) -> add_bridge A(1) -> revoke_bridge A(2), each checkpoint verified like the bridge would. */
async function revokedAccount(label: string) {
  const now = Date.now();
  const device = await generateEndpoint(OWNER_ID, 'browser');
  const signing = await generateAccountSigningIdentity();
  let history: AccountHistory = { genesis: await createAccountGenesis(OWNER_ID, device.endpoint, signing, label, now), transitions: [] };
  const states: AccountCheckpoint[] = [await verifyAccountHistory(history, null, now)];
  const ops: AccountOperation[] = [
    { type: 'add_bridge', bridge: { bridgeId: 'A', endpoint: (await generateEndpoint(OWNER_ID, 'bridge')).endpoint, label: 'A', approvedAt: new Date(now).toISOString() } },
    { type: 'revoke_bridge', bridgeId: 'A' },
  ];
  for (const op of ops) {
    const at = now + history.transitions.length + 1;
    const record = await signAccountTransition(states[states.length - 1], device.endpoint.id, signing, op, at);
    history = { ...history, transitions: [...history.transitions, record] };
    states.push(await verifyAccountHistory(history, states[states.length - 1], at));
  }
  return { evidence: history, pinBeforeRevoke: states[1], pinAfterRevoke: states[2] };
}

describe('bridgeMode and handlesRevocation', () => {
  it('maps the start flags to one mode', () => {
    assert.equal(bridgeMode({}), 'account');
    assert.equal(bridgeMode({ solo: true }), 'solo');
    assert.equal(bridgeMode({ local: true }), 'local');
  });

  it('handles revocation only for account bridges', () => {
    assert.deepEqual(MODES.filter(handlesRevocation), ['account']);
  });
});

describe('restartForPinnedRevocation', () => {
  it('restarts an account bridge whose pin already revokes it', async () => {
    const f = await revokedAccount('pinned');
    assert.equal(restartForPinnedRevocation('account', f.pinAfterRevoke, 'A'), true);
  });

  it('never restarts solo or local bridges, a null pin, an unrevoked pin or another bridgeId', async () => {
    const f = await revokedAccount('pinned-negative');
    assert.equal(restartForPinnedRevocation('solo', f.pinAfterRevoke, 'A'), false);
    assert.equal(restartForPinnedRevocation('local', f.pinAfterRevoke, 'A'), false);
    assert.equal(restartForPinnedRevocation('account', null, 'A'), false);
    assert.equal(restartForPinnedRevocation('account', f.pinBeforeRevoke, 'A'), false);
    assert.equal(restartForPinnedRevocation('account', f.pinAfterRevoke, 'B'), false);
  });
});

describe('restartForRefreshError', () => {
  it('restarts on a BridgeRevokedError whose evidence verifies against the pin', async () => {
    const f = await revokedAccount('confirmed');
    const error = new BridgeRevokedError(f.evidence);
    assert.equal(await restartForRefreshError({ mode: 'account', error, pinned: f.pinBeforeRevoke, bridgeId: 'A' }), true);
  });

  it('keeps the pairing fallback for a bare UnauthorizedError or any other error', async () => {
    const f = await revokedAccount('bare');
    for (const error of [new UnauthorizedError('Bridge refresh failed (401)'), new Error('network down'), undefined]) {
      assert.equal(await restartForRefreshError({ mode: 'account', error, pinned: f.pinBeforeRevoke, bridgeId: 'A' }), false);
    }
  });

  it('rejects evidence that does not verify against this pin', async () => {
    const f = await revokedAccount('evidence');
    const other = await revokedAccount('forked account');
    const forged = new BridgeRevokedError(other.evidence);
    assert.equal(await restartForRefreshError({ mode: 'account', error: forged, pinned: f.pinBeforeRevoke, bridgeId: 'A' }), false);
    const garbage = new BridgeRevokedError({ genesis: f.evidence.genesis, transitions: [{ ...f.evidence.transitions[0], signature: 'AAAA' }] } as AccountHistory);
    assert.equal(await restartForRefreshError({ mode: 'account', error: garbage, pinned: f.pinBeforeRevoke, bridgeId: 'A' }), false);
  });

  it('rejects valid evidence that names another bridge', async () => {
    const f = await revokedAccount('other bridge');
    assert.equal(await restartForRefreshError({ mode: 'account', error: new BridgeRevokedError(f.evidence), pinned: f.pinBeforeRevoke, bridgeId: 'B' }), false);
  });

  it('never restarts without a pin', async () => {
    const f = await revokedAccount('no pin');
    assert.equal(await restartForRefreshError({ mode: 'account', error: new BridgeRevokedError(f.evidence), pinned: null, bridgeId: 'A' }), false);
  });

  it('never restarts solo or local bridges, even with confirmed evidence', async () => {
    const f = await revokedAccount('modes');
    for (const mode of ['solo', 'local'] as const) {
      assert.equal(await restartForRefreshError({ mode, error: new BridgeRevokedError(f.evidence), pinned: f.pinBeforeRevoke, bridgeId: 'A' }), false);
    }
  });
});

describe('canReexecAfterRevocation', () => {
  it('re-executes only outside an update restart and without an active update operation', () => {
    assert.equal(canReexecAfterRevocation({ updateRestart: false, updatePhase: null }), true);
    assert.equal(canReexecAfterRevocation({ updateRestart: true, updatePhase: null }), false);
    for (const phase of ['staging', 'prepared', 'restarting']) {
      assert.equal(canReexecAfterRevocation({ updateRestart: false, updatePhase: phase }), false, phase);
    }
    for (const phase of ['succeeded', 'failed']) {
      assert.equal(canReexecAfterRevocation({ updateRestart: false, updatePhase: phase }), true, phase);
    }
    assert.equal(canReexecAfterRevocation({ updateRestart: true, updatePhase: 'failed' }), false);
  });

  it('treats exactly the coordinator active phases as active', () => {
    assert.deepEqual(['staging', 'prepared', 'restarting', 'succeeded', 'failed'].filter(updateOperationActive), ['staging', 'prepared', 'restarting']);
    assert.equal(updateOperationActive(null), false);
  });
});
