import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCodexConfigDefaults, parseCodexModels } from './models-codex.js';

const OBSERVED = '2026-11-13T10:00:00.000Z';

/** One entry in the verified `codex debug models` shape. */
function catalogueEntry(
  slug: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    slug,
    display_name: slug.toUpperCase(),
    description: `${slug} description`,
    default_reasoning_level: 'low',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast' },
      { effort: 'medium', description: 'Balanced' },
      { effort: 'high', description: 'Deep' },
    ],
    visibility: 'list',
    context_window: 272000,
    max_context_window: 872000,
    ...overrides,
  };
}

const CATALOGUE = {
  models: [
    catalogueEntry('gpt-6.1-sol', {
      context_window: 500000,
      default_reasoning_level: 'low',
    }),
    catalogueEntry('gpt-6-astra', {
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low', description: 'x' },
        { effort: 'medium', description: 'x' },
        { effort: 'xhigh', description: 'x' },
        { effort: 'max', description: 'x' },
      ],
    }),
    catalogueEntry('gpt-reserve', { visibility: 'hide' }),
    catalogueEntry('codex-auto-review', { visibility: 'hide' }),
  ],
};

describe('parseCodexModels', () => {
  it('maps the verified shape, excluding hidden entries', () => {
    const result = parseCodexModels(CATALOGUE, null, null, 'live', OBSERVED);
    assert.equal(result.provider, 'codex');
    assert.equal(result.status, 'ok');
    assert.equal(result.message, null);
    assert.equal(result.source, 'live');
    assert.equal(result.observedAt, OBSERVED);
    assert.equal(result.modelFlag, '-m <id>');
    assert.equal(result.effortFlag, '-c model_reasoning_effort=<level>');
    assert.deepEqual(
      result.models.map((m) => m.id),
      ['gpt-6.1-sol', 'gpt-6-astra'],
    );
  });

  it('takes id from slug, name from display_name, and the usable context_window', () => {
    const [first] = parseCodexModels(CATALOGUE, null, null, 'live', OBSERVED).models;
    assert.deepEqual(first, {
      id: 'gpt-6.1-sol',
      name: 'GPT-6.1-SOL',
      isDefault: false,
      description: 'gpt-6.1-sol description',
      contextTokens: 500000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'low',
    });
  });

  it('falls back to max_context_window only when context_window is absent', () => {
    const data = {
      models: [
        catalogueEntry('only-max', { context_window: undefined, max_context_window: 400000 }),
        catalogueEntry('neither', { context_window: undefined, max_context_window: undefined }),
        catalogueEntry('bad-window', { context_window: 'big', max_context_window: 900000 }),
      ],
    };
    const result = parseCodexModels(data, null, null, 'live', OBSERVED);
    assert.deepEqual(
      result.models.map((m) => m.contextTokens),
      [400000, null, 900000],
    );
  });

  it('sets defaultEffort to null when the own default is not a supported effort', () => {
    const data = {
      models: [
        catalogueEntry('only-low', {
          default_reasoning_level: 'xhigh',
          supported_reasoning_levels: [{ effort: 'low', description: '' }],
        }),
        catalogueEntry('no-efforts', {
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [],
        }),
      ],
    };
    const result = parseCodexModels(data, null, null, 'live', OBSERVED);
    assert.deepEqual(
      result.models.map((m) => m.defaultEffort),
      [null, null],
    );
  });

  it('keeps effort ids in the provider order', () => {
    const astra = parseCodexModels(CATALOGUE, null, null, 'live', OBSERVED).models[1];
    assert.deepEqual(astra?.efforts, ['low', 'medium', 'xhigh', 'max']);
    assert.equal(astra?.defaultEffort, 'medium');
  });

  it('lets the config default model override the source default flag', () => {
    const flagged = {
      models: [
        catalogueEntry('gpt-6.1-sol', { is_default: true }),
        catalogueEntry('gpt-6-astra'),
      ],
    };
    const result = parseCodexModels(flagged, 'gpt-6-astra', null, 'live', OBSERVED);
    assert.deepEqual(
      result.models.map((m) => m.isDefault),
      [false, true],
    );
  });

  it('falls back to the source default flag when the config model is unknown', () => {
    const flagged = {
      models: [catalogueEntry('gpt-6.1-sol'), catalogueEntry('gpt-6-astra', { isDefault: true })],
    };
    const result = parseCodexModels(flagged, 'gpt-not-real', null, 'live', OBSERVED);
    assert.deepEqual(
      result.models.map((m) => m.isDefault),
      [false, true],
    );
  });

  it('marks no model default when neither config nor source names one', () => {
    const result = parseCodexModels(CATALOGUE, null, null, 'live', OBSERVED);
    assert.deepEqual(
      result.models.map((m) => m.isDefault),
      [false, false],
    );
  });

  it('allows at most one default even when the source flags several', () => {
    const flagged = {
      models: [
        catalogueEntry('gpt-6.1-sol', { is_default: true }),
        catalogueEntry('gpt-6-astra', { is_default: true }),
      ],
    };
    const result = parseCodexModels(flagged, null, null, 'live', OBSERVED);
    assert.deepEqual(
      result.models.map((m) => m.isDefault),
      [true, false],
    );
  });

  it('applies the config effort to the default model when it is supported', () => {
    const result = parseCodexModels(CATALOGUE, 'gpt-6.1-sol', 'high', 'live', OBSERVED);
    const [sol, astra] = result.models;
    assert.equal(sol?.defaultEffort, 'high');
    assert.equal(astra?.defaultEffort, 'medium');
  });

  it('keeps the model own default effort when the config effort is not supported', () => {
    const result = parseCodexModels(CATALOGUE, 'gpt-6-astra', 'high', 'live', OBSERVED);
    const astra = result.models[1];
    assert.equal(astra?.isDefault, true);
    assert.equal(astra?.defaultEffort, 'medium');
  });

  it('does not apply the config effort to a non-default model', () => {
    const result = parseCodexModels(CATALOGUE, 'gpt-6.1-sol', 'xhigh', 'live', OBSERVED);
    assert.equal(result.models[1]?.defaultEffort, 'medium');
  });

  it('accepts camelCase keys and a models array wrapped in data', () => {
    const camel = {
      data: [
        {
          model: 'gpt-x',
          displayName: 'GPT X',
          description: null,
          isDefault: true,
          hidden: false,
          contextWindow: 128000,
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [
            { reasoningEffort: 'medium', description: '' },
            { reasoningEffort: 'high', description: '' },
          ],
        },
        { model: 'gpt-hidden', hidden: true },
      ],
    };
    const result = parseCodexModels(camel, null, null, 'cached', OBSERVED);
    assert.equal(result.status, 'ok');
    assert.equal(result.source, 'cached');
    assert.deepEqual(result.models, [
      {
        id: 'gpt-x',
        name: 'GPT X',
        isDefault: true,
        description: null,
        contextTokens: 128000,
        efforts: ['medium', 'high'],
        defaultEffort: 'medium',
      },
    ]);
  });

  it('returns an error when there are no visible models', () => {
    const allHidden = { models: [catalogueEntry('gpt-reserve', { visibility: 'hide' })] };
    for (const data of [[], { models: [] }, allHidden]) {
      const result = parseCodexModels(data, null, null, 'live', OBSERVED);
      assert.equal(result.status, 'error');
      assert.equal(result.message, 'Codex returned no models');
      assert.deepEqual(result.models, []);
    }
  });

  it('returns an error for non-object model data', () => {
    for (const data of [null, undefined, 'gpt-6.1-sol', 42, true]) {
      const result = parseCodexModels(data, null, null, 'live', OBSERVED);
      assert.equal(result.status, 'error');
      assert.equal(result.message, 'unexpected model data from Codex');
      assert.deepEqual(result.models, []);
    }
  });

  it('returns an error when an object has no model array', () => {
    const result = parseCodexModels({ models: 'nope' }, null, null, 'live', OBSERVED);
    assert.equal(result.status, 'error');
    assert.equal(result.message, 'unexpected model data from Codex');
  });
});

