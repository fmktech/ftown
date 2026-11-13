import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadRoutingConfig,
  parseModelRoutingConfig,
  resolveRoutingPath,
  saveRoutingConfig,
  starterRoutingConfig,
  validatePicksAgainstModels,
} from './routing-config.js';
import { DEFAULT_ROUTING_TIERS, MODEL_ROUTING_LIMITS } from './types.js';
import type { HarnessModel, ModelRoutingConfig, ProviderModels } from './types.js';

const {
  maxTiers,
  maxPicksPerTier,
  maxTierNameLength,
  maxTierDescriptionLength,
  maxTierGuidanceLength,
  maxSteeringLength,
} = MODEL_ROUTING_LIMITS;

/** One sample per control / invisible character class, plus tab, newline and carriage return. */
const CHARACTER_CLASSES = [
  '\u0001',
  '\u0007',
  '\u007f',
  '\u0085',
  '\u200e',
  '\u202a',
  '\u2066',
  '\u200b',
  '\u2060',
  '\ufeff',
  '\u2028',
  '\u2029',
  '\n',
  '\t',
  '\r',
];

function tier(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'complex', description: '', picks: [], ...overrides };
}

function pick(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { provider: 'claude', model: 'opus', effort: null, ...overrides };
}

function input(tiers: unknown, rest: Record<string, unknown> = {}): unknown {
  return { version: 1, tiers, steering: '', ...rest };
}

function singleError(json: unknown): string {
  const result = parseModelRoutingConfig(json);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1, result.ok ? '' : result.errors.join(' | '));
  return result.errors[0] ?? '';
}

function fullValidInput(): Record<string, unknown> {
  return {
    version: 1,
    tiers: [
      {
        name: '  complex  ',
        description: 'Hard   development\n and debugging  ',
        picks: [
          { provider: 'claude', model: ' opus ', effort: 'high', note: 'extra' },
          { provider: 'codex', model: 'gpt-x' },
        ],
        guidance: '  Use Claude\n for design  ',
        colour: 'red',
      },
      { name: 'simple', picks: [{ provider: 'grok', model: 'g1', effort: null }] },
    ],
    steering: '  Keep Claude in reserve  ',
    unknownRoot: true,
  };
}

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'routing-config-'));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeRaw(home: string, content: string | Buffer): Promise<void> {
  await mkdir(join(home, '.ftown'), { recursive: true });
  await writeFile(resolveRoutingPath(home), content);
}

const NORMALISED_FULL = {
  version: 1,
  tiers: [
    {
      name: 'complex',
      description: 'Hard development and debugging',
      picks: [
        { provider: 'claude', model: 'opus', effort: 'high' },
        { provider: 'codex', model: 'gpt-x', effort: null },
      ],
      guidance: 'Use Claude\n for design',
    },
    {
      name: 'simple',
      description: '',
      picks: [{ provider: 'grok', model: 'g1', effort: null }],
      guidance: '',
    },
  ],
  steering: 'Keep Claude in reserve',
} as const;

describe('starterRoutingConfig', () => {
  it('has version 1, one empty tier per default tier with empty guidance, and empty steering', () => {
    const config = starterRoutingConfig();
    assert.equal(config.version, 1);
    assert.deepEqual(
      config.tiers,
      DEFAULT_ROUTING_TIERS.map((tier) => ({
        name: tier.name,
        description: tier.description,
        picks: [],
        guidance: '',
      })),
    );
    assert.equal(config.steering, '');
  });

  it('is itself a valid config', () => {
    const config = starterRoutingConfig();
    const result = parseModelRoutingConfig(JSON.parse(JSON.stringify(config)));
    assert.deepEqual(result, { ok: true, config });
  });
});

