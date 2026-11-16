import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureCodexHooks, ensureCodexWorkdirTrust } from './codex-installer.js';

function restoreHome(realHome: string | undefined): void {
  if (realHome === undefined) delete process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
  else process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = realHome;
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
    const realHome = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    const home = mkdtempSync(join(tmpdir(), 'ftw-codex-hooks-'));
    process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = home;

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
    const realHome = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    const home = mkdtempSync(join(tmpdir(), 'ftw-codex-hooks-repair-'));
    process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = home;

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

it('installs hooks and trust in CODEX_HOME and defaults when blank', () => {
  const key = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const previousHome = process.env[key];
  const previousConfig = process.env.CODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), 'ftown-codex-home-'));
  process.env[key] = home;
  try {
    process.env.CODEX_HOME = join(home, 'custom');
    assert.equal(ensureCodexHooks(join(home, 'harness'), join(home, 'notify')), true);
    ensureCodexWorkdirTrust(home);
    assert.equal(existsSync(join(home, 'custom', 'hooks.json')), true);
    assert.match(readFileSync(join(home, 'custom', 'config.toml'), 'utf8'), /trust_level = "trusted"/);
    assert.equal(existsSync(join(home, '.codex')), false);
    process.env.CODEX_HOME = ' ';
    assert.equal(ensureCodexHooks(join(home, 'harness'), join(home, 'notify')), true);
    ensureCodexWorkdirTrust(home);
    assert.equal(existsSync(join(home, '.codex', 'hooks.json')), true);
    assert.equal(existsSync(join(home, '.codex', 'config.toml')), true);
  } finally {
    restoreHome(previousHome);
    if (previousConfig === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousConfig;
    rmSync(home, { recursive: true, force: true });
  }
});

// Tests in this module own temporary homes and must not access inherited harness paths.
const inheritedPathOverrides: NodeJS.ProcessEnv = {};
const pathOverrideNames = [
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'OPENCODE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
] as const;
before(() => {
  for (const name of pathOverrideNames) {
    inheritedPathOverrides[name] = process.env[name];
    delete process.env[name];
  }
});
after(() => {
  for (const name of pathOverrideNames) {
    const value = inheritedPathOverrides[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
