import type { ApplicationJson, VerifiedApplication } from '../protocol.js';

/** Trusted in-process lifecycle only; never serialized or accepted from clients. */
export interface SecureExecutionObserver {
  /** May refuse new mutations. Called after verification, before any dispatch/revocation effects. */
  admitted(message: VerifiedApplication): void;
  /** Original result only, after successful audit AND awaited sealing. */
  sealed(message: VerifiedApplication, data: ApplicationJson): void;
  /** Exact response reached HTTP finish or resolved broker publication. */
  delivered(requestId: string): void;
  /** Dispatch/audit/seal/transport failure. Never signals successful delivery. */
  failed(requestId: string): void;
}
