import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectQuotaReport,
  loadRealQuotaDeps,
  parseQuotaArgs,
  runQuota,
  runQuotaCli,
  QUOTA_HELP_TEXT,
  type QuotaDeps,
  type RoutingLoader,
  type TierAnnotator,
} from './quota-cli.js';
import { QUOTA_PROVIDER_IDS } from './quota/types.js';
import type {
  AnnotatedTier,
  HarnessModel,
  ModelRoutingConfig,
  ModelsFetcher,
  ProviderModels,
  ProviderQuota,
  ProviderRouting,
  QuotaFetcher,
  QuotaProviderId,
  QuotaReport,
  QuotaRoutingAdvisor,
  RoutingConfigState,
} from './quota/types.js';

const NOW = new Date('2026-11-13T12:00:00.000Z');

function okRow(provider: QuotaProviderId): ProviderQuota {
  return {
    provider,
    status: 'ok',
    plan: 'pro',
    windows: [{ kind: 'five_hour', usedPercent: 10, resetsAt: null, windowMinutes: 300, note: null }],
    source: 'live',
    observedAt: NOW.toISOString(),
    message: null,
  };
}

function okModels(provider: QuotaProviderId): ProviderModels {
  return {
    provider,
    status: 'ok',
    models: [{
      id: `${provider}-default`,
      name: null,
      isDefault: true,
      description: null,
      contextTokens: null,
      efforts: [],
      defaultEffort: null,
    }],
    source: 'live',
    observedAt: NOW.toISOString(),
    message: null,
    modelFlag: '--model <id>',
    effortFlag: null,
  };
}

function routingFor(row: ProviderQuota, availability: ProviderRouting['availability'] = 'available'): ProviderRouting {
  return {
    provider: row.provider,
    availability,
    leftPercent: 90,
    bindingWindow: 'five_hour',
    resetsAt: null,
    resetsInMinutes: null,
    runway: null,
    reason: 'fake',
  };
}

/** Default advisor: rows in the order given, all available. */
const keepOrderAdvise: QuotaRoutingAdvisor = rows => rows.map(row => routingFor(row));

const ROUTING_PATH = '/home/test/.ftown/model-routing.json';
/** Default routing file: present, valid, no tiers, no steering. Keeps table output unchanged for older tests. */
const EMPTY_CONFIG: ModelRoutingConfig = { version: 1, tiers: [], steering: '' };
const defaultRouting: RoutingLoader = async () => ({
  state: { status: 'ok', path: ROUTING_PATH, errors: [] },
  config: EMPTY_CONFIG,
});
/** Default annotator: copies each pick and takes its availability from the routing advice. */
const keepAnnotate: TierAnnotator = (config, _quota, routing) => config.tiers.map(tier => ({
  name: tier.name,
  description: tier.description,
  guidance: tier.guidance,
  picks: tier.picks.map(pick => {
    const advice = routing.find(entry => entry.provider === pick.provider);
    return {
      ...pick,
      modelName: null,
      availability: advice?.availability ?? 'unknown',
      leftPercent: advice?.leftPercent ?? null,
      resetsAt: null,
      scopedLimits: [],
      problem: null,
      checked: true,
    };
  }),
}));

/** A user config with a described tier that has two picks, an empty tier, and steering with a newline. */
const TIER_CONFIG: ModelRoutingConfig = {
  version: 1,
  tiers: [
    {
      name: 'complex',
      description: 'Hard dev',
      picks: [
        { provider: 'claude', model: 'opus', effort: 'high' },
        { provider: 'codex', model: 'gpt-x', effort: null },
      ],
      guidance: '',
    },
    { name: 'simple', description: '', picks: [], guidance: '' },
  ],
  steering: 'don\'t fully exhaust Claude',
};

/** What the annotator returns for TIER_CONFIG: a low pick, and a pick whose model is gone. */
const ANNOTATED: AnnotatedTier[] = [
  {
    name: 'complex',
    description: 'Hard dev',
    guidance: '',
    picks: [
      {
        provider: 'claude', model: 'opus', effort: 'high', modelName: null,
        availability: 'low', leftPercent: 12, resetsAt: null, scopedLimits: [], problem: null, checked: true,
      },
      {
        provider: 'codex', model: 'gpt-x', effort: null, modelName: null,
        availability: 'available', leftPercent: null, resetsAt: null, scopedLimits: [],
        problem: 'model no longer offered', checked: true,
      },
    ],
  },
  { name: 'simple', description: '', picks: [], guidance: '' },
];

const okRouting = (config: ModelRoutingConfig): RoutingLoader => async () => ({
  state: { status: 'ok', path: ROUTING_PATH, errors: [] },
  config,
});

interface FakeCall {
  provider: QuotaProviderId;
  timeoutMs: number;
  homeDir: string;
}

interface FakeOptions {
  quota?: Partial<Record<QuotaProviderId, QuotaFetcher>>;
  models?: Partial<Record<QuotaProviderId, ModelsFetcher>>;
  advise?: QuotaRoutingAdvisor;
  routing?: RoutingLoader;
  annotate?: TierAnnotator;
  graceMs?: number;
}

function fakeDeps(options: FakeOptions = {}) {
  const quotaCalls: FakeCall[] = [];
  const modelCalls: FakeCall[] = [];
  const formatted: { rows: readonly ProviderQuota[]; now: Date }[] = [];
  const advised: { rows: readonly ProviderQuota[]; now: Date }[] = [];

  const quotaFetcher = (provider: QuotaProviderId): QuotaFetcher => opts => {
    quotaCalls.push({ provider, timeoutMs: opts.timeoutMs, homeDir: opts.homeDir });
    const override = options.quota?.[provider];
    return override ? override(opts) : Promise.resolve(okRow(provider));
  };
  const modelFetcher = (provider: QuotaProviderId): ModelsFetcher => opts => {
    modelCalls.push({ provider, timeoutMs: opts.timeoutMs, homeDir: opts.homeDir });
    const override = options.models?.[provider];
    return override ? override(opts) : Promise.resolve(okModels(provider));
  };

  const advise: QuotaRoutingAdvisor = (rows, now) => {
    advised.push({ rows, now });
    return (options.advise ?? keepOrderAdvise)(rows, now);
  };

  const fetchers = {} as Record<QuotaProviderId, QuotaFetcher>;
  const modelFetchers = {} as Record<QuotaProviderId, ModelsFetcher>;
  for (const provider of QUOTA_PROVIDER_IDS) {
    fetchers[provider] = quotaFetcher(provider);
    modelFetchers[provider] = modelFetcher(provider);
  }

  const deps: QuotaDeps = {
    fetchers,
    modelFetchers,
    advise,
    format: (rows, now) => {
      formatted.push({ rows, now });
      return `TABLE(${rows.map(row => row.provider).join(',')})`;
    },
    loadRouting: options.routing ?? defaultRouting,
    annotate: options.annotate ?? keepAnnotate,
    now: () => NOW,
    homeDir: '/home/test',
    graceMs: options.graceMs,
  };
  return { deps, quotaCalls, modelCalls, formatted, advised };
}

