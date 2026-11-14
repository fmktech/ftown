/**
 * `ftown plan` — manager plan list CLI (coordination phase C).
 * Thin client over the local plan API (see coordination/contract-c.ts).
 */
import { Command, CommanderError } from 'commander';
import { api as request, loadPointer } from './cli-client.js';
import { UsageError } from './coordination-cli.js';
import {
  PLAN_LIMITS,
  PLAN_ROUTES,
  type PlanItem,
  type PlanPriority,
  type PlanState,
  type PlanView,
} from './coordination/contract-c.js';

/** One local-API call; injectable so tests need no bridge. */
export type PlanApiFn = (method: string, path: string, body?: unknown) => Promise<unknown>;

export interface PlanCliDeps {
  api: PlanApiFn;
  env: NodeJS.ProcessEnv;
  log: (text: string) => void;
  errorLog: (text: string) => void;
}

const PLAN_USAGE =
  'Usage: ftown plan [--json] [--session-id <id>] | ' +
  'ftown plan add <title...> [--note <t>] [--after <id,id>] [--priority 1|2|3] [--session-id <id>] | ' +
  'ftown plan start <id> --session <child-id> [--session-id <id>] | ' +
  'ftown plan done|drop|todo <id> [--session-id <id>] | ' +
  'ftown plan edit <id> [--title <t>] [--note <t>|--no-note] [--after <ids>|--no-after] [--priority n] [--session-id <id>] | ' +
  'ftown plan rm <id> [--session-id <id>]';

const ITEM_ID_RE = /^p\d{1,6}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

async function defaultApi(method: string, path: string, body?: unknown): Promise<unknown> {
  return request(loadPointer(), method, path, body);
}

function resolveDeps(partial?: Partial<PlanCliDeps>): PlanCliDeps {
  return {
    api: partial?.api ?? defaultApi,
    env: partial?.env ?? process.env,
    log: partial?.log ?? ((text: string) => console.log(text)),
    errorLog: partial?.errorLog ?? ((text: string) => console.error(text)),
  };
}

function requireSessionId(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  const id = (explicit ?? env.FTOWN_SESSION_ID)?.trim();
  if (!id || !SESSION_ID_RE.test(id)) {
    throw new UsageError('Supply a valid --session-id or set FTOWN_SESSION_ID');
  }
  return id;
}

function planPath(sessionId: string): string {
  return PLAN_ROUTES.plan.replace(':id', encodeURIComponent(sessionId));
}

function itemPath(sessionId: string, itemId: string): string {
  return PLAN_ROUTES.item
    .replace(':id', encodeURIComponent(sessionId))
    .replace(':itemId', encodeURIComponent(itemId));
}

// ───────────────────────── Flag parsing (pure) ─────────────────────────

export function parsePlanItemId(value: string): string {
  const id = value.trim();
  if (!ITEM_ID_RE.test(id)) {
    throw new UsageError(`Invalid plan item id "${value}" (expected p<n>)`);
  }
  return id;
}

export function parsePlanPriority(value: string): PlanPriority {
  if (value !== '1' && value !== '2' && value !== '3') {
    throw new UsageError(`--priority must be 1, 2 or 3 (got "${value}")`);
  }
  return Number(value) as PlanPriority;
}

export function parsePlanAfter(value: string): string[] {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw new UsageError('--after must be a comma-separated list of plan item ids');
  }
  for (const part of parts) parsePlanItemId(part);
  if (parts.length > PLAN_LIMITS.after) {
    throw new UsageError(`--after must list at most ${PLAN_LIMITS.after} items`);
  }
  return parts;
}

function parseChildSessionId(value: string): string {
  const id = value.trim();
  if (!SESSION_ID_RE.test(id)) {
    throw new UsageError('--session requires a valid child session id');
  }
  return id;
}

// ───────────────────────── Output helpers ─────────────────────────

function planMark(item: PlanItem, ready: ReadonlySet<string>): string {
  switch (item.state) {
    case 'todo':
      return ready.has(item.id) ? '→' : '·';
    case 'started':
      return '▸';
    case 'done':
      return '✓';
    case 'dropped':
      return '✗';
  }
}

