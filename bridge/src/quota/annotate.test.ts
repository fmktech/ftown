import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { annotatePick, annotateTiers } from './annotate.js';
import type {
  HarnessModel,
  ModelRoutingConfig,
  ProviderModels,
  ProviderQuota,
  ProviderRouting,
  RoutingPick,
} from './types.js';

const NOW = '2026-11-13T12:00:00.000Z';
const RESET = '2026-11-13T15:00:00.000Z';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function model(overrides: Partial<HarnessModel> & Pick<HarnessModel, 'id'>): HarnessModel {
  return {
    name: null,
    isDefault: false,
    description: null,
    contextTokens: null,
    efforts: [],
    defaultEffort: null,
    ...overrides,
  };
}

function modelList(
  overrides: Partial<ProviderModels> & Pick<ProviderModels, 'provider'>,
): ProviderModels {
  return {
    status: 'ok',
    models: [],
    source: 'live',
    observedAt: NOW,
    message: null,
    modelFlag: '--model <id>',
    effortFlag: '--effort <level>',
    ...overrides,
  };
}

function quotaRow(overrides: Partial<ProviderQuota> & Pick<ProviderQuota, 'provider'>): ProviderQuota {
  return {
    status: 'ok',
    plan: null,
    windows: [],
    source: 'live',
    observedAt: NOW,
    message: null,
    ...overrides,
  };
}

function routingRow(overrides: Partial<ProviderRouting> & Pick<ProviderRouting, 'provider'>): ProviderRouting {
  return {
    availability: 'available',
    leftPercent: 80,
    bindingWindow: 'five_hour',
    resetsAt: RESET,
    resetsInMinutes: 180,
    runway: 1.2,
    reason: 'test',
    ...overrides,
  };
}

const pick = (overrides: Partial<RoutingPick> & Pick<RoutingPick, 'provider' | 'model'>): RoutingPick => ({
  effort: null,
  ...overrides,
});