describe('parseModelRoutingConfig: normalisation', () => {
  it('normalises a full config and drops unknown keys', () => {
    const result = parseModelRoutingConfig(fullValidInput());
    assert.deepEqual(result, { ok: true, config: NORMALISED_FULL });
  });

  it('keeps only the known fields in the normalised output', () => {
    const result = parseModelRoutingConfig(fullValidInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(Object.keys(result.config), ['version', 'tiers', 'steering']);
    assert.deepEqual(Object.keys(result.config.tiers[0] ?? {}), ['name', 'description', 'picks', 'guidance']);
    assert.deepEqual(Object.keys(result.config.tiers[0]?.picks[0] ?? {}), ['provider', 'model', 'effort']);
  });

  it('keeps steering newlines and tabs but strips other control characters', () => {
    const result = parseModelRoutingConfig(input([], { steering: 'a\u0001b\u0007c\td\re\nf' }));
    assert.deepEqual(result, { ok: true, config: { version: 1, tiers: [], steering: 'abc\tde\nf' } });
  });

  it('defaults missing description and steering to empty strings and effort to null', () => {
    const result = parseModelRoutingConfig({
      version: 1,
      tiers: [{ name: 'simple', picks: [{ provider: 'muse', model: 'm' }] }],
    });
    assert.deepEqual(result, {
      ok: true,
      config: {
        version: 1,
        tiers: [
          {
            name: 'simple',
            description: '',
            picks: [{ provider: 'muse', model: 'm', effort: null }],
            guidance: '',
          },
        ],
        steering: '',
      },
    });
  });

  it('accepts an empty tier list', () => {
    assert.deepEqual(parseModelRoutingConfig(input([])), {
      ok: true,
      config: { version: 1, tiers: [], steering: '' },
    });
  });
});

describe('parseModelRoutingConfig: validation rules (one error each)', () => {
  it('rejects a root that is not a plain object', () => {
    for (const value of [[], null, 'text', 7]) {
      assert.deepEqual(parseModelRoutingConfig(value), {
        ok: false,
        errors: ['the routing file must contain a JSON object'],
      });
    }
  });

  it('requires version 1', () => {
    assert.equal(singleError({ version: 2, tiers: [], steering: '' }), 'version must be 1');
    assert.equal(singleError({ version: '1', tiers: [] }), 'version must be 1');
  });

  it('requires tiers to be an array', () => {
    assert.equal(singleError(input({ name: 'complex' })), 'tiers must be an array');
  });

  it('rejects more tiers than the limit', () => {
    const tiers = Array.from({ length: maxTiers + 1 }, (_, i) => tier({ name: `t${i}` }));
    assert.equal(singleError(input(tiers)), `tiers has ${maxTiers + 1} entries; the limit is ${maxTiers}`);
  });

  it('rejects a tier that is not an object', () => {
    assert.equal(singleError(input(['complex'])), 'tiers[0] must be an object');
  });

  it('requires a string tier name', () => {
    assert.equal(singleError(input([tier({ name: 5 })])), 'tiers[0].name must be a string');
  });

  it('rejects an empty tier name', () => {
    assert.equal(singleError(input([tier({ name: '   ' })])), 'tiers[0].name must not be empty');
  });

  it('rejects a tier name longer than the limit', () => {
    const name = 'a'.repeat(maxTierNameLength + 1);
    assert.equal(singleError(input([tier({ name })])), `tiers[0].name is longer than ${maxTierNameLength} characters`);
  });

  it('rejects a tier name outside the slug pattern', () => {
    assert.match(singleError(input([tier({ name: 'Complex' })])), /^tiers\[0\]\.name "Complex" must use only/);
    assert.match(singleError(input([tier({ name: 'two words' })])), /^tiers\[0\]\.name "two words" must use only/);
    assert.match(singleError(input([tier({ name: '-leading' })])), /^tiers\[0\]\.name "-leading" must use only/);
  });

  it('rejects duplicate tier names', () => {
    assert.equal(
      singleError(input([tier({ name: 'complex' }), tier({ name: ' complex ' })])),
      'tiers[1].name "complex" is already used by tiers[0]',
    );
  });

  it('requires a string description', () => {
    assert.equal(singleError(input([tier({ description: 3 })])), 'tiers[0].description must be a string');
  });

  it('rejects a description longer than the limit after whitespace is collapsed', () => {
    const description = 'a'.repeat(maxTierDescriptionLength + 1);
    assert.equal(
      singleError(input([tier({ description })])),
      `tiers[0].description is longer than ${maxTierDescriptionLength} characters`,
    );
  });

  it('requires picks to be an array', () => {
    assert.equal(singleError(input([tier({ picks: 'opus' })])), 'tiers[0].picks must be an array');
  });

  it('rejects more picks than the limit', () => {
    const picks = Array.from({ length: maxPicksPerTier + 1 }, (_, i) => pick({ model: `m${i}` }));
    assert.equal(
      singleError(input([tier({ picks })])),
      `tiers[0].picks has ${maxPicksPerTier + 1} entries; the limit is ${maxPicksPerTier}`,
    );
  });

  it('rejects a pick that is not an object', () => {
    assert.equal(singleError(input([tier({ picks: ['opus'] })])), 'tiers[0].picks[0] must be an object');
  });

  it('rejects an unknown provider', () => {
    assert.equal(
      singleError(input([tier(), tier({ name: 'simple', picks: [pick({ provider: 'foo' })] })])),
      'tiers[1].picks[0].provider "foo" is not a known CLI',
    );
  });

  it('requires a string model', () => {
    assert.equal(singleError(input([tier({ picks: [pick({ model: 7 })] })])), 'tiers[0].picks[0].model must be a string');
  });

  it('rejects an empty model after trimming', () => {
    assert.equal(
      singleError(input([tier({ picks: [pick({ model: '  ' })] })])),
      'tiers[0].picks[0].model must not be empty',
    );
  });

  it('rejects a model longer than 200 characters', () => {
    assert.equal(
      singleError(input([tier({ picks: [pick({ model: 'm'.repeat(201) })] })])),
      'tiers[0].picks[0].model is longer than 200 characters',
    );
  });

  it('rejects a model containing control or invisible characters of every class', () => {
    for (const ch of CHARACTER_CLASSES) {
      assert.equal(
        singleError(input([tier({ picks: [pick({ model: `op${ch}us` })] })])),
        'tiers[0].picks[0].model contains control or invisible characters',
        `class sample ${JSON.stringify(ch)}`,
      );
    }
  });

  it('rejects a model with a tab or BOM at its ends even though trimming would remove it', () => {
    assert.equal(
      singleError(input([tier({ picks: [pick({ model: '\topus' })] })])),
      'tiers[0].picks[0].model contains control or invisible characters',
    );
    assert.equal(
      singleError(input([tier({ picks: [pick({ model: '\ufeffopus' })] })])),
      'tiers[0].picks[0].model contains control or invisible characters',
    );
  });

  it('requires effort to be a string or null', () => {
    assert.equal(
      singleError(input([tier({ picks: [pick({ effort: 3 })] })])),
      'tiers[0].picks[0].effort must be a string or null',
    );
  });

  it('rejects an effort that does not match the effort pattern', () => {
    assert.match(
      singleError(input([tier({ picks: [pick({ effort: 'High' })] })])),
      /^tiers\[0\]\.picks\[0\]\.effort "High" must be 1 to 31 characters/,
    );
  });

  it('rejects an empty effort string', () => {
    assert.match(singleError(input([tier({ picks: [pick({ effort: '' })] })])), /^tiers\[0\]\.picks\[0\]\.effort "" must be/);
  });

  it('rejects duplicate picks within one tier', () => {
    assert.equal(
      singleError(input([tier({ picks: [pick({ effort: 'high' }), pick({ effort: 'high' })] })])),
      'tiers[0].picks[1] repeats an earlier pick for the same provider, model and effort',
    );
  });

  it('requires guidance to be a string', () => {
    assert.equal(singleError(input([tier({ guidance: 3 })])), 'tiers[0].guidance must be a string');
    assert.equal(singleError(input([tier({ guidance: ['x'] })])), 'tiers[0].guidance must be a string');
  });

  it('names the index of the tier whose guidance is not a string', () => {
    const tiers = [tier({ name: 'a' }), tier({ name: 'b' }), tier({ name: 'c', guidance: true })];
    assert.equal(singleError(input(tiers)), 'tiers[2].guidance must be a string');
  });

  it('rejects guidance longer than the limit after cleaning', () => {
    assert.equal(
      singleError(input([tier({ guidance: 'g'.repeat(maxTierGuidanceLength + 1) })])),
      `tiers[0].guidance is longer than ${maxTierGuidanceLength} characters`,
    );
  });

  it('requires steering to be a string', () => {
    assert.equal(singleError(input([], { steering: ['x'] })), 'steering must be a string');
  });

  it('rejects steering longer than the limit', () => {
    assert.equal(
      singleError(input([], { steering: 'a'.repeat(maxSteeringLength + 1) })),
      `steering is longer than ${maxSteeringLength} characters`,
    );
  });
});

describe('tier guidance', () => {
  it('becomes an empty string when absent or null', () => {
    for (const value of [undefined, null]) {
      const result = parseModelRoutingConfig(input([tier({ guidance: value })]));
      assert.deepEqual(result, {
        ok: true,
        config: { version: 1, tiers: [{ name: 'complex', description: '', picks: [], guidance: '' }], steering: '' },
      });
    }
  });

  it('keeps an empty string as an empty string', () => {
    const result = parseModelRoutingConfig(input([tier({ guidance: '' })]));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.tiers[0]?.guidance, '');
  });

  it('keeps a valid guidance text verbatim', () => {
    const text = 'otherwise any free opencode model';
    const result = parseModelRoutingConfig(input([tier({ guidance: text })]));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.tiers[0]?.guidance, text);
  });

  it('is trimmed and keeps newlines', () => {
    const result = parseModelRoutingConfig(input([tier({ guidance: '  first\nsecond  ' })]));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.tiers[0]?.guidance, 'first\nsecond');
  });

  it('strips invisible characters but keeps tab and newline, as steering does', () => {
    const result = parseModelRoutingConfig(
      input([tier({ guidance: 'a\u0001b​c‪d⁦e﻿y\tz\r\nw' })]),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.tiers[0]?.guidance, 'abcdey\tz\nw');
  });

  it('measures the limit after cleaning, so padding does not count', () => {
    const padded = `​  ${'g'.repeat(maxTierGuidanceLength)}  \u0001`;
    const result = parseModelRoutingConfig(input([tier({ guidance: padded })]));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.tiers[0]?.guidance, 'g'.repeat(maxTierGuidanceLength));
  });

  it('accepts exactly the limit', () => {
    const text = 'g'.repeat(maxTierGuidanceLength);
    const result = parseModelRoutingConfig(input([tier({ guidance: text })]));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.tiers[0]?.guidance, text);
  });

  it('keeps tab and newline in guidance and strips every other character class', () => {
    for (const ch of CHARACTER_CLASSES) {
      const result = parseModelRoutingConfig(input([tier({ guidance: `a${ch}b` })]));
      assert.equal(result.ok, true, result.ok ? '' : result.errors.join(' | '));
      if (!result.ok) return;
      const expected = ch === '\n' || ch === '\t' ? `a${ch}b` : 'ab';
      assert.equal(result.config.tiers[0]?.guidance, expected, JSON.stringify(ch));
    }
  });

  it('trims leading and trailing tabs and newlines', () => {
    const result = parseModelRoutingConfig(input([tier({ guidance: '\t\nkeep\nthis\t' })]));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.tiers[0]?.guidance, 'keep\nthis');
  });

  it('turns whitespace-only guidance into an empty string', () => {
    for (const value of [' ', '\t', '\n', ' \t\n\t ']) {
      const result = parseModelRoutingConfig(input([tier({ guidance: value })]));
      assert.equal(result.ok, true, result.ok ? '' : result.errors.join(' | '));
      if (!result.ok) return;
      assert.equal(result.config.tiers[0]?.guidance, '', JSON.stringify(value));
    }
  });

  it('applies the length limit after stripping an invisible character', () => {
    const accepted = parseModelRoutingConfig(
      input([tier({ guidance: `\u200b${'g'.repeat(maxTierGuidanceLength)}` })]),
    );
    assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.errors.join(' | '));
    if (!accepted.ok) return;
    assert.equal(accepted.config.tiers[0]?.guidance, 'g'.repeat(maxTierGuidanceLength));
    assert.equal(
      singleError(input([tier({ guidance: 'g'.repeat(maxTierGuidanceLength + 1) })])),
      `tiers[0].guidance is longer than ${maxTierGuidanceLength} characters`,
    );
  });

  it('round-trips through save and load to an equal config', async () => {
    await withHome(async (home) => {
      const parsed = parseModelRoutingConfig(
        input([
          tier({ name: 'advisory', guidance: 'Use Claude\nfor review' }),
          tier({ name: 'simple' }),
        ]),
      );
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      assert.deepEqual(await saveRoutingConfig(home, parsed.config), { ok: true });
      const saved = JSON.parse(await readFile(resolveRoutingPath(home), 'utf8')) as {
        tiers: Array<{ guidance: unknown }>;
      };
      assert.deepEqual(
        saved.tiers.map((entry) => entry.guidance),
        ['Use Claude\nfor review', ''],
      );
      const loaded = await loadRoutingConfig(home);
      assert.equal(loaded.state.status, 'ok');
      assert.deepEqual(loaded.config, parsed.config);
    });
  });

  it('starter config carries empty guidance on every tier and re-parses to an equal config', () => {
    const starter = starterRoutingConfig();
    for (const entry of starter.tiers) assert.equal(entry.guidance, '');
    assert.deepEqual(parseModelRoutingConfig(JSON.parse(JSON.stringify(starter))), { ok: true, config: starter });
  });
});

