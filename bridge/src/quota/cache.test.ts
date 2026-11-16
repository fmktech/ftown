import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { collectQuotaReport, runQuota, type QuotaDeps } from '../quota-cli.js';
import { formatQuotaTable } from './format.js';
import {
  invalidateQuotaCacheEntry,
  isModelsRowFresh,
  isQuotaRowFresh,
  readQuotaCache,
  resolveQuotaCacheLockPath,
  resolveQuotaCachePath,
  QUOTA_CACHE_ERROR_TTL_MS,
  QUOTA_CACHE_TTL_MS,
} from './cache.js';
import { QUOTA_PROVIDER_IDS } from './types.js';
import type { ProviderModels, ProviderQuota, QuotaProviderId } from './types.js';

const START = new Date('2026-11-13T12:00:00.000Z');

function okQuota(provider: QuotaProviderId, observedAt: string, plan = 'pro'): ProviderQuota {
  return {
    provider,
    status: 'ok',
    plan,
    windows: [{ kind: 'five_hour', usedPercent: 10, resetsAt: null, windowMinutes: 300, note: null }],
    source: 'live',
    observedAt,
    message: null,
  };
}

function errorQuota(provider: QuotaProviderId, observedAt: string): ProviderQuota {
  return {
    provider,
    status: 'error',
    plan: null,
    windows: [],
    source: 'live',
    observedAt,
    message: `${provider} check failed: boom`,
  };
}

function okModels(provider: QuotaProviderId, observedAt: string): ProviderModels {
  return {
    provider,
    status: 'ok',
    models: [{ id: `${provider}-default`, name: null, isDefault: true, description: null, contextTokens: null, efforts: [], defaultEffort: null }],
    source: 'live',
    observedAt,
    message: null,
    modelFlag: '--model <id>',
    effortFlag: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface Harness {
  homeDir: string;
  clock: { t: number };
  quotaCalls: QuotaProviderId[];
  modelCalls: QuotaProviderId[];
  deps: QuotaDeps;
}

type QuotaBehavior = (provider: QuotaProviderId, callIndex: number, observedAt: string) => ProviderQuota | Promise<ProviderQuota>;
type ModelsBehavior = (provider: QuotaProviderId, callIndex: number, observedAt: string) => ProviderModels | Promise<ProviderModels>;

async function harness(
  t: { after: (fn: () => Promise<void>) => void },
  options: { quota?: QuotaBehavior; models?: ModelsBehavior; graceMs?: number; useRealFormat?: boolean } = {},
): Promise<Harness> {
  const homeDir = await mkdtemp(join(tmpdir(), 'quota-cache-'));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(homeDir, { recursive: true, force: true });
  });
  const clock = { t: START.getTime() };
  const quotaCalls: QuotaProviderId[] = [];
  const modelCalls: QuotaProviderId[] = [];
  const quotaCounts = new Map<QuotaProviderId, number>();
  const modelCounts = new Map<QuotaProviderId, number>();

  const fetchers = {} as QuotaDeps['fetchers'];
  const modelFetchers = {} as QuotaDeps['modelFetchers'];
  for (const provider of QUOTA_PROVIDER_IDS) {
    fetchers[provider] = async (opts) => {
      quotaCalls.push(provider);
      const index = quotaCounts.get(provider) ?? 0;
      quotaCounts.set(provider, index + 1);
      const observedAt = opts.now().toISOString();
      return options.quota ? options.quota(provider, index, observedAt) : okQuota(provider, observedAt);
    };
    modelFetchers[provider] = async (opts) => {
      modelCalls.push(provider);
      const index = modelCounts.get(provider) ?? 0;
      modelCounts.set(provider, index + 1);
      const observedAt = opts.now().toISOString();
      return options.models ? options.models(provider, index, observedAt) : okModels(provider, observedAt);
    };
  }

  const deps: QuotaDeps = {
    fetchers,
    modelFetchers,
    advise: rows => rows.map(row => ({
      provider: row.provider,
      availability: 'available' as const,
      leftPercent: 90,
      bindingWindow: 'five_hour' as const,
      resetsAt: null,
      resetsInMinutes: null,
      runway: null,
      reason: 'fake',
    })),
    format: options.useRealFormat ? formatQuotaTable : (rows => `TABLE(${rows.map(row => row.provider).join(',')})`),
    loadRouting: async () => ({ state: { status: 'missing', path: join(homeDir, '.ftown', 'model-routing.json'), errors: [] }, config: null }),
    annotate: () => [],
    now: () => new Date(clock.t),
    homeDir,
    graceMs: options.graceMs,
    cache: { lockPollMs: 10, staleLockMs: 100, lockWaitMs: 5000 },
  };
  return { homeDir, clock, quotaCalls, modelCalls, deps };
}

