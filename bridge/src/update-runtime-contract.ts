import type { BridgeUpdateOperation } from './update-protocol.js';

/** Private, versioned update/restart capability advertised as ftownUpdateProtocol in package.json. */
export const UPDATE_RESTART_PROTOCOL = 1 as const;

export interface StableRelease {
  version: string;
  gitHead: string;
  tarballUrl: string;
  integrity: string;
  nodeEngine: string;
}

export interface PreparedRelease {
  protocol: 1;
  operationId: string;
  targetVersion: string;
  jobDir: string;
  packageRoot: string;
  packageEntry: string;
}

export interface RestartDescriptor {
  mode: 'cloud' | 'local';
  home: string;
  dataDir: string;
  cwd: string;
  apiUrl: string;
  bridgeId: string;
  ownerId: string;
  endpointId: string;
}

export interface PreparedHandoff {
  /** Resolves only after the exact private commit ACK; old process must still exit before install. */
  commit(): Promise<void>;
  /** Resolves only after the owned helper has exited. Failure must keep admission closed. */
  cancel(): Promise<void>;
}

export interface UpdateRestartContext {
  protocol: 1;
  operationId: string;
  targetVersion: string;
  bridgeId: string;
  ownerId: string;
  endpointId: string;
}

/** prepareHandoff could not prove its owned helper exited; preserve reservation and closed admission. */
export interface UpdateHandoffUncertainFailure extends Error {
  code: 'handoff_uncertain';
}

/** A staging/setup child exceeded termination proof budget; retain owned files/locks and closed admission. */
export interface UpdateProcessUncertainFailure extends Error {
  code: 'update_process_uncertain';
}

export interface UpdateReceipt {
  schema: 1;
  bridgeId: string;
  operation: BridgeUpdateOperation;
}

export interface UpdateReservation {
  /** Release only this exact operation's reservation; never a foreign/live unknown lock. */
  release(): Promise<void>;
}

/** Cross-worker exports implemented by update-release.ts. */
export interface UpdateReleaseApi {
  resolveStableRelease(signal: AbortSignal): Promise<StableRelease>;
  prepareRelease(release: StableRelease, options: {
    operationId: string; stagingRoot: string; signal: AbortSignal;
  }): Promise<PreparedRelease>;
  discardPreparedRelease(prepared: PreparedRelease): Promise<void>;
}

/** Cross-worker exports implemented by the builtin-only update-handoff.ts. */
export interface UpdateHandoffApi {
  /** Ordinary rejection guarantees no helper remains; otherwise reject with code handoff_uncertain. */
  prepareHandoff(prepared: PreparedRelease, restart: RestartDescriptor, signal: AbortSignal): Promise<PreparedHandoff>;
  readUpdateRestartContext(): UpdateRestartContext | null;
  reportUpdateReady(identity: { version: string; bridgeId: string; ownerId: string; endpointId: string }): Promise<void>;
  reserveUpdate(home: string, operationId: string): Promise<UpdateReservation>;
  assertUpdateReservationAllowed(home: string): void;
  readUpdateReceipt(stagingRoot: string): Promise<UpdateReceipt | null>;
  writeUpdateReceipt(stagingRoot: string, receipt: UpdateReceipt): Promise<void>;
}
