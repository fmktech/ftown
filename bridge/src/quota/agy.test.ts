import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGY_QUOTA_POOLS,
  agyPoolForModel,
  agyQuotaPool,
  agyWindowsForModel,
  fetchAgyQuota,
  parseAgyUsage,
  resolveAgyBinary,
} from './agy.js';

const NOW = new Date('2026-11-13T10:00:00.000Z');
const NOT_FOUND = 'agy CLI not found';
const UNEXPECTED = 'unexpected output from `agy -p /usage`';
const NO_BUCKETS = 'agy reported no usage buckets';
const TURN = 'agy ran a model turn for /usage (unexpected)';
const AUTH = 'agy login problem: run `agy` and sign in';

/** Writes an executable file at `path`, creating parent directories. */
async function writeExecutable(path: string, body = '#!/bin/sh\n'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body);
  await chmod(path, 0o755);
}

/** Real `/usage` excerpt (groups/buckets exactly as given by the CLI), with the envelope fields. */
function usageBody(groups: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'SUCCESS',
    num_turns: 0,
    command: { name: 'usage', data: { groups } },
    ...extra,
  };
}

const EXCERPT_GROUPS = [
  {
    name: 'Gemini Models',
    buckets: [
      { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-20T15:32:11Z' },
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: '2026-11-13T20:32:11Z' },
    ],
  },
  {
    name: 'Claude and GPT models',
    buckets: [
      { id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-20T15:32:11Z' },
      { id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: '2026-11-13T20:32:11Z' },
    ],
  },
  {
    name: 'Gemini 4 Argon',
    buckets: [
      {
        id: 'gemini-argon-wtu-weekly',
        name: 'Gemini 4 Argon Weekly Limit',
        window: 'weekly',
        remaining_fraction: 0.9898666739463806,
        reset_time: '2026-11-20T14:59:57Z',
      },
    ],
  },
];

function singleBucket(bucket: Record<string, unknown>, groupName = 'Only Group'): Record<string, unknown> {
  return { name: groupName, buckets: [{ id: 'b', ...bucket }] };
}

describe('parseAgyUsage', () => {
  it('maps the real excerpt: first group wins a tie at 0%, weekly tightest is Argon at 1%', () => {
    const quota = parseAgyUsage(usageBody(EXCERPT_GROUPS), NOW.toISOString());
    assert.equal(quota.provider, 'agy');
    assert.equal(quota.status, 'ok');
    assert.equal(quota.plan, null);
    assert.equal(quota.source, 'live');
    assert.equal(quota.observedAt, NOW.toISOString());
    assert.equal(quota.message, null);
    assert.deepEqual(quota.windows, [
      {
        kind: 'five_hour',
        usedPercent: 0,
        resetsAt: '2026-11-13T20:32:11.000Z',
        windowMinutes: 300,
        note: 'tightest: Gemini Models',
      },
      {
        kind: 'weekly',
        usedPercent: 1,
        resetsAt: '2026-11-20T14:59:57.000Z',
        windowMinutes: 10080,
        note: 'tightest: Gemini 4 Argon',
      },
    ]);
    assert.deepEqual(quota.scopedLimits, [
      { scope: 'Gemini Models', kind: 'weekly', usedPercent: 0, resetsAt: '2026-11-20T15:32:11.000Z' },
      { scope: 'Gemini Models', kind: 'five_hour', usedPercent: 0, resetsAt: '2026-11-13T20:32:11.000Z' },
      { scope: 'Claude and GPT models', kind: 'weekly', usedPercent: 0, resetsAt: '2026-11-20T15:32:11.000Z' },
      { scope: 'Claude and GPT models', kind: 'five_hour', usedPercent: 0, resetsAt: '2026-11-13T20:32:11.000Z' },
      { scope: 'Gemini 4 Argon', kind: 'weekly', usedPercent: 1, resetsAt: '2026-11-20T14:59:57.000Z' },
    ]);
  });

  it('maps remaining_fraction 0 to 100% used', () => {
    const quota = parseAgyUsage(usageBody([singleBucket({ window: '5h', remaining_fraction: 0 })]), NOW.toISOString());
    assert.equal(quota.windows[0].usedPercent, 100);
    assert.equal(quota.status, 'ok');
  });

  it('clamps remaining_fraction above 1 to 0% used', () => {
    const quota = parseAgyUsage(usageBody([singleBucket({ window: 'weekly', remaining_fraction: 1.2 })]), NOW.toISOString());
    assert.equal(quota.windows[0].usedPercent, 0);
  });

  it('gives null usedPercent when remaining_fraction is missing, and no_data when nothing is numeric', () => {
    const quota = parseAgyUsage(usageBody([singleBucket({ window: '5h' })]), NOW.toISOString());
    assert.equal(quota.windows[0].usedPercent, null);
    assert.equal(quota.status, 'no_data');
    assert.equal(quota.message, NO_BUCKETS);
    assert.deepEqual(quota.scopedLimits, [{ scope: 'Only Group', kind: 'five_hour', usedPercent: null, resetsAt: null }]);
  });

  it('ignores buckets whose window is not 5h or weekly', () => {
    const quota = parseAgyUsage(usageBody([singleBucket({ window: 'monthly', remaining_fraction: 0.5 })]), NOW.toISOString());
    assert.deepEqual(quota.windows, []);
    assert.equal(quota.status, 'no_data');
    assert.equal(quota.message, NO_BUCKETS);
    assert.equal('scopedLimits' in quota, false);
  });

  it('sets note to null when only one group carries a bucket of that kind', () => {
    const quota = parseAgyUsage(
      usageBody([singleBucket({ window: 'weekly', remaining_fraction: 0.5, reset_time: '2026-11-20T15:00:00Z' })]),
      NOW.toISOString(),
    );
    assert.equal(quota.windows[0].note, null);
    assert.equal(quota.windows[0].usedPercent, 50);
  });

  it('keeps the first bucket when two groups tie on usage', () => {
    const quota = parseAgyUsage(
      usageBody([
        singleBucket({ window: 'weekly', remaining_fraction: 0.5 }, 'First'),
        singleBucket({ window: 'weekly', remaining_fraction: 0.5 }, 'Second'),
      ]),
      NOW.toISOString(),
    );
    assert.equal(quota.windows[0].note, 'tightest: First');
  });

  it('gives null resetsAt for a missing or invalid reset_time', () => {
    const quota = parseAgyUsage(
      usageBody([singleBucket({ window: '5h', remaining_fraction: 0.8, reset_time: 'not-a-date' })]),
      NOW.toISOString(),
    );
    assert.equal(quota.windows[0].resetsAt, null);
    assert.equal(quota.scopedLimits?.[0].resetsAt, null);
  });

  it('returns no_data with the buckets message when there are no groups', () => {
    const quota = parseAgyUsage(usageBody([]), NOW.toISOString());
    assert.equal(quota.status, 'no_data');
    assert.equal(quota.message, NO_BUCKETS);
    assert.deepEqual(quota.windows, []);
    assert.equal('scopedLimits' in quota, false);
  });

  it('returns error when status is not SUCCESS', () => {
    const quota = parseAgyUsage(usageBody(EXCERPT_GROUPS, { status: 'FAILURE' }), NOW.toISOString());
    assert.equal(quota.status, 'error');
    assert.equal(quota.message, UNEXPECTED);
  });

  it('returns error when the body is not an object or groups is not an array', () => {
    assert.equal(parseAgyUsage(null, NOW.toISOString()).status, 'error');
    assert.equal(parseAgyUsage('text', NOW.toISOString()).message, UNEXPECTED);
    const noGroups = { status: 'SUCCESS', command: { name: 'usage', data: { groups: 'nope' } } };
    assert.equal(parseAgyUsage(noGroups, NOW.toISOString()).status, 'error');
  });

  it('still parses but flags the message when num_turns is above 0', () => {
    const quota = parseAgyUsage(usageBody(EXCERPT_GROUPS, { num_turns: 1 }), NOW.toISOString());
    assert.equal(quota.status, 'ok');
    assert.equal(quota.message, TURN);
    assert.equal(quota.windows.length, 2);
  });
});

describe('resolveAgyBinary and fetchAgyQuota', () => {
  const originalPath = process.env.PATH;
  let root: string;
  let homeDir: string;
  let emptyPathDir: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'agy-quota-test-'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    homeDir = await mkdtemp(join(root, 'home-'));
    emptyPathDir = await mkdtemp(join(root, 'path-'));
    process.env.PATH = emptyPathDir;
  });

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  });

  it('resolveAgyBinary returns the home path when it is an executable file', async () => {
    const homeBin = join(homeDir, '.local', 'bin', 'agy');
    await writeExecutable(homeBin);
    assert.equal(await resolveAgyBinary(homeDir, process.env.PATH), homeBin);
  });

  it('resolveAgyBinary prefers the home path over a PATH match', async () => {
    const homeBin = join(homeDir, '.local', 'bin', 'agy');
    await writeExecutable(homeBin);
    await writeExecutable(join(emptyPathDir, 'agy'));
    assert.equal(await resolveAgyBinary(homeDir, process.env.PATH), homeBin);
  });

  it('resolveAgyBinary returns the PATH match when only PATH has agy', async () => {
    const pathBin = join(emptyPathDir, 'agy');
    await writeExecutable(pathBin);
    assert.equal(await resolveAgyBinary(homeDir, process.env.PATH), pathBin);
  });

  it('resolveAgyBinary ignores a directory named agy', async () => {
    await mkdir(join(homeDir, '.local', 'bin', 'agy'), { recursive: true });
    await mkdir(join(emptyPathDir, 'agy'));
    assert.equal(await resolveAgyBinary(homeDir, process.env.PATH), null);
  });

  it('resolveAgyBinary ignores a non-executable file', async () => {
    await mkdir(join(homeDir, '.local', 'bin'), { recursive: true });
    await writeFile(join(homeDir, '.local', 'bin', 'agy'), '#!/bin/sh\n');
    await chmod(join(homeDir, '.local', 'bin', 'agy'), 0o644);
    assert.equal(await resolveAgyBinary(homeDir, process.env.PATH), null);
  });

  it('resolveAgyBinary skips the home candidate when homeDir is empty', async () => {
    await writeExecutable(join(homeDir, '.local', 'bin', 'agy'));
    assert.equal(await resolveAgyBinary('', process.env.PATH), null);
  });

  it('resolveAgyBinary returns null when agy is nowhere', async () => {
    assert.equal(await resolveAgyBinary(homeDir, process.env.PATH), null);
    assert.equal(await resolveAgyBinary(homeDir, undefined), null);
  });

  it('resolveAgyBinary skips empty and relative PATH entries', async () => {
    await writeExecutable(join(emptyPathDir, 'agy'));
    const relative = `relative-dir:${emptyPathDir}`;
    assert.equal(await resolveAgyBinary('', relative), join(emptyPathDir, 'agy'));
    assert.equal(await resolveAgyBinary('', `relative-dir:`), null);
  });

  it('fetchAgyQuota reports agy CLI not found when no binary exists', async () => {
    const quota = await fetchAgyQuota({ timeoutMs: 1000, now: () => NOW, homeDir });
    assert.deepEqual(quota, {
      provider: 'agy',
      status: 'unavailable',
      plan: null,
      windows: [],
      source: 'live',
      observedAt: NOW.toISOString(),
      message: NOT_FOUND,
    });
  });

  it('fetchAgyQuota parses the usage the fake agy prints and runs it in a removed scratch dir', async () => {
    const payloadPath = join(root, 'payload.json');
    const cwdFile = join(homeDir, 'cwd.txt');
    await writeFile(payloadPath, JSON.stringify(usageBody(EXCERPT_GROUPS)));
    await writeExecutable(
      join(homeDir, '.local', 'bin', 'agy'),
      `#!/bin/sh\npwd > '${cwdFile}'\n/bin/cat '${payloadPath}'\n`,
    );

    const quota = await fetchAgyQuota({ timeoutMs: 5000, now: () => NOW, homeDir });
    assert.equal(quota.message, null);
    assert.equal(quota.status, 'ok');
    assert.equal(quota.windows.length, 2);
    assert.equal(quota.scopedLimits?.length, 5);

    const cwd = (await readFile(cwdFile, 'utf8')).trim();
    assert.notEqual(cwd, homeDir);
    assert.equal(existsSync(cwd), false, 'scratch directory should be removed');
  });

  it('fetchAgyQuota reports auth when the fake agy exits 1 with a sign-in message on stderr', async () => {
    await writeExecutable(join(homeDir, '.local', 'bin', 'agy'), '#!/bin/sh\necho "please sign in" >&2\nexit 1\n');
    const quota = await fetchAgyQuota({ timeoutMs: 5000, now: () => NOW, homeDir });
    assert.equal(quota.status, 'auth');
    assert.equal(quota.message, AUTH);
  });

  it('fetchAgyQuota reports an error with the exit code when the fake agy exits 3', async () => {
    await writeExecutable(join(homeDir, '.local', 'bin', 'agy'), '#!/bin/sh\nexit 3\n');
    const quota = await fetchAgyQuota({ timeoutMs: 5000, now: () => NOW, homeDir });
    assert.equal(quota.status, 'error');
    assert.equal(quota.message, '`agy -p /usage` failed (exit 3)');
  });

  it('fetchAgyQuota reports unexpected output for garbage stdout without echoing it', async () => {
    await writeExecutable(join(homeDir, '.local', 'bin', 'agy'), '#!/bin/sh\necho "GARBAGE-SECRET-TEXT"\n');
    const quota = await fetchAgyQuota({ timeoutMs: 5000, now: () => NOW, homeDir });
    assert.equal(quota.status, 'error');
    assert.equal(quota.message, UNEXPECTED);
    assert.equal(quota.message?.includes('GARBAGE'), false);
  });
});

