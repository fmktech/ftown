import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlFoldCache } from './jsonl-fold-cache.js';
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

describe('collectSessionUsage — Pi extractor', () => {
  const workingDir = '/Users/x/projects/pi-demo';

  it('sums assistant-message usage and attributes it by provider/model', async () => {
    const piSessionsDir = join(root, 'pi-sums');
    const dir = join(piSessionsDir, '--Users-x-projects-pi-demo--');
    await mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'session', version: 3, timestamp: '2026-08-08T10:00:01.000Z', cwd: workingDir }),
      JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({
        type: 'message', id: 'a1', message: {
          role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-4',
          usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 40 },
        },
      }),
      'not json',
      JSON.stringify({
        type: 'message', id: 'a2', message: {
          role: 'assistant', provider: 'openai', model: 'gpt-5',
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0 },
        },
      }),
    ];
    await writeFile(join(dir, '2026-08-08T10-00-01-000Z_pi.jsonl'), lines.join('\n') + '\n');

    const usage = await collectSessionUsage(
      { shellType: 'pi', workingDir, createdAt: '2026-08-08T10:00:00.000Z' },
      { piSessionsDir },
    );

    assert.ok(usage);
    assert.equal(usage.harness, 'pi');
    assert.equal(usage.inputTokens, 110);
    assert.equal(usage.outputTokens, 25);
    assert.equal(usage.cacheReadTokens, 302);
    assert.equal(usage.cacheWriteTokens, 40);
    assert.equal(usage.totalTokens, 477);
    assert.deepEqual(usage.models, ['anthropic/claude-sonnet-4', 'openai/gpt-5']);
    assert.deepEqual(usage.perModel, [
      {
        model: 'anthropic/claude-sonnet-4',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 300,
        cacheWriteTokens: 40,
      },
      {
        model: 'openai/gpt-5',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
      },
    ]);
  });

  it('selects the closest session created after the ftown session in a shared workspace', async () => {
    const piSessionsDir = join(root, 'pi-disambig');
    const dir = join(piSessionsDir, '--Users-x-projects-pi-demo--');
    await mkdir(dir, { recursive: true });
    const writePi = async (file: string, timestamp: string, input: number) => {
      await writeFile(join(dir, file), [
        JSON.stringify({ type: 'session', version: 3, timestamp, cwd: workingDir }),
        JSON.stringify({
          type: 'message', id: `a-${input}`, message: {
            role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-4',
            usage: { input, output: 1, cacheRead: 0, cacheWrite: 0 },
          },
        }),
      ].join('\n') + '\n');
    };
    await writePi('older.jsonl', '2026-08-08T09:59:00.000Z', 1);
    await writePi('match.jsonl', '2026-08-08T10:00:02.000Z', 42);
    await writePi('later.jsonl', '2026-08-08T10:05:00.000Z', 99);

    const usage = await collectSessionUsage(
      { shellType: 'pi', workingDir, createdAt: '2026-08-08T10:00:00.000Z' },
      { piSessionsDir },
    );
    assert.ok(usage);
    assert.equal(usage.inputTokens, 42);
  });

  it('uses the native session file from the Pi extension when available', async () => {
    const piSessionsDir = join(root, 'pi-native');
    const nativeFile = join(piSessionsDir, 'pi-native-session.jsonl');
    await mkdir(piSessionsDir, { recursive: true });
    await writeFile(nativeFile, [
      JSON.stringify({ type: 'session', version: 3, id: 'pi-native', cwd: '/actual/workdir' }),
      JSON.stringify({
        type: 'message', id: 'a1', message: {
          role: 'assistant', provider: 'openai', model: 'gpt-5',
          usage: { input: 77, output: 9, cacheRead: 3, cacheWrite: 0 },
        },
      }),
    ].join('\n') + '\n');

    const usage = await collectSessionUsage(
      {
        shellType: 'pi',
        workingDir: '/ambiguous/shared/workdir',
        piSessionId: 'pi-native',
        piSessionFile: nativeFile,
      },
      { piSessionsDir },
    );

    assert.ok(usage);
    assert.equal(usage.inputTokens, 77);
    assert.equal(usage.outputTokens, 9);
  });

  it('rejects a native session file outside the Pi sessions directory', async () => {
    const piSessionsDir = join(root, 'pi-contained');
    const outsideFile = join(root, 'outside-pi-session.jsonl');
    await mkdir(piSessionsDir, { recursive: true });
    await writeFile(outsideFile, JSON.stringify({
      type: 'message',
      message: { role: 'assistant', model: 'gpt-5', usage: { input: 999 } },
    }) + '\n');

    const usage = await collectSessionUsage(
      { shellType: 'pi', workingDir, piSessionFile: outsideFile },
      { piSessionsDir },
    );

    assert.equal(usage, null);
  });

  it('ignores malformed, negative, and non-finite Pi token values', async () => {
    const piSessionsDir = join(root, 'pi-malformed');
    const nativeFile = join(piSessionsDir, 'malformed.jsonl');
    await mkdir(piSessionsDir, { recursive: true });
    await writeFile(nativeFile, [
      JSON.stringify({
        type: 'message', message: {
          role: 'assistant', provider: 'openai', model: 'gpt-5',
          usage: { input: -10, output: '5', cacheRead: null, cacheWrite: 1 / 0 },
        },
      }),
      JSON.stringify({
        type: 'message', message: {
          role: 'assistant', provider: 'openai', model: 'gpt-5',
          usage: { input: 7, output: 2, cacheRead: 1, cacheWrite: 0 },
        },
      }),
    ].join('\n') + '\n');

    const usage = await collectSessionUsage(
      { shellType: 'pi', workingDir, piSessionFile: nativeFile },
      { piSessionsDir },
    );

    assert.ok(usage);
    assert.equal(usage.inputTokens, 7);
    assert.equal(usage.outputTokens, 2);
    assert.equal(usage.cacheReadTokens, 1);
    assert.equal(usage.cacheWriteTokens, 0);
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

function museMetaLine(workspaceRoot: string, recordedAtUs: number): string {
  return JSON.stringify({
    payload_type: 'runtime.session.metadata',
    recorded_at: recordedAtUs,
    payload: { kind: 'metadata', record: { workspace_root: workspaceRoot } },
  });
}

function museCompletedLine(
  model: string,
  usage: Record<string, number>,
  recordedAtUs: number,
): string {
  return JSON.stringify({
    payload_type: 'runtime.session',
    recorded_at: recordedAtUs,
    payload: { kind: 'run', run_id: 'run-1', event: { kind: 'model_completed', model, usage } },
  });
}

async function writeMuseSession(
  museSessionsDir: string,
  sessionId: string,
  lines: string[],
): Promise<void> {
  const dir = join(museSessionsDir, '2026', '09', '20', sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'session.jsonl'), lines.join('\n') + '\n');
}

/** recorded_at is microseconds; fixtures pin it from ISO session times. */
const museUs = (iso: string): number => Date.parse(iso) * 1000;

describe('collectSessionUsage — muse extractor', () => {
  const workingDir = '/Users/x/projects/muse-demo';
  const sessionCreatedAt = '2026-09-20T12:00:00.000Z';

  it('sums model_completed usage, splits cached from input, attributes per model', async () => {
    const museSessionsDir = join(root, 'muse-sums');
    await writeMuseSession(museSessionsDir, 'sess-1', [
      JSON.stringify({ retained_frame: 'session_permission_transaction' }),
      museMetaLine(workingDir, museUs('2026-09-20T12:00:01.000Z')),
      JSON.stringify({
        payload_type: 'runtime.session',
        recorded_at: museUs('2026-09-20T12:00:02.000Z'),
        payload: { kind: 'run', run_id: 'run-1', event: { kind: 'started' } },
      }),
      museCompletedLine('muse-spark-1.3', {
        input_tokens: 100, output_tokens: 20, cached_tokens: 0,
        cache_write_tokens: 5, cache_read_tokens: 0, reasoning_tokens: 8,
      }, museUs('2026-09-20T12:00:03.000Z')),
      'not json',
      // input includes cached — only the fresh 200 count as input
      museCompletedLine('muse-spark-1.3', {
        input_tokens: 1000, output_tokens: 50, cached_tokens: 800,
        cache_write_tokens: 10, cache_read_tokens: 800, reasoning_tokens: 20,
      }, museUs('2026-09-20T12:00:04.000Z')),
      // model_completed without a model — skipped
      JSON.stringify({
        payload_type: 'runtime.session',
        recorded_at: museUs('2026-09-20T12:00:05.000Z'),
        payload: {
          kind: 'run',
          run_id: 'run-1',
          event: { kind: 'model_completed', usage: { input_tokens: 999, output_tokens: 999 } },
        },
      }),
      museCompletedLine('muse-spark-1.3-contributor', {
        input_tokens: 60, output_tokens: 6, cached_tokens: 0,
        cache_write_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0,
      }, museUs('2026-09-20T12:00:06.000Z')),
    ]);

    const usage = await collectSessionUsage(
      { shellType: 'muse' as never, workingDir, createdAt: sessionCreatedAt },
      { museSessionsDir },
    );

    assert.ok(usage);
    assert.equal(usage.harness, 'muse');
    assert.equal(usage.inputTokens, 360);
    assert.equal(usage.outputTokens, 76);
    assert.equal(usage.cacheReadTokens, 800);
    assert.equal(usage.cacheWriteTokens, 15);
    assert.equal(usage.totalTokens, 1251);
    assert.deepEqual(usage.models, ['muse-spark-1.3', 'muse-spark-1.3-contributor']);
    assert.deepEqual(usage.perModel, [
      {
        model: 'muse-spark-1.3',
        inputTokens: 300,
        outputTokens: 70,
        cacheReadTokens: 800,
        cacheWriteTokens: 15,
      },
      {
        model: 'muse-spark-1.3-contributor',
        inputTokens: 60,
        outputTokens: 6,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);
    assert.ok(usage.collectedAt);
  });

  it('disambiguates two sessions in the same workdir by createdAt (>= session wins, newest)', async () => {
    const museSessionsDir = join(root, 'muse-disambig');
    await writeMuseSession(museSessionsDir, 'sess-older', [
      museMetaLine(workingDir, museUs('2026-09-20T11:00:00.000Z')),
      museCompletedLine('muse-spark-1.3', { input_tokens: 9, output_tokens: 9 }, museUs('2026-09-20T11:00:05.000Z')),
    ]);
    await writeMuseSession(museSessionsDir, 'sess-newer', [
      museMetaLine(workingDir, museUs('2026-09-20T12:00:03.000Z')),
      museCompletedLine('muse-spark-1.3', { input_tokens: 42, output_tokens: 7 }, museUs('2026-09-20T12:00:05.000Z')),
    ]);

    const usage = await collectSessionUsage(
      { shellType: 'muse' as never, workingDir, createdAt: sessionCreatedAt },
      { museSessionsDir },
    );
    assert.ok(usage);
    assert.equal(usage.inputTokens, 42);
    assert.equal(usage.outputTokens, 7);
  });

  it('returns null when no session matches the workspace or the dir is missing', async () => {
    const museSessionsDir = join(root, 'muse-nomatch');
    await writeMuseSession(museSessionsDir, 'sess-other', [
      museMetaLine('/some/other/dir', museUs('2026-09-20T12:00:01.000Z')),
      museCompletedLine('muse-spark-1.3', { input_tokens: 999, output_tokens: 999 }, museUs('2026-09-20T12:00:05.000Z')),
    ]);

    assert.equal(
      await collectSessionUsage(
        { shellType: 'muse' as never, workingDir, createdAt: sessionCreatedAt },
        { museSessionsDir },
      ),
      null,
    );
    assert.equal(
      await collectSessionUsage(
        { shellType: 'muse' as never, workingDir, createdAt: sessionCreatedAt },
        { museSessionsDir: join(root, 'muse-missing') },
      ),
      null,
    );
  });
});

describe('collectSessionUsage — muse id-first resolution', () => {
  const workingDir = '/Users/x/projects/muse-demo';
  const sessionCreatedAt = '2026-09-20T12:00:00.000Z';

  it('resolves the exact session.jsonl by native id, ignoring the workdir', async () => {
    const museSessionsDir = join(root, 'muse-id-hit');
    const nativeId = 'id-hit-uuid-1234';
    await writeMuseSession(museSessionsDir, nativeId, [
      museMetaLine('/some/other/workspace', museUs('2026-09-20T12:00:01.000Z')),
      museCompletedLine('muse-spark-1.3', { input_tokens: 11, output_tokens: 3 }, museUs('2026-09-20T12:00:05.000Z')),
    ]);
    // A workdir decoy that must NOT win over the id.
    await writeMuseSession(museSessionsDir, 'sess-decoy', [
      museMetaLine(workingDir, museUs('2026-09-20T12:00:02.000Z')),
      museCompletedLine('muse-spark-1.3', { input_tokens: 999, output_tokens: 999 }, museUs('2026-09-20T12:00:05.000Z')),
    ]);

    const usage = await collectSessionUsage(
      { shellType: 'muse', museSessionId: nativeId, workingDir, createdAt: sessionCreatedAt },
      { museSessionsDir },
    );
    assert.ok(usage);
    assert.equal(usage.harness, 'muse');
    assert.equal(usage.inputTokens, 11);
    assert.equal(usage.outputTokens, 3);
  });

  it('resolves by id without any workdir on the session', async () => {
    const museSessionsDir = join(root, 'muse-id-only');
    const nativeId = 'id-only-uuid-5678';
    await writeMuseSession(museSessionsDir, nativeId, [
      museMetaLine('/whatever/workspace', museUs('2026-09-20T12:00:01.000Z')),
      museCompletedLine('muse-spark-1.3', { input_tokens: 5, output_tokens: 2 }, museUs('2026-09-20T12:00:05.000Z')),
    ]);

    const usage = await collectSessionUsage(
      { shellType: 'muse', museSessionId: nativeId },
      { museSessionsDir },
    );
    assert.ok(usage);
    assert.equal(usage.inputTokens, 5);
  });

  it('falls back to workdir discovery when the native id matches nothing', async () => {
    const museSessionsDir = join(root, 'muse-id-miss');
    await writeMuseSession(museSessionsDir, 'sess-workdir', [
      museMetaLine(workingDir, museUs('2026-09-20T12:00:01.000Z')),
      museCompletedLine('muse-spark-1.3', { input_tokens: 42, output_tokens: 7 }, museUs('2026-09-20T12:00:05.000Z')),
    ]);

    const usage = await collectSessionUsage(
      {
        shellType: 'muse',
        museSessionId: 'no-such-uuid',
        workingDir,
        createdAt: sessionCreatedAt,
      },
      { museSessionsDir },
    );
    assert.ok(usage);
    assert.equal(usage.inputTokens, 42);
    assert.equal(usage.outputTokens, 7);
  });

  it('returns null when the id misses and no workdir (or no workdir match) exists', async () => {
    const museSessionsDir = join(root, 'muse-id-null');
    await writeMuseSession(museSessionsDir, 'sess-other', [
      museMetaLine('/some/other/dir', museUs('2026-09-20T12:00:01.000Z')),
      museCompletedLine('muse-spark-1.3', { input_tokens: 999, output_tokens: 999 }, museUs('2026-09-20T12:00:05.000Z')),
    ]);

    // Id miss + no workdir at all.
    assert.equal(
      await collectSessionUsage(
        { shellType: 'muse', museSessionId: 'no-such-uuid' },
        { museSessionsDir },
      ),
      null,
    );
    // Id miss + workdir with no match.
    assert.equal(
      await collectSessionUsage(
        { shellType: 'muse', museSessionId: 'no-such-uuid', workingDir, createdAt: sessionCreatedAt },
        { museSessionsDir },
      ),
      null,
    );
    // Neither id nor workdir.
    assert.equal(await collectSessionUsage({ shellType: 'muse' }), null);
  });

  it('rejects a hostile native id instead of escaping the sessions dir', async () => {
    const museSessionsDir = join(root, 'muse-id-hostile');
    await writeMuseSession(museSessionsDir, 'sess-1', [
      museMetaLine(workingDir, museUs('2026-09-20T12:00:01.000Z')),
      museCompletedLine('muse-spark-1.3', { input_tokens: 1, output_tokens: 1 }, museUs('2026-09-20T12:00:05.000Z')),
    ]);

    assert.equal(
      await collectSessionUsage(
        { shellType: 'muse', museSessionId: '../../etc' },
        { museSessionsDir },
      ),
      null,
    );
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

  it('routes muse shellType to the workdir-based muse extractor', async () => {
    const museSessionsDir = join(root, 'routing-muse');
    const workingDir = '/tmp/muse-routing';
    await writeMuseSession(museSessionsDir, 'sess-muse-1', [
      museMetaLine(workingDir, museUs('2026-09-20T10:00:01.000Z')),
      museCompletedLine(
        'muse-spark-1.3',
        { input_tokens: 7, output_tokens: 3 },
        museUs('2026-09-20T10:00:05.000Z'),
      ),
    ]);

    const usage = await collectSessionUsage(
      { shellType: 'muse' as never, workingDir, createdAt: '2026-09-20T10:00:00.000Z' },
      { museSessionsDir },
    );
    assert.equal(usage?.harness, 'muse');
  });

  it('returns null for sessions with no structured source (shell/cursor)', async () => {
    assert.equal(await collectSessionUsage({ shellType: 'shell' }), null);
  });
});

describe('collectSessionUsage — incremental folding across polls', () => {
  const withoutCollectedAt = <T extends { collectedAt?: string } | null>(usage: T) => {
    if (!usage) return usage;
    const { collectedAt: _collectedAt, ...rest } = usage;
    return rest;
  };

  it('claude: appended lines (repeat id, second model) match a fresh-cache collect and read only the delta', async () => {
    const workingDir = '/tmp/incr.claude';
    const sessionId = 'incr-claude';
    const claudeProjectsDir = join(root, 'incr-claude');
    const dir = join(claudeProjectsDir, claudeProjectSlug(workingDir));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${sessionId}.jsonl`);
    await writeFile(file, [
      claudeLine('m1', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }),
      claudeLine('m2', 'claude-sonnet-5', { input_tokens: 1, output_tokens: 2 }),
    ].join('\n') + '\n');

    const foldCache = new JsonlFoldCache();
    const ref = { shellType: 'claude' as const, claudeSessionId: sessionId, workingDir };
    const first = await collectSessionUsage(ref, { claudeProjectsDir, foldCache });
    assert.equal(first?.inputTokens, 11);

    const appended = [
      claudeLine('m2', 'claude-sonnet-5', { input_tokens: 1, output_tokens: 2 }),
      claudeLine('m3', 'claude-haiku-4-5', { input_tokens: 100, output_tokens: 200 }),
      claudeLine('m4', 'claude-sonnet-5', { input_tokens: 5, output_tokens: 6 }),
    ].join('\n') + '\n';
    await appendFile(file, appended);

    const before = foldCache.stats().bytesRead;
    const second = await collectSessionUsage(ref, { claudeProjectsDir, foldCache });
    const delta = foldCache.stats().bytesRead - before;
    assert.ok(delta <= Buffer.byteLength(appended) + 64, `read ${delta} bytes`);

    const fresh = await collectSessionUsage(ref, { claudeProjectsDir, foldCache: new JsonlFoldCache() });
    assert.deepEqual(withoutCollectedAt(second), withoutCollectedAt(fresh));
    assert.equal(second?.inputTokens, 10 + 1 + 100 + 5);
    assert.deepEqual(second?.models, ['claude-sonnet-5', 'claude-haiku-4-5']);

    // The result never aliases cache state: mutating it does not leak into the next poll.
    second!.perModel![0]!.inputTokens = 999_999;
    second!.models.push('bogus');
    const third = await collectSessionUsage(ref, { claudeProjectsDir, foldCache });
    assert.deepEqual(withoutCollectedAt(third), withoutCollectedAt(fresh));
  });

  it('claude: a half-written line is excluded, then counted once when completed', async () => {
    const workingDir = '/tmp/incr.half';
    const sessionId = 'incr-half';
    const claudeProjectsDir = join(root, 'incr-half');
    const dir = join(claudeProjectsDir, claudeProjectSlug(workingDir));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${sessionId}.jsonl`);
    const whole = claudeLine('m1', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 1 });
    const tail = claudeLine('m2', 'claude-sonnet-5', { input_tokens: 7, output_tokens: 3 });
    const cut = Math.floor(tail.length / 2);
    await writeFile(file, whole + '\n' + tail.slice(0, cut));

    const foldCache = new JsonlFoldCache();
    const ref = { shellType: 'claude' as const, claudeSessionId: sessionId, workingDir };
    const partial = await collectSessionUsage(ref, { claudeProjectsDir, foldCache });
    assert.equal(partial?.inputTokens, 10);

    await appendFile(file, tail.slice(cut) + '\n');
    const done = await collectSessionUsage(ref, { claudeProjectsDir, foldCache });
    assert.equal(done?.inputTokens, 17);
    assert.equal(done?.outputTokens, 4);
    const again = await collectSessionUsage(ref, { claudeProjectsDir, foldCache });
    assert.equal(again?.inputTokens, 17);
  });

  it('codex: appended token_count updates totals and appended turn_context adds a model', async () => {
    const codexSessionId = '019d2b5c-0000-7863-9688-d9be287e46a6';
    const codexSessionsDir = join(root, 'incr-codex');
    const dir = join(codexSessionsDir, '2026', '07', '02');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `rollout-2026-07-02T10-00-00-${codexSessionId}.jsonl`);
    const tokenCount = (input: number, cached: number, output: number) => JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } },
    });
    await writeFile(file, [
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4' } }),
      tokenCount(100, 50, 5),
    ].join('\n') + '\n');

    const foldCache = new JsonlFoldCache();
    const ref = { shellType: 'codex' as const, codexSessionId };
    const first = await collectSessionUsage(ref, { codexSessionsDir, foldCache });
    assert.equal(first?.totalTokens, 105);
    assert.deepEqual(first?.models, ['gpt-5.4']);

    await appendFile(file, [
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4' } }),
      tokenCount(1000, 400, 30),
    ].join('\n') + '\n');

    const second = await collectSessionUsage(ref, { codexSessionsDir, foldCache });
    const fresh = await collectSessionUsage(ref, { codexSessionsDir, foldCache: new JsonlFoldCache() });
    assert.deepEqual(withoutCollectedAt(second), withoutCollectedAt(fresh));
    assert.equal(second?.inputTokens, 600);
    assert.equal(second?.cacheReadTokens, 400);
    assert.equal(second?.outputTokens, 30);
    assert.deepEqual(second?.models, ['gpt-5.4', 'gpt-5.4-mini']);
    // The first result's models array was a copy, not the live fold state.
    assert.deepEqual(first?.models, ['gpt-5.4']);
  });

  it('kimi: two agents, appending to one wire.jsonl matches a fresh-cache result', async () => {
    const workingDir = '/Users/x/projects/incr-kimi';
    const kimiCodeDir = join(root, 'incr-kimi');
    const sessionDir = join(kimiCodeDir, 'sessions', 'wd_incr_1', 'session_incr');
    await mkdir(kimiCodeDir, { recursive: true });
    await writeFile(
      join(kimiCodeDir, 'session_index.jsonl'),
      JSON.stringify({ sessionId: 'session_incr', sessionDir, workDir: workingDir }) + '\n',
    );
    const rec = (model: string, n: number) =>
      kimiUsageRecord(model, { inputOther: n, output: n * 2, inputCacheRead: n * 3, inputCacheCreation: n * 4 });
    await writeKimiSession({
      kimiCodeDir,
      sessionDir,
      workDir: workingDir,
      createdAt: '2026-07-17T12:00:05.000Z',
      wireByAgent: {
        main: [rec('kimi-code/k3', 1)],
        'agent-0': [rec('kimi-code/k2', 2), rec('kimi-code/k3', 3)],
      },
    });

    const foldCache = new JsonlFoldCache();
    const ref = { shellType: 'kimi-code' as const, workingDir, createdAt: '2026-07-17T12:00:00.000Z' };
    const first = await collectSessionUsage(ref, { kimiCodeDir, foldCache });
    assert.equal(first?.inputTokens, 6);

    await appendFile(join(sessionDir, 'agents', 'agent-0', 'wire.jsonl'), rec('kimi-code/k3', 10) + '\n' + rec('kimi-code/k1', 5) + '\n');
    const second = await collectSessionUsage(ref, { kimiCodeDir, foldCache });
    const fresh = await collectSessionUsage(ref, { kimiCodeDir, foldCache: new JsonlFoldCache() });
    assert.deepEqual(withoutCollectedAt(second), withoutCollectedAt(fresh));
    assert.equal(second?.inputTokens, 1 + 2 + 3 + 10 + 5);
    assert.deepEqual(second?.models, ['kimi-code/k2', 'kimi-code/k3', 'kimi-code/k1']);
    // Repeated polls never double count merged sums.
    const third = await collectSessionUsage(ref, { kimiCodeDir, foldCache });
    assert.deepEqual(withoutCollectedAt(third), withoutCollectedAt(fresh));
  });

  it('kimi: an agent dir without wire.jsonl is skipped; with none at all the result is null', async () => {
    const workingDir = '/Users/x/projects/kimi-nowire';
    const kimiCodeDir = join(root, 'kimi-nowire');
    const sessionDir = join(kimiCodeDir, 'sessions', 'wd_nw_1', 'session_nw');
    await mkdir(kimiCodeDir, { recursive: true });
    await writeFile(
      join(kimiCodeDir, 'session_index.jsonl'),
      JSON.stringify({ sessionId: 'session_nw', sessionDir, workDir: workingDir }) + '\n',
    );
    await writeKimiSession({
      kimiCodeDir,
      sessionDir,
      workDir: workingDir,
      createdAt: '2026-07-17T12:00:05.000Z',
      wireByAgent: {
        main: [kimiUsageRecord('kimi-code/k3', { inputOther: 7, output: 3, inputCacheRead: 0, inputCacheCreation: 0 })],
      },
    });
    await mkdir(join(sessionDir, 'agents', 'agent-empty'), { recursive: true });

    const ref = { shellType: 'kimi-code' as const, workingDir, createdAt: '2026-07-17T12:00:00.000Z' };
    const usage = await collectSessionUsage(ref, { kimiCodeDir, foldCache: new JsonlFoldCache() });
    assert.equal(usage?.inputTokens, 7);
    assert.equal(usage?.outputTokens, 3);
    assert.deepEqual(usage?.models, ['kimi-code/k3']);

    await rm(join(sessionDir, 'agents', 'main'), { recursive: true });
    const none = await collectSessionUsage(ref, { kimiCodeDir, foldCache: new JsonlFoldCache() });
    assert.equal(none, null);
  });

  it('muse: appended model_completed lines match a fresh-cache result', async () => {
    const workingDir = '/Users/x/projects/incr-muse';
    const museSessionsDir = join(root, 'incr-muse');
    const completed = (model: string, input: number, cacheRead: number) => museCompletedLine(model, {
      input_tokens: input, output_tokens: 5, cache_write_tokens: 1, cache_read_tokens: cacheRead,
    }, museUs('2026-09-20T12:00:03.000Z'));
    await writeMuseSession(museSessionsDir, 'sess-incr', [
      museMetaLine(workingDir, museUs('2026-09-20T12:00:01.000Z')),
      completed('muse-a', 100, 40),
    ]);

    const foldCache = new JsonlFoldCache();
    const ref = { shellType: 'muse' as never, workingDir, createdAt: '2026-09-20T12:00:00.000Z' };
    const first = await collectSessionUsage(ref, { museSessionsDir, foldCache });
    assert.equal(first?.inputTokens, 60);

    await appendFile(
      join(museSessionsDir, '2026', '09', '20', 'sess-incr', 'session.jsonl'),
      completed('muse-a', 50, 10) + '\n' + completed('muse-b', 20, 0) + '\n',
    );
    const second = await collectSessionUsage(ref, { museSessionsDir, foldCache });
    const fresh = await collectSessionUsage(ref, { museSessionsDir, foldCache: new JsonlFoldCache() });
    assert.deepEqual(withoutCollectedAt(second), withoutCollectedAt(fresh));
    assert.equal(second?.inputTokens, 60 + 40 + 20);
    assert.deepEqual(second?.models, ['muse-a', 'muse-b']);
  });

  it('pi: appended assistant messages match a fresh-cache result', async () => {
    const workingDir = '/Users/x/projects/pi-incr';
    const piSessionsDir = join(root, 'incr-pi');
    const dir = join(piSessionsDir, '--Users-x-projects-pi-incr--');
    await mkdir(dir, { recursive: true });
    const file = join(dir, '2026-08-08T10-00-01-000Z_pi.jsonl');
    const assistant = (provider: string, model: string, input: number) => JSON.stringify({
      type: 'message',
      message: { role: 'assistant', provider, model, usage: { input, output: 2, cacheRead: 3, cacheWrite: 4 } },
    });
    await writeFile(file, [
      JSON.stringify({ type: 'session', version: 3, timestamp: '2026-08-08T10:00:01.000Z', cwd: workingDir }),
      assistant('anthropic', 'claude-sonnet-4', 10),
    ].join('\n') + '\n');

    const foldCache = new JsonlFoldCache();
    const ref = { shellType: 'pi' as const, workingDir, createdAt: '2026-08-08T10:00:00.000Z' };
    const first = await collectSessionUsage(ref, { piSessionsDir, foldCache });
    assert.equal(first?.inputTokens, 10);

    await appendFile(file, assistant('openai', 'gpt-5', 7) + '\n' + assistant('anthropic', 'claude-sonnet-4', 1) + '\n');
    const second = await collectSessionUsage(ref, { piSessionsDir, foldCache });
    const fresh = await collectSessionUsage(ref, { piSessionsDir, foldCache: new JsonlFoldCache() });
    assert.deepEqual(withoutCollectedAt(second), withoutCollectedAt(fresh));
    assert.equal(second?.inputTokens, 18);
    assert.deepEqual(second?.models, ['anthropic/claude-sonnet-4', 'openai/gpt-5']);
  });
});
