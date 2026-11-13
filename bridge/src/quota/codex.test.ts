import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isCodexAuthError, parseCodexRateLimits, readLatestCodexRateLimits } from './codex.js';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const OBSERVED = '2026-11-13T11:59:00.000Z';
const FUTURE_SECONDS = Math.floor(Date.parse('2026-11-20T00:00:00.000Z') / 1000);
const PAST_SECONDS = Math.floor(Date.parse('2026-11-10T00:00:00.000Z') / 1000);
const FUTURE_ISO = '2026-11-20T00:00:00.000Z';
const PAST_ISO = '2026-11-10T00:00:00.000Z';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-quota-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('parseCodexRateLimits', () => {
  it('reads a camelCase weekly-only live result', () => {
    const quota = parseCodexRateLimits(
      {
        limitId: 'codex',
        primary: { usedPercent: 92, windowDurationMins: 10080, resetsAt: FUTURE_SECONDS },
        secondary: null,
        credits: { hasCredits: false },
        planType: 'pro',
        rateLimitReachedType: null,
      },
      'live',
      OBSERVED,
      NOW,
    );
    assert.deepEqual(quota, {
      provider: 'codex',
      status: 'ok',
      plan: 'pro',
      windows: [
        { kind: 'weekly', usedPercent: 92, resetsAt: FUTURE_ISO, windowMinutes: 10080, note: null },
      ],
      source: 'live',
      observedAt: OBSERVED,
      message: null,
    });
  });

  it('reads snake_case cached rollout keys', () => {
    const quota = parseCodexRateLimits(
      {
        limit_id: 'codex',
        primary: { used_percent: 40, window_minutes: 10080, resets_at: FUTURE_SECONDS },
        secondary: null,
        plan_type: 'plus',
      },
      'cached',
      OBSERVED,
      NOW,
    );
    assert.equal(quota.status, 'ok');
    assert.equal(quota.plan, 'plus');
    assert.equal(quota.source, 'cached');
    assert.deepEqual(quota.windows, [
      { kind: 'weekly', usedPercent: 40, resetsAt: FUTURE_ISO, windowMinutes: 10080, note: null },
    ]);
  });

  it('keeps both windows when primary is 300 minutes and secondary is 10080', () => {
    const quota = parseCodexRateLimits(
      {
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: FUTURE_SECONDS },
        secondary: { usedPercent: 55, windowDurationMins: 10080, resetsAt: FUTURE_SECONDS },
        planType: 'pro',
      },
      'live',
      OBSERVED,
      NOW,
    );
    assert.equal(quota.status, 'ok');
    assert.deepEqual(
      quota.windows.map((w) => [w.kind, w.usedPercent, w.windowMinutes]),
      [
        ['five_hour', 10, 300],
        ['weekly', 55, 10080],
      ],
    );
  });

  it('chooses kind by minutes when primary is the weekly window', () => {
    const quota = parseCodexRateLimits(
      {
        primary: { usedPercent: 70, windowDurationMins: 10080, resetsAt: FUTURE_SECONDS },
        secondary: { usedPercent: 5, windowDurationMins: 300, resetsAt: FUTURE_SECONDS },
      },
      'live',
      OBSERVED,
      NOW,
    );
    assert.deepEqual(
      quota.windows.map((w) => [w.kind, w.usedPercent]),
      [
        ['weekly', 70],
        ['five_hour', 5],
      ],
    );
  });

  it('uses positional defaults when minutes are missing', () => {
    const quota = parseCodexRateLimits(
      {
        primary: { usedPercent: 20, resetsAt: FUTURE_SECONDS },
        secondary: { usedPercent: 30, resetsAt: FUTURE_SECONDS },
      },
      'live',
      OBSERVED,
      NOW,
    );
    assert.deepEqual(
      quota.windows.map((w) => [w.kind, w.usedPercent, w.windowMinutes]),
      [
        ['five_hour', 20, null],
        ['weekly', 30, null],
      ],
    );
  });

  it('keeps the first window when two windows map to the same kind', () => {
    const quota = parseCodexRateLimits(
      {
        primary: { usedPercent: 11, windowDurationMins: 10080, resetsAt: FUTURE_SECONDS },
        secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: FUTURE_SECONDS },
      },
      'live',
      OBSERVED,
      NOW,
    );
    assert.deepEqual(quota.windows.map((w) => [w.kind, w.usedPercent]), [['weekly', 11]]);
  });

  it('nulls usedPercent and adds a note for a cached window whose reset has passed', () => {
    const quota = parseCodexRateLimits(
      {
        primary: { usedPercent: 92, windowDurationMins: 10080, resetsAt: PAST_SECONDS },
        secondary: null,
        planType: 'pro',
      },
      'cached',
      OBSERVED,
      NOW,
    );
    assert.equal(quota.status, 'ok');
    assert.deepEqual(quota.windows, [
      {
        kind: 'weekly',
        usedPercent: null,
        resetsAt: PAST_ISO,
        windowMinutes: 10080,
        note: 'reset since last Codex turn',
      },
    ]);
  });

  it('keeps the number for a live window whose reset time has passed', () => {
    const quota = parseCodexRateLimits(
      {
        primary: { usedPercent: 92, windowDurationMins: 10080, resetsAt: PAST_SECONDS },
      },
      'live',
      OBSERVED,
      NOW,
    );
    assert.deepEqual(quota.windows, [
      { kind: 'weekly', usedPercent: 92, resetsAt: PAST_ISO, windowMinutes: 10080, note: null },
    ]);
  });

  it('reports no_data when every window is null', () => {
    const quota = parseCodexRateLimits(
      { primary: null, secondary: null, planType: 'pro' },
      'live',
      OBSERVED,
      NOW,
    );
    assert.deepEqual(quota, {
      provider: 'codex',
      status: 'no_data',
      plan: 'pro',
      windows: [],
      source: 'live',
      observedAt: OBSERVED,
      message: 'Codex reported no rate-limit windows',
    });
  });

  it('reports error for non-object input', () => {
    for (const input of [null, undefined, 42, 'weekly', ['primary']]) {
      const quota = parseCodexRateLimits(input, 'cached', OBSERVED, NOW);
      assert.equal(quota.status, 'error');
      assert.equal(quota.provider, 'codex');
      assert.deepEqual(quota.windows, []);
      assert.equal(quota.message, 'unexpected rate-limit data from Codex');
    }
  });

  it('leaves resetsAt and usedPercent null when the values are missing or not finite', () => {
    const quota = parseCodexRateLimits(
      {
        primary: { usedPercent: 'lots', windowDurationMins: 10080, resetsAt: 'soon' },
      },
      'live',
      OBSERVED,
      NOW,
    );
    assert.deepEqual(quota.windows, [
      { kind: 'weekly', usedPercent: null, resetsAt: null, windowMinutes: 10080, note: null },
    ]);
  });
});

