/**
 * `ftown attention` — answer or escalate questions routed from child sessions
 * (coordination phase B, see coordination/contract-b.ts ATTENTION_ROUTES).
 * The caller is identified by x-ftown-session-id (FTOWN_SESSION_ID).
 */
import { Command, CommanderError } from 'commander';
import { apiResponse, loadPointer } from './cli-client.js';
import type { AttentionItem } from './attention-events.js';
import type { AttentionAnswerEntry, AttentionPrompt } from './attention-prompt-protocol.js';
import { ATTENTION_ROUTES, ESCALATION_NOTE_MAX } from './coordination/contract-b.js';

/** One local-API call; injectable so tests need no bridge. */
export type AttentionApiFn = (
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<unknown>;

export interface AttentionCliDeps {
  api: AttentionApiFn;
  env: NodeJS.ProcessEnv;
  log: (text: string) => void;
  errorLog: (text: string) => void;
}

/** API failure carrying the HTTP status, so exit codes can map 403→4 and 409→5. */
export class AttentionApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AttentionApiError';
  }
}

/** Usage problem: message printed, exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Failure with a fixed exit code (e.g. 5 for an already-resolved item). */
class CliExitError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'CliExitError';
  }
}

async function defaultApi(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<unknown> {
  const result = await apiResponse(loadPointer(), method, path, body, headers);
  if (result.status < 200 || result.status >= 300) {
    const raw =
      result.body && typeof result.body === 'object' && !Array.isArray(result.body)
        ? (result.body as { error?: unknown }).error
        : undefined;
    throw new AttentionApiError(result.status, typeof raw === 'string' ? raw : `HTTP ${result.status}`);
  }
  return result.body;
}

function resolveDeps(partial?: Partial<AttentionCliDeps>): AttentionCliDeps {
  return {
    api: partial?.api ?? defaultApi,
    env: partial?.env ?? process.env,
    log: partial?.log ?? ((text: string) => console.log(text)),
    errorLog: partial?.errorLog ?? ((text: string) => console.error(text)),
  };
}

function requireSelf(env: NodeJS.ProcessEnv): string {
  const id = env.FTOWN_SESSION_ID?.trim();
  if (!id || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
    throw new UsageError('Set FTOWN_SESSION_ID (attention commands run inside a session)');
  }
  return id;
}

function callerHeaders(self: string): Record<string, string> {
  return { 'X-Ftown-Session-Id': self };
}

function routedPath(self: string): string {
  return ATTENTION_ROUTES.routed.replace(':id', encodeURIComponent(self));
}

function itemPath(childId: string, eventId: string): string {
  return `/api/sessions/${encodeURIComponent(childId)}/attention/${encodeURIComponent(eventId)}`;
}

function answerPath(childId: string, eventId: string): string {
  return ATTENTION_ROUTES.answer
    .replace(':id', encodeURIComponent(childId))
    .replace(':eventId', encodeURIComponent(eventId));
}

function escalatePath(childId: string, eventId: string): string {
  return ATTENTION_ROUTES.escalate
    .replace(':id', encodeURIComponent(childId))
    .replace(':eventId', encodeURIComponent(eventId));
}

// ───────────────────────── Answer building (pure) ─────────────────────────

export interface AnswerInput {
  options?: string[];
  text?: string;
  answersJson?: string;
}

function normalizeEntries(raw: unknown, prompt: AttentionPrompt | undefined): AttentionAnswerEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { answers?: unknown }).answers)
      ? (raw as { answers: unknown[] }).answers
      : undefined;
  if (!list) throw new UsageError('--answers-json must be a JSON array of { selected, text? } entries');
  if (prompt && list.length !== prompt.questions.length) {
    throw new UsageError(`--answers-json must contain ${prompt.questions.length} answer(s), one per question`);
  }
  return list.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new UsageError(`answers[${index}] must be an object with a selected array`);
    }
    const { selected, text } = entry as { selected?: unknown; text?: unknown };
    if (!Array.isArray(selected) || selected.some((s) => !Number.isInteger(s) || (s as number) < 0)) {
      throw new UsageError(`answers[${index}].selected must be an array of non-negative integers`);
    }
    if (text !== undefined && typeof text !== 'string') {
      throw new UsageError(`answers[${index}].text must be a string`);
    }
    const question = prompt?.questions[index];
    const indexes = [...new Set(selected as number[])].sort((a, b) => a - b);
    if (question && indexes.some((s) => s >= question.options.length)) {
      throw new UsageError(`answers[${index}].selected is out of range for question ${index + 1}`);
    }
    return text === undefined ? { selected: indexes } : { selected: indexes, text };
  });
}

