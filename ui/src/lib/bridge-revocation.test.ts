import { describe, it, expect } from 'vitest';
import { generateEndpoint } from '@security/crypto';
import { createAccountGenesis, generateAccountSigningIdentity, signAccountTransition, verifyAccountHistory } from '@security/account-crypto';
import type { AccountHistory, AccountOperation } from '@security/account-protocol';
import { AccountTrustStore } from './account-trust-store';
import { accountBridgeIds, bridgeRevocationForOwner, revocationEvidence } from './bridge-revocation';

const owner = '349f8d2e-38e4-4d59-888d-687dcfa19e39';

async function fixture() {
  const now = Date.now();
  const admin = await generateEndpoint(owner, 'browser');
  const signing = await generateAccountSigningIdentity();
  const genesis = await createAccountGenesis(owner, admin.endpoint, signing, 'Admin', now);
  let history: AccountHistory = { genesis, transitions: [] };
  let checkpoint = await verifyAccountHistory(history, null, now);
  const append = async (operation: AccountOperation) => {
    const record = await signAccountTransition(checkpoint, admin.endpoint.id, signing, operation, now);
    history = { genesis, transitions: [...history.transitions, record] };
    checkpoint = await verifyAccountHistory(history, checkpoint, now);
  };
  const addBridge = async (bridgeId: string) => {
    const bridge = await generateEndpoint(owner, 'bridge');
    await append({ type: 'add_bridge', bridge: { bridgeId, endpoint: bridge.endpoint, label: bridgeId, approvedAt: new Date(now).toISOString() } });
  };
  const addDevice = async () => {
    const device = await generateEndpoint(owner, 'browser');
    const deviceSigning = await generateAccountSigningIdentity();
    await append({ type: 'add_device', device: { endpoint: device.endpoint, signingPublicKey: deviceSigning.publicKey, label: 'Extra', approvedAt: new Date(now).toISOString() } });
  };
  const row = () => ({ root_id: checkpoint.rootId, revision: checkpoint.revision, head: checkpoint.head });
  const store = () => ({ readVerified: async () => ({ history, checkpoint }) });
  return { now, row, append, addBridge, addDevice, store, get history() { return history; } };
}

