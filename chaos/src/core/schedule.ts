import {
  FAULTS,
  FAULT_WINDOW_END_MS,
  FAULT_WINDOW_START_MS,
  type BuildSchedule,
  type FaultSpec,
  type Role,
  type ScheduledFault,
} from '../contract.ts';

const CHILDREN: readonly Role[] = ['child1', 'child2', 'child3'];
const MAX_ATTEMPTS = 2_000;

function checkRange(name: string, r: readonly [number, number]): void {
  if (!Number.isFinite(r[0]) || !Number.isFinite(r[1]) || r[0] < 0 || r[1] < r[0]) {
    throw new Error(`FAULTS: ${name} has an empty or inverted range [${r[0]}, ${r[1]}]`);
  }
}

/** Rejects duplicate kinds, clock faults without a jump range, non-clock faults with one, and bad ranges. */
export function validateFaults(table: readonly FaultSpec[]): void {
  const seen = new Set<string>();
  for (const f of table) {
    if (seen.has(f.kind)) throw new Error(`FAULTS: duplicate kind ${f.kind}`);
    seen.add(f.kind);
    if (f.target === 'clock' && f.jump === null) throw new Error(`FAULTS: clock fault ${f.kind} has no jump range`);
    if (f.target !== 'clock' && f.jump !== null) throw new Error(`FAULTS: non-clock fault ${f.kind} has a jump range`);
    checkRange(`${f.kind}.short`, f.short);
    if (f.long !== null) checkRange(`${f.kind}.long`, f.long);
    if (f.jump !== null) {
      checkRange(`${f.kind}.jump.short`, f.jump.short);
      checkRange(`${f.kind}.jump.long`, f.jump.long);
    }
  }
}

const KILLS = new Set(['agent_kill9', 'parent_kill9']);

function endOf(f: ScheduledFault): number {
  return f.atMs + f.durationMs;
}

/** True when `cand` can be added to `placed` without breaking a schedule rule. */
function fits(cand: ScheduledFault, placed: readonly ScheduledFault[]): boolean {
  if (cand.atMs < FAULT_WINDOW_START_MS || endOf(cand) > FAULT_WINDOW_END_MS) return false;
  const candKill = KILLS.has(cand.kind);
  for (const p of placed) {
    const overlapsInTime = cand.atMs <= endOf(p) && p.atMs <= endOf(cand);
    if (cand.target === p.target && overlapsInTime) return false;
    const pKill = KILLS.has(p.kind);
    if (cand.target === p.target && cand.target !== 'bridge' && cand.target !== 'clock') {
      // A killed role is dead for good: one kill per role, nothing before-or-after on it that
      // would target a dead process.
      if (candKill && pKill) return false;
      if (candKill && endOf(p) >= cand.atMs) return false;
      if (pKill && cand.atMs >= p.atMs) return false;
    }
    if (cand.target === 'bridge' && p.target === 'bridge' && overlapsInTime) return false;
  }
  return true;
}

function drawFault(
  rng: Parameters<BuildSchedule>[2],
  candidates: readonly FaultSpec[],
  long: boolean,
): ScheduledFault {
  const spec = rng.pick(candidates);
  let target: ScheduledFault['target'];
  if (spec.target === 'agent') target = rng.pick(CHILDREN);
  else if (spec.target === 'parent') target = 'root';
  else target = spec.target;

  let durationMs = 0;
  let jumpMs: number | null = null;
  if (spec.jump !== null) {
    const size = rng.int(...(long ? spec.jump.long : spec.jump.short));
    jumpMs = spec.kind === 'clock_jump_back' ? -size : size;
  } else {
    const range = long ? spec.long : spec.short;
    if (range === null) throw new Error(`schedule: ${spec.kind} has no long form`);
    durationMs = rng.int(...range);
  }
  const atMs = rng.int(FAULT_WINDOW_START_MS, Math.max(FAULT_WINDOW_START_MS, FAULT_WINDOW_END_MS - durationMs));
  return { id: '', kind: spec.kind, target, atMs, durationMs, jumpMs, long };
}

export const buildSchedule: BuildSchedule = (_seed, level, rng) => {
  validateFaults(FAULTS);
  if (level === 'off') return [];

  const shortCount = level === 'low' ? rng.int(2, 4) : rng.int(3, 5);
  const placed: ScheduledFault[] = [];

  // The long fault is placed first so it always finds room in the window.
  if (level === 'high') {
    const longCandidates = FAULTS.filter((f) => f.long !== null || f.jump !== null);
    let ok = false;
    for (let a = 0; a < MAX_ATTEMPTS && !ok; a++) {
      const cand = drawFault(rng, longCandidates, true);
      if (fits(cand, placed)) {
        placed.push(cand);
        ok = true;
      }
    }
    if (!ok) throw new Error('schedule: could not place the long fault');
  }

  for (let i = 0; i < shortCount; i++) {
    let ok = false;
    for (let a = 0; a < MAX_ATTEMPTS && !ok; a++) {
      const cand = drawFault(rng, FAULTS, false);
      if (fits(cand, placed)) {
        placed.push(cand);
        ok = true;
      }
    }
    if (!ok) throw new Error(`schedule: could not place short fault ${i + 1}`);
  }

  // Array.prototype.sort is stable, so equal atMs keeps draw order.
  const sorted = [...placed].sort((a, b) => a.atMs - b.atMs);
  return sorted.map((f, i) => ({ ...f, id: `f${i + 1}` }));
};
