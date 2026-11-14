import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { loadRoutingConfig, resolveRoutingPath, saveRoutingConfig, starterRoutingConfig } from './routing-config.js';
import { createModelRoutingService, MODEL_ROUTING_CACHE_MS, type ModelRoutingServiceOptions } from './routing-service.js';
import { MODEL_ROUTING_MIN_REFRESH_MS, type ModelRoutingConfig, type ProviderModels, type QuotaReport, type SetModelRoutingResult } from './types.js';

const OBSERVED = '2026-11-13T00:00:00.000Z';

function models(): ProviderModels[] {
  return [{
    provider: 'claude', status: 'ok', source: 'live', observedAt: OBSERVED, message: null,
    modelFlag: '--model <id>', effortFlag: '--effort <level>',
    models: [{ id: 'opus', name: 'Opus', isDefault: true, description: null, contextTokens: null, efforts: ['low', 'high'], defaultEffort: 'high' }],
  }];
}

function report(label = 'r1'): QuotaReport {
  return {
    generatedAt: OBSERVED,
    providers: [{ provider: 'claude', status: 'ok', plan: label, windows: [], source: 'live', observedAt: OBSERVED, message: null }],
    routing: [{ provider: 'claude', availability: 'available', leftPercent: 80, bindingWindow: 'weekly', resetsAt: null, resetsInMinutes: null, runway: null, reason: 'ok' }],
    models: models(),
    routingConfig: { status: 'missing', path: '/elsewhere', errors: [] },
    tiers: [],
    steering: '',
  };
}

function config(pick: Partial<{ provider: string; model: string; effort: string | null }> = {}): ModelRoutingConfig {
  return {
    version: 1,
    tiers: [{ name: 'complex', description: 'Hard work', guidance: '', picks: [{ provider: 'claude', model: 'opus', effort: 'high', ...pick } as ModelRoutingConfig['tiers'][number]['picks'][number]] }],
    steering: 'keep claude in reserve',
  };
}

interface Harness {
  homeDir: string;
  clock: { t: number };
  calls: boolean[];
  service: ReturnType<typeof createModelRoutingService>;
  setCollect(fn: ModelRoutingServiceOptions['collect']): void;
}

