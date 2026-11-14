/**
 * `ftown brief` — manager brief CLI (coordination phase B).
 * Thin client over the local brief API (see coordination/contract-b.ts).
 */
import { readFile } from 'node:fs/promises';
import { Command, CommanderError } from 'commander';
import { api as request, loadPointer } from './cli-client.js';
import { UsageError } from './coordination-cli.js';
import { BRIEF_LIMITS, BRIEF_ROUTES, type SessionBrief } from './coordination/contract-b.js';

/** One local-API call; injectable so tests need no bridge. */
export type BriefApiFn = (method: string, path: string, body?: unknown) => Promise<unknown>;

export interface BriefCliDeps {
  api: BriefApiFn;
  env: NodeJS.ProcessEnv;
  log: (text: string) => void;
  errorLog: (text: string) => void;
  readFile: (path: string) => Promise<Buffer>;
}

const BRIEF_USAGE =
  'Usage: ftown brief show [--json] [--session-id <id>] | ' +
  'ftown brief set (--file <path.md> | --text <t> | --clear) [--json] [--session-id <id>] | ' +
  'ftown brief note <text...> [--json] [--session-id <id>]';

async function defaultApi(method: string, path: string, body?: unknown): Promise<unknown> {
  return request(loadPointer(), method, path, body);
}

function resolveDeps(partial?: Partial<BriefCliDeps>): BriefCliDeps {
  return {
    api: partial?.api ?? defaultApi,
    env: partial?.env ?? process.env,
    log: partial?.log ?? ((text: string) => console.log(text)),
    errorLog: partial?.errorLog ?? ((text: string) => console.error(text)),
    readFile: partial?.readFile ?? ((path: string) => readFile(path)),
  };
}

function requireSessionId(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  const id = (explicit ?? env.FTOWN_SESSION_ID)?.trim();
  if (!id || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
    throw new UsageError('Supply a valid --session-id or set FTOWN_SESSION_ID');
  }
  return id;
}

function briefPath(sessionId: string): string {
  return BRIEF_ROUTES.brief.replace(':id', encodeURIComponent(sessionId));
}

function briefNotesPath(sessionId: string): string {
  return BRIEF_ROUTES.notes.replace(':id', encodeURIComponent(sessionId));
}

interface BriefResponse {
  brief: SessionBrief | null;
}

function formatNoteTime(ts: string): string {
  const date = new Date(ts);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function printBrief(deps: BriefCliDeps, data: unknown, json: boolean): void {
  if (json) {
    deps.log(JSON.stringify(data, null, 2));
    return;
  }
  const brief = (data as BriefResponse | null)?.brief ?? null;
  if (!brief) {
    deps.log('No brief set.');
    return;
  }
  if (brief.text) deps.log(brief.text);
  deps.log('notes:');
  for (const note of brief.notes.slice(-10)) {
    deps.log(`${formatNoteTime(note.ts)} ${note.text}`);
  }
}

interface ShowOptions {
  json?: boolean;
  plain?: boolean;
  sessionId?: string;
}

interface SetOptions extends ShowOptions {
  file?: string;
  text?: string;
  clear?: boolean;
}

async function showBrief(deps: BriefCliDeps, opts: ShowOptions): Promise<void> {
  const sessionId = requireSessionId(opts.sessionId, deps.env);
  const data = await deps.api('GET', briefPath(sessionId));
  printBrief(deps, data, opts.json === true);
}

async function setBrief(deps: BriefCliDeps, opts: SetOptions): Promise<void> {
  const sessionId = requireSessionId(opts.sessionId, deps.env);
  const sources = [opts.file !== undefined, opts.text !== undefined, opts.clear === true].filter(Boolean).length;
  if (sources !== 1) {
    throw new UsageError('Supply exactly one of --file, --text or --clear', BRIEF_USAGE);
  }
  let text: string | null;
  if (opts.clear === true) {
    text = null;
  } else if (opts.file !== undefined) {
    const content = await deps.readFile(opts.file);
    if (content.length > BRIEF_LIMITS.text) {
      throw new Error(`Brief file exceeds ${BRIEF_LIMITS.text} bytes`);
    }
    text = content.toString('utf8');
  } else {
    text = opts.text as string;
    if ([...text].length > BRIEF_LIMITS.text) {
      throw new Error(`Brief text exceeds ${BRIEF_LIMITS.text} characters`);
    }
  }
  const data = await deps.api('PUT', briefPath(sessionId), { text });
  printBrief(deps, data, opts.json === true);
}

async function noteBrief(deps: BriefCliDeps, textParts: string[], opts: ShowOptions): Promise<void> {
  const sessionId = requireSessionId(opts.sessionId, deps.env);
  const text = textParts.join(' ');
  if (!text.trim()) throw new UsageError('Supply the note text', BRIEF_USAGE);
  const data = await deps.api('POST', briefNotesPath(sessionId), { text });
  printBrief(deps, data, opts.json === true);
}

function briefProgram(deps: BriefCliDeps): Command {
  const program = new Command()
    .name('ftown brief')
    .description("Show or update this session's manager brief");
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => deps.log(text.trimEnd()),
    writeErr: (text) => deps.errorLog(text.trimEnd()),
  });
  program
    .command('show')
    .description('Show the brief and its last 10 notes')
    .option('--json', 'Machine-readable JSON output')
    .option('--plain', 'Human-readable output (default)')
    .option('--session-id <id>', 'Target session; defaults to FTOWN_SESSION_ID')
    .action(async (opts: ShowOptions) => {
      await showBrief(deps, opts);
    });
  program
    .command('set')
    .description('Set or clear the brief text (notes are kept)')
    .option('--file <path>', 'Read the brief text from a file')
    .option('--text <t>', 'Brief text')
    .option('--clear', 'Clear the brief text (notes are kept)')
    .option('--json', 'Machine-readable JSON output')
    .option('--plain', 'Human-readable output (default)')
    .option('--session-id <id>', 'Target session; defaults to FTOWN_SESSION_ID')
    .action(async (opts: SetOptions) => {
      await setBrief(deps, opts);
    });
  program
    .command('note')
    .description('Append one note to the brief')
    .argument('<text...>', 'Note text')
    .option('--json', 'Machine-readable JSON output')
    .option('--plain', 'Human-readable output (default)')
    .option('--session-id <id>', 'Target session; defaults to FTOWN_SESSION_ID')
    .action(async (textParts: string[], opts: ShowOptions) => {
      await noteBrief(deps, textParts, opts);
    });
  return program;
}

export async function runBrief(argv: string[], deps?: Partial<BriefCliDeps>): Promise<number> {
  const resolved = resolveDeps(deps);
  try {
    if (argv.length === 0) throw new UsageError('Missing brief command', BRIEF_USAGE);
    await briefProgram(resolved).parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    if (error instanceof UsageError) {
      resolved.errorLog(`ftown brief: ${error.message}`);
      if (error.usage) resolved.errorLog(error.usage);
      return 2;
    }
    resolved.errorLog(`ftown brief: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
