import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureCodexHooks } from './codex-installer.js';

function restoreHome(realHome: string | undefined): void {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
}

function readHooks(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')) as Record<string, unknown>;
}

function eventCommands(data: Record<string, unknown>, event: string): Array<Record<string, unknown>> {
  const hooks = data.hooks as Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>>;
  return hooks[event].flatMap((entry) => entry.hooks ?? []);
}

describe('ensureCodexHooks', () => {
  it('installs Codex notify hooks without async:true', () => {
    const realHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), 'ftw-codex-hooks-'));
    process.env.HOME = home;

    try {
      const harness = join(home, '.ftown', 'bin', 'ftown-harness');
      const notify = join(home, '.ftown', 'notify.sh');
      ensureCodexHooks(harness, notify);

      const data = readHooks(home);
      for (const event of ['Stop', 'UserPromptSubmit', 'SessionStart', 'PreToolUse', 'PostToolUse']) {
        const notifyHook = eventCommands(data, event).find((hook) => hook.command === notify);
        assert.ok(notifyHook, `missing notify hook for ${event}`);
        assert.equal(notifyHook.async, undefined);
        assert.equal(notifyHook.timeout, 10);
      }
      assert.equal(
        eventCommands(data, 'PreToolUse').some((hook) => hook.command === `${harness} hook-pump`),
        false,
        'tool events should not run the mail pump',
      );
    } finally {
      restoreHome(realHome);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('repairs legacy Codex notify hooks that used async:true', () => {
    const realHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), 'ftw-codex-hooks-repair-'));
    process.env.HOME = home;

    try {
      const hooksPath = join(home, '.codex', 'hooks.json');
      const harness = join(home, '.ftown', 'bin', 'ftown-harness');
      const notify = join(home, '.ftown', 'notify.sh');
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(
        hooksPath,
        JSON.stringify({
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: 'command', command: notify, async: true },
                ],
              },
            ],
          },
        }),
        'utf8',
      );

      ensureCodexHooks(harness, notify);

      const data = readHooks(home);
      const notifyHook = eventCommands(data, 'Stop').find((hook) => hook.command === notify);
      assert.ok(notifyHook);
      assert.equal(notifyHook.async, undefined);
      assert.equal(notifyHook.timeout, 10);
      assert.equal(existsSync(hooksPath), true);
    } finally {
      restoreHome(realHome);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
