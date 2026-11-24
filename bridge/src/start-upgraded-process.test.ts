import assert from 'node:assert/strict';
import { execFile as exec } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

test('the upgraded bridge keeps the launcher PID managed by the service', {
  skip: process.platform === 'win32' || typeof process.execve !== 'function',
}, async t => {
  const home = await mkdtemp(join(tmpdir(), 'ftown-launcher-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtime = join(home, '.ftown', 'cli', 'dist');
  await mkdir(runtime, { recursive: true });
  await writeFile(join(home, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(runtime, 'ftown-cli.js'), 'console.log("running " + process.pid + " " + process.env.FTOWN_UPGRADE_DONE);');
  const launcher = join(home, 'start.mjs');
  const module = new URL('./start-commands.ts', import.meta.url).href;
  await writeFile(launcher, `
    import { runStart } from ${JSON.stringify(module)};
    console.log("launcher " + process.pid);
    await runStart([], {
      env: { HOME: process.env.HOME, PATH: process.env.PATH },
      assertReady() {}, loadBridge: async () => ({}), version: () => "1.0.0",
      fetchLatest: async () => "1.0.1", beginUpgrade: () => ({ commit() {} }),
    });
  `);
  const { stdout } = await promisify(exec)(process.execPath, ['--import', import.meta.resolve('tsx'), launcher], {
    env: { ...process.env, HOME: home, PATH: home + ':' + process.env.PATH }, timeout: 20000,
  });
  const pid = stdout.match(/^launcher (\d+)$/m)?.[1];
  assert.ok(pid);
  assert.ok(stdout.includes('running ' + pid + ' 1'), stdout);
});
