#!/usr/bin/env node
import { runSessions } from './sessions-commands.js';
import { runHarness } from './harness-commands.js';
import { runEnv } from './env-commands.js';
import { runSetup } from './setup.js';
import { runStart } from './start-commands.js';
import { runSecurity } from './security-cli.js';
import { runQuotaCli } from './quota-cli.js';
import { runBoard, runEvents, runStatus } from './coordination-cli.js';
import { runAttention } from './attention-cli.js';
import { runBrief } from './brief-cli.js';
import { runWorktrees } from './worktrees-cli.js';
import { runPlan } from './plan-cli.js';
import { executeCli, isCliEntry } from './cli-entry.js';
export { isCliEntry } from './cli-entry.js';

export function usage(): string {
  return `Usage: ftown [bridge options]
       ftown <setup|start|sessions|harness|env|security|quota|status|board|events|attention|brief|worktrees|plan> [args...]

With no subcommand, start the bridge. Run setup explicitly before the first start.

Subcommands:
  setup      Install or upgrade local CLI, hooks, plugins and skill (--repair to recheck)
  start      Start the bridge (--solo for a single-port LAN deployment)
  sessions   List, create, read and drive ftown agent sessions
  harness    Inspect and drive the local ftown-bridge harness
  security   Pair browsers and inspect/revoke encrypted endpoints
  env        Manage per-provider machine tokens (~/.ftown/env.json)
  quota      Subscription quota left, routing advice and model lists per harness (--json for agents)
  status     Own status card: show, set or clear
  board      Child-session board for this session's tree
  events     Tree event log for this session's tree
  attention  Answer or escalate questions routed from child sessions
  brief      Manager brief for a session (show, set, note)
  worktrees  List or prune bridge-owned git worktrees
  plan       Manager plan list (add, start, done, drop, todo, edit, rm)`;
}

export async function runFtown(argv: string[], start: (argv: string[]) => Promise<number> = runStart): Promise<number> {
  const [group, ...args] = argv;
  if (['--help', '-h', 'help'].includes(group)) { console.log(usage()); return 0; }
  if (!group || group.startsWith('-')) return start(argv);
  switch (group) {
    case 'sessions': return runSessions(args);
    case 'harness': return runHarness(args);
    case 'env': return runEnv(args);
    case 'security': return runSecurity(args);
    case 'quota': return runQuotaCli(args);
    case 'status': return runStatus(args);
    case 'board': return runBoard(args);
    case 'events': return runEvents(args);
    case 'attention': return runAttention(args);
    case 'brief': return runBrief(args);
    case 'worktrees': return runWorktrees(args);
    case 'plan': return runPlan(args);
    case 'setup': return runSetup(args);
    case 'start': return start(args);
    default: console.error(`ftown: Unknown subcommand "${group}"`); console.error(usage()); return 1;
  }
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  void executeCli(() => runFtown(process.argv.slice(2)));
}
