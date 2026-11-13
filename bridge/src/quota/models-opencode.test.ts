import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  OPENCODE_PLAN_PROVIDERS,
  fetchOpencodeModels,
  isOpencodePlanProvider,
  opencodeSubscriptionProviders,
  parseOpencodeModelIds,
  parseOpencodeModels,
  readOpencodeCatalogue,
  resolveOpencodeBinary,
} from './models-opencode.js';
import type { HarnessModel, QuotaFetchOptions } from './types.js';

const OBSERVED = '2026-11-13T10:00:00.000Z';
const NOW = new Date(OBSERVED);
const PROVIDERS_ENV = 'FTOWN_QUOTA_OPENCODE_PROVIDERS';
const PLAN = ['opencode-go', 'zai-coding-plan'];

const CLI_OUTPUT = [
  'openrouter/zeta-free',
  'opencode-go/kimi-k2.7',
  'zai-coding-plan/glm-5.3',
  'openrouter/paid-model',
  'opencode-go/beam-free',
  'openrouter/alpha-free',
  'opencode-go/cli-only',
  'zai-coding-plan/glm-5.3',
  '',
].join('\n');

const CATALOGUE = {
  'opencode-go': {
    id: 'opencode-go',
    models: {
      'kimi-k2.7': {
        id: 'kimi-k2.7',
        name: 'Kimi K2.7',
        description: 'Fast\ncoding model',
        limit: { context: 262144, output: 32768 },
        cost: { input: 0.6, output: 2.5, cache_read: 0.1 },
        reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'medium', 'high'] }],
      },
      'beam-free': {
        id: 'beam-free',
        name: 'Beam Free',
        limit: { context: 1048576 },
        cost: { input: 0, output: 0, cache_read: 0 },
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
      },
      'catalogue-only': { id: 'catalogue-only', name: 'Not listed', cost: { input: 0, output: 0 } },
    },
  },
  'zai-coding-plan': {
    models: {
      'glm-5.3': {
        name: 'GLM-5.3',
        limit: { context: 200000 },
        cost: { input: 0, output: 0 },
        reasoning_options: [{ type: 'budget_tokens', min: 1024 }],
      },
    },
  },
  openrouter: {
    models: {
      'zeta-free': { name: 'Zeta (free)', cost: { input: 0, output: 0 } },
      'alpha-free': { name: 'Alpha (free)', cost: { input: 0, output: 0 }, limit: { context: 'big' } },
      'paid-model': { name: 'Paid', cost: { input: 0, output: 1 } },
      'unlisted-free': { name: 'Unlisted', cost: { input: 0, output: 0 } },
    },
  },
};

const savedPath = process.env.PATH;
const savedProviders = process.env[PROVIDERS_ENV];
const opened: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-models-test-'));
  opened.push(dir);
  return dir;
}

