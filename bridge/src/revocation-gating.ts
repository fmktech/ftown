import { BridgeRevokedError } from './bridge-auth.js';
import type { AccountCheckpoint } from './security/account-protocol.js';
import { confirmOwnRevocation, isOwnBridgeRevoked } from './security/bridge/revocation.js';

export type BridgeMode = 'account' | 'solo' | 'local';

export function bridgeMode(opts: { local?: boolean; solo?: boolean }): BridgeMode {
  return opts.local ? 'local' : opts.solo ? 'solo' : 'account';
}

/** Solo and local bridges belong to no account, so nothing can revoke them. */
export function handlesRevocation(mode: BridgeMode): boolean {
  return mode === 'account';
}

/** A pin that already tombstones this bridgeId is signed proof on its own. */
export function restartForPinnedRevocation(mode: BridgeMode, pinned: AccountCheckpoint | null, bridgeId: string): boolean {
  return handlesRevocation(mode) && isOwnBridgeRevoked(pinned, bridgeId);
}

/** Only a refusal whose signed history verifies against our own pin counts; a bare 401 or a forged body never does. */
export async function restartForRefreshError(input: { mode: BridgeMode; error: unknown; pinned: AccountCheckpoint | null; bridgeId: string; now?: number }): Promise<boolean> {
  if (!handlesRevocation(input.mode) || !(input.error instanceof BridgeRevokedError)) return false;
  return confirmOwnRevocation({ evidence: input.error.evidence, pinned: input.pinned, bridgeId: input.bridgeId, now: input.now });
}

const ACTIVE_UPDATE_PHASES = ['staging', 'prepared', 'restarting'];

/** Same phases as the update coordinator's active operation: the update reservation is held. */
export function updateOperationActive(phase: string | null): boolean {
  return phase !== null && ACTIVE_UPDATE_PHASES.includes(phase);
}

/**
 * A same-PID re-exec fails while an update reservation names this PID, and a helper-started bridge has no
 * visible stdio for the pairing link; then the next `ftown start` must finish the reset instead.
 */
export function canReexecAfterRevocation(input: { updateRestart: boolean; updatePhase: string | null }): boolean {
  return !input.updateRestart && !updateOperationActive(input.updatePhase);
}