describe('parseQuotaArgs', () => {
  it('defaults to all providers, table output, 15 second timeout, no help, default models', () => {
    assert.deepEqual(parseQuotaArgs([]), {
      ok: true,
      providers: [...QUOTA_PROVIDER_IDS],
      json: false,
      timeoutMs: 15000,
      help: false,
      models: 'default',
    });
  });

  it('keeps only the named providers in canonical order, de-duplicated, case-insensitive', () => {
    const parsed = parseQuotaArgs(['MUSE', 'codex', 'muse', 'Claude']);
    assert.deepEqual(parsed, {
      ok: true,
      providers: ['claude', 'codex', 'muse'],
      json: false,
      timeoutMs: 15000,
      help: false,
      models: 'default',
    });
  });

  it('sets json', () => {
    const parsed = parseQuotaArgs(['--json']);
    assert.equal(parsed.ok && parsed.json, true);
  });

  it('maps --models to show and --no-models to skip', () => {
    const show = parseQuotaArgs(['--models']);
    const skip = parseQuotaArgs(['--no-models']);
    assert.equal(show.ok && show.models, 'show');
    assert.equal(skip.ok && skip.models, 'skip');
  });

  it('rejects --models combined with --no-models in either order', () => {
    for (const argv of [['--models', '--no-models'], ['--no-models', '--models']]) {
      assert.deepEqual(parseQuotaArgs(argv), { ok: false, error: 'cannot combine --models and --no-models' }, argv.join(' '));
    }
  });

  it('accepts --timeout <seconds> and converts to milliseconds', () => {
    const parsed = parseQuotaArgs(['--timeout', '2.5']);
    assert.equal(parsed.ok && parsed.timeoutMs, 2500);
  });

  it('accepts --timeout=<seconds>', () => {
    const parsed = parseQuotaArgs(['--timeout=3']);
    assert.equal(parsed.ok && parsed.timeoutMs, 3000);
  });

  it('accepts the range bounds 1 and 600 seconds', () => {
    const low = parseQuotaArgs(['--timeout', '1']);
    const high = parseQuotaArgs(['--timeout', '600']);
    assert.equal(low.ok && low.timeoutMs, 1000);
    assert.equal(high.ok && high.timeoutMs, 600000);
  });

  it('rejects a missing, zero, negative or non-numeric timeout', () => {
    for (const argv of [['--timeout'], ['--timeout', 'abc'], ['--timeout', '0'], ['--timeout', '-1'], ['--timeout='], ['--timeout=soon']]) {
      assert.deepEqual(parseQuotaArgs(argv), { ok: false, error: 'invalid --timeout value' }, argv.join(' '));
    }
  });

  it('rejects timeouts outside 1-600 seconds, including sub-millisecond and overflow-sized values', () => {
    for (const value of ['0.0004', '0.5', '601', '2200000', 'NaN', 'Infinity']) {
      assert.deepEqual(parseQuotaArgs(['--timeout', value]), { ok: false, error: 'invalid --timeout value' }, value);
      assert.deepEqual(parseQuotaArgs([`--timeout=${value}`]), { ok: false, error: 'invalid --timeout value' }, value);
    }
  });

  it('rejects an unknown provider name and lists all six providers', () => {
    const parsed = parseQuotaArgs(['claude', 'gemini']);
    assert.deepEqual(parsed, {
      ok: false,
      error: 'unknown provider: gemini (expected claude, codex, grok, muse, agy, opencode)',
    });
  });

  it('accepts the agy and opencode providers in canonical order', () => {
    const parsed = parseQuotaArgs(['opencode', 'agy']);
    assert.equal(parsed.ok && parsed.providers.join(','), 'agy,opencode');
  });

  it('rejects an unknown flag', () => {
    assert.deepEqual(parseQuotaArgs(['--verbose']), { ok: false, error: 'unknown option: --verbose' });
  });

  it('sets help for -h and --help', () => {
    const short = parseQuotaArgs(['-h']);
    const long = parseQuotaArgs(['--help']);
    assert.equal(short.ok && short.help, true);
    assert.equal(long.ok && long.help, true);
  });
});