afterEach(async () => {
  while (opened.length > 0) {
    const dir = opened.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
  if (savedProviders === undefined) delete process.env[PROVIDERS_ENV];
  else process.env[PROVIDERS_ENV] = savedProviders;
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
});

function byId(models: HarnessModel[]): Map<string, HarnessModel> {
  return new Map(models.map((model) => [model.id, model]));
}

describe('parseOpencodeModelIds', () => {
  it('keeps provider/model lines in order, tolerating CRLF and blank lines, without duplicates', () => {
    const stdout = '\r\nopencode-go/a\r\n\r\n  zai-coding-plan/b  \r\nopencode-go/a\r\nopenrouter/x/y:free\r\n';
    assert.deepEqual(parseOpencodeModelIds(stdout), [
      'opencode-go/a',
      'zai-coding-plan/b',
      'openrouter/x/y:free',
    ]);
  });

  it('ignores lines without a slash, with an empty part, or with whitespace', () => {
    const stdout = ['no-slash', '/model', 'provider/', 'Warning: see https://x/y', 'ok/model', '\u001b[1mok/bold'].join('\n');
    assert.deepEqual(parseOpencodeModelIds(stdout), ['ok/model']);
  });
});

describe('isOpencodePlanProvider', () => {
  it('counts the listed plan providers and any coding-plan provider', () => {
    assert.deepEqual([...OPENCODE_PLAN_PROVIDERS], []);
    for (const id of OPENCODE_PLAN_PROVIDERS) assert.equal(isOpencodePlanProvider(id), true);
    assert.equal(isOpencodePlanProvider('zai-coding-plan'), true);
    assert.equal(isOpencodePlanProvider('kimi-for-coding-plan'), true);
    assert.equal(isOpencodePlanProvider('opencode-go'), false);
    assert.equal(isOpencodePlanProvider('openrouter'), false);
    assert.equal(isOpencodePlanProvider('opencode'), false);
  });
});

describe('parseOpencodeModels', () => {
  it('joins catalogue details onto the CLI ids', () => {
    const result = parseOpencodeModels(CLI_OUTPUT, CATALOGUE, PLAN, OBSERVED);
    assert.equal(result.status, 'ok');
    assert.equal(result.message, null);
    assert.equal(result.source, 'live');
    assert.equal(result.observedAt, OBSERVED);
    assert.equal(result.modelFlag, '-m <id>');
    assert.equal(result.effortFlag, '-m <id>#<level>');
    assert.deepEqual(byId(result.models).get('opencode-go/kimi-k2.7'), {
      id: 'opencode-go/kimi-k2.7',
      name: 'Kimi K2.7',
      isDefault: false,
      description: 'Fast coding model',
      contextTokens: 262144,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: null,
      pricing: 'paid',
    });
  });

  it('lists a CLI-only id with null details and no pricing', () => {
    const model = byId(parseOpencodeModels(CLI_OUTPUT, CATALOGUE, PLAN, OBSERVED).models).get('opencode-go/cli-only');
    assert.deepEqual(model, {
      id: 'opencode-go/cli-only',
      name: null,
      isDefault: false,
      description: null,
      contextTokens: null,
      efforts: [],
      defaultEffort: null,
    });
    assert.equal(model !== undefined && 'pricing' in model, false);
  });

  it('excludes catalogue entries the CLI does not list', () => {
    const ids = parseOpencodeModels(CLI_OUTPUT, CATALOGUE, PLAN, OBSERVED).models.map((model) => model.id);
    assert.equal(ids.includes('opencode-go/catalogue-only'), false);
    assert.equal(ids.includes('openrouter/unlisted-free'), false);
  });

  it('classifies pricing as included, free, paid, or omitted', () => {
    const catalogue = {
      'zai-coding-plan': { models: { zero: { cost: { input: 0, output: 0 } } } },
      'opencode-go': { models: { zero: { cost: { input: 0, output: 0 } } } },
      openrouter: {
        models: {
          zero: { cost: { input: 0, output: 0 } },
          in: { cost: { input: 0.1, output: 0 } },
          out: { cost: { input: 0, output: 2 } },
          none: { name: 'No cost' },
          text: { cost: { input: '0', output: 0 } },
          half: { cost: { input: 0 } },
          bad: { cost: 5 },
        },
      },
    };
    const stdout = [
      'zai-coding-plan/zero',
      'opencode-go/zero',
      ...['zero', 'in', 'out', 'none', 'text', 'half', 'bad'].map((id) => `openrouter/${id}`),
    ].join('\n');
    const providers = ['zai-coding-plan', 'opencode-go', 'openrouter'];
    const models = byId(parseOpencodeModels(stdout, catalogue, providers, OBSERVED).models);
    assert.equal(models.get('zai-coding-plan/zero')?.pricing, 'included');
    assert.equal(models.get('opencode-go/zero')?.pricing, 'free');
    assert.equal(models.get('openrouter/zero')?.pricing, 'free');
    assert.equal(models.get('openrouter/in')?.pricing, 'paid');
    assert.equal(models.get('openrouter/out')?.pricing, 'paid');
    for (const id of ['none', 'text', 'half', 'bad']) {
      const model = models.get(`openrouter/${id}`);
      assert.ok(model, id);
      assert.equal('pricing' in model, false, id);
    }
  });

  it('classes a zero-priced opencode-go model as free, not included', () => {
    assert.equal(isOpencodePlanProvider('opencode-go'), false);
    const catalogue = { 'opencode-go': { models: { zero: { cost: { input: 0, output: 0 } } } } };
    const result = parseOpencodeModels('opencode-go/zero', catalogue, ['opencode-go'], OBSERVED);
    assert.equal(result.status, 'ok');
    assert.equal(byId(result.models).get('opencode-go/zero')?.pricing, 'free');
  });

  it('omits pricing for negative or NaN costs', () => {
    const catalogue = {
      openrouter: {
        models: {
          negIn: { cost: { input: -1, output: 0 } },
          negOut: { cost: { input: 0, output: -2 } },
          nanIn: { cost: { input: Number.NaN, output: 0 } },
          nanOut: { cost: { input: 0, output: Number.NaN } },
        },
      },
    };
    const stdout = ['openrouter/negIn', 'openrouter/negOut', 'openrouter/nanIn', 'openrouter/nanOut'].join('\n');
    const models = byId(parseOpencodeModels(stdout, catalogue, ['openrouter'], OBSERVED).models);
    for (const id of ['negIn', 'negOut', 'nanIn', 'nanOut']) {
      const model = models.get(`openrouter/${id}`);
      assert.ok(model, id);
      assert.equal('pricing' in model, false, id);
    }
  });

  it('extracts efforts from effort-type reasoning options only, in catalogue order', () => {
    const catalogue = {
      p: {
        models: {
          multi: {
            reasoning_options: [
              { type: 'toggle' },
              { type: 'effort', values: ['high', 'low', 7, '', 'high'] },
              { type: 'budget_tokens', values: ['ignored'] },
              { type: 'effort', values: ['max'], default: 'max' },
            ],
          },
          budget: { reasoning_options: [{ type: 'budget_tokens', min: 1, max: 2 }] },
          odd: { reasoning_options: { type: 'effort', values: ['low'] } },
          wrongDefault: { reasoning_options: [{ type: 'effort', values: ['low'], default: 'max' }] },
        },
      },
    };
    const stdout = 'p/multi\np/budget\np/odd\np/wrongDefault';
    const models = byId(parseOpencodeModels(stdout, catalogue, ['p'], OBSERVED).models);
    assert.deepEqual(models.get('p/multi')?.efforts, ['high', 'low', 'max']);
    assert.equal(models.get('p/multi')?.defaultEffort, 'max');
    assert.deepEqual(models.get('p/budget')?.efforts, []);
    assert.deepEqual(models.get('p/odd')?.efforts, []);
    assert.deepEqual(models.get('p/wrongDefault')?.efforts, ['low']);
    assert.equal(models.get('p/wrongDefault')?.defaultEffort, null);
  });

  it('trims effort values and default before dedup', () => {
    const catalogue = {
      p: {
        models: {
          padded: {
            reasoning_options: [
              { type: 'effort', values: [' high ', 'low', 'high', '  ', '  max  '], default: ' max ' },
            ],
          },
        },
      },
    };
    const models = byId(parseOpencodeModels('p/padded', catalogue, ['p'], OBSERVED).models);
    assert.deepEqual(models.get('p/padded')?.efforts, ['high', 'low', 'max']);
    assert.equal(models.get('p/padded')?.defaultEffort, 'max');
  });

  it('skips non-record reasoning options and non-array values', () => {
    const catalogue = {
      p: {
        models: {
          bad: {
            reasoning_options: [
              null,
              'oops',
              7,
              [],
              { type: 'effort', values: 'low' },
              { type: 'effort', values: null },
              { type: 'effort' },
              { type: 'effort', values: ['ok'] },
            ],
          },
        },
      },
    };
    const models = byId(parseOpencodeModels('p/bad', catalogue, ['p'], OBSERVED).models);
    assert.deepEqual(models.get('p/bad')?.efforts, ['ok']);
    assert.equal(models.get('p/bad')?.defaultEffort, null);
  });

  it('orders selected providers first, then free models of other providers sorted by id, without duplicates', () => {
    const result = parseOpencodeModels(CLI_OUTPUT, CATALOGUE, ['zai-coding-plan', 'opencode-go'], OBSERVED);
    assert.deepEqual(
      result.models.map((model) => model.id),
      [
        'zai-coding-plan/glm-5.3',
        'opencode-go/kimi-k2.7',
        'opencode-go/beam-free',
        'opencode-go/cli-only',
        'openrouter/alpha-free',
        'openrouter/zeta-free',
      ],
    );
  });

  it('includes free models of a non-selected provider and keeps selected free models once', () => {
    const result = parseOpencodeModels(CLI_OUTPUT, CATALOGUE, ['openrouter'], OBSERVED);
    const ids = result.models.map((model) => model.id);
    assert.deepEqual(ids, [
      'openrouter/zeta-free',
      'openrouter/paid-model',
      'openrouter/alpha-free',
      'opencode-go/beam-free',
    ]);
    assert.equal(new Set(ids).size, ids.length);
    // opencode-go is not a plan provider, so its zero-cost model is 'free' and joins the tail.
    assert.equal(byId(result.models).get('opencode-go/beam-free')?.pricing, 'free');
    // Zero-cost models of a plan provider are 'included', not 'free', so they stay out.
    assert.equal(ids.includes('zai-coding-plan/glm-5.3'), false);
  });

  it('treats a malformed catalogue as no details', () => {
    for (const catalogue of [null, undefined, 'text', 42, [], { 'opencode-go': [] }, { 'opencode-go': { models: 'x' } }]) {
      const result = parseOpencodeModels(CLI_OUTPUT, catalogue, PLAN, OBSERVED);
      assert.equal(result.status, 'ok');
      assert.deepEqual(
        result.models.map((model) => model.id),
        ['opencode-go/kimi-k2.7', 'opencode-go/beam-free', 'opencode-go/cli-only', 'zai-coding-plan/glm-5.3'],
      );
      for (const model of result.models) {
        assert.equal(model.name, null);
        assert.equal(model.contextTokens, null);
        assert.deepEqual(model.efforts, []);
        assert.equal('pricing' in model, false);
      }
    }
  });

  it('does not read inherited properties as catalogue entries', () => {
    const result = parseOpencodeModels('opencode-go/toString\nopencode-go/__proto__', {}, PLAN, OBSERVED);
    assert.deepEqual(result.models.map((model) => model.name), [null, null]);
  });

  it('returns ok with an empty list when ids exist but none qualify', () => {
    const result = parseOpencodeModels('openrouter/paid-model', CATALOGUE, PLAN, OBSERVED);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.models, []);
  });

  it('returns an error when the CLI output has no ids', () => {
    for (const stdout of ['', '\r\n\r\n', 'nothing here\n']) {
      assert.deepEqual(parseOpencodeModels(stdout, CATALOGUE, PLAN, OBSERVED), {
        provider: 'opencode',
        status: 'error',
        models: [],
        source: 'live',
        observedAt: OBSERVED,
        message: 'unexpected output from `opencode models`',
        modelFlag: '-m <id>',
        effortFlag: '-m <id>#<level>',
      });
    }
  });
});

