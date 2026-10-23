#!/usr/bin/env node
/**
 * Local API client for ftown cross-session control.
 * Installed to ~/.ftown/ftown-sessions by ftown-bridge.
 */
import { Command, CommanderError } from 'commander';
import { normalizePullRequestUrl } from './pull-request-url.js';
import { sanitizeAttentionText } from './attention-events.js';
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

interface SessionsOptions {
  plain?: boolean; json?: boolean; shell?: string; prompt?: string; workdir?: string;
  name?: string; command?: string; model?: string; parentId?: string; parent?: boolean;
  createWorkdir?: boolean; offset?: string; limit?: string; pattern?: string;
  children?: boolean; siblings?: boolean; keys?: boolean; type?: string; thread?: string;
  peek?: boolean; all?: boolean; sessionId?: string; message?: string; title?: string; clear?: boolean;
}
type SessionCommand = 'list' | 'create' | 'get' | 'screen' | 'grep' | 'keys' | 'tell'
  | 'inbox' | 'mail' | 'running' | 'usage' | 'remove' | 'archive' | 'revive' | 'attention' | 'pr';

function sessionProgram(): Command {
  const program = new Command().name('ftown sessions').description('List, create, read and drive ftown agent sessions');
  program.exitOverride();
  program.configureOutput({ writeOut: (text) => console.log(text.trimEnd()), writeErr: (text) => console.error(text.trimEnd()) });
  const command = (name: string, description: string): Command => program.command(name).description(description)
    .option('--json', 'Machine-readable JSON output (the default for most commands)')
    .option('--plain', 'Human-readable output where supported');
  const run = (name: SessionCommand, args: string[], cmd: Command): Promise<void> => executeSessionCommand(name, args, cmd.opts<SessionsOptions>());

  command('list', 'List sessions').action((_opts, cmd: Command) => run('list', [], cmd));
  command('create', 'Spawn a new agent session')
    .option('--shell <type>', 'Harness override; otherwise inherit the current session')
    .option('--prompt <text>', 'Initial message').option('--workdir <path>', 'Working directory')
    .option('--create-workdir', 'Create the working directory if missing')
    .option('--name <label>', 'Dashboard name').option('--command <cmd>', 'Full command override')
    .option('--parent', 'Link to the current session').option('--parent-id <uuid>', 'Explicit parent session')
    .option('--model <name>', 'Model override')
    .option('--orchestrator', 'Compatibility flag (no additional prompt or environment changes)')
    .action((_opts, cmd: Command) => run('create', [], cmd));
  for (const name of ['get', 'running', 'remove', 'revive'] as const) {
    command(`${name} <session-id>`, { get: 'Session metadata', running: 'Check if session PTY is running', remove: 'Stop and remove a session', revive: 'Recreate an archived session' }[name])
      .action((id: string, _opts, cmd: Command) => run(name, [id], cmd));
  }
  command('screen <session-id>', 'Print terminal lines')
    .option('--offset <n>', 'Pagination offset', '0').option('--limit <n>', 'Max lines', '200')
    .action((id: string, _opts, cmd: Command) => run('screen', [id], cmd));
  command('grep <session-id>', 'Search terminal output')
    .requiredOption('--pattern <regex>', 'Search expression').option('--offset <n>', 'Match offset', '0')
    .option('--limit <n>', 'Max matches', '100')
    .action((id: string, _opts, cmd: Command) => run('grep', [id], cmd));
  command('keys <session-id> <text...>', 'Send keys to a running session')
    .action((id: string, text: string[], _opts, cmd: Command) => run('keys', [id, ...text], cmd));
  command('tell [target] [message...]', 'Send mail to another session inbox')
    .option('--parent', 'Message the current session parent').option('--children', 'Message its children')
    .option('--siblings', 'Message its siblings').option('--keys', 'Inject terminal keystrokes instead of mail')
    .option('--type <t>', `Mail type: ${MAIL_TYPES.join(' | ')}`).option('--thread <id>', 'Reply thread')
    .action((target: string | undefined, text: string[], _opts, cmd: Command) => run('tell', [...(target === undefined ? [] : [target]), ...text], cmd));
  command('inbox', 'Read own inbox (requires FTOWN_SESSION_ID)').alias('mail')
    .option('--peek', 'Do not mark delivered').option('--limit <n>', 'Max messages').option('--all', 'Include delivered messages')
    .action((_opts, cmd: Command) => run('inbox', [], cmd));
  command('usage <session-id...>', 'Model/token usage per session')
    .action((ids: string[], _opts, cmd: Command) => run('usage', ids, cmd));
  command('archive', 'List archived sessions').action((_opts, cmd: Command) => run('archive', [], cmd));
  command('attention', 'Request human input for this session')
    .requiredOption('--message <text>', 'What the user should review or answer (max 2000 characters)')
    .option('--title <text>', 'Short title (max 200 characters)')
    .option('--session-id <id>', 'Target session; defaults to FTOWN_SESSION_ID')
    .action((_opts, cmd: Command) => run('attention', [], cmd));
  command('pr [url]', 'Attach or replace this session’s GitHub pull request')
    .option('--clear', 'Remove the current pull request association')
    .option('--session-id <id>', 'Target session; defaults to FTOWN_SESSION_ID')
    .action((url: string | undefined, _opts, cmd: Command) => run('pr', url === undefined ? [] : [url], cmd));
  return program;
}

