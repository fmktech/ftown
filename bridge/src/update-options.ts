import type { Command } from 'commander';

export function configureUpdateOptions(program: Command): Command {
  return program
    .option('--allow-updates', 'Allow explicit updates for this unsupervised single-bridge installation', true)
    .option('--no-allow-updates', 'Disable assisted updates');
}
