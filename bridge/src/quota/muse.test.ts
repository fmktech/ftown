import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyMuseFailure, extractMuseJson, fetchMuseQuotaWith, parseMuseUsage } from './muse.js';
import type { ProviderQuota, QuotaStatus } from './types.js';

const NOW = new Date('2026-11-13T10:00:00.000Z');

describe('parseMuseUsage', () => {
  it('maps the verified null-allowance body to no_data with the server hint', () => {
    const quota = parseMuseUsage(
      {
        schemaVersion: 1,
        allowance: null,
        reason: 'server_sent_no_usage',
        hint: 'the server sent no usage data for this subscription; this can happen before your first use in a new window',
      },
      NOW,
    );
    assert.deepEqual(quota, {
      provider: 'muse',
      status: 'no_data',
      plan: null,
      windows: [],
      source: 'live',
      observedAt: NOW.toISOString(),
      message:
        'the server sent no usage data for this subscription; this can happen before your first use in a new window',
    });
  });

  it('uses the default message when the null-allowance body has no hint', () => {
    const quota = parseMuseUsage({ allowance: null }, NOW);
    assert.equal(quota.status, 'no_data');
    assert.equal(
      quota.message,
      'muse reported no allowance yet (it appears after the first use in a window)',
    );
  });

  it('parses a camelCase populated allowance with both windows', () => {
    const observedMs = Date.UTC(2026, 10, 13, 9, 30);
    const fiveHourResetMs = Date.UTC(2026, 10, 13, 13, 0);
    const weeklyResetMs = Date.UTC(2026, 10, 18, 0, 0);
    const quota = parseMuseUsage(
      {
        allowance: {
          tier: 'max',
          observedAtMs: observedMs,
          window: { usedPercent: 42.5, windowDurationMins: 300, resetsAtMs: fiveHourResetMs },
          weekly: { usedPercent: 17, resetsAtMs: weeklyResetMs },
        },
      },
      NOW,
    );
    assert.equal(quota.provider, 'muse');
    assert.equal(quota.status, 'ok');
    assert.equal(quota.plan, 'max');
    assert.equal(quota.source, 'live');
    assert.equal(quota.observedAt, new Date(observedMs).toISOString());
    assert.equal(quota.message, null);
    assert.deepEqual(quota.windows, [
      {
        kind: 'five_hour',
        usedPercent: 42.5,
        resetsAt: new Date(fiveHourResetMs).toISOString(),
        windowMinutes: 300,
        note: null,
      },
      {
        kind: 'weekly',
        usedPercent: 17,
        resetsAt: new Date(weeklyResetMs).toISOString(),
        windowMinutes: 10080,
        note: null,
      },
    ]);
  });

  it('parses a snake_case populated allowance the same way', () => {
    const observedMs = Date.UTC(2026, 10, 13, 9, 30);
    const fiveHourResetMs = Date.UTC(2026, 10, 13, 13, 0);
    const weeklyResetMs = Date.UTC(2026, 10, 18, 0, 0);
    const quota = parseMuseUsage(
      {
        allowance: {
          tier: 'pro',
          observed_at_ms: observedMs,
          window: { used_percent: 8, window_duration_mins: 240, resets_at_ms: fiveHourResetMs },
          weekly: { used_percent: 55, resets_at_ms: weeklyResetMs },
        },
      },
      NOW,
    );
    assert.equal(quota.status, 'ok');
    assert.equal(quota.plan, 'pro');
    assert.equal(quota.observedAt, new Date(observedMs).toISOString());
    assert.deepEqual(quota.windows, [
      {
        kind: 'five_hour',
        usedPercent: 8,
        resetsAt: new Date(fiveHourResetMs).toISOString(),
        windowMinutes: 240,
        note: null,
      },
      {
        kind: 'weekly',
        usedPercent: 55,
        resetsAt: new Date(weeklyResetMs).toISOString(),
        windowMinutes: 10080,
        note: null,
      },
    ]);
  });

  it('produces only a weekly window when the five-hour window is absent', () => {
    const weeklyResetMs = Date.UTC(2026, 10, 18, 0, 0);
    const quota = parseMuseUsage(
      { allowance: { weekly: { usedPercent: 3, resetsAtMs: weeklyResetMs } } },
      NOW,
    );
    assert.equal(quota.status, 'ok');
    assert.equal(quota.plan, null);
    assert.equal(quota.observedAt, NOW.toISOString());
    assert.deepEqual(quota.windows, [
      {
        kind: 'weekly',
        usedPercent: 3,
        resetsAt: new Date(weeklyResetMs).toISOString(),
        windowMinutes: 10080,
        note: null,
      },
    ]);
  });

  it('preserves used percent values above 100', () => {
    const quota = parseMuseUsage(
      { allowance: { window: { usedPercent: 130, windowDurationMins: 300 } } },
      NOW,
    );
    assert.equal(quota.windows[0]?.usedPercent, 130);
  });

  it('sets windowMinutes to null when the stated duration is not a positive finite number', () => {
    for (const bad of [0, -5, '300', null, Number.NaN]) {
      const quota = parseMuseUsage(
        { allowance: { window: { usedPercent: 10, windowDurationMins: bad } } },
        NOW,
      );
      assert.equal(quota.windows[0]?.windowMinutes, null, `duration ${String(bad)}`);
    }
  });

  it('reports an error for a body that is not an object', () => {
    for (const body of [null, 'x', 42, [], undefined]) {
      const quota = parseMuseUsage(body, NOW);
      assert.equal(quota.status, 'error');
      assert.deepEqual(quota.windows, []);
      assert.equal(quota.plan, null);
      assert.equal(quota.message, 'unexpected output from `muse usage --json`');
    }
  });

  it('collapses whitespace and truncates a long hint to 160 characters', () => {
    const longHint = `  first line\n\n${'word '.repeat(80)}tail  `;
    const quota = parseMuseUsage({ allowance: null, hint: longHint }, NOW);
    assert.equal(quota.status, 'no_data');
    assert.ok(quota.message !== null);
    assert.equal(quota.message.length, 160);
    assert.ok(quota.message.startsWith('first line word word'));
    assert.ok(!/\s{2}|\n/.test(quota.message));
  });

  it('reports no_data when the allowance has no window at all', () => {
    const quota = parseMuseUsage({ allowance: { tier: 'max' } }, NOW);
    assert.equal(quota.status, 'no_data');
    assert.deepEqual(quota.windows, []);
    assert.equal(quota.plan, 'max');
    assert.equal(quota.message, 'muse reported an allowance without any window');
  });
});

