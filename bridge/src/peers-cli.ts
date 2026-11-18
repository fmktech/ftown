import { apiResponse, loadPointer } from './cli-client.js';

/** Command groups whose requests may be forwarded to another bridge with --bridge / FTOWN_BRIDGE. */
export const PEER_GROUPS: ReadonlySet<string> = new Set(['sessions', 'status', 'board', 'events', 'attention', 'brief', 'worktrees', 'plan']);

/**
 * Removes the global `--bridge <target>` / `--bridge=<target>` option from `args` (only before a `--` terminator, so text sent with
 * `sessions keys` is never mistaken for it). Returns the remaining args and the target (the last one wins), or null when absent.
 */
export function extractBridgeOption(args: readonly string[]): { args: string[]; target: string | null } {
  const rest: string[] = [];
  let target: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { rest.push(...args.slice(index)); break; }
    if (arg === '--bridge') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error('--bridge requires a bridge id or name (see ftown bridges)');
      target = value; index++; continue;
    }
    if (arg.startsWith('--bridge=')) {
      const value = arg.slice('--bridge='.length);
      if (!value) throw new Error('--bridge requires a bridge id or name (see ftown bridges)');
      target = value; continue;
    }
    rest.push(arg);
  }
  return { args: rest, target };
}

interface PeerRow { bridgeId: string; label: string; approvedAt: string; online?: boolean }

export function bridgesUsage(): string {
  return `Usage: ftown bridges [--probe] [--json]

List the other bridges (computers) of this account that cross-bridge control can reach.

  --probe   Send each bridge an encrypted handshake and show whether it answered
  --json    Machine-readable output

Then drive one with --bridge <name|id|id-prefix> on sessions, status, board, events, attention, brief, worktrees
and plan commands, or set FTOWN_BRIDGE. Example: ftown sessions list --bridge my-laptop`;
}

export async function runBridges(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(bridgesUsage()); return 0; }
  const unknown = args.filter(arg => arg !== '--probe' && arg !== '--json');
  if (unknown.length) { console.error(`ftown bridges: unknown option ${unknown[0]}`); console.error(bridgesUsage()); return 1; }
  const probe = args.includes('--probe');
  const result = await apiResponse(loadPointer(), 'GET', probe ? '/api/peers?probe=1' : '/api/peers');
  const body = result.body as { bridgeId?: string; peers?: PeerRow[]; error?: string } | null;
  if (result.status < 200 || result.status >= 300) {
    console.error(`ftown bridges: ${typeof body?.error === 'string' ? body.error : `HTTP ${result.status}`}`);
    return 1;
  }
  if (args.includes('--json')) { console.log(JSON.stringify(body, null, 2)); return 0; }
  const peers = body?.peers ?? [];
  console.log(`this bridge: ${body?.bridgeId ?? 'unknown'}`);
  if (peers.length === 0) { console.log('no other bridges in this account'); return 0; }
  for (const peer of peers) {
    const state = peer.online === undefined ? '' : peer.online ? '  online' : '  offline';
    console.log(`${peer.bridgeId}  ${peer.label || '(unnamed)'}${state}`);
  }
  return 0;
}
