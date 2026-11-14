import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claudeCatalogExpiry, fetchClaudeModels, parseClaudeCcCatalog, parseClaudeModelCatalog } from './models-claude.js';
import type { QuotaFetchOptions } from './types.js';

const OBSERVED = '2026-11-13T09:00:00.000Z';
const NOW = new Date('2026-11-13T10:00:00.000Z');

function entry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Name ${id}`,
    description: `About ${id}`,
    section: 'main',
    runtime: {
      max_input_tokens: 1000000,
      effort_levels: ['low', 'medium', 'high'],
      default_effort: 'medium',
    },
    ...overrides,
  };
}

function ccEntry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Name ${id}`,
    description: `About ${id}`,
    section: 'main',
    thinking: {
      type: 'effort',
      effort_options: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
    },
    runtime: {
      max_input_tokens: 1000000,
      default_effort: 'medium',
    },
    ...overrides,
  };
}

function catalogue(
  models: unknown[],
  options: { defaultModel?: string; aliases?: Record<string, { default: string }>; expiresAt?: string } = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    ...(options.expiresAt === undefined ? {} : { expires_at: options.expiresAt }),
    surfaces: {
      cc: {
        model_selector_state: [{ id: 'cc', model: options.defaultModel ?? 'claude-opus-5-5' }],
        model_selector_config: [
          {
            id: 'cc',
            models,
            provider_alias_targets: options.aliases ?? {
              fable: { default: 'claude-fable-5-2' },
              opus: { default: 'claude-opus-5-5' },
              sonnet: { default: 'claude-sonnet-5-5' },
            },
          },
        ],
      },
    },
  };
}

function ccCatalogue(
  models: unknown[],
  options: {
    defaultModel?: string;
    aliases?: Record<string, { default: string }>;
    fetchedAt?: number;
    staleAt?: number;
  } = {},
): Record<string, unknown> {
  return {
    version: 2,
    fetchedAt: options.fetchedAt ?? NOW.getTime(),
    staleAt: options.staleAt ?? NOW.getTime() + 3600_000,
    catalog: {
      surface: 'cc',
      config: {
        id: 'cc',
        models,
        provider_alias_targets: options.aliases ?? {
          fable: { default: 'claude-fable-5-2' },
          opus: { default: 'claude-opus-5-5' },
          sonnet: { default: 'claude-sonnet-5-5' },
        },
      },
      state: {
        id: 'cc',
        model: options.defaultModel ?? 'claude-opus-5-5',
      },
    },
  };
}

function fileFor(doc: unknown): Record<string, unknown> {
  return { version: 2, documentBytes: Buffer.from(JSON.stringify(doc)).toString('base64') };
}

const SAMPLE_MODELS = [
  entry('claude-opus-5-5', { name: 'Opus 5.5' }),
  entry('claude-sonnet-5-5', { name: 'Sonnet 5.5' }),
  entry('claude-fable-5-2', { name: 'Fable 5.2' }),
  entry('claude-haiku-5-5', { name: 'Haiku 5.5', runtime: { max_input_tokens: 200000 } }),
];

const SAMPLE_CC_MODELS = [
  ccEntry('claude-opus-5-5', { name: 'Opus 5.5' }),
  ccEntry('claude-fable-5-2', { name: 'Fable 5.2' }),
  ccEntry('claude-sonnet-5-5', { name: 'Sonnet 5.5' }),
  ccEntry('claude-haiku-4-5-20251001', {
    name: 'Haiku 4.5',
    description: null,
    thinking: { type: 'none' },
    runtime: { max_input_tokens: 200000 },
  }),
];

