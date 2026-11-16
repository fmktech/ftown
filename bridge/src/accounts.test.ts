import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { accountEnv, loadAccounts, saveAccounts, validateAccount } from './accounts.js';

test('account registry validates, atomically persists mode 0600, and resolves launch environment', () => {
  const home = mkdtempSync(join(tmpdir(), 'ftown-accounts-'));
  try {
    const account = { id: 'claude-work', harness: 'claude' as const, label: 'Work', configDir: join(home, 'claude-work') };
    saveAccounts({ version: 1, accounts: [account] }, home);
    assert.deepEqual(loadAccounts(home), { version: 1, accounts: [account] });
    assert.equal(statSync(join(home, '.ftown', 'accounts.json')).mode & 0o777, 0o600);
    assert.deepEqual(accountEnv(account), { CLAUDE_CONFIG_DIR: account.configDir });
    assert.deepEqual(accountEnv({ id: 'codex-lab', harness: 'codex', configDir: join(home, 'codex-lab') }), { CODEX_HOME: join(home, 'codex-lab') });
    assert.throws(() => validateAccount({ id: 'default', harness: 'claude', configDir: '/tmp/work' }), /reserved/);
    assert.throws(() => validateAccount({ id: 'bad', harness: 'claude', configDir: '~/work' }), /absolute/);
    assert.equal(JSON.parse(readFileSync(join(home, '.ftown', 'accounts.json'), 'utf8')).version, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
