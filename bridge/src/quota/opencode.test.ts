import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { annotatePick } from './annotate.js';
import { fetchOpencodeQuota, opencodeRouteUnavailableMessage, parseOpencodeUsageLimits } from './opencode.js';
import { adviseQuotaRouting } from './routing.js';
import type { ProviderQuota, QuotaWindow } from './types.js';

const OBSERVED = '2026-11-13T10:00:00.000Z';
const NOW = new Date(OBSERVED);
const VERSION = 'v2.3.0';
const ROLLING_MS = 1794756990000;
const WEEKLY_MS = 1794787200000;
const MONTHLY_MS = 1796249677000;

const savedPath = process.env.PATH;
const opened: string[] = [];

// A shell script, not a node shebang: the fetcher tests clear PATH, so `env node` cannot run.
const FAKE_CLI = `#!/bin/sh
# Absolute paths: these tests clear PATH so the resolver cannot see a real opencode.
dir=$(/usr/bin/dirname "$0")
if [ "$1" = "--version" ]; then
  if [ -f "$dir/version-sleep-ms.txt" ]; then
    while :; do :; done
  fi
  if [ ! -f "$dir/version.txt" ]; then
    exit 1
  fi
  /bin/cat "$dir/version.txt"
  exit 0
fi
if [ -f "$dir/sleep-ms.txt" ]; then
  while :; do :; done
fi
if [ -f "$dir/stderr.txt" ]; then
  /bin/cat "$dir/stderr.txt" >&2
fi
if [ -f "$dir/stdout.txt" ]; then
  /bin/cat "$dir/stdout.txt"
fi
if [ -f "$dir/exit.txt" ]; then
  exit "$(/bin/cat "$dir/exit.txt")"
fi
exit 0
`;

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-quota-test-'));
  opened.push(dir);
  return dir;
}

afterEach(async () => {
  while (opened.length > 0) {
    const dir = opened.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
});

function envelope(data: unknown): unknown {
  return { location: { directory: '/tmp/work' }, data };
}

function goBody(go: unknown, budgets: unknown = []): unknown {
  return envelope({
    workspace: { name: 'Default', usageURL: 'https://example.invalid/usage' },
    go,
    budgets,
  });
}

function meters(overrides: { weeklyLimited?: boolean } = {}): unknown {
  return {
    rolling: { percent: 0, limited: false, resetsAt: ROLLING_MS },
    weekly: { percent: 13, limited: overrides.weeklyLimited === true, resetsAt: WEEKLY_MS },
    monthly: { percent: 6, limited: false, resetsAt: MONTHLY_MS },
  };
}

function windowOf(quota: ProviderQuota, kind: QuotaWindow['kind']): QuotaWindow {
  const found = quota.windows.find((window) => window.kind === kind);
  assert.ok(found, kind);
  return found;
}

describe('parseOpencodeUsageLimits', () => {
  it('maps rolling, weekly and monthly windows and drops the usage URL and budgets', () => {
    const quota = parseOpencodeUsageLimits(
      goBody(meters(), [{ limit: 10, spent: 1, scope: 'each' }]),
      OBSERVED,
      VERSION,
    );
    assert.equal(quota.status, 'ok');
    assert.equal(quota.plan, 'Go');
    assert.equal(quota.message, null);
    assert.equal(quota.provider, 'opencode');
    assert.deepEqual(
      quota.windows.map((window) => window.kind),
      ['five_hour', 'weekly', 'monthly'],
    );
    const rolling = windowOf(quota, 'five_hour');
    assert.equal(rolling.usedPercent, 0);
    assert.equal(rolling.limited, false);
    assert.equal(rolling.windowMinutes, null);
    assert.equal(rolling.resetsAt, new Date(ROLLING_MS).toISOString());
    const weekly = windowOf(quota, 'weekly');
    assert.equal(weekly.usedPercent, 13);
    assert.equal(weekly.windowMinutes, 10080);
    assert.equal(weekly.resetsAt, new Date(WEEKLY_MS).toISOString());
    const monthly = windowOf(quota, 'monthly');
    assert.equal(monthly.usedPercent, 6);
    assert.equal(monthly.windowMinutes, null);
    assert.equal(monthly.resetsAt, new Date(MONTHLY_MS).toISOString());
    assert.equal(quota.scopedLimits, undefined);
    const encoded = JSON.stringify(quota);
    assert.equal(encoded.includes('example.invalid'), false);
    assert.equal(encoded.includes('usageURL'), false);
    assert.equal(encoded.includes('spent'), false);
  });

  it('keeps the used percent when a window is limited', () => {
    const quota = parseOpencodeUsageLimits(goBody(meters({ weeklyLimited: true })), OBSERVED, VERSION);
    const weekly = windowOf(quota, 'weekly');
    assert.equal(weekly.limited, true);
    assert.equal(weekly.usedPercent, 13);
    assert.equal(quota.status, 'ok');
  });

  it('reports no Go subscription when the go block is missing or null', () => {
    const missing = envelope({ workspace: { name: 'Default' }, budgets: [] });
    for (const body of [missing, goBody(null)]) {
      const quota = parseOpencodeUsageLimits(body, OBSERVED, VERSION);
      assert.equal(quota.status, 'no_data');
      assert.equal(quota.plan, null);
      assert.equal(quota.message, 'opencode has no Go subscription');
      assert.deepEqual(quota.windows, []);
    }
  });

  it('reports no windows when go is present but every meter is absent', () => {
    const quota = parseOpencodeUsageLimits(goBody({}), OBSERVED, VERSION);
    assert.equal(quota.status, 'no_data');
    assert.equal(quota.plan, 'Go');
    assert.equal(quota.message, 'opencode reported a Go plan without usage windows');
  });

  it('reports auth when data is null', () => {
    const quota = parseOpencodeUsageLimits(envelope(null), OBSERVED, VERSION);
    assert.equal(quota.status, 'auth');
    assert.equal(quota.message, 'opencode is not signed in');
    assert.deepEqual(quota.windows, []);
  });

  it('reports the route unavailable for a malformed meter, a non-object, and a bad budgets field', () => {
    const expected = opencodeRouteUnavailableMessage(VERSION);
    const badMeter = goBody({ rolling: { percent: '13', limited: true, resetsAt: ROLLING_MS } });
    const badBudgets = envelope({ go: meters(), budgets: { spent: 1 } });
    for (const body of [badMeter, 'nope', [], { location: {} }, badBudgets]) {
      const quota = parseOpencodeUsageLimits(body, OBSERVED, VERSION);
      assert.equal(quota.status, 'error');
      assert.equal(quota.message, expected);
      assert.deepEqual(quota.windows, []);
    }
  });
});

async function installFakeCli(homeDir: string, files: Record<string, string>): Promise<void> {
  const binDir = join(homeDir, '.opencode', 'bin');
  await mkdir(binDir, { recursive: true });
  const binary = join(binDir, 'opencode');
  await writeFile(binary, FAKE_CLI);
  await chmod(binary, 0o755);
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(binDir, name), contents);
  }
}

