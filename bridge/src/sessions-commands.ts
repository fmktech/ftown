#!/usr/bin/env node
/**
 * Local API client for ftown cross-session control.
 * Installed to ~/.ftown/ftown-sessions by ftown-bridge.
 */

import { normalizeShellType } from './harness-registry.js';
import { Command, CommanderError } from 'commander';
import { normalizePullRequestUrl } from './pull-request-url.js';
import { sanitizeAttentionText } from './attention-events.js';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { formatAttentionAnswerText } from './attention-prompt.js';
import { ATTENTION_ITEM_WAIT_MAX_SECONDS, type AttentionAnswer, type AttentionPrompt } from './attention-prompt-protocol.js';
import { PREVIEW_CHAT_TEXT_BYTES } from './preview-chat-protocol.js';
import { validateChatInput } from './preview-chat.js';
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
  createWorkdir?: boolean; worktree?: boolean; branch?: string; base?: string;
  keepWorktree?: boolean; forceWorktree?: boolean; to?: string;
  offset?: string; limit?: string; pattern?: string;
  planItem?: string;
  children?: boolean; siblings?: boolean; keys?: boolean; type?: string; thread?: string;
  peek?: boolean; all?: boolean; sessionId?: string; message?: string; messageFile?: string; id?: string; title?: string; clear?: boolean;
  option?: string[]; multi?: boolean; text?: boolean; questionsJson?: string; wait?: boolean; timeout?: string;
  add?: string[]; remove?: string[];
}
type SessionCommand = 'preview-reply' | 'preview' | 'list' | 'create' | 'get' | 'screen' | 'grep' | 'keys' | 'tell'
  | 'inbox' | 'mail' | 'running' | 'usage' | 'remove' | 'archive' | 'revive' | 'attention' | 'attention-status' | 'pr';

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
    .option('--worktree', 'Create a bridge-owned git worktree for the session')
    .option('--branch <name>', 'Worktree branch (requires --worktree)')
    .option('--base <ref>', 'Base ref for the worktree branch (requires --worktree)')
    .option('--name <label>', 'Dashboard name').option('--command <cmd>', 'Full command override')
    .option('--parent', 'Link to the current session').option('--parent-id <uuid>', 'Explicit parent session')
    .option('--plan-item <id>', 'Start this todo item (p<n>) on the parent plan; requires --parent or --parent-id')
    .option('--model <name>', 'Model override')
    .option('--orchestrator', 'Compatibility flag (no additional prompt or environment changes)')
    .action((_opts, cmd: Command) => run('create', [], cmd));
  for (const name of ['get', 'running', 'revive'] as const) {
    command(`${name} <session-id>`, { get: 'Session metadata', running: 'Check if session PTY is running', revive: 'Recreate an archived session' }[name])
      .action((id: string, _opts, cmd: Command) => run(name, [id], cmd));
  }
  command('remove <session-id>', 'Stop and remove a session')
    .option('--keep-worktree', 'Retain a bridge-owned worktree instead of auto-retiring it')
    .option('--force-worktree', 'Force-remove a bridge-owned worktree')
    .action((id: string, _opts, cmd: Command) => run('remove', [id], cmd));
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
    .option('--to <target>', 'Routing target (only "human" is supported to bypass parent routing)')
    .option('--option <label>', 'Answer option shown to the user (repeatable)', (value: string, previous: string[]) => [...previous, value], [] as string[])
    .option('--multi', 'Let the user select several options (needs --option)')
    .option('--no-text', 'Do not offer a free-text answer (needs --option)')
    .option('--questions-json <json>', 'Structured questions: an array, or { "questions": [...] } (excludes --option/--multi/--no-text)')
    .option('--wait', 'Block until the user answers; prints the answer on stdout (exit 0; 2 dismissed, 124 timeout)')
    .option('--timeout <seconds>', 'With --wait: give up after this many seconds (1-86400, default 600)')
    .option('--session-id <id>', 'Target session; defaults to FTOWN_SESSION_ID')
    .action((_opts, cmd: Command) => run('attention', [], cmd));
  command('attention-status <event-id>', 'Check or wait for the answer to an attention question (exit 0 answered, 2 dismissed, 3 pending, 124 timeout)')
    .option('--wait', 'Block until the user answers')
    .option('--timeout <seconds>', 'With --wait: give up after this many seconds (1-86400, default 600)')
    .option('--session-id <id>', 'Target session; defaults to FTOWN_SESSION_ID')
    .action((eventId: string, _opts, cmd: Command) => run('attention-status', [eventId], cmd));
  command('pr [url]', 'Attach or replace this session’s GitHub pull request')
    .option('--clear', 'Remove the current pull request association')
    .option('--session-id <id>', 'Target session; defaults to FTOWN_SESSION_ID')
    .action((url: string | undefined, _opts, cmd: Command) => run('pr', url === undefined ? [] : [url], cmd));
  command('preview [paths...]', 'Register up to 12 preview files (.html/.htm/.md/.markdown, 1MiB each, duplicate basenames rejected)')
    .option('--add <paths...>', 'Append files to the current preview set (an already-registered file is re-registered in place with a new file id)')
    .option('--remove <names...>', 'Remove files by basename (removing the last file clears the preview)')
    .option('--clear', 'Remove the preview registration')
    .option('--session-id <id>', 'Target session; defaults to FTOWN_SESSION_ID')
    .action((paths: string[], _opts, cmd: Command) => run('preview', paths ?? [], cmd));
  command('preview-reply', 'Reply to this session’s preview conversation')
    .option('--message <text>', 'Reply text').option('--message-file <path>', 'Read UTF-8 reply from a file or - for stdin')
    .option('--session-id <id>', 'Target session; defaults to FTOWN_SESSION_ID').option('--id <uuid>', 'Stable ID for retry')
    .action((_opts, cmd: Command) => run('preview-reply', [], cmd));
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
    if (error instanceof SessionExit) return error.code;
    console.error(`ftown sessions: ${error instanceof Error ? error.message : String(error)}`); return 1;
  }
}

