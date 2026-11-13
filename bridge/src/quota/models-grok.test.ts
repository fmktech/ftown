import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchGrokModels, parseGrokConfigDefaults, parseGrokModelsCache } from './models-grok.js';
import type { QuotaFetchOptions } from './types.js';

const NOW = new Date('2026-11-13T10:00:00.000Z');
const FALLBACK = '2026-11-12T08:00:00.000Z';

const HIGH_FAMILY = [
  { id: 'xhigh', value: 'xhigh', label: 'Extra high', description: '', default: false },
  { id: 'high', value: 'high', label: 'High', description: '', default: true },
  { id: 'medium', value: 'medium', label: 'Medium', description: '', default: false },
  { id: 'low', value: 'low', label: 'Low', description: '', default: false },
];

/** An entry shaped like the real models_cache.json `models` values. */
function cacheEntry(id: string, info: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    info: {
      id,
      name: `Grok ${id}`,
      description: `Description of ${id}`,
      context_windows: [256000, 500000],
      hidden: false,
      reasoning_effort: 'high',
      supports_reasoning_effort: true,
      reasoning_efforts: HIGH_FAMILY,
      ...info,
    },
  };
}

function realShapedCache(models: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return {
    fetched_at: '2026-11-13T14:55:11.109570Z',
    grok_version: '1.0.77',
    models,
  };
}