describe('annotatePick', () => {
  it('copies provider, model and effort from the pick', () => {
    const result = annotatePick(pick({ provider: 'claude', model: 'opus', effort: 'high' }), [], [], []);
    assert.equal(result.provider, 'claude');
    assert.equal(result.model, 'opus');
    assert.equal(result.effort, 'high');
  });

  it('takes availability, leftPercent and resetsAt from the routing entry', () => {
    const result = annotatePick(
      pick({ provider: 'codex', model: 'm' }),
      [],
      [routingRow({ provider: 'codex', availability: 'low', leftPercent: 12, resetsAt: RESET })],
      [],
    );
    assert.equal(result.availability, 'low');
    assert.equal(result.leftPercent, 12);
    assert.equal(result.resetsAt, RESET);
  });

  it('uses unknown and nulls when the provider has no routing entry', () => {
    const result = annotatePick(
      pick({ provider: 'grok', model: 'm' }),
      [],
      [routingRow({ provider: 'claude' })],
      [],
    );
    assert.equal(result.availability, 'unknown');
    assert.equal(result.leftPercent, null);
    assert.equal(result.resetsAt, null);
  });

  it('copies scopedLimits from the quota entry', () => {
    const quota = [
      quotaRow({
        provider: 'claude',
        scopedLimits: [{ scope: 'Fable', kind: 'weekly', usedPercent: 40, resetsAt: RESET }],
      }),
    ];
    const result = annotatePick(pick({ provider: 'claude', model: 'm' }), quota, [], []);
    assert.deepEqual(result.scopedLimits, [{ scope: 'Fable', kind: 'weekly', usedPercent: 40, resetsAt: RESET }]);
  });

  it('returns an empty scopedLimits when the quota entry or property is absent', () => {
    const noProperty = annotatePick(
      pick({ provider: 'claude', model: 'm' }),
      [quotaRow({ provider: 'claude' })],
      [],
      [],
    );
    const noEntry = annotatePick(pick({ provider: 'claude', model: 'm' }), [], [], []);
    assert.deepEqual(noProperty.scopedLimits, []);
    assert.deepEqual(noEntry.scopedLimits, []);
  });

  it('does not share scopedLimits objects with the input', () => {
    const quota = [
      quotaRow({
        provider: 'claude',
        scopedLimits: [{ scope: 'Fable', kind: 'weekly', usedPercent: 40, resetsAt: null }],
      }),
    ];
    const result = annotatePick(pick({ provider: 'claude', model: 'm' }), quota, [], []);
    result.scopedLimits[0].usedPercent = 99;
    result.scopedLimits.push({ scope: 'X', kind: 'weekly', usedPercent: null, resetsAt: null });
    assert.equal(quota[0].scopedLimits?.[0].usedPercent, 40);
    assert.equal(quota[0].scopedLimits?.length, 1);
  });

  it('takes modelName from the live list', () => {
    const models = [modelList({ provider: 'claude', models: [model({ id: 'opus', name: 'Opus 5' })] })];
    const result = annotatePick(pick({ provider: 'claude', model: 'opus' }), [], [], models);
    assert.equal(result.modelName, 'Opus 5');
    assert.equal(result.problem, null);
  });

  it('reports a null modelName when the live model has no name', () => {
    const models = [modelList({ provider: 'claude', models: [model({ id: 'opus' })] })];
    const result = annotatePick(pick({ provider: 'claude', model: 'opus' }), [], [], models);
    assert.equal(result.modelName, null);
    assert.equal(result.problem, null);
  });

  it('leaves modelName and problem null when there is no model list for the provider', () => {
    const result = annotatePick(pick({ provider: 'agy', model: 'x', effort: 'high' }), [], [], []);
    assert.equal(result.modelName, null);
    assert.equal(result.problem, null);
  });

  it('leaves modelName and problem null when the model list status is not ok', () => {
    const models = [
      modelList({ provider: 'muse', status: 'unavailable', models: [], message: 'no source' }),
    ];
    const result = annotatePick(pick({ provider: 'muse', model: 'x', effort: 'high' }), [], [], models);
    assert.equal(result.modelName, null);
    assert.equal(result.problem, null);
  });

  it('reports a model the harness no longer offers', () => {
    const models = [modelList({ provider: 'codex', models: [model({ id: 'gpt-a' })] })];
    const result = annotatePick(pick({ provider: 'codex', model: 'gpt-old' }), [], [], models);
    assert.equal(result.modelName, null);
    assert.equal(result.problem, 'codex no longer offers model "gpt-old"');
  });

  it('reports an effort the model does not support', () => {
    const models = [
      modelList({ provider: 'codex', models: [model({ id: 'gpt-a', efforts: ['low', 'medium'] })] }),
    ];
    const result = annotatePick(pick({ provider: 'codex', model: 'gpt-a', effort: 'max' }), [], [], models);
    assert.equal(result.modelName, null);
    assert.equal(result.problem, 'model "gpt-a" does not support effort "max"');
  });

  it('reports an effort on a model that takes no effort setting', () => {
    const models = [modelList({ provider: 'grok', models: [model({ id: 'grok-x', efforts: [] })] })];
    const result = annotatePick(pick({ provider: 'grok', model: 'grok-x', effort: 'high' }), [], [], models);
    assert.equal(result.problem, 'model "grok-x" takes no effort setting');
  });

  it('accepts a supported effort and a null effort', () => {
    const models = [
      modelList({ provider: 'codex', models: [model({ id: 'gpt-a', efforts: ['low', 'medium'] })] }),
    ];
    const supported = annotatePick(pick({ provider: 'codex', model: 'gpt-a', effort: 'medium' }), [], [], models);
    const none = annotatePick(pick({ provider: 'codex', model: 'gpt-a', effort: null }), [], [], models);
    assert.equal(supported.problem, null);
    assert.equal(none.problem, null);
  });

  it('does not report an effort problem for a null effort on a model with no efforts', () => {
    const models = [modelList({ provider: 'grok', models: [model({ id: 'grok-x' })] })];
    const result = annotatePick(pick({ provider: 'grok', model: 'grok-x', effort: null }), [], [], models);
    assert.equal(result.problem, null);
  });

  it('uses the first entry when a provider is listed more than once', () => {
    const routing = [
      routingRow({ provider: 'claude', availability: 'exhausted', leftPercent: 0 }),
      routingRow({ provider: 'claude', availability: 'available', leftPercent: 90 }),
    ];
    const models = [
      modelList({ provider: 'claude', models: [model({ id: 'a' })] }),
      modelList({ provider: 'claude', models: [] }),
    ];
    const result = annotatePick(pick({ provider: 'claude', model: 'a' }), [], routing, models);
    assert.equal(result.availability, 'exhausted');
    assert.equal(result.leftPercent, 0);
    assert.equal(result.problem, null);
  });

  it('marks a pick checked with a valid model and effort, and no problem', () => {
    const models = [
      modelList({ provider: 'codex', models: [model({ id: 'gpt-a', efforts: ['low', 'medium'] })] }),
    ];
    const result = annotatePick(pick({ provider: 'codex', model: 'gpt-a', effort: 'medium' }), [], [], models);
    assert.equal(result.checked, true);
    assert.equal(result.problem, null);
  });

  it('marks a pick checked when the model is no longer offered, and reports the problem', () => {
    const models = [modelList({ provider: 'codex', models: [model({ id: 'gpt-a' })] })];
    const result = annotatePick(pick({ provider: 'codex', model: 'gpt-old' }), [], [], models);
    assert.equal(result.checked, true);
    assert.equal(result.problem, 'codex no longer offers model "gpt-old"');
  });

  it('marks a pick checked when the effort is unsupported, and reports the problem', () => {
    const models = [
      modelList({ provider: 'codex', models: [model({ id: 'gpt-a', efforts: ['low', 'medium'] })] }),
    ];
    const result = annotatePick(pick({ provider: 'codex', model: 'gpt-a', effort: 'max' }), [], [], models);
    assert.equal(result.checked, true);
    assert.equal(result.problem, 'model "gpt-a" does not support effort "max"');
  });

  it('marks a pick unchecked when the provider has no model list', () => {
    const result = annotatePick(pick({ provider: 'agy', model: 'x', effort: 'high' }), [], [], []);
    assert.equal(result.checked, false);
    assert.equal(result.problem, null);
  });

  it('marks a pick unchecked when the model list is unavailable', () => {
    const models = [modelList({ provider: 'muse', status: 'unavailable', models: [], message: 'no source' })];
    const result = annotatePick(pick({ provider: 'muse', model: 'x', effort: 'high' }), [], [], models);
    assert.equal(result.checked, false);
    assert.equal(result.problem, null);
  });

  it('marks a pick unchecked when the model list errored', () => {
    const models = [modelList({ provider: 'grok', status: 'error', models: [], message: 'boom' })];
    const result = annotatePick(pick({ provider: 'grok', model: 'x', effort: 'high' }), [], [], models);
    assert.equal(result.checked, false);
    assert.equal(result.problem, null);
  });

  it('stays unchecked with a null problem when a non-ok list still contains models', () => {
    const errored = annotatePick(pick({ provider: 'grok', model: 'x', effort: 'high' }), [], [], [
      modelList({
        provider: 'grok',
        status: 'error',
        models: [model({ id: 'other', name: 'Other', efforts: ['low'] })],
        message: 'boom',
      }),
    ]);
    const unavailable = annotatePick(pick({ provider: 'muse', model: 'x', effort: 'high' }), [], [], [
      modelList({
        provider: 'muse',
        status: 'unavailable',
        models: [model({ id: 'x', name: 'Muse X', efforts: ['low'] })],
        message: 'no source',
      }),
    ]);
    assert.equal(errored.checked, false);
    assert.equal(errored.problem, null);
    assert.equal(errored.modelName, null);
    assert.equal(unavailable.checked, false);
    assert.equal(unavailable.problem, null);
    assert.equal(unavailable.modelName, null);
  });

  it('does not check a pick against an ok list for a different provider', () => {
    const models = [
      modelList({ provider: 'claude', models: [model({ id: 'opus', name: 'Opus', efforts: ['high'] })] }),
    ];
    const result = annotatePick(pick({ provider: 'codex', model: 'gpt-old', effort: 'max' }), [], [], models);
    assert.equal(result.checked, false);
    assert.equal(result.problem, null);
    assert.equal(result.modelName, null);
  });
});

