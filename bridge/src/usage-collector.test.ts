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

  it('sums per-message usage, dedupes repeated message ids, skips synthetic rows, attributes per model', async () => {
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
      // msg3: haiku (second model, date-suffixed id)
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
    // Per-model attribution: msg1 + msg2 land on sonnet-5, msg3 on haiku.
    assert.deepEqual(usage.perModel, [
      {
        model: 'claude-sonnet-5',
        inputTokens: 110,
        outputTokens: 220,
        cacheReadTokens: 1000,
        cacheWriteTokens: 500,
      },
      {
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 200,
        cacheWriteTokens: 400,
      },
    ]);
    assert.ok(usage.collectedAt);
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

  it('uses the LAST token_count totals, splits cached from input, no perModel', async () => {
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
    // Codex carries only cumulative totals — never a per-model breakdown.
    assert.equal(usage.perModel, undefined);
  });

  it('returns null when no rollout file matches the session id', async () => {
    const usage = await collectSessionUsage(
      { shellType: 'codex', codexSessionId: 'ffffffff-0000-0000-0000-000000000000' },
      { codexSessionsDir: join(root, 'codex-missing') },
    );
    assert.equal(usage, null);
  });
});

function kimiUsageRecord(model: string, usage: Record<string, number>): string {
  return JSON.stringify({ type: 'usage.record', model, usage, usageScope: 'turn', time: 1 });
}

async function writeKimiSession(opts: {
  kimiCodeDir: string;
  sessionDir: string;
  workDir: string;
  createdAt: string;
  wireByAgent: Record<string, string[]>;
}): Promise<void> {
  await mkdir(opts.sessionDir, { recursive: true });
  await writeFile(
    join(opts.sessionDir, 'state.json'),
    JSON.stringify({ createdAt: opts.createdAt, updatedAt: opts.createdAt, workDir: opts.workDir, agents: {} }),
  );
  for (const [agent, lines] of Object.entries(opts.wireByAgent)) {
    const agentDir = join(opts.sessionDir, 'agents', agent);
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'wire.jsonl'), lines.join('\n') + '\n');
  }
}

