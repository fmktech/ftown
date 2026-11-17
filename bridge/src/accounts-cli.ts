import { Command } from 'commander';
import { loadAccounts, saveAccounts, type AccountHarness, type HarnessAccount } from './accounts.js';
import { setupAccount } from './setup.js';

export async function runAccounts(argv: string[], setup: typeof setupAccount = setupAccount): Promise<number> {
  const program = new Command().name('ftown accounts').exitOverride();
  program.configureOutput({ writeOut: value => console.log(value.trimEnd()), writeErr: value => console.error(value.trimEnd()) });
  program.command('list').option('--json').action((opts: { json?: boolean }) => {
    const accounts = loadAccounts().accounts;
    if (opts.json) console.log(JSON.stringify({ version: 1, accounts }, null, 2));
    else console.log(accounts.length ? accounts.map(a => `${a.id}\t${a.harness}\t${a.label ?? ''}\t${a.configDir}`).join('\n') : '(no registered accounts)');
  });
  program.command('add <id>').requiredOption('--harness <harness>').requiredOption('--config-dir <path>').option('--label <label>').option('--no-setup', 'skip account setup')
    .action(async (id: string, opts: { harness: AccountHarness; configDir: string; label?: string; setup?: boolean }) => {
      const data = loadAccounts();
      if (data.accounts.some(a => a.id === id)) throw new Error(`Account ${id} already exists`);
      const account: HarnessAccount = { id, harness: opts.harness, configDir: opts.configDir, ...(opts.label ? { label: opts.label } : {}) };
      data.accounts.push(account); saveAccounts(data); console.log(`Added account ${id}`);
      if (opts.setup !== false) {
        try {
          for (const result of await setup(account)) console.log(`  ${result.name}: ${result.status}${result.detail ? ` (${result.detail})` : ''}`);
        } catch (error) {
          throw new Error(`Account ${id} was saved, but setup failed: ${error instanceof Error ? error.message : String(error)}. Run ftown setup to retry.`);
        }
      }
    });
  program.command('remove <id>').action((id: string) => {
    const data = loadAccounts(); const next = data.accounts.filter(a => a.id !== id);
    if (next.length === data.accounts.length) throw new Error(`Unknown account ${id}`);
    data.accounts = next; saveAccounts(data); console.log(`Removed account ${id}`);
  });
  try { await program.parseAsync(argv, { from: 'user' }); return 0; }
  catch (error) { console.error(`ftown accounts: ${error instanceof Error ? error.message : String(error)}`); return 1; }
}