describe('parseClaudeModelCatalog', () => {
  it('maps entries in catalogue order with the provider metadata', () => {
    const result = parseClaudeModelCatalog(fileFor(catalogue(SAMPLE_MODELS)), null, OBSERVED);
    assert.equal(result.provider, 'claude');
    assert.equal(result.status, 'ok');
    assert.equal(result.source, 'cached');
    assert.equal(result.observedAt, OBSERVED);
    assert.equal(result.message, null);
    assert.equal(result.modelFlag, '--model <id>');
    assert.equal(result.effortFlag, '--effort <level>');
    assert.deepEqual(
      result.models.map((model) => model.id),
      ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-haiku-5-5'],
    );
    assert.deepEqual(result.models[0], {
      id: 'claude-opus-5-5',
      name: 'Opus 5.5',
      isDefault: true,
      description: 'About claude-opus-5-5',
      contextTokens: 1000000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
    });
  });

  it('resolves a settings alias through the alias targets to exactly one default', () => {
    const result = parseClaudeModelCatalog(fileFor(catalogue(SAMPLE_MODELS)), 'fable', OBSERVED);
    assert.deepEqual(
      result.models.map((model) => model.isDefault),
      [false, false, true, false],
    );
  });

  it('strips a trailing bracket suffix such as [1m] before resolving', () => {
    const result = parseClaudeModelCatalog(fileFor(catalogue(SAMPLE_MODELS)), 'sonnet[1m]', OBSERVED);
    assert.deepEqual(
      result.models.map((model) => model.isDefault),
      [false, true, false, false],
    );
  });

  it('accepts a full model id in settings', () => {
    const result = parseClaudeModelCatalog(
      fileFor(catalogue(SAMPLE_MODELS)),
      'claude-haiku-5-5[1m]',
      OBSERVED,
    );
    assert.deepEqual(
      result.models.map((model) => model.isDefault),
      [false, false, false, true],
    );
  });

  it('falls back to the catalogue default when the settings model matches nothing', () => {
    const result = parseClaudeModelCatalog(fileFor(catalogue(SAMPLE_MODELS)), 'no-such-model', OBSERVED);
    assert.equal(result.status, 'ok');
    assert.deepEqual(
      result.models.map((model) => model.isDefault),
      [true, false, false, false],
    );
  });

  it('uses the catalogue default when settings is null', () => {
    const result = parseClaudeModelCatalog(
      fileFor(catalogue(SAMPLE_MODELS, { defaultModel: 'claude-haiku-5-5' })),
      null,
      OBSERVED,
    );
    assert.deepEqual(
      result.models.map((model) => model.isDefault),
      [false, false, false, true],
    );
  });

  it('marks no model default when neither settings nor the catalogue default resolves', () => {
    const result = parseClaudeModelCatalog(
      fileFor(catalogue(SAMPLE_MODELS, { defaultModel: 'claude-gone-1' })),
      'missing',
      OBSERVED,
    );
    assert.equal(result.status, 'ok');
    assert.ok(result.models.every((model) => !model.isDefault));
  });

  it('maps a non-numeric or missing max_input_tokens to null', () => {
    const result = parseClaudeModelCatalog(
      fileFor(
        catalogue([
          entry('claude-a', { runtime: { max_input_tokens: '1000000' } }),
          entry('claude-b', { runtime: { max_input_tokens: null } }),
          entry('claude-c', { runtime: {} }),
        ]),
      ),
      null,
      OBSERVED,
    );
    assert.deepEqual(
      result.models.map((model) => model.contextTokens),
      [null, null, null],
    );
  });

  it('gives null name, description and default effort when absent, and [] efforts when unstated', () => {
    const bare = { id: 'claude-bare', runtime: { max_input_tokens: 5 } };
    const result = parseClaudeModelCatalog(
      fileFor(catalogue([bare], { defaultModel: 'claude-bare' })),
      null,
      OBSERVED,
    );
    assert.deepEqual(result.models[0], {
      id: 'claude-bare',
      name: null,
      isDefault: true,
      description: null,
      contextTokens: 5,
      efforts: [],
      defaultEffort: null,
    });
  });

  it('returns error for bad base64', () => {
    const result = parseClaudeModelCatalog({ documentBytes: '@@not base64!!' }, null, OBSERVED);
    assertUnrecognised(result);
  });

  it('returns error when the decoded bytes are not JSON', () => {
    const bytes = Buffer.from('not json at all').toString('base64');
    assertUnrecognised(parseClaudeModelCatalog({ documentBytes: bytes }, null, OBSERVED));
  });

  it('returns error for a wrong shape', () => {
    assertUnrecognised(parseClaudeModelCatalog(fileFor({ surfaces: {} }), null, OBSERVED));
    assertUnrecognised(parseClaudeModelCatalog(fileFor(catalogue([])), null, OBSERVED));
    assertUnrecognised(parseClaudeModelCatalog(fileFor(catalogue([{ name: 'no id' }])), null, OBSERVED));
    assertUnrecognised(parseClaudeModelCatalog(null, null, OBSERVED));
    assertUnrecognised(parseClaudeModelCatalog('text', null, OBSERVED));
  });
});