describe('runQuota table mode', () => {
  it('passes rows in canonical order to the table formatter and prints the table then the route line', async () => {
    const { deps, formatted } = fakeDeps();
    const result = await runQuota(['grok', 'claude'], deps);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'TABLE(claude,grok)\n\nRoute first: claude > grok');
    assert.equal(formatted.length, 1);
    assert.deepEqual(formatted[0].rows.map(row => row.provider), ['claude', 'grok']);
    assert.equal(formatted[0].now.getTime(), NOW.getTime());
  });

  it('orders the route line by advise and adds availability suffixes', async () => {
    const advise: QuotaRoutingAdvisor = rows => [
      routingFor(rows[1], 'low'),
      routingFor(rows[0]),
      routingFor(rows[2], 'exhausted'),
      routingFor(rows[3], 'unknown'),
      routingFor(rows[4]),
      routingFor(rows[5]),
    ];
    const { deps } = fakeDeps({ advise });
    const result = await runQuota([], deps);

    assert.equal(
      result.stdout,
      'TABLE(claude,codex,grok,muse,agy,opencode)\n\n'
      + 'Route first: codex (low) > claude > grok (exhausted) > muse (unknown) > agy > opencode',
    );
  });

  it('runs the agy and opencode subset through the table path', async () => {
    const { deps, quotaCalls } = fakeDeps();
    const result = await runQuota(['opencode', 'agy'], deps);

    assert.equal(result.stdout, 'TABLE(agy,opencode)\n\nRoute first: agy > opencode');
    assert.deepEqual(quotaCalls.map(call => call.provider).sort(), ['agy', 'opencode']);
  });

  it('truncates a model list longer than 20 in table mode with a count line', async () => {
    const many: HarnessModel[] = Array.from({ length: 23 }, (_, i) => ({
      id: `m${i + 1}`,
      name: null,
      isDefault: false,
      description: null,
      contextTokens: null,
      efforts: [],
      defaultEffort: null,
    }));
    const { deps } = fakeDeps({
      models: {
        opencode: async () => ({ ...okModels('opencode'), models: many, modelFlag: '--model <id>' }),
      },
    });
    const result = await runQuota(['--models', 'opencode'], deps);
    const lines = result.stdout.split('\n');

    assert.equal(lines[lines.length - 1 - 21], 'opencode models (--model <id>):');
    assert.equal(lines[lines.length - 1 - 20], '  m1');
    assert.equal(lines[lines.length - 2], '  m20');
    assert.equal(lines[lines.length - 1], '  ... and 3 more (use --json for the full list)');
    assert.equal(result.stdout.includes('  m21'), false);
  });

  it('prints no model section without --models, and does not call model fetchers', async () => {
    const { deps, modelCalls } = fakeDeps();
    const result = await runQuota(['claude'], deps);

    assert.equal(result.stdout, 'TABLE(claude)\n\nRoute first: claude');
    assert.equal(modelCalls.length, 0);
  });

  it('prints a model section with default marks, efforts, context and non-ok lists when --models is given', async () => {
    const { deps } = fakeDeps({
      models: {
        claude: async () => ({
          provider: 'claude',
          status: 'ok',
          models: [
            {
              id: 'opus-x',
              name: null,
              isDefault: true,
              description: null,
              contextTokens: 200000,
              efforts: ['low', 'medium', 'high'],
              defaultEffort: 'high',
            },
            {
              id: 'haiku-y',
              name: null,
              isDefault: false,
              description: null,
              contextTokens: 1500,
              efforts: [],
              defaultEffort: null,
            },
          ],
          source: 'live',
          observedAt: NOW.toISOString(),
          message: null,
          modelFlag: '--model <id>',
          effortFlag: '--effort <level>',
        }),
        codex: async () => ({
          provider: 'codex',
          status: 'unavailable',
          models: [],
          source: 'live',
          observedAt: NOW.toISOString(),
          message: 'codex not installed',
          modelFlag: '--model <id>',
          effortFlag: null,
        }),
      },
    });
    const result = await runQuota(['--models', 'claude', 'codex'], deps);

    assert.equal(result.stdout, [
      'TABLE(claude,codex)',
      '',
      'Route first: claude > codex',
      '',
      'claude models (--model <id>):',
      '  opus-x  [default]  efforts: low, medium, high*  ctx 200k',
      '  haiku-y  ctx 2k',
      'codex models (--model <id>):',
      '  codex not installed',
    ].join('\n'));
    for (const line of result.stdout.split('\n')) {
      assert.equal(line, line.trimEnd(), `trailing whitespace in ${JSON.stringify(line)}`);
    }
  });

  it('omits the efforts part when a model has missing or non-array efforts', async () => {
    const { deps } = fakeDeps({
      models: {
        claude: async () => ({
          ...okModels('claude'),
          models: [
            { ...okModels('claude').models[0], id: 'no-efforts', isDefault: false, efforts: undefined as unknown as string[] },
            { ...okModels('claude').models[0], id: 'string-efforts', isDefault: false, efforts: 'low' as unknown as string[] },
          ],
        }),
      },
    });
    const result = await runQuota(['--models', 'claude'], deps);

    assert.equal(result.stdout, [
      'TABLE(claude)',
      '',
      'Route first: claude',
      '',
      'claude models (--model <id>):',
      '  no-efforts',
      '  string-efforts',
    ].join('\n'));
  });

  it('lists no models when the model list is missing or non-array', async () => {
    const { deps } = fakeDeps({
      models: {
        claude: async () => ({ ...okModels('claude'), models: undefined as unknown as HarnessModel[] }),
        codex: async () => ({ ...okModels('codex'), models: 'nope' as unknown as HarnessModel[] }),
      },
    });
    const result = await runQuota(['--models', 'claude', 'codex'], deps);

    assert.equal(result.stdout, [
      'TABLE(claude,codex)',
      '',
      'Route first: claude > codex',
      '',
      'claude models (--model <id>):',
      '  (none listed)',
      'codex models (--model <id>):',
      '  (none listed)',
    ].join('\n'));
  });
});