/**
 * Plain plan row: `<mark> <id> [P<prio>] <title>  (after p1,p2 | → <child name>)`.
 * Ready/waiting comes only from `ready` (the server PlanView.ready ids);
 * the child label is the session name from `childNames`, else the session id.
 */
export function formatPlanItem(
  item: PlanItem,
  ready: ReadonlySet<string> | readonly string[],
  childNames?: ReadonlyMap<string, string>,
): string {
  const readySet = new Set<string>(ready);
  const base = `${planMark(item, readySet)} ${item.id} [P${item.priority}] ${item.title}`;
  const suffix: string[] = [];
  if (item.after.length > 0) suffix.push(`after ${item.after.join(',')}`);
  if (item.sessionId) suffix.push(`→ ${childNames?.get(item.sessionId) ?? item.sessionId}`);
  return suffix.length > 0 ? `${base}  (${suffix.join(' | ')})` : base;
}

/** Plain plan list lines, in the order the API returned them. */
export function formatPlanList(view: PlanView, childNames?: ReadonlyMap<string, string>): string[] {
  const ready = new Set<string>(view.ready);
  return view.items.map((item) => formatPlanItem(item, ready, childNames));
}

/** Session id → name from a GET /api/sessions payload (`{ sessions: [{ id, name }] }`). */
export function parseSessionNames(data: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const sessions = (data as { sessions?: unknown }).sessions;
    if (Array.isArray(sessions)) {
      for (const entry of sessions) {
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
          const id = (entry as { id?: unknown }).id;
          const name = (entry as { name?: unknown }).name;
          if (typeof id === 'string' && typeof name === 'string' && name) names.set(id, name);
        }
      }
    }
  }
  return names;
}

function asPlanView(data: unknown): PlanView {
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const record = data as { items?: unknown; ready?: unknown };
    const items = Array.isArray(record.items) ? (record.items as PlanItem[]) : [];
    const ready = Array.isArray(record.ready)
      ? record.ready.filter((value): value is string => typeof value === 'string')
      : [];
    return { items, ready };
  }
  return { items: [], ready: [] };
}

function asItem(data: unknown): PlanItem {
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const item = (data as { item?: unknown }).item;
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) return item as PlanItem;
  }
  throw new Error('Invalid plan response');
}

async function printItem(
  deps: PlanCliDeps,
  sessionId: string,
  data: unknown,
  json: boolean,
): Promise<void> {
  if (json) {
    deps.log(JSON.stringify(data, null, 2));
    return;
  }
  const mutated = asItem(data);
  // The mutation already succeeded: a failed confirmation GET must not turn
  // it into an error. Fall back to the mutation payload and warn on stderr.
  let view: PlanView = { items: [], ready: [] };
  try {
    view = asPlanView(await deps.api('GET', planPath(sessionId)));
  } catch (error) {
    deps.errorLog(
      `ftown plan: warning: could not refresh the plan (${error instanceof Error ? error.message : String(error)}); showing the mutation result`,
    );
  }
  let childNames = new Map<string, string>();
  try {
    childNames = parseSessionNames(await deps.api('GET', '/api/sessions'));
  } catch (error) {
    deps.errorLog(
      `ftown plan: warning: could not load session names (${error instanceof Error ? error.message : String(error)}); showing session ids`,
    );
  }
  const fresh = view.items.find((item) => item.id === mutated.id) ?? mutated;
  deps.log(formatPlanItem(fresh, new Set<string>(view.ready), childNames));
}

// ───────────────────────── commands ─────────────────────────

interface ListOptions {
  json?: boolean;
  plain?: boolean;
  sessionId?: string;
}

interface AddOptions extends ListOptions {
  note?: string;
  after?: string;
  priority?: string;
}

interface StartOptions extends ListOptions {
  session?: string;
}

interface EditOptions extends ListOptions {
  title?: string;
  note?: string | boolean;
  after?: string | boolean;
  priority?: string;
}

