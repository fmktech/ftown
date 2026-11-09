import type { AccountHistory } from '@security/account-protocol';
import { AccountTrustStore } from '@/lib/account-trust-store';

export type BridgeRevocation = { revoked: false } | { revoked: true; evidence: AccountHistory };
type Store = Pick<AccountTrustStore, 'readVerified'>;

/** Truncates right after the FIRST revoke_bridge for this bridge, so a revoked holder learns nothing later. */
export function revocationEvidence(history: AccountHistory, bridgeId: string): AccountHistory | null {
  const { transitions } = history;
  for (let k = 0; k < transitions.length; k++) {
    const operation = transitions[k].payload.operation;
    if (operation.type === 'revoke_bridge' && operation.bridgeId === bridgeId) {
      return { genesis: history.genesis, transitions: transitions.slice(0, k + 1) };
    }
  }
  return null;
}

/** Fail-closed: store/verify errors propagate; never report "not revoked" on error. */
export async function bridgeRevocationForOwner(ownerId: string, bridgeId: string, store?: Store): Promise<BridgeRevocation> {
  const row = await (store ?? new AccountTrustStore()).readVerified(ownerId);
  if (!row || !row.checkpoint.revokedBridgeIds.includes(bridgeId)) return { revoked: false };
  const evidence = revocationEvidence(row.history, bridgeId);
  if (!evidence) throw new Error('bridge_revocation_inconsistent');
  return { revoked: true, evidence };
}

export async function accountBridgeIds(ownerId: string, store?: Store): Promise<Set<string>> {
  const row = await (store ?? new AccountTrustStore()).readVerified(ownerId);
  return new Set(row ? row.checkpoint.bridges.map(bridge => bridge.bridgeId) : []);
}