describe('runQuota tier guidance, unchecked picks and pricing markers in table mode', () => {
  const pick = (
    provider: QuotaProviderId,
    model: string,
    overrides: Partial<AnnotatedTier['picks'][number]> = {},
  ): AnnotatedTier['picks'][number] => ({
    provider,
    model,
    effort: null,
    modelName: null,
    availability: 'available',
    leftPercent: null,
    resetsAt: null,
    scopedLimits: [],
    problem: null,
    checked: true,
    ...overrides,
  });

  const listed = (id: string, pricing?: HarnessModel['pricing']): HarnessModel => ({
    id,
    name: null,
    isDefault: false,
    description: null,
    contextTokens: null,
    efforts: [],
    defaultEffort: null,
    ...(pricing === undefined ? {} : { pricing }),
  });

  it('prints single-line guidance after a tier\'s picks, and still prints it for a tier with no picks', async () => {
    const config: ModelRoutingConfig = {
      version: 1,
      tiers: [
        { name: 'complex', description: '', picks: [{ provider: 'claude', model: 'opus', effort: null }], guidance: 'prefer opus' },
        { name: 'simple', description: '', picks: [], guidance: 'otherwise any free opencode model' },
      ],
      steering: '',
    };
    const annotated: AnnotatedTier[] = [
      { name: 'complex', description: '', guidance: 'prefer opus', picks: [pick('claude', 'opus', { leftPercent: 90 })] },
      { name: 'simple', description: '', guidance: 'otherwise any free opencode model', picks: [] },
    ];
    const { deps } = fakeDeps({ routing: okRouting(config), annotate: () => annotated });
    const result = await runQuota(['claude'], deps);

    assert.equal(result.stdout, [
      'TABLE(claude)',
      '',
      'Route first: claude',
      '',
      'Your tiers:',
      'complex',
      '  1. claude opus  available 90% left',
      '  guidance: prefer opus',
      'simple',
      '  (no picks yet)',
      '  guidance: otherwise any free opencode model',
    ].join('\n'));
  });

  it('prints multi-line guidance with the first line labelled and later lines aligned, dropping blank edges', async () => {
    const config: ModelRoutingConfig = {
      version: 1,
      tiers: [{ name: 'complex', description: '', picks: [], guidance: '\nfirst line\n\nthird line  \n\n' }],
      steering: '',
    };
    const annotated: AnnotatedTier[] = [
      { name: 'complex', description: '', guidance: '\nfirst line\n\nthird line  \n\n', picks: [] },
    ];
    const { deps } = fakeDeps({ routing: okRouting(config), annotate: () => annotated });
    const result = await runQuota(['claude'], deps);

    assert.equal(result.stdout, [
      'TABLE(claude)',
      '',
      'Route first: claude',
      '',
      'Your tiers:',
      'complex',
      '  (no picks yet)',
      '  guidance: first line',
      '',
      `${' '.repeat(12)}third line`,
    ].join('\n'));
    for (const line of result.stdout.split('\n')) {
      assert.equal(line, line.trimEnd(), `trailing whitespace in ${JSON.stringify(line)}`);
    }
  });

  it('prints no guidance line for empty, blank, or missing guidance (older data)', async () => {
    const config: ModelRoutingConfig = {
      version: 1,
      tiers: [{ name: 'complex', description: '', picks: [{ provider: 'claude', model: 'opus', effort: null }], guidance: '' }],
      steering: '',
    };
    const annotated = [
      { name: 'complex', description: '', guidance: '   \n  ', picks: [pick('claude', 'opus', { leftPercent: 90 })] },
      { name: 'simple', description: '', picks: [] },
    ] as unknown as AnnotatedTier[];
    const { deps } = fakeDeps({ routing: okRouting(config), annotate: () => annotated });
    const result = await runQuota(['claude'], deps);

    assert.equal(result.stdout.includes('guidance'), false);
    assert.equal(result.stdout.endsWith('simple\n  (no picks yet)'), true);
  });

  it('marks an unchecked pick with a suffix, keeps a pick with a problem unchanged, and treats a missing checked as checked', async () => {
    const config: ModelRoutingConfig = {
      version: 1,
      tiers: [{
        name: 'complex',
        description: '',
        picks: [{ provider: 'claude', model: 'opus', effort: null }, { provider: 'codex', model: 'gpt-x', effort: null }],
        guidance: '',
      }],
      steering: '',
    };
    const annotated: AnnotatedTier[] = [{
      name: 'complex',
      description: '',
      guidance: '',
      picks: [
        pick('claude', 'opus', { availability: 'unknown', checked: false }),
        pick('codex', 'gpt-x', { availability: 'available', problem: 'model no longer offered', checked: false }),
        { ...pick('claude', 'haiku'), checked: undefined } as unknown as AnnotatedTier['picks'][number],
      ],
    }];
    const { deps } = fakeDeps({ routing: okRouting(config), annotate: () => annotated });
    const result = await runQuota(['claude', 'codex'], deps);

    assert.equal(result.stdout, [
      'TABLE(claude,codex)',
      '',
      'Route first: claude > codex',
      '',
      'Your tiers:',
      'complex',
      '  1. claude opus  unknown (not checked: model list unavailable)',
      '  2. codex gpt-x  available  ! model no longer offered',
      '  3. claude haiku  available',
    ].join('\n'));
  });

  it('appends a pricing marker for free and included models and nothing for paid or absent pricing', async () => {
    const { deps } = fakeDeps({
      models: {
        claude: async () => ({
          provider: 'claude',
          status: 'ok',
          models: [listed('free-m', 'free'), listed('inc-m', 'included'), listed('paid-m', 'paid'), listed('none-m')],
          source: 'live',
          observedAt: NOW.toISOString(),
          message: null,
          modelFlag: '--model <id>',
          effortFlag: null,
        }),
      },
    });
    const result = await runQuota(['--models', 'claude'], deps);

    assert.equal(result.stdout, [
      'TABLE(claude)',
      '',
      'Route first: claude',
      '',
      'claude models (--model <id>):',
      '  free-m [free]',
      '  inc-m [included in plan]',
      '  paid-m',
      '  none-m',
    ].join('\n'));
  });

  it('treats missing or non-array tier picks as no picks', async () => {
    const config: ModelRoutingConfig = {
      version: 1,
      tiers: [{ name: 'complex', description: '', picks: [], guidance: '' }],
      steering: '',
    };
    const annotated = [
      { name: 'complex', description: '', guidance: 'prefer opus' },
      { name: 'simple', description: '', guidance: '', picks: 'nope' },
    ] as unknown as AnnotatedTier[];
    const { deps } = fakeDeps({ routing: okRouting(config), annotate: () => annotated });
    const result = await runQuota(['claude'], deps);

    assert.equal(result.stdout, [
      'TABLE(claude)',
      '',
      'Route first: claude',
      '',
      'Your tiers:',
      'complex',
      '  (no picks yet)',
      '  guidance: prefer opus',
      'simple',
      '  (no picks yet)',
    ].join('\n'));
  });

  it('prints no guidance line for non-string guidance', async () => {
    const config: ModelRoutingConfig = {
      version: 1,
      tiers: [{ name: 'complex', description: '', picks: [], guidance: '' }],
      steering: '',
    };
    const annotated = [
      { name: 'complex', description: '', guidance: 42, picks: [] },
      { name: 'simple', description: '', guidance: null, picks: [] },
      { name: 'other', description: '', guidance: ['prefer opus'], picks: [] },
    ] as unknown as AnnotatedTier[];
    const { deps } = fakeDeps({ routing: okRouting(config), annotate: () => annotated });
    const result = await runQuota(['claude'], deps);

    assert.equal(result.stdout.includes('guidance'), false);
    assert.equal(result.stdout.includes('42'), false);
  });

  it('prints CRLF guidance as aligned multi-line text', async () => {
    const config: ModelRoutingConfig = {
      version: 1,
      tiers: [{ name: 'complex', description: '', picks: [], guidance: '' }],
      steering: '',
    };
    const annotated: AnnotatedTier[] = [
      { name: 'complex', description: '', guidance: 'first\r\nsecond\r\n\r\nfourth\r\n', picks: [] },
    ];
    const { deps } = fakeDeps({ routing: okRouting(config), annotate: () => annotated });
    const result = await runQuota(['claude'], deps);

    assert.equal(result.stdout, [
      'TABLE(claude)',
      '',
      'Route first: claude',
      '',
      'Your tiers:',
      'complex',
      '  (no picks yet)',
      '  guidance: first',
      `${' '.repeat(12)}second`,
      '',
      `${' '.repeat(12)}fourth`,
    ].join('\n'));
  });

  it('prints 0% left and suppresses missing or non-finite leftPercent', async () => {
    const config: ModelRoutingConfig = {
      version: 1,
      tiers: [{ name: 'complex', description: '', picks: [], guidance: '' }],
      steering: '',
    };
    const annotated: AnnotatedTier[] = [{
      name: 'complex',
      description: '',
      guidance: '',
      picks: [
        pick('claude', 'opus', { leftPercent: 0 }),
        { ...pick('claude', 'haiku'), leftPercent: undefined } as unknown as AnnotatedTier['picks'][number],
        { ...pick('claude', 'sonnet'), leftPercent: Number.NaN },
        { ...pick('claude', 'fable'), leftPercent: Number.POSITIVE_INFINITY },
        { ...pick('claude', 'muse'), leftPercent: '5' as unknown as number },
      ],
    }];
    const { deps } = fakeDeps({ routing: okRouting(config), annotate: () => annotated });
    const result = await runQuota(['claude'], deps);

    assert.equal(result.stdout, [
      'TABLE(claude)',
      '',
      'Route first: claude',
      '',
      'Your tiers:',
      'complex',
      '  1. claude opus  available 0% left',
      '  2. claude haiku  available',
      '  3. claude sonnet  available',
      '  4. claude fable  available',
      '  5. claude muse  available',
    ].join('\n'));
  });

  it('shows the unchecked suffix when the problem is an empty string and checked is false', async () => {
    const config: ModelRoutingConfig = {
      version: 1,
      tiers: [{ name: 'complex', description: '', picks: [], guidance: '' }],
      steering: '',
    };
    const annotated: AnnotatedTier[] = [{
      name: 'complex',
      description: '',
      guidance: '',
      picks: [pick('claude', 'opus', { availability: 'unknown', problem: '', checked: false })],
    }];
    const { deps } = fakeDeps({ routing: okRouting(config), annotate: () => annotated });
    const result = await runQuota(['claude'], deps);

    assert.equal(result.stdout, [
      'TABLE(claude)',
      '',
      'Route first: claude',
      '',
      'Your tiers:',
      'complex',
      '  1. claude opus  unknown (not checked: model list unavailable)',
    ].join('\n'));
  });

  it('prints tier guidance before steering', async () => {
    const config: ModelRoutingConfig = {
      version: 1,
      tiers: [{ name: 'complex', description: 'Hard dev', picks: [{ provider: 'claude', model: 'opus', effort: null }], guidance: 'prefer opus' }],
      steering: 'line one\nline two',
    };
    const annotated: AnnotatedTier[] = [
      { name: 'complex', description: 'Hard dev', guidance: 'prefer opus', picks: [pick('claude', 'opus', { leftPercent: 90 })] },
    ];
    const { deps } = fakeDeps({ routing: okRouting(config), annotate: () => annotated });
    const result = await runQuota(['claude'], deps);

    assert.equal(result.stdout, [
      'TABLE(claude)',
      '',
      'Route first: claude',
      '',
      'Your tiers:',
      'complex - Hard dev',
      '  1. claude opus  available 90% left',
      '  guidance: prefer opus',
      '',
      'Steering: line one line two',
    ].join('\n'));
  });
});