describe('parseModelRoutingConfig: boundaries and multiple errors', () => {
  it('accepts values exactly at each limit', () => {
    const tiers = Array.from({ length: maxTiers }, (_, i) =>
      tier({
        name: `t${i}`.padEnd(maxTierNameLength, 'x'),
        description: 'd'.repeat(maxTierDescriptionLength),
        picks: Array.from({ length: maxPicksPerTier }, (_, j) =>
          pick({ model: `${'m'.repeat(200 - String(j).length)}${j}`, effort: 'e'.repeat(31) }),
        ),
        guidance: 'g'.repeat(maxTierGuidanceLength),
      }),
    );
    const result = parseModelRoutingConfig(input(tiers, { steering: 's'.repeat(maxSteeringLength) }));
    assert.equal(result.ok, true, result.ok ? '' : result.errors.join(' | '));
    if (!result.ok) return;
    assert.equal(result.config.tiers[0]?.guidance, 'g'.repeat(maxTierGuidanceLength));
  });

  it('reports every error in one pass', () => {
    const result = parseModelRoutingConfig(
      input([tier({ name: 'Bad Name', picks: [pick({ provider: 'foo' })], guidance: 3 })], { version: 2 }),
    );
    assert.deepEqual(result, {
      ok: false,
      errors: [
        'version must be 1',
        'tiers[0].name "Bad Name" must use only lowercase letters, digits, "-" and "_", and start with a letter or digit',
        'tiers[0].picks[0].provider "foo" is not a known CLI',
        'tiers[0].guidance must be a string',
      ],
    });
    assert.equal('config' in result, false);
  });

  it('keeps going past a bad tier so later tiers are still checked', () => {
    const result = parseModelRoutingConfig(input([42, tier({ description: 1 })]));
    assert.deepEqual(result, {
      ok: false,
      errors: ['tiers[0] must be an object', 'tiers[1].description must be a string'],
    });
  });
});