async function harness(t: { after: (fn: () => Promise<void>) => void }, cacheMs?: number): Promise<Harness> {
  const homeDir = await mkdtemp(join(tmpdir(), 'routing-service-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const clock = { t: 1_000_000 };
  const calls: boolean[] = [];
  let impl: ModelRoutingServiceOptions['collect'] = async () => report(`r${calls.length}`);
  const service = createModelRoutingService({
    homeDir, now: () => clock.t, cacheMs,
    collect: refresh => { calls.push(refresh); return impl(refresh); },
  });
  return { homeDir, clock, calls, service, setCollect: fn => { impl = fn; } };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('model routing service: get', () => {
  it('collects on a miss, serves the cache on a hit, and recollects on refresh or expiry', async t => {
    const h = await harness(t);
    const first = await h.service.get({});
    assert.equal(first.cached, false);
    assert.equal(first.schema, 1);
    assert.deepEqual(h.calls, [false]);

    h.clock.t += 59_999;
    const hit = await h.service.get({});
    assert.equal(hit.cached, true);
    assert.equal(hit.report.providers[0]?.plan, first.report.providers[0]?.plan);
    assert.equal(h.calls.length, 1);

    const refreshed = await h.service.get({ refresh: true });
    assert.equal(refreshed.cached, false);
    assert.deepEqual(h.calls, [false, true]);

    h.clock.t += 60_000;
    const expired = await h.service.get({ refresh: false });
    assert.equal(expired.cached, false);
    assert.equal(h.calls.length, 3);
  });

  it('honours a custom cacheMs', async t => {
    const h = await harness(t, 10);
    await h.service.get({});
    h.clock.t += 10;
    assert.equal((await h.service.get({})).cached, false);
    assert.equal(h.calls.length, 2);
  });

  it('shares one in-flight collect between concurrent gets', async t => {
    const h = await harness(t);
    const pending = deferred<QuotaReport>();
    h.setCollect(() => pending.promise);
    const a = h.service.get({});
    const b = h.service.get({ refresh: true });
    const c = h.service.get({});
    await new Promise(resolve => setImmediate(resolve));
    pending.resolve(report('shared'));
    const results = await Promise.all([a, b, c]);
    assert.equal(h.calls.length, 1);
    for (const result of results) {
      assert.equal(result.cached, false);
      assert.equal(result.report.providers[0]?.plan, 'shared');
    }
  });

  it('does not cache a failed collect and rejects with a short error', async t => {
    const h = await harness(t);
    h.setCollect(async () => { throw new Error('boom\nstack line'); });
    await assert.rejects(h.service.get({}), { message: 'quota could not be collected: boom' });
    h.setCollect(async () => report('ok'));
    const after = await h.service.get({});
    assert.equal(after.cached, false);
    assert.equal(h.calls.length, 2);
  });

  it('serves a refresh inside the floor from cache and recollects at and after it', async t => {
    const h = await harness(t);
    await h.service.get({});
    h.clock.t += MODEL_ROUTING_MIN_REFRESH_MS - 1;
    const within = await h.service.get({ refresh: true });
    assert.equal(within.cached, true);
    assert.deepEqual(h.calls, [false]);

    h.clock.t += 1;
    const atFloor = await h.service.get({ refresh: true });
    assert.equal(atFloor.cached, false);
    assert.deepEqual(h.calls, [false, true]);

    h.clock.t += 1;
    assert.equal((await h.service.get({ refresh: true })).cached, true);
    h.clock.t += MODEL_ROUTING_MIN_REFRESH_MS + 5;
    assert.equal((await h.service.get({ refresh: true })).cached, false);
    assert.deepEqual(h.calls, [false, true, true]);
  });

  it('counts the refresh floor from when the last collect completed', async t => {
    const h = await harness(t);
    const pending = deferred<QuotaReport>();
    h.setCollect(() => pending.promise);
    const first = h.service.get({});
    await new Promise(resolve => setImmediate(resolve));
    h.clock.t += 20_000;
    pending.resolve(report('slow'));
    await first;
    h.setCollect(async () => report('next'));
    h.clock.t += MODEL_ROUTING_MIN_REFRESH_MS - 1;
    assert.equal((await h.service.get({ refresh: true })).cached, true);
    assert.equal(h.calls.length, 1);
  });

  it('serves a refresh inside the floor from cache even when cacheMs has already elapsed', async t => {
    const h = await harness(t, 5_000);
    await h.service.get({});
    h.clock.t += 6_000;
    assert.equal((await h.service.get({ refresh: true })).cached, true);
    assert.deepEqual(h.calls, [false]);
    assert.equal((await h.service.get({})).cached, false);
    assert.deepEqual(h.calls, [false, false]);
  });

  it('serves a refresh inside the floor after a slow collect whose cache age has expired', async t => {
    const h = await harness(t);
    const pending = deferred<QuotaReport>();
    h.setCollect(() => pending.promise);
    const first = h.service.get({});
    await new Promise(resolve => setImmediate(resolve));
    h.clock.t += 50_000;
    pending.resolve(report('slow'));
    await first;
    h.setCollect(async () => report('next'));
    h.clock.t += 10_000;
    const refreshed = await h.service.get({ refresh: true });
    assert.equal(refreshed.cached, true);
    assert.equal(refreshed.report.providers[0]?.plan, 'slow');
    assert.equal(h.calls.length, 1);
    const plain = await h.service.get({});
    assert.equal(plain.cached, false);
    assert.equal(plain.report.providers[0]?.plan, 'next');
    assert.deepEqual(h.calls, [false, false]);
  });

  it('a refresh inside the floor joins an in-flight collect started after cacheMs elapsed', async t => {
    const h = await harness(t, 5_000);
    await h.service.get({});
    h.clock.t += 6_000;
    const pending = deferred<QuotaReport>();
    h.setCollect(() => pending.promise);
    const plain = h.service.get({});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.calls, [false, false]);
    const refreshed = h.service.get({ refresh: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.length, 2);
    pending.resolve(report('fresh'));
    const [a, b] = await Promise.all([plain, refreshed]);
    assert.equal(a.cached, false);
    assert.equal(b.cached, false);
    assert.equal(a.report.providers[0]?.plan, 'fresh');
    assert.equal(b.report.providers[0]?.plan, 'fresh');
    assert.equal(h.calls.length, 2);
  });

  it('a refresh arriving during a collect joins it instead of starting another', async t => {
    const h = await harness(t);
    await h.service.get({});
    h.clock.t += MODEL_ROUTING_MIN_REFRESH_MS;
    const pending = deferred<QuotaReport>();
    h.setCollect(() => pending.promise);
    const a = h.service.get({ refresh: true });
    await new Promise(resolve => setImmediate(resolve));
    const b = h.service.get({ refresh: true });
    await new Promise(resolve => setImmediate(resolve));
    pending.resolve(report('joined'));
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual(h.calls, [false, true]);
    assert.equal(ra.report.providers[0]?.plan, 'joined');
    assert.equal(rb.report.providers[0]?.plan, 'joined');
    assert.equal(rb.cached, false);
  });

  it('recovers after collect throws synchronously', async t => {
    const h = await harness(t);
    h.setCollect(() => { throw new Error('sync boom'); });
    await assert.rejects(h.service.get({}), { message: 'quota could not be collected: sync boom' });
    h.setCollect(async () => report('ok'));
    const after = await h.service.get({});
    assert.equal(after.cached, false);
    assert.equal(after.report.providers[0]?.plan, 'ok');
    assert.equal(h.calls.length, 2);
  });

  it('recovers after collect rejects and never caches the failure', async t => {
    const h = await harness(t);
    await h.service.get({});
    h.clock.t += MODEL_ROUTING_CACHE_MS;
    h.setCollect(() => Promise.reject(new Error('offline')));
    await assert.rejects(h.service.get({}), { message: 'quota could not be collected: offline' });
    await assert.rejects(h.service.get({}), { message: 'quota could not be collected: offline' });
    assert.equal(h.calls.length, 3);
    h.setCollect(async () => report('back'));
    const after = await h.service.get({});
    assert.equal(after.cached, false);
    assert.equal(after.report.providers[0]?.plan, 'back');
    assert.equal((await h.service.get({})).cached, true);
    assert.equal(h.calls.length, 4);
  });

  it('re-reads the routing file on every get even when quota is cached', async t => {
    const h = await harness(t);
    const before = await h.service.get({});
    assert.equal(before.report.routingConfig.status, 'missing');
    assert.deepEqual(before.report.tiers, []);

    assert.deepEqual(await saveRoutingConfig(h.homeDir, config()), { ok: true });
    const after = await h.service.get({});
    assert.equal(after.cached, true);
    assert.equal(h.calls.length, 1);
    assert.equal(after.report.routingConfig.status, 'ok');
    assert.equal(after.report.routingConfig.path, resolveRoutingPath(h.homeDir));
    assert.deepEqual(after.config, config());
    assert.equal(after.report.steering, 'keep claude in reserve');
    assert.equal(after.report.tiers.length, 1);
    const annotated = after.report.tiers[0]?.picks[0];
    assert.equal(annotated?.model, 'opus');
    assert.equal(annotated?.modelName, 'Opus');
    assert.equal(annotated?.availability, 'available');
    assert.equal(annotated?.problem, null);
  });

  it('serves the starter config when the routing file is missing or invalid', async t => {
    const h = await harness(t);
    const missing = await h.service.get({});
    assert.deepEqual(missing.config, starterRoutingConfig());
    assert.equal(missing.report.routingConfig.status, 'missing');
    assert.equal(missing.report.steering, '');

    const path = resolveRoutingPath(h.homeDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{ not json');
    const invalid = await h.service.get({});
    assert.deepEqual(invalid.config, starterRoutingConfig());
    assert.equal(invalid.report.routingConfig.status, 'invalid');
    assert.deepEqual(invalid.report.routingConfig.errors, ['not valid JSON']);
    assert.deepEqual(invalid.report.tiers, []);
  });

  it('never mutates the cached report object', async t => {
    const h = await harness(t);
    const original = report('frozen');
    const snapshot = JSON.parse(JSON.stringify(original)) as QuotaReport;
    h.setCollect(async () => original);
    await h.service.get({});
    await saveRoutingConfig(h.homeDir, config());
    const served = await h.service.get({});
    assert.notEqual(served.report, original);
    assert.deepEqual(original, snapshot);
  });
});

describe('model routing service: set', () => {
  it('rejects an invalid structure without collecting or writing', async t => {
    const h = await harness(t);
    const result = await h.service.set({ config: { version: 2 } as unknown as ModelRoutingConfig });
    assert.equal(result.saved, false);
    assert.equal(result.schema, 1);
    assert.ok(result.errors.length > 0);
    assert.equal(h.calls.length, 0);
    assert.equal((await loadRoutingConfig(h.homeDir)).state.status, 'missing');
  });

  it('rejects a pick whose model is not offered', async t => {
    const h = await harness(t);
    const result = await h.service.set({ config: config({ model: 'no-such-model' }) });
    assert.equal(result.saved, false);
    assert.match(result.errors[0] ?? '', /has no model "no-such-model"/);
    assert.equal((await loadRoutingConfig(h.homeDir)).state.status, 'missing');
  });

  it('rejects an unsupported effort', async t => {
    const h = await harness(t);
    const result = await h.service.set({ config: config({ effort: 'max' }) });
    assert.equal(result.saved, false);
    assert.match(result.errors[0] ?? '', /does not support effort "max"/);
  });

  it('saves a valid config readable by loadRoutingConfig', async t => {
    const h = await harness(t);
    const result = await h.service.set({ config: config() });
    assert.deepEqual(result, { schema: 1, saved: true, errors: [] });
    const loaded = await loadRoutingConfig(h.homeDir);
    assert.equal(loaded.state.status, 'ok');
    assert.deepEqual(loaded.config, config());
  });

  const writeInvalidFile = async (homeDir: string): Promise<string> => {
    const path = resolveRoutingPath(homeDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{ not json');
    return path;
  };

  it('refuses to replace an invalid routing file without overwriteInvalid', async t => {
    const h = await harness(t);
    const path = await writeInvalidFile(h.homeDir);
    for (const payload of [{ config: config() }, { config: config(), overwriteInvalid: false }]) {
      const result = await h.service.set(payload);
      assert.equal(result.saved, false);
      assert.equal(result.invalidFileBlocked, true);
      assert.equal(result.schema, 1);
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0] ?? '', /invalid/);
      assert.equal(await readFile(path, 'utf8'), '{ not json');
    }
    assert.equal(h.calls.length, 0);
  });

  it('replaces an invalid routing file when overwriteInvalid is true', async t => {
    const h = await harness(t);
    await writeInvalidFile(h.homeDir);
    const result = await h.service.set({ config: config(), overwriteInvalid: true });
    assert.deepEqual(result, { schema: 1, saved: true, errors: [] });
    const loaded = await loadRoutingConfig(h.homeDir);
    assert.equal(loaded.state.status, 'ok');
    assert.deepEqual(loaded.config, config());
  });

  it('saves over a missing or valid file without the flag', async t => {
    const h = await harness(t);
    assert.deepEqual(await h.service.set({ config: config() }), { schema: 1, saved: true, errors: [] });
    const replacement = { ...config(), steering: 'replaced' };
    assert.deepEqual(await h.service.set({ config: replacement }), { schema: 1, saved: true, errors: [] });
    assert.equal((await loadRoutingConfig(h.homeDir)).config?.steering, 'replaced');
  });

  it('validates structure, then blocks an invalid file, before picks or quota collection', async t => {
    const h = await harness(t);
    const path = await writeInvalidFile(h.homeDir);
    const structural = await h.service.set({ config: { version: 2 } as unknown as ModelRoutingConfig });
    assert.equal(structural.saved, false);
    assert.ok(structural.errors.length > 0);
    assert.equal('invalidFileBlocked' in structural, false);
    assert.equal(h.calls.length, 0);
    const blocked = await h.service.set({ config: config({ model: 'no-such-model' }) });
    assert.equal(blocked.saved, false);
    assert.equal(blocked.invalidFileBlocked, true);
    assert.equal(h.calls.length, 0);
    const badPick = await h.service.set({ config: config({ model: 'no-such-model' }), overwriteInvalid: true });
    assert.equal(badPick.saved, false);
    assert.equal('invalidFileBlocked' in badPick, false);
    assert.match(badPick.errors[0] ?? '', /has no model/);
    assert.equal(h.calls.length, 1);
    assert.equal(await readFile(path, 'utf8'), '{ not json');
  });

  it('a successful set is reflected by the next get', async t => {
    const h = await harness(t);
    assert.deepEqual((await h.service.get({})).report.tiers, []);
    await h.service.set({ config: config() });
    const after = await h.service.get({});
    assert.equal(after.cached, true);
    assert.equal(after.report.tiers.length, 1);
    assert.deepEqual(after.config, config());
  });

  it('collects when no fresh cache exists and reuses a recent one', async t => {
    const h = await harness(t);
    await h.service.set({ config: config() });
    assert.equal(h.calls.length, 1);
    h.clock.t += 9 * 60_000;
    await h.service.set({ config: config() });
    assert.equal(h.calls.length, 1);
    h.clock.t += 60_000;
    await h.service.set({ config: config() });
    assert.equal(h.calls.length, 2);
  });

  it('shares an in-flight collect with a get', async t => {
    const h = await harness(t);
    const pending = deferred<QuotaReport>();
    h.setCollect(() => pending.promise);
    const got = h.service.get({});
    const saved = h.service.set({ config: config() });
    await new Promise(resolve => setImmediate(resolve));
    pending.resolve(report());
    await Promise.all([got, saved]);
    assert.equal(h.calls.length, 1);
    assert.equal((await saved).saved, true);
  });

  it('a failed collect during set rejects and a later set still runs', async t => {
    const h = await harness(t);
    h.setCollect(async () => { throw new Error('offline'); });
    await assert.rejects(h.service.set({ config: config() }), /quota could not be collected: offline/);
    h.setCollect(async () => report());
    assert.equal((await h.service.set({ config: config() })).saved, true);
  });

  it('serialises sets: the second starts only after the first finishes', async t => {
    const h = await harness(t);
    const pending = deferred<QuotaReport>();
    const collectStarted = deferred<true>();
    h.setCollect(() => { collectStarted.resolve(true); return pending.promise; });
    const order: string[] = [];
    const first = h.service.set({ config: { ...config(), steering: 'first' } }).then((r: SetModelRoutingResult) => { order.push('first'); return r; });
    // Invalid, so unserialised it would settle at once, before the first set's collect resolves.
    const invalid = h.service.set({ config: { version: 2 } as unknown as ModelRoutingConfig }).then((r: SetModelRoutingResult) => { order.push('invalid'); return r; });
    const third = h.service.set({ config: { ...config(), steering: 'third' } }).then((r: SetModelRoutingResult) => { order.push('third'); return r; });
    // The invalid-file read happens before collect, so wait until that collect is actually in flight.
    await collectStarted.promise;
    assert.deepEqual(order, []);
    assert.equal(h.calls.length, 1);
    pending.resolve(report());
    const results = await Promise.all([first, invalid, third]);
    assert.deepEqual(order, ['first', 'invalid', 'third']);
    assert.deepEqual(results.map(r => r.saved), [true, false, true]);
    assert.equal(h.calls.length, 1);
    assert.equal((await loadRoutingConfig(h.homeDir)).config?.steering, 'third');
  });
});
