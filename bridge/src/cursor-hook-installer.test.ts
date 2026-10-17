import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { installCursorHooks } from './cursor-hook-installer.js';

test('setup reports invalid user settings as failure without replacing them', () => {
  const previous = process.env.HOME; const home = mkdtempSync(join(tmpdir(), 'ftown-hooks-')); process.env.HOME = home;
  try {
    const path = join(home, '.cursor/hooks.json'); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '{invalid');
    assert.equal(installCursorHooks('/tmp/notify.sh'), false);
    assert.equal(readFileSync(path, 'utf8'), '{invalid');
    writeFileSync(path, '{"custom":"keep"}');
    assert.equal(installCursorHooks('/tmp/notify.sh'), true);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).custom, 'keep');
  } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; rmSync(home, { recursive: true, force: true }); }
});