function assertUnrecognised(result: { status: string; models: unknown[]; message: string | null }): void {
  assert.equal(result.status, 'error');
  assert.deepEqual(result.models, []);
  assert.equal(result.message, 'unrecognised Claude model catalogue format');
}

describe('parseClaudeCcCatalog', () => {
  it('maps entries in catalogue order with provider metadata', () => {
    const result = parseClaudeCcCatalog(ccCatalogue(SAMPLE_CC_MODELS), null, OBSERVED);
    assert.equal(result.provider, 'claude');
    assert.equal(result.status, 'ok');
    assert.equal(result.source, 'cached');
    assert.equal(result.observedAt, OBSERVED);
    assert.equal(result.message, null);
    assert.equal(result.modelFlag, '--model <id>');
    assert.equal(result.effortFlag, '--effort <level>');
    assert.deepEqual(
      result.models.map((model) => model.id),
      ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'],
    );
    assert.deepEqual(result.models[0], {
      id: 'claude-opus-5-5',
      name: 'Opus 5.5',
      isDefault: true,
      description: 'About claude-opus-5-5',
      contextTokens: 1000000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
    });
  });

  it('maps thinking: none to empty efforts and null defaultEffort', () => {
    const result = parseClaudeCcCatalog(ccCatalogue(SAMPLE_CC_MODELS), null, OBSERVED);
    const haiku = result.models.find((m) => m.id === 'claude-haiku-4-5-20251001');
    assert.ok(haiku);
    assert.deepEqual(haiku.efforts, []);
    assert.equal(haiku.defaultEffort, null);
    assert.equal(haiku.description, null);
    assert.equal(haiku.contextTokens, 200000);
  });

  it('resolves a settings alias to default model', () => {
    const result = parseClaudeCcCatalog(ccCatalogue(SAMPLE_CC_MODELS), 'fable', OBSERVED);
    assert.deepEqual(
      result.models.map((model) => model.isDefault),
      [false, true, false, false],
    );
  });

  it('strips a trailing bracket suffix before resolving settings model', () => {
    const result = parseClaudeCcCatalog(ccCatalogue(SAMPLE_CC_MODELS), 'sonnet[1m]', OBSERVED);
    assert.deepEqual(
      result.models.map((model) => model.isDefault),
      [false, false, true, false],
    );
  });

  it('falls back to state default when settings model matches nothing', () => {
    const result = parseClaudeCcCatalog(ccCatalogue(SAMPLE_CC_MODELS), 'no-such-model', OBSERVED);
    assert.deepEqual(
      result.models.map((model) => model.isDefault),
      [true, false, false, false],
    );
  });

  it('nulls defaultEffort when declared default is not among effort_options', () => {
    const doc = ccCatalogue([
      ccEntry('claude-invalid-default', {
        thinking: {
          type: 'effort',
          effort_options: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }],
        },
        runtime: { default_effort: 'max' },
      }),
    ]);
    const result = parseClaudeCcCatalog(doc, null, OBSERVED);
    assert.equal(result.models[0].defaultEffort, null);
  });

  it('returns error for wrong shape or wrong surface', () => {
    assertUnrecognised(parseClaudeCcCatalog({ catalog: { surface: 'other', config: { models: [] } } }, null, OBSERVED));
    assertUnrecognised(parseClaudeCcCatalog({ catalog: { surface: 'cc', config: { models: [] } } }, null, OBSERVED));
    assertUnrecognised(parseClaudeCcCatalog({ catalog: { surface: 'cc', config: { models: [{ name: 'no id' }] } } }, null, OBSERVED));
    assertUnrecognised(parseClaudeCcCatalog(null, null, OBSERVED));
    assertUnrecognised(parseClaudeCcCatalog('invalid', null, OBSERVED));
  });

  it('is also parsed via parseClaudeModelCatalog when given cc format', () => {
    const result = parseClaudeModelCatalog(ccCatalogue(SAMPLE_CC_MODELS), null, OBSERVED);
    assert.equal(result.status, 'ok');
    assert.equal(result.models.length, 4);
    assert.equal(result.models[0].id, 'claude-opus-5-5');
  });
});

