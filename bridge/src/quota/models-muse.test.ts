import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchMuseModels, parseMuseModelCatalog } from './models-muse.js';
import type { QuotaFetchOptions } from './types.js';

const OBSERVED = '2026-11-13T14:52:03.065Z';
const TIERS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    model_id: 'muse-spark-1.3',
    display_label: 'muse-spark-1.3',
    provider_id: 'meta',
    profile_id: 'tbh',
    visibility: 'visible',
    is_current: false,
    is_default: false,
    context_limit: 1007997,
    output_limit: 64000,
    description: 'A model',
    reasoning_effort_variants: TIERS.map((tier) => ({ tier, description: `${tier} effort` })),
    background_agent_model: null,
    ...overrides,
  };
}

function catalog(rows: unknown[]): Record<string, unknown> {
  return { schema_version: 3, provider_id: 'meta', profile_id: 'tbh', source: 'provider_catalog', rows };
}

describe('parseMuseModelCatalog', () => {
  it('lists only visible rows, includes a missing visibility, and keeps the catalogue order', () => {
    const result = parseMuseModelCatalog(
      catalog([
        row({ model_id: 'muse-wonder-1.0', is_default: true }),
        row({ model_id: 'muse-wonder-1.0-contributor', visibility: 'hidden' }),
        row({ model_id: 'muse-ember-1.0', visibility: undefined }),
        row({ model_id: 'muse-image-1.0', visibility: 'hidden', reasoning_effort_variants: [] }),
        row({ model_id: 'muse-spark-1.2' }),
      ]),
      null,
      null,
      OBSERVED,
    );
    assert.equal(result.status, 'ok');
    assert.deepEqual(
      result.models.map((model) => model.id),
      ['muse-wonder-1.0', 'muse-ember-1.0', 'muse-spark-1.2'],
    );
  });

  it('maps the real row fields onto HarnessModel', () => {
    const result = parseMuseModelCatalog(
      catalog([
        row({
          model_id: 'muse-spark-1.2',
          display_label: 'muse-spark-1.2',
          description: 'Fast model',
          context_limit: 1007997,
          reasoning_effort_variants: [
            { tier: 'low', description: 'x' },
            { tier: 'high', description: 'y' },
          ],
        }),
      ]),
      null,
      null,
      OBSERVED,
    );
    assert.deepEqual(result, {
      provider: 'muse',
      status: 'ok',
      models: [
        {
          id: 'muse-spark-1.2',
          name: 'muse-spark-1.2',
          isDefault: false,
          description: 'Fast model',
          contextTokens: 1007997,
          efforts: ['low', 'high'],
          defaultEffort: null,
        },
      ],
      source: 'cached',
      observedAt: OBSERVED,
      message: null,
      modelFlag: '--model <id>',
      effortFlag: '--reasoning-effort <level>',
    });
  });

  it('uses null description when the row has none', () => {
    const { description: _omitted, ...withoutDescription } = row({ model_id: 'muse-ember-1.0' });
    const result = parseMuseModelCatalog(catalog([withoutDescription]), null, null, OBSERVED);
    assert.equal(result.models[0]?.description, null);
  });

  it('takes the default from settings and overrides is_default', () => {
    const result = parseMuseModelCatalog(
      catalog([
        row({ model_id: 'muse-wonder-1.0', is_default: true }),
        row({ model_id: 'muse-spark-1.3' }),
      ]),
      'muse-spark-1.3',
      null,
      OBSERVED,
    );
    assert.deepEqual(
      result.models.map((model) => model.isDefault),
      [false, true],
    );
  });

  it('falls back to the is_default row when the settings model matches no visible row', () => {
    const result = parseMuseModelCatalog(
      catalog([
        row({ model_id: 'muse-wonder-1.0', is_default: true }),
        row({ model_id: 'muse-hidden-x', visibility: 'hidden' }),
        row({ model_id: 'muse-spark-1.3' }),
      ]),
      'muse-hidden-x',
      null,
      OBSERVED,
    );
    assert.deepEqual(
      result.models.map((model) => model.isDefault),
      [true, false],
    );
  });

  it('marks nothing as default when neither settings nor is_default name one', () => {
    const result = parseMuseModelCatalog(
      catalog([row({ model_id: 'muse-wonder-1.0' }), row({ model_id: 'muse-spark-1.3' })]),
      null,
      null,
      OBSERVED,
    );
    assert.deepEqual(
      result.models.map((model) => model.isDefault),
      [false, false],
    );
  });

  it('applies settingsEffort only to the default model and only when it is supported', () => {
    const rows = [
      row({ model_id: 'muse-wonder-1.0', is_default: true }),
      row({ model_id: 'muse-spark-1.2', reasoning_effort_variants: [{ tier: 'low', description: 'x' }] }),
    ];

    const applied = parseMuseModelCatalog(catalog(rows), 'muse-wonder-1.0', 'max', OBSERVED);
    assert.equal(applied.models[0]?.defaultEffort, 'max');
    assert.equal(applied.models[1]?.defaultEffort, null);

    const unsupported = parseMuseModelCatalog(
      catalog([row({ model_id: 'muse-spark-1.2', is_default: true, reasoning_effort_variants: [{ tier: 'low', description: 'x' }] })]),
      null,
      'max',
      OBSERVED,
    );
    assert.equal(unsupported.models[0]?.defaultEffort, null);

    const nonDefault = parseMuseModelCatalog(
      catalog([row({ model_id: 'muse-wonder-1.0', is_default: true }), row({ model_id: 'muse-spark-1.3' })]),
      'muse-wonder-1.0',
      'max',
      OBSERVED,
    );
    assert.equal(nonDefault.models[1]?.defaultEffort, null);
  });

  it('keeps efforts in the provider order and yields an empty list when none are given', () => {
    const result = parseMuseModelCatalog(
      catalog([
        row({ model_id: 'muse-a', reasoning_effort_variants: [{ tier: 'high', description: '' }, { tier: 'low', description: '' }] }),
        row({ model_id: 'muse-b', reasoning_effort_variants: undefined }),
      ]),
      null,
      null,
      OBSERVED,
    );
    assert.deepEqual(result.models[0]?.efforts, ['high', 'low']);
    assert.deepEqual(result.models[1]?.efforts, []);
  });

  it('removes duplicate effort tiers, keeping the first-seen order', () => {
    const result = parseMuseModelCatalog(
      catalog([
        row({
          model_id: 'muse-a',
          reasoning_effort_variants: [
            { tier: 'low', description: '' },
            { tier: 'high', description: '' },
            { tier: 'low', description: 'again' },
          ],
        }),
      ]),
      null,
      null,
      OBSERVED,
    );
    assert.deepEqual(result.models[0]?.efforts, ['low', 'high']);
  });

  it('maps a non-numeric context_limit to null', () => {
    const result = parseMuseModelCatalog(
      catalog([
        row({ model_id: 'muse-a', context_limit: '1007997' }),
        row({ model_id: 'muse-b', context_limit: null }),
        row({ model_id: 'muse-c', context_limit: 262144 }),
      ]),
      null,
      null,
      OBSERVED,
    );
    assert.deepEqual(
      result.models.map((model) => model.contextTokens),
      [null, null, 262144],
    );
  });

  it('returns an error for a wrong shape or when no row is visible', () => {
    const expected = {
      provider: 'muse',
      status: 'error',
      models: [],
      source: 'cached',
      observedAt: OBSERVED,
      message: 'unrecognised muse model catalogue format',
      modelFlag: '--model <id>',
      effortFlag: '--reasoning-effort <level>',
    };
    assert.deepEqual(parseMuseModelCatalog(null, null, null, OBSERVED), expected);
    assert.deepEqual(parseMuseModelCatalog([], null, null, OBSERVED), expected);
    assert.deepEqual(parseMuseModelCatalog({ rows: 'nope' }, null, null, OBSERVED), expected);
    assert.deepEqual(
      parseMuseModelCatalog(catalog([row({ visibility: 'hidden' })]), null, null, OBSERVED),
      expected,
    );
    assert.deepEqual(parseMuseModelCatalog(catalog([]), null, null, OBSERVED), expected);
  });
});

