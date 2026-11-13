import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseAgyModels, fetchAgyModels } from './models-agy.js';

const OBSERVED = '2026-11-13T10:00:00.000Z';

// Full real output of `agy models` (agy 1.5.8), stdout only.
const REAL_STDOUT = [
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
  'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
  'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)',
  'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)',
  'gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
  'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)',
  'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  '',
].join('\n');

describe('parseAgyModels', () => {
  it('parses the full real output into 18 models in output order', () => {
    const result = parseAgyModels(REAL_STDOUT, OBSERVED);
    assert.equal(result.status, 'ok');
    assert.equal(result.models.length, 18);
    assert.deepEqual(
      result.models.map((model) => model.id),
      REAL_STDOUT.split('\n').filter((line) => line.length > 0).map((line) => line.split('\t')[0]),
    );
  });

  it('keeps each effort variant as its own model and does not merge them', () => {
    const result = parseAgyModels(REAL_STDOUT, OBSERVED);
    const opus = result.models.filter((model) => model.id.startsWith('claude-opus-5-5-'));
    assert.deepEqual(
      opus.map((model) => [model.id, model.defaultEffort]),
      [
        ['claude-opus-5-5-low', 'low'],
        ['claude-opus-5-5-medium', 'medium'],
        ['claude-opus-5-5-high', 'high'],
      ],
    );
  });

  it('maps a suffixed line to the exact shape with source live and the flags', () => {
    const result = parseAgyModels('gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)\n', OBSERVED);
    assert.deepEqual(result, {
      provider: 'agy',
      status: 'ok',
      models: [
        {
          id: 'gemini-4-hydrogen-xhigh',
          name: 'Gemini 4 Hydrogen (XHigh)',
          isDefault: false,
          description: null,
          contextTokens: null,
          efforts: ['xhigh'],
          defaultEffort: 'xhigh',
        },
      ],
      source: 'live',
      observedAt: OBSERVED,
      message: null,
      modelFlag: '--model <id>',
      effortFlag: '--effort <level>',
    });
  });

  it('gives an id without an effort suffix empty efforts and a null defaultEffort', () => {
    const result = parseAgyModels('gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)\n', OBSERVED);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.models[0], {
      id: 'gemini-pro-orchestrator-g1-pro',
      name: 'Orchestrator (Argon)',
      isDefault: false,
      description: null,
      contextTokens: null,
      efforts: [],
      defaultEffort: null,
    });
  });

  it('recognises every effort suffix', () => {
    const lines = ['low', 'medium', 'high', 'xhigh', 'max'].map(
      (level) => `m-${level}\tModel (${level})`,
    );
    const result = parseAgyModels(lines.join('\n'), OBSERVED);
    assert.deepEqual(
      result.models.map((model) => model.defaultEffort),
      ['low', 'medium', 'high', 'xhigh', 'max'],
    );
  });

  it('ignores the progress line and any blank line', () => {
    const stdout = `Fetching available models...\n\n${REAL_STDOUT}\n\n`;
    const result = parseAgyModels(stdout, OBSERVED);
    assert.equal(result.status, 'ok');
    assert.equal(result.models.length, 18);
    assert.equal(result.models[0].id, 'gemini-4-argon-medium');
  });

  it('strips ANSI escape sequences before reading ids and names', () => {
    const stdout =
      '\u001b[2K\u001b[1GFetching available models...\n' +
      '\u001b[36mclaude-opus-5-5-high\u001b[0m\t\u001b[1mClaude Opus 5.5 (High)\u001b[22m\n' +
      '\u001b[32mgpt-oss-120b-medium\u001b[39m\tGPT-OSS 120B (Medium)\n';
    const result = parseAgyModels(stdout, OBSERVED);
    assert.equal(result.status, 'ok');
    assert.deepEqual(
      result.models.map((model) => [model.id, model.name]),
      [
        ['claude-opus-5-5-high', 'Claude Opus 5.5 (High)'],
        ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'],
      ],
    );
  });

  it('ignores garbage lines: no tab, bad id characters, leading punctuation, empty id', () => {
    const stdout = [
      'Error: something went wrong',
      'foo bar\tSpaced id',
      '-leading-dash\tLeading dash',
      '\tNo id at all',
      'valid-one-high\tValid One (High)',
      'a/b\tSlash in id',
      '',
    ].join('\n');
    const result = parseAgyModels(stdout, OBSERVED);
    assert.equal(result.status, 'ok');
    assert.deepEqual(
      result.models.map((model) => model.id),
      ['valid-one-high'],
    );
  });

  it('keeps a line with a tab and an empty display name as a null name', () => {
    const result = parseAgyModels('claude-sonnet-5-5-low\t\n', OBSERVED);
    assert.equal(result.status, 'ok');
    assert.equal(result.models[0].name, null);
    assert.equal(result.models[0].defaultEffort, 'low');
  });

  it('accepts CRLF line endings', () => {
    const stdout = 'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\r\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\r\n';
    const result = parseAgyModels(stdout, OBSERVED);
    assert.equal(result.status, 'ok');
    assert.deepEqual(
      result.models.map((model) => [model.id, model.name]),
      [
        ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'],
        ['claude-opus-5-5-high', 'Claude Opus 5.5 (High)'],
      ],
    );
  });

  it('returns an error with no models for empty output', () => {
    const result = parseAgyModels('', OBSERVED);
    assert.deepEqual(result, {
      provider: 'agy',
      status: 'error',
      models: [],
      source: 'live',
      observedAt: OBSERVED,
      message: 'unexpected output from `agy models`',
      modelFlag: '--model <id>',
      effortFlag: '--effort <level>',
    });
  });

  it('returns an error when only the progress line and garbage are present', () => {
    const result = parseAgyModels('Fetching available models...\nno models here\n', OBSERVED);
    assert.equal(result.status, 'error');
    assert.deepEqual(result.models, []);
    assert.equal(result.message, 'unexpected output from `agy models`');
  });
});

