/** Shared, versioned update wire contract. No Node imports: consumed by the UI. */
export type BridgeUpdatePhase = 'staging' | 'prepared' | 'restarting' | 'succeeded' | 'failed';

export type BridgeUpdateBlock =
  | 'permission_denied'
  | 'not_enabled'
  | 'unsupported_launch'
  | 'busy'
  | 'in_progress'
  | 'release_unavailable'
  | null;

export interface BridgeUpdateOperation {
  id: string;
  targetVersion: string;
  phase: BridgeUpdatePhase;
  startedAt: string;
  updatedAt: string;
  /** Bounded, sanitized public failure explanation; never child output or credentials. */
  error: string | null;
}

export interface BridgeUpdateStatus {
  schema: 1;
  bridgeId: string;
  currentVersion: string;
  latestVersion: string | null;
  checkedAt: string | null;
  availability: 'current' | 'available' | 'unknown';
  canUpdate: boolean;
  blockedReason: BridgeUpdateBlock;
  operation: BridgeUpdateOperation | null;
  /** Display/copy only. Fixed npm package, with a validated exact stable version when known. */
  manualCommand: string;
}

export interface GetBridgeUpdatePayload {
  bridgeId: string;
  refresh?: boolean;
}

export interface UpdateBridgePayload {
  bridgeId: string;
  targetVersion: string;
  /** Client-generated UUID, retained across outcome reconciliation. Never automatically retry mutation. */
  operationId: string;
}

export interface BridgeUpdateAccepted {
  bridgeId: string;
  operation: BridgeUpdateOperation;
}

export type BridgeUpdateErrorCode =
  | 'invalid_update_request'
  | 'permission_denied'
  | 'updates_disabled'
  | 'bridge_busy'
  | 'update_in_progress'
  | 'release_unavailable'
  | 'update_target_changed'
  | 'update_failed';
