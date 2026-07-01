import { LoopSchedule } from "@/types";

/**
 * Display/validation helpers only. Authoritative `nextRunAt` always comes
 * from `loop.nextRunAt` (computed on the bridge via cron-parser) — the UI
 * never computes cron occurrences itself.
 */

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds % 86400 === 0) return `${totalSeconds / 86400}d`;
  if (totalSeconds % 3600 === 0) return `${totalSeconds / 3600}h`;
  if (totalSeconds % 60 === 0) return `${totalSeconds / 60}m`;
  return `${totalSeconds}s`;
}

/** Human-readable summary of a loop's schedule for list/form display. */
export function describeSchedule(schedule: LoopSchedule): string {
  if (schedule.kind === "interval") return `every ${formatDuration(schedule.everyMs)}`;
  return schedule.tz ? `cron ${schedule.expression} (${schedule.tz})` : `cron ${schedule.expression}`;
}

/** Live preview text for an interval schedule while editing. */
export function nextIntervalPreview(everyMs: number): string {
  if (!Number.isFinite(everyMs) || everyMs < 1000) return "invalid interval (minimum 1000ms)";
  return `runs every ${formatDuration(everyMs)}`;
}

const CRON_FIELD_COUNT_MIN = 5;
const CRON_FIELD_COUNT_MAX = 6;

/**
 * Light field-count check only (catches obviously malformed input in the
 * form). Authoritative parsing/validation happens on the bridge via
 * cron-parser inside computeNextRun.
 */
export function validateCron(expression: string): string | null {
  const trimmed = expression.trim();
  if (!trimmed) return "cron expression is required";
  const fields = trimmed.split(/\s+/);
  if (fields.length < CRON_FIELD_COUNT_MIN || fields.length > CRON_FIELD_COUNT_MAX) {
    return `cron expression must have ${CRON_FIELD_COUNT_MIN}-${CRON_FIELD_COUNT_MAX} fields, got ${fields.length}`;
  }
  return null;
}
