/**
 * `ftown status | board | events` — coordination phase-A CLI.
 * Thin client over the local coordination API (see coordination/contract.ts).
 */
import { Command, CommanderError } from 'commander';
import { apiResponse, loadPointer } from './cli-client.js';
import {
  BOARD_WAIT_CONDITIONS,
  CARD_LIMITS,
  CARD_STATES,
  COORDINATION_ROUTES,
  type Board,
  type BoardWaitCondition,
  type CardBlockedOn,
  type CardPatch,
  type CardProgress,
  type SessionCard,
  type TreeEvent,
  type TreeEventPage,
} from './coordination/contract.js';
import { formatBoard, formatBoardRow, formatEvent } from './coordination/format.js';

/** One local-API call; injectable so tests need no bridge. */
export type CoordinationApiFn = (method: string, path: string, body?: unknown) => Promise<unknown>;

export interface CoordinationCliDeps {
  api: CoordinationApiFn;
  now: () => number;
  env: NodeJS.ProcessEnv;
  log: (text: string) => void;
  errorLog: (text: string) => void;
}

export const WAIT_DEFAULT_TIMEOUT_SECONDS = 300;
export const WAIT_MAX_TIMEOUT_SECONDS = 300;
const EVENTS_WAIT_CHUNK_SECONDS = 300;

const STATUS_SET_USAGE =
  'Usage: ftown status set [--state <s>] [--headline <t>] [--progress <d>/<t>|--no-progress] ' +
  '[--on human|parent|external|session:<id>] [--text <t>] [--next <t>|--no-next] [--force] [--session-id <id>]';

/** Usage problem: message printed, exit code 2. */
export class UsageError extends Error {
  constructor(message: string, readonly usage?: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Thrown after output has been printed, to carry a non-zero exit code. */
class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = 'ExitError';
  }
}

/** HTTP error returned by the local coordination API. */
class ApiHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

async function defaultApi(method: string, path: string, body?: unknown): Promise<unknown> {
  const caller = process.env.FTOWN_SESSION_ID?.trim();
  const headers = caller ? { 'X-Ftown-Session-Id': caller } : undefined;
  const result = await apiResponse(loadPointer(), method, path, body, headers);
  if (result.status < 200 || result.status >= 300) {
    const error =
      result.body && typeof result.body === 'object' && !Array.isArray(result.body)
        ? result.body.error
        : undefined;
    throw new ApiHttpError(
      result.status,
      typeof error === 'string' ? error : `HTTP ${result.status}`,
    );
  }
  return result.body;
}

function resolveDeps(partial?: Partial<CoordinationCliDeps>): CoordinationCliDeps {
  return {
    api: partial?.api ?? defaultApi,
    now: partial?.now ?? (() => Date.now()),
    env: partial?.env ?? process.env,
    log: partial?.log ?? ((text: string) => console.log(text)),
    errorLog: partial?.errorLog ?? ((text: string) => console.error(text)),
  };
}

function requireSessionId(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  const id = (explicit ?? env.FTOWN_SESSION_ID)?.trim();
  if (!id || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
    throw new UsageError('Supply a valid --session-id or set FTOWN_SESSION_ID');
  }
  return id;
}

function cardPath(sessionId: string): string {
  return COORDINATION_ROUTES.card.replace(':id', encodeURIComponent(sessionId));
}

function boardPath(sessionId: string, query: { since?: number; ready?: boolean; all?: boolean }): string {
  const params = new URLSearchParams();
  if (query.since !== undefined) params.set('since', String(query.since));
  if (query.ready) params.set('ready', '1');
  if (query.all) params.set('all', '1');
  const qs = params.toString();
  const base = COORDINATION_ROUTES.board.replace(':id', encodeURIComponent(sessionId));
  return qs ? `${base}?${qs}` : base;
}

function eventsPath(
  sessionId: string,
  query: { since?: number; limit?: number; waitSeconds?: number },
): string {
  const params = new URLSearchParams();
  if (query.since !== undefined) params.set('since', String(query.since));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.waitSeconds !== undefined) params.set('waitSeconds', String(query.waitSeconds));
  const qs = params.toString();
  const base = COORDINATION_ROUTES.events.replace(':id', encodeURIComponent(sessionId));
  return qs ? `${base}?${qs}` : base;
}

// ───────────────────────── Flag parsing (pure) ─────────────────────────

export function parseProgress(value: string): CardProgress {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) {
    throw new UsageError(`--progress must be <done>/<total> (got "${value}")`);
  }
  const done = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1 || total > CARD_LIMITS.progressTotal || done > total) {
    throw new UsageError(
      `--progress must satisfy 0 <= done <= total and 1 <= total <= ${CARD_LIMITS.progressTotal} (got "${value}")`,
    );
  }
  return { done, total };
}

