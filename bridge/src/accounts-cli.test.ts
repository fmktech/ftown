import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
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
    assert.equal(await runAccounts(['add', 'work', '--harness', 'claude', '--config-dir', configDir, '--label', 'Work', '--no-setup']), 0);
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


test('account add sets up only the saved account and preserves it after a failure', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ftown-account-add-'));
  const priorHome = process.env.HOME; const priorLog = console.log; const priorError = console.error;
  const errors: string[] = []; const calls: string[] = [];
  process.env.HOME = home; console.log = () => {}; console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    const configDir = join(home, 'account');
    const setup = async (account: { id: string }) => { calls.push(account.id); throw new Error('broken hooks'); };
    assert.equal(await runAccounts(['add', 'work', '--harness', 'claude', '--config-dir', configDir], setup), 1);
    assert.deepEqual(calls, ['work']);
    assert.equal(JSON.parse(readFileSync(join(home, '.ftown', 'accounts.json'), 'utf8')).accounts[0].id, 'work');
    assert.match(errors.join(' '), /saved.*broken hooks.*ftown setup/);
    assert.equal(await runAccounts(['add', 'other', '--harness', 'codex', '--config-dir', join(home, 'other'), '--no-setup'], setup), 0);
    assert.deepEqual(calls, ['work']);
  } finally {
    console.log = priorLog; console.error = priorError;
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  }
});


test('account setup installs hooks and a skill link in only the selected configuration', async () => {
  const { setupAccount } = await import('./setup.js');
  const home = mkdtempSync(join(tmpdir(), 'ftown-account-scope-'));
  const priorHome = process.env.HOME; const priorClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home; delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const selected = join(home, 'selected'); const other = join(home, 'other');
    mkdirSync(join(home, '.ftown', 'skills', 'ftown'), { recursive: true });
    writeFileSync(join(home, '.ftown', 'skills', 'ftown', 'SKILL.md'), 'test');
    writeFileSync(join(home, '.ftown', 'notify.sh'), 'test');
    mkdirSync(other); writeFileSync(join(other, 'settings.json'), '{"untouched":true}');
    const results = await setupAccount({ id: 'selected', harness: 'claude', configDir: selected });
    assert.deepEqual(results.map(result => result.name), ['claude', 'skill']);
    assert.ok(JSON.parse(readFileSync(join(selected, 'settings.json'), 'utf8')).hooks);
    assert.ok(readlinkSync(join(selected, 'skills', 'ftown')));
    assert.equal(readFileSync(join(other, 'settings.json'), 'utf8'), '{"untouched":true}');
    assert.equal(existsSync(join(home, '.claude')), false);
    assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorClaude;
    rmSync(home, { recursive: true, force: true });
  }
});

test('account setup reports a blocked skill link as failure', async () => {
  const { setupAccount } = await import('./setup.js');
  const home = mkdtempSync(join(tmpdir(), 'ftown-account-blocked-'));
  const priorHome = process.env.HOME; const priorClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home; delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const selected = join(home, 'selected');
    mkdirSync(join(home, '.ftown', 'skills', 'ftown'), { recursive: true });
    writeFileSync(join(home, '.ftown', 'skills', 'ftown', 'SKILL.md'), 'test');
    writeFileSync(join(home, '.ftown', 'notify.sh'), 'test');
    mkdirSync(join(selected, 'skills'), { recursive: true });
    writeFileSync(join(selected, 'skills', 'ftown'), 'user data');
    await assert.rejects(setupAccount({ id: 'selected', harness: 'claude', configDir: selected }), /Could not link ftown skill/);
    assert.equal(readFileSync(join(selected, 'skills', 'ftown'), 'utf8'), 'user data');
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorClaude;
    rmSync(home, { recursive: true, force: true });
  }
});
