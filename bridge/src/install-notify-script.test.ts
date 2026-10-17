import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalNotifyPath, installNotifyScript } from './install-notify-script.js';

test('notification integration resolves HOME when setup runs, not when imported', () => {
  const previous = process.env.HOME; const home = mkdtempSync(join(tmpdir(), 'ftown-notify-')); process.env.HOME = home;
  try {
    const source = join(home, 'notify-source'); writeFileSync(source, '#!/bin/sh\nexit 0\n');
    assert.equal(installNotifyScript(source), join(home, '.ftown/notify.sh'));
    assert.equal(canonicalNotifyPath(), join(home, '.ftown/notify.sh'));
    assert.equal(readFileSync(canonicalNotifyPath(), 'utf8'), '#!/bin/sh\nexit 0\n');
  } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; rmSync(home, { recursive: true, force: true }); }
});
