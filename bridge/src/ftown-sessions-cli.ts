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

function usage(): void {
  console.error(`Usage: ftown-sessions <command> [options]

Commands:
  list                          List sessions
  create [options]              Spawn a new agent session
  get <session-id>              Session metadata
  screen <session-id>           Print terminal lines
  grep <session-id>             Search terminal output
  keys <session-id> <text>      Send keys to a running session
  tell <target> <message...>    Send a text message to another session's terminal
  running <session-id>          Check if session PTY is running

Tell targets (one of):
  <session-id>                  Explicit target session id
  --parent                      Message FTOWN_SESSION_ID's parent session
  --children                    Message all sessions parented to FTOWN_SESSION_ID
  --siblings                    Message sessions sharing my parent (excluding me)

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
        const fanCount = [useParent, useChildren, useSiblings].filter(Boolean).length;
        if (fanCount > 1) {
          throw new Error('Use only one of --parent, --children, --siblings');
        }

        const positional = rest.filter((a) => !a.startsWith('--'));
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

        for (const target of targets) {
          const reqBody: Record<string, unknown> = { text: message };
          if (self) reqBody.from = self;
          try {
            const { data } = await api('POST', `/api/sessions/${target}/message`, reqBody);
            console.log(JSON.stringify({ target, ...(data as Record<string, unknown>) }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(JSON.stringify({ target, error: msg }));
          }
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
  const session = (data as { session?: Record<string, unknown> }).session;
  if (!session) return JSON.stringify(data, null, 2);
  return `created ${session.id}  ${session.name}  (${session.status})`;
}

main();
