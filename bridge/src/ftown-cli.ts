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
import { runAccounts } from './accounts-cli.js';
import { executeCli, isCliEntry } from './cli-entry.js';
import { setPeerTarget } from './cli-client.js';
import { runInstructions } from './instructions-cli.js';
import { runProjectCommands } from './project-cli.js';
import { runTransfer } from './transfer-cli.js';
import { PEER_GROUPS, extractBridgeOption, runBridges } from './peers-cli.js';
export { isCliEntry } from './cli-entry.js';

export function usage(): string {
  return `Usage: ftown [bridge options]
       ftown <setup|start|sessions|harness|env|accounts|security|quota|status|board|events|attention|brief|worktrees|plan|bridges|transfer|instructions|projects|boards|tickets|discuss> [args...]

With no subcommand, start the bridge. Run setup explicitly before the first start.
Add --bridge <name|id> (or set FTOWN_BRIDGE) to run sessions, status, board, events, attention, brief,
worktrees, plan, projects, boards, tickets or discuss commands on another bridge of your account.

Subcommands:
  setup      Install or upgrade local CLI, hooks, plugins and skill (--repair to recheck)
  start      Start the bridge (--solo for a single-port LAN deployment)
  sessions   List, create, read and drive ftown agent sessions
  harness    Inspect and drive the local ftown-bridge harness
  security   Pair browsers and inspect/revoke encrypted endpoints
  env        Manage per-provider machine tokens (~/.ftown/env.json)
  accounts   Manage registered Claude and Codex accounts
  quota      Subscription quota left, routing advice and model lists per harness (--json for agents)
  status     Own status card: show, set or clear
  board      Child-session board for this session's tree
  discuss     Manage project channels, threads and session notifications
  boards      Manage project boards and columns
  projects    List and manage hosted projects
  tickets      Manage project tickets, subtasks, comments, worker links and bridge messages
  events     Tree event log for this session's tree
  attention  Answer or escalate questions routed from child sessions
  brief      Manager brief for a session (show, set, note)
  worktrees  List or prune bridge-owned git worktrees
  plan       Manager plan list (add, start, done, drop, todo, edit, rm)
  bridges    List the other bridges of this account (--probe to check which answer)
  instructions  Read bridge guidance or sync shared global instructions
  transfer   Copy a folder once between paired bridges`;
}

export async function runFtown(argv: string[], start: (argv: string[]) => Promise<number> = runStart): Promise<number> {
  const [group, ...rawArgs] = argv;
  if (['--help', '-h', 'help'].includes(group)) { console.log(usage()); return 0; }
  if (!group || group.startsWith('-')) return start(argv);
  if (group === 'instructions') return runInstructions(rawArgs);
  if (group === 'transfer') return runTransfer(rawArgs);
  let args = rawArgs;
  // Cross-bridge control: --bridge <target> (or FTOWN_BRIDGE) forwards this command's requests to another bridge of the account.
  if (group !== 'start' && group !== 'setup') {
    let extracted: { args: string[]; target: string | null };
    try { extracted = extractBridgeOption(rawArgs); }
    catch (error) { console.error(`ftown: ${error instanceof Error ? error.message : String(error)}`); return 1; }
    args = extracted.args;
    const target = extracted.target ?? (process.env.FTOWN_BRIDGE?.trim() || null);
    if (target !== null && extracted.target !== null && !PEER_GROUPS.has(group)) {
      console.error(`ftown: --bridge is not supported for "${group}" (supported: ${[...PEER_GROUPS].join(', ')})`);
      return 1;
    }
    // FTOWN_BRIDGE applies only where forwarding is supported; local-only groups ignore it.
    setPeerTarget(PEER_GROUPS.has(group) ? target : null);
  }
  switch (group) {
    case 'discuss':
    case 'boards':
    case 'projects':
    case 'tickets': return runProjectCommands(group, args);
    case 'bridges': return runBridges(args);
    case 'sessions': return runSessions(args);
    case 'harness': return runHarness(args);
    case 'env': return runEnv(args);
    case 'accounts': return runAccounts(args);
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
