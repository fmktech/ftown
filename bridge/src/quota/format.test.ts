import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatDuration, formatQuotaTable, formatWindowCell } from './format.js';
import type { ProviderQuota, QuotaStatus, QuotaWindow } from './types.js';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const at = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function win(overrides: Partial<QuotaWindow> & Pick<QuotaWindow, 'kind'>): QuotaWindow {
  return { usedPercent: null, resetsAt: null, windowMinutes: null, note: null, ...overrides };
}

function row(overrides: Partial<ProviderQuota> & Pick<ProviderQuota, 'provider'>): ProviderQuota {
  return {
    status: 'ok',
    plan: null,
    windows: [],
    source: 'live',
    observedAt: NOW.toISOString(),
    message: null,
    ...overrides,
  };
}

describe('formatDuration', () => {
  it('formats boundaries', () => {
    assert.equal(formatDuration(59_000), '<1m');
    assert.equal(formatDuration(60_000), '1m');
    assert.equal(formatDuration(59 * 60_000 + 59_000), '59m');
    assert.equal(formatDuration(HOUR), '1h 0m');
    assert.equal(formatDuration(23 * HOUR + 59 * 60_000), '23h 59m');
    assert.equal(formatDuration(DAY), '1d 0h');
    assert.equal(formatDuration(6 * DAY + 14 * HOUR), '6d 14h');
    assert.equal(formatDuration(0), '<1m');
  });

  it('returns "<1m" for negative and non-finite input', () => {
    assert.equal(formatDuration(-1), '<1m');
    assert.equal(formatDuration(-DAY), '<1m');
    assert.equal(formatDuration(Number.NaN), '<1m');
    assert.equal(formatDuration(Number.POSITIVE_INFINITY), '<1m');
  });
});

describe('formatWindowCell', () => {
  const statusCases: [QuotaStatus, string][] = [
    ['ok', '-'],
    ['no_data', 'no data'],
    ['auth', 'login needed'],
    ['unavailable', 'unavailable'],
    ['error', 'error'],
  ];
  for (const [status, expected] of statusCases) {
    it(`missing window with status ${status} -> "${expected}"`, () => {
      assert.equal(formatWindowCell(undefined, status, NOW), expected);
    });
  }

  it('converts usedPercent to left percent, clamped and rounded', () => {
    assert.equal(formatWindowCell(win({ kind: 'weekly', usedPercent: 0 }), 'ok', NOW), '100%');
    assert.equal(formatWindowCell(win({ kind: 'weekly', usedPercent: 100 }), 'ok', NOW), '0%');
    assert.equal(formatWindowCell(win({ kind: 'weekly', usedPercent: 135 }), 'ok', NOW), '0%');
    assert.equal(formatWindowCell(win({ kind: 'weekly', usedPercent: 2.6 }), 'ok', NOW), '97%');
  });

  it('appends "(reset due)" when resetsAt is not in the future', () => {
    const past = win({ kind: 'weekly', usedPercent: 40, resetsAt: at(-1_000) });
    const equal = win({ kind: 'weekly', usedPercent: 40, resetsAt: at(0) });
    assert.equal(formatWindowCell(past, 'ok', NOW), '60% (reset due)');
    assert.equal(formatWindowCell(equal, 'ok', NOW), '60% (reset due)');
  });

  it('appends "(resets in ...)" for a future resetsAt', () => {
    const future = win({ kind: 'five_hour', usedPercent: 10, resetsAt: at(2 * HOUR + 5 * 60_000) });
    assert.equal(formatWindowCell(future, 'ok', NOW), '90% (resets in 2h 5m)');
  });

  it('shows the note when usedPercent is null', () => {
    const noteOnly = win({ kind: 'five_hour', note: 'no active window' });
    assert.equal(formatWindowCell(noteOnly, 'ok', NOW), 'no active window');
  });

  it('shows "?" when usedPercent is null and the note is absent or empty', () => {
    assert.equal(formatWindowCell(win({ kind: 'weekly' }), 'ok', NOW), '?');
    assert.equal(formatWindowCell(win({ kind: 'weekly', note: '' }), 'ok', NOW), '?');
  });

  it('appends the reset suffix to a note when resetsAt is set', () => {
    const withReset = win({ kind: 'weekly', note: 'waiting', resetsAt: at(HOUR) });
    const withPast = win({ kind: 'weekly', note: 'waiting', resetsAt: at(-HOUR) });
    assert.equal(formatWindowCell(withReset, 'ok', NOW), 'waiting (resets in 1h 0m)');
    assert.equal(formatWindowCell(withPast, 'ok', NOW), 'waiting (reset due)');
  });

  it('appends nothing for a note with null resetsAt', () => {
    const noteOnly = win({ kind: 'weekly', note: 'no active window', resetsAt: null });
    assert.equal(formatWindowCell(noteOnly, 'ok', NOW), 'no active window');
  });
});

describe('formatQuotaTable', () => {
  const rows: ProviderQuota[] = [
    row({
      provider: 'claude',
      plan: 'max',
      windows: [
        win({ kind: 'five_hour', note: 'no active window' }),
        win({ kind: 'weekly', usedPercent: 3, resetsAt: at(6 * DAY + 14 * HOUR) }),
      ],
    }),
    row({
      provider: 'codex',
      plan: 'pro',
      windows: [win({ kind: 'weekly', usedPercent: 92, resetsAt: at(4 * DAY + 11 * HOUR) })],
    }),
    row({
      provider: 'grok',
      windows: [win({ kind: 'weekly', usedPercent: null, resetsAt: at(2 * DAY + 3 * HOUR) })],
      source: 'cached',
      observedAt: at(-3 * HOUR),
      message: "grok's log has the weekly reset time but no usage percentage: run /usage inside grok for the number",
    }),
    row({
      provider: 'muse',
      status: 'no_data',
      message: 'muse reported no allowance yet',
    }),
  ];

  it('reproduces the target table exactly', () => {
    const expected = [
      'PROVIDER  PLAN  5H LEFT           WEEKLY LEFT             SOURCE',
      'claude    max   no active window  97% (resets in 6d 14h)  live',
      'codex     pro   -                 8% (resets in 4d 11h)   live',
      'grok      -     -                 ? (resets in 2d 3h)     cached 3h 0m ago',
      'muse      -     no data           no data                 live',
      '',
      "grok: grok's log has the weekly reset time but no usage percentage: run /usage inside grok for the number",
      'muse: muse reported no allowance yet',
    ].join('\n');
    assert.equal(formatQuotaTable(rows, NOW), expected);
  });

  it('has no trailing whitespace on any line', () => {
    for (const line of formatQuotaTable(rows, NOW).split('\n')) {
      assert.doesNotMatch(line, /\s$/);
    }
  });

  it('returns only the header for an empty rows array', () => {
    assert.equal(formatQuotaTable([], NOW), 'PROVIDER  PLAN  5H LEFT  WEEKLY LEFT  SOURCE');
  });

  it('adds no blank line or message lines when no row has a message', () => {
    const output = formatQuotaTable([row({ provider: 'codex', plan: 'pro' })], NOW);
    assert.equal(output.split('\n').length, 2);
    assert.doesNotMatch(output, /\n\n/);
  });

  it('renders cached source with a bad observedAt as "cached"', () => {
    const output = formatQuotaTable(
      [row({ provider: 'grok', source: 'cached', observedAt: 'not-a-date' })],
      NOW,
    );
    assert.equal(output.split('\n')[1].endsWith('cached'), true);
  });
});
