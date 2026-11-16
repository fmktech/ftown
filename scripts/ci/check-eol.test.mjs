import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function git(dir, args) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: join(dir, '.xdg') },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function fixture(t, { attributes = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-check-eol-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts/ci'), { recursive: true });
  copyFileSync(join(root, 'scripts/ci/check-eol.sh'), join(dir, 'scripts/ci/check-eol.sh'));
  if (attributes) copyFileSync(join(root, '.gitattributes'), join(dir, '.gitattributes'));
  git(dir, ['init', '-q']);
  return dir;
}

function write(dir, path, body) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), body);
}

function commitAll(dir, message) {
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', message]);
}

function runCheck(dir) {
  return spawnSync('bash', ['scripts/ci/check-eol.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: join(dir, '.xdg') },
    timeout: 10_000,
  });
}

test('accepts LF shell and hook assets covered by the shipped attributes', t => {
  const dir = fixture(t);
  for (const [path, body] of [
    ['bridge/hooks/notify.sh', '#!/bin/sh\nexit 0\n'],
    ['bridge/muse-plugin/hooks/ftown-stop.sh', '#!/bin/sh\nexit 0\n'],
    ['.githooks/pre-commit', '#!/bin/sh\nexit 0\n'],
    ['bridge/claude-mod/hooks/register.js', "console.log('hook');\n"],
    ['bridge/opencode-plugin/ftown.js', "console.log('plugin');\n"],
  ]) write(dir, path, body);
  commitAll(dir, 'lf assets');

  const result = runCheck(dir);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /line endings ok: 6 shell\/hook assets are LF/);
});

test('rejects a CRLF shell script stored in the index', t => {
  const dir = fixture(t, { attributes: false });
  write(dir, 'bridge/hooks/notify.sh', '#!/bin/sh\r\nexit 0\r\n');
  commitAll(dir, 'crlf asset');
  copyFileSync(join(root, '.gitattributes'), join(dir, '.gitattributes'));

  const result = runCheck(dir);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not LF: .*bridge\/hooks\/notify\.sh/);
  assert.match(result.stderr, /must be committed and checked out with LF/);
});

test('rejects a shell script without the LF attribute rule', t => {
  const dir = fixture(t, { attributes: false });
  write(dir, 'hook.sh', '#!/bin/sh\nexit 0\n');
  commitAll(dir, 'no attributes');

  const result = runCheck(dir);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing "text eol=lf" attribute: hook\.sh \(text=unspecified eol=unspecified\)/);
});

test('ignores CRLF files outside the shell and hook asset set', t => {
  const dir = fixture(t);
  write(dir, 'bridge/hooks/notify.sh', '#!/bin/sh\nexit 0\n');
  write(dir, 'notes.txt', 'a\r\nb\r\n');
  commitAll(dir, 'unrelated crlf');

  const result = runCheck(dir);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /notes\.txt/);
});
