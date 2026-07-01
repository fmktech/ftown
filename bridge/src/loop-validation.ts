import { computeNextRun } from './loop-schedule.js';

import type { LoopDraft, LoopSchedule } from './types.js';

/**
 * Loop payload validation, extracted from index.ts so it is unit-testable
 * without importing the CLI entrypoint (which calls program.parse() on load).
 * Every validator returns an error string, or null when the input is valid.
 */

export const LOOP_HARNESSES: ReadonlySet<string> = new Set([
  'claude',
  'cursor',
  'codex',
  'opencode',
  'shell',
]);

/** Validate a loop schedule (interval floor + cron parseability). */
export function validateSchedule(schedule: LoopSchedule | undefined): string | null {
  if (!schedule || typeof schedule !== 'object') return 'schedule is required';
  if (schedule.kind === 'interval') {
    if (typeof schedule.everyMs !== 'number' || !Number.isFinite(schedule.everyMs) || schedule.everyMs < 1000) {
      return 'interval everyMs must be a finite number >= 1000';
    }
    return null;
  }
  if (schedule.kind === 'cron') {
    if (typeof schedule.expression !== 'string' || !schedule.expression.trim()) {
      return 'cron expression is required';
    }
    try {
      computeNextRun(schedule, Date.now());
    } catch {
      return `Invalid cron expression: ${schedule.expression}`;
    }
    return null;
  }
  return 'schedule.kind must be "interval" or "cron"';
}

export function validateRetention(retention: LoopDraft['retention'] | undefined): string | null {
  const value = retention?.autoClearAfterRuns;
  const ok = value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return retention && ok ? null : 'retention.autoClearAfterRuns must be null or a non-negative number';
}

/** Full-draft validation for create_loop. */
export function validateLoopDraft(draft: Partial<LoopDraft>): string | null {
  if (!draft || typeof draft !== 'object') return 'Invalid loop payload';
  // Required so a create can never slip past the bridge-routing guard and get
  // duplicated across every connected bridge (create mints a fresh id).
  if (typeof draft.bridgeId !== 'string' || !draft.bridgeId.trim()) return 'bridgeId is required';
  if (typeof draft.name !== 'string' || !draft.name.trim()) return 'Loop name is required';
  if (typeof draft.task !== 'string' || !draft.task.trim()) return 'Loop task is required';
  if (typeof draft.harness !== 'string' || !LOOP_HARNESSES.has(draft.harness)) {
    return `Invalid harness: ${String(draft.harness)}`;
  }
  if (draft.overlapPolicy !== 'skip' && draft.overlapPolicy !== 'allow') {
    return 'overlapPolicy must be "skip" or "allow"';
  }
  if (typeof draft.enabled !== 'boolean') return 'enabled must be a boolean';
  const retentionError = validateRetention(draft.retention);
  if (retentionError) return retentionError;
  return validateSchedule(draft.schedule);
}

/** Partial validation for update_loop — only the fields present in the patch. */
export function validateLoopPatch(patch: Partial<LoopDraft>): string | null {
  if (!patch || typeof patch !== 'object') return 'Invalid patch';
  if ('name' in patch && (typeof patch.name !== 'string' || !patch.name.trim())) {
    return 'Loop name must be a non-empty string';
  }
  if ('task' in patch && (typeof patch.task !== 'string' || !patch.task.trim())) {
    return 'Loop task must be a non-empty string';
  }
  if ('harness' in patch && (typeof patch.harness !== 'string' || !LOOP_HARNESSES.has(patch.harness))) {
    return `Invalid harness: ${String(patch.harness)}`;
  }
  if ('overlapPolicy' in patch && patch.overlapPolicy !== 'skip' && patch.overlapPolicy !== 'allow') {
    return 'overlapPolicy must be "skip" or "allow"';
  }
  if ('enabled' in patch && typeof patch.enabled !== 'boolean') return 'enabled must be a boolean';
  if ('retention' in patch) {
    const retentionError = validateRetention(patch.retention);
    if (retentionError) return retentionError;
  }
  if ('schedule' in patch) return validateSchedule(patch.schedule);
  return null;
}