describe('parseCodexConfigDefaults', () => {
  it('reads model and model_reasoning_effort with double quotes', () => {
    const toml = 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n';
    assert.deepEqual(parseCodexConfigDefaults(toml), { model: 'gpt-6.1-sol', effort: 'high' });
  });

  it('reads single-quoted values', () => {
    const toml = "model = 'gpt-6-luna'\nmodel_reasoning_effort = 'low'\n";
    assert.deepEqual(parseCodexConfigDefaults(toml), { model: 'gpt-6-luna', effort: 'low' });
  });

  it('ignores keys written inside a multi-line string', () => {
    const toml = [
      'developer_instructions = """',
      'model = "evil"',
      '"""',
      'model = "real"',
    ].join('\n');
    assert.deepEqual(parseCodexConfigDefaults(toml), { model: 'real', effort: null });
  });

  it('ignores keys inside a multi-line literal string and reads after it closes', () => {
    const toml = [
      "notes = '''",
      'model_reasoning_effort = "max"',
      "'''",
      'model = "gpt-6-luna"',
      'model_reasoning_effort = "low"',
    ].join('\n');
    assert.deepEqual(parseCodexConfigDefaults(toml), { model: 'gpt-6-luna', effort: 'low' });
  });

  it('reads keys after a triple-quoted value that closes on the same line', () => {
    const toml = 'notes = """inline"""\nmodel = "gpt-6-luna"\n';
    assert.deepEqual(parseCodexConfigDefaults(toml), { model: 'gpt-6-luna', effort: null });
  });

  it('unescapes \\" and \\\\ in double-quoted values', () => {
    assert.deepEqual(parseCodexConfigDefaults('model = "a\\"b"\n'), {
      model: 'a"b',
      effort: null,
    });
    assert.deepEqual(parseCodexConfigDefaults('model = "c\\\\d"\n'), {
      model: 'c\\d',
      effort: null,
    });
  });

  it('keeps backslashes literal in single-quoted values', () => {
    assert.deepEqual(parseCodexConfigDefaults("model = 'a\\\"b'\n"), {
      model: 'a\\"b',
      effort: null,
    });
  });

  it('ignores full-line and trailing comments', () => {
    const toml = [
      '# model = "gpt-old"',
      'model = "gpt-6.1-sol" # the daily driver',
      '  # model_reasoning_effort = "max"',
      'model_reasoning_effort = "medium"  # not "high"',
    ].join('\n');
    assert.deepEqual(parseCodexConfigDefaults(toml), { model: 'gpt-6.1-sol', effort: 'medium' });
  });

  it('ignores keys inside a later table', () => {
    const toml = [
      'model = "gpt-6.1-sol"',
      '[projects."/some/path"]',
      'model = "gpt-6-astra"',
      'model_reasoning_effort = "max"',
    ].join('\n');
    assert.deepEqual(parseCodexConfigDefaults(toml), { model: 'gpt-6.1-sol', effort: null });
  });

  it('returns null for missing keys and for empty input', () => {
    assert.deepEqual(parseCodexConfigDefaults('approval_policy = "never"\n'), {
      model: null,
      effort: null,
    });
    assert.deepEqual(parseCodexConfigDefaults(''), { model: null, effort: null });
  });

  it('returns null for an unquoted or empty value', () => {
    const toml = 'model = gpt-6.1-sol\nmodel_reasoning_effort = ""\n';
    assert.deepEqual(parseCodexConfigDefaults(toml), { model: null, effort: null });
  });
});
