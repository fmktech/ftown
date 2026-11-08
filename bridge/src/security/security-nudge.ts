export const SECURITY_NUDGE_TYPE = 'ftown_security_changed';
export type SecurityNudgeScope = 'approvals' | 'account';
export interface SecurityNudge { type: typeof SECURITY_NUDGE_TYPE; version: 1; scope: SecurityNudgeScope }

/** `bridges:security#${userId}`; userId is the Centrifugo user (account email). */
export function securityNudgeChannel(userId: string): string {
  if (!userId) throw new Error('securityNudgeChannel: userId is required');
  return `bridges:security#${userId}`;
}

export function securityNudge(scope: SecurityNudgeScope): SecurityNudge {
  return { type: SECURITY_NUDGE_TYPE, version: 1, scope };
}

export function parseSecurityNudge(data: unknown): SecurityNudgeScope | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const proto = Object.getPrototypeOf(data);
  if (proto !== Object.prototype && proto !== null) return null;
  const record = data as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3 || !keys.includes('type') || !keys.includes('version') || !keys.includes('scope')) return null;
  const type = record.type;
  const version = record.version;
  const scope = record.scope;
  if (type !== SECURITY_NUDGE_TYPE || version !== 1) return null;
  return scope === 'approvals' || scope === 'account' ? scope : null;
}

/** Minimum spacing between nudge-triggered refreshes of one scope at one receiver. */
export const SECURITY_NUDGE_MIN_SPACING_MS = 1000;
/** Bridge-only safety re-read of account trust when no nudge arrives. */
export const ACCOUNT_SAFETY_REFRESH_MS = 3600000;

export interface CoalescedTrigger { request(): void; dispose(): void }

interface TriggerTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: TriggerTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Calls `run` for request()s, never two runs at once, and never two run starts closer than minSpacingMs.
 * Requests during a run or inside the spacing window collapse into ONE trailing run.
 * `run` rejections are swallowed. After dispose(), nothing runs. Timers use the injected `timers`.
 */
export function createCoalescedTrigger(
  run: () => Promise<void> | void,
  minSpacingMs: number,
  timers: TriggerTimers = defaultTimers,
): CoalescedTrigger {
  let disposed = false;
  let running = false;
  let pending = false;
  let lastStart: number | null = null;
  let timer: unknown = null;

  const schedule = (): void => {
    if (disposed || running || !pending || timer !== null) return;
    const wait = lastStart === null ? 0 : lastStart + minSpacingMs - timers.now();
    if (wait <= 0) { start(); return; }
    timer = timers.setTimeout(() => { timer = null; schedule(); }, wait);
  };

  const finish = (): void => {
    running = false;
    schedule();
  };

  const start = (): void => {
    pending = false;
    running = true;
    lastStart = timers.now();
    let result: Promise<void> | void;
    try {
      result = run();
    } catch (_error) {
      finish();
      return;
    }
    if (result && typeof (result as Promise<void>).then === 'function') {
      (result as Promise<void>).then(finish, finish);
    } else {
      finish();
    }
  };

  return {
    request(): void {
      if (disposed) return;
      pending = true;
      schedule();
    },
    dispose(): void {
      disposed = true;
      pending = false;
      if (timer !== null) { timers.clearTimeout(timer); timer = null; }
    },
  };
}