describe('parseModelRoutingConfig: prototype-style keys', () => {
  it('ignores __proto__ and constructor keys without polluting prototypes or crashing', () => {
    const json = JSON.parse(
      '{"version":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},' +
        '"tiers":[{"name":"constructor","__proto__":{"x":1},"picks":[{"provider":"claude","model":"opus",' +
        '"effort":null,"__proto__":{"y":1}}]}],"steering":""}',
    ) as unknown;
    const result = parseModelRoutingConfig(json);
    assert.equal(result.ok, true, result.ok ? '' : result.errors.join(' | '));
    if (!result.ok) return;
    assert.deepEqual(Object.keys(result.config), ['version', 'tiers', 'steering']);
    assert.equal(result.config.tiers[0]?.name, 'constructor');
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(result.config.tiers[0] ?? {}, 'x'), false);
  });

  it('rejects a tier named __proto__ as an ordinary invalid name', () => {
    const json = JSON.parse('{"version":1,"tiers":[{"name":"__proto__","picks":[]}],"steering":""}') as unknown;
    assert.match(singleError(json), /^tiers\[0\]\.name "__proto__" must use only/);
  });
});

describe('validatePicksAgainstModels', () => {
  const model = (overrides: Partial<HarnessModel> & { id: string }): HarnessModel => ({
    name: null,
    isDefault: false,
    description: null,
    contextTokens: null,
    efforts: [],
    defaultEffort: null,
    ...overrides,
  });

  const lists: ProviderModels[] = [
    {
      provider: 'claude',
      status: 'ok',
      models: [
        model({ id: 'opus', efforts: ['low', 'high'] }),
        model({ id: 'haiku', efforts: [] }),
      ],
      source: 'live',
      observedAt: '2026-11-13T12:00:00.000Z',
      message: null,
      modelFlag: '--model <id>',
      effortFlag: '--effort <level>',
    },
    {
      provider: 'codex',
      status: 'error',
      models: [],
      source: 'live',
      observedAt: '2026-11-13T12:00:00.000Z',
      message: 'boom',
      modelFlag: '--model <id>',
      effortFlag: null,
    },
  ];

  function configWith(picks: RoutingConfigPick[]): ModelRoutingConfig {
    return {
      version: 1,
      tiers: [{ name: 'complex', description: '', picks, guidance: '' }],
      steering: '',
    };
  }

  type RoutingConfigPick = ModelRoutingConfig['tiers'][number]['picks'][number];

  it('reports a model the list does not offer', () => {
    assert.deepEqual(
      validatePicksAgainstModels(configWith([{ provider: 'claude', model: 'sonnet', effort: null }]), lists),
      ['tiers.complex: claude has no model "sonnet"'],
    );
  });

  it('reports an effort the model does not support', () => {
    assert.deepEqual(
      validatePicksAgainstModels(configWith([{ provider: 'claude', model: 'opus', effort: 'max' }]), lists),
      ['tiers.complex: claude model "opus" does not support effort "max" (supported: low, high)'],
    );
  });

  it('reports an effort on a model that takes no effort setting', () => {
    assert.deepEqual(
      validatePicksAgainstModels(configWith([{ provider: 'claude', model: 'haiku', effort: 'low' }]), lists),
      ['tiers.complex: claude model "haiku" takes no effort setting'],
    );
  });

  it('skips picks whose provider list is missing or not ok', () => {
    assert.deepEqual(
      validatePicksAgainstModels(
        configWith([
          { provider: 'grok', model: 'anything', effort: 'high' },
          { provider: 'codex', model: 'gpt-x', effort: null },
        ]),
        lists,
      ),
      [],
    );
  });

  it('returns no errors for a valid config', () => {
    assert.deepEqual(
      validatePicksAgainstModels(
        configWith([
          { provider: 'claude', model: 'opus', effort: 'high' },
          { provider: 'claude', model: 'opus', effort: null },
          { provider: 'claude', model: 'haiku', effort: null },
        ]),
        lists,
      ),
      [],
    );
  });
});