export async function runSessions(argv: string[]): Promise<number> {
  if (['loop', 'loops', 'loop-list'].includes(argv[0])) {
    console.error(`ftown sessions: ${AUTOMATION_REMOVED_MESSAGE}`); return 1;
  }
  const program = sessionProgram();
  try {
    if (argv.length === 0) { program.outputHelp({ error: true }); return 1; }
    await program.parseAsync(argv, { from: 'user' }); return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    console.error(`ftown sessions: ${error instanceof Error ? error.message : String(error)}`); return 1;
  }
}

function selfSessionId(explicit?: string): string {
  const id = (explicit ?? process.env.FTOWN_SESSION_ID)?.trim();
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error('Supply a valid --session-id or set FTOWN_SESSION_ID');
  }
  return id;
}

function attentionText(value: string, field: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) throw new Error(`${field} must contain 1–${maxLength} characters`);
  const text = sanitizeAttentionText(trimmed, maxLength);
  if (!text) throw new Error(`${field} must contain visible text`);
  return text;
}

async function requireSessionCapability(id: string, feature: 'attention' | 'pullRequest'): Promise<void> {
  const { data } = await api('GET', `/api/sessions/${id}`);
  const capabilities = (data as { capabilities?: { attention?: { version?: number; request?: boolean }; sessionMetadata?: { pullRequest?: boolean } } } | null)?.capabilities;
  const supported = feature === 'attention'
    ? capabilities?.attention?.version === 1 && capabilities.attention.request === true
    : capabilities?.sessionMetadata?.pullRequest === true;
  if (!supported) throw new Error(`bridge_upgrade_required: Upgrade this bridge to support ${feature === 'attention' ? 'attention requests' : 'pull request metadata'}`);
}