describe('isCodexAuthError', () => {
  it('matches each login/credential phrase', () => {
    const positives = [
      'not logged in',
      'You are logged out',
      'please log in',
      'run codex login',
      'sign in required',
      'user signed out',
      'unauthorized',
      'request unauthorised',
      'unauthenticated request',
      'authentication required',
      'HTTP 401',
      'missing credential',
      'bad credentials',
      'token expired',
      'expired token',
    ];
    for (const text of positives) {
      assert.equal(isCodexAuthError(text), true, text);
    }
  });

  it('does not match "author" or "authority"', () => {
    assert.equal(isCodexAuthError('author of the change is unknown'), false);
    assert.equal(isCodexAuthError('authority check failed'), false);
  });
});

describe('readLatestCodexRateLimits', () => {
  const rollout = (ts: string, rateLimits: unknown): string =>
    JSON.stringify({
      timestamp: ts,
      type: 'event_msg',
      payload: { type: 'token_count', rate_limits: rateLimits },
    });

  it('returns null when the sessions directory does not exist', async () => {
    assert.equal(await readLatestCodexRateLimits(join(root, 'no-such-dir')), null);
  });

  it('takes the last non-null token_count from the newest rollout file', async () => {
    const sessions = join(root, 'case-newest', 'sessions');
    const oldDir = join(sessions, '2026', '11', '10');
    const newDir = join(sessions, '2026', '11', '12');
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });

    const older = { primary: { used_percent: 5, window_minutes: 10080, resets_at: FUTURE_SECONDS } };
    const newer = { primary: { used_percent: 61, window_minutes: 10080, resets_at: FUTURE_SECONDS } };
    await writeFile(
      join(oldDir, 'rollout-2026-11-10T08-00-00-aaa.jsonl'),
      [rollout('2026-11-10T08:05:00.000Z', older)].join('\n') + '\n',
    );
    await writeFile(
      join(newDir, 'rollout-2026-11-12T08-00-00-bbb.jsonl'),
      [
        JSON.stringify({ timestamp: '2026-11-12T08:00:00.000Z', type: 'session_meta', payload: {} }),
        rollout('2026-11-12T09:00:00.000Z', newer),
        rollout('2026-11-12T09:30:00.000Z', null),
        JSON.stringify({ timestamp: '2026-11-12T09:31:00.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
        'not json at all',
      ].join('\n') + '\n',
    );

    const hit = await readLatestCodexRateLimits(sessions);
    assert.deepEqual(hit, { rateLimits: newer, observedAt: '2026-11-12T09:00:00.000Z' });
  });

  it('uses the file mtime when the event has no timestamp', async () => {
    const sessions = join(root, 'case-mtime', 'sessions');
    const dir = join(sessions, '2026', '11', '13');
    await mkdir(dir, { recursive: true });
    const limits = { primary: { used_percent: 3, window_minutes: 300, resets_at: FUTURE_SECONDS } };
    await writeFile(
      join(dir, 'rollout-2026-11-13T10-00-00-ccc.jsonl'),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: limits } }) + '\n',
    );

    const hit = await readLatestCodexRateLimits(sessions);
    assert.ok(hit);
    assert.deepEqual(hit.rateLimits, limits);
    assert.ok(!Number.isNaN(Date.parse(hit.observedAt)));
  });

  it('returns null when no rollout has non-null rate_limits', async () => {
    const sessions = join(root, 'case-empty', 'sessions');
    const dir = join(sessions, '2026', '11', '13');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'rollout-2026-11-13T10-00-00-ddd.jsonl'),
      rollout('2026-11-13T10:00:00.000Z', null) + '\n',
    );
    assert.equal(await readLatestCodexRateLimits(sessions), null);
  });
});
