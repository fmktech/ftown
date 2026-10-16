import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionController } from './session-controller.js';
import { relaunchFtownSession, type CreateFtownSessionDeps } from './create-ftown-session.js';
import { AUTOMATION_REMOVED_MESSAGE } from './retired-automation.js';
import type { Session } from './types.js';

const retired = { id: 'run-1', loopId: 'old-loop', command: 'dispatch', status: 'error' } as Session;

test('retry and internal resume/retry reject legacy provenance before touching launch dependencies', async () => {
  const controller = new SessionController({ store: { loadSession: async () => retired } } as never);
  assert.deepEqual(await controller.retry(retired.id), {
    ok: false, code: 'automation_removed', message: AUTOMATION_REMOVED_MESSAGE,
  });
  for (const mode of ['resume', 'retry'] as const) {
    await assert.rejects(relaunchFtownSession({} as CreateFtownSessionDeps, retired, mode),
      { code: 'automation_removed', message: AUTOMATION_REMOVED_MESSAGE });
  }
});

test('all removed CLI aliases reject locally with no bridge pointer or advertised help', () => {
  const home = mkdtempSync(join(tmpdir(), 'ftown-cli-retired-'));
  try {
    const cli = fileURLToPath(new URL('./ftown-sessions-cli.ts', import.meta.url));
    for (const alias of ['loop', 'loops', 'loop-list']) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', cli, alias, 'create'], {
        encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Recurring loops and factory automation have been removed/);
      assert.doesNotMatch(result.stderr, /bridge.json|ENOENT/);
    }
    const help = spawnSync(process.execPath, ['--import', 'tsx', cli, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.doesNotMatch(help.stderr + help.stdout, /cron|loop create|scheduled loops/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
