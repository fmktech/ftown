import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAccounts } from './accounts-cli.js';

test('accounts CLI lists, adds, removes and rejects a malformed registry', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ftown-accounts-cli-'));
  const priorHome = process.env.HOME;
  const priorLog = console.log; const priorError = console.error;
  const out: string[] = []; const errors: string[] = [];
  process.env.HOME = home;
  console.log = (...args: unknown[]) => { out.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    assert.equal(await runAccounts(['list', '--json']), 0);
    assert.deepEqual(JSON.parse(out.pop()!), { version: 1, accounts: [] });
    const configDir = join(home, 'claude-work');
    assert.equal(await runAccounts(['add', 'work', '--harness', 'claude', '--config-dir', configDir, '--label', 'Work']), 0);
    assert.equal(await runAccounts(['list', '--json']), 0);
    assert.deepEqual(JSON.parse(out.pop()!), { version: 1, accounts: [{ id: 'work', harness: 'claude', configDir, label: 'Work' }] });
    assert.equal(await runAccounts(['remove', 'work']), 0);
    assert.equal(await runAccounts(['list', '--json']), 0);
    assert.deepEqual(JSON.parse(out.pop()!), { version: 1, accounts: [] });
    assert.equal(await runAccounts(['remove', 'work']), 1);
    assert.match(errors.pop()!, /Unknown account work/);
    const path = join(home, '.ftown', 'accounts.json');
    writeFileSync(path, '{broken json');
    assert.equal(await runAccounts(['list', '--json']), 1);
    assert.match(errors.pop()!, /ftown accounts:/);
    assert.equal(await runAccounts(['add', 'other', '--harness', 'codex', '--config-dir', join(home, 'codex')]), 1);
    assert.equal(readFileSync(path, 'utf8'), '{broken json');
  } finally {
    console.log = priorLog; console.error = priorError;
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  }
});
