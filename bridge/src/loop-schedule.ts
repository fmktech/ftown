import cronParser from 'cron-parser';

import type { Loop, LoopSchedule } from './types.js';

/**
 * Epoch ms of the next fire strictly after fromMs.
 *
 * - interval: fromMs + everyMs, floored at a 1000ms minimum cadence so a
 *   misconfigured sub-second loop cannot busy-spin the scheduler.
 * - cron: the next occurrence strictly after `fromMs` in the loop's timezone.
 *   Throws on a malformed cron expression (callers validate before persisting).
 */
export function computeNextRun(schedule: LoopSchedule, fromMs: number): number {
  if (schedule.kind === 'interval') return fromMs + Math.max(1000, schedule.everyMs);
  const it = cronParser.parseExpression(schedule.expression, {
    currentDate: new Date(fromMs),
    tz: schedule.tz,
  });
  return it.next().toDate().getTime();
}

/**
 * Whether a loop should fire on a tick at `nowMs`.
 *
 * A manual run request bypasses both the enabled flag and the schedule (it is a
 * one-shot override cleared on the next fire). Otherwise the loop must be
 * enabled, have a computed nextRunAt, and that target must be at or before now.
 */
export function isDue(loop: Loop, nowMs: number): boolean {
  if (loop.runNowRequested) return true; // manual fire bypasses enabled + schedule
  if (!loop.enabled) return false;
  if (!loop.nextRunAt) return false;
  return Date.parse(loop.nextRunAt) <= nowMs;
}