export function buildAnswers(prompt: AttentionPrompt | undefined, input: AnswerInput): AttentionAnswerEntry[] {
  if (input.answersJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.answersJson);
    } catch {
      throw new UsageError('--answers-json is not valid JSON');
    }
    return normalizeEntries(parsed, prompt);
  }
  if (input.options !== undefined && input.options.length > 0) {
    if (!prompt) throw new UsageError('This item has no prompt options to pick from; use --text');
    if (prompt.questions.length > 1) {
      throw new UsageError('Multi-question prompt: use --answers-json');
    }
    const question = prompt.questions[0];
    if (question.options.length === 0) {
      throw new UsageError('This question has no options; use --text');
    }
    const selected = input.options.map((value) => {
      if (/^\d+$/.test(value)) {
        const index = Number(value);
        if (index < 1 || index > question.options.length) {
          throw new UsageError(`--option ${value} is out of range (1-${question.options.length})`);
        }
        return index - 1;
      }
      const index = question.options.findIndex((option) => option.label === value);
      if (index < 0) throw new UsageError(`--option "${value}" does not match an option label`);
      return index;
    });
    const unique = [...new Set(selected)].sort((a, b) => a - b);
    if (!question.multiSelect && unique.length > 1) {
      throw new UsageError('This question allows a single choice; supply one --option');
    }
    return [{ selected: unique }];
  }
  if (input.text !== undefined) {
    if (!input.text.trim()) throw new UsageError('--text must not be empty');
    if (prompt) {
      if (prompt.questions.length > 1) throw new UsageError('Multi-question prompt: use --answers-json');
      const question = prompt.questions[0];
      if (question.options.length > 0 && !question.allowText) {
        throw new UsageError('This question does not accept free text; use --option');
      }
    }
    return [{ selected: [], text: input.text }];
  }
  throw new UsageError('Supply exactly one of --option, --text or --answers-json');
}

// ───────────────────────── list ─────────────────────────

export interface RoutedItem {
  sessionId: string;
  sessionName: string;
  event: AttentionItem;
}

export function formatRoutedItem(item: RoutedItem): string[] {
  const { event } = item;
  const child = item.sessionName || item.sessionId;
  const title = event.title || event.message;
  const lines = [`${child} ${event.id} ${title}`];
  const questions = event.prompt?.questions ?? [];
  questions.forEach((question, index) => {
    if (questions.length > 1) lines.push(`  Q${index + 1}: ${question.question}`);
    if (question.options.length > 0) {
      const indent = questions.length > 1 ? '    ' : '  ';
      lines.push(`${indent}${question.options.map((option, i) => `${i + 1}) ${option.label}`).join('  ')}`);
    }
  });
  return lines;
}

async function listCommand(deps: AttentionCliDeps, opts: { json?: boolean }): Promise<void> {
  const self = requireSelf(deps.env);
  const data = (await deps.api('GET', routedPath(self), undefined, callerHeaders(self))) as {
    items?: RoutedItem[];
  };
  const items = data?.items ?? [];
  if (opts.json === true) {
    deps.log(JSON.stringify(data, null, 2));
    return;
  }
  if (items.length === 0) {
    deps.log('no routed questions');
    return;
  }
  for (const item of items) {
    for (const line of formatRoutedItem(item)) deps.log(line);
  }
}

// ───────────────────────── answer / escalate ─────────────────────────

async function fetchItem(
  deps: AttentionCliDeps,
  self: string,
  childId: string,
  eventId: string,
): Promise<AttentionItem> {
  const data = (await deps.api('GET', itemPath(childId, eventId), undefined, callerHeaders(self))) as {
    event?: AttentionItem;
  };
  const event = data?.event;
  if (!event || typeof event !== 'object') throw new Error('Invalid attention response');
  return event;
}