describe('bridge revocation', () => {
  it('reports not revoked when the owner has no history', async () => {
    const store = { readVerified: async () => null };
    expect(await bridgeRevocationForOwner(owner, 'bridge-a', store)).toEqual({ revoked: false });
    expect((await accountBridgeIds(owner, store)).size).toBe(0);
  });

  it('reports not revoked for a rostered bridge', async () => {
    const f = await fixture();
    await f.addBridge('bridge-a');
    expect(await bridgeRevocationForOwner(owner, 'bridge-a', f.store())).toEqual({ revoked: false });
    expect(revocationEvidence(f.history, 'bridge-a')).toBeNull();
  });

  it('revocationEvidence is null when only a different bridge was revoked', async () => {
    const f = await fixture();
    await f.addBridge('bridge-a');
    await f.addBridge('bridge-b');
    await f.append({ type: 'revoke_bridge', bridgeId: 'bridge-b' });
    expect(revocationEvidence(f.history, 'bridge-a')).toBeNull();
  });

  it('does not flag a bridge when a different bridge is revoked', async () => {
    const f = await fixture();
    await f.addBridge('bridge-a');
    await f.addBridge('bridge-b');
    await f.append({ type: 'revoke_bridge', bridgeId: 'bridge-b' });
    expect(await bridgeRevocationForOwner(owner, 'bridge-a', f.store())).toEqual({ revoked: false });
  });

  it('returns evidence truncated right after the first revoke, excluding later transitions', async () => {
    const f = await fixture();
    await f.addBridge('bridge-a');
    await f.addBridge('bridge-b');
    await f.append({ type: 'revoke_bridge', bridgeId: 'bridge-a' });
    const k = f.history.transitions.length - 1;
    await f.addDevice();
    await f.append({ type: 'revoke_bridge', bridgeId: 'bridge-b' });
    const result = await bridgeRevocationForOwner(owner, 'bridge-a', f.store());
    expect(result.revoked).toBe(true);
    if (!result.revoked) return;
    expect(result.evidence.transitions).toHaveLength(k + 1);
    expect(result.evidence.transitions.some(t => t.payload.operation.type === 'add_device')).toBe(false);
    expect(result.evidence.transitions[k].payload.operation).toEqual({ type: 'revoke_bridge', bridgeId: 'bridge-a' });
    expect(result.evidence.genesis).toEqual(f.history.genesis);
    const checkpoint = await verifyAccountHistory(result.evidence, null, f.now);
    expect(checkpoint.revokedBridgeIds).toContain('bridge-a');
    expect(checkpoint.revokedBridgeIds).not.toContain('bridge-b');
  });

  it('does not mutate the input history', async () => {
    const f = await fixture();
    await f.addBridge('bridge-a');
    await f.append({ type: 'revoke_bridge', bridgeId: 'bridge-a' });
    await f.addDevice();
    const before = JSON.stringify(f.history);
    const length = f.history.transitions.length;
    const evidence = revocationEvidence(f.history, 'bridge-a');
    expect(evidence).not.toBe(f.history);
    expect(evidence!.transitions).not.toBe(f.history.transitions);
    expect(f.history.transitions).toHaveLength(length);
    expect(JSON.stringify(f.history)).toBe(before);
  });

  it('fails closed when the store throws', async () => {
    const store = { readVerified: async () => { throw new Error('db down'); } };
    await expect(bridgeRevocationForOwner(owner, 'bridge-a', store)).rejects.toThrow('db down');
    await expect(accountBridgeIds(owner, store)).rejects.toThrow('db down');
  });

  it('fails closed on an inconsistent checkpoint that lists a revocation absent from the history', async () => {
    const f = await fixture();
    await f.addBridge('bridge-a');
    const row = await f.store().readVerified();
    const inconsistent = { readVerified: async () => ({ history: row.history, checkpoint: { ...row.checkpoint, revokedBridgeIds: ['bridge-a'] } }) };
    await expect(bridgeRevocationForOwner(owner, 'bridge-a', inconsistent)).rejects.toThrow('bridge_revocation_inconsistent');
  });

  it('accountBridgeIds lists the roster', async () => {
    const f = await fixture();
    await f.addBridge('bridge-a');
    await f.addBridge('bridge-b');
    const ids = await accountBridgeIds(owner, f.store());
    expect(Array.from(ids).sort()).toEqual(['bridge-a', 'bridge-b']);
    expect(ids.has('bridge-c')).toBe(false);
    await f.append({ type: 'revoke_bridge', bridgeId: 'bridge-b' });
    expect((await accountBridgeIds(owner, f.store())).has('bridge-b')).toBe(false);
  });

  it('works through the real AccountTrustStore verification path', async () => {
    const f = await fixture();
    await f.addBridge('bridge-a');
    await f.append({ type: 'revoke_bridge', bridgeId: 'bridge-a' });
    const good = new AccountTrustStore(async () => [{ ...f.row(), history: f.history }], () => f.now);
    const result = await bridgeRevocationForOwner(owner, 'bridge-a', good);
    expect(result.revoked).toBe(true);
    if (result.revoked) expect(result.evidence.transitions).toHaveLength(f.history.transitions.length);
    const last = f.history.transitions.length - 1;
    const flipped = f.history.transitions[last].signature.replace(/^./, c => (c === 'A' ? 'B' : 'A'));
    const tampered = { genesis: f.history.genesis, transitions: f.history.transitions.map((t, i) => (i === last ? { ...t, signature: flipped } : t)) };
    const bad = new AccountTrustStore(async () => [{ ...f.row(), history: tampered }], () => f.now);
    await expect(bridgeRevocationForOwner(owner, 'bridge-a', bad)).rejects.toThrow();
  });
});
