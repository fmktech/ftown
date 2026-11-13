import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGrokHooksConfig,
  grokHookScriptPath,
  installGrokHooks,
} from './grok-hook-installer.js';

const EXPECTED_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'];
const SCRIPT_BODY = '#!/bin/sh\necho ftown-grok-hook\n';

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeHome(prefix = 'ftown-grok-home-'): string {
  return tempDir(prefix);
}

function makeBundle(body: string = SCRIPT_BODY): string {
  const dir = tempDir('ftown-grok-bundle-');
  const path = join(dir, 'ftown-grok-hook.sh');
  writeFileSync(path, body);
  return path;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('installGrokHooks', () => {
  it('returns false and creates nothing when ~/.grok does not exist', () => {
    const home = makeHome();
    const bundle = makeBundle();

    assert.equal(installGrokHooks(bundle, home), false);
    assert.deepEqual(readdirSync(home), []);
  });

  it('returns false and writes nothing when the bundled script is missing', (t) => {
    const home = makeHome();
    mkdirSync(join(home, '.grok'));
    const errorMock = t.mock.method(console, 'error', () => {});

    const result = installGrokHooks(join(home, 'does-not-exist.sh'), home);

    assert.equal(result, false);
    assert.equal(errorMock.mock.callCount(), 1);
    assert.equal(existsSync(join(home, '.ftown')), false);
    assert.equal(existsSync(join(home, '.grok', 'hooks')), false);
  });

  it('fresh install copies the script with mode 0755 and writes ftown.json', () => {
    const home = makeHome();
    mkdirSync(join(home, '.grok'));
    const bundle = makeBundle();

    assert.equal(installGrokHooks(bundle, home), true);

    const scriptPath = grokHookScriptPath(home);
    assert.equal(scriptPath, join(home, '.ftown', 'grok-hook.sh'));
    assert.equal(readFileSync(scriptPath, 'utf8'), SCRIPT_BODY);
    assert.equal(mode(scriptPath), 0o755);

    const configPath = join(home, '.grok', 'hooks', 'ftown.json');
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    assert.deepEqual(parsed, buildGrokHooksConfig(grokHookScriptPath(home)));
    assert.equal(raw, JSON.stringify(parsed, null, 2) + '\n');
  });

  it('registers exactly the six events in order, each a command with the absolute script path and timeout 10', () => {
    const home = makeHome();
    mkdirSync(join(home, '.grok'));
    assert.equal(installGrokHooks(makeBundle(), home), true);

    const parsed = JSON.parse(
      readFileSync(join(home, '.grok', 'hooks', 'ftown.json'), 'utf8'),
    ) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };

    assert.deepEqual(Object.keys(parsed.hooks), EXPECTED_EVENTS);
    for (const event of EXPECTED_EVENTS) {
      const groups = parsed.hooks[event];
      assert.equal(groups.length, 1, `${event} has one group`);
      assert.deepEqual(Object.keys(groups[0]), ['hooks'], `${event} group has no matcher`);
      assert.equal(groups[0].hooks.length, 1, `${event} has one hook`);
      assert.deepEqual(groups[0].hooks[0], {
        type: 'command',
        command: grokHookScriptPath(home),
        args: [],
        timeout: 10,
      });
    }
  });

  it('a second call is idempotent: returns true and does not rewrite ftown.json', () => {
    const home = makeHome();
    mkdirSync(join(home, '.grok'));
    const bundle = makeBundle();
    assert.equal(installGrokHooks(bundle, home), true);

    const configPath = join(home, '.grok', 'hooks', 'ftown.json');
    const before = statSync(configPath);

    assert.equal(installGrokHooks(bundle, home), true);

    const afterStat = statSync(configPath);
    assert.equal(afterStat.ino, before.ino);
    assert.equal(afterStat.mtimeMs, before.mtimeMs);
  });

  it('replaces a stale ftown.json with different content', () => {
    const home = makeHome();
    const hooksDir = join(home, '.grok', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const configPath = join(hooksDir, 'ftown.json');
    writeFileSync(configPath, '{"hooks":{"Stop":[]}}\n');

    assert.equal(installGrokHooks(makeBundle(), home), true);

    assert.deepEqual(
      JSON.parse(readFileSync(configPath, 'utf8')),
      buildGrokHooksConfig(grokHookScriptPath(home)),
    );
  });

  it('leaves other files under ~/.grok/hooks byte-identical', () => {
    const home = makeHome();
    const hooksDir = join(home, '.grok', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const userBytes = Buffer.from('{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/usr/bin/true"}]}]}}\n');
    writeFileSync(join(hooksDir, 'user.json'), userBytes);

    assert.equal(installGrokHooks(makeBundle(), home), true);

    assert.deepEqual(readFileSync(join(hooksDir, 'user.json')), userBytes);
  });

  it('replaces an installed script with different content and mode 0644 and makes it 0755', () => {
    const home = makeHome();
    mkdirSync(join(home, '.grok'));
    mkdirSync(join(home, '.ftown'));
    const scriptPath = grokHookScriptPath(home);
    writeFileSync(scriptPath, 'old script\n');
    chmodSync(scriptPath, 0o644);
    assert.equal(mode(scriptPath), 0o644);

    assert.equal(installGrokHooks(makeBundle(), home), true);

    assert.equal(readFileSync(scriptPath, 'utf8'), SCRIPT_BODY);
    assert.equal(mode(scriptPath), 0o755);
  });

  it('fixes the mode of an identical installed script without rewriting its content', () => {
    const home = makeHome();
    mkdirSync(join(home, '.grok'));
    mkdirSync(join(home, '.ftown'));
    const scriptPath = grokHookScriptPath(home);
    writeFileSync(scriptPath, SCRIPT_BODY);
    chmodSync(scriptPath, 0o644);

    assert.equal(installGrokHooks(makeBundle(), home), true);

    assert.equal(readFileSync(scriptPath, 'utf8'), SCRIPT_BODY);
    assert.equal(mode(scriptPath), 0o755);
  });

  it('works when the home directory path contains a space', () => {
    const home = makeHome('ftown grok home ');
    mkdirSync(join(home, '.grok'));
    assert.ok(home.includes(' '));

    assert.equal(installGrokHooks(makeBundle(), home), true);

    // The command stays the raw, unquoted path; `args: []` stops Grok from running it through a shell.
    const parsed = JSON.parse(readFileSync(join(home, '.grok', 'hooks', 'ftown.json'), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; args: unknown }> }>>;
    };
    assert.equal(parsed.hooks.Stop[0].hooks[0].command, join(home, '.ftown', 'grok-hook.sh'));
    assert.deepEqual(parsed.hooks.Stop[0].hooks[0].args, []);
    assert.equal(readFileSync(join(home, '.ftown', 'grok-hook.sh'), 'utf8'), SCRIPT_BODY);
  });

  it('leaves no temp files in ~/.grok/hooks or ~/.ftown after install', () => {
    const home = makeHome();
    mkdirSync(join(home, '.grok'));
    assert.equal(installGrokHooks(makeBundle(), home), true);
    assert.equal(installGrokHooks(makeBundle(), home), true);

    assert.deepEqual(readdirSync(join(home, '.grok', 'hooks')), ['ftown.json']);
    assert.deepEqual(readdirSync(join(home, '.ftown')), ['grok-hook.sh']);
  });

  it('treats ~/.grok as absent when it is a regular file, creating nothing', () => {
    const home = makeHome();
    writeFileSync(join(home, '.grok'), 'not a directory');

    assert.equal(installGrokHooks(makeBundle(), home), false);
    assert.deepEqual(readdirSync(home), ['.grok']);
    assert.equal(existsSync(join(home, '.ftown')), false);
  });

  it('ignores a pre-existing ftown.json.tmp regular file and still installs', () => {
    const home = makeHome();
    const hooksDir = join(home, '.grok', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'ftown.json.tmp'), 'stale leftover\n');

    assert.equal(installGrokHooks(makeBundle(), home), true);

    assert.equal(readFileSync(join(hooksDir, 'ftown.json.tmp'), 'utf8'), 'stale leftover\n');
    assert.deepEqual(
      JSON.parse(readFileSync(join(hooksDir, 'ftown.json'), 'utf8')),
      buildGrokHooksConfig(grokHookScriptPath(home)),
    );
    assert.deepEqual(readdirSync(hooksDir).sort(), ['ftown.json', 'ftown.json.tmp']);
  });

  it('never follows a pre-existing symlink at ftown.json.tmp', () => {
    const home = makeHome();
    const victimDir = tempDir('ftown-grok-victim-');
    const victim = join(victimDir, 'victim.txt');
    writeFileSync(victim, 'do not touch\n');
    const hooksDir = join(home, '.grok', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    symlinkSync(victim, join(hooksDir, 'ftown.json.tmp'));

    assert.equal(installGrokHooks(makeBundle(), home), true);

    assert.equal(readFileSync(victim, 'utf8'), 'do not touch\n');
    assert.equal(lstatSync(join(hooksDir, 'ftown.json.tmp')).isSymbolicLink(), true);
    assert.deepEqual(
      JSON.parse(readFileSync(join(hooksDir, 'ftown.json'), 'utf8')),
      buildGrokHooksConfig(grokHookScriptPath(home)),
    );
  });

  it('returns false instead of throwing when a filesystem operation fails', (t) => {
    const home = makeHome();
    mkdirSync(join(home, '.grok'));
    // A regular file where the hooks directory must be created makes mkdirSync fail.
    writeFileSync(join(home, '.grok', 'hooks'), 'not a directory');
    const errorMock = t.mock.method(console, 'error', () => {});

    assert.equal(installGrokHooks(makeBundle(), home), false);
    assert.equal(errorMock.mock.callCount(), 1);
  });
});

describe('buildGrokHooksConfig', () => {
  it('embeds the script path verbatim, including spaces', () => {
    const config = buildGrokHooksConfig('/Users/a b/.ftown/grok-hook.sh') as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; args: unknown }> }>>;
    };
    assert.equal(config.hooks.SessionEnd[0].hooks[0].command, '/Users/a b/.ftown/grok-hook.sh');
    assert.deepEqual(config.hooks.SessionEnd[0].hooks[0].args, []);
  });
});
