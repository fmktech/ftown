export type BridgeMode = 'account' | 'solo' | 'local';

export function bridgeMode(opts: { local?: boolean; solo?: boolean }): BridgeMode {
  return opts.local ? 'local' : opts.solo ? 'solo' : 'account';
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
