import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AccountHarness = 'claude' | 'codex';

export interface HarnessAccount {
  id: string;
  harness: AccountHarness;
  label?: string;
  configDir: string;
}

export interface AccountsFile {
  version: 1;
  accounts: HarnessAccount[];
}

export function accountEnv(a: HarnessAccount): Record<string, string> {
  return a.harness === 'claude' ? { CLAUDE_CONFIG_DIR: a.configDir } : { CODEX_HOME: a.configDir };
}

export async function loadAccounts(home: string = homedir()): Promise<AccountsFile> {
  try {
    const value: unknown = JSON.parse(await readFile(join(home, '.ftown', 'accounts.json'), 'utf8'));
    if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1 || !('accounts' in value) || !Array.isArray(value.accounts)) {
      return { version: 1, accounts: [] };
    }
    return value as AccountsFile;
  } catch {
    return { version: 1, accounts: [] };
  }
}
