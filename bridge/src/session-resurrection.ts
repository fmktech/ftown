import type { Session } from './types.js';

export function shouldResurrectStoredSession(session: Session): boolean {
  if (session.status !== 'running' && session.status !== 'pending') return false;
  return !session.loopId;
}