async function executeSessionCommand(cmd: SessionCommand, rest: string[], options: SessionsOptions): Promise<void> {
  const jsonOut = !options.plain;
    switch (cmd) {
      case 'attention': {
        const id = selfSessionId(options.sessionId);
        const message = attentionText(options.message ?? '', '--message', 2000);
        const title = options.title === undefined ? undefined : attentionText(options.title, '--title', 200);
        await requireSessionCapability(id, 'attention');
        const { data } = await api('POST', `/api/sessions/${id}/attention`, { message, ...(title === undefined ? {} : { title }) });
        console.log(jsonOut ? JSON.stringify(data, null, 2) : `attention requested for ${id}`);
        break;
      }
      case 'pr': {
        const id = selfSessionId(options.sessionId);
        const url = rest[0];
        if ((url !== undefined && options.clear) || (url === undefined && !options.clear)) {
          throw new Error('Supply a GitHub pull request URL or --clear, but not both');
        }
        const pullRequestUrl = options.clear ? null : normalizePullRequestUrl(url!);
        await requireSessionCapability(id, 'pullRequest');
        const { data } = await api('PATCH', `/api/sessions/${id}`, { pullRequestUrl });
        console.log(jsonOut ? JSON.stringify(data, null, 2) : `pull request ${pullRequestUrl === null ? 'cleared' : 'updated'} for ${id}`);
        break;
      }

      case 'list': {
        const { data } = await api('GET', '/api/sessions');
        console.log(jsonOut ? JSON.stringify(data, null, 2) : formatSessionList(data));
        break;
      }

      case 'create': {
        const shellType = options.shell;
        const prompt = options.prompt;
        const workingDir = options.workdir;
        const name = options.name;
        const command = options.command;
        const model = options.model;
        const parentId = options.parentId;
        const useParent = !!options.parent;
        const createWorkdir = !!options.createWorkdir;

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
        const id = rest[0];
        if (!id) throw new Error('Missing session-id');
        const { data } = await api('GET', `/api/sessions/${id}`);
        console.log(JSON.stringify(data, null, 2));
        break;
      }

      case 'screen': {
        const id = rest[0];
        if (!id) throw new Error('Missing session-id');
        const offset = options.offset ?? '0';
        const limit = options.limit ?? '200';
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
        const id = rest[0];
        const pattern = options.pattern;
        if (!id) throw new Error('Missing session-id');
        if (!pattern) throw new Error('Missing --pattern');
        const offset = parseInt(options.offset ?? '0', 10);
        const limit = parseInt(options.limit ?? '100', 10);
        const { data } = await api('POST', `/api/sessions/${id}/grep`, {
          pattern,
          offset,
          limit,
        });
        console.log(JSON.stringify(data, null, 2));
        break;
      }

      case 'keys': {
        const positional = rest;
        const id = positional[0];
        const keys = positional.slice(1).join(' ');
        if (!id || !keys) throw new Error('Usage: keys <session-id> <text>');
        await api('POST', `/api/sessions/${id}/keys`, { keys });
        console.log(JSON.stringify({ sent: true, sessionId: id }));
        break;
      }

      case 'tell': {
        const useParent = !!options.parent;
        const useChildren = !!options.children;
        const useSiblings = !!options.siblings;
        const useKeys = !!options.keys;
        const mailType = options.type;
        const threadId = options.thread;
        const fanCount = [useParent, useChildren, useSiblings].filter(Boolean).length;
        if (fanCount > 1) {
          throw new Error('Use only one of --parent, --children, --siblings');
        }
        if (mailType && !(MAIL_TYPES as readonly string[]).includes(mailType)) {
          throw new Error(`Invalid --type "${mailType}" — use one of: ${MAIL_TYPES.join(', ')}`);
        }

        const positional = rest;
        const self = process.env.FTOWN_SESSION_ID?.trim();

        let targets: string[];
        let message: string;

        if (fanCount === 1) {
          message = positional.join(' ');
          if (!message) throw new Error('Missing message');
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
        const limit = options.limit;
        const messages = await fetchInbox(loadPointer(), self, { peek: !!options.peek, all: !!options.all, ...(limit ? { limit: Number(limit) } : {}) });
        if (!!options.json) {
          console.log(JSON.stringify({ messages }, null, 2));
        } else if (messages.length === 0) {
          console.log('(no mail)');
        } else {
          for (const m of messages) console.log(formatMailMessage(m));
        }
        break;
      }

      case 'running': {
        const id = rest[0];
        if (!id) throw new Error('Missing session-id');
        const { data } = await api('GET', `/api/sessions/${id}/running`);
        console.log(JSON.stringify(data, null, 2));
        break;
      }

      case 'usage': {
        const ids = rest;
        if (ids.length === 0) throw new Error('Missing session-id');
        const rows = await Promise.all(ids.map(fetchUsageRow));
        if (!!options.json) {
          console.log(JSON.stringify({ sessions: rows }, null, 2));
        } else {
          console.log(formatUsageTable(rows));
        }
        break;
      }

      case 'remove': {
        const id = rest[0];
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
        const id = rest[0];
        if (!id) throw new Error('Missing session-id');
        const { data } = await api('POST', `/api/sessions/${id}/revive`);
        console.log(jsonOut ? JSON.stringify(data, null, 2) : formatCreated(data));
        break;
      }


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