describe('loadRoutingConfig', () => {
  it('reports a missing file with no errors', async () => {
    await withHome(async (home) => {
      assert.deepEqual(await loadRoutingConfig(home), {
        state: { status: 'missing', path: join(home, '.ftown', 'model-routing.json'), errors: [] },
        config: null,
      });
    });
  });

  it('reports invalid JSON', async () => {
    await withHome(async (home) => {
      await writeRaw(home, '{not json');
      const result = await loadRoutingConfig(home);
      assert.equal(result.state.status, 'invalid');
      assert.deepEqual(result.state.errors, ['not valid JSON']);
      assert.equal(result.config, null);
    });
  });

  it('reports validation errors for an invalid config', async () => {
    await withHome(async (home) => {
      await writeRaw(home, JSON.stringify({ version: 2, tiers: [] }));
      const result = await loadRoutingConfig(home);
      assert.deepEqual(result.state.errors, ['version must be 1']);
      assert.equal(result.state.status, 'invalid');
      assert.equal(result.config, null);
    });
  });

  it('loads and normalises a valid file', async () => {
    await withHome(async (home) => {
      await writeRaw(home, JSON.stringify(fullValidInput()));
      const result = await loadRoutingConfig(home);
      assert.deepEqual(result, {
        state: { status: 'ok', path: join(home, '.ftown', 'model-routing.json'), errors: [] },
        config: NORMALISED_FULL,
      });
    });
  });

  it('refuses a file over 1 MB without parsing it', async () => {
    await withHome(async (home) => {
      await writeRaw(home, Buffer.alloc(1024 * 1024 + 1, 0x20));
      const result = await loadRoutingConfig(home);
      assert.deepEqual(result.state.errors, ['file is too large']);
      assert.equal(result.state.status, 'invalid');
      assert.equal(result.config, null);
    });
  });

  it('rejects a directory at the path as not a regular file', async () => {
    await withHome(async (home) => {
      await mkdir(resolveRoutingPath(home), { recursive: true });
      const result = await loadRoutingConfig(home);
      assert.equal(result.state.status, 'invalid');
      assert.deepEqual(result.state.errors, ['routing file is not a regular file']);
      assert.equal(result.config, null);
    });
  });
});