describe('collectSessionUsage — kimi-code extractor', () => {
  const workingDir = '/Users/x/projects/demo';
  const sessionCreatedAt = '2026-07-17T12:00:00.000Z';

  it('sums usage.record across agents, attributes per model, no costUsd', async () => {
    const kimiCodeDir = join(root, 'kimi-sums');
    const sessionDir = join(kimiCodeDir, 'sessions', 'wd_demo_1', 'session_uuid-1');
    await mkdir(kimiCodeDir, { recursive: true });
    await writeFile(
      join(kimiCodeDir, 'session_index.jsonl'),
      JSON.stringify({ sessionId: 'session_uuid-1', sessionDir, workDir: workingDir }) + '\n' +
        // duplicate append line for the same sessionDir — must be deduped
        JSON.stringify({ sessionId: 'session_uuid-1', sessionDir, workDir: workingDir }) + '\n',
    );
    await writeKimiSession({
      kimiCodeDir,
      sessionDir,
      workDir: workingDir,
      createdAt: '2026-07-17T12:00:05.000Z', // >= session createdAt
      wireByAgent: {
        // 3 usage.record events, 2 models to exercise perModel
        main: [
          JSON.stringify({ type: 'text', model: 'kimi-code/k3' }),
          kimiUsageRecord('kimi-code/k3', {
            inputOther: 100, output: 200, inputCacheRead: 1000, inputCacheCreation: 500,
          }),
          'not json',
          kimiUsageRecord('kimi-code/k3', {
            inputOther: 10, output: 20, inputCacheRead: 5, inputCacheCreation: 0,
          }),
          kimiUsageRecord('kimi-code/k2', {
            inputOther: 1000, output: 100, inputCacheRead: 200, inputCacheCreation: 400,
          }),
        ],
      },
    });

    const usage = await collectSessionUsage(
      { shellType: 'kimi-code', workingDir, createdAt: sessionCreatedAt },
      { kimiCodeDir },
    );

    assert.ok(usage);
    assert.equal(usage.harness, 'kimi-code');
    assert.equal(usage.inputTokens, 1110);
    assert.equal(usage.outputTokens, 320);
    assert.equal(usage.cacheReadTokens, 1205);
    assert.equal(usage.cacheWriteTokens, 900);
    assert.equal(usage.totalTokens, 1110 + 320 + 1205 + 900);
    assert.deepEqual(usage.models, ['kimi-code/k3', 'kimi-code/k2']);
    assert.deepEqual(usage.perModel, [
      {
        model: 'kimi-code/k3',
        inputTokens: 110,
        outputTokens: 220,
        cacheReadTokens: 1005,
        cacheWriteTokens: 500,
      },
      {
        model: 'kimi-code/k2',
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 200,
        cacheWriteTokens: 400,
      },
    ]);
    assert.ok(usage.collectedAt);
    assert.ok(!('costUsd' in usage));
  });

  it('sums main + sub-agent wire.jsonl for the session total', async () => {
    const kimiCodeDir = join(root, 'kimi-multiagent');
    const sessionDir = join(kimiCodeDir, 'sessions', 'wd_ma_1', 'session_uuid-ma');
    await mkdir(kimiCodeDir, { recursive: true });
    await writeFile(
      join(kimiCodeDir, 'session_index.jsonl'),
      JSON.stringify({ sessionId: 'session_uuid-ma', sessionDir, workDir: workingDir }) + '\n',
    );
    await writeKimiSession({
      kimiCodeDir,
      sessionDir,
      workDir: workingDir,
      createdAt: '2026-07-17T12:00:01.000Z',
      wireByAgent: {
        main: [kimiUsageRecord('kimi-code/k3', { inputOther: 100, output: 10, inputCacheRead: 0, inputCacheCreation: 0 })],
        'agent-0': [kimiUsageRecord('kimi-code/k3', { inputOther: 5, output: 3, inputCacheRead: 0, inputCacheCreation: 0 })],
      },
    });

    const usage = await collectSessionUsage(
      { shellType: 'kimi-code', workingDir, createdAt: sessionCreatedAt },
      { kimiCodeDir },
    );
    assert.ok(usage);
    // main (100/10) + agent-0 (5/3) summed into one kimi-code/k3 model
    assert.equal(usage.inputTokens, 105);
    assert.equal(usage.outputTokens, 13);
    assert.deepEqual(usage.models, ['kimi-code/k3']);
  });

  it('disambiguates two sessions in the same workDir by createdAt (>= session wins, newest)', async () => {
    const kimiCodeDir = join(root, 'kimi-disambig');
    const olderDir = join(kimiCodeDir, 'sessions', 'wd_d_1', 'session_older');
    const newerDir = join(kimiCodeDir, 'sessions', 'wd_d_1', 'session_newer');
    await mkdir(kimiCodeDir, { recursive: true });
    await writeFile(
      join(kimiCodeDir, 'session_index.jsonl'),
      JSON.stringify({ sessionId: 'session_older', sessionDir: olderDir, workDir: workingDir }) + '\n' +
        JSON.stringify({ sessionId: 'session_newer', sessionDir: newerDir, workDir: workingDir }) + '\n',
    );
    // older kimi session created BEFORE the ftown session — not the spawn
    await writeKimiSession({
      kimiCodeDir,
      sessionDir: olderDir,
      workDir: workingDir,
      createdAt: '2026-07-17T11:00:00.000Z',
      wireByAgent: {
        main: [kimiUsageRecord('kimi-code/k3', { inputOther: 9, output: 9, inputCacheRead: 0, inputCacheCreation: 0 })],
      },
    });
    // newer kimi session created AFTER the ftown session — the true spawn
    await writeKimiSession({
      kimiCodeDir,
      sessionDir: newerDir,
      workDir: workingDir,
      createdAt: '2026-07-17T12:00:03.000Z',
      wireByAgent: {
        main: [kimiUsageRecord('kimi-code/k3', { inputOther: 42, output: 7, inputCacheRead: 0, inputCacheCreation: 0 })],
      },
    });

    const usage = await collectSessionUsage(
      { shellType: 'kimi-code', workingDir, createdAt: sessionCreatedAt },
      { kimiCodeDir },
    );
    assert.ok(usage);
    assert.equal(usage.inputTokens, 42); // the createdAt-matched (newer) session
    assert.equal(usage.outputTokens, 7);
  });

  it('returns null when the session index is missing', async () => {
    const usage = await collectSessionUsage(
      { shellType: 'kimi-code', workingDir, createdAt: sessionCreatedAt },
      { kimiCodeDir: join(root, 'kimi-missing') },
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