describe('readOpencodeCatalogue', () => {
  it('returns null when the file is missing, malformed, or homeDir is empty', async () => {
    const homeDir = await tempDir();
    assert.equal(await readOpencodeCatalogue(homeDir), null);
    assert.equal(await readOpencodeCatalogue(''), null);
    await mkdir(join(homeDir, '.cache', 'opencode'), { recursive: true });
    await writeFile(join(homeDir, '.cache', 'opencode', 'models.json'), '{"broken": ');
    assert.equal(await readOpencodeCatalogue(homeDir), null);
  });

  it('parses a valid file', async () => {
    const homeDir = await tempDir();
    await mkdir(join(homeDir, '.cache', 'opencode'), { recursive: true });
    await writeFile(join(homeDir, '.cache', 'opencode', 'models.json'), JSON.stringify(CATALOGUE));
    assert.deepEqual(await readOpencodeCatalogue(homeDir), CATALOGUE);
  });

  it('returns null for an oversized file', async () => {
    const homeDir = await tempDir();
    await mkdir(join(homeDir, '.cache', 'opencode'), { recursive: true });
    const file = join(homeDir, '.cache', 'opencode', 'models.json');
    await writeFile(file, '');
    await truncate(file, 64 * 1024 * 1024 + 1);
    assert.equal(await readOpencodeCatalogue(homeDir), null);
  });

  it('returns null when the catalogue path is a directory', async () => {
    const homeDir = await tempDir();
    await mkdir(join(homeDir, '.cache', 'opencode', 'models.json'), { recursive: true });
    assert.equal(await readOpencodeCatalogue(homeDir), null);
  });
});