describe('fetchMuseModels', () => {
  let homeDir: string;
  const now = () => new Date('2026-11-13T15:00:00.000Z');
  const options = (dir: string): QuotaFetchOptions => ({ timeoutMs: 1000, now, homeDir: dir });
  const catalogDir = (dir: string): string => join(dir, '.local', 'share', 'muse', 'model-catalog');
  const settingsPath = (dir: string): string => join(dir, '.config', 'muse', 'settings.json');

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'models-muse-test-'));
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('uses the newest catalogue file by mtime and reports its mtime as observedAt', async () => {
    const dir = await mkdtemp(join(homeDir, 'newest-'));
    await mkdir(catalogDir(dir), { recursive: true });
    const oldFile = join(catalogDir(dir), 'old__p1.json');
    const newFile = join(catalogDir(dir), 'new__p2.json');
    await writeFile(oldFile, JSON.stringify(catalog([row({ model_id: 'muse-old-1.0' })])));
    await writeFile(newFile, JSON.stringify(catalog([row({ model_id: 'muse-new-1.0' })])));
    await utimes(oldFile, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));
    await utimes(newFile, new Date('2026-11-01T08:30:00.000Z'), new Date('2026-11-01T08:30:00.000Z'));

    const result = await fetchMuseModels(options(dir));
    assert.equal(result.status, 'ok');
    assert.equal(result.source, 'cached');
    assert.equal(result.observedAt, '2026-11-01T08:30:00.000Z');
    assert.deepEqual(
      result.models.map((model) => model.id),
      ['muse-new-1.0'],
    );
  });

  it('breaks equal mtimes by file name, descending, regardless of listing order', async () => {
    const dir = await mkdtemp(join(homeDir, 'tie-'));
    await mkdir(catalogDir(dir), { recursive: true });
    const sameTime = new Date('2026-06-01T12:00:00.000Z');
    const aFile = join(catalogDir(dir), 'a__p1.json');
    const zFile = join(catalogDir(dir), 'z__p2.json');
    await writeFile(aFile, JSON.stringify(catalog([row({ model_id: 'muse-from-a' })])));
    await writeFile(zFile, JSON.stringify(catalog([row({ model_id: 'muse-from-z' })])));
    await utimes(aFile, sameTime, sameTime);
    await utimes(zFile, sameTime, sameTime);

    const result = await fetchMuseModels(options(dir));
    assert.equal(result.observedAt, sameTime.toISOString());
    assert.deepEqual(
      result.models.map((model) => model.id),
      ['muse-from-z'],
    );
  });

  it('returns unavailable when the catalogue directory is missing', async () => {
    const dir = await mkdtemp(join(homeDir, 'missing-'));
    const result = await fetchMuseModels(options(dir));
    assert.deepEqual(result, {
      provider: 'muse',
      status: 'unavailable',
      models: [],
      source: 'cached',
      observedAt: now().toISOString(),
      message: 'muse model catalogue not found (open muse once to create it)',
      modelFlag: '--model <id>',
      effortFlag: '--reasoning-effort <level>',
    });
  });

  it('returns unavailable when the catalogue directory holds no json file', async () => {
    const dir = await mkdtemp(join(homeDir, 'empty-'));
    await mkdir(catalogDir(dir), { recursive: true });
    await writeFile(join(catalogDir(dir), 'notes.txt'), 'x');
    const result = await fetchMuseModels(options(dir));
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.models, []);
  });

  it('tolerates an invalid settings.json by using is_default and null settings', async () => {
    const dir = await mkdtemp(join(homeDir, 'badsettings-'));
    await mkdir(catalogDir(dir), { recursive: true });
    await writeFile(
      join(catalogDir(dir), 'cat__p1.json'),
      JSON.stringify(catalog([row({ model_id: 'muse-wonder-1.0', is_default: true })])),
    );
    await mkdir(join(dir, '.config', 'muse'), { recursive: true });
    await writeFile(settingsPath(dir), '{not json');

    const result = await fetchMuseModels(options(dir));
    assert.equal(result.status, 'ok');
    assert.equal(result.models[0]?.isDefault, true);
    assert.equal(result.models[0]?.defaultEffort, null);
  });

  it('applies settings model and reasoning_effort from a valid settings.json', async () => {
    const dir = await mkdtemp(join(homeDir, 'settings-'));
    await mkdir(catalogDir(dir), { recursive: true });
    await writeFile(
      join(catalogDir(dir), 'cat__p1.json'),
      JSON.stringify(
        catalog([
          row({ model_id: 'muse-wonder-1.0', is_default: true }),
          row({ model_id: 'muse-spark-1.3' }),
        ]),
      ),
    );
    await mkdir(join(dir, '.config', 'muse'), { recursive: true });
    await writeFile(settingsPath(dir), JSON.stringify({ model: 'muse-spark-1.3', reasoning_effort: 'max' }));

    const result = await fetchMuseModels(options(dir));
    assert.equal(result.models[0]?.isDefault, false);
    assert.equal(result.models[1]?.isDefault, true);
    assert.equal(result.models[1]?.defaultEffort, 'max');
  });

  it('returns error with a message when the newest file is not a catalogue', async () => {
    const dir = await mkdtemp(join(homeDir, 'badformat-'));
    await mkdir(catalogDir(dir), { recursive: true });
    await writeFile(join(catalogDir(dir), 'cat__p1.json'), JSON.stringify({ something: 'else' }));
    const result = await fetchMuseModels(options(dir));
    assert.equal(result.status, 'error');
    assert.equal(result.message, 'unrecognised muse model catalogue format');
    assert.deepEqual(result.models, []);
  });
});