/** Thrown after a command has already printed its result, to carry a non-zero exit code. */
class SessionExit extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}

/** Injectable so tests need not really sleep. */
export const attentionClock = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms)),
};

const ATTENTION_DEFAULT_TIMEOUT_SECONDS = 600;
const ATTENTION_MAX_TIMEOUT_SECONDS = 86400;
const ATTENTION_POLL_RETRIES = 3;
const ATTENTION_RETRY_BACKOFF_MS = 1000;

interface WaitedAttentionItem { id: string; resolvedAt?: string; resolution?: string; prompt?: AttentionPrompt; answer?: AttentionAnswer }

function parseAttentionTimeout(value: string | undefined): number {
  if (value === undefined) return ATTENTION_DEFAULT_TIMEOUT_SECONDS;
  if (!/^\d+$/.test(value.trim())) throw new Error(`--timeout must be a whole number of seconds between 1 and ${ATTENTION_MAX_TIMEOUT_SECONDS}`);
  const seconds = Number(value);
  if (seconds < 1 || seconds > ATTENTION_MAX_TIMEOUT_SECONDS) throw new Error(`--timeout must be between 1 and ${ATTENTION_MAX_TIMEOUT_SECONDS} seconds`);
  return seconds;
}

function parseQuestionsJson(raw: string): unknown[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('--questions-json is not valid JSON'); }
  const questions = Array.isArray(parsed) ? parsed
    : parsed && typeof parsed === 'object' ? (parsed as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(questions) || questions.length === 0) throw new Error('--questions-json must be a non-empty array of questions or { "questions": [...] }');
  return questions;
}

/** Print the outcome of a resolved item and return its exit code, or undefined while still pending. */
function reportAttentionItem(item: WaitedAttentionItem): number | undefined {
  if (item.answer) {
    console.log(item.prompt ? formatAttentionAnswerText(item.prompt, item.answer.answers) : JSON.stringify(item.answer.answers));
    return 0;
  }
  if (item.resolvedAt) {
    console.error(`Attention request ${item.id} was resolved (${item.resolution ?? 'unknown'}) without an answer.`);
    return 2;
  }
  return undefined;
}

async function fetchAttentionItem(sessionId: string, eventId: string, waitSeconds?: number): Promise<WaitedAttentionItem> {
  const query = waitSeconds === undefined ? '' : `?waitSeconds=${waitSeconds}`;
  const { data } = await api('GET', `/api/sessions/${sessionId}/attention/${encodeURIComponent(eventId)}${query}`);
  const event = (data as { event?: WaitedAttentionItem } | null)?.event;
  if (!event || typeof event !== 'object') throw new Error('Invalid attention response');
  return event;
}