describe('quota cache freshness', () => {
  it('treats a future observedAt as expired and an old ok row as expired after the TTL', () => {
    const now = START.getTime();
    const row = okQuota('claude', START.toISOString());
    assert.equal(isQuotaRowFresh(row, now), true);
    assert.equal(isQuotaRowFresh(row, now + QUOTA_CACHE_TTL_MS - 1), true);
    assert.equal(isQuotaRowFresh(row, now + QUOTA_CACHE_TTL_MS), false);
    assert.equal(isQuotaRowFresh({ ...row, observedAt: new Date(now + 60_000).toISOString() }, now), false);
    const err = errorQuota('claude', START.toISOString());
    assert.equal(isQuotaRowFresh(err, now + QUOTA_CACHE_ERROR_TTL_MS - 1), true);
    assert.equal(isQuotaRowFresh(err, now + QUOTA_CACHE_ERROR_TTL_MS), false);
    const models = okModels('claude', START.toISOString());
    assert.equal(isModelsRowFresh(models, now + QUOTA_CACHE_TTL_MS - 1), true);
    assert.equal(isModelsRowFresh({ ...models, status: 'error' }, now + QUOTA_CACHE_ERROR_TTL_MS), false);
  });

  it('resolves the cache path under the given homeDir', async t => {
    const h = await harness(t);
    assert.equal(resolveQuotaCachePath(h.homeDir), join(h.homeDir, '.ftown', 'quota-cache.json'));
    assert.equal(resolveQuotaCachePath('relative/path'), '');
    assert.equal(resolveQuotaCacheLockPath(h.homeDir), `${join(h.homeDir, '.ftown', 'quota-cache.json')}.lock`);
  });
});