describe('agyQuotaPool and agyWindowsForModel', () => {
  it('lists the three rate-limit pool names', () => {
    assert.deepEqual(AGY_QUOTA_POOLS, ['Gemini Models', 'Gemini 4 Argon', 'Claude and GPT models']);
    assert.equal(agyPoolForModel, agyQuotaPool);
  });

  it('maps gemini-4-argon* models to Gemini 4 Argon (case-insensitive)', () => {
    assert.equal(agyQuotaPool('gemini-4-argon-low'), 'Gemini 4 Argon');
    assert.equal(agyQuotaPool('gemini-4-argon-medium'), 'Gemini 4 Argon');
    assert.equal(agyQuotaPool('gemini-4-argon-high'), 'Gemini 4 Argon');
    assert.equal(agyQuotaPool('  GEMINI-4-ARGON-MEDIUM  '), 'Gemini 4 Argon');
  });

  it('maps models containing claude or gpt to Claude and GPT models', () => {
    assert.equal(agyQuotaPool('claude-opus-5-5-low'), 'Claude and GPT models');
    assert.equal(agyQuotaPool('claude-sonnet-5-5-high'), 'Claude and GPT models');
    assert.equal(agyQuotaPool('gpt-oss-120b-medium'), 'Claude and GPT models');
    assert.equal(agyQuotaPool('agy-claude-custom'), 'Claude and GPT models');
    assert.equal(agyQuotaPool('custom-gpt-5'), 'Claude and GPT models');
  });

  it('maps other gemini* models to Gemini Models', () => {
    assert.equal(agyQuotaPool('gemini-3.8-flash'), 'Gemini Models');
    assert.equal(agyQuotaPool('gemini-3.8-flash-high'), 'Gemini Models');
    assert.equal(agyQuotaPool('gemini-4-hydrogen-high'), 'Gemini Models');
    assert.equal(agyQuotaPool('gemini-pro-orchestrator-g1-pro'), 'Gemini Models');
  });

  it('returns null for unknown or blank model ids', () => {
    assert.equal(agyQuotaPool(''), null);
    assert.equal(agyQuotaPool('   '), null);
    assert.equal(agyQuotaPool('mystery-model-x'), null);
    assert.equal(agyQuotaPool('llama-4-maverick'), null);
  });

  it('extracts per-pool windows when the three pools are at different levels, and falls back to tightest for unknown', () => {
    const quota = parseAgyUsage(
      usageBody([
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-5h', window: '5h', remaining_fraction: 0, reset_time: '2026-11-13T15:00:00Z' },
            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.4, reset_time: '2026-11-20T15:00:00Z' },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            { id: '3p-5h', window: '5h', remaining_fraction: 0.1, reset_time: '2026-11-13T16:00:00Z' },
            { id: '3p-weekly', window: 'weekly', remaining_fraction: 0.8, reset_time: '2026-11-20T16:00:00Z' },
          ],
        },
        {
          name: 'Gemini 4 Argon',
          buckets: [
            { id: 'argon-weekly', window: 'weekly', remaining_fraction: 0.99, reset_time: '2026-11-20T17:00:00Z' },
          ],
        },
      ]),
      NOW.toISOString(),
    );

    assert.deepEqual(agyWindowsForModel(quota, 'gemini-4-argon-medium'), [
      {
        kind: 'weekly',
        usedPercent: 1,
        resetsAt: '2026-11-20T17:00:00.000Z',
        windowMinutes: 10080,
        note: 'Gemini 4 Argon',
      },
    ]);

    assert.deepEqual(agyWindowsForModel(quota, 'claude-opus-5-5-high'), [
      {
        kind: 'five_hour',
        usedPercent: 90,
        resetsAt: '2026-11-13T16:00:00.000Z',
        windowMinutes: 300,
        note: 'Claude and GPT models',
      },
      {
        kind: 'weekly',
        usedPercent: 20,
        resetsAt: '2026-11-20T16:00:00.000Z',
        windowMinutes: 10080,
        note: 'Claude and GPT models',
      },
    ]);

    assert.deepEqual(agyWindowsForModel(quota, 'gemini-3.8-flash'), [
      {
        kind: 'five_hour',
        usedPercent: 100,
        resetsAt: '2026-11-13T15:00:00.000Z',
        windowMinutes: 300,
        note: 'Gemini Models',
      },
      {
        kind: 'weekly',
        usedPercent: 60,
        resetsAt: '2026-11-20T15:00:00.000Z',
        windowMinutes: 10080,
        note: 'Gemini Models',
      },
    ]);

    assert.deepEqual(agyWindowsForModel(quota, 'unknown-model'), quota.windows);
  });
});