describe('fetchClaudeModels', () => {
  async function withHome(run: (home: string) => Promise<void>): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), 'models-claude-'));
    try {
      await run(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  function optionsFor(home: string): QuotaFetchOptions {
    return { timeoutMs: 1000, now: () => NOW, homeDir: home };
  }

  async function writeCatalogue(home: string, name: string, mtime: Date, doc: unknown): Promise<void> {
    const dir = join(home, '.claude', 'cache', 'model-catalog');
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, JSON.stringify(fileFor(doc)));
    await utimes(path, mtime, mtime);
  }

  async function writeCcCatalogue(home: string, name: string, mtime: Date, doc: unknown): Promise<void> {
    const dir = join(home, '.claude', 'cache', 'model-catalog');
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, typeof doc === 'string' ? doc : JSON.stringify(doc));
    await utimes(path, mtime, mtime);
  }

  it('reports unavailable when the catalogue directory is missing', async () => {
    await withHome(async (home) => {
      const result = await fetchClaudeModels(optionsFor(home));
      assert.equal(result.status, 'unavailable');
      assert.deepEqual(result.models, []);
      assert.equal(result.provider, 'claude');
      assert.equal(result.message, 'Claude model catalogue not found (open claude once to create it)');
      assert.equal(result.observedAt, NOW.toISOString());
    });
  });

  it('reports unavailable when the directory holds no published file', async () => {
    await withHome(async (home) => {
      await mkdir(join(home, '.claude', 'cache', 'model-catalog'), { recursive: true });
      const result = await fetchClaudeModels(optionsFor(home));
      assert.equal(result.status, 'unavailable');
    });
  });

  it('reads the newest published file by mtime and uses its mtime as observedAt', async () => {
    await withHome(async (home) => {
      await writeCatalogue(
        home,
        'published-aaa.json',
        new Date('2026-11-01T00:00:00.000Z'),
        catalogue([entry('claude-old')]),
      );
      const newerMtime = new Date('2026-11-12T08:30:00.000Z');
      await writeCatalogue(home, 'published-bbb.json', newerMtime, catalogue([entry('claude-new')]));
      await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-new' }));

      const result = await fetchClaudeModels(optionsFor(home));
      assert.equal(result.status, 'ok');
      assert.equal(result.source, 'cached');
      assert.equal(result.observedAt, newerMtime.toISOString());
      assert.deepEqual(
        result.models.map((model) => [model.id, model.isDefault]),
        [['claude-new', true]],
      );
    });
  });

  it('tolerates an invalid settings.json by treating the model as null', async () => {
    await withHome(async (home) => {
      await writeCatalogue(home, 'published-x.json', new Date('2026-11-12T00:00:00.000Z'), catalogue(SAMPLE_MODELS));
      await writeFile(join(home, '.claude', 'settings.json'), '{ not valid json');

      const result = await fetchClaudeModels(optionsFor(home));
      assert.equal(result.status, 'ok');
      assert.deepEqual(
        result.models.map((model) => model.isDefault),
        [true, false, false, false],
      );
    });
  });

  it('uses an older real catalogue when the newest published file is a tiny non-catalogue file', async () => {
    await withHome(async (home) => {
      await writeCatalogue(home, 'published-old.json', new Date('2026-11-10T00:00:00.000Z'), catalogue(SAMPLE_MODELS));
      const dir = join(home, '.claude', 'cache', 'model-catalog');
      const floorPath = join(dir, 'published-floor.json');
      await writeFile(floorPath, JSON.stringify({ floor: 1 }));
      const newer = new Date('2026-11-12T00:00:00.000Z');
      await utimes(floorPath, newer, newer);

      const result = await fetchClaudeModels(optionsFor(home));
      assert.equal(result.status, 'ok');
      assert.equal(result.observedAt, new Date('2026-11-10T00:00:00.000Z').toISOString());
      assert.equal(result.models.length, SAMPLE_MODELS.length);
      assert.equal(result.message, null);
    });
  });

  it('nulls defaultEffort when the declared default is not among the effort levels', () => {
    const doc = catalogue([
      entry('claude-limited', { runtime: { max_input_tokens: 5, effort_levels: ['low', 'medium'], default_effort: 'xhigh' } }),
      entry('claude-none', { runtime: { max_input_tokens: 5, default_effort: 'medium' } }),
      entry('claude-ok', { runtime: { max_input_tokens: 5, effort_levels: ['low', 'medium'], default_effort: 'medium' } }),
    ]);
    const result = parseClaudeModelCatalog(fileFor(doc), null, OBSERVED);
    assert.deepEqual(
      result.models.map((model) => [model.id, model.defaultEffort]),
      [
        ['claude-limited', null],
        ['claude-none', null],
        ['claude-ok', 'medium'],
      ],
    );
  });

  it('skips a candidate that disappears between listing and stat, and uses the next one', async () => {
    await withHome(async (home) => {
      await writeCatalogue(home, 'published-keep.json', new Date('2026-11-09T00:00:00.000Z'), catalogue(SAMPLE_MODELS));
      const dir = join(home, '.claude', 'cache', 'model-catalog');
      // A dangling symlink is listed by readdir but fails stat with ENOENT.
      await symlink(join(dir, 'missing-target.json'), join(dir, 'published-gone.json'));

      const result = await fetchClaudeModels(optionsFor(home));
      assert.equal(result.status, 'ok');
      assert.equal(result.models.length, SAMPLE_MODELS.length);
      assert.equal(result.observedAt, new Date('2026-11-09T00:00:00.000Z').toISOString());
    });
  });

  it('returns error when every candidate is unreadable, unparseable or the wrong shape', async () => {
    await withHome(async (home) => {
      const dir = join(home, '.claude', 'cache', 'model-catalog');
      await mkdir(join(dir, 'published-dir.json'), { recursive: true });
      await writeFile(join(dir, 'published-text.json'), 'not json');
      await writeFile(join(dir, 'published-shape.json'), JSON.stringify({ floor: 1 }));
      const result = await fetchClaudeModels(optionsFor(home));
      assert.equal(result.status, 'error');
      assert.deepEqual(result.models, []);
      assert.equal(result.message, 'unrecognised Claude model catalogue format');
    });
  });

  it('keeps the models but reports expiry when the catalogue expired before now', async () => {
    await withHome(async (home) => {
      await writeCatalogue(
        home,
        'published-exp.json',
        new Date('2026-11-01T00:00:00.000Z'),
        catalogue(SAMPLE_MODELS, { expiresAt: '2026-11-01T09:37:50Z' }),
      );
      const result = await fetchClaudeModels(optionsFor(home));
      assert.equal(result.status, 'ok');
      assert.equal(result.models.length, SAMPLE_MODELS.length);
      assert.equal(result.message, 'Claude model catalogue expired on 2026-11-01; open claude to refresh it');
    });
  });

  it('reports no message when the catalogue has not expired', async () => {
    await withHome(async (home) => {
      await writeCatalogue(
        home,
        'published-live.json',
        new Date('2026-11-12T00:00:00.000Z'),
        catalogue(SAMPLE_MODELS, { expiresAt: '2026-11-20T09:37:50Z' }),
      );
      const result = await fetchClaudeModels(optionsFor(home));
      assert.equal(result.status, 'ok');
      assert.equal(result.message, null);
    });
  });

  it('prefers a cc catalogue over a published catalogue with fewer models', async () => {
    await withHome(async (home) => {
      await writeCatalogue(
        home,
        'published-few.json',
        new Date('2026-11-12T00:00:00.000Z'),
        catalogue([entry('claude-fable-5-1')]),
      );
      await writeCcCatalogue(
        home,
        'account-hash-cc.json',
        new Date('2026-11-10T00:00:00.000Z'),
        ccCatalogue([
          ccEntry('claude-opus-5-5'),
          ccEntry('claude-fable-5-2'),
          ccEntry('claude-sonnet-5-5'),
        ]),
      );

      const result = await fetchClaudeModels(optionsFor(home));
      assert.equal(result.status, 'ok');
      assert.equal(result.models.length, 3);
      assert.deepEqual(
        result.models.map((m) => m.id),
        ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5'],
      );
    });
  });

  it('falls back to published catalogue when cc catalogue is unparseable', async () => {
    await withHome(async (home) => {
      await writeCatalogue(
        home,
        'published-ok.json',
        new Date('2026-11-10T00:00:00.000Z'),
        catalogue([entry('claude-opus-5-5'), entry('claude-sonnet-5-5')]),
      );
      await writeCcCatalogue(
        home,
        'bad-cc.json',
        new Date('2026-11-12T00:00:00.000Z'),
        '{ corrupted json',
      );

      const result = await fetchClaudeModels(optionsFor(home));
      assert.equal(result.status, 'ok');
      assert.deepEqual(
        result.models.map((m) => m.id),
        ['claude-opus-5-5', 'claude-sonnet-5-5'],
      );
    });
  });

  it('preserves unchanged behaviour when only published catalogues exist', async () => {
    await withHome(async (home) => {
      await writeCatalogue(
        home,
        'published-only.json',
        new Date('2026-11-10T00:00:00.000Z'),
        catalogue(SAMPLE_MODELS),
      );

      const result = await fetchClaudeModels(optionsFor(home));
      assert.equal(result.status, 'ok');
      assert.equal(result.models.length, SAMPLE_MODELS.length);
      assert.deepEqual(
        result.models.map((m) => m.id),
        ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-haiku-5-5'],
      );
    });
  });

  it('prefers newest cc catalogue by fetchedAt over mtime', async () => {
    await withHome(async (home) => {
      await writeCcCatalogue(
        home,
        'older-fetched-cc.json',
        new Date('2026-11-12T00:00:00.000Z'),
        ccCatalogue([ccEntry('claude-from-older-fetch')], { fetchedAt: 1000 }),
      );
      await writeCcCatalogue(
        home,
        'newer-fetched-cc.json',
        new Date('2026-11-10T00:00:00.000Z'),
        ccCatalogue([ccEntry('claude-from-newer-fetch')], { fetchedAt: 2000 }),
      );

      const result = await fetchClaudeModels(optionsFor(home));
      assert.equal(result.status, 'ok');
      assert.deepEqual(
        result.models.map((m) => m.id),
        ['claude-from-newer-fetch'],
      );
    });
  });

  it('breaks ties on fetchedAt by mtime', async () => {
    await withHome(async (home) => {
      await writeCcCatalogue(
        home,
        'older-mtime-cc.json',
        new Date('2026-11-05T00:00:00.000Z'),
        ccCatalogue([ccEntry('claude-older-mtime')], { fetchedAt: 5000 }),
      );
      await writeCcCatalogue(
        home,
        'newer-mtime-cc.json',
        new Date('2026-11-10T00:00:00.000Z'),
        ccCatalogue([ccEntry('claude-newer-mtime')], { fetchedAt: 5000 }),
      );

      const result = await fetchClaudeModels(optionsFor(home));
      assert.equal(result.status, 'ok');
      assert.deepEqual(
        result.models.map((m) => m.id),
        ['claude-newer-mtime'],
      );
    });
  });

  it('reports expiry when cc catalogue staleAt is in the past', async () => {
    await withHome(async (home) => {
      const pastStaleAt = Date.parse('2026-11-01T08:00:00.000Z');
      await writeCcCatalogue(
        home,
        'stale-cc.json',
        new Date('2026-11-01T08:00:00.000Z'),
        ccCatalogue(SAMPLE_CC_MODELS, { staleAt: pastStaleAt }),
      );

      const result = await fetchClaudeModels(optionsFor(home));
      assert.equal(result.status, 'ok');
      assert.equal(result.models.length, SAMPLE_CC_MODELS.length);
      assert.equal(result.message, 'Claude model catalogue expired on 2026-11-01; open claude to refresh it');
    });
  });

  it('reports no message when cc catalogue staleAt is in the future', async () => {
    await withHome(async (home) => {
      const futureStaleAt = Date.parse('2026-11-20T08:00:00.000Z');
      await writeCcCatalogue(
        home,
        'fresh-cc.json',
        new Date('2026-11-12T00:00:00.000Z'),
        ccCatalogue(SAMPLE_CC_MODELS, { staleAt: futureStaleAt }),
      );

      const result = await fetchClaudeModels(optionsFor(home));
      assert.equal(result.status, 'ok');
      assert.equal(result.models.length, SAMPLE_CC_MODELS.length);
      assert.equal(result.message, null);
    });
  });
});

