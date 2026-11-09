import type { AccountCheckpoint, AccountHistory } from '../account-protocol.js';
import { parseAccountHistory, verifyAccountHistory } from '../account-crypto.js';

export function parseBridgeRevokedBody(body: string): AccountHistory | null {
  try {
    const value: unknown = JSON.parse(body);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.error !== 'bridge_revoked' || record.history === undefined) return null;
    return parseAccountHistory(record.history);
  } catch {
    return null;
  }
}

export function isOwnBridgeRevoked(checkpoint: AccountCheckpoint | null, bridgeId: string): boolean {
  return checkpoint !== null && checkpoint.revokedBridgeIds.indexOf(bridgeId) !== -1;
}

export async function confirmOwnRevocation(input: { evidence: AccountHistory; pinned: AccountCheckpoint | null; bridgeId: string; now?: number }): Promise<boolean> {
  try {
    if (input.pinned === null) return false;
    // The pin is mandatory: verifying without it would accept a forked history that merely revokes this bridge.
    const checkpoint = await verifyAccountHistory(input.evidence, input.pinned, input.now);
    return isOwnBridgeRevoked(checkpoint, input.bridgeId);
  } catch {
    return false;
  }
}

/** Thrown when the account service answers a signed 'bridge_revoked' refusal; the evidence is still unverified. */
export class AccountBridgeRevoked extends Error {
  readonly evidence: AccountHistory;
  constructor(evidence: AccountHistory) {
    super('Account bridge revoked');
    this.name = 'AccountBridgeRevoked';
    this.evidence = evidence;
  }
}