describe('runQuota model routing in table mode', () => {
  it('prints the tiers, picks with effort, problems and empty tiers, then steering', async () => {
    const { deps } = fakeDeps({ routing: okRouting(TIER_CONFIG), annotate: () => ANNOTATED });
    const result = await runQuota(['claude', 'codex'], deps);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, [
      'TABLE(claude,codex)',
      '',
      'Route first: claude > codex',
      '',
      'Your tiers:',
      'complex - Hard dev',
      '  1. claude opus @high  low 12% left',
      '  2. codex gpt-x  available  ! model no longer offered',
      'simple',
      '  (no picks yet)',
      '',
      'Steering: don\'t fully exhaust Claude',
    ].join('\n'));
    for (const line of result.stdout.split('\n')) {
      assert.equal(line, line.trimEnd(), `trailing whitespace in ${JSON.stringify(line)}`);
    }
  });

  it('collapses newlines in steering to spaces', async () => {
    const config: ModelRoutingConfig = { version: 1, tiers: [], steering: 'line one\n  line two' };
    const { deps } = fakeDeps({ routing: okRouting(config) });
    const result = await runQuota(['claude'], deps);

    assert.equal(result.stdout, 'TABLE(claude)\n\nRoute first: claude\n\nSteering: line one line two');
  });

  it('prints no steering block when steering is missing or non-string', async () => {
    for (const steering of [undefined, 42]) {
      const config = { version: 1, tiers: [], steering } as unknown as ModelRoutingConfig;
      const { deps } = fakeDeps({
        routing: async () => ({ state: { status: 'ok', path: ROUTING_PATH, errors: [] }, config }),
        annotate: () => [],
      });
      const result = await runQuota(['claude'], deps);

      assert.equal(result.stdout, 'TABLE(claude)\n\nRoute first: claude', String(steering));
    }
  });

  it('prints the setup line when no routing file exists', async () => {
    const missing: RoutingLoader = async () => ({
      state: { status: 'missing', path: ROUTING_PATH, errors: [] },
      config: null,
    });
    const { deps } = fakeDeps({ routing: missing });
    const result = await runQuota(['claude'], deps);

    assert.equal(
      result.stdout,
      'TABLE(claude)\n\nRoute first: claude\n\n'
      + 'No model routing set up yet: open Model routing for this bridge in the dashboard.',
    );
  });

  it('prints the first error when the routing file is invalid', async () => {
    const invalid: RoutingLoader = async () => ({
      state: { status: 'invalid', path: ROUTING_PATH, errors: ['tiers[0].name is not valid', 'second'] },
      config: null,
    });
    const { deps } = fakeDeps({ routing: invalid });
    const result = await runQuota(['claude'], deps);

    assert.equal(
      result.stdout,
      'TABLE(claude)\n\nRoute first: claude\n\nModel routing file has errors: tiers[0].name is not valid',
    );
  });

  it('fetches model lists when the config has picks, without --models, and prints no model section', async () => {
    const { deps, modelCalls } = fakeDeps({ routing: okRouting(TIER_CONFIG), annotate: () => ANNOTATED });
    const result = await runQuota(['claude'], deps);

    assert.deepEqual(modelCalls.map(call => call.provider), ['claude']);
    assert.equal(result.stdout.includes('models ('), false);
  });

  it('does not fetch model lists with --no-models even when the config has picks', async () => {
    const { deps, modelCalls } = fakeDeps({ routing: okRouting(TIER_CONFIG), annotate: () => ANNOTATED });
    await runQuota(['--no-models', 'claude'], deps);

    assert.equal(modelCalls.length, 0);
  });
});

