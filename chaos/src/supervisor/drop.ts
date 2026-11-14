// Experiment support: drop listed faults (by id like 'f2' or by kind like 'clock_jump_fwd') from the
// schedule generated for the seed. The schedule is generated first with the seed's rng draws.
import { FAULTS } from '../contract.ts';
import type { ScheduledFault } from '../contract.ts';

/** Tokens from CHAOS_DROP_FAULTS ('f2,f4,clock_jump_fwd'); empty or unset = no drop (null). */
export function parseDropFaults(text: string | undefined): string[] | null {
  if (text === undefined || text.trim() === '') return null;
  return [...new Set(text.split(',').map((s) => s.trim()))];
}

/** Removes the listed faults. unknown = tokens that are neither a scheduled id nor a FAULTS kind (or empty). */
export function applyDrop(schedule: readonly ScheduledFault[], tokens: readonly string[]): { faults: ScheduledFault[]; unknown: string[] } {
  const kinds: readonly string[] = FAULTS.map((f) => f.kind);
  const ids = schedule.map((f) => f.id);
  const unknown = tokens.filter((t) => !ids.includes(t) && !kinds.includes(t));
  const faults = schedule.filter((f) => !tokens.includes(f.id) && !tokens.includes(f.kind));
  return { faults, unknown };
}
