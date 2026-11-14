// Fault executor: applies each ScheduledFault at atMs, heals it at atMs + durationMs, then performs
// the contract's final heal. All side effects go through FaultActions so the timeline is testable.
import type { Clock, FaultKind, Rec, Role, ScheduledFault } from '../contract.ts';

export interface FaultActions {
  /** Send a signal to the current bridge pid. false when there is no live bridge. */
  signalBridge(sig: 'SIGKILL' | 'SIGSTOP' | 'SIGCONT' | 'SIGTERM'): Promise<boolean>;
  /** Poll (fixed interval, bound) until the bridge pid is gone; true when it exited in time. */
  waitBridgeExit(boundMs: number): Promise<boolean>;
  bridgeAlive(): Promise<boolean>;
  /** Start the bridge (box/up.sh). */
  bridgeUp(): Promise<boolean>;
  /** Signal every fake-agent process of the role. false when none was found. */
  signalAgent(role: Role, sig: 'SIGKILL' | 'SIGSTOP' | 'SIGCONT'): Promise<boolean>;
  /** Jump the guest realtime clock. false when not allowed or it failed. */
  jumpClock(jumpMs: number): Promise<boolean>;
}

export const SIGTERM_EXIT_BOUND_MS = 30_000;
export const SIGKILL_EXIT_BOUND_MS = 10_000;

interface Step {
  atMs: number;
  /** 0 = start, 1 = heal; heals before starts at equal times. */
  order: number;
  seq: number;
  fault: ScheduledFault;
  phase: 'start' | 'heal';
}

/** True when the fault kind has a heal step (durationMs > 0 and something to undo). */
export function hasHeal(f: ScheduledFault): boolean {
  if (f.durationMs <= 0) return false;
  return f.kind === 'bridge_kill9' || f.kind === 'bridge_sigstop' || f.kind === 'bridge_sigterm' || f.kind === 'agent_sigstop';
}

/** Timeline of start/heal steps sorted by (time, heal before start, schedule order). */
export function timeline(schedule: readonly ScheduledFault[]): Step[] {
  const steps: Step[] = [];
  schedule.forEach((f, i) => {
    steps.push({ atMs: f.atMs, order: 1, seq: i, fault: f, phase: 'start' });
    if (hasHeal(f)) steps.push({ atMs: f.atMs + f.durationMs, order: 0, seq: i, fault: f, phase: 'heal' });
  });
  return steps.sort((a, b) => a.atMs - b.atMs || a.order - b.order || a.seq - b.seq);
}

async function applyStart(f: ScheduledFault, a: FaultActions): Promise<boolean> {
  switch (f.kind) {
    case 'bridge_kill9':
      return a.signalBridge('SIGKILL');
    case 'bridge_sigstop':
      return a.signalBridge('SIGSTOP');
    case 'bridge_sigterm': {
      if (!(await a.signalBridge('SIGTERM'))) return false;
      if (await a.waitBridgeExit(SIGTERM_EXIT_BOUND_MS)) return true;
      await a.signalBridge('SIGKILL');
      // Heal must not start while the old bridge still holds its port and pid file.
      await a.waitBridgeExit(SIGKILL_EXIT_BOUND_MS);
      return false;
    }
    case 'agent_kill9':
    case 'parent_kill9':
      return a.signalAgent(f.target as Role, 'SIGKILL');
    case 'agent_sigstop':
      return a.signalAgent(f.target as Role, 'SIGSTOP');
    case 'clock_jump_fwd':
    case 'clock_jump_back':
      return f.jumpMs === null ? false : a.jumpClock(f.jumpMs);
  }
}

async function applyHeal(f: ScheduledFault, a: FaultActions): Promise<boolean> {
  switch (f.kind) {
    case 'bridge_kill9':
    case 'bridge_sigterm':
      return a.bridgeUp();
    case 'bridge_sigstop':
      return a.signalBridge('SIGCONT');
    case 'agent_sigstop':
      return a.signalAgent(f.target as Role, 'SIGCONT');
    default:
      return true;
  }
}

/** Final heal: SIGCONT everything, start the bridge if it is not running. ok = bridge alive after. */
async function finalHeal(a: FaultActions, roles: readonly Role[]): Promise<boolean> {
  await a.signalBridge('SIGCONT');
  for (const r of roles) await a.signalAgent(r, 'SIGCONT');
  if (await a.bridgeAlive()) return true;
  return a.bridgeUp();
}

export interface ExecutorDeps {
  clock: Clock;
  schedule: readonly ScheduledFault[];
  actions: FaultActions;
  roles: readonly Role[];
  log: (rec: Rec) => void;
  /** Checked before each step; true ends the loop without the final heal (another loop failed). */
  stopped?: () => boolean;
}

const BRIDGE_KINDS: readonly FaultKind[] = ['bridge_kill9', 'bridge_sigstop', 'bridge_sigterm'];

/**
 * Runs the whole schedule; resolves after the final heal (immediately when the schedule is empty).
 * Every step fires at its own atMs, independent of slow earlier steps (a heal running up.sh does
 * not delay other faults). Two orderings are kept: a fault's heal runs after its own start has
 * finished, and bridge steps (start or heal) never overlap — a bridge step that is due while
 * another is still running waits, and its record's t is the instant it actually applies.
 */
export async function runFaults(deps: ExecutorDeps): Promise<void> {
  const { clock, actions, log } = deps;
  let bridgeLock: Promise<unknown> = Promise.resolve();
  const withBridge = <T>(f: () => Promise<T>): Promise<T> => {
    const p = bridgeLock.then(f);
    bridgeLock = p.catch(() => undefined);
    return p;
  };
  /** Resolves with the instant the start actually applied (null when stopped). */
  const starts = new Map<number, Promise<number | null>>();
  const tasks: Promise<unknown>[] = [];
  for (const s of timeline(deps.schedule)) {
    const task = (async (): Promise<number | null> => {
      let due = s.atMs;
      if (s.phase === 'heal') {
        // A start delayed behind a bridge heal still holds for its full duration.
        const startedAt = await starts.get(s.seq);
        if (startedAt === null || startedAt === undefined) return null;
        due = Math.max(due, startedAt + s.fault.durationMs);
      }
      const wait = due - clock.now();
      if (wait > 0) await clock.sleep(wait);
      if (deps.stopped?.()) return null;
      const apply = async (): Promise<number> => {
        const t = clock.now();
        const ok = s.phase === 'start' ? await applyStart(s.fault, actions) : await applyHeal(s.fault, actions);
        const doneT = clock.now();
        log({ k: 'fault', t, doneT, id: s.fault.id, phase: s.phase, kind: s.fault.kind, target: s.fault.target, ok });
        return t;
      };
      return BRIDGE_KINDS.includes(s.fault.kind) ? withBridge(apply) : apply();
    })();
    if (s.phase === 'start') starts.set(s.seq, task);
    tasks.push(task);
  }
  await Promise.all(tasks);
  if (deps.schedule.length === 0 || deps.stopped?.()) return;
  const last: FaultKind = deps.schedule[deps.schedule.length - 1].kind;
  await withBridge(async () => {
    const t = clock.now();
    const ok = await finalHeal(actions, deps.roles);
    const doneT = clock.now();
    log({ k: 'fault', t, doneT, id: 'heal', phase: 'heal', kind: last, target: 'all', ok });
  });
}