describe('saveRoutingConfig', () => {
  it('creates the .ftown directory with mode 0o700 and writes a 0o600 file', async () => {
    await withHome(async (home) => {
      const result = await saveRoutingConfig(home, starterRoutingConfig());
      assert.deepEqual(result, { ok: true });
      const dirMode = (await stat(join(home, '.ftown'))).mode & 0o777;
      const fileMode = (await stat(resolveRoutingPath(home))).mode & 0o777;
      assert.equal(dirMode, 0o700);
      assert.equal(fileMode, 0o600);
    });
  });

  it('writes normalised JSON with a trailing newline', async () => {
    await withHome(async (home) => {
      const parsed = parseModelRoutingConfig(fullValidInput());
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      assert.deepEqual(await saveRoutingConfig(home, parsed.config), { ok: true });
      const text = await readFile(resolveRoutingPath(home), 'utf8');
      assert.equal(text, `${JSON.stringify(NORMALISED_FULL, null, 2)}\n`);
    });
  });

  it('replaces an existing file atomically and leaves no temp files behind', async () => {
    await withHome(async (home) => {
      await writeRaw(home, JSON.stringify({ version: 1, tiers: [], steering: 'old' }));
      const config: ModelRoutingConfig = { version: 1, tiers: [], steering: 'new' };
      assert.deepEqual(await saveRoutingConfig(home, config), { ok: true });
      assert.deepEqual(JSON.parse(await readFile(resolveRoutingPath(home), 'utf8')), config);
      assert.deepEqual(await readdir(join(home, '.ftown')), ['model-routing.json']);
    });
  });

  it('rejects an invalid config with the first error and writes nothing', async () => {
    await withHome(async (home) => {
      const invalid = {
        version: 1,
        tiers: [{ name: 'Bad', description: '', picks: [], guidance: '' }],
        steering: '',
      } as unknown as ModelRoutingConfig;
      const result = await saveRoutingConfig(home, invalid);
      assert.deepEqual(result, {
        ok: false,
        error: 'tiers[0].name "Bad" must use only lowercase letters, digits, "-" and "_", and start with a letter or digit',
      });
      assert.equal(existsSync(join(home, '.ftown')), false);
    });
  });

  it('rejects guidance over the limit and writes nothing', async () => {
    await withHome(async (home) => {
      const invalid: ModelRoutingConfig = {
        version: 1,
        tiers: [
          {
            name: 'complex',
            description: '',
            picks: [],
            guidance: 'g'.repeat(maxTierGuidanceLength + 1),
          },
        ],
        steering: '',
      };
      const result = await saveRoutingConfig(home, invalid);
      assert.deepEqual(result, {
        ok: false,
        error: `tiers[0].guidance is longer than ${maxTierGuidanceLength} characters`,
      });
      assert.equal(existsSync(join(home, '.ftown')), false);
    });
  });

  it('rejects non-string guidance and writes nothing', async () => {
    await withHome(async (home) => {
      const invalid = {
        version: 1,
        tiers: [{ name: 'complex', description: '', picks: [], guidance: 3 }],
        steering: '',
      } as unknown as ModelRoutingConfig;
      const result = await saveRoutingConfig(home, invalid);
      assert.deepEqual(result, { ok: false, error: 'tiers[0].guidance must be a string' });
      assert.equal(existsSync(join(home, '.ftown')), false);
    });
  });

  it('normalises untrimmed guidance on save', async () => {
    await withHome(async (home) => {
      const config: ModelRoutingConfig = {
        version: 1,
        tiers: [{ name: 'complex', description: '', picks: [], guidance: '\t\n  first\nsecond  \n' }],
        steering: '',
      };
      assert.deepEqual(await saveRoutingConfig(home, config), { ok: true });
      const saved = JSON.parse(await readFile(resolveRoutingPath(home), 'utf8')) as {
        tiers: Array<{ guidance: unknown }>;
      };
      assert.equal(saved.tiers[0]?.guidance, 'first\nsecond');
    });
  });

  it('round-trips through load', async () => {
    await withHome(async (home) => {
      const parsed = parseModelRoutingConfig(fullValidInput());
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      assert.deepEqual(await saveRoutingConfig(home, parsed.config), { ok: true });
      const loaded = await loadRoutingConfig(home);
      assert.equal(loaded.state.status, 'ok');
      assert.deepEqual(loaded.config, parsed.config);
    });
  });

  it('returns an error instead of throwing when the directory cannot be created', async () => {
    await withHome(async (home) => {
      const blocker = join(home, 'not-a-dir');
      await writeFile(blocker, 'x');
      const result = await saveRoutingConfig(blocker, starterRoutingConfig());
      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.error, /^could not write the routing file \(E[A-Z]+\)$/);
      assert.equal((await stat(blocker)).isFile(), true);
    });
  });
});

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe('never throws', () => {
  const unreadable = { version: 1, steering: '' };

  it('returns one error for a throwing getter', () => {
    const json = {
      version: 1,
      get tiers(): never {
        throw new Error('boom');
      },
      steering: '',
    };
    assert.deepEqual(parseModelRoutingConfig(json), { ok: false, errors: ['could not read the config'] });
  });

  it('returns one error for throwing Proxy traps', () => {
    const noPrototype = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('boom');
        },
      },
    );
    const throwingGet = new Proxy(unreadable, {
      get() {
        throw new Error('boom');
      },
    });
    assert.deepEqual(parseModelRoutingConfig(noPrototype), { ok: false, errors: ['could not read the config'] });
    assert.deepEqual(parseModelRoutingConfig(throwingGet), { ok: false, errors: ['could not read the config'] });
  });

  it('save resolves with an error for a throwing config and writes nothing', async () => {
    await withHome(async (home) => {
      const bad = {
        version: 1,
        get tiers(): never {
          throw new Error('boom');
        },
        steering: '',
      } as unknown as ModelRoutingConfig;
      assert.deepEqual(await saveRoutingConfig(home, bad), { ok: false, error: 'could not read the config' });
      assert.equal(existsSync(join(home, '.ftown')), false);
    });
  });

  it('load does not reject when the file path is a FIFO', async (t) => {
    await withHome(async (home) => {
      await mkdir(join(home, '.ftown'), { recursive: true });
      const made = spawnSync('mkfifo', [resolveRoutingPath(home)]);
      if (made.status !== 0) {
        t.skip('mkfifo is unavailable');
        return;
      }
      const result = await withTimeout(loadRoutingConfig(home), 2000);
      if (result === 'timeout') assert.fail('loading a FIFO blocked');
      assert.equal(result.state.status, 'invalid');
      assert.deepEqual(result.state.errors, ['routing file is not a regular file']);
      assert.equal(result.config, null);
    });
  });
});

