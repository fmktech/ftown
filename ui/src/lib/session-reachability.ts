import type { SessionStatus } from '@/types';

/**
 * Derive the status shown by the dashboard from both available transport planes.
 * Centrifugo presence remains the fallback signal; an attached Local/P2P path is
 * authoritative for liveness when cloud presence is temporarily absent.
 */
export function deriveSessionReachabilityStatus(
  status: SessionStatus,
  bridgeId: string,
  cloudBridgeIds: ReadonlySet<string>,
  directlyReachableBridgeIds: ReadonlySet<string>,
): SessionStatus {
  if (
    status === 'running' &&
    cloudBridgeIds.size > 0 &&
    !cloudBridgeIds.has(bridgeId) &&
    !directlyReachableBridgeIds.has(bridgeId)
  ) {
    return 'disconnected';
  }
  return status;
}
