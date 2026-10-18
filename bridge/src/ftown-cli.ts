#!/usr/bin/env node
import { runSessions } from './sessions-commands.js';
import { runHarness } from './harness-commands.js';
import { runEnv } from './env-commands.js';
import { runSetup } from './setup.js';
import { runStart } from './start-commands.js';
import { executeCli, isCliEntry } from './cli-entry.js';
export { isCliEntry } from './cli-entry.js';

export function usage(): string {
  return `Usage: ftown [bridge options]
       ftown <setup|start|sessions|harness|env> [args...]

With no subcommand, start the bridge. Run setup explicitly before the first start.

Subcommands:
  setup      Install or upgrade local CLI, hooks, plugins and skill (--repair to recheck)
  start      Start the bridge (--solo for a single-port LAN deployment)
  sessions   List, create, read and drive ftown agent sessions
  harness    Inspect and drive the local ftown-bridge harness
  env        Manage per-provider machine tokens (~/.ftown/env.json)`;
}

export async function runFtown(argv: string[], start: (argv: string[]) => Promise<number> = runStart): Promise<number> {
  const [group, ...args] = argv;
  if (['--help', '-h', 'help'].includes(group)) { console.log(usage()); return 0; }
  if (!group || group.startsWith('-')) return start(argv);
  switch (group) {
    case 'sessions': return runSessions(args);
    case 'harness': return runHarness(args);
    case 'env': return runEnv(args);
    case 'setup': return runSetup(args);
    case 'start': return start(args);
    default: console.error(`ftown: Unknown subcommand "${group}"`); console.error(usage()); return 1;
  }
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  void executeCli(() => runFtown(process.argv.slice(2)));
}