describe('parseMuseUsage epoch handling', () => {
  it('treats epoch-ms values <= 0 as missing', () => {
    const quota = parseMuseUsage(
      {
        allowance: {
          observedAtMs: 0,
          window: { usedPercent: 5, windowDurationMins: 300, resetsAtMs: -1 },
          weekly: { usedPercent: 6, resets_at_ms: 0 },
        },
      },
      NOW,
    );
    assert.equal(quota.observedAt, NOW.toISOString());
    assert.equal(quota.windows[0]?.resetsAt, null);
    assert.equal(quota.windows[1]?.resetsAt, null);
  });
});

describe('extractMuseJson', () => {
  const json = '{"schemaVersion":1,"allowance":null,"hint":"x"}';

  it('parses clean JSON stdout', () => {
    assert.deepEqual(extractMuseJson(`${json}\n`), { schemaVersion: 1, allowance: null, hint: 'x' });
  });

  it('skips a leading update notice', () => {
    assert.deepEqual(extractMuseJson(`Update available: run muse update\n${json}\n`), {
      schemaVersion: 1,
      allowance: null,
      hint: 'x',
    });
  });

  it('ignores notice lines that contain braces before and after the JSON', () => {
    const stdout = `Update available {v2}\n${json}\nsee {docs} later\n`;
    assert.deepEqual(extractMuseJson(stdout), { schemaVersion: 1, allowance: null, hint: 'x' });
  });

  it('parses pretty-printed multi-line JSON as the whole stdout', () => {
    const pretty = JSON.stringify({ schemaVersion: 1, allowance: null, hint: 'y' }, null, 2);
    assert.deepEqual(extractMuseJson(pretty), { schemaVersion: 1, allowance: null, hint: 'y' });
  });

  it('returns undefined when no JSON object is present', () => {
    assert.equal(extractMuseJson('muse is starting up\nnothing to see'), undefined);
    assert.equal(extractMuseJson(''), undefined);
    assert.equal(extractMuseJson('{not json}\n'), undefined);
  });
});

describe('classifyMuseFailure', () => {
  it('does not treat "author" as an auth failure', () => {
    assert.deepEqual(classifyMuseFailure(1, 'error: author field missing'), {
      status: 'error',
      message: '`muse usage` failed (exit 1)',
    });
  });

  it('classifies "please log in" as auth', () => {
    assert.deepEqual(classifyMuseFailure(1, 'Error: please log in first'), {
      status: 'auth',
      message: 'muse login problem: run `muse` and sign in',
    });
  });

  it('classifies "Unauthorized" as auth', () => {
    assert.equal(classifyMuseFailure(2, 'HTTP 401 Unauthorized').status, 'auth');
  });

  it('reports a plain failure with the exit code', () => {
    assert.deepEqual(classifyMuseFailure(3, 'boom'), {
      status: 'error',
      message: '`muse usage` failed (exit 3)',
    });
  });

  it('reports unknown exit when no exit code is available', () => {
    assert.equal(classifyMuseFailure(null, '').message, '`muse usage` failed (exit unknown)');
  });
});

