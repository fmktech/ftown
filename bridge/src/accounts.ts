import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export type AccountHarness = 'claude' | 'codex';
export interface HarnessAccount { id: string; harness: AccountHarness; label?: string; configDir: string }
export interface AccountsFile { version: 1; accounts: HarnessAccount[] }
const ID = /^[a-z0-9-]{1,32}$/;

export function validateAccount(account: HarnessAccount): HarnessAccount {
  if (!account || !ID.test(account.id) || account.id === 'default') throw new Error('Account id must match [a-z0-9-]{1,32}; default is reserved');
  if (account.harness !== 'claude' && account.harness !== 'codex') throw new Error('harness must be claude or codex');
  if (typeof account.configDir !== 'string' || !isAbsolute(account.configDir) || account.configDir.startsWith('~') || account.configDir !== account.configDir.normalize('NFC') || account.configDir.endsWith('/') || account.configDir.endsWith('\\')) throw new Error('configDir must be an absolute NFC path without a trailing slash or ~');
  if (account.label !== undefined && typeof account.label !== 'string') throw new Error('label must be a string');
  return account;
}

export function accountsPath(home = homedir()): string { return join(home, '.ftown', 'accounts.json'); }
export function loadAccounts(home = homedir()): AccountsFile {
  try {
    const data = JSON.parse(readFileSync(accountsPath(home), 'utf8')) as AccountsFile;
    if (data.version !== 1 || !Array.isArray(data.accounts)) throw new Error('Invalid accounts registry');
    const accounts = data.accounts.map(validateAccount);
    if (new Set(accounts.map(a => a.id)).size !== accounts.length) throw new Error('Duplicate account id');
    return { version: 1, accounts };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, accounts: [] };
    throw error;
  }
}
export function saveAccounts(file: AccountsFile, home = homedir()): void {
  if (file.version !== 1 || !Array.isArray(file.accounts)) throw new Error('Invalid accounts registry');
  const accounts = file.accounts.map(validateAccount);
  if (new Set(accounts.map(a => a.id)).size !== accounts.length) throw new Error('Duplicate account id');
  const path = accountsPath(home); mkdirSync(join(home, '.ftown'), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600); renameSync(temp, path);
}
export function accountEnv(account: HarnessAccount): Record<string, string> {
  validateAccount(account);
  return account.harness === 'claude' ? { CLAUDE_CONFIG_DIR: account.configDir } : { CODEX_HOME: account.configDir };
}
