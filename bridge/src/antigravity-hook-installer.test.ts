import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  antigravityHookCommand,
  antigravityHookScriptPath,
  buildAntigravityHookEntry,
  installAntigravityHooks,
  setTempNameGeneratorForTests,
} from './antigravity-hook-installer.js';

const BUNDLED_BODY = '#!/bin/sh\necho installed-ok\n';
const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'ftown-agy-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeBundled(root: string): string {
  const path = join(root, 'bundled-antigravity-hook.sh');
  writeFileSync(path, BUNDLED_BODY);
  chmodSync(path, 0o755);
  return path;
}

function makeHome(root: string, name = 'home'): string {
  const home = join(root, name);
  mkdirSync(join(home, '.gemini'), { recursive: true });
  return home;
}

function configDirOf(home: string): string {
  return join(home, '.gemini', 'config');
}

function hooksPath(home: string): string {
  return join(configDirOf(home), 'hooks.json');
}

function readHooks(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(hooksPath(home), 'utf8')) as Record<string, unknown>;
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function writeExecutable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function runCommand(command: string): string {
  return execFileSync('sh', ['-c', command], { encoding: 'utf8' });
}

function runShell(command: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('sh', ['-c', command], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('does nothing when agy is not installed (no .gemini dir)', () => {
  withRoot((root) => {
    const home = join(root, 'home');
    mkdirSync(home);
    const bundled = makeBundled(root);
    assert.equal(installAntigravityHooks(bundled, home), false);
    assert.deepEqual(readdirSync(home), []);
  });
});

test('.gemini as a regular file means agy is absent: returns false and creates nothing', () => {
  withRoot((root) => {
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(join(home, '.gemini'), 'not a dir');

    assert.equal(installAntigravityHooks(makeBundled(root), home), false);

    assert.deepEqual(readdirSync(home), ['.gemini']);
    assert.equal(existsSync(join(home, '.ftown')), false);
  });
});

test('returns false and writes nothing when the bundled script is missing', () => {
  withRoot((root) => {
    const home = makeHome(root);
    assert.equal(installAntigravityHooks(join(root, 'missing.sh'), home), false);
    assert.equal(existsSync(join(home, '.ftown')), false);
    assert.equal(existsSync(configDirOf(home)), false);
  });
});

test('fresh install copies the script and writes hooks.json', () => {
  withRoot((root) => {
    const home = makeHome(root);
    const bundled = makeBundled(root);
    assert.equal(installAntigravityHooks(bundled, home), true);

    const script = antigravityHookScriptPath(home);
    assert.equal(readFileSync(script, 'utf8'), BUNDLED_BODY);
    assert.equal(modeOf(script), 0o755);

    const hooks = readHooks(home);
    assert.deepEqual(hooks, { ftown: buildAntigravityHookEntry(script) });

    const ftown = hooks.ftown as Record<string, unknown>;
    assert.deepEqual(Object.keys(ftown), ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop']);
    for (const event of ['SessionStart', 'PreInvocation', 'Stop']) {
      for (const handler of ftown[event] as Array<Record<string, unknown>>) {
        assert.equal(handler.type, 'command');
        assert.equal(handler.timeout, 10);
      }
    }
    for (const event of ['PreToolUse', 'PostToolUse']) {
      for (const group of ftown[event] as Array<{ matcher: string; hooks: Array<Record<string, unknown>> }>) {
        assert.equal(group.matcher, '*');
        for (const handler of group.hooks) {
          assert.equal(handler.type, 'command');
          assert.equal(handler.timeout, 10);
        }
      }
    }

    assert.deepEqual(readdirSync(configDirOf(home)), ['hooks.json']);
    assert.deepEqual(readdirSync(join(home, '.ftown')), ['antigravity-hook.sh']);
  });
});

test('other top-level hooks are preserved in order and ftown is appended last', () => {
  withRoot((root) => {
    const home = makeHome(root);
    mkdirSync(configDirOf(home), { recursive: true });
    const existing = { mine: { command: 'mine.sh', timeout: 3 }, other: [{ type: 'command' }] };
    writeFileSync(hooksPath(home), JSON.stringify(existing, null, 2));

    assert.equal(installAntigravityHooks(makeBundled(root), home), true);

    const hooks = readHooks(home);
    assert.deepEqual(Object.keys(hooks), ['mine', 'other', 'ftown']);
    assert.deepEqual(hooks.mine, existing.mine);
    assert.deepEqual(hooks.other, existing.other);
  });
});

test('a stale ftown entry is replaced in place, keeping key order', () => {
  withRoot((root) => {
    const home = makeHome(root);
    mkdirSync(configDirOf(home), { recursive: true });
    writeFileSync(hooksPath(home), JSON.stringify({ a: 1, ftown: { stale: true }, b: 2 }));

    assert.equal(installAntigravityHooks(makeBundled(root), home), true);

    const hooks = readHooks(home);
    assert.deepEqual(Object.keys(hooks), ['a', 'ftown', 'b']);
    assert.equal(hooks.a, 1);
    assert.equal(hooks.b, 2);
    assert.deepEqual(hooks.ftown, buildAntigravityHookEntry(antigravityHookScriptPath(home)));
  });
});

test('second install is idempotent and does not rewrite hooks.json', () => {
  withRoot((root) => {
    const home = makeHome(root);
    const bundled = makeBundled(root);
    assert.equal(installAntigravityHooks(bundled, home), true);
    const before = statSync(hooksPath(home));

    assert.equal(installAntigravityHooks(bundled, home), true);
    const after = statSync(hooksPath(home));

    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual(readdirSync(configDirOf(home)), ['hooks.json']);
  });
});

for (const [label, content] of [
  ['invalid JSON', '{"broken": '],
  ['a top-level array', '[]'],
  ['a top-level string', '"x"'],
  ['a top-level null', 'null'],
  ['a UTF-8 BOM before valid JSON', '﻿{"a": 1}'],
  ['a // comment', '{ // c\n "a": 1 }'],
  ['a trailing comma', '{"a": 1,}'],
] as const) {
  test(`hooks.json holding ${label} is left byte-identical and install fails`, () => {
    withRoot((root) => {
      const home = makeHome(root);
      mkdirSync(configDirOf(home), { recursive: true });
      writeFileSync(hooksPath(home), content);
      const before = readFileSync(hooksPath(home));

      assert.equal(installAntigravityHooks(makeBundled(root), home), false);

      assert.deepEqual(readFileSync(hooksPath(home)), before);
      assert.deepEqual(readdirSync(configDirOf(home)), ['hooks.json']);
      // Pinned: the script is copied before hooks.json is merged, so it exists even when the merge refuses.
      assert.equal(readFileSync(antigravityHookScriptPath(home), 'utf8'), BUNDLED_BODY);
      assert.equal(modeOf(antigravityHookScriptPath(home)), 0o755);
    });
  });
}

test('empty hooks.json is treated as {} and install succeeds', () => {
  withRoot((root) => {
    const home = makeHome(root);
    mkdirSync(configDirOf(home), { recursive: true });
    writeFileSync(hooksPath(home), ' \n\t\n');

    assert.equal(installAntigravityHooks(makeBundled(root), home), true);

    assert.deepEqual(readHooks(home), { ftown: buildAntigravityHookEntry(antigravityHookScriptPath(home)) });
  });
});

test('an existing hooks.json with mode 0600 keeps mode 0600 after a merge', () => {
  withRoot((root) => {
    const home = makeHome(root);
    mkdirSync(configDirOf(home), { recursive: true });
    writeFileSync(hooksPath(home), '{"mine": 1}\n');
    chmodSync(hooksPath(home), 0o600);

    assert.equal(installAntigravityHooks(makeBundled(root), home), true);

    assert.equal(modeOf(hooksPath(home)), 0o600);
    assert.equal(readHooks(home).mine, 1);
  });
});

test(
  'a read-only (0444) hooks.json is left byte-identical and install returns false',
  { skip: runningAsRoot ? 'W_OK always succeeds as root' : false },
  () => {
    withRoot((root) => {
      const home = makeHome(root);
      mkdirSync(configDirOf(home), { recursive: true });
      writeFileSync(hooksPath(home), '{"mine": 1}\n');
      chmodSync(hooksPath(home), 0o444);
      const before = readFileSync(hooksPath(home));

      assert.equal(installAntigravityHooks(makeBundled(root), home), false);

      assert.deepEqual(readFileSync(hooksPath(home)), before);
      assert.equal(modeOf(hooksPath(home)), 0o444);
    });
  },
);

test('a symlinked hooks.json: the link stays and the target gets the merged content', () => {
  withRoot((root) => {
    const home = makeHome(root);
    mkdirSync(configDirOf(home), { recursive: true });
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    const target = join(elsewhere, 'hooks-target.json');
    writeFileSync(target, JSON.stringify({ mine: 1, other: 2 }));
    symlinkSync(target, hooksPath(home));

    assert.equal(installAntigravityHooks(makeBundled(root), home), true);

    assert.equal(lstatSync(hooksPath(home)).isSymbolicLink(), true);
    const merged = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(merged), ['mine', 'other', 'ftown']);
    assert.deepEqual(merged.ftown, buildAntigravityHookEntry(antigravityHookScriptPath(home)));
    assert.deepEqual(readdirSync(elsewhere), ['hooks-target.json']);
  });
});

test('a dangling hooks.json symlink returns false and the link is untouched', () => {
  withRoot((root) => {
    const home = makeHome(root);
    mkdirSync(configDirOf(home), { recursive: true });
    const missingTarget = join(root, 'nowhere.json');
    symlinkSync(missingTarget, hooksPath(home));

    assert.equal(installAntigravityHooks(makeBundled(root), home), false);

    assert.equal(lstatSync(hooksPath(home)).isSymbolicLink(), true);
    assert.equal(readlinkSync(hooksPath(home)), missingTarget);
    assert.equal(existsSync(missingTarget), false);
  });
});

test('an installed script with different content and mode 0644 is replaced and made 0755', () => {
  withRoot((root) => {
    const home = makeHome(root);
    const script = antigravityHookScriptPath(home);
    writeExecutable(script, '#!/bin/sh\necho stale\n');
    chmodSync(script, 0o644);

    assert.equal(installAntigravityHooks(makeBundled(root), home), true);

    assert.equal(readFileSync(script, 'utf8'), BUNDLED_BODY);
    assert.equal(modeOf(script), 0o755);
  });
});

test('an installed script with identical content but mode 0644 keeps content and gets mode 0755', () => {
  withRoot((root) => {
    const home = makeHome(root);
    const script = antigravityHookScriptPath(home);
    writeExecutable(script, BUNDLED_BODY);
    chmodSync(script, 0o644);

    assert.equal(installAntigravityHooks(makeBundled(root), home), true);

    assert.equal(readFileSync(script, 'utf8'), BUNDLED_BODY);
    assert.equal(modeOf(script), 0o755);
  });
});

test('a read-only 0444 script with different content is replaced atomically and made 0755', () => {
  withRoot((root) => {
    const home = makeHome(root);
    const script = antigravityHookScriptPath(home);
    writeExecutable(script, '#!/bin/sh\necho stale\n');
    chmodSync(script, 0o444);

    assert.equal(installAntigravityHooks(makeBundled(root), home), true);

    assert.equal(readFileSync(script, 'utf8'), BUNDLED_BODY);
    assert.equal(modeOf(script), 0o755);
    assert.deepEqual(readdirSync(join(home, '.ftown')), ['antigravity-hook.sh']);
  });
});

test('hooks.json that is a directory returns false without throwing', () => {
  withRoot((root) => {
    const home = makeHome(root);
    mkdirSync(hooksPath(home), { recursive: true });

    assert.equal(installAntigravityHooks(makeBundled(root), home), false);

    assert.equal(statSync(hooksPath(home)).isDirectory(), true);
    assert.deepEqual(readdirSync(hooksPath(home)), []);
  });
});

test('temp-name collision with a regular file: install returns false and the file is untouched', () => {
  withRoot((root) => {
    const home = makeHome(root);
    mkdirSync(configDirOf(home), { recursive: true });
    const decoy = join(configDirOf(home), 'hooks.json.fixed.tmp');
    writeFileSync(decoy, 'victim');

    setTempNameGeneratorForTests((destination) => `${destination}.fixed.tmp`);
    try {
      assert.equal(installAntigravityHooks(makeBundled(root), home), false);
    } finally {
      setTempNameGeneratorForTests(null);
    }

    assert.equal(readFileSync(decoy, 'utf8'), 'victim');
    assert.equal(existsSync(hooksPath(home)), false);
    assert.deepEqual(readdirSync(configDirOf(home)), ['hooks.json.fixed.tmp']);
  });
});

test('temp-name collision with a symlink: install returns false and the victim is untouched', () => {
  withRoot((root) => {
    const home = makeHome(root);
    mkdirSync(configDirOf(home), { recursive: true });
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'victim');
    const link = join(configDirOf(home), 'hooks.json.fixed.tmp');
    symlinkSync(victim, link);

    setTempNameGeneratorForTests((destination) => `${destination}.fixed.tmp`);
    try {
      assert.equal(installAntigravityHooks(makeBundled(root), home), false);
    } finally {
      setTempNameGeneratorForTests(null);
    }

    assert.equal(readFileSync(victim, 'utf8'), 'victim');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(existsSync(hooksPath(home)), false);
    assert.deepEqual(readdirSync(configDirOf(home)), ['hooks.json.fixed.tmp']);
  });
});

test('antigravityHookCommand: plain path is unquoted and guarded', () => {
  withRoot((root) => {
    const script = join(root, 'plain', 'hook.sh');
    writeExecutable(script, '#!/bin/sh\necho plain-ok\n');

    const command = antigravityHookCommand(script);
    assert.equal(command, `${script} 2>/dev/null || true`);
    assert.equal(runCommand(command), 'plain-ok\n');
  });
});

test('antigravityHookCommand single-quotes a path containing a space', () => {
  withRoot((root) => {
    const script = join(root, 'with space', 'hook.sh');
    writeExecutable(script, '#!/bin/sh\necho space-ok\n');

    const command = antigravityHookCommand(script);
    assert.equal(command, `'${script}' 2>/dev/null || true`);
    assert.equal(runCommand(command), 'space-ok\n');
  });
});

test("antigravityHookCommand escapes a single quote as '\\'' in a path", () => {
  withRoot((root) => {
    const script = join(root, "it's here", 'hook.sh');
    writeExecutable(script, '#!/bin/sh\necho quote-ok\n');

    const command = antigravityHookCommand(script);
    assert.equal(command, `'${script.split("'").join("'\\''")}' 2>/dev/null || true`);
    assert.equal(runCommand(command), 'quote-ok\n');
  });
});

test('guarded command: a missing script exits 0 with no stdout or stderr', () => {
  withRoot((root) => {
    const command = antigravityHookCommand(join(root, 'missing dir', 'hook.sh'));
    assert.deepEqual(runShell(command), { status: 0, stdout: '', stderr: '' });
  });
});

test('guarded command: a present but non-executable script exits 0', () => {
  withRoot((root) => {
    const script = join(root, 'not-exec.sh');
    writeFileSync(script, '#!/bin/sh\necho should-not-run\n');
    chmodSync(script, 0o644);

    const result = runShell(antigravityHookCommand(script));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });
});

test('guarded command: a script printing a line and exiting 3 exits 0 and passes the line through', () => {
  withRoot((root) => {
    const script = join(root, 'exit3.sh');
    writeExecutable(script, '#!/bin/sh\necho hello-line\nexit 3\n');

    assert.deepEqual(runShell(antigravityHookCommand(script)), { status: 0, stdout: 'hello-line\n', stderr: '' });
  });
});

test('guarded command: a Stop decision line passes through unchanged with exit 0', () => {
  withRoot((root) => {
    const script = join(root, 'decision.sh');
    writeExecutable(script, `#!/bin/sh\necho '{"decision":"continue","reason":"x"}'\nexit 0\n`);

    assert.deepEqual(runShell(antigravityHookCommand(script)), {
      status: 0,
      stdout: '{"decision":"continue","reason":"x"}\n',
      stderr: '',
    });
  });
});

test('home path with a space: hooks.json is valid and its command runs the installed script', () => {
  withRoot((root) => {
    const home = makeHome(root, 'my home');
    assert.equal(installAntigravityHooks(makeBundled(root), home), true);

    const hooks = readHooks(home);
    const ftown = hooks.ftown as { SessionStart: Array<{ command: string }> };
    assert.equal(runCommand(ftown.SessionStart[0].command), 'installed-ok\n');
  });
});

test('no leftover temp files after repeated installs', () => {
  withRoot((root) => {
    const home = makeHome(root);
    const bundled = makeBundled(root);
    mkdirSync(configDirOf(home), { recursive: true });
    writeFileSync(hooksPath(home), JSON.stringify({ mine: 1 }));

    assert.equal(installAntigravityHooks(bundled, home), true);
    assert.equal(installAntigravityHooks(bundled, home), true);

    assert.deepEqual(readdirSync(configDirOf(home)), ['hooks.json']);
    assert.deepEqual(readdirSync(join(home, '.ftown')), ['antigravity-hook.sh']);
    assert.equal(existsSync(hooksPath(home)), true);
  });
});