interface AnswerOptions {
  json?: boolean;
  option?: string[];
  text?: string;
  answersJson?: string;
}

async function answerCommand(
  deps: AttentionCliDeps,
  childId: string,
  eventId: string,
  opts: AnswerOptions,
): Promise<void> {
  const self = requireSelf(deps.env);
  const modes = [
    (opts.option?.length ?? 0) > 0,
    opts.text !== undefined,
    opts.answersJson !== undefined,
  ].filter(Boolean).length;
  if (modes !== 1) throw new UsageError('Supply exactly one of --option, --text or --answers-json');
  const item = await fetchItem(deps, self, childId, eventId);
  if (item.resolvedAt) throw new CliExitError(5, `Attention item ${eventId} is already resolved`);
  const answers = buildAnswers(item.prompt, {
    options: opts.option,
    text: opts.text,
    answersJson: opts.answersJson,
  });
  const data = await deps.api('POST', answerPath(childId, eventId), { answers }, callerHeaders(self));
  if (opts.json === true) deps.log(JSON.stringify(data, null, 2));
  else deps.log(`answer recorded for ${childId} (${eventId})`);
}

async function escalateCommand(
  deps: AttentionCliDeps,
  childId: string,
  eventId: string,
  opts: { json?: boolean; note?: string },
): Promise<void> {
  const self = requireSelf(deps.env);
  if (opts.note !== undefined && opts.note.length > ESCALATION_NOTE_MAX) {
    throw new UsageError(`--note must be at most ${ESCALATION_NOTE_MAX} characters`);
  }
  const body = opts.note === undefined ? {} : { note: opts.note };
  const data = await deps.api('POST', escalatePath(childId, eventId), body, callerHeaders(self));
  if (opts.json === true) deps.log(JSON.stringify(data, null, 2));
  else deps.log(`escalated ${eventId} for ${childId} to the human`);
}

// ───────────────────────── program / entry ─────────────────────────

function attentionProgram(deps: AttentionCliDeps): Command {
  const program = new Command()
    .name('ftown attention')
    .description('Answer or escalate questions routed from child sessions');
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => deps.log(text.trimEnd()),
    writeErr: (text) => deps.errorLog(text.trimEnd()),
  });
  program
    .command('list')
    .description('Questions routed to you from your child sessions')
    .option('--json', 'Machine-readable JSON output')
    .action(async (opts: { json?: boolean }) => {
      await listCommand(deps, opts);
    });
  program
    .command('answer <child-id> <event-id>')
    .description('Answer a routed question as its parent session')
    .option(
      '--option <value>',
      'Option 1-based index or exact label (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--text <t>', 'Free-text answer')
    .option('--answers-json <json>', 'JSON answers array (required for multi-question prompts)')
    .option('--json', 'Machine-readable JSON output')
    .action(async (childId: string, eventId: string, opts: AnswerOptions) => {
      await answerCommand(deps, childId, eventId, opts);
    });
  program
    .command('escalate <child-id> <event-id>')
    .description('Hand a routed question to the human')
    .option('--note <t>', `Context for the human (max ${ESCALATION_NOTE_MAX} characters)`)
    .option('--json', 'Machine-readable JSON output')
    .action(async (childId: string, eventId: string, opts: { json?: boolean; note?: string }) => {
      await escalateCommand(deps, childId, eventId, opts);
    });
  return program;
}

function exitCodeFor(error: unknown): number {
  if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
  if (error instanceof UsageError) return 2;
  if (error instanceof CliExitError) return error.code;
  if (error instanceof AttentionApiError) {
    if (error.status === 403) return 4;
    if (error.status === 409) return 5;
    return 1;
  }
  return 1;
}

export async function runAttention(argv: string[], deps?: Partial<AttentionCliDeps>): Promise<number> {
  const resolved = resolveDeps(deps);
  const program = attentionProgram(resolved);
  try {
    if (argv.length === 0) {
      program.outputHelp({ error: true });
      return 2;
    }
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    resolved.errorLog(`ftown attention: ${error instanceof Error ? error.message : String(error)}`);
    return exitCodeFor(error);
  }
}
