import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeNextRun, isDue } from './loop-schedule.js';
import type { Loop, LoopDraft } from './types.js';

const BASE = Date.parse('2026-01-01T00:00:00.000Z');

function makeLoop(overrides: Partial<Loop> = {}): Loop {
  const draft: LoopDraft = {
    name: 'l',
    bridgeId: 'b1',
    schedule: { kind: 'interval', everyMs: 60_000 },
    harness: 'claude',
    task: 't',
    enabled: true,
    overlapPolicy: 'skip',
    retention: { autoClearAfterRuns: 10 },
  };
  return {
    ...draft,
    id: 'loop1',
    createdAt: new Date(BASE).toISOString(),
    updatedAt: new Date(BASE).toISOString(),
    runCount: 0,
    skipCount: 0,
    ...overrides,
  };
}

describe('computeNextRun — interval', () => {
  it('adds everyMs to fromMs when everyMs >= 1000', () => {
    assert.strictEqual(computeNextRun({ kind: 'interval', everyMs: 60_000 }, BASE), BASE + 60_000);
  });

  it('clamps a sub-second interval up to a 1000ms floor', () => {
    assert.strictEqual(computeNextRun({ kind: 'interval', everyMs: 250 }, BASE), BASE + 1000);
    assert.strictEqual(computeNextRun({ kind: 'interval', everyMs: 0 }, BASE), BASE + 1000);
  });
});

describe('computeNextRun — cron', () => {
  it('returns the next 5-minute boundary strictly after fromMs', () => {
    // BASE is exactly on a boundary; next() is exclusive so it advances to :05.
    const next = computeNextRun({ kind: 'cron', expression: '*/5 * * * *', tz: 'UTC' }, BASE);
    assert.strictEqual(new Date(next).toISOString(), '2026-01-01T00:05:00.000Z');
  });

  it('advances from a mid-interval instant to the next boundary', () => {
    const from = Date.parse('2026-01-01T00:07:30.000Z');
    const next = computeNextRun({ kind: 'cron', expression: '*/5 * * * *', tz: 'UTC' }, from);
    assert.strictEqual(new Date(next).toISOString(), '2026-01-01T00:10:00.000Z');
  });

  it('honors a timezone for a daily cron', () => {
    // Midnight in New York on Jan 1 2026 (EST, UTC-5) == 05:00Z.
    const from = Date.parse('2026-01-01T00:00:00.000Z');
    const next = computeNextRun({ kind: 'cron', expression: '0 0 * * *', tz: 'America/New_York' }, from);
    assert.strictEqual(new Date(next).toISOString(), '2026-01-01T05:00:00.000Z');
  });

  it('recomputes from an overdue instant to a future occurrence (missed-schedule primitive)', () => {
    // A loop that was due long ago: computing "from now" skips missed fires and
    // lands on the next future boundary, never a past one.
    const now = Date.parse('2026-06-15T09:03:11.000Z');
    const next = computeNextRun({ kind: 'cron', expression: '0 * * * *', tz: 'UTC' }, now);
    assert.ok(next > now, 'next must be strictly in the future');
    assert.strictEqual(new Date(next).toISOString(), '2026-06-15T10:00:00.000Z');
  });

  it('throws on a malformed cron expression', () => {
    assert.throws(() => computeNextRun({ kind: 'cron', expression: 'not a cron' }, BASE));
    assert.throws(() => computeNextRun({ kind: 'cron', expression: '99 99 99 99 99' }, BASE));
  });
});

describe('isDue', () => {
  it('runNowRequested fires regardless of enabled/schedule/nextRunAt', () => {
    const loop = makeLoop({ enabled: false, nextRunAt: undefined, runNowRequested: true });
    assert.strictEqual(isDue(loop, BASE), true);
  });

  it('a disabled loop is never due (without a manual request)', () => {
    const loop = makeLoop({ enabled: false, nextRunAt: new Date(BASE - 1000).toISOString() });
    assert.strictEqual(isDue(loop, BASE), false);
  });

  it('an enabled loop with no nextRunAt is not due', () => {
    const loop = makeLoop({ enabled: true, nextRunAt: undefined });
    assert.strictEqual(isDue(loop, BASE), false);
  });

  it('is due when nextRunAt is in the past', () => {
    const loop = makeLoop({ nextRunAt: new Date(BASE - 1).toISOString() });
    assert.strictEqual(isDue(loop, BASE), true);
  });

  it('is due when nextRunAt is exactly now (inclusive boundary)', () => {
    const loop = makeLoop({ nextRunAt: new Date(BASE).toISOString() });
    assert.strictEqual(isDue(loop, BASE), true);
  });

  it('is not due when nextRunAt is in the future', () => {
    const loop = makeLoop({ nextRunAt: new Date(BASE + 1).toISOString() });
    assert.strictEqual(isDue(loop, BASE), false);
  });
});