describe('bounded work and error cap', () => {
  it('reports exactly one error for a 1,000,000-entry tiers array, quickly', () => {
    const tiers = new Array<unknown>(1_000_000).fill(tier());
    const started = performance.now();
    const result = parseModelRoutingConfig(input(tiers));
    const elapsed = performance.now() - started;
    assert.deepEqual(result, { ok: false, errors: ['tiers has 1000000 entries; the limit is 12'] });
    assert.ok(elapsed < 200, `took ${elapsed} ms`);
  });

  it('reports one error for picks over the limit without iterating them', () => {
    const picks = new Array<unknown>(1_000_000).fill(pick());
    assert.equal(singleError(input([tier({ picks })])), 'tiers[0].picks has 1000000 entries; the limit is 12');
  });

  it('caps collected errors at 50 and ends with a truncation marker', () => {
    const tiers = Array.from({ length: 12 }, (_, i) =>
      tier({ name: `t${i}`, picks: Array.from({ length: 12 }, () => pick({ provider: 'foo', model: 5 })) }),
    );
    const result = parseModelRoutingConfig(input(tiers));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors.length, 50);
    assert.equal(result.errors[0], 'tiers[0].picks[0].provider "foo" is not a known CLI');
    assert.equal(result.errors[49], '... and more');
  });

  it('adds no truncation marker when exactly 50 errors occur', () => {
    const tiers = [
      tier({ name: 'a', picks: Array.from({ length: 10 }, () => pick({ provider: 'foo', model: 5 })) }),
      tier({ name: 'b', picks: Array.from({ length: 10 }, () => pick({ provider: 'foo', model: 5 })) }),
      tier({ name: 'c', picks: Array.from({ length: 5 }, () => pick({ provider: 'foo', model: 5 })) }),
    ];
    const result = parseModelRoutingConfig(input(tiers));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors.length, 50);
    assert.equal(result.errors[49], 'tiers[2].picks[4].model must be a string');
  });
});