describe('opencodeSubscriptionProviders', () => {
  it('defaults to the two subscription providers when unset or empty', () => {
    const defaults = ['opencode-go', 'zai-coding-plan'];
    assert.deepEqual(opencodeSubscriptionProviders({}), defaults);
    assert.deepEqual(opencodeSubscriptionProviders({ [PROVIDERS_ENV]: '' }), defaults);
    assert.deepEqual(opencodeSubscriptionProviders({ [PROVIDERS_ENV]: '  ,  , ' }), defaults);
  });

  it('reads a custom list, trimming, dropping invalid entries and removing duplicates', () => {
    const env = { [PROVIDERS_ENV]: '  a-1 , ,b, a-1, Bad, -x, opencode_go, c ,' };
    assert.deepEqual(opencodeSubscriptionProviders(env), ['a-1', 'b', 'c']);
  });

  it('falls back to the defaults when no entry is valid', () => {
    assert.deepEqual(opencodeSubscriptionProviders({ [PROVIDERS_ENV]: 'Bad,_x' }), [
      'opencode-go',
      'zai-coding-plan',
    ]);
  });
});

function quotaOptions(homeDir: string): QuotaFetchOptions {
  return { timeoutMs: 5000, now: () => NOW, homeDir };
}

describe('fetchOpencodeModels', () => {
  it('reports unavailable when neither the bundled binary nor PATH has opencode', async () => {
    const homeDir = await tempDir();
    const emptyPath = await tempDir();
    process.env.PATH = emptyPath;
    const models = await fetchOpencodeModels(quotaOptions(homeDir));
    assert.deepEqual(models, {
      provider: 'opencode',
      status: 'unavailable',
      models: [],
      source: 'live',
      observedAt: OBSERVED,
      message: 'opencode CLI not found',
      modelFlag: '-m <id>',
      effortFlag: '-m <id>#<level>',
    });
  });

  describe('with a fake binary in a temporary home', () => {
    async function fakeHome(script: string, catalogue?: unknown): Promise<string> {
      const homeDir = await tempDir();
      const binDir = join(homeDir, '.opencode', 'bin');
      await mkdir(binDir, { recursive: true });
      const binary = join(binDir, 'opencode');
      await writeFile(binary, `#!/bin/sh\n${script}\n`);
      await chmod(binary, 0o755);
      if (catalogue !== undefined) {
        await mkdir(join(homeDir, '.cache', 'opencode'), { recursive: true });
        await writeFile(join(homeDir, '.cache', 'opencode', 'models.json'), JSON.stringify(catalogue));
      }
      return homeDir;
    }

    it('calls plain `opencode models` and joins the catalogue', async () => {
      const dir = await tempDir();
      const fixture = join(dir, 'ids.txt');
      await writeFile(fixture, CLI_OUTPUT);
      const homeDir = await fakeHome(`[ "$#" = 1 ] && [ "$1" = models ] || exit 2\ncat '${fixture}'`, CATALOGUE);
      delete process.env[PROVIDERS_ENV];
      const models = await fetchOpencodeModels(quotaOptions(homeDir));
      assert.equal(models.status, 'ok');
      assert.equal(models.message, null);
      assert.equal(models.observedAt, OBSERVED);
      assert.deepEqual(
        models.models.map((model) => model.id),
        PLAN_IDS,
      );
      assert.equal(byId(models.models).get('opencode-go/beam-free')?.pricing, 'free');
    });

    it('still lists ids when the catalogue is missing', async () => {
      const homeDir = await fakeHome("printf 'zai-coding-plan/glm-5.3\\n'");
      process.env[PROVIDERS_ENV] = 'zai-coding-plan';
      const models = await fetchOpencodeModels(quotaOptions(homeDir));
      assert.equal(models.status, 'ok');
      assert.deepEqual(models.models.map((model) => [model.id, model.name]), [['zai-coding-plan/glm-5.3', null]]);
    });

    it('reports error when the call exits non-zero', async () => {
      const homeDir = await fakeHome('echo "boom" >&2; exit 1');
      const models = await fetchOpencodeModels(quotaOptions(homeDir));
      assert.equal(models.status, 'error');
      assert.equal(models.message, '`opencode models` failed');
      assert.deepEqual(models.models, []);
    });

    it('reports a timeout when the call exceeds timeoutMs', async () => {
      const homeDir = await fakeHome('exec sleep 5');
      const models = await fetchOpencodeModels({ timeoutMs: 200, now: () => NOW, homeDir });
      assert.equal(models.status, 'error');
      assert.equal(models.message, '`opencode models` timed out');
    });

    it('reports output too large when the call exceeds the buffer', async () => {
      const homeDir = await fakeHome('head -c 17000000 /dev/zero');
      const models = await fetchOpencodeModels(quotaOptions(homeDir));
      assert.equal(models.status, 'error');
      assert.equal(models.message, '`opencode models` output was too large');
      assert.deepEqual(models.models, []);
    });

    it('reports timed out without spawning when timeoutMs is zero', async () => {
      const homeDir = await fakeHome('exec sleep 5');
      const startedAt = Date.now();
      const models = await fetchOpencodeModels({ timeoutMs: 0, now: () => NOW, homeDir });
      const elapsedMs = Date.now() - startedAt;
      assert.equal(models.status, 'error');
      assert.equal(models.message, '`opencode models` timed out');
      assert.ok(elapsedMs < 500, `elapsed ${elapsedMs}ms`);
    });

    it('reports "unexpected output" when the call prints no ids', async () => {
      const homeDir = await fakeHome('exit 0');
      const models = await fetchOpencodeModels(quotaOptions(homeDir));
      assert.equal(models.status, 'error');
      assert.equal(models.message, 'unexpected output from `opencode models`');
    });
  });
});

