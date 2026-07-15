import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claudeProjectSlug, collectSessionUsage } from './usage-collector.js';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'usage-collector-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('claudeProjectSlug', () => {
  it('maps every non-alphanumeric char to "-" (verified against real ~/.claude/projects dirs)', () => {
    assert.equal(
      claudeProjectSlug('/Users/x/projects/ftown/.claude/worktrees/fix-1'),
      '-Users-x-projects-ftown--claude-worktrees-fix-1',
    );
    assert.equal(claudeProjectSlug('/tmp/a_b.c'), '-tmp-a-b-c');
  });
});

function claudeLine(
  id: string,
  model: string,
  usage: Record<string, number>,
  type = 'assistant',
): string {
  return JSON.stringify({ type, message: { id, model, usage } });
}

describe('collectSessionUsage — claude extractor', () => {
  const workingDir = '/tmp/proj.x';
  const sessionId = 'aaaa-bbbb';

  it('sums per-message usage, dedupes repeated message ids, skips synthetic rows, prices per model', async () => {
    const claudeProjectsDir = join(root, 'claude-sums');
    const dir = join(claudeProjectsDir, claudeProjectSlug(workingDir));
    await mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user' } }),
      // msg1: sonnet-5, spans two jsonl lines with identical usage — count once
      claudeLine('msg1', 'claude-sonnet-5', {
        input_tokens: 100, output_tokens: 200,
        cache_read_input_tokens: 1000, cache_creation_input_tokens: 500,
      }),
      claudeLine('msg1', 'claude-sonnet-5', {
        input_tokens: 100, output_tokens: 200,
        cache_read_input_tokens: 1000, cache_creation_input_tokens: 500,
      }),
      // synthetic placeholder — ignored
      claudeLine('msg-syn', '<synthetic>', { input_tokens: 0, output_tokens: 0 }),
      // msg2: sonnet-5 again
      claudeLine('msg2', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 20 }),
      'this is not json',
      // msg3: haiku (second model, date-suffixed id exercising prefix pricing)
      claudeLine('msg3', 'claude-haiku-4-5-20251001', {
        input_tokens: 1000, output_tokens: 100,
        cache_read_input_tokens: 200, cache_creation_input_tokens: 400,
      }),
    ];
    await writeFile(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');

    const usage = await collectSessionUsage(
      { shellType: 'claude', claudeSessionId: sessionId, workingDir },
      { claudeProjectsDir },
    );

    assert.ok(usage);
    assert.equal(usage.harness, 'claude');
    assert.equal(usage.inputTokens, 1110);
    assert.equal(usage.outputTokens, 320);
    assert.equal(usage.cacheReadTokens, 1200);
    assert.equal(usage.cacheWriteTokens, 900);
    assert.equal(usage.totalTokens, 1110 + 320 + 1200 + 900);
    assert.deepEqual(usage.models, ['claude-sonnet-5', 'claude-haiku-4-5-20251001']);
    // sonnet-5: (100*3 + 200*15 + 1000*0.3 + 500*3.75)/1e6 = 0.005475
    //         + (10*3 + 20*15)/1e6                          = 0.000330
    // haiku:    (1000*1 + 100*5 + 200*0.1 + 400*1.25)/1e6   = 0.002020
    assert.ok(usage.costUsd !== undefined);
    assert.ok(Math.abs(usage.costUsd - 0.007825) < 1e-9, String(usage.costUsd));
    assert.ok(usage.collectedAt);
  });

  it('omits costUsd when any model lacks pricing', async () => {
    const claudeProjectsDir = join(root, 'claude-unknown');
    const dir = join(claudeProjectsDir, claudeProjectSlug(workingDir));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      [
        claudeLine('m1', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 10 }),
        claudeLine('m2', 'totally-unknown-model', { input_tokens: 5, output_tokens: 5 }),
      ].join('\n'),
    );

    const usage = await collectSessionUsage(
      { shellType: 'claude', claudeSessionId: sessionId, workingDir },
      { claudeProjectsDir },
    );

    assert.ok(usage);
    assert.equal(usage.costUsd, undefined);
    assert.equal(usage.totalTokens, 30);
    assert.deepEqual(usage.models, ['claude-sonnet-5', 'totally-unknown-model']);
  });

  it('returns null when the transcript file is missing', async () => {
    const usage = await collectSessionUsage(
      { shellType: 'claude', claudeSessionId: 'no-such-session', workingDir },
      { claudeProjectsDir: join(root, 'claude-missing') },
    );
    assert.equal(usage, null);
  });
});

describe('collectSessionUsage — codex extractor', () => {
  const codexSessionId = '019d2b5c-d671-7863-9688-d9be287e46a6';

  it('uses the LAST token_count totals, splits cached from input, cost from single model', async () => {
    const codexSessionsDir = join(root, 'codex-last-wins');
    const dir = join(codexSessionsDir, '2026', '07', '01');
    await mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 5, total_tokens: 105 } },
        },
      }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 11276, cached_input_tokens: 9088, output_tokens: 29, total_tokens: 11305 } },
        },
      }),
    ];
    await writeFile(
      join(dir, `rollout-2026-07-01T10-00-00-${codexSessionId}.jsonl`),
      lines.join('\n'),
    );

    const usage = await collectSessionUsage(
      { shellType: 'codex', codexSessionId },
      { codexSessionsDir },
    );

    assert.ok(usage);
    assert.equal(usage.harness, 'codex');
    // last token_count wins; input excludes cached so the four sum to codex's total_tokens
    assert.equal(usage.inputTokens, 11276 - 9088);
    assert.equal(usage.cacheReadTokens, 9088);
    assert.equal(usage.outputTokens, 29);
    assert.equal(usage.cacheWriteTokens, 0);
    assert.equal(usage.totalTokens, 11305);
    assert.deepEqual(usage.models, ['gpt-5.4-mini']);
    // (2188*0.25 + 29*2 + 9088*0.025)/1e6
    assert.ok(usage.costUsd !== undefined);
    assert.ok(Math.abs(usage.costUsd - 0.0008322) < 1e-9, String(usage.costUsd));
  });

  it('returns null when no rollout file matches the session id', async () => {
    const usage = await collectSessionUsage(
      { shellType: 'codex', codexSessionId: 'ffffffff-0000-0000-0000-000000000000' },
      { codexSessionsDir: join(root, 'codex-missing') },
    );
    assert.equal(usage, null);
  });
});

describe('collectSessionUsage — extractor routing', () => {
  it('prefers the claude extractor whenever claudeSessionId is present (provider flavors)', async () => {
    const claudeProjectsDir = join(root, 'routing');
    const workingDir = '/tmp/routing';
    const dir = join(claudeProjectsDir, claudeProjectSlug(workingDir));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'sess-1.jsonl'),
      claudeLine('m1', 'claude-haiku-4-5', { input_tokens: 1, output_tokens: 2 }),
    );

    const usage = await collectSessionUsage(
      // shellType is a provider flavor, but the native claude id wins
      { shellType: 'zai' as never, claudeSessionId: 'sess-1', codexSessionId: 'also-set', workingDir },
      { claudeProjectsDir },
    );
    assert.equal(usage?.harness, 'claude');
  });

  it('returns null for sessions with no structured source (shell/cursor)', async () => {
    assert.equal(await collectSessionUsage({ shellType: 'shell' }), null);
  });
});