async function listPlan(deps: PlanCliDeps, opts: ListOptions): Promise<void> {
  const sessionId = requireSessionId(opts.sessionId, deps.env);
  const data = await deps.api('GET', planPath(sessionId));
  if (opts.json === true) {
    deps.log(JSON.stringify(data, null, 2));
    return;
  }
  const view = asPlanView(data);
  // One sessions call per list resolves every child name; unknown ids fall back to the id.
  const childNames = parseSessionNames(await deps.api('GET', '/api/sessions'));
  if (view.items.length === 0) {
    deps.log('no plan items');
    return;
  }
  for (const line of formatPlanList(view, childNames)) deps.log(line);
}

export function buildAddBody(titleParts: string[], opts: AddOptions): {
  title: string;
  note?: string;
  after?: string[];
  priority?: PlanPriority;
} {
  const title = titleParts.join(' ');
  if (!title.trim()) throw new UsageError('Supply the plan item title', PLAN_USAGE);
  const body: { title: string; note?: string; after?: string[]; priority?: PlanPriority } = { title };
  if (opts.note !== undefined) body.note = opts.note;
  if (opts.after !== undefined) body.after = parsePlanAfter(opts.after);
  if (opts.priority !== undefined) body.priority = parsePlanPriority(opts.priority);
  return body;
}

async function addPlan(deps: PlanCliDeps, titleParts: string[], opts: AddOptions): Promise<void> {
  const sessionId = requireSessionId(opts.sessionId, deps.env);
  const body = buildAddBody(titleParts, opts);
  const data = await deps.api('POST', planPath(sessionId), body);
  await printItem(deps, sessionId, data, opts.json === true);
}

async function startPlan(deps: PlanCliDeps, rawId: string, opts: StartOptions): Promise<void> {
  const sessionId = requireSessionId(opts.sessionId, deps.env);
  const itemId = parsePlanItemId(rawId);
  if (opts.session === undefined) {
    throw new UsageError('ftown plan start requires --session <child-id>', PLAN_USAGE);
  }
  const childId = parseChildSessionId(opts.session);
  const body: { state: PlanState; sessionId: string } = { state: 'started', sessionId: childId };
  const data = await deps.api('PATCH', itemPath(sessionId, itemId), body);
  await printItem(deps, sessionId, data, opts.json === true);
}

async function setPlanState(
  deps: PlanCliDeps,
  rawId: string,
  state: PlanState,
  opts: ListOptions,
): Promise<void> {
  const sessionId = requireSessionId(opts.sessionId, deps.env);
  const itemId = parsePlanItemId(rawId);
  const data = await deps.api('PATCH', itemPath(sessionId, itemId), { state });
  await printItem(deps, sessionId, data, opts.json === true);
}

export function buildEditPatch(opts: EditOptions): {
  title?: string;
  note?: string | null;
  after?: string[];
  priority?: PlanPriority;
} {
  const patch: {
    title?: string;
    note?: string | null;
    after?: string[];
    priority?: PlanPriority;
  } = {};
  let touched = false;
  if (opts.title !== undefined) {
    if (!opts.title.trim()) throw new UsageError('--title must not be empty');
    patch.title = opts.title;
    touched = true;
  }
  if (typeof opts.note === 'string') {
    patch.note = opts.note;
    touched = true;
  } else if (opts.note === false) {
    patch.note = null;
    touched = true;
  }
  if (typeof opts.after === 'string') {
    patch.after = parsePlanAfter(opts.after);
    touched = true;
  } else if (opts.after === false) {
    patch.after = [];
    touched = true;
  }
  if (opts.priority !== undefined) {
    patch.priority = parsePlanPriority(opts.priority);
    touched = true;
  }
  if (!touched) {
    throw new UsageError(
      'Nothing to edit: supply at least one of --title, --note/--no-note, --after/--no-after or --priority',
      PLAN_USAGE,
    );
  }
  return patch;
}

async function editPlan(deps: PlanCliDeps, rawId: string, opts: EditOptions): Promise<void> {
  const sessionId = requireSessionId(opts.sessionId, deps.env);
  const itemId = parsePlanItemId(rawId);
  const patch = buildEditPatch(opts);
  const data = await deps.api('PATCH', itemPath(sessionId, itemId), patch);
  await printItem(deps, sessionId, data, opts.json === true);
}

