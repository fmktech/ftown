#!/usr/bin/env node
/**
 * Local API client for ftown cross-session control.
 * Installed to ~/.ftown/ftown-sessions by ftown-bridge.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface BridgePointer {
  port: number;
  token: string;
}

function loadBridge(): BridgePointer {
  const path = join(homedir(), '.ftown', 'bridge.json');
  const raw = readFileSync(path, 'utf8');
  const data = JSON.parse(raw) as BridgePointer;
  if (!data.port || !data.token) {
    throw new Error('Invalid bridge.json (missing port or token)');
  }
  return data;
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; data: unknown }> {
  const { port, token } = loadBridge();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...extraHeaders,
  };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: payload,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const err = data as { error?: string };
    throw new Error(err?.error ?? `HTTP ${res.status}`);
  }
  return { status: res.status, data };
}

interface SessionInfo {
  id: string;
  name?: string;
  parentSessionId?: string;
}

async function listSessionInfo(): Promise<SessionInfo[]> {
  const { data } = await api('GET', '/api/sessions');
  return (data as { sessions?: SessionInfo[] }).sessions ?? [];
}

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

const MAIL_TYPES = ['message', 'task', 'result', 'escalation'] as const;

interface MailMessage {
  id: string;
  ts: string;
  from: string;
  fromName?: string;
  to: string;
  type: (typeof MAIL_TYPES)[number];
  threadId?: string;
  body: string;
}

function formatMailMessage(m: MailMessage): string {
  return `[${m.ts}] ${m.fromName ?? m.from} (${m.type}): ${m.body}`;
}

function usage(): void {
  console.error(`Usage: ftown-sessions <command> [options]

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
  --shell <type>                cursor | claude | shell | opencode (default: claude)
  --prompt <text>               Initial message
  --workdir <path>              Working directory
  --name <label>                Dashboard name
  --command <cmd>               Full command override
  --parent                      Link parent to FTOWN_SESSION_ID or X-Ftown-Session-Id
  --parent-id <uuid>            Explicit parent session id
  --orchestrator                Brief the new agent to spawn and coordinate sibling sessions
  --model <name>                Model (cursor)
  --json                        Output raw JSON (default for most commands)

Screen/grep options:
  --offset <n>                  Pagination offset (default: 0)
  --limit <n>                   Max lines/matches (default: 200)

Grep options:
  --pattern <regex>             Required for grep

Reads ~/.ftown/bridge.json (ftown-bridge must be running).`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    usage();
    process.exit(argv.length === 0 ? 1 : 0);
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
        const orchestrator = hasFlag(rest, '--orchestrator');

        const body: Record<string, unknown> = {};
        if (shellType) body.shellType = shellType;
        if (prompt) body.prompt = prompt;
        if (workingDir) body.workingDir = workingDir;
        if (name) body.name = name;
        if (command) body.command = command;
        if (model) body.model = model;
        if (parentId) body.parentSessionId = parentId;
        else if (useParent) body.parentSessionId = true;
        if (orchestrator) body.orchestrator = true;

        const caller = process.env.FTOWN_SESSION_ID?.trim();
        const headers =
          useParent && caller ? { 'X-Ftown-Session-Id': caller } : undefined;

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
              const { data } = await api('POST', `/api/sessions/${target}/inbox`, reqBody);
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
        const params = new URLSearchParams();
        params.set('wait', '0');
        if (hasFlag(rest, '--peek')) params.set('peek', '1');
        if (hasFlag(rest, '--all')) params.set('all', '1');
        const limit = flag(rest, '--limit');
        if (limit) params.set('limit', limit);
        const { data } = await api('GET', `/api/sessions/${self}/inbox?${params.toString()}`);
        const messages = (data as { messages?: MailMessage[] }).messages ?? [];
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
        process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ftown-sessions: ${msg}`);
    process.exit(1);
  }
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

main();