describe('runQuota JSON mode', () => {
  it('prints a QuotaReport whose providers, routing and models match the run', async () => {
    const { deps } = fakeDeps();
    const result = await runQuota(['--json', 'grok', 'claude'], deps);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout) as QuotaReport;
    assert.deepEqual(Object.keys(report).sort(), ['generatedAt', 'models', 'providers', 'routing', 'routingConfig', 'steering', 'tiers']);
    assert.equal(report.generatedAt, NOW.toISOString());
    assert.deepEqual(report.providers, [okRow('claude'), okRow('grok')]);
    assert.deepEqual(report.routing.map(entry => entry.provider), ['claude', 'grok']);
    assert.deepEqual(report.models, [okModels('claude'), okModels('grok')]);
    assert.equal(result.stdout, JSON.stringify(report, null, 2));
  });

  it('carries the routing config, annotated tiers and steering into the report', async () => {
    const { deps } = fakeDeps({ routing: okRouting(TIER_CONFIG), annotate: () => ANNOTATED });
    const result = await runQuota(['--json', 'claude', 'codex'], deps);
    const report = JSON.parse(result.stdout) as QuotaReport;

    assert.deepEqual(report.routingConfig, { status: 'ok', path: ROUTING_PATH, errors: [] });
    assert.deepEqual(report.tiers, ANNOTATED);
    assert.equal(report.steering, 'don\'t fully exhaust Claude');
    assert.equal(result.stderr, '');
  });

  it('reports a missing routing file with no tiers and no steering', async () => {
    const missing: RoutingLoader = async () => ({
      state: { status: 'missing', path: ROUTING_PATH, errors: [] },
      config: null,
    });
    const { deps } = fakeDeps({
      routing: missing,
      annotate: () => { throw new Error('annotate must not run without a config'); },
    });
    const result = await runQuota(['--json', 'claude'], deps);
    const report = JSON.parse(result.stdout) as QuotaReport;

    assert.deepEqual(report.routingConfig, { status: 'missing', path: ROUTING_PATH, errors: [] });
    assert.deepEqual(report.tiers, []);
    assert.equal(report.steering, '');
    assert.equal(result.stderr, '');
  });

  it('reports an invalid routing file with its errors and no tiers', async () => {
    const invalidState: RoutingConfigState = { status: 'invalid', path: ROUTING_PATH, errors: ['steering is too long'] };
    const invalid: RoutingLoader = async () => ({ state: invalidState, config: null });
    const { deps } = fakeDeps({ routing: invalid });
    const result = await runQuota(['--json', 'claude'], deps);
    const report = JSON.parse(result.stdout) as QuotaReport;

    assert.deepEqual(report.routingConfig, invalidState);
    assert.deepEqual(report.tiers, []);
    assert.equal(report.steering, '');
    assert.equal(result.exitCode, 0);
  });

  it('keeps the report valid with a fallback and a warning when loading the routing file rejects', async () => {
    const { deps } = fakeDeps({
      routing: async () => { throw new Error('disk gone'); },
    });
    const result = await runQuota(['--json'], deps);
    const report = JSON.parse(result.stdout) as QuotaReport;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, 'ftown-quota: model routing could not be loaded: disk gone');
    assert.deepEqual(report.routingConfig, { status: 'invalid', path: '', errors: ['could not load the routing file'] });
    assert.deepEqual(report.tiers, []);
    assert.equal(report.steering, '');
    assert.equal(report.providers.length, QUOTA_PROVIDER_IDS.length);
  });

  it('keeps the report valid with a fallback and a warning when annotating throws', async () => {
    const { deps } = fakeDeps({
      routing: okRouting(TIER_CONFIG),
      annotate: () => { throw new Error('bad join'); },
    });
    const result = await runQuota(['--json', 'claude'], deps);
    const report = JSON.parse(result.stdout) as QuotaReport;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, 'ftown-quota: model routing could not be annotated: bad join');
    assert.deepEqual(report.routingConfig, { status: 'invalid', path: '', errors: ['could not load the routing file'] });
    assert.deepEqual(report.tiers, []);
    assert.equal(report.steering, '');
  });

  it('defaults missing or non-string steering to empty in the report', async () => {
    for (const steering of [undefined, null, 42]) {
      const config = { version: 1, tiers: [], steering } as unknown as ModelRoutingConfig;
      const { deps } = fakeDeps({
        routing: async () => ({ state: { status: 'ok', path: ROUTING_PATH, errors: [] }, config }),
        annotate: () => [],
      });
      const result = await runQuota(['--json', 'claude'], deps);
      const report = JSON.parse(result.stdout) as QuotaReport;

      assert.equal(report.steering, '', String(steering));
      assert.equal('steering' in report, true);
    }
  });

  it('keeps the routing order returned by advise', async () => {
    const advise: QuotaRoutingAdvisor = rows => [...rows].reverse().map(row => routingFor(row));
    const { deps, advised } = fakeDeps({ advise });
    const result = await runQuota(['--json', 'claude', 'codex', 'muse'], deps);
    const report = JSON.parse(result.stdout) as QuotaReport;

    assert.deepEqual(report.routing.map(entry => entry.provider), ['muse', 'codex', 'claude']);
    assert.deepEqual(report.providers.map(row => row.provider), ['claude', 'codex', 'muse']);
    assert.deepEqual(advised[0].rows.map(row => row.provider), ['claude', 'codex', 'muse']);
    assert.equal(advised[0].now.getTime(), NOW.getTime());
  });

  it('includes model lists by default, and an empty models array with --no-models', async () => {
    const withModels = await runQuota(['--json', 'codex'], fakeDeps().deps);
    assert.deepEqual((JSON.parse(withModels.stdout) as QuotaReport).models, [okModels('codex')]);

    const { deps, modelCalls } = fakeDeps();
    const skipped = await runQuota(['--json', '--no-models', 'codex'], deps);
    assert.deepEqual((JSON.parse(skipped.stdout) as QuotaReport).models, []);
    assert.equal(modelCalls.length, 0);
  });

  it('turns a rejecting quota fetcher into an error row while the others still appear', async () => {
    const { deps } = fakeDeps({
      quota: { codex: async () => { throw new Error('keychain locked\nsecond line'); } },
    });
    const result = await runQuota(['--json'], deps);
    const report = JSON.parse(result.stdout) as QuotaReport;

    assert.equal(result.exitCode, 0);
    assert.deepEqual(report.providers.map(row => row.provider), [...QUOTA_PROVIDER_IDS]);
    const codex = report.providers[1];
    assert.equal(codex.status, 'error');
    assert.deepEqual(codex.windows, []);
    assert.equal(codex.plan, null);
    assert.equal(codex.source, 'live');
    assert.equal(codex.observedAt, NOW.toISOString());
    assert.equal(codex.message, 'codex check failed: keychain locked');
    assert.equal(report.providers[0].status, 'ok');
  });

  it('turns a synchronous throw from a quota fetcher into an error row', async () => {
    const { deps } = fakeDeps({
      quota: { grok: () => { throw new Error('boom'); } },
    });
    const result = await runQuota(['--json', 'grok'], deps);
    const report = JSON.parse(result.stdout) as QuotaReport;
    assert.equal(report.providers[0].status, 'error');
    assert.equal(report.providers[0].message, 'grok check failed: boom');
  });

  it('turns a never-settling quota fetcher into a timeout row', async () => {
    const { deps } = fakeDeps({
      quota: { muse: () => new Promise<ProviderQuota>(() => { /* never settles */ }) },
      models: { muse: async () => okModels('muse') },
      graceMs: 0,
    });
    const result = await runQuota(['--json', 'muse', '--timeout', '1'], deps);
    const report = JSON.parse(result.stdout) as QuotaReport;

    assert.equal(result.exitCode, 0);
    assert.equal(report.providers.length, 1);
    assert.equal(report.providers[0].provider, 'muse');
    assert.equal(report.providers[0].status, 'error');
    assert.equal(report.providers[0].message, 'muse check timed out');
  });

  it('turns a rejecting model fetcher into an error entry while quota rows still appear', async () => {
    const { deps } = fakeDeps({
      models: { claude: async () => { throw new Error('nope'); } },
    });
    const result = await runQuota(['--json', 'claude', 'grok'], deps);
    const report = JSON.parse(result.stdout) as QuotaReport;

    assert.deepEqual(report.providers, [okRow('claude'), okRow('grok')]);
    assert.deepEqual(report.models[0], {
      provider: 'claude',
      status: 'error',
      models: [],
      source: 'live',
      observedAt: NOW.toISOString(),
      message: 'claude model list failed: nope',
      modelFlag: '',
      effortFlag: null,
    });
    assert.deepEqual(report.models[1], okModels('grok'));
  });

  it('turns a never-settling model fetcher into a timed-out model entry', async () => {
    const { deps } = fakeDeps({
      models: { codex: () => new Promise<ProviderModels>(() => { /* never settles */ }) },
      graceMs: 0,
    });
    const result = await runQuota(['--json', 'codex', 'grok', '--timeout', '1'], deps);
    const report = JSON.parse(result.stdout) as QuotaReport;

    assert.deepEqual(report.providers, [okRow('codex'), okRow('grok')]);
    assert.equal(report.models[0].status, 'error');
    assert.equal(report.models[0].message, 'codex model list timed out');
    assert.deepEqual(report.models[1], okModels('grok'));
  });

  it('calls only the selected quota and model fetchers, with the timeout and home directory', async () => {
    const { deps, quotaCalls, modelCalls } = fakeDeps();
    await runQuota(['--json', 'codex', 'muse', '--timeout=7'], deps);

    assert.deepEqual(quotaCalls.map(call => call.provider).sort(), ['codex', 'muse']);
    assert.deepEqual(modelCalls.map(call => call.provider).sort(), ['codex', 'muse']);
    for (const call of [...quotaCalls, ...modelCalls]) {
      assert.equal(call.timeoutMs, 7000);
      assert.equal(call.homeDir, '/home/test');
    }
  });
});