function parseBlockedOn(on: string, text: string): CardBlockedOn {
  if (on === 'human' || on === 'parent' || on === 'external') {
    return { kind: on, text };
  }
  if (on.startsWith('session:')) {
    const ref = on.slice('session:'.length);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(ref)) {
      throw new UsageError('--on session:<id> requires a valid session id');
    }
    return { kind: 'session', ref, text };
  }
  throw new UsageError('--on must be human, parent, external or session:<id>');
}

export interface StatusSetFlags {
  state?: string;
  headline?: string;
  /** string value, false for --no-progress, undefined when absent */
  progress?: string | boolean;
  on?: string;
  text?: string;
  /** string value, false for --no-next, undefined when absent */
  next?: string | boolean;
  force?: boolean;
}

export function buildCardPatch(flags: StatusSetFlags): CardPatch {
  const patch: CardPatch = {};
  let touched = false;
  if (flags.state !== undefined) {
    if (!(CARD_STATES as readonly string[]).includes(flags.state)) {
      throw new UsageError(`--state must be one of: ${CARD_STATES.join(', ')}`);
    }
    patch.state = flags.state as CardPatch['state'];
    touched = true;
  }
  if (flags.headline !== undefined) {
    patch.headline = flags.headline;
    touched = true;
  }
  if (typeof flags.progress === 'string') {
    patch.progress = parseProgress(flags.progress);
    touched = true;
  } else if (flags.progress === false) {
    patch.progress = null;
    touched = true;
  }
  if (flags.on !== undefined) {
    if (flags.text === undefined) throw new UsageError('--on requires --text');
    patch.blockedOn = parseBlockedOn(flags.on, flags.text);
    touched = true;
  } else if (flags.text !== undefined) {
    throw new UsageError('--text requires --on');
  }
  if (typeof flags.next === 'string') {
    patch.next = flags.next;
    touched = true;
  } else if (flags.next === false) {
    patch.next = null;
    touched = true;
  }
  if (!touched) {
    throw new UsageError('Nothing to set: supply at least one card field', STATUS_SET_USAGE);
  }
  return patch;
}

/**
 * Pure wait-condition evaluation.
 * any-done, any-blocked, and any-ready hold only for a child that appears in
 * `events` (tree events after the starting cursor). all-done is the whole board.
 * any-change is any event in `events`.
 */
export function evaluateWaitCondition(
  condition: BoardWaitCondition,
  board: Board,
  events: readonly TreeEvent[],
): boolean {
  const changedIds = new Set(events.map((event) => event.sessionId));
  const changed = board.cards.filter((card) => changedIds.has(card.sessionId));
  switch (condition) {
    case 'any-change':
      return events.length > 0;
    case 'any-done':
      return changed.some((card) => card.declared?.state === 'done');
    case 'any-blocked':
      return changed.some((card) => card.declared?.state === 'blocked');
    case 'all-done':
      return board.cards.length > 0 && board.cards.every((card) => card.declared?.state === 'done');
    case 'any-ready':
      return changed.some(
        (card) => card.derived.pr?.state === 'passed' && card.declared?.state !== 'done',
      );
  }
}

function parseSince(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,12}$/.test(value)) throw new UsageError('--since must be a non-negative integer');
  return Number(value);
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError('--limit must be a whole number between 1 and 500');
  const limit = Number(value);
  if (limit < 1 || limit > 500) throw new UsageError('--limit must be between 1 and 500');
  return limit;
}

function parseTimeoutSeconds(value: string | undefined): number {
  if (value === undefined) return WAIT_DEFAULT_TIMEOUT_SECONDS;
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`--timeout must be a whole number of seconds between 1 and ${WAIT_MAX_TIMEOUT_SECONDS}`);
  }
  const seconds = Number(value);
  if (seconds < 1 || seconds > WAIT_MAX_TIMEOUT_SECONDS) {
    throw new UsageError(`--timeout must be between 1 and ${WAIT_MAX_TIMEOUT_SECONDS} seconds`);
  }
  return seconds;
}

function parseWaitCondition(value: string): BoardWaitCondition {
  if (!(BOARD_WAIT_CONDITIONS as readonly string[]).includes(value)) {
    throw new UsageError(`--until must be one of: ${BOARD_WAIT_CONDITIONS.join(', ')}`);
  }
  return value as BoardWaitCondition;
}

// ───────────────────────── Output helpers ─────────────────────────