describe('fetchAgyModels', () => {
  const originalPath = process.env.PATH;
  let root: string;
  let homeDir: string;
  let emptyPathDir: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'agy-models-test-'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    homeDir = await mkdtemp(join(root, 'home-'));
    emptyPathDir = await mkdtemp(join(root, 'path-'));
    process.env.PATH = emptyPathDir;
  });

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  });

  async function writeFakeAgy(script: string): Promise<void> {
    const binDir = join(homeDir, '.local', 'bin');
    await mkdir(binDir, { recursive: true });
    const path = join(binDir, 'agy');
    await writeFile(path, script);
    await chmod(path, 0o755);
  }

  it('runs the resolved fake agy and returns its models when agy is not on PATH', async () => {
    await writeFakeAgy(
      "#!/bin/sh\nprintf 'fake-model-high\\tFake Model (High)\\n'\nprintf 'fake-model\\tFake Model\\n'\n",
    );

    const result = await fetchAgyModels({ timeoutMs: 5000, now: () => new Date(OBSERVED), homeDir });
    assert.equal(result.status, 'ok');
    assert.equal(result.message, null);
    assert.deepEqual(
      result.models.map((model) => [model.id, model.name, model.defaultEffort]),
      [
        ['fake-model-high', 'Fake Model (High)', 'high'],
        ['fake-model', 'Fake Model', null],
      ],
    );
  });

  it('reports unavailable with agy CLI not found when no binary exists', async () => {
    const result = await fetchAgyModels({ timeoutMs: 5000, now: () => new Date(OBSERVED), homeDir });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.message, 'agy CLI not found');
    assert.deepEqual(result.models, []);
  });

  it('returns within about the timeout when the child ignores TERM', async () => {
    await writeFakeAgy('#!/bin/sh\ntrap "" TERM\nwhile :; do :; done\n');

    const start = Date.now();
    const result = await fetchAgyModels({ timeoutMs: 1000, now: () => new Date(OBSERVED), homeDir });
    const elapsed = Date.now() - start;
    assert.equal(result.status, 'error');
    assert.equal(result.message, '`agy models` timed out');
    assert.ok(elapsed < 4000, `expected return within 4000 ms, took ${elapsed} ms`);
  });
});