describe('parseMuseUsage real populated payload', () => {
  it('parses the observed populated payload verbatim', () => {
    const body = JSON.parse(
      '{"schemaVersion":1,"allowance":{"tier":"Muse Code Power Usage","window":{"usedPercent":0,"resetsAtMs":1794599539000},"weekly":{"usedPercent":42,"resetsAtMs":1794787200000},"asOfMs":1794581601798,"source":"mint"},"reason":null,"hint":null}',
    ) as unknown;
    const quota = parseMuseUsage(body, NOW);
    assert.equal(quota.status, 'ok');
    assert.equal(quota.plan, 'Muse Code Power Usage');
    assert.equal(quota.observedAt, '2026-11-13T14:53:21.798Z');
    assert.equal(quota.message, null);
    assert.deepEqual(quota.windows, [
      {
        kind: 'five_hour',
        usedPercent: 0,
        resetsAt: '2026-11-13T19:52:19.000Z',
        windowMinutes: null,
        note: null,
      },
      {
        kind: 'weekly',
        usedPercent: 42,
        resetsAt: '2026-11-16T00:00:00.000Z',
        windowMinutes: 10080,
        note: null,
      },
    ]);
  });
});

function quotaWith(status: QuotaStatus): ProviderQuota {
  return {
    provider: 'muse',
    status,
    plan: null,
    windows: [],
    source: 'live',
    observedAt: NOW.toISOString(),
    message: null,
  };
}

interface FakeRun {
  results: QuotaStatus[];
  /** Milliseconds the fake clock advances during each runUsage call. */
  runCostMs?: number;
}

function fakeHarness(timeoutMs: number, run: FakeRun) {
  let clock = 0;
  const runTimeouts: number[] = [];
  const sleeps: number[] = [];
  let next = 0;
  const deps = {
    runUsage: async (t: number): Promise<ProviderQuota> => {
      runTimeouts.push(t);
      clock += run.runCostMs ?? 0;
      const status = run.results[Math.min(next, run.results.length - 1)] ?? 'error';
      next += 1;
      return quotaWith(status);
    },
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      clock += ms;
    },
    nowMs: (): number => clock,
  };
  const options = { timeoutMs, now: () => NOW, homeDir: '' };
  return { options, deps, runTimeouts, sleeps };
}

describe('fetchMuseQuotaWith retry', () => {
  it('retries no_data once and returns the later ok result after one 2000 ms sleep', async () => {
    const h = fakeHarness(15000, { results: ['no_data', 'ok'] });
    const quota = await fetchMuseQuotaWith(h.options, h.deps);
    assert.equal(quota.status, 'ok');
    assert.equal(h.runTimeouts.length, 2);
    assert.deepEqual(h.sleeps, [2000]);
  });

  it('does not retry or sleep when the first result is ok', async () => {
    const h = fakeHarness(15000, { results: ['ok'] });
    const quota = await fetchMuseQuotaWith(h.options, h.deps);
    assert.equal(quota.status, 'ok');
    assert.equal(h.runTimeouts.length, 1);
    assert.deepEqual(h.sleeps, []);
  });

  it('makes at most three attempts and returns the last no_data', async () => {
    const h = fakeHarness(15000, { results: ['no_data', 'no_data', 'no_data', 'ok'] });
    const quota = await fetchMuseQuotaWith(h.options, h.deps);
    assert.equal(quota.status, 'no_data');
    assert.equal(h.runTimeouts.length, 3);
    assert.deepEqual(h.sleeps, [2000, 2000]);
  });

  it('does not retry an error result', async () => {
    const h = fakeHarness(15000, { results: ['error', 'ok'] });
    const quota = await fetchMuseQuotaWith(h.options, h.deps);
    assert.equal(quota.status, 'error');
    assert.equal(h.runTimeouts.length, 1);
    assert.deepEqual(h.sleeps, []);
  });

  it('does not retry an auth result', async () => {
    const h = fakeHarness(15000, { results: ['auth', 'ok'] });
    const quota = await fetchMuseQuotaWith(h.options, h.deps);
    assert.equal(quota.status, 'auth');
    assert.equal(h.runTimeouts.length, 1);
    assert.deepEqual(h.sleeps, []);
  });

  it('does not start a retry when the budget after the wait is below 3000 ms', async () => {
    // First attempt costs 1000 ms: 4000 ms left, minus the 2000 ms wait leaves 2000 ms (< 3000).
    const h = fakeHarness(5000, { results: ['no_data', 'ok'], runCostMs: 1000 });
    const quota = await fetchMuseQuotaWith(h.options, h.deps);
    assert.equal(quota.status, 'no_data');
    assert.equal(h.runTimeouts.length, 1);
    assert.deepEqual(h.sleeps, []);
  });

  it('gives each attempt the remaining overall budget as its timeout', async () => {
    // First attempt costs 500 ms, the 2000 ms wait follows: second attempt gets 12500 ms.
    const h = fakeHarness(15000, { results: ['no_data', 'ok'], runCostMs: 500 });
    const quota = await fetchMuseQuotaWith(h.options, h.deps);
    assert.equal(quota.status, 'ok');
    assert.deepEqual(h.runTimeouts, [15000, 14500 - 2000]);
    assert.deepEqual(h.sleeps, [2000]);
  });
});
