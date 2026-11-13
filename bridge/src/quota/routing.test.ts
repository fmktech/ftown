import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { adviseQuotaRouting, assessWindow } from './routing.js';
import type { ProviderQuota, QuotaWindow } from './types.js';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const MINUTE = 60_000;
const at = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
const inMinutes = (minutes: number): string => at(minutes * MINUTE);
const WEEK_MINUTES = 10_080;
const FIVE_HOUR_MINUTES = 300;

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

describe('assessWindow', () => {
  it('reports unknown and null left when usedPercent is null, but still computes the reset', () => {
    const result = assessWindow(
      win({ kind: 'five_hour', resetsAt: inMinutes(120), windowMinutes: FIVE_HOUR_MINUTES }),
      NOW,
    );
    assert.deepEqual(result, {
      availability: 'unknown',
      leftPercent: null,
      resetsInMinutes: 120,
      runway: null,
      resetting: false,
    });
  });

  it('does not treat a window with unknown usage as resetting, even when the reset is imminent', () => {
    const result = assessWindow(win({ kind: 'five_hour', resetsAt: inMinutes(3) }), NOW);
    assert.equal(result.availability, 'unknown');
    assert.equal(result.resetting, false);
    assert.equal(result.resetsInMinutes, 3);
  });

  it('reports unknown for a non-finite usedPercent', () => {
    const nan = assessWindow(win({ kind: 'weekly', usedPercent: Number.NaN }), NOW);
    const inf = assessWindow(win({ kind: 'weekly', usedPercent: Number.POSITIVE_INFINITY }), NOW);
    assert.equal(nan.availability, 'unknown');
    assert.equal(nan.leftPercent, null);
    assert.equal(inf.availability, 'unknown');
    assert.equal(inf.leftPercent, null);
  });

  it('clamps and rounds leftPercent', () => {
    assert.equal(assessWindow(win({ kind: 'weekly', usedPercent: 135 }), NOW).leftPercent, 0);
    assert.equal(assessWindow(win({ kind: 'weekly', usedPercent: -20 }), NOW).leftPercent, 100);
    assert.equal(assessWindow(win({ kind: 'weekly', usedPercent: 2.6 }), NOW).leftPercent, 97);
    assert.equal(assessWindow(win({ kind: 'weekly', usedPercent: 2.4 }), NOW).leftPercent, 98);
  });

  it('computes resetsInMinutes as a floored, non-negative whole number', () => {
    const cases: [string | null, number | null][] = [
      [null, null],
      ['not-a-date', null],
      [at(90_000), 1],
      [at(-5 * MINUTE), 0],
      [at(0), 0],
      [inMinutes(45), 45],
    ];
    for (const [resetsAt, expected] of cases) {
      const result = assessWindow(win({ kind: 'weekly', usedPercent: 10, resetsAt }), NOW);
      assert.equal(result.resetsInMinutes, expected, `resetsAt=${String(resetsAt)}`);
    }
  });

  it('computes runway for a weekly window at 8% left with 4d 6h remaining as low 0.13', () => {
    const result = assessWindow(
      win({ kind: 'weekly', usedPercent: 92, resetsAt: inMinutes(6120), windowMinutes: WEEK_MINUTES }),
      NOW,
    );
    assert.equal(result.runway, 0.13);
    assert.equal(result.availability, 'low');
    assert.equal(result.leftPercent, 8);
    assert.equal(result.resetsInMinutes, 6120);
  });

  it('computes runway for a weekly window at 90% left with 6d 10h remaining as available 0.98', () => {
    const result = assessWindow(
      win({ kind: 'weekly', usedPercent: 10, resetsAt: inMinutes(9240), windowMinutes: WEEK_MINUTES }),
      NOW,
    );
    assert.equal(result.runway, 0.98);
    assert.equal(result.availability, 'available');
  });

  it('leaves runway null when windowMinutes is null, zero, negative or non-finite', () => {
    for (const windowMinutes of [null, 0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = assessWindow(
        win({ kind: 'weekly', usedPercent: 10, resetsAt: inMinutes(600), windowMinutes }),
        NOW,
      );
      assert.equal(result.runway, null, `windowMinutes=${String(windowMinutes)}`);
    }
  });

  it('leaves runway null when the reset is unknown or already due', () => {
    const noReset = assessWindow(
      win({ kind: 'weekly', usedPercent: 10, resetsAt: null, windowMinutes: WEEK_MINUTES }),
      NOW,
    );
    const due = assessWindow(
      win({ kind: 'weekly', usedPercent: 10, resetsAt: at(0), windowMinutes: WEEK_MINUTES }),
      NOW,
    );
    assert.equal(noReset.runway, null);
    assert.equal(due.runway, null);
  });

  it('caps runway at 99', () => {
    const result = assessWindow(
      win({ kind: 'weekly', usedPercent: 0, resetsAt: inMinutes(11), windowMinutes: WEEK_MINUTES }),
      NOW,
    );
    assert.equal(result.resetting, false);
    assert.equal(result.runway, 99);
  });

  it('treats a window resetting within 10 minutes as fully available, whatever its real figure', () => {
    const atTen = assessWindow(
      win({ kind: 'five_hour', usedPercent: 100, resetsAt: inMinutes(10), windowMinutes: FIVE_HOUR_MINUTES }),
      NOW,
    );
    const fiveMinutes = assessWindow(
      win({ kind: 'five_hour', usedPercent: 100, resetsAt: inMinutes(5), windowMinutes: FIVE_HOUR_MINUTES }),
      NOW,
    );
    assert.deepEqual(fiveMinutes, {
      availability: 'available',
      leftPercent: 100,
      resetsInMinutes: 5,
      runway: null,
      resetting: true,
    });
    assert.equal(atTen.availability, 'available');
    assert.equal(atTen.leftPercent, 100);
    assert.equal(atTen.resetting, true);
  });

  it('treats a reset exactly now as resetting', () => {
    const result = assessWindow(win({ kind: 'five_hour', usedPercent: 100, resetsAt: at(0) }), NOW);
    assert.equal(result.resetting, true);
    assert.equal(result.leftPercent, 100);
    assert.equal(result.resetsInMinutes, 0);
  });

  it('is not resetting when the reset is 11 minutes away', () => {
    const result = assessWindow(win({ kind: 'five_hour', usedPercent: 100, resetsAt: inMinutes(11) }), NOW);
    assert.equal(result.resetting, false);
    assert.equal(result.leftPercent, 0);
    assert.equal(result.availability, 'exhausted');
  });

  it('is exhausted at 1% left or less once the reset is more than 10 minutes away', () => {
    const zero = assessWindow(
      win({ kind: 'five_hour', usedPercent: 100, resetsAt: inMinutes(11), windowMinutes: FIVE_HOUR_MINUTES }),
      NOW,
    );
    const onePercent = assessWindow(win({ kind: 'weekly', usedPercent: 99, resetsAt: inMinutes(3000) }), NOW);
    const roundsToOne = assessWindow(win({ kind: 'weekly', usedPercent: 98.6, resetsAt: inMinutes(3000) }), NOW);
    assert.equal(zero.availability, 'exhausted');
    assert.equal(onePercent.availability, 'exhausted');
    assert.equal(roundsToOne.availability, 'exhausted');
  });

  it('is low below 15% left', () => {
    const fourteen = assessWindow(win({ kind: 'weekly', usedPercent: 86 }), NOW);
    const two = assessWindow(win({ kind: 'weekly', usedPercent: 98 }), NOW);
    assert.equal(fourteen.leftPercent, 14);
    assert.equal(fourteen.availability, 'low');
    assert.equal(two.availability, 'low');
  });

  it('is available at 15% left with no runway', () => {
    const result = assessWindow(win({ kind: 'weekly', usedPercent: 85 }), NOW);
    assert.equal(result.leftPercent, 15);
    assert.equal(result.runway, null);
    assert.equal(result.availability, 'available');
  });

  it('is low when runway is below 0.5 even with plenty left', () => {
    const result = assessWindow(
      win({ kind: 'weekly', usedPercent: 60, resetsAt: inMinutes(9240), windowMinutes: WEEK_MINUTES }),
      NOW,
    );
    assert.equal(result.leftPercent, 40);
    assert.equal(result.runway, 0.44);
    assert.equal(result.availability, 'low');
  });

  it('is available when runway is exactly 0.5', () => {
    const result = assessWindow(
      win({ kind: 'weekly', usedPercent: 50, resetsAt: inMinutes(WEEK_MINUTES), windowMinutes: WEEK_MINUTES }),
      NOW,
    );
    assert.equal(result.runway, 0.5);
    assert.equal(result.availability, 'available');
  });
});

describe('adviseQuotaRouting', () => {
  it('reports a weekly window at 8% left with 4d 6h remaining as low with runway 0.13', () => {
    const resetsAt = inMinutes(6120);
    const [advice] = adviseQuotaRouting(
      [row({ provider: 'codex', windows: [win({ kind: 'weekly', usedPercent: 92, resetsAt, windowMinutes: WEEK_MINUTES })] })],
      NOW,
    );
    assert.deepEqual(advice, {
      provider: 'codex',
      availability: 'low',
      leftPercent: 8,
      bindingWindow: 'weekly',
      resetsAt,
      resetsInMinutes: 6120,
      runway: 0.13,
      reason: 'only 8% of the weekly window left, resets in 4d 6h (runway 0.13x)',
    });
  });

  it('reports a weekly window at 90% left with 6d 10h remaining as available with runway 0.98', () => {
    const [advice] = adviseQuotaRouting(
      [row({ provider: 'claude', windows: [win({ kind: 'weekly', usedPercent: 10, resetsAt: inMinutes(9240), windowMinutes: WEEK_MINUTES })] })],
      NOW,
    );
    assert.equal(advice.availability, 'available');
    assert.equal(advice.runway, 0.98);
    assert.equal(advice.reason, '90% of the weekly window left, resets in 6d 10h (runway 0.98x)');
  });

  it('picks the weekly window as binding for a muse-like row (five_hour unused, weekly 42% used)', () => {
    const weeklyReset = inMinutes(3420);
    const [advice] = adviseQuotaRouting(
      [
        row({
          provider: 'muse',
          windows: [
            win({ kind: 'five_hour', usedPercent: 0, resetsAt: inMinutes(300), windowMinutes: null }),
            win({ kind: 'weekly', usedPercent: 42, resetsAt: weeklyReset, windowMinutes: WEEK_MINUTES }),
          ],
        }),
      ],
      NOW,
    );
    assert.equal(advice.availability, 'available');
    assert.equal(advice.bindingWindow, 'weekly');
    assert.equal(advice.leftPercent, 58);
    assert.equal(advice.resetsAt, weeklyReset);
    assert.equal(advice.resetsInMinutes, 3420);
    assert.equal(advice.runway, 1.71);
    assert.equal(advice.reason, '58% of the weekly window left, resets in 2d 9h (runway 1.71x)');
  });

  it('reports five_hour at 0% left resetting in 5 minutes as available with 100% left', () => {
    const [advice] = adviseQuotaRouting(
      [row({ provider: 'claude', windows: [win({ kind: 'five_hour', usedPercent: 100, resetsAt: inMinutes(5), windowMinutes: FIVE_HOUR_MINUTES })] })],
      NOW,
    );
    assert.equal(advice.availability, 'available');
    assert.equal(advice.bindingWindow, 'five_hour');
    assert.equal(advice.leftPercent, 100);
    assert.equal(advice.runway, null);
    assert.equal(advice.resetsInMinutes, 5);
    assert.equal(advice.reason, '5-hour window resets in 5m');
  });

  it('reports a five_hour window with 0% left and no windowMinutes, reset 3h away, as exhausted', () => {
    const resetsAt = inMinutes(180);
    const [advice] = adviseQuotaRouting(
      [row({ provider: 'codex', windows: [win({ kind: 'five_hour', usedPercent: 100, resetsAt, windowMinutes: null })] })],
      NOW,
    );
    assert.equal(advice.availability, 'exhausted');
    assert.equal(advice.leftPercent, 0);
    assert.equal(advice.runway, null);
    assert.equal(advice.resetsAt, resetsAt);
    assert.equal(advice.reason, '5-hour window used up, resets in 3h 0m');
  });

  it('uses the pace-only low reason when quota is above 15% but runway is below 0.5', () => {
    const [advice] = adviseQuotaRouting(
      [row({ provider: 'claude', windows: [win({ kind: 'weekly', usedPercent: 60, resetsAt: inMinutes(9240), windowMinutes: WEEK_MINUTES })] })],
      NOW,
    );
    assert.equal(advice.availability, 'low');
    assert.equal(advice.leftPercent, 40);
    assert.equal(advice.runway, 0.44);
    assert.equal(advice.reason, '40% of the weekly window left but 6d 10h until reset (runway 0.44x)');
  });

  it('never prints a zero runway in a reason', () => {
    const [advice] = adviseQuotaRouting(
      [row({ provider: 'codex', windows: [win({ kind: 'weekly', usedPercent: 98, resetsAt: inMinutes(9240), windowMinutes: 1 })] })],
      NOW,
    );
    assert.equal(advice.availability, 'low');
    assert.equal(advice.runway, 0);
    assert.doesNotMatch(advice.reason, /runway 0x/);
    assert.equal(advice.reason, 'only 2% of the weekly window left, resets in 6d 10h');
  });

  it('ranks a window that resets now (score 1.00) above a healthy weekly (score 0.88)', () => {
    // Hand-computed: claude five_hour used 100%, reset == now -> resetting, left 100, runway null,
    //   score = 1.00 * min(1, 1) = 1.00.
    // codex weekly used 10% (left 90), runway 0.98 -> score = 0.90 * 0.98 = 0.882 -> 0.88.
    // Expected order: claude, codex.
    const advice = adviseQuotaRouting(
      [
        row({
          provider: 'codex',
          windows: [win({ kind: 'weekly', usedPercent: 10, resetsAt: inMinutes(9240), windowMinutes: WEEK_MINUTES })],
        }),
        row({
          provider: 'claude',
          windows: [win({ kind: 'five_hour', usedPercent: 100, resetsAt: at(0), windowMinutes: FIVE_HOUR_MINUTES })],
        }),
      ],
      NOW,
    );
    assert.deepEqual(
      advice.map((a) => [a.provider, a.availability, a.leftPercent, a.runway]),
      [
        ['claude', 'available', 100, null],
        ['codex', 'available', 90, 0.98],
      ],
    );
    assert.equal(advice[0].reason, '5-hour window resets in <1m');
  });

  it('orders available rows by score: A (1.00), B (0.87), C (0.58)', () => {
    // A: five_hour 0% used, windowMinutes 300, reset in 300 min -> left 100, runway 1, score 1.00.
    // B: weekly 11% used, reset in 9151 min -> left 89, runway 0.98, score 0.89 * 0.98 = 0.87.
    // C: weekly 42% used, reset in 3420 min -> left 58, runway 1.71, score 0.58 * 1 = 0.58.
    // Input is C, A, B; expected output A, B, C.
    const advice = adviseQuotaRouting(
      [
        row({
          provider: 'muse',
          windows: [win({ kind: 'weekly', usedPercent: 42, resetsAt: inMinutes(3420), windowMinutes: WEEK_MINUTES })],
        }),
        row({
          provider: 'claude',
          windows: [win({ kind: 'five_hour', usedPercent: 0, resetsAt: inMinutes(300), windowMinutes: FIVE_HOUR_MINUTES })],
        }),
        row({
          provider: 'codex',
          windows: [win({ kind: 'weekly', usedPercent: 11, resetsAt: inMinutes(9151), windowMinutes: WEEK_MINUTES })],
        }),
      ],
      NOW,
    );
    assert.deepEqual(
      advice.map((a) => [a.provider, a.leftPercent, a.runway]),
      [
        ['claude', 100, 1],
        ['codex', 89, 0.98],
        ['muse', 58, 1.71],
      ],
    );
  });

  it('reports five_hour at 0% left resetting in 3h as exhausted, binding over a healthy weekly', () => {
    const fiveHourReset = inMinutes(180);
    const [advice] = adviseQuotaRouting(
      [
        row({
          provider: 'claude',
          windows: [
            win({ kind: 'five_hour', usedPercent: 100, resetsAt: fiveHourReset, windowMinutes: FIVE_HOUR_MINUTES }),
            win({ kind: 'weekly', usedPercent: 20, resetsAt: inMinutes(5000), windowMinutes: WEEK_MINUTES }),
          ],
        }),
      ],
      NOW,
    );
    assert.equal(advice.availability, 'exhausted');
    assert.equal(advice.bindingWindow, 'five_hour');
    assert.equal(advice.leftPercent, 0);
    assert.equal(advice.resetsAt, fiveHourReset);
    assert.equal(advice.resetsInMinutes, 180);
    assert.equal(advice.reason, '5-hour window used up, resets in 3h 0m');
  });

  it('omits the reset clause when the binding window has no reset time', () => {
    const [available] = adviseQuotaRouting(
      [row({ provider: 'codex', windows: [win({ kind: 'weekly', usedPercent: 30 })] })],
      NOW,
    );
    const [exhausted] = adviseQuotaRouting(
      [row({ provider: 'codex', windows: [win({ kind: 'weekly', usedPercent: 100 })] })],
      NOW,
    );
    assert.equal(available.reason, '70% of the weekly window left');
    assert.equal(available.resetsInMinutes, null);
    assert.equal(exhausted.reason, 'weekly window used up');
  });

  it('does not append runway to the exhausted form', () => {
    const [advice] = adviseQuotaRouting(
      [
        row({
          provider: 'grok',
          windows: [win({ kind: 'five_hour', usedPercent: 100, resetsAt: inMinutes(180), windowMinutes: FIVE_HOUR_MINUTES })],
        }),
      ],
      NOW,
    );
    assert.equal(advice.runway, 0);
    assert.equal(advice.reason, '5-hour window used up, resets in 3h 0m');
  });

  it('breaks binding ties by lower leftPercent', () => {
    const [advice] = adviseQuotaRouting(
      [
        row({
          provider: 'claude',
          windows: [
            win({ kind: 'five_hour', usedPercent: 40 }),
            win({ kind: 'weekly', usedPercent: 70 }),
          ],
        }),
      ],
      NOW,
    );
    assert.equal(advice.bindingWindow, 'weekly');
    assert.equal(advice.leftPercent, 30);
  });

  it('breaks binding ties with equal leftPercent by five_hour before weekly', () => {
    const [advice] = adviseQuotaRouting(
      [
        row({
          provider: 'claude',
          windows: [
            win({ kind: 'weekly', usedPercent: 50 }),
            win({ kind: 'five_hour', usedPercent: 50 }),
          ],
        }),
      ],
      NOW,
    );
    assert.equal(advice.bindingWindow, 'five_hour');
  });

  it('ignores windows with unknown numbers when choosing the binding window', () => {
    const [advice] = adviseQuotaRouting(
      [
        row({
          provider: 'claude',
          windows: [
            win({ kind: 'five_hour', usedPercent: null, note: 'no active window' }),
            win({ kind: 'weekly', usedPercent: 60 }),
          ],
        }),
      ],
      NOW,
    );
    assert.equal(advice.bindingWindow, 'weekly');
    assert.equal(advice.leftPercent, 40);
  });

  it('reports unknown with the trimmed row message for a non-ok status', () => {
    const [advice] = adviseQuotaRouting(
      [
        row({
          provider: 'claude',
          status: 'auth',
          message: '  login expired: run claude login  ',
          windows: [win({ kind: 'weekly', usedPercent: 10, resetsAt: inMinutes(600), windowMinutes: WEEK_MINUTES })],
        }),
      ],
      NOW,
    );
    assert.deepEqual(advice, {
      provider: 'claude',
      availability: 'unknown',
      leftPercent: null,
      bindingWindow: null,
      resetsAt: null,
      resetsInMinutes: null,
      runway: null,
      reason: 'login expired: run claude login',
    });
  });

  it('uses the fallback reason for unknown rows without a usable message', () => {
    const [noMessage] = adviseQuotaRouting([row({ provider: 'muse', status: 'unavailable' })], NOW);
    const [blankMessage] = adviseQuotaRouting(
      [row({ provider: 'muse', status: 'no_data', message: '   ' })],
      NOW,
    );
    assert.equal(noMessage.reason, 'no usage numbers available');
    assert.equal(noMessage.availability, 'unknown');
    assert.equal(blankMessage.reason, 'no usage numbers available');
  });

  it('is unknown for an ok row whose windows have no usedPercent', () => {
    const [advice] = adviseQuotaRouting(
      [
        row({
          provider: 'grok',
          message: 'grok has no usage percentage',
          windows: [win({ kind: 'weekly', usedPercent: null, resetsAt: inMinutes(600), windowMinutes: WEEK_MINUTES })],
        }),
      ],
      NOW,
    );
    assert.equal(advice.availability, 'unknown');
    assert.equal(advice.leftPercent, null);
    assert.equal(advice.bindingWindow, null);
    assert.equal(advice.resetsInMinutes, null);
    assert.equal(advice.reason, 'grok has no usage percentage');
  });

  it('is unknown for an ok row with no windows at all', () => {
    const [advice] = adviseQuotaRouting([row({ provider: 'codex', windows: [] })], NOW);
    assert.equal(advice.availability, 'unknown');
    assert.equal(advice.reason, 'no usage numbers available');
  });

  it('returns one entry per input row', () => {
    const advice = adviseQuotaRouting(
      [
        row({ provider: 'claude' }),
        row({ provider: 'codex' }),
        row({ provider: 'grok' }),
        row({ provider: 'muse' }),
      ],
      NOW,
    );
    assert.equal(advice.length, 4);
    assert.deepEqual(advice.map((a) => a.provider).sort(), ['claude', 'codex', 'grok', 'muse']);
  });

  it('sorts a mixed list as available, low, unknown, exhausted', () => {
    const advice = adviseQuotaRouting(
      [
        row({
          provider: 'grok',
          windows: [win({ kind: 'five_hour', usedPercent: 100, resetsAt: inMinutes(180), windowMinutes: FIVE_HOUR_MINUTES })],
        }),
        row({ provider: 'muse', status: 'auth', message: 'login needed' }),
        row({
          provider: 'codex',
          windows: [win({ kind: 'weekly', usedPercent: 92, resetsAt: inMinutes(6120), windowMinutes: WEEK_MINUTES })],
        }),
        row({
          provider: 'claude',
          windows: [win({ kind: 'weekly', usedPercent: 10, resetsAt: inMinutes(9240), windowMinutes: WEEK_MINUTES })],
        }),
      ],
      NOW,
    );
    assert.deepEqual(
      advice.map((a) => [a.provider, a.availability]),
      [
        ['claude', 'available'],
        ['codex', 'low'],
        ['muse', 'unknown'],
        ['grok', 'exhausted'],
      ],
    );
  });

  it('sorts within a rank by score: claude 0.88, codex 0.60, muse 0.58', () => {
    const advice = adviseQuotaRouting(
      [
        row({
          provider: 'claude',
          windows: [win({ kind: 'weekly', usedPercent: 10, resetsAt: inMinutes(9240), windowMinutes: WEEK_MINUTES })],
        }),
        row({
          provider: 'muse',
          windows: [win({ kind: 'weekly', usedPercent: 42, resetsAt: inMinutes(3420), windowMinutes: WEEK_MINUTES })],
        }),
        row({
          provider: 'codex',
          windows: [win({ kind: 'five_hour', usedPercent: 40, resetsAt: inMinutes(300) })],
        }),
      ],
      NOW,
    );
    assert.deepEqual(
      advice.map((a) => [a.provider, a.runway]),
      [
        ['claude', 0.98],
        ['codex', null],
        ['muse', 1.71],
      ],
    );
  });

  it('sorts runway-less available rows by leftPercent, with unknown rows last', () => {
    const advice = adviseQuotaRouting(
      [
        row({ provider: 'grok', status: 'error', message: 'boom' }),
        row({ provider: 'muse', windows: [win({ kind: 'five_hour', usedPercent: 30 })] }),
        row({ provider: 'codex', windows: [win({ kind: 'five_hour', usedPercent: 50 })] }),
      ],
      NOW,
    );
    assert.deepEqual(
      advice.map((a) => a.provider),
      ['muse', 'codex', 'grok'],
    );
  });

  it('breaks full ties by canonical provider order regardless of input order', () => {
    const sameWindow = win({ kind: 'weekly', usedPercent: 50 });
    const advice = adviseQuotaRouting(
      [
        row({ provider: 'muse', windows: [sameWindow] }),
        row({ provider: 'codex', windows: [sameWindow] }),
        row({ provider: 'claude', windows: [sameWindow] }),
      ],
      NOW,
    );
    assert.deepEqual(
      advice.map((a) => a.provider),
      ['claude', 'codex', 'muse'],
    );
  });

  it('does not mutate its input', () => {
    const rows: ProviderQuota[] = [
      row({
        provider: 'muse',
        windows: [
          win({ kind: 'five_hour', usedPercent: 0 }),
          win({ kind: 'weekly', usedPercent: 42, resetsAt: inMinutes(3420), windowMinutes: WEEK_MINUTES }),
        ],
      }),
      row({ provider: 'claude', status: 'auth', message: 'login needed' }),
    ];
    const snapshot = structuredClone(rows);
    const order = rows.map((r) => r.provider);
    adviseQuotaRouting(rows, NOW);
    assert.deepEqual(rows, snapshot);
    assert.deepEqual(
      rows.map((r) => r.provider),
      order,
    );
  });
});