function printCard(deps: CoordinationCliDeps, card: SessionCard, json: boolean): void {
  if (json) {
    deps.log(JSON.stringify(card, null, 2));
    return;
  }
  deps.log(formatBoardRow(card, deps.now()));
  if (card.declared?.next) deps.log(`next: ${card.declared.next}`);
}

function printBoard(deps: CoordinationCliDeps, board: Board, json: boolean): void {
  if (json) {
    deps.log(JSON.stringify(board, null, 2));
    return;
  }
  deps.log(formatBoard(board, deps.now()));
  deps.log(`cursor ${board.cursor}`);
}

function printEvents(deps: CoordinationCliDeps, page: TreeEventPage, json: boolean): void {
  if (json) {
    deps.log(JSON.stringify(page, null, 2));
    return;
  }
  for (const event of page.events) deps.log(formatEvent(event));
  deps.log(`cursor ${page.cursor}`);
}

async function fetchBoard(
  deps: CoordinationCliDeps,
  sessionId: string,
  query: { since?: number; ready?: boolean; all?: boolean },
): Promise<Board> {
  return (await deps.api('GET', boardPath(sessionId, query))) as Board;
}

async function fetchEventsPage(
  deps: CoordinationCliDeps,
  sessionId: string,
  query: { since?: number; limit?: number; waitSeconds?: number },
): Promise<TreeEventPage> {
  return (await deps.api('GET', eventsPath(sessionId, query))) as TreeEventPage;
}

// ───────────────────────── status ─────────────────────────

interface StatusOptions {
  json?: boolean;
  plain?: boolean;
  sessionId?: string;
}

interface StatusSetOptions extends StatusOptions {
  state?: string;
  headline?: string;
  progress?: string | boolean;
  on?: string;
  text?: string;
  next?: string | boolean;
  force?: boolean;
}

async function getStatus(deps: CoordinationCliDeps, opts: StatusOptions): Promise<void> {
  const sessionId = requireSessionId(opts.sessionId, deps.env);
  const card = (await deps.api('GET', cardPath(sessionId))) as SessionCard;
  printCard(deps, card, opts.json === true);
}

async function setStatus(deps: CoordinationCliDeps, opts: StatusSetOptions): Promise<void> {
  const sessionId = requireSessionId(opts.sessionId, deps.env);
  const patch = buildCardPatch(opts);
  if (patch.state === 'blocked' && patch.blockedOn === undefined) {
    const current = (await deps.api('GET', cardPath(sessionId))) as SessionCard;
    if (current.declared?.state !== 'blocked') {
      throw new UsageError('--state blocked needs --on <human|parent|external|session:id> and --text');
    }
  }
  const body: CardPatch & { force?: boolean } = opts.force ? { ...patch, force: true } : patch;
  const card = (await deps.api('PUT', cardPath(sessionId), body)) as SessionCard;
  printCard(deps, card, opts.json === true);
}

async function clearStatus(deps: CoordinationCliDeps, opts: StatusOptions): Promise<void> {
  const sessionId = requireSessionId(opts.sessionId, deps.env);
  const data = await deps.api('DELETE', cardPath(sessionId));
  if (opts.json === true) deps.log(JSON.stringify(data, null, 2));
  else deps.log(`card cleared for ${sessionId}`);
}

function statusProgram(deps: CoordinationCliDeps): Command {
  const program = new Command()
    .name('ftown status')
    .description("Show or update this session's status card");
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => deps.log(text.trimEnd()),
    writeErr: (text) => deps.errorLog(text.trimEnd()),
  });
  program
    .option('--json', 'Machine-readable JSON output')
    .option('--plain', 'Human-readable output (default)')
    .option('--session-id <id>', 'Target session; defaults to FTOWN_SESSION_ID')
    .action(async (opts: StatusOptions) => {
      await getStatus(deps, opts);
    });
  program
    .command('set')
    .description('Update the status card')
    .option('--state <s>', `Card state: ${CARD_STATES.join(' | ')}`)
    .option('--headline <t>', 'One-line headline')
    .option('--progress <done/total>', 'Progress, e.g. 3/7')
    .option('--no-progress', 'Clear progress')
    .option('--on <kind>', 'Blocked on: human | parent | external | session:<id>')
    .option('--text <t>', 'Blocked-on detail (required with --on)')
    .option('--next <t>', 'Next step')
    .option('--no-next', 'Clear next step')
    .option('--force', 'Bypass --require-green-pr check (parent session only)')
    .option('--json', 'Machine-readable JSON output')
    .option('--plain', 'Human-readable output (default)')
    .option('--session-id <id>', 'Target session; defaults to FTOWN_SESSION_ID')
    .action(async (opts: StatusSetOptions) => {
      await setStatus(deps, opts);
    });
  program
    .command('clear')
    .description('Clear the status card')
    .option('--json', 'Machine-readable JSON output')
    .option('--plain', 'Human-readable output (default)')
    .option('--session-id <id>', 'Target session; defaults to FTOWN_SESSION_ID')
    .action(async (opts: StatusOptions) => {
      await clearStatus(deps, opts);
    });
  return program;
}

