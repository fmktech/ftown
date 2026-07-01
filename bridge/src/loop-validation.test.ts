import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateLoopDraft,
  validateLoopPatch,
  validateRetention,
  validateSchedule,
} from './loop-validation.js';
import type { LoopDraft } from './types.js';

function draft(overrides: Partial<LoopDraft> = {}): LoopDraft {
  return {
    name: 'nightly',
    bridgeId: 'bridge-1',
    schedule: { kind: 'interval', everyMs: 60_000 },
    harness: 'claude',
    task: 'do the thing',
    enabled: true,
    overlapPolicy: 'skip',
    retention: { autoClearAfterRuns: 10 },
    ...overrides,
  };
}

describe('validateLoopDraft — required fields', () => {
  it('accepts a well-formed draft', () => {
    assert.strictEqual(validateLoopDraft(draft()), null);
  });

  it('rejects a missing/blank bridgeId (routing guard would otherwise duplicate the create)', () => {
    assert.strictEqual(validateLoopDraft(draft({ bridgeId: '' })), 'bridgeId is required');
    assert.strictEqual(validateLoopDraft(draft({ bridgeId: '   ' })), 'bridgeId is required');
  });

  it('rejects a missing name and a missing task', () => {
    assert.strictEqual(validateLoopDraft(draft({ name: '' })), 'Loop name is required');
    assert.strictEqual(validateLoopDraft(draft({ task: '  ' })), 'Loop task is required');
  });

  it('rejects an unknown harness', () => {
    assert.strictEqual(
      validateLoopDraft(draft({ harness: 'gpt' as LoopDraft['harness'] })),
      'Invalid harness: gpt',
    );
  });

  it('accepts every supported harness', () => {
    for (const harness of ['claude', 'cursor', 'codex', 'opencode', 'shell'] as const) {
      assert.strictEqual(validateLoopDraft(draft({ harness })), null);
    }
  });

  it('rejects a bad overlapPolicy and a non-boolean enabled', () => {
    assert.strictEqual(
      validateLoopDraft(draft({ overlapPolicy: 'queue' as LoopDraft['overlapPolicy'] })),
      'overlapPolicy must be "skip" or "allow"',
    );
    assert.strictEqual(
      validateLoopDraft(draft({ enabled: 'yes' as unknown as boolean })),
      'enabled must be a boolean',
    );
  });
});

describe('validateSchedule', () => {
  it('enforces the 1000ms interval floor', () => {
    assert.strictEqual(validateSchedule({ kind: 'interval', everyMs: 999 }), 'interval everyMs must be a finite number >= 1000');
    assert.strictEqual(validateSchedule({ kind: 'interval', everyMs: 1000 }), null);
  });

  it('rejects a non-finite everyMs', () => {
    assert.strictEqual(
      validateSchedule({ kind: 'interval', everyMs: Number.NaN }),
      'interval everyMs must be a finite number >= 1000',
    );
  });

  it('accepts a valid cron and reports the exact message for a malformed one', () => {
    assert.strictEqual(validateSchedule({ kind: 'cron', expression: '*/5 * * * *' }), null);
    assert.strictEqual(
      validateSchedule({ kind: 'cron', expression: 'not a cron' }),
      'Invalid cron expression: not a cron',
    );
  });

  it('rejects an empty cron expression and an unknown kind', () => {
    assert.strictEqual(validateSchedule({ kind: 'cron', expression: '   ' }), 'cron expression is required');
    assert.strictEqual(
      validateSchedule({ kind: 'weekly' } as unknown as Parameters<typeof validateSchedule>[0]),
      'schedule.kind must be "interval" or "cron"',
    );
    assert.strictEqual(validateSchedule(undefined), 'schedule is required');
  });
});

describe('validateRetention', () => {
  it('accepts null (keep all) and any non-negative number, including 0', () => {
    assert.strictEqual(validateRetention({ autoClearAfterRuns: null }), null);
    assert.strictEqual(validateRetention({ autoClearAfterRuns: 0 }), null);
    assert.strictEqual(validateRetention({ autoClearAfterRuns: 10 }), null);
  });

  it('rejects a negative or non-finite retention', () => {
    const msg = 'retention.autoClearAfterRuns must be null or a non-negative number';
    assert.strictEqual(validateRetention({ autoClearAfterRuns: -1 }), msg);
    assert.strictEqual(validateRetention({ autoClearAfterRuns: Number.NaN }), msg);
    assert.strictEqual(validateRetention(undefined), msg);
  });
});

describe('validateLoopPatch — only present fields are validated', () => {
  it('accepts an empty patch and a single-valid-field patch', () => {
    assert.strictEqual(validateLoopPatch({}), null);
    assert.strictEqual(validateLoopPatch({ enabled: false }), null);
  });

  it('validates a present field but ignores absent ones', () => {
    assert.strictEqual(validateLoopPatch({ name: '' }), 'Loop name must be a non-empty string');
    assert.strictEqual(validateLoopPatch({ task: '  ' }), 'Loop task must be a non-empty string');
    assert.strictEqual(
      validateLoopPatch({ harness: 'nope' as LoopDraft['harness'] }),
      'Invalid harness: nope',
    );
    // name/task absent here — not required in a patch.
    assert.strictEqual(validateLoopPatch({ schedule: { kind: 'interval', everyMs: 5000 } }), null);
  });

  it('surfaces a malformed cron in a schedule patch', () => {
    assert.strictEqual(
      validateLoopPatch({ schedule: { kind: 'cron', expression: '99 99 99 99 99' } }),
      'Invalid cron expression: 99 99 99 99 99',
    );
  });
});