async function waitForAttentionAnswer(sessionId: string, eventId: string, timeoutSeconds: number): Promise<void> {
  console.error(`Waiting for an answer (attention ${eventId})...`);
  const deadline = attentionClock.now() + timeoutSeconds * 1000;
  let failures = 0;
  while (attentionClock.now() < deadline) {
    const remainingSeconds = Math.ceil((deadline - attentionClock.now()) / 1000);
    const waitSeconds = Math.max(1, Math.min(ATTENTION_ITEM_WAIT_MAX_SECONDS, remainingSeconds));
    let item: WaitedAttentionItem;
    try { item = await fetchAttentionItem(sessionId, eventId, waitSeconds); failures = 0; }
    catch (error) {
      if (++failures > ATTENTION_POLL_RETRIES) throw error;
      await attentionClock.sleep(ATTENTION_RETRY_BACKOFF_MS);
      continue;
    }
    const code = reportAttentionItem(item);
    if (code === 0) return;
    if (code !== undefined) throw new SessionExit(code);
  }
  console.error(`Timed out waiting for an answer. Check later: ftown sessions attention-status ${eventId} --wait`);
  throw new SessionExit(124);
}

function selfSessionId(explicit?: string): string {
  const id = (explicit ?? process.env.FTOWN_SESSION_ID)?.trim();
  if (!id || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
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

async function requireSessionCapability(id: string, feature: 'attention' | 'pullRequest' | 'preview', needsPrompt = false): Promise<void>  {
  const { data } = await api('GET', `/api/sessions/${id}`);
  const capabilities = (data as { capabilities?: { attention?: { version?: number; request?: boolean; prompt?: boolean }; sessionMetadata?: { pullRequest?: boolean; preview?: boolean } } } | null)?.capabilities;
  const supported = feature === 'attention'
    ? capabilities?.attention?.version === 1 && capabilities.attention.request === true && (!needsPrompt || capabilities.attention.prompt === true)
    : feature === 'preview' ? capabilities?.sessionMetadata?.preview === true : capabilities?.sessionMetadata?.pullRequest === true;
  if (!supported) throw new Error(`bridge_upgrade_required: Upgrade this bridge to support ${feature === 'attention' ? (needsPrompt ? 'attention questions' : 'attention requests') : feature === 'preview' ? 'HTML previews' : 'pull request metadata'}`);
}

async function executeSessionCommand(cmd: SessionCommand, rest: string[], options: SessionsOptions): Promise<void> {
  const jsonOut = !options.plain;
    switch (cmd) {
      case 'preview-reply': {
        const id = selfSessionId(options.sessionId);
        if ((options.message === undefined) === (options.messageFile === undefined)) throw new Error('Supply exactly one of --message or --message-file');
        let text = options.message;
        if (options.messageFile !== undefined) {
          const chunks: Buffer[] = []; let size = 0;
          if (options.messageFile === '-') {
            for await (const part of process.stdin) { const chunk = Buffer.from(part); size += chunk.length; if (size > PREVIEW_CHAT_TEXT_BYTES) throw new Error('Reply is too large'); chunks.push(chunk); }
          } else {
            const file = await open(options.messageFile, 'r');
            try {
              const buffer = Buffer.alloc(PREVIEW_CHAT_TEXT_BYTES + 1);
              while (size < buffer.length) { const read = await file.read(buffer, size, buffer.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
              if (size > PREVIEW_CHAT_TEXT_BYTES) throw new Error('Reply is too large'); chunks.push(buffer.subarray(0, size));
            }
            finally { await file.close(); }
          }
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw new Error('Reply must be UTF-8'); }
        }
        const messageId = options.id ?? randomUUID();
        if (text === undefined) throw new Error('Missing reply text');
        validateChatInput({ id: messageId, text });
        try {
          const { data } = await api('POST', `/api/sessions/${id}/preview-chat/reply`, { id: messageId, text });
          console.log(jsonOut ? JSON.stringify(data, null, 2) : `preview reply recorded for ${id} (${messageId})`);
        } catch { throw new Error(`Reply outcome may be uncertain; retry with --id ${messageId} and the same text`); }
        break;
      }
      case 'preview': {
        const id = selfSessionId(options.sessionId);
        const add = options.add;
        const removed = options.remove;
        const flagCount = [add !== undefined, removed !== undefined, options.clear === true].filter(Boolean).length;
        if (flagCount > 1) throw new Error('Supply only one of --add, --remove or --clear');
        if (options.clear === true) {
          if (rest.length > 0) throw new Error('Supply preview files or --clear, but not both');
          await requireSessionCapability(id, 'preview');
          const { data } = await api('DELETE', `/api/sessions/${id}/preview`);
          console.log(jsonOut ? JSON.stringify(data, null, 2) : `preview cleared for ${id}`);
          break;
        }
        if (add !== undefined) {
          if (rest.length > 0) throw new Error('Supply preview files or --add, but not both');
          if (!Array.isArray(add) || add.length === 0 || add.some((entry) => typeof entry !== 'string' || entry === '')) throw new Error('Supply preview files or --clear, but not both');
          await requireSessionCapability(id, 'preview');
          const { data } = await api('PUT', `/api/sessions/${id}/preview`, { paths: add.map((entry) => resolve(entry)), mode: 'add' });
          console.log(jsonOut ? JSON.stringify(data, null, 2) : `preview registered for ${id}`);
          break;
        }
        if (removed !== undefined) {
          if (rest.length > 0) throw new Error('Supply preview files or --remove, but not both');
          if (!Array.isArray(removed) || removed.length === 0 || removed.some((entry) => typeof entry !== 'string' || entry === '')) throw new Error('Supply preview files or --clear, but not both');
          await requireSessionCapability(id, 'preview');
          const { data } = await api('DELETE', `/api/sessions/${id}/preview`, { names: removed });
          console.log(jsonOut ? JSON.stringify(data, null, 2) : `preview updated for ${id}`);
          break;
        }
        if (rest.length === 0 || rest.some((entry) => entry === '')) throw new Error('Supply preview files or --clear, but not both');
        await requireSessionCapability(id, 'preview');
        const { data } = await api('PUT', `/api/sessions/${id}/preview`, { paths: rest.map((entry) => resolve(entry)), mode: 'replace' });
        console.log(jsonOut ? JSON.stringify(data, null, 2) : `preview registered for ${id}`);
        break;
      }
      case 'attention': {
        const id = selfSessionId(options.sessionId);
        const message = attentionText(options.message ?? '', '--message', 2000);
        const title = options.title === undefined ? undefined : attentionText(options.title, '--title', 200);
        if (options.to !== undefined && options.to !== 'human') {
          throw new Error('--to only accepts "human"');
        }
        const labels = options.option ?? [];
        const noText = options.text === false;
        if (options.questionsJson !== undefined && (labels.length > 0 || options.multi || noText)) {
          throw new Error('--questions-json cannot be combined with --option, --multi or --no-text');
        }
        if ((options.multi || noText) && labels.length === 0) throw new Error('--multi and --no-text require at least one --option');
        if (options.timeout !== undefined && !options.wait) throw new Error('--timeout requires --wait');
        let questions: unknown[] | undefined;
        if (options.questionsJson !== undefined) questions = parseQuestionsJson(options.questionsJson);
        else if (labels.length > 0) {
          questions = [{ question: message, options: labels.map((label) => attentionText(label, '--option', 80)), multiSelect: !!options.multi, allowText: !noText }];
        }
        if (options.wait && !questions) throw new Error('--wait requires --option or --questions-json');
        const timeoutSeconds = options.wait ? parseAttentionTimeout(options.timeout) : 0;
        await requireSessionCapability(id, 'attention', questions !== undefined);
        const { data } = await api('POST', `/api/sessions/${id}/attention`, {
          message,
          ...(title === undefined ? {} : { title }),
          ...(questions === undefined ? {} : { questions }),
          ...(options.to === 'human' ? { to: 'human' } : {}),
        });
        const eventId = (data as { event?: { id?: unknown } } | null)?.event?.id;
        if (options.wait) {
          if (typeof eventId !== 'string') throw new Error('Invalid attention response');
          await waitForAttentionAnswer(id, eventId, timeoutSeconds);
          break;
        }
        console.log(jsonOut ? JSON.stringify(data, null, 2) : `attention requested for ${id}`);
        if (questions && typeof eventId === 'string') console.error(`Event id: ${eventId}. Check later: ftown sessions attention-status ${eventId} --wait`);
        break;
      }
      case 'attention-status': {
        const id = selfSessionId(options.sessionId);
        const eventId = rest[0];
        if (!eventId) throw new Error('Missing event-id');
        if (options.timeout !== undefined && !options.wait) throw new Error('--timeout requires --wait');
        const timeoutSeconds = options.wait ? parseAttentionTimeout(options.timeout) : 0;
        const code = reportAttentionItem(await fetchAttentionItem(id, eventId));
        if (code === 0) break;
        if (code !== undefined) throw new SessionExit(code);
        if (!options.wait) { console.log('Pending: no answer yet.'); throw new SessionExit(3); }
        await waitForAttentionAnswer(id, eventId, timeoutSeconds);
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
        const rawShell = options.shell;
        const shellType = rawShell !== undefined ? normalizeShellType(rawShell) : undefined;
        const prompt = options.prompt;
        const workingDir = options.workdir;
        const name = options.name;
        const command = options.command;
        const model = options.model;
        const parentId = options.parentId;
        const useParent = !!options.parent;
        const planItem = options.planItem;

        if (planItem !== undefined && !/^p\d{1,6}$/.test(planItem)) {
          throw new Error('--plan-item must be a plan item id like p1, p12');
        }
        if (planItem !== undefined && !parentId && !useParent) {
          throw new Error('--plan-item requires --parent or --parent-id');
        }
        const createWorkdir = !!options.createWorkdir;
        const useWorktree = !!options.worktree;
        const branch = options.branch;
        const base = options.base;

        if ((branch !== undefined || base !== undefined) && !useWorktree) {
          throw new Error('--branch and --base require --worktree');
        }

        const body: Record<string, unknown> = {};
        if (shellType) body.shellType = shellType;
        if (prompt) body.prompt = prompt;
        if (workingDir) body.workingDir = workingDir;
        if (name) body.name = name;
        if (command) body.command = command;
        if (model) body.model = model;
        if (parentId) body.parentSessionId = parentId;
        else if (useParent) body.parentSessionId = true;
        if (planItem) body.planItem = planItem;
        if (createWorkdir) body.createMissingWorkingDir = true;
        if (useWorktree) {
          if (branch !== undefined || base !== undefined) {
            body.worktree = {
              ...(branch !== undefined ? { branch } : {}),
              ...(base !== undefined ? { base } : {}),
            };
          } else {
            body.worktree = true;
          }
        }

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
        if (options.keepWorktree && options.forceWorktree) {
          throw new Error('Supply at most one of --keep-worktree or --force-worktree');
        }
        const query = options.keepWorktree
          ? '?worktree=keep'
          : options.forceWorktree
            ? '?worktree=force'
            : '';
        const { data } = await api('DELETE', `/api/sessions/${id}${query}`);
        const outcomeText = formatWorktreeOutcome(data);
        if (jsonOut) {
          console.log(JSON.stringify(data, null, 2));
          if (outcomeText) console.error(outcomeText);
        } else {
          console.log(outcomeText ? `removed ${id} (${outcomeText})` : `removed ${id}`);
        }
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

function formatWorktreeOutcome(data: unknown): string | undefined {
  const outcome = (data as { worktreeOutcome?: { action?: string; reason?: string } } | null)?.worktreeOutcome;
  if (!outcome || typeof outcome !== 'object') return undefined;
  if (outcome.action === 'removed') return 'worktree removed';
  if (outcome.action === 'retained') {
    return outcome.reason ? `worktree retained: ${outcome.reason}` : 'worktree retained';
  }
  return undefined;
}

function formatCreated(data: unknown): string {
  const { session, resumed } = data as { session?: Record<string, unknown>; resumed?: boolean };
  if (!session) return JSON.stringify(data, null, 2);
  // revive responses carry resumed; a fresh conversation lost its context.
  const resumeNote = resumed === undefined ? '' : resumed ? '  [resumed]' : '  [fresh conversation]';
  return `created ${session.id}  ${session.name}  (${session.status})${resumeNote}`;
}