const PLAN_IDS = [
  'opencode-go/kimi-k2.7',
  'opencode-go/beam-free',
  'opencode-go/cli-only',
  'zai-coding-plan/glm-5.3',
  'openrouter/alpha-free',
  'openrouter/zeta-free',
];

describe('resolveOpencodeBinary', () => {
  async function executable(path: string): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '');
    await chmod(path, 0o755);
  }

  it('returns the bundled binary when it is an executable file', async () => {
    const homeDir = await tempDir();
    const bundled = join(homeDir, '.opencode', 'bin', 'opencode');
    await executable(bundled);
    assert.equal(await resolveOpencodeBinary(homeDir, ''), bundled);
  });

  it('ignores a directory named opencode, both bundled and on PATH', async () => {
    const homeDir = await tempDir();
    await mkdir(join(homeDir, '.opencode', 'bin', 'opencode'), { recursive: true });
    const pathDir = await tempDir();
    await mkdir(join(pathDir, 'opencode'));
    assert.equal(await resolveOpencodeBinary(homeDir, pathDir), null);
  });

  it('ignores a file that is not executable', async () => {
    const homeDir = await tempDir();
    const bundled = join(homeDir, '.opencode', 'bin', 'opencode');
    await mkdir(join(homeDir, '.opencode', 'bin'), { recursive: true });
    await writeFile(bundled, '');
    await chmod(bundled, 0o644);
    const pathDir = await tempDir();
    await writeFile(join(pathDir, 'opencode'), '');
    await chmod(join(pathDir, 'opencode'), 0o644);
    assert.equal(await resolveOpencodeBinary(homeDir, pathDir), null);
  });

  it('skips an empty homeDir instead of resolving against the working directory', async () => {
    const cwd = await tempDir();
    await executable(join(cwd, '.opencode', 'bin', 'opencode'));
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      assert.equal(await resolveOpencodeBinary('', ''), null);
    } finally {
      process.chdir(previous);
    }
  });

  it('skips relative and empty PATH entries', async () => {
    const cwd = await tempDir();
    await executable(join(cwd, 'relbin', 'opencode'));
    const absolute = await tempDir();
    await executable(join(absolute, 'opencode'));
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const homeDir = await tempDir();
      assert.equal(await resolveOpencodeBinary(homeDir, `relbin${delimiter}`), null);
      assert.equal(
        await resolveOpencodeBinary(homeDir, `relbin${delimiter}${delimiter}${absolute}`),
        join(absolute, 'opencode'),
      );
    } finally {
      process.chdir(previous);
    }
  });
});