describe('collectQuotaReport', () => {
  it('returns hung true when a quota fetcher never settles', async () => {
    const { deps } = fakeDeps({
      quota: { muse: () => new Promise<ProviderQuota>(() => { /* never settles */ }) },
      graceMs: 0,
    });
    const collected = await collectQuotaReport({ providers: ['muse'], timeoutMs: 1, includeModels: false }, deps);

    assert.equal(collected.hung, true);
    assert.equal(collected.report.providers[0].message, 'muse check timed out');
    assert.deepEqual(collected.warnings, []);
  });

  it('returns hung false when every fetcher settles', async () => {
    const { deps } = fakeDeps();
    const collected = await collectQuotaReport({ providers: ['claude'], timeoutMs: 1000, includeModels: true }, deps);

    assert.equal(collected.hung, false);
    assert.deepEqual(collected.report.models, [okModels('claude')]);
  });
});

describe('runQuota all providers', () => {
  it('default selection calls all six quota and six model fetchers', async () => {
    const { deps, quotaCalls, modelCalls } = fakeDeps();
    const result = await runQuota(['--json'], deps);
    const report = JSON.parse(result.stdout) as QuotaReport;

    assert.deepEqual(quotaCalls.map(call => call.provider).sort(), [...QUOTA_PROVIDER_IDS].sort());
    assert.deepEqual(modelCalls.map(call => call.provider).sort(), [...QUOTA_PROVIDER_IDS].sort());
    assert.deepEqual(report.providers.map(row => row.provider), [...QUOTA_PROVIDER_IDS]);
    assert.deepEqual(report.models.map(list => list.provider), [...QUOTA_PROVIDER_IDS]);
  });

  it('JSON never truncates a model list longer than 20', async () => {
    const many: HarnessModel[] = Array.from({ length: 23 }, (_, i) => ({
      id: `m${i + 1}`,
      name: null,
      isDefault: false,
      description: null,
      contextTokens: null,
      efforts: [],
      defaultEffort: null,
    }));
    const { deps } = fakeDeps({
      models: { opencode: async () => ({ ...okModels('opencode'), models: many }) },
    });
    const result = await runQuota(['--json', 'opencode'], deps);
    const report = JSON.parse(result.stdout) as QuotaReport;

    assert.equal(report.models[0].models.length, 23);
    assert.equal(result.stdout.includes('more (use --json'), false);
  });
});