// ───────────────────────── board ─────────────────────────

interface BoardOptions {
  json?: boolean;
  plain?: boolean;
  sessionId?: string;
  since?: string;
  ready?: boolean;
  all?: boolean;
  wait?: boolean;
  until?: string;
  timeout?: string;
}

async function waitForBoard(
  deps: CoordinationCliDeps,
  sessionId: string,
  query: { since?: number; ready?: boolean; all?: boolean },
  condition: BoardWaitCondition,
  timeoutSeconds: number,
  json: boolean,
): Promise<void> {
  // any-done / any-blocked / any-ready apply to children with events after the
  // starting cursor (accumulated across polls). all-done is global. Evaluation
  // uses an unfiltered board; the user-filtered board is what prints.
  const start = await fetchBoard(deps, sessionId, {});
  let cursor = start.cursor;
  const timeoutMs = timeoutSeconds * 1000;
  const deadline = deps.now() + timeoutMs;
  let remainingMs = timeoutMs;
  const eventsSinceStart: TreeEvent[] = [];
  while (remainingMs > 0) {
    const waitSeconds = Math.min(Math.ceil(remainingMs / 1000), EVENTS_WAIT_CHUNK_SECONDS);
    const page = await fetchEventsPage(deps, sessionId, { since: cursor, waitSeconds });
    cursor = page.cursor;
    if (page.events.length > 0) {
      eventsSinceStart.push(...page.events);
      const board = await fetchBoard(deps, sessionId, {});
      if (evaluateWaitCondition(condition, board, eventsSinceStart)) {
        printBoard(deps, await fetchBoard(deps, sessionId, query), json);
        return;
      }
      remainingMs = Math.min(remainingMs, deadline - deps.now());
    } else {
      remainingMs -= waitSeconds * 1000;
      const wallRemaining = deadline - deps.now();
      if (wallRemaining < remainingMs) remainingMs = wallRemaining;
    }
  }
  printBoard(deps, await fetchBoard(deps, sessionId, query), json);
  throw new ExitError(3);
}

async function runBoardCommand(deps: CoordinationCliDeps, opts: BoardOptions): Promise<void> {
  const sessionId = requireSessionId(opts.sessionId, deps.env);
  const since = parseSince(opts.since);
  if (opts.wait && opts.until === undefined) throw new UsageError('--wait requires --until <condition>');
  if (!opts.wait && opts.until !== undefined) throw new UsageError('--until requires --wait');
  if (opts.timeout !== undefined && !opts.wait) throw new UsageError('--timeout requires --wait');
  const timeoutSeconds = parseTimeoutSeconds(opts.timeout);
  const condition = opts.until === undefined ? undefined : parseWaitCondition(opts.until);
  const query = { since, ready: opts.ready === true, all: opts.all === true };
  const json = opts.json === true;
  if (!opts.wait) {
    printBoard(deps, await fetchBoard(deps, sessionId, query), json);
    return;
  }
  await waitForBoard(deps, sessionId, query, condition as BoardWaitCondition, timeoutSeconds, json);
}

function boardProgram(deps: CoordinationCliDeps): Command {
  const program = new Command()
    .name('ftown board')
    .description("Child-session board for this session's tree");
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => deps.log(text.trimEnd()),
    writeErr: (text) => deps.errorLog(text.trimEnd()),
  });
  program
    .option('--json', 'Machine-readable JSON output')
    .option('--plain', 'Human-readable output (default)')
    .option('--since <n>', 'Only children with tree events after this seq')
    .option('--ready', 'Only merge-ready children')
    .option('--all', 'Include archived/completed children')
    .option('--wait', 'Wait until --until condition is met')
    .option('--until <cond>', `Wait condition: ${BOARD_WAIT_CONDITIONS.join(' | ')}`)
    .option('--timeout <s>', `With --wait: give up after this many seconds (1-${WAIT_MAX_TIMEOUT_SECONDS}, default ${WAIT_DEFAULT_TIMEOUT_SECONDS})`)
    .option('--session-id <id>', 'Target session; defaults to FTOWN_SESSION_ID')
    .action(async (opts: BoardOptions) => {
      await runBoardCommand(deps, opts);
    });
  return program;
}