describe('quota cache via collectQuotaReport', () => {
  it('hit within TTL does no fetch and marks quota and models cached with the original observedAt', async t => {
    const h = await harness(t);
    const first = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: true }, h.deps);
    assert.deepEqual(h.quotaCalls, ['claude']);
    assert.deepEqual(h.modelCalls, ['claude']);
    assert.equal(first.report.providers[0].source, 'live');
    assert.equal(first.report.models[0].source, 'live');

    h.clock.t += 60_000;
    const second = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: true }, h.deps);
    assert.deepEqual(h.quotaCalls, ['claude']);
    assert.deepEqual(h.modelCalls, ['claude']);
    assert.equal(second.report.providers[0].source, 'cached');
    assert.equal(second.report.providers[0].observedAt, START.toISOString());
    assert.equal(second.report.models[0].source, 'cached');
    assert.equal(second.report.models[0].observedAt, START.toISOString());
  });

  it('keeps each registered account in an independent quota and model cache slot', async t => {
    const h = await harness(t);
    await mkdir(join(h.deps.homeDir, '.ftown'), { recursive: true });
    await writeFile(join(h.deps.homeDir, '.ftown', 'accounts.json'), JSON.stringify({ version: 1, accounts: [
      { id: 'second', harness: 'claude', configDir: join(h.deps.homeDir, 'claude-second') },
    ] }));
    const first = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: true }, h.deps);
    assert.deepEqual(first.report.providers.map(row => row.account), ['default', 'second']);
    assert.deepEqual(first.report.models.map(row => row.account), ['default', 'second']);
    const second = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: true }, h.deps);
    assert.deepEqual(second.report.providers.map(row => row.source), ['cached', 'cached']);
    assert.deepEqual(second.report.models.map(row => row.source), ['cached', 'cached']);
  });

  it('expiry refetches after the 5 minute TTL', async t => {
    const h = await harness(t);
    await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: false }, h.deps);
    h.clock.t += QUOTA_CACHE_TTL_MS - 1;
    const hit = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: false }, h.deps);
    assert.equal(h.quotaCalls.length, 1);
    assert.equal(hit.report.providers[0].source, 'cached');
    h.clock.t += 1;
    const expired = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: false }, h.deps);
    assert.equal(h.quotaCalls.length, 2);
    assert.equal(expired.report.providers[0].source, 'live');
  });

  it('errors are not cached beyond 30 s', async t => {
    const h = await harness(t, { quota: (provider, _index, observedAt) => errorQuota(provider, observedAt) });
    const first = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: false }, h.deps);
    assert.equal(first.report.providers[0].status, 'error');
    assert.equal(h.quotaCalls.length, 1);

    h.clock.t += 10_000;
    const cached = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: false }, h.deps);
    assert.equal(h.quotaCalls.length, 1);
    assert.equal(cached.report.providers[0].source, 'cached');
    assert.equal(cached.report.providers[0].status, 'error');

    h.clock.t += 21_000;
    const refetched = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: false }, h.deps);
    assert.equal(h.quotaCalls.length, 2);
    assert.equal(refetched.report.providers[0].source, 'live');
  });

  it('hung fetches are not cached beyond 30 s', async t => {
    const h = await harness(t, {
      graceMs: 0,
      quota: () => new Promise<ProviderQuota>(() => { /* never settles */ }),
    });
    const first = await collectQuotaReport({ providers: ['claude'], timeoutMs: 20, includeModels: false }, h.deps);
    assert.equal(first.hung, true);
    assert.equal(first.report.providers[0].status, 'error');
    assert.equal(h.quotaCalls.length, 1);

    h.clock.t += 10_000;
    const cached = await collectQuotaReport({ providers: ['claude'], timeoutMs: 20, includeModels: false }, h.deps);
    assert.equal(h.quotaCalls.length, 1);
    assert.equal(cached.hung, false);
    assert.equal(cached.report.providers[0].source, 'cached');

    h.clock.t += 21_000;
    const refetched = await collectQuotaReport({ providers: ['claude'], timeoutMs: 20, includeModels: false }, h.deps);
    assert.equal(h.quotaCalls.length, 2);
    assert.equal(refetched.hung, true);
  });

  it('--fresh bypasses the cache and refreshes it', async t => {
    const h = await harness(t);
    await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: false }, h.deps);
    const hit = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: false }, h.deps);
    assert.equal(hit.report.providers[0].source, 'cached');
    assert.equal(h.quotaCalls.length, 1);

    h.clock.t += 60_000;
    const fresh = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: false, fresh: true }, h.deps);
    assert.equal(h.quotaCalls.length, 2);
    assert.equal(fresh.report.providers[0].source, 'live');
    assert.equal(fresh.report.providers[0].observedAt, new Date(h.clock.t).toISOString());

    const after = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: false }, h.deps);
    assert.equal(h.quotaCalls.length, 2);
    assert.equal(after.report.providers[0].source, 'cached');
    assert.equal(after.report.providers[0].observedAt, new Date(h.clock.t).toISOString());
  });

  it('runQuota --fresh bypasses a cached row', async t => {
    const h = await harness(t);
    await runQuota(['claude'], h.deps);
    await runQuota(['claude'], h.deps);
    assert.equal(h.quotaCalls.length, 1);
    await runQuota(['--fresh', 'claude'], h.deps);
    assert.equal(h.quotaCalls.length, 2);
  });

  it('per-provider independence: an expiring error does not evict a fresh ok provider', async t => {
    const h = await harness(t, {
      quota: (provider, _index, observedAt) => (provider === 'codex' ? errorQuota(provider, observedAt) : okQuota(provider, observedAt)),
    });
    await collectQuotaReport({ providers: ['claude', 'codex'], timeoutMs: 1000, includeModels: false }, h.deps);
    assert.deepEqual([...h.quotaCalls].sort(), ['claude', 'codex']);

    h.clock.t += 31_000;
    const second = await collectQuotaReport({ providers: ['claude', 'codex'], timeoutMs: 1000, includeModels: false }, h.deps);
    assert.equal(h.quotaCalls.filter(p => p === 'claude').length, 1);
    assert.equal(h.quotaCalls.filter(p => p === 'codex').length, 2);
    assert.equal(second.report.providers.find(r => r.provider === 'claude')?.source, 'cached');
    assert.equal(second.report.providers.find(r => r.provider === 'codex')?.source, 'live');
  });

  it('concurrent calls share one live fetch', async t => {
    const h = await harness(t, {
      quota: async (provider, _index, observedAt) => {
        await sleep(80);
        return okQuota(provider, observedAt);
      },
      models: async (provider, _index, observedAt) => {
        await sleep(80);
        return okModels(provider, observedAt);
      },
    });
    const [a, b] = await Promise.all([
      collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: true }, h.deps),
      collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: true }, h.deps),
    ]);
    assert.equal(h.quotaCalls.length, 1);
    assert.equal(h.modelCalls.length, 1);
    const sources = [a.report.providers[0].source, b.report.providers[0].source].sort();
    assert.deepEqual(sources, ['cached', 'live']);
  });

  it('dead lock holder is recovered', async t => {
    const h = await harness(t);
    const lockPath = resolveQuotaCacheLockPath(h.homeDir);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: 999999, token: 'deadbeef', createdAt: h.clock.t - 60_000 }));
    const collected = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: false }, h.deps);
    assert.equal(h.quotaCalls.length, 1);
    assert.equal(collected.report.providers[0].status, 'ok');
    // The recovered lock is released afterwards: no lock file remains.
    await assert.rejects(readFile(lockPath, 'utf8'), { code: 'ENOENT' });
  });

  it('corrupt lock older than the stale timeout is recovered', async t => {
    const h = await harness(t);
    const lockPath = resolveQuotaCacheLockPath(h.homeDir);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, 'not json at all');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const collected = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: false }, h.deps);
    assert.equal(h.quotaCalls.length, 1);
    assert.equal(collected.report.providers[0].status, 'ok');
  });

  it('keeps a monthly window and the limited flag through the cache', async t => {
    const h = await harness(t, {
      quota: (provider, _index, observedAt) => ({
        ...okQuota(provider, observedAt, 'Go'),
        windows: [
          { kind: 'weekly', usedPercent: 13, resetsAt: null, windowMinutes: 10080, note: null, limited: true },
          { kind: 'monthly', usedPercent: 6, resetsAt: null, windowMinutes: null, note: null, limited: false },
        ],
      }),
    });
    await collectQuotaReport({ providers: ['opencode'], timeoutMs: 1000, includeModels: false }, h.deps);
    const second = await collectQuotaReport({ providers: ['opencode'], timeoutMs: 1000, includeModels: false }, h.deps);
    assert.equal(h.quotaCalls.length, 1);
    const row = second.report.providers[0];
    assert.equal(row.source, 'cached');
    assert.equal(row.windows.find(window => window.kind === 'monthly')?.usedPercent, 6);
    assert.equal(row.windows.find(window => window.kind === 'weekly')?.limited, true);
  });

  it('refetches when a cached window kind or limited flag is not a real window', async t => {
    const h = await harness(t);
    const cachePath = resolveQuotaCachePath(h.homeDir);
    await mkdir(dirname(cachePath), { recursive: true });
    const base = JSON.parse(JSON.stringify(okQuota('opencode', START.toISOString()))) as {
      windows: Array<Record<string, unknown>>;
    };
    base.windows[0].kind = 'daily';
    await writeFile(cachePath, `${JSON.stringify({ version: 1, entries: { opencode: { quota: base, models: null } } })}\n`);
    const unknownKind = await collectQuotaReport({ providers: ['opencode'], timeoutMs: 1000, includeModels: false }, h.deps);
    assert.equal(h.quotaCalls.length, 1);
    assert.equal(unknownKind.report.providers[0].source, 'live');

    base.windows[0].kind = 'five_hour';
    base.windows[0].limited = 'yes';
    await writeFile(cachePath, `${JSON.stringify({ version: 1, entries: { opencode: { quota: base, models: null } } })}\n`);
    const badFlag = await collectQuotaReport({ providers: ['opencode'], timeoutMs: 1000, includeModels: false }, h.deps);
    assert.equal(h.quotaCalls.length, 2);
    assert.equal(badFlag.report.providers[0].source, 'live');
  });

  it('corrupt cache file is ignored and rewritten', async t => {
    const h = await harness(t);
    const cachePath = resolveQuotaCachePath(h.homeDir);
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, '{ corrupt json');
    const first = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: false }, h.deps);
    assert.equal(h.quotaCalls.length, 1);
    assert.equal(first.report.providers[0].source, 'live');

    const rewritten: unknown = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.equal(typeof rewritten, 'object');
    const cache = await readQuotaCache(h.homeDir);
    assert.equal(cache.entries['claude:default']?.quota?.provider, 'claude');

    const second = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: false }, h.deps);
    assert.equal(h.quotaCalls.length, 1);
    assert.equal(second.report.providers[0].source, 'cached');
  });

  it('a cache entry with a future observedAt is treated as expired', async t => {
    const h = await harness(t);
    const cachePath = resolveQuotaCachePath(h.homeDir);
    await mkdir(dirname(cachePath), { recursive: true });
    const future = new Date(h.clock.t + 60_000).toISOString();
    await writeFile(cachePath, `${JSON.stringify({
      version: 1,
      entries: { claude: { quota: okQuota('claude', future), models: null } },
    }, null, 2)}\n`);
    const collected = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: false }, h.deps);
    assert.equal(h.quotaCalls.length, 1);
    assert.equal(collected.report.providers[0].source, 'live');
    assert.equal(collected.report.providers[0].observedAt, START.toISOString());
  });

  it('invalidateQuotaCacheEntry drops only that provider', async t => {
    const h = await harness(t);
    await collectQuotaReport({ providers: ['claude', 'codex'], timeoutMs: 1000, includeModels: true }, h.deps);
    assert.equal(h.quotaCalls.length, 2);
    await invalidateQuotaCacheEntry(h.homeDir, 'claude');
    const cache = await readQuotaCache(h.homeDir);
    assert.equal(cache.entries['claude:default'], undefined);
    assert.equal(cache.entries['codex:default']?.quota?.provider, 'codex');

    const second = await collectQuotaReport({ providers: ['claude', 'codex'], timeoutMs: 1000, includeModels: true }, h.deps);
    assert.equal(h.quotaCalls.filter(p => p === 'claude').length, 2);
    assert.equal(h.quotaCalls.filter(p => p === 'codex').length, 1);
    assert.equal(second.report.providers.find(r => r.provider === 'codex')?.source, 'cached');
  });

  it('writes the cache atomically with no temp files left behind', async t => {
    const h = await harness(t);
    await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: false }, h.deps);
    const cachePath = resolveQuotaCachePath(h.homeDir);
    const parsed: unknown = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.equal(typeof parsed, 'object');
    const names = await readdir(dirname(cachePath));
    assert.deepEqual(names.filter(name => name.includes('.tmp')), []);
    assert.equal(names.includes('quota-cache.json.lock'), false);
  });

  it('cached rows show their age in human output and keep the JSON shape', async t => {
    const h = await harness(t, { useRealFormat: true });
    await runQuota(['claude'], h.deps);
    h.clock.t += 3 * 60_000;
    const table = await runQuota(['claude'], h.deps);
    assert.equal(h.quotaCalls.length, 1);
    assert.match(table.stdout, /cached 3m ago/);

    const json = await runQuota(['--json', 'claude'], h.deps);
    assert.equal(h.quotaCalls.length, 1);
    const report = JSON.parse(json.stdout) as { providers: ProviderQuota[] };
    assert.equal(report.providers[0].source, 'cached');
    assert.equal(report.providers[0].observedAt, START.toISOString());
    assert.deepEqual(Object.keys(report.providers[0]).sort(), ['account', 'message', 'observedAt', 'plan', 'provider', 'source', 'status', 'windows']);
  });
});