async function fetchFrom(files: Record<string, string>, timeoutMs = 5000): Promise<ProviderQuota> {
  const homeDir = await tempDir();
  await installFakeCli(homeDir, files);
  process.env.PATH = await tempDir();
  return fetchOpencodeQuota({ timeoutMs, now: () => NOW, homeDir });
}

describe('fetchOpencodeQuota', () => {
  it('reports the CLI as not found when neither the bundled binary nor PATH has it', async () => {
    const homeDir = await tempDir();
    process.env.PATH = await tempDir();
    const quota = await fetchOpencodeQuota({ timeoutMs: 5000, now: () => NOW, homeDir });
    assert.equal(quota.status, 'unavailable');
    assert.equal(quota.message, 'opencode CLI not found');
    assert.deepEqual(quota.windows, []);
  });

  it('reads the usage route and does not probe the version on success', async () => {
    const started = Date.now();
    const quota = await fetchFrom({
      'stdout.txt': JSON.stringify(goBody(meters())),
      'version-sleep-ms.txt': '5000',
      'version.txt': 'opencode v2.3.0\n',
    });
    assert.ok(Date.now() - started < 1000);
    assert.equal(quota.status, 'ok');
    assert.equal(quota.plan, 'Go');
    assert.equal(windowOf(quota, 'weekly').usedPercent, 13);
  });

  it('names the opencode version when the route is missing or the body is not JSON', async () => {
    const missing = await fetchFrom({
      'exit.txt': '1',
      'stderr.txt': 'HTTP 404 Not Found\n',
      'version.txt': 'opencode v2.3.0\n',
    });
    const garbage = await fetchFrom({
      'stdout.txt': 'not json\n',
      'version.txt': 'opencode v2.3.0\n',
    });
    const expected = opencodeRouteUnavailableMessage('v2.3.0');
    assert.equal(missing.status, 'error');
    assert.equal(missing.message, expected);
    assert.equal(garbage.status, 'error');
    assert.equal(garbage.message, expected);
  });

  it('uses version unknown when the version command fails', async () => {
    const quota = await fetchFrom({
      'exit.txt': '1',
      'stderr.txt': 'HTTP 404 Not Found\n',
    });
    assert.equal(quota.message, opencodeRouteUnavailableMessage('unknown'));
  });

  it('reports a timeout separately from a missing route', async () => {
    const quota = await fetchFrom({ 'sleep-ms.txt': '5000', 'version.txt': 'opencode v2.3.0\n' }, 300);
    assert.equal(quota.status, 'error');
    assert.equal(quota.message, '`opencode api` timed out');
  });

  it('annotates an opencode pick as exhausted when a window is limited', async () => {
    const quota = parseOpencodeUsageLimits(goBody(meters({ weeklyLimited: true })), OBSERVED, VERSION);
    const routing = adviseQuotaRouting([quota], NOW);
    const annotated = annotatePick(
      { provider: 'opencode', model: 'opencode/model', effort: null },
      [quota],
      routing,
      [],
      NOW,
    );
    assert.equal(windowOf(quota, 'weekly').usedPercent, 13);
    assert.equal(annotated.availability, 'exhausted');
    assert.equal(annotated.leftPercent, 0);
    assert.equal(annotated.checked, false);
  });
});