async function captureOutput(run: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  // Honour the write callback, as a real stream does, so runQuotaCli's flush waits do not hang.
  const capture = (sink: string[]) => (chunk: string | Uint8Array, encodingOrCallback?: unknown, callback?: unknown): boolean => {
    sink.push(String(chunk));
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (typeof done === 'function') done();
    return true;
  };
  process.stdout.write = capture(out) as unknown as typeof process.stdout.write;
  process.stderr.write = capture(err) as unknown as typeof process.stderr.write;
  try {
    const code = await run();
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

/** Fails the test if the promise does not settle within `ms`. */
async function resolvesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not resolve within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
  }
}

describe('runQuotaCli', () => {
  it('resolves even when the stream ignores write callbacks (recorders used by in-process callers)', async () => {
    const recorded: string[] = [];
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    const recorder = (chunk: string | Uint8Array): boolean => { recorded.push(String(chunk)); return true; };
    process.stdout.write = recorder as unknown as typeof process.stdout.write;
    process.stderr.write = recorder as unknown as typeof process.stderr.write;
    try {
      const helpCode = await resolvesWithin(runQuotaCli(['--help']), 2000);
      const bogusCode = await resolvesWithin(runQuotaCli(['bogus']), 2000);
      assert.equal(helpCode, 0);
      assert.equal(bogusCode, 2);
      assert.equal(recorded.join('').includes(QUOTA_HELP_TEXT), true);
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
  });

  it('resolves to 0 for --help and prints the help text, loading no provider module', async () => {
    const { code, out, err } = await captureOutput(() => runQuotaCli(['--help']));
    assert.equal(code, 0);
    assert.equal(out, `${QUOTA_HELP_TEXT}\n`);
    assert.equal(err, '');
  });

  it('leaves the stdout error listener count unchanged after a call', async () => {
    const before = process.stdout.listenerCount('error');
    await captureOutput(() => runQuotaCli(['--help']));
    assert.equal(process.stdout.listenerCount('error'), before);
  });

  it('resolves to 2 for an unknown provider and writes the error and help to stderr', async () => {
    const { code, out, err } = await captureOutput(() => runQuotaCli(['bogus']));
    assert.equal(code, 2);
    assert.equal(out, '');
    assert.equal(err, `unknown provider: bogus (expected claude, codex, grok, muse, agy, opencode)\n${QUOTA_HELP_TEXT}\n`);
  });
});

describe('runQuota hung fetchers and advice failures', () => {
  it('reports hung true when a quota fetcher never settles', async () => {
    const { deps } = fakeDeps({
      quota: { muse: () => new Promise<ProviderQuota>(() => { /* never settles */ }) },
      graceMs: 0,
    });
    const result = await runQuota(['--json', 'muse', '--timeout', '1'], deps);
    assert.equal(result.hung, true);
    assert.equal((JSON.parse(result.stdout) as QuotaReport).providers[0].message, 'muse check timed out');
  });

  it('reports hung true when a model fetcher never settles', async () => {
    const { deps } = fakeDeps({
      models: { codex: () => new Promise<ProviderModels>(() => { /* never settles */ }) },
      graceMs: 0,
    });
    const result = await runQuota(['--json', 'codex', '--timeout', '1'], deps);
    assert.equal(result.hung, true);
  });

  it('reports hung false when every fetcher settles, including rejections', async () => {
    const { deps } = fakeDeps({
      quota: { codex: async () => { throw new Error('broken'); } },
      models: { grok: async () => { throw new Error('broken too'); } },
    });
    const result = await runQuota(['--json'], deps);
    assert.equal(result.hung, false);
  });

  it('keeps JSON valid with six unknown routing entries and a stderr line when the advisor throws', async () => {
    const { deps } = fakeDeps({
      advise: () => { throw new Error('bad advice\nsecond line'); },
    });
    const result = await runQuota(['--json'], deps);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, 'ftown-quota: routing advice failed: bad advice');
    const report = JSON.parse(result.stdout) as QuotaReport;
    assert.deepEqual(report.providers.map(row => row.provider), [...QUOTA_PROVIDER_IDS]);
    assert.deepEqual(report.routing.map(entry => entry.provider), [...QUOTA_PROVIDER_IDS]);
    for (const entry of report.routing) {
      assert.equal(entry.availability, 'unknown');
      assert.equal(entry.leftPercent, null);
      assert.equal(entry.reason, 'routing unavailable');
    }
    assert.equal(report.models.length, QUOTA_PROVIDER_IDS.length);
  });

  it('prints the table with every provider marked unknown when the advisor throws', async () => {
    const { deps } = fakeDeps({
      advise: () => { throw new Error('bad advice'); },
    });
    const result = await runQuota([], deps);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, 'ftown-quota: routing advice failed: bad advice');
    assert.equal(
      result.stdout,
      'TABLE(claude,codex,grok,muse,agy,opencode)\n\n'
      + 'Route first: claude (unknown) > codex (unknown) > grok (unknown) > muse (unknown) > agy (unknown) > opencode (unknown)',
    );
  });
});

describe('runQuota errors and help', () => {
  it('exits 2 with the error and help text on a parse error, without calling any fetcher', async () => {
    const { deps, quotaCalls, modelCalls } = fakeDeps();
    const result = await runQuota(['--timeout', 'never'], deps);

    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `invalid --timeout value\n${QUOTA_HELP_TEXT}`);
    assert.equal(quotaCalls.length + modelCalls.length, 0);
  });

  it('exits 2 for combined --models and --no-models without calling any fetcher', async () => {
    const { deps, quotaCalls, modelCalls } = fakeDeps();
    const result = await runQuota(['--models', '--no-models'], deps);

    assert.equal(result.exitCode, 2);
    assert.equal(result.stderr, `cannot combine --models and --no-models\n${QUOTA_HELP_TEXT}`);
    assert.equal(quotaCalls.length + modelCalls.length, 0);
  });

  it('prints the help text with exit 0 for -h, mentioning the new flags and the router agent', async () => {
    const { deps, quotaCalls } = fakeDeps();
    const result = await runQuota(['-h'], deps);

    assert.deepEqual(result, { exitCode: 0, stdout: QUOTA_HELP_TEXT, stderr: '', hung: false });
    assert.match(QUOTA_HELP_TEXT, /--models/);
    assert.match(QUOTA_HELP_TEXT, /--no-models/);
    assert.match(QUOTA_HELP_TEXT, /machine-readable report \(quota, routing advice, models, routing tiers, steering\) for agents/);
    assert.match(QUOTA_HELP_TEXT, /router agent/);
    assert.equal(quotaCalls.length, 0);
  });
});

describe('loadRealQuotaDeps', () => {
  it('is exported as a function and is not called here', () => {
    assert.equal(typeof loadRealQuotaDeps, 'function');
  });
});
