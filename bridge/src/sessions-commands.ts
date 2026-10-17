#!/usr/bin/env node
/**
 * Local API client for ftown cross-session control.
 * Installed to ~/.ftown/ftown-sessions by ftown-bridge.
 */
import { api as request, loadPointer, listSessions, fetchInbox, sendMail } from './cli-client.js';
import {
  MAIL_TYPES,
  AUTOMATION_REMOVED_MESSAGE,
  formatMailMessage,
  type BridgePointer,
  type MailMessage,
  type Session,
  type SessionUsage,
} from './wire-types.js';

async function api(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ data: unknown }> {
  return { data: await request(loadPointer(), method, path, body, headers) };
}

async function listSessionInfo(): Promise<Session[]> { return listSessions(loadPointer()); }

async function resolveFanout(
  mode: 'parent' | 'children' | 'siblings',
  self: string | undefined,
): Promise<string[]> {
  if (!self) {
    throw new Error(`--${mode} requires FTOWN_SESSION_ID to be set`);
  }
  const sessions = await listSessionInfo();
  const me = sessions.find((s) => s.id === self);

  if (mode === 'parent') {
    const parent = me?.parentSessionId;
    if (!parent) throw new Error('Current session has no parent');
    return [parent];
  }

  if (mode === 'children') {
    return sessions.filter((s) => s.parentSessionId === self).map((s) => s.id);
  }

  // siblings
  const parent = me?.parentSessionId;
  if (!parent) throw new Error('Current session has no parent (cannot resolve siblings)');
  return sessions
    .filter((s) => s.parentSessionId === parent && s.id !== self)
    .map((s) => s.id);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** Positional args, skipping flags and the values of value-taking flags. */
function positionals(args: string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (valueFlags.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

interface UsageRow {
  id: string;
  name: string;
  usage: SessionUsage | null;
}

async function fetchUsageRow(id: string): Promise<UsageRow> {
  const [{ data: usageData }, sessionData] = await Promise.all([
    api('GET', `/api/sessions/${id}/usage`),
    api('GET', `/api/sessions/${id}`).then(
      (r) => r.data,
      () => null,
    ),
  ]);
  const session = (sessionData as { session?: Session } | null)?.session;
  return {
    id,
    name: session?.name ?? '',
    usage: (usageData as { usage?: SessionUsage | null }).usage ?? null,
  };
}

function formatUsageTable(rows: UsageRow[]): string {
  const header = ['id', 'name', 'model(s)', 'in', 'out', 'cacheR', 'cacheW', 'total'];
  const body: string[][] = [];
  for (const r of rows) {
    const u = r.usage;
    body.push([
      r.id.slice(0, 8),
      r.name,
      u ? u.models.join(',') : '-',
      u ? String(u.inputTokens) : '-',
      u ? String(u.outputTokens) : '-',
      u ? String(u.cacheReadTokens) : '-',
      u ? String(u.cacheWriteTokens) : '-',
      u ? String(u.totalTokens) : '-',
    ]);
    // Multi-model sessions get an indented per-model sub-row each.
    if (u?.perModel && u.perModel.length > 1) {
      for (const m of u.perModel) {
        body.push([
          '',
          '',
          `  ${m.model}`,
          String(m.inputTokens),
          String(m.outputTokens),
          String(m.cacheReadTokens),
          String(m.cacheWriteTokens),
          String(m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens),
        ]);
      }
    }
  }
  const collected = rows.map((r) => r.usage).filter((u): u is SessionUsage => u !== null);
  const sum = (pick: (u: SessionUsage) => number): number =>
    collected.reduce((acc, u) => acc + pick(u), 0);
  body.push([
    'TOTAL',
    '',
    '',
    String(sum((u) => u.inputTokens)),
    String(sum((u) => u.outputTokens)),
    String(sum((u) => u.cacheReadTokens)),
    String(sum((u) => u.cacheWriteTokens)),
    String(sum((u) => u.totalTokens)),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)),
  );
  const render = (row: string[]): string =>
    row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  return [render(header), ...body.map(render)].join('\n');
}

function usage(): void {
  console.error(`Usage: ftown sessions <command> [options]

Commands:
  list                          List sessions
  create [options]              Spawn a new agent session
  get <session-id>              Session metadata
  screen <session-id>           Print terminal lines
  grep <session-id>             Search terminal output
  keys <session-id> <text>      Send keys to a running session
  tell <target> <message...>    Send mail to another session's inbox
  inbox | mail                  Read own inbox (requires FTOWN_SESSION_ID)
  running <session-id>          Check if session PTY is running
  usage <session-id...>         Model/token usage per session (--json for raw)
  remove <session-id>           Stop and remove a session (archived as a tombstone)
  archive                       List archived (removed) sessions
  revive <session-id>           Recreate a removed session from its tombstone

Tell targets (one of):
  <session-id>                  Explicit target session id
  --parent                      Message FTOWN_SESSION_ID's parent session
  --children                    Message all sessions parented to FTOWN_SESSION_ID
  --siblings                    Message sessions sharing my parent (excluding me)

Tell options:
  --type <t>                    message | task | result | escalation (default: message)
  --thread <id>                 Thread id for grouping replies
  --keys                        Inject as terminal keystrokes instead of mail (last resort)

Inbox options:
  --peek                        Do not mark messages as delivered
  --limit <n>                   Max messages
  --all                         Include already-delivered messages
  --json                        Raw JSON output

Create options:
  --shell <type>                Harness override; omitted inherits the current session (otherwise claude)
  --prompt <text>               Initial message
  --workdir <path>              Working directory
  --create-workdir              Create --workdir if it does not exist
  --name <label>                Dashboard name
  --command <cmd>               Full command override
  --parent                      Link parent to FTOWN_SESSION_ID or X-Ftown-Session-Id
  --parent-id <uuid>            Explicit parent session id
  --model <name>                Model (cursor, codex)
  --json                        Output raw JSON (default for most commands)

Screen/grep options:
  --offset <n>                  Pagination offset (default: 0)
  --limit <n>                   Max lines/matches (default: 200)

Grep options:
  --pattern <regex>             Required for grep

Reads ~/.ftown/bridge.json (ftown-bridge must be running).`);
}

export async function runSessions(argv: string[]): Promise<number> {
  if (['loop', 'loops', 'loop-list'].includes(argv[0])) {
    console.error(`ftown sessions: ${AUTOMATION_REMOVED_MESSAGE}`);
    return 1;
  }
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    usage();
    return argv.length === 0 ? 1 : 0;
  }

  const cmd = argv[0];
  const rest = argv.slice(1);
  const jsonOut = !hasFlag(rest, '--plain');

  try {
    switch (cmd) {
      case 'list': {
        const { data } = await api('GET', '/api/sessions');
        console.log(jsonOut ? JSON.stringify(data, null, 2) : formatSessionList(data));
        break;
      }

      case 'create': {
        const shellType = flag(rest, '--shell');
        const prompt = flag(rest, '--prompt');
        const workingDir = flag(rest, '--workdir');
        const name = flag(rest, '--name');
        const command = flag(rest, '--command');
        const model = flag(rest, '--model');
        const parentId = flag(rest, '--parent-id');
        const useParent = hasFlag(rest, '--parent');
        const createWorkdir = hasFlag(rest, '--create-workdir');

        const body: Record<string, unknown> = {};
        if (shellType) body.shellType = shellType;
        if (prompt) body.prompt = prompt;
        if (workingDir) body.workingDir = workingDir;
        if (name) body.name = name;
        if (command) body.command = command;
        if (model) body.model = model;
        if (parentId) body.parentSessionId = parentId;
        else if (useParent) body.parentSessionId = true;
        if (createWorkdir) body.createMissingWorkingDir = true;

        const caller = process.env.FTOWN_SESSION_ID?.trim();
        const headers = caller ? { 'X-Ftown-Session-Id': caller } : undefined;

        const { data } = await api('POST', '/api/sessions', body, headers);
        console.log(jsonOut ? JSON.stringify(data, null, 2) : formatCreated(data));
        break;
      }

      case 'get': {
        const id = rest.find((a) => !a.startsWith('--'));
        if (!id) throw new Error('Missing session-id');
        const { data } = await api('GET', `/api/sessions/${id}`);
        console.log(JSON.stringify(data, null, 2));
        break;
      }

      case 'screen': {
        const id = rest.find((a) => !a.startsWith('--'));
        if (!id) throw new Error('Missing session-id');
        const offset = flag(rest, '--offset') ?? '0';
        const limit = flag(rest, '--limit') ?? '200';
        const { data } = await api(
          'GET',
          `/api/sessions/${id}/screen?offset=${offset}&limit=${limit}`,
        );
        if (jsonOut) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const lines = (data as { lines?: string[] }).lines ?? [];
          for (const line of lines) console.log(line);
        }
        break;
      }

      case 'grep': {
        const id = rest.find((a) => !a.startsWith('--'));
        const pattern = flag(rest, '--pattern');
        if (!id) throw new Error('Missing session-id');
        if (!pattern) throw new Error('Missing --pattern');
        const offset = parseInt(flag(rest, '--offset') ?? '0', 10);
        const limit = parseInt(flag(rest, '--limit') ?? '100', 10);
        const { data } = await api('POST', `/api/sessions/${id}/grep`, {
          pattern,
          offset,
          limit,
        });
        console.log(JSON.stringify(data, null, 2));
        break;
      }

      case 'keys': {
        const positional = rest.filter((a) => !a.startsWith('--'));
        const id = positional[0];
        const keys = positional.slice(1).join(' ');
        if (!id || !keys) throw new Error('Usage: keys <session-id> <text>');
        await api('POST', `/api/sessions/${id}/keys`, { keys });
        console.log(JSON.stringify({ sent: true, sessionId: id }));
        break;
      }

      case 'tell': {
        const useParent = hasFlag(rest, '--parent');
        const useChildren = hasFlag(rest, '--children');
        const useSiblings = hasFlag(rest, '--siblings');
        const useKeys = hasFlag(rest, '--keys');
        const mailType = flag(rest, '--type');
        const threadId = flag(rest, '--thread');
        const fanCount = [useParent, useChildren, useSiblings].filter(Boolean).length;
        if (fanCount > 1) {
          throw new Error('Use only one of --parent, --children, --siblings');
        }
        if (mailType && !(MAIL_TYPES as readonly string[]).includes(mailType)) {
          throw new Error(`Invalid --type "${mailType}" — use one of: ${MAIL_TYPES.join(', ')}`);
        }

        const positional = positionals(rest, ['--type', '--thread']);
        const self = process.env.FTOWN_SESSION_ID?.trim();

        let targets: string[];
        let message: string;

        if (fanCount === 1) {
          message = positional.join(' ');
          targets = await resolveFanout(
            useParent ? 'parent' : useChildren ? 'children' : 'siblings',
            self,
          );
        } else {
          const target = positional[0];
          message = positional.slice(1).join(' ');
          if (!target) {
            throw new Error('Usage: tell <target|--parent|--children|--siblings> <message...>');
          }
          targets = [target];
        }

        if (!message) throw new Error('Missing message');
        if (targets.length === 0) throw new Error('No matching target sessions');

        const fromName = self
          ? (await listSessionInfo()).find((s) => s.id === self)?.name
          : undefined;

        for (const target of targets) {
          try {
            if (useKeys) {
              // Explicit keystroke injection into the target terminal (legacy path).
              const reqBody: Record<string, unknown> = { text: message };
              if (self) reqBody.from = self;
              const { data } = await api('POST', `/api/sessions/${target}/message`, reqBody);
              console.log(JSON.stringify({ target, ...(data as Record<string, unknown>) }));
            } else {
              const reqBody: Record<string, unknown> = { body: message };
              if (self) reqBody.from = self;
              if (fromName) reqBody.fromName = fromName;
              if (mailType) reqBody.type = mailType;
              if (threadId) reqBody.threadId = threadId;
              const data = await sendMail(loadPointer(), target, reqBody);
              console.log(JSON.stringify({ target, ...(data as Record<string, unknown>) }));
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(JSON.stringify({ target, error: msg }));
          }
        }
        break;
      }

      case 'inbox':
      case 'mail': {
        const self = process.env.FTOWN_SESSION_ID?.trim();
        if (!self) throw new Error('inbox requires FTOWN_SESSION_ID to be set');
        const limit = flag(rest, '--limit');
        const messages = await fetchInbox(loadPointer(), self, { peek: hasFlag(rest, '--peek'), all: hasFlag(rest, '--all'), ...(limit ? { limit: Number(limit) } : {}) });
        if (hasFlag(rest, '--json')) {
          console.log(JSON.stringify({ messages }, null, 2));
        } else if (messages.length === 0) {
          console.log('(no mail)');
        } else {
          for (const m of messages) console.log(formatMailMessage(m));
        }
        break;
      }

      case 'running': {
        const id = rest.find((a) => !a.startsWith('--'));
        if (!id) throw new Error('Missing session-id');
        const { data } = await api('GET', `/api/sessions/${id}/running`);
        console.log(JSON.stringify(data, null, 2));
        break;
      }

      case 'usage': {
        const ids = rest.filter((a) => !a.startsWith('--'));
        if (ids.length === 0) throw new Error('Missing session-id');
        const rows = await Promise.all(ids.map(fetchUsageRow));
        if (hasFlag(rest, '--json')) {
          console.log(JSON.stringify({ sessions: rows }, null, 2));
        } else {
          console.log(formatUsageTable(rows));
        }
        break;
      }

      case 'remove': {
        const id = rest.find((a) => !a.startsWith('--'));
        if (!id) throw new Error('Missing session-id');
        const { data } = await api('DELETE', `/api/sessions/${id}`);
        console.log(jsonOut ? JSON.stringify(data, null, 2) : `removed ${id}`);
        break;
      }

      case 'archive': {
        const { data } = await api('GET', '/api/archive');
        const archived =
          (data as { archived?: Array<Record<string, unknown>> }).archived ?? [];
        const summary = archived.map((s) => ({
          id: s.id,
          name: s.name,
          removedAt: s.removedAt,
          shellType: s.shellType,
        }));
        console.log(
          jsonOut
            ? JSON.stringify({ archived: summary }, null, 2)
            : summary
                .map((s) => `${s.id}  ${s.removedAt}  ${s.shellType ?? ''}  ${s.name ?? ''}`.trimEnd())
                .join('\n'),
        );
        break;
      }

      case 'revive': {
        const id = rest.find((a) => !a.startsWith('--'));
        if (!id) throw new Error('Missing session-id');
        const { data } = await api('POST', `/api/sessions/${id}/revive`);
        console.log(jsonOut ? JSON.stringify(data, null, 2) : formatCreated(data));
        break;
      }

      default:
        usage();
        return 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ftown sessions: ${msg}`);
    return 1;
  }
  return 0;
}

function formatSessionList(data: unknown): string {
  const sessions = (data as { sessions?: Array<Record<string, unknown>> }).sessions ?? [];
  return sessions
    .map(
      (s) =>
        `${s.id}  ${s.status}  ${s.name ?? ''}  ${s.workingDir ?? ''}`.trimEnd(),
    )
    .join('\n');
}

function formatCreated(data: unknown): string {
  const { session, resumed } = data as { session?: Record<string, unknown>; resumed?: boolean };
  if (!session) return JSON.stringify(data, null, 2);
  // revive responses carry resumed; a fresh conversation lost its context.
  const resumeNote = resumed === undefined ? '' : resumed ? '  [resumed]' : '  [fresh conversation]';
  return `created ${session.id}  ${session.name}  (${session.status})${resumeNote}`;
}