describe('sparse arrays', () => {
  it('reports a hole in tiers at its real index', () => {
    const tiers: unknown[] = new Array(2);
    tiers[1] = tier({ name: 'simple' });
    assert.equal(singleError(input(tiers)), 'tiers[0] must be an object');
  });

  it('reports a hole in picks at its real index', () => {
    const picks: unknown[] = new Array(2);
    picks[0] = pick();
    assert.equal(singleError(input([tier({ picks })])), 'tiers[0].picks[1] must be an object');
  });
});

describe('control and invisible characters', () => {
  it('strips them from descriptions after collapsing whitespace', () => {
    for (const ch of CHARACTER_CLASSES) {
      const result = parseModelRoutingConfig(input([tier({ description: `a${ch}b` })]));
      assert.equal(result.ok, true, result.ok ? '' : result.errors.join(' | '));
      if (!result.ok) return;
      assert.equal(result.config.tiers[0]?.description, /\s/.test(ch) ? 'a b' : 'ab', JSON.stringify(ch));
    }
  });

  it('counts the description length after stripping invisible characters', () => {
    const description = `${'a'.repeat(100)}\u200b${'a'.repeat(100)}`;
    const result = parseModelRoutingConfig(input([tier({ description })]));
    assert.equal(result.ok, true, result.ok ? '' : result.errors.join(' | '));
  });

  it('keeps tab and newline in steering and strips the other characters', () => {
    for (const ch of CHARACTER_CLASSES) {
      const result = parseModelRoutingConfig(input([], { steering: `a${ch}b` }));
      assert.equal(result.ok, true, result.ok ? '' : result.errors.join(' | '));
      if (!result.ok) return;
      const expected = ch === '\n' || ch === '\t' ? `a${ch}b` : 'ab';
      assert.equal(result.config.steering, expected, JSON.stringify(ch));
    }
  });
});

describe('load: bounded read', () => {
  it('reads a file of exactly 1 MB without reporting it as too large', async () => {
    await withHome(async (home) => {
      await writeRaw(home, Buffer.alloc(1024 * 1024, 0x20));
      const result = await loadRoutingConfig(home);
      assert.deepEqual(result.state.errors, ['not valid JSON']);
    });
  });
});

describe('home directory must be absolute', () => {
  const relative = `relative-home-${process.pid}`;

  it('load returns home-not-set for empty and relative homeDir', async () => {
    for (const home of ['', relative]) {
      assert.deepEqual(await loadRoutingConfig(home), {
        state: { status: 'invalid', path: '', errors: ['home directory is not set'] },
        config: null,
      });
    }
  });

  it('save returns home-not-set and creates nothing', async () => {
    for (const home of ['', relative]) {
      assert.deepEqual(await saveRoutingConfig(home, starterRoutingConfig()), {
        ok: false,
        error: 'home directory is not set',
      });
    }
    assert.equal(existsSync(join(process.cwd(), relative)), false);
  });

  it('resolveRoutingPath returns an empty string for non-absolute homes', () => {
    assert.equal(resolveRoutingPath(''), '');
    assert.equal(resolveRoutingPath(relative), '');
  });
});
