import { AUTOMATION_REMOVED_CODE, AUTOMATION_REMOVED_MESSAGE } from './wire-types.js';

export { AUTOMATION_REMOVED_CODE, AUTOMATION_REMOVED_MESSAGE };

/** Compatibility tombstones only; these are no longer supported commands. */
export const RETIRED_AUTOMATION_COMMANDS: ReadonlySet<string> = new Set([
  'create_loop', 'list_loops', 'update_loop', 'delete_loop', 'run_loop_now', 'get_loop_runs',
]);

export function isRetiredAutomationSession(session: { loopId?: string }): boolean {
  return typeof session.loopId === 'string' && session.loopId.trim().length > 0;
}

export class AutomationRemovedError extends Error {
  readonly code = AUTOMATION_REMOVED_CODE;
  constructor() { super(AUTOMATION_REMOVED_MESSAGE); }
}

export function assertSessionCanLaunch(session: { loopId?: string }): void {
  if (isRetiredAutomationSession(session)) throw new AutomationRemovedError();
}