// ───────────────────────── events ─────────────────────────

interface EventsOptions {
  json?: boolean;
  plain?: boolean;
  sessionId?: string;
  since?: string;
  limit?: string;
  wait?: boolean;
  timeout?: string;
}

async function waitForEvents(
  deps: CoordinationCliDeps,
  sessionId: string,
  since: number | undefined,
  limit: number | undefined,
  timeoutSeconds: number,
  json: boolean,
): Promise<void> {
  // Without --since, wait only for events from the current head (board cursor).
  let cursor = since ?? (await fetchBoard(deps, sessionId, {})).cursor;
  const timeoutMs = timeoutSeconds * 1000;
  const deadline = deps.now() + timeoutMs;
  let remainingMs = timeoutMs;
  let lastPage: TreeEventPage = { events: [], cursor };
  while (remainingMs > 0) {
    const waitSeconds = Math.min(Math.ceil(remainingMs / 1000), EVENTS_WAIT_CHUNK_SECONDS);
    const page = await fetchEventsPage(deps, sessionId, { since: cursor, limit, waitSeconds });
    lastPage = page;
    cursor = page.cursor;
    if (page.events.length > 0) {
      printEvents(deps, page, json);
      return;
    }
    remainingMs -= waitSeconds * 1000;
    const wallRemaining = deadline - deps.now();
    if (wallRemaining < remainingMs) remainingMs = wallRemaining;
  }
  printEvents(deps, lastPage, json);
  throw new ExitError(3);
}

async function runEventsCommand(deps: CoordinationCliDeps, opts: EventsOptions): Promise<void> {
  const sessionId = requireSessionId(opts.sessionId, deps.env);
  const since = parseSince(opts.since);
  const limit = parseLimit(opts.limit);
  if (opts.timeout !== undefined && !opts.wait) throw new UsageError('--timeout requires --wait');
  const timeoutSeconds = parseTimeoutSeconds(opts.timeout);
  const json = opts.json === true;
  if (!opts.wait) {
    printEvents(deps, await fetchEventsPage(deps, sessionId, { since, limit }), json);
    return;
  }
  await waitForEvents(deps, sessionId, since, limit, timeoutSeconds, json);
}

function eventsProgram(deps: CoordinationCliDeps): Command {
  const program = new Command()
    .name('ftown events')
    .description("Tree event log for this session's tree");
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => deps.log(text.trimEnd()),
    writeErr: (text) => deps.errorLog(text.trimEnd()),
  });
  program
    .option('--json', 'Machine-readable JSON output')
    .option('--plain', 'Human-readable output (default)')
    .option('--since <n>', 'Only events with seq greater than n')
    .option('--limit <n>', 'Max events (1-500)')
    .option('--wait', 'Wait for new events')
    .option('--timeout <s>', `With --wait: give up after this many seconds (1-${WAIT_MAX_TIMEOUT_SECONDS}, default ${WAIT_DEFAULT_TIMEOUT_SECONDS})`)
    .option('--session-id <id>', 'Target session; defaults to FTOWN_SESSION_ID')
    .action(async (opts: EventsOptions) => {
      await runEventsCommand(deps, opts);
    });
  return program;
}

// ───────────────────────── entry points ─────────────────────────

async function runProgram(
  group: string,
  program: Command,
  argv: string[],
  deps: CoordinationCliDeps,
): Promise<number> {
  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    if (error instanceof ExitError) return error.code;
    if (error instanceof UsageError) {
      deps.errorLog(`ftown ${group}: ${error.message}`);
      if (error.usage) deps.errorLog(error.usage);
      return 2;
    }
    if (error instanceof Error && (error as { status?: unknown }).status === 409) {
      deps.errorLog(`ftown ${group}: ${error.message}`);
      return 5;
    }
    deps.errorLog(`ftown ${group}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function runStatus(argv: string[], deps?: Partial<CoordinationCliDeps>): Promise<number> {
  const resolved = resolveDeps(deps);
  return runProgram('status', statusProgram(resolved), argv, resolved);
}

export async function runBoard(argv: string[], deps?: Partial<CoordinationCliDeps>): Promise<number> {
  const resolved = resolveDeps(deps);
  return runProgram('board', boardProgram(resolved), argv, resolved);
}

export async function runEvents(argv: string[], deps?: Partial<CoordinationCliDeps>): Promise<number> {
  const resolved = resolveDeps(deps);
  return runProgram('events', eventsProgram(resolved), argv, resolved);
}