describe('annotateTiers', () => {
  it('carries each tier guidance verbatim, including empty and multi-line text', () => {
    const multiLine = 'first line\n\n- second line\n  indented';
    const config: ModelRoutingConfig = {
      version: 1,
      steering: '',
      tiers: [
        { name: 'complex', description: '', picks: [], guidance: multiLine },
        { name: 'simple', description: '', picks: [], guidance: '' },
        { name: 'moderate', description: '', picks: [], guidance: 'otherwise any free opencode model' },
      ],
    };
    const result = annotateTiers(config, [], [], []);
    assert.deepEqual(
      result.map((tier) => tier.guidance),
      [multiLine, '', 'otherwise any free opencode model'],
    );
  });

  it('uses empty guidance when the input tier lacks the field', () => {
    const config = {
      version: 1,
      steering: '',
      tiers: [{ name: 'simple', description: '', picks: [] }],
    } as unknown as ModelRoutingConfig;
    assert.equal(annotateTiers(config, [], [], [])[0].guidance, '');
  });
});

describe('annotateTiers order and isolation', () => {
  it('returns an empty array for an empty config', () => {
    const config: ModelRoutingConfig = { version: 1, tiers: [], steering: '' };
    assert.deepEqual(annotateTiers(config, [], [], []), []);
  });

  it('keeps tier order, pick order and descriptions', () => {
    const config: ModelRoutingConfig = {
      version: 1,
      steering: '',
      tiers: [
        {
          name: 'complex',
          description: 'Hard work',
          picks: [pick({ provider: 'codex', model: 'b' }), pick({ provider: 'claude', model: 'a' })],
          guidance: '',
        },
        { name: 'simple', description: '', picks: [pick({ provider: 'grok', model: 'c' })], guidance: '' },
      ],
    };
    const result = annotateTiers(config, [], [], []);
    assert.deepEqual(
      result.map((tier) => [tier.name, tier.description]),
      [
        ['complex', 'Hard work'],
        ['simple', ''],
      ],
    );
    assert.deepEqual(
      result[0].picks.map((p) => [p.provider, p.model]),
      [
        ['codex', 'b'],
        ['claude', 'a'],
      ],
    );
    assert.equal(result[1].picks[0].model, 'c');
  });

  it('keeps an empty tier with an empty picks list', () => {
    const config: ModelRoutingConfig = {
      version: 1,
      steering: '',
      tiers: [{ name: 'advisory', description: 'Planning', picks: [], guidance: '' }],
    };
    assert.deepEqual(annotateTiers(config, [], [], []), [
      { name: 'advisory', description: 'Planning', picks: [], guidance: '' },
    ]);
  });

  it('annotates two picks of the same provider in different tiers independently', () => {
    const config: ModelRoutingConfig = {
      version: 1,
      steering: '',
      tiers: [
        {
          name: 'complex',
          description: '',
          picks: [pick({ provider: 'claude', model: 'opus', effort: 'high' })],
          guidance: '',
        },
        {
          name: 'simple',
          description: '',
          picks: [pick({ provider: 'claude', model: 'haiku', effort: null })],
          guidance: '',
        },
      ],
    };
    const routing = [routingRow({ provider: 'claude', availability: 'low', leftPercent: 5 })];
    const models = [
      modelList({
        provider: 'claude',
        models: [model({ id: 'opus', name: 'Opus', efforts: ['low'] }), model({ id: 'haiku', name: 'Haiku' })],
      }),
    ];
    const result = annotateTiers(config, [], routing, models);
    assert.equal(result[0].picks[0].modelName, 'Opus');
    assert.equal(result[0].picks[0].problem, 'model "opus" does not support effort "high"');
    assert.equal(result[1].picks[0].modelName, 'Haiku');
    assert.equal(result[1].picks[0].problem, null);
    assert.equal(result[0].picks[0].availability, 'low');
    assert.equal(result[1].picks[0].availability, 'low');
  });

  it('forwards each provider scopedLimits onto its picks', () => {
    const config: ModelRoutingConfig = {
      version: 1,
      steering: '',
      tiers: [
        {
          name: 'complex',
          description: '',
          picks: [pick({ provider: 'claude', model: 'opus' }), pick({ provider: 'codex', model: 'gpt' })],
          guidance: '',
        },
      ],
    };
    const quota = [
      quotaRow({
        provider: 'claude',
        scopedLimits: [{ scope: 'Fable', kind: 'weekly', usedPercent: 40, resetsAt: RESET }],
      }),
      quotaRow({
        provider: 'codex',
        scopedLimits: [{ scope: 'Spark', kind: 'five_hour', usedPercent: 7, resetsAt: null }],
      }),
    ];
    const result = annotateTiers(config, quota, [], []);
    assert.deepEqual(result[0].picks[0].scopedLimits, [
      { scope: 'Fable', kind: 'weekly', usedPercent: 40, resetsAt: RESET },
    ]);
    assert.deepEqual(result[0].picks[1].scopedLimits, [
      { scope: 'Spark', kind: 'five_hour', usedPercent: 7, resetsAt: null },
    ]);
  });

  it('does not mutate its inputs', () => {
    const config = deepFreeze<ModelRoutingConfig>({
      version: 1,
      steering: 'x',
      tiers: [
        {
          name: 'complex',
          description: 'Hard',
          picks: [{ provider: 'claude', model: 'opus', effort: 'high' }],
          guidance: '',
        },
      ],
    });
    const quota = deepFreeze<ProviderQuota[]>([
      quotaRow({
        provider: 'claude',
        scopedLimits: [{ scope: 'Fable', kind: 'weekly', usedPercent: 10, resetsAt: null }],
      }),
    ]);
    const routing = deepFreeze<ProviderRouting[]>([routingRow({ provider: 'claude' })]);
    const models = deepFreeze<ProviderModels[]>([
      modelList({ provider: 'claude', models: [model({ id: 'opus', name: 'Opus', efforts: ['low'] })] }),
    ]);

    const result = annotateTiers(config, quota, routing, models);

    assert.equal(result[0].picks[0].problem, 'model "opus" does not support effort "high"');
    result[0].picks[0].scopedLimits.push({ scope: 'Y', kind: 'weekly', usedPercent: null, resetsAt: null });
    assert.equal(quota[0].scopedLimits?.length, 1);
  });

  it('computes per-pick availability for agy picks from their pool windows when the three pools are at different levels', () => {
    const fiveHourReset = '2026-11-13T15:00:00.000Z';
    const weeklyReset = '2026-11-19T22:00:00.000Z';
    const agyQuota = quotaRow({
      provider: 'agy',
      windows: [
        {
          kind: 'five_hour',
          usedPercent: 100,
          resetsAt: fiveHourReset,
          windowMinutes: 300,
          note: 'tightest: Gemini Models',
        },
        {
          kind: 'weekly',
          usedPercent: 60,
          resetsAt: weeklyReset,
          windowMinutes: 10080,
          note: 'tightest: Gemini Models',
        },
      ],
      scopedLimits: [
        { scope: 'Gemini Models', kind: 'five_hour', usedPercent: 100, resetsAt: fiveHourReset },
        { scope: 'Gemini Models', kind: 'weekly', usedPercent: 60, resetsAt: weeklyReset },
        { scope: 'Claude and GPT models', kind: 'five_hour', usedPercent: 90, resetsAt: fiveHourReset },
        { scope: 'Claude and GPT models', kind: 'weekly', usedPercent: 20, resetsAt: weeklyReset },
        { scope: 'Gemini 4 Argon', kind: 'weekly', usedPercent: 1, resetsAt: weeklyReset },
      ],
    });
    const agyRouting = routingRow({
      provider: 'agy',
      availability: 'exhausted',
      leftPercent: 0,
      bindingWindow: 'five_hour',
      resetsAt: fiveHourReset,
      reason: '5-hour window used up, resets in 3h 0m (tightest: Gemini Models)',
    });
    const agyModels = modelList({
      provider: 'agy',
      models: [
        model({ id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)', efforts: ['medium'] }),
        model({ id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (Thinking)', efforts: ['high'] }),
        model({ id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', efforts: ['medium'] }),
        model({ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: [] }),
        model({ id: 'unknown-future-model', name: 'Unknown Future Model', efforts: [] }),
      ],
    });
    const config: ModelRoutingConfig = {
      version: 1,
      steering: '',
      tiers: [
        {
          name: 'complex',
          description: 'All agy pools',
          guidance: '',
          picks: [
            pick({ provider: 'agy', model: 'gemini-4-argon-medium', effort: 'medium' }),
            pick({ provider: 'agy', model: 'claude-opus-5-5-high', effort: 'high' }),
            pick({ provider: 'agy', model: 'gpt-oss-120b-medium', effort: 'medium' }),
            pick({ provider: 'agy', model: 'gemini-3.8-flash', effort: null }),
            pick({ provider: 'agy', model: 'unknown-future-model', effort: null }),
          ],
        },
      ],
    };

    const [tier] = annotateTiers(config, [agyQuota], [agyRouting], [agyModels], new Date(NOW));
    assert.deepEqual(
      tier.picks.map((entry) => [entry.model, entry.availability, entry.leftPercent, entry.resetsAt]),
      [
        ['gemini-4-argon-medium', 'available', 99, weeklyReset],
        ['claude-opus-5-5-high', 'low', 10, fiveHourReset],
        ['gpt-oss-120b-medium', 'low', 10, fiveHourReset],
        ['gemini-3.8-flash', 'exhausted', 0, fiveHourReset],
        ['unknown-future-model', 'exhausted', 0, fiveHourReset],
      ],
    );
  });
});
