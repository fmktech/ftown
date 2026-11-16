import { Command } from 'commander';
import { loadAccounts, saveAccounts, type AccountHarness, type HarnessAccount } from './accounts.js';

export async function runAccounts(argv: string[]): Promise<number> {
  const program = new Command().name('ftown accounts').exitOverride();
  program.configureOutput({ writeOut: value => console.log(value.trimEnd()), writeErr: value => console.error(value.trimEnd()) });
  program.command('list').option('--json').action((opts: { json?: boolean }) => {
    const accounts = loadAccounts().accounts;
    if (opts.json) console.log(JSON.stringify({ version: 1, accounts }, null, 2));
    else console.log(accounts.length ? accounts.map(a => `${a.id}\t${a.harness}\t${a.label ?? ''}\t${a.configDir}`).join('\n') : '(no registered accounts)');
  });
  program.command('add <id>').requiredOption('--harness <harness>').requiredOption('--config-dir <path>').option('--label <label>')
    .action((id: string, opts: { harness: AccountHarness; configDir: string; label?: string }) => {
      const data = loadAccounts();
      if (data.accounts.some(a => a.id === id)) throw new Error(`Account ${id} already exists`);
      const account: HarnessAccount = { id, harness: opts.harness, configDir: opts.configDir, ...(opts.label ? { label: opts.label } : {}) };
      data.accounts.push(account); saveAccounts(data); console.log(`Added account ${id}`);
    });
  program.command('remove <id>').action((id: string) => {
    const data = loadAccounts(); const next = data.accounts.filter(a => a.id !== id);
    if (next.length === data.accounts.length) throw new Error(`Unknown account ${id}`);
    data.accounts = next; saveAccounts(data); console.log(`Removed account ${id}`);
  });
  try { await program.parseAsync(argv, { from: 'user' }); return 0; }
  catch (error) { console.error(`ftown accounts: ${error instanceof Error ? error.message : String(error)}`); return 1; }
}