async function withHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'grok-models-'));
  try {
    await run(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function writeGrokFiles(
  homeDir: string,
  files: { cache?: string; config?: string },
): Promise<void> {
  await mkdir(join(homeDir, '.grok'), { recursive: true });
  if (files.cache !== undefined) {
    await writeFile(join(homeDir, '.grok', 'models_cache.json'), files.cache);
  }
  if (files.config !== undefined) {
    await writeFile(join(homeDir, '.grok', 'config.toml'), files.config);
  }
}

function optionsFor(homeDir: string): QuotaFetchOptions {
  return { timeoutMs: 1000, now: () => NOW, homeDir };
}

describe('parseGrokModelsCache', () => {
  it('maps the real-shaped cache: drops hidden, keeps order, flags the config default', () => {
    const cache = realShapedCache({
      'grok-4.7': cacheEntry('grok-4.7', { name: 'Grok 4.7' }),
      'grok-4.7-internal': cacheEntry('grok-4.7-internal', { hidden: true }),
      'grok-4.6': cacheEntry('grok-4.6', { name: 'Grok 4.6' }),
      'grok-4.5': cacheEntry('grok-4.5', {
        name: 'Grok 4.5',
        reasoning_efforts: HIGH_FAMILY.slice(1),
      }),
    });

    const result = parseGrokModelsCache(cache, 'grok-4.5', 'high', FALLBACK);

    assert.deepEqual(result, {
      provider: 'grok',
      status: 'ok',
      source: 'cached',
      observedAt: '2026-11-13T14:55:11.109Z',
      message: null,
      modelFlag: '-m <id>',
      effortFlag: '--reasoning-effort <level>',
      models: [
        {
          id: 'grok-4.7',
          name: 'Grok 4.7',
          isDefault: false,
          description: 'Description of grok-4.7',
          contextTokens: 500000,
          efforts: ['xhigh', 'high', 'medium', 'low'],
          defaultEffort: 'high',
        },
        {
          id: 'grok-4.6',
          name: 'Grok 4.6',
          isDefault: false,
          description: 'Description of grok-4.6',
          contextTokens: 500000,
          efforts: ['xhigh', 'high', 'medium', 'low'],
          defaultEffort: 'high',
        },
        {
          id: 'grok-4.5',
          name: 'Grok 4.5',
          isDefault: true,
          description: 'Description of grok-4.5',
          contextTokens: 500000,
          efforts: ['high', 'medium', 'low'],
          defaultEffort: 'high',
        },
      ],
    });
  });

  it('takes the largest finite context window and null when none are given', () => {
    const result = parseGrokModelsCache(
      realShapedCache({
        a: cacheEntry('a', { context_windows: [128000, 'big', 1000000, Number.NaN] }),
        b: cacheEntry('b', { context_windows: [] }),
        c: cacheEntry('c', { context_windows: undefined }),
      }),
      null,
      null,
      FALLBACK,
    );
    assert.deepEqual(
      result.models.map((m) => m.contextTokens),
      [1000000, null, null],
    );
  });

  it('uses the effort flagged default, then info.reasoning_effort, then null', () => {
    const result = parseGrokModelsCache(
      realShapedCache({
        flagged: cacheEntry('flagged', { reasoning_effort: 'low' }),
        infoOnly: cacheEntry('infoOnly', {
          reasoning_effort: 'medium',
          reasoning_efforts: HIGH_FAMILY.map((e) => ({ ...e, default: false })),
        }),
        neither: cacheEntry('neither', {
          reasoning_effort: undefined,
          reasoning_efforts: HIGH_FAMILY.map((e) => ({ ...e, default: false })),
        }),
      }),
      null,
      null,
      FALLBACK,
    );
    assert.deepEqual(
      result.models.map((m) => m.defaultEffort),
      ['high', 'medium', null],
    );
  });

  it('overrides the effort with the config default for the default model only, and only when supported', () => {
    const cache = realShapedCache({
      'grok-4.7': cacheEntry('grok-4.7'),
      'grok-4.5': cacheEntry('grok-4.5', { reasoning_efforts: HIGH_FAMILY.slice(1) }),
    });

    const overridden = parseGrokModelsCache(cache, 'grok-4.7', 'medium', FALLBACK);
    assert.equal(overridden.models[0]?.defaultEffort, 'medium');
    assert.equal(overridden.models[1]?.defaultEffort, 'high');

    const notSupported = parseGrokModelsCache(cache, 'grok-4.5', 'xhigh', FALLBACK);
    assert.equal(notSupported.models[0]?.defaultEffort, 'high');
    assert.equal(notSupported.models[1]?.defaultEffort, 'high');
    assert.deepEqual(notSupported.models[1]?.efforts, ['high', 'medium', 'low']);

    const nonDefault = parseGrokModelsCache(cache, 'grok-4.5', 'medium', FALLBACK);
    assert.equal(nonDefault.models[0]?.defaultEffort, 'high');
    assert.equal(nonDefault.models[1]?.defaultEffort, 'medium');
  });

  it('reports no efforts when supports_reasoning_effort is false', () => {
    const result = parseGrokModelsCache(
      realShapedCache({
        plain: cacheEntry('plain', { supports_reasoning_effort: false }),
      }),
      'plain',
      'high',
      FALLBACK,
    );
    assert.deepEqual(result.models[0]?.efforts, []);
    assert.equal(result.models[0]?.isDefault, true);
  });

  it('marks no model as default when the config default is unknown or null', () => {
    const cache = realShapedCache({ 'grok-4.7': cacheEntry('grok-4.7') });
    const unknown = parseGrokModelsCache(cache, 'grok-9', null, FALLBACK);
    assert.equal(unknown.status, 'ok');
    assert.equal(unknown.models[0]?.isDefault, false);

    const absent = parseGrokModelsCache(cache, null, null, FALLBACK);
    assert.equal(absent.models[0]?.isDefault, false);
  });

  it('parses an epoch fetched_at in seconds and in milliseconds', () => {
    const seconds = Date.UTC(2026, 10, 13, 9, 30) / 1000;
    const millis = Date.UTC(2026, 10, 13, 9, 30);
    const cache = (fetchedAt: unknown) => ({ fetched_at: fetchedAt, models: { m: cacheEntry('m') } });

    const expected = '2026-11-13T09:30:00.000Z';
    assert.equal(parseGrokModelsCache(cache(seconds), null, null, FALLBACK).observedAt, expected);
    assert.equal(parseGrokModelsCache(cache(millis), null, null, FALLBACK).observedAt, expected);
  });

  it('falls back to the given observedAt when fetched_at is missing or unparseable', () => {
    const models = { m: cacheEntry('m') };
    assert.equal(parseGrokModelsCache({ models }, null, null, FALLBACK).observedAt, FALLBACK);
    assert.equal(
      parseGrokModelsCache({ models, fetched_at: 'yesterday' }, null, null, FALLBACK).observedAt,
      FALLBACK,
    );
    assert.equal(
      parseGrokModelsCache({ models, fetched_at: { at: 1 } }, null, null, FALLBACK).observedAt,
      FALLBACK,
    );
  });

  it('gives a null defaultEffort when supports_reasoning_effort is false', () => {
    const result = parseGrokModelsCache(
      realShapedCache({
        plain: cacheEntry('plain', { supports_reasoning_effort: false, reasoning_effort: 'high' }),
      }),
      null,
      'high',
      FALLBACK,
    );
    assert.deepEqual(result.models[0]?.efforts, []);
    assert.equal(result.models[0]?.defaultEffort, null);
  });

  it('gives a null defaultEffort when the supported effort list is empty', () => {
    const result = parseGrokModelsCache(
      realShapedCache({
        empty: cacheEntry('empty', { reasoning_efforts: [], reasoning_effort: 'high' }),
      }),
      'empty',
      'high',
      FALLBACK,
    );
    assert.deepEqual(result.models[0]?.efforts, []);
    assert.equal(result.models[0]?.defaultEffort, null);
  });

  it('gives a null defaultEffort when info.reasoning_effort is not in the list', () => {
    const result = parseGrokModelsCache(
      realShapedCache({
        odd: cacheEntry('odd', {
          reasoning_effort: 'ultra',
          reasoning_efforts: HIGH_FAMILY.map((e) => ({ ...e, default: false })),
        }),
      }),
      null,
      null,
      FALLBACK,
    );
    assert.equal(result.models[0]?.defaultEffort, null);
  });

  it('does not throw on a very large context_windows array', () => {
    const huge = Array.from({ length: 300000 }, (_, i) => i);
    const result = parseGrokModelsCache(
      realShapedCache({ big: cacheEntry('big', { context_windows: huge }) }),
      null,
      null,
      FALLBACK,
    );
    assert.equal(result.status, 'ok');
    assert.equal(result.models[0]?.contextTokens, 299999);
  });

  it('returns an error for wrong shapes', () => {
    const shapes: unknown[] = [
      null,
      [],
      'not json',
      { models: [] },
      { models: 'grok-4.7' },
      {},
      { models: { x: { info: 'nope' } } },
      { models: { hiddenOnly: cacheEntry('hiddenOnly', { hidden: true }) } },
    ];
    for (const shape of shapes) {
      const result = parseGrokModelsCache(shape, 'grok-4.7', 'high', FALLBACK);
      assert.equal(result.status, 'error', JSON.stringify(shape));
      assert.deepEqual(result.models, []);
      assert.equal(result.message, 'unrecognised grok model cache format');
      assert.equal(result.provider, 'grok');
      assert.equal(result.observedAt, FALLBACK);
    }
  });
});

describe('parseGrokConfigDefaults', () => {
  it('reads default and default_reasoning_effort from the [models] section', () => {
    const toml = [
      '[cli]',
      'default = "wrong"',
      '',
      '[models]',
      'default = "grok-4.5"',
      'default_reasoning_effort = "high"',
    ].join('\n');
    assert.deepEqual(parseGrokConfigDefaults(toml), { model: 'grok-4.5', effort: 'high' });
  });

  it('ignores the same keys outside [models] and before any section', () => {
    const toml = [
      'default = "top-level"',
      'default_reasoning_effort = "low"',
      '[ui]',
      'default_reasoning_effort = "medium"',
      '[models.extra]',
      'default = "nested"',
      '[models]',
      'default_skills_installs_purged = true',
    ].join('\n');
    assert.deepEqual(parseGrokConfigDefaults(toml), { model: null, effort: null });
  });

  it('handles single quotes, comments and hashes inside strings', () => {
    const toml = [
      '# top comment',
      '[models] # section comment',
      "default = 'grok-4.6' # trailing",
      'default_reasoning_effort = "medium # not a comment"',
    ].join('\n');
    assert.deepEqual(parseGrokConfigDefaults(toml), {
      model: 'grok-4.6',
      effort: 'medium # not a comment',
    });
  });

  it('returns null for missing, empty or non-string values', () => {
    assert.deepEqual(parseGrokConfigDefaults(''), { model: null, effort: null });
    assert.deepEqual(parseGrokConfigDefaults('[models]\ndefault = ""\n'), {
      model: null,
      effort: null,
    });
    assert.deepEqual(parseGrokConfigDefaults('[models]\ndefault = 4\n'), {
      model: null,
      effort: null,
    });
  });

  it('accepts a quoted section header', () => {
    assert.deepEqual(
      parseGrokConfigDefaults('["models"]\ndefault = "grok-4.5"\ndefault_reasoning_effort = "high"\n'),
      { model: 'grok-4.5', effort: 'high' },
    );
    assert.deepEqual(parseGrokConfigDefaults("['models']\ndefault = 'grok-4.6'\n"), {
      model: 'grok-4.6',
      effort: null,
    });
  });

  it('accepts quoted keys', () => {
    const toml = '[models]\n\'default\' = "grok-4.5"\n"default_reasoning_effort" = "low"\n';
    assert.deepEqual(parseGrokConfigDefaults(toml), { model: 'grok-4.5', effort: 'low' });
  });

  it('accepts the dotted top-level form models.<key>', () => {
    const toml = 'models.default = "grok-4.5"\nmodels.default_reasoning_effort = "high"\n';
    assert.deepEqual(parseGrokConfigDefaults(toml), { model: 'grok-4.5', effort: 'high' });
  });

  it('ignores dotted keys under other sections or with other prefixes', () => {
    const toml = '[ui]\nmodels.default = "x"\nother.default = "y"\n';
    assert.deepEqual(parseGrokConfigDefaults(toml), { model: null, effort: null });
  });

  it('keeps the first value when a key repeats', () => {
    const toml = '[models]\ndefault = "a"\ndefault = "b"\n';
    assert.equal(parseGrokConfigDefaults(toml).model, 'a');
  });
});

describe('fetchGrokModels', () => {
  const cacheWith = (models: Record<string, Record<string, unknown>>, extra = {}) =>
    JSON.stringify({ ...realShapedCache(models), ...extra });

  it('reads the cache and config from homeDir', async () => {
    await withHome(async (homeDir) => {
      await writeGrokFiles(homeDir, {
        cache: cacheWith({
          'grok-4.7': cacheEntry('grok-4.7'),
          'grok-4.5': cacheEntry('grok-4.5', { reasoning_efforts: HIGH_FAMILY.slice(1) }),
        }),
        config: '[models]\ndefault = "grok-4.5"\ndefault_reasoning_effort = "medium"\n',
      });

      const result = await fetchGrokModels(optionsFor(homeDir));

      assert.equal(result.status, 'ok');
      assert.equal(result.source, 'cached');
      assert.equal(result.observedAt, '2026-11-13T14:55:11.109Z');
      assert.deepEqual(
        result.models.map((m) => [m.id, m.isDefault, m.defaultEffort]),
        [
          ['grok-4.7', false, 'high'],
          ['grok-4.5', true, 'medium'],
        ],
      );
    });
  });

  it('uses the cache file mtime as observedAt when fetched_at is absent', async () => {
    await withHome(async (homeDir) => {
      const body = JSON.stringify({ models: { m: cacheEntry('m') } });
      await writeGrokFiles(homeDir, { cache: body });
      const cachePath = join(homeDir, '.grok', 'models_cache.json');
      const mtime = new Date('2026-11-10T12:00:00.000Z');
      await utimes(cachePath, mtime, mtime);
      assert.equal((await stat(cachePath)).mtime.toISOString(), mtime.toISOString());

      const result = await fetchGrokModels(optionsFor(homeDir));

      assert.equal(result.status, 'ok');
      assert.equal(result.observedAt, mtime.toISOString());
      assert.equal(result.models[0]?.isDefault, false);
    });
  });

  it('returns unavailable when the cache file is missing, even with a config present', async () => {
    await withHome(async (homeDir) => {
      await writeGrokFiles(homeDir, { config: '[models]\ndefault = "grok-4.5"\n' });

      const result = await fetchGrokModels(optionsFor(homeDir));

      assert.equal(result.status, 'unavailable');
      assert.equal(result.message, 'grok model cache not found (open grok once to create it)');
      assert.deepEqual(result.models, []);
    });
  });

  it('returns unavailable when the grok directory does not exist', async () => {
    await withHome(async (homeDir) => {
      const result = await fetchGrokModels(optionsFor(join(homeDir, 'absent')));
      assert.equal(result.status, 'unavailable');
      assert.equal(result.observedAt, NOW.toISOString());
    });
  });

  it('treats a missing config.toml as null defaults', async () => {
    await withHome(async (homeDir) => {
      await writeGrokFiles(homeDir, {
        cache: cacheWith({ 'grok-4.5': cacheEntry('grok-4.5') }),
      });

      const result = await fetchGrokModels(optionsFor(homeDir));

      assert.equal(result.status, 'ok');
      assert.equal(result.models[0]?.isDefault, false);
      assert.equal(result.models[0]?.defaultEffort, 'high');
    });
  });

  it('returns an error with only the errno code when the cache cannot be read', async () => {
    await withHome(async (homeDir) => {
      await mkdir(join(homeDir, '.grok', 'models_cache.json'), { recursive: true });

      const result = await fetchGrokModels(optionsFor(homeDir));

      assert.equal(result.status, 'error');
      assert.equal(result.message, 'grok model cache could not be read (EISDIR)');
      assert.deepEqual(result.models, []);
    });
  });

  it('returns the wrong-shape error for a cache that is not JSON', async () => {
    await withHome(async (homeDir) => {
      await writeGrokFiles(homeDir, { cache: '{not json' });

      const result = await fetchGrokModels(optionsFor(homeDir));

      assert.equal(result.status, 'error');
      assert.equal(result.message, 'unrecognised grok model cache format');
      assert.equal(Number.isNaN(Date.parse(result.observedAt)), false);
      const mtime = await stat(join(homeDir, '.grok', 'models_cache.json'));
      assert.equal(result.observedAt, mtime.mtime.toISOString());
    });
  });
});