async function removePlan(deps: PlanCliDeps, rawId: string, opts: ListOptions): Promise<void> {
  const sessionId = requireSessionId(opts.sessionId, deps.env);
  const itemId = parsePlanItemId(rawId);
  const data = await deps.api('DELETE', itemPath(sessionId, itemId));
  if (opts.json === true) {
    deps.log(JSON.stringify(data, null, 2));
    return;
  }
  deps.log(`removed ${itemId}`);
}

function addJsonSessionOptions(command: Command): Command {
  return command
    .option('--json', 'Machine-readable JSON output')
    .option('--plain', 'Human-readable output (default)')
    .option('--session-id <id>', 'Target session; defaults to FTOWN_SESSION_ID');
}

function planProgram(deps: PlanCliDeps): Command {
  const program = new Command()
    .name('ftown plan')
    .description("Manager plan list for this session's tree");
  program.exitOverride();
  program.enablePositionalOptions();
  program.configureOutput({
    writeOut: (text) => deps.log(text.trimEnd()),
    writeErr: (text) => deps.errorLog(text.trimEnd()),
  });
  program
    .option('--json', 'Machine-readable JSON output')
    .option('--plain', 'Human-readable output (default)')
    .option('--session-id <id>', 'Target session; defaults to FTOWN_SESSION_ID')
    .action(async (opts: ListOptions) => {
      await listPlan(deps, opts);
    });
  addJsonSessionOptions(
    program
      .command('add')
      .description('Add a plan item')
      .argument('<title...>', 'Plan item title'),
  )
    .option('--note <t>', 'Item note')
    .option('--after <id,id>', 'Comma-separated ids that must finish first')
    .option('--priority <n>', 'Priority: 1 (highest), 2 or 3')
    .action(async (titleParts: string[], opts: AddOptions) => {
      await addPlan(deps, titleParts, opts);
    });
  addJsonSessionOptions(
    program
      .command('start')
      .description('Mark an item started by a child session')
      .argument('<id>', 'Plan item id'),
  )
    .option('--session <child-id>', 'Child session doing the item')
    .action(async (id: string, opts: StartOptions) => {
      await startPlan(deps, id, opts);
    });
  addJsonSessionOptions(
    program
      .command('done')
      .description('Mark a plan item done')
      .argument('<id>', 'Plan item id'),
  ).action(async (id: string, opts: ListOptions) => {
    await setPlanState(deps, id, 'done', opts);
  });
  addJsonSessionOptions(
    program
      .command('drop')
      .description('Mark a plan item dropped')
      .argument('<id>', 'Plan item id'),
  ).action(async (id: string, opts: ListOptions) => {
    await setPlanState(deps, id, 'dropped', opts);
  });
  addJsonSessionOptions(
    program
      .command('todo')
      .description('Mark a plan item todo')
      .argument('<id>', 'Plan item id'),
  ).action(async (id: string, opts: ListOptions) => {
    await setPlanState(deps, id, 'todo', opts);
  });
  addJsonSessionOptions(
    program
      .command('edit')
      .description('Edit a plan item')
      .argument('<id>', 'Plan item id'),
  )
    .option('--title <t>', 'New title')
    .option('--note <t>', 'New note')
    .option('--no-note', 'Clear the note')
    .option('--after <ids>', 'Comma-separated ids that must finish first')
    .option('--no-after', 'Clear all predecessors')
    .option('--priority <n>', 'Priority: 1 (highest), 2 or 3')
    .action(async (id: string, opts: EditOptions) => {
      await editPlan(deps, id, opts);
    });
  addJsonSessionOptions(
    program
      .command('rm')
      .description('Remove a plan item')
      .argument('<id>', 'Plan item id'),
  ).action(async (id: string, opts: ListOptions) => {
    await removePlan(deps, id, opts);
  });
  return program;
}

export async function runPlan(argv: string[], deps?: Partial<PlanCliDeps>): Promise<number> {
  const resolved = resolveDeps(deps);
  try {
    await planProgram(resolved).parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    if (error instanceof UsageError) {
      resolved.errorLog(`ftown plan: ${error.message}`);
      if (error.usage) resolved.errorLog(error.usage);
      return 2;
    }
    resolved.errorLog(`ftown plan: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
