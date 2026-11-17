import type { SecurityErrorCode, SecurityFailure } from '../protocol.js';

/** Messages are deliberately fixed: underlying storage/crypto exceptions never cross this boundary. */
export class BridgeSecurityError extends Error implements SecurityFailure {
  readonly retryable: boolean;
  constructor(readonly code: SecurityErrorCode) {
    super(`Bridge security: ${code}`);
    this.name = 'BridgeSecurityError';
    this.retryable = code === 'storage_unavailable' || code === 'audit_unavailable';
  }
}

/** Raised only by the command dispatcher before it accepts work during startup. */
export class BridgeStartingError extends Error {
  constructor() {
    super('Bridge is starting');
    this.name = 'BridgeStartingError';
  }
}
