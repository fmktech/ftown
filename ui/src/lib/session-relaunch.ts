import type { SessionStatus } from '@/types';

/** Label the manual relaunch action for a session that is safe to restart. */
export function getSessionRelaunchLabel(status: SessionStatus): 'Rerun' | 'Retry' | null {
  if (status === 'completed') return 'Rerun';
  if (status === 'error') return 'Retry';
  return null;
}