describe('claudeCatalogExpiry', () => {
  it('returns the expires_at as an ISO instant', () => {
    assert.equal(
      claudeCatalogExpiry(fileFor(catalogue(SAMPLE_MODELS, { expiresAt: '2026-11-20T09:37:50Z' }))),
      '2026-11-20T09:37:50.000Z',
    );
  });

  it('returns numeric staleAt as an ISO instant', () => {
    assert.equal(
      claudeCatalogExpiry({ staleAt: 1794644369607 }),
      '2026-11-14T08:19:29.607Z',
    );
  });

  it('returns string staleAt as an ISO instant', () => {
    assert.equal(
      claudeCatalogExpiry({ staleAt: '2026-11-14T08:19:29.607Z' }),
      '2026-11-14T08:19:29.607Z',
    );
  });

  it('returns null when staleAt is invalid', () => {
    assert.equal(claudeCatalogExpiry({ staleAt: 'invalid-date' }), null);
    assert.equal(claudeCatalogExpiry({ staleAt: NaN }), null);
  });

  it('returns null when expires_at is absent', () => {
    assert.equal(claudeCatalogExpiry(fileFor(catalogue(SAMPLE_MODELS))), null);
  });

  it('returns null when expires_at does not parse', () => {
    assert.equal(claudeCatalogExpiry(fileFor(catalogue(SAMPLE_MODELS, { expiresAt: 'soon' }))), null);
  });

  it('returns null for a non-catalogue file', () => {
    assert.equal(claudeCatalogExpiry({ floor: 1 }), null);
    assert.equal(claudeCatalogExpiry({ documentBytes: '@@' }), null);
    assert.equal(claudeCatalogExpiry(null), null);
  });
});
