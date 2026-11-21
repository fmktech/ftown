import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fetchOmpModels, fetchOmpQuota } from './omp.js';
import { advisePickRouting, adviseQuotaRouting } from './routing.js';

test('OMP routes exact model selectors against their own subscription windows', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-omp-quota-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = () => new Date('2026-11-21T09:00:00.000Z');
  const options = { now, homeDir: dir, timeoutMs: 2000, env: { PATH: dir + delimiter + process.env.PATH } };
  const reset = now().getTime() + 4 * 60 * 60_000;
  const pool = { window: '5h', durationMs: 18_000_000, accounts: 2, usedAccounts: 0.5 };
  const usage = {
    capacity: {
      anthropic: [{ ...pool, usedAccounts: 2 }],
      'openai-codex': [{ ...pool, meter: 'chat' }, { ...pool, meter: 'spark', usedAccounts: 2 }],
    },
    reports: [{ provider: 'anthropic', limits: [{ window: { id: '5h', resetsAt: reset } }] }],
  };
  const catalog = { models: [{ selector: 'openai-codex/gpt', name: 'GPT', contextWindow: 200000, thinking: ['low', 'high'] }] };
  await writeFile(join(dir, 'omp'), `#!/bin/sh
case "$1 $2" in
  "models --json") echo '${JSON.stringify(catalog)}' ;;
  "usage --json") echo '${JSON.stringify(usage)}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });

  const [models, quota] = await Promise.all([fetchOmpModels(options), fetchOmpQuota(options)]);
  assert.equal(models.models[0]?.id, 'openai-codex/gpt');
  assert.deepEqual(models.models[0]?.efforts, ['low', 'high']);
  const advice = adviseQuotaRouting([quota], now());
  const route = (model: string) => advisePickRouting({ provider: 'omp', model }, [quota], advice, now());
  assert.equal(route('anthropic/claude').resetsAt, new Date(reset).toISOString());
  assert.equal(route('anthropic/claude').availability, 'exhausted');
  assert.equal(route('openai-codex/gpt').leftPercent, 75);
  assert.equal(route('openai-codex/gpt-spark').availability, 'exhausted');
  assert.equal(route('openrouter/model').availability, 'unknown');
});
