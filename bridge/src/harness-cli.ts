#!/usr/bin/env node
/**
 * Local bridge harness — talks to ftown-bridge LocalApiServer via ~/.ftown/bridge.json
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { cleanTerminalLine, formatLogLines, isDisplayableLine } from './harness-format.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BRIDGE_JSON = join(homedir(), '.ftown', 'bridge.json');
const REGISTRY_JSON = join(homedir(), '.ftown', 'session-registry.json');

interface BridgePointer {
  port: number;
  token: string;
  bridgeId?: string;
  pid?: number;
  startedAt?: string;
  harness?: string;
  harnessCli?: string;
}

interface Session {
  id: string;
  name: string;
  status: string;
  workingDir?: string;
  shellType?: string;
  model?: string;
}

interface GrepMatch {
  lineNumber: number;
  text: string;
  before?: string[];
  after?: string[];
}

interface RegistryData {
  byWorkspace: Record<string, string>;
  byConversation: Record<string, string>;
}

function loadPointer(): BridgePointer {
  if (!existsSync(BRIDGE_JSON)) {
    const wrapper = join(homedir(), '.ftown', 'bin', 'ftown-harness');
    throw new Error(
      `Bridge not running (no ${BRIDGE_JSON}). Start ftown-bridge from the UI CLI token, then use ${wrapper}`,
    );
  }
  const parsed = JSON.parse(readFileSync(BRIDGE_JSON, 'utf8')) as Partial<BridgePointer>;
  if (!parsed.port || !parsed.token) {
    throw new Error(`Invalid ${BRIDGE_JSON} — missing port or token`);
  }
  return parsed as BridgePointer;
}

function loadRegistry(): RegistryData {
  if (!existsSync(REGISTRY_JSON)) {
    return { byWorkspace: {}, byConversation: {} };
  }
  const parsed = JSON.parse(readFileSync(REGISTRY_JSON, 'utf8')) as Partial<RegistryData>;
  return {
    byWorkspace: parsed.byWorkspace ?? {},
    byConversation: parsed.byConversation ?? {},
  };
}

function emit(json: boolean, data: unknown, text: string): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else console.log(text);
}

async function api<T>(
  pointer: BridgePointer,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `http://127.0.0.1:${pointer.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${pointer.token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `HTTP ${res.status} ${path}`);
  }
  return data;
}

async function listSessions(pointer: BridgePointer): Promise<Session[]> {
  const { sessions } = await api<{ sessions: Session[] }>(pointer, 'GET', '/api/sessions');
  return sessions;
}

async function getSession(pointer: BridgePointer, id: string): Promise<Session> {
  const { session } = await api<{ session: Session }>(pointer, 'GET', `/api/sessions/${id}`);
  return session;
}

async function getLogLineCount(pointer: BridgePointer, id: string): Promise<number> {
  const meta = await api<{ totalLines: number }>(
    pointer,
    'GET',
    `/api/sessions/${id}/screen?limit=1`,
  );
  return meta.totalLines;
}

async function isAlive(pointer: BridgePointer, id: string): Promise<boolean> {
  const { running } = await api<{ running: boolean }>(pointer, 'GET', `/api/sessions/${id}/running`);
  return running;
}

function resolveSessionId(sessions: Session[], query: string): string {
  if (UUID_RE.test(query) || query.length >= 8) {
    const byPrefix = sessions.filter((s) => s.id === query || s.id.startsWith(query));
    if (byPrefix.length === 1) return byPrefix[0].id;
    if (byPrefix.length > 1) {
      throw new Error(
        `Ambiguous id prefix "${query}": ${byPrefix.map((s) => `${s.name} (${s.id.slice(0, 8)}…)`).join(', ')}`,
      );
    }
  }

  const exact = sessions.filter((s) => s.name === query);
  if (exact.length === 1) return exact[0].id;

  const fuzzy = sessions.filter((s) => s.name.toLowerCase().includes(query.toLowerCase()));
  if (fuzzy.length === 1) return fuzzy[0].id;
  if (fuzzy.length > 1) {
    throw new Error(
      `Ambiguous name "${query}": ${fuzzy.map((s) => s.name).join(', ')} — use full name or id prefix`,
    );
  }

  throw new Error(`No session matching "${query}"`);
}

function resolveWorkspaceSessionId(cwd: string): { id: string; workspace: string } | undefined {
  const reg = loadRegistry();
  let dir = resolve(cwd);
  const root = resolve('/');
  while (dir.startsWith(root)) {
    const id = reg.byWorkspace[dir];
    if (id) return { id, workspace: dir };
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function submitSuffix(shellType?: string): string {
  switch (shellType) {
    case 'claude':
    case 'cursor':
      return '\x1b\r';
    default:
      return '\r';
  }
}

async function fetchTail(pointer: BridgePointer, id: string, n: number): Promise<string[]> {
  const totalLines = await getLogLineCount(pointer, id);
  if (totalLines === 0) return [];
  const start = Math.max(0, totalLines - n);
  const scr = await api<{ lines: string[] }>(
    pointer,
    'GET',
    `/api/sessions/${id}/screen?offset=${start}&limit=${n}`,
  );
  return formatLogLines(scr.lines);
}

async function printTail(
  pointer: BridgePointer,
  id: string,
  n: number,
  opts: { header?: string; json?: boolean },
): Promise<string[]> {
  const lines = await fetchTail(pointer, id, n);
  if (opts.json) {
    emit(true, { sessionId: id, lines }, '');
    return lines;
  }
  if (opts.header) console.log(opts.header);
  for (const line of lines) console.log(line);
  return lines;
}

async function cmdStatus(pointer: BridgePointer, json: boolean): Promise<void> {
  let alive = false;
  try {
    await api(pointer, 'GET', '/api/sessions');
    alive = true;
  } catch {
    alive = false;
  }
  const data = {
    bridge: alive ? 'up' : 'down',
    url: `http://127.0.0.1:${pointer.port}`,
    auth: BRIDGE_JSON,
    cli: pointer.harness ?? join(homedir(), '.ftown', 'bin', 'ftown-harness'),
    pid: pointer.pid,
    bridgeId: pointer.bridgeId,
    since: pointer.startedAt,
  };
  if (json) emit(true, data, '');
  else {
    console.log(`bridge: ${data.bridge}`);
    console.log(`url:    ${data.url}`);
    console.log(`auth:   ${data.auth}`);
    console.log(`cli:    ${data.cli}`);
    if (data.pid) console.log(`pid:    ${data.pid}`);
    if (data.bridgeId) console.log(`id:     ${data.bridgeId}`);
    if (data.since) console.log(`since:  ${data.since}`);
  }
}

async function cmdLs(
  pointer: BridgePointer,
  opts: { tail: number; json: boolean },
): Promise<void> {
  const sessions = await listSessions(pointer);
  if (sessions.length === 0) {
    emit(opts.json, { sessions: [] }, '(no sessions)');
    return;
  }

  const cwd = resolve(process.cwd());
  const hereResolved = resolveWorkspaceSessionId(cwd);
  const hereId = hereResolved?.id;
  const rows: Record<string, unknown>[] = [];

  for (const s of sessions.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))) {
    const logLines = await getLogLineCount(pointer, s.id);
    const alive =
      s.status === 'running' ? await isAlive(pointer, s.id) : false;
    const hasLog = logLines > 0;
    const mark = s.id === hereId;
    const row = {
      mark,
      name: s.name,
      id: s.id,
      status: s.status,
      alive,
      shellType: s.shellType,
      workingDir: s.workingDir,
      logLines,
      hasLog,
    };
    rows.push(row);

    if (!opts.json) {
      const wd = s.workingDir ? `…${s.workingDir.slice(-30)}` : '';
      const logLabel = hasLog ? `log=${logLines}` : 'no log';
      const proc = alive ? 'alive' : 'dead ';
      console.log(
        `${mark ? '*' : ' '} ${s.name.padEnd(14)} ${s.id.slice(0, 8)}… ${s.status.padEnd(9)} ${proc} ${logLabel.padEnd(12)} ${(s.shellType ?? '?').padEnd(7)} ${wd}`,
      );
      if (opts.tail > 0 && hasLog) {
        const lines = await fetchTail(pointer, s.id, opts.tail);
        for (const line of lines) console.log(`    ${line.slice(0, 120)}`);
      }
    }
  }

  if (opts.json) {
    emit(true, { sessions: rows, hereWorkspace: hereResolved?.workspace }, '');
  } else if (hereId) {
    console.log('\n* = session for current working directory');
  }
}

async function cmdHere(
  pointer: BridgePointer,
  opts: { lines: number; cwd?: string; json: boolean },
): Promise<void> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const resolved = resolveWorkspaceSessionId(cwd);
  if (!resolved) {
    emit(opts.json, { error: 'no_registry', cwd }, `No registry entry for workspace tree from: ${cwd}`);
    return;
  }
  const { id, workspace } = resolved;
  const session = await getSession(pointer, id);
  const alive = await isAlive(pointer, id);
  const logLines = await getLogLineCount(pointer, id);

  const meta = {
    session,
    registryWorkspace: workspace,
    alive,
    logLines,
    hasLog: logLines > 0,
  };

  if (opts.json) {
    const out: Record<string, unknown> = { ...meta };
    if (opts.lines > 0 && logLines > 0) {
      out.tail = await fetchTail(pointer, id, opts.lines);
    }
    emit(true, out, '');
    return;
  }

  console.log(`${session.name} (${id})`);
  console.log(`registry=${workspace}`);
  console.log(`status=${session.status} alive=${alive} shell=${session.shellType ?? '?'} log=${logLines}`);
  if (session.workingDir) console.log(`cwd=${session.workingDir}`);

  if (opts.lines <= 0) return;

  if (logLines === 0) {
    console.log('---');
    console.log('(no terminal log yet)');
    return;
  }

  if (!alive) {
    console.log(`---`);
    console.log(`# process not running — showing last ${opts.lines} log lines (status=${session.status})`);
  } else {
    console.log('---');
  }

  await printTail(pointer, id, opts.lines, {});
}

async function cmdTail(
  pointer: BridgePointer,
  query: string,
  opts: { lines: number; json: boolean },
): Promise<void> {
  const sessions = await listSessions(pointer);
  const id = resolveSessionId(sessions, query);
  const session = await getSession(pointer, id);
  const logLines = await getLogLineCount(pointer, id);
  if (opts.json) {
    emit(
      true,
      { session, logLines, lines: await fetchTail(pointer, id, opts.lines) },
      '',
    );
    return;
  }
  console.log(`# ${session.name} (${id}) log=${logLines}`);
  await printTail(pointer, id, opts.lines, {});
}

function printGrepMatch(m: GrepMatch, context: number): void {
  if (context > 0 && m.before?.length) {
    const startLine = m.lineNumber - m.before.length;
    for (let i = 0; i < m.before.length; i++) {
      const t = cleanTerminalLine(m.before[i]);
      if (isDisplayableLine(t)) console.log(`  ${startLine + i}- ${t.slice(0, 200)}`);
    }
  }
  const hit = cleanTerminalLine(m.text);
  if (isDisplayableLine(hit)) console.log(`${m.lineNumber}: ${hit.slice(0, 200)}`);
  if (context > 0 && m.after?.length) {
    for (let j = 0; j < m.after.length; j++) {
      const t = cleanTerminalLine(m.after[j]);
      if (isDisplayableLine(t)) console.log(`  ${m.lineNumber + j + 1}- ${t.slice(0, 200)}`);
    }
  }
}

async function cmdGrep(
  pointer: BridgePointer,
  query: string,
  pattern: string,
  opts: { limit: number; offset: number; context: number; json: boolean },
): Promise<void> {
  const sessions = await listSessions(pointer);
  const id = resolveSessionId(sessions, query);
  const result = await api<{
    matches: GrepMatch[];
    totalMatches: number;
  }>(pointer, 'POST', `/api/sessions/${id}/grep`, {
    pattern,
    offset: opts.offset,
    limit: opts.limit,
    ...(opts.context > 0 ? { context: opts.context } : {}),
  });

  if (opts.json) {
    const cleaned = result.matches.map((m) => ({
      lineNumber: m.lineNumber,
      text: cleanTerminalLine(m.text),
      before: m.before?.map(cleanTerminalLine).filter(isDisplayableLine),
      after: m.after?.map(cleanTerminalLine).filter(isDisplayableLine),
    }));
    emit(true, { totalMatches: result.totalMatches, matches: cleaned }, '');
    return;
  }

  console.log(`# matches ${result.totalMatches} (showing ${result.matches.length})`);
  for (const m of result.matches) {
    if (opts.context > 0) printGrepMatch(m, opts.context);
    else {
      const hit = cleanTerminalLine(m.text);
      if (isDisplayableLine(hit)) console.log(`${m.lineNumber}: ${hit.slice(0, 200)}`);
    }
  }
}

async function cmdSend(
  pointer: BridgePointer,
  query: string,
  text: string,
  opts: { submit: boolean; literal: boolean; dryRun: boolean; json: boolean },
): Promise<void> {
  const sessions = await listSessions(pointer);
  const id = resolveSessionId(sessions, query);
  const session = await getSession(pointer, id);
  let keys = text;
  if (opts.submit) keys += submitSuffix(session.shellType);

  const plan = {
    sessionId: id,
    name: session.name,
    shellType: session.shellType,
    submit: opts.submit,
    bytes: keys.length,
    dryRun: opts.dryRun,
  };

  if (opts.dryRun) {
    emit(opts.json, plan, `dry-run: would send ${keys.length} bytes to ${session.name} (submit=${opts.submit})`);
    return;
  }

  await api(pointer, 'POST', `/api/sessions/${id}/keys`, { keys });
  emit(opts.json, { ...plan, sent: true }, `sent ${keys.length} bytes to ${session.name} (submit=${opts.submit})`);
}

const program = new Command();
program
  .name('ftown-harness')
  .description('CLI for ftown bridge local API (~/.ftown/bridge.json)')
  .option('--json', 'Machine-readable JSON output');

program
  .command('status')
  .description('Bridge pointer and health')
  .action(async (_opts, cmd) => {
    const pointer = loadPointer();
    await cmdStatus(pointer, !!cmd.parent?.opts().json);
  });

program
  .command('ls')
  .description('List sessions (* = cwd workspace)')
  .option('-n, --tail <n>', 'Preview last N log lines per session (incl. dead)', '0')
  .action(async (opts: { tail: string }, cmd) => {
    const pointer = loadPointer();
    await cmdLs(pointer, {
      tail: parseInt(opts.tail, 10) || 0,
      json: !!cmd.parent?.opts().json,
    });
  });

program
  .command('here')
  .description('Session for current workspace (from registry)')
  .option('-n, --lines <n>', 'Tail lines (works for dead sessions with logs)', '15')
  .option('--cwd <path>', 'Workspace path (default: process.cwd())')
  .action(async (opts: { lines: string; cwd?: string }, cmd) => {
    const pointer = loadPointer();
    await cmdHere(pointer, {
      lines: parseInt(opts.lines, 10) || 15,
      cwd: opts.cwd,
      json: !!cmd.parent?.opts().json,
    });
  });

program
  .command('tail <session>')
  .description('Last N lines of terminal (ANSI/OSC stripped)')
  .option('-n, --lines <n>', 'Line count', '40')
  .action(async (session: string, opts: { lines: string }, cmd) => {
    const pointer = loadPointer();
    await cmdTail(pointer, session, {
      lines: parseInt(opts.lines, 10) || 40,
      json: !!cmd.parent?.opts().json,
    });
  });

program
  .command('grep <session> <pattern>')
  .description('Search terminal log (regex)')
  .option('-n, --limit <n>', 'Max matches', '30')
  .option('--offset <n>', 'Match offset', '0')
  .option('-C, --context <n>', 'Lines of context before/after each match', '0')
  .action(async (session: string, pattern: string, opts: { limit: string; offset: string; context: string }, cmd) => {
    const pointer = loadPointer();
    await cmdGrep(pointer, session, pattern, {
      limit: parseInt(opts.limit, 10) || 30,
      offset: parseInt(opts.offset, 10) || 0,
      context: parseInt(opts.context, 10) || 0,
      json: !!cmd.parent?.opts().json,
    });
  });

program
  .command('send <session> <text...>')
  .description('Send keystrokes (--submit adds Enter for shell type)')
  .option('-s, --submit', 'Append submit sequence after text')
  .option('-l, --literal', 'Do not interpret escape sequences in text')
  .option('--dry-run', 'Print what would be sent without writing to PTY')
  .action(async (session: string, textParts: string[], opts: { submit?: boolean; literal?: boolean; dryRun?: boolean }, cmd) => {
    const pointer = loadPointer();
    let text = textParts.join(' ');
    if (!opts.literal) {
      text = text.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\x1b/g, '\x1b');
    }
    await cmdSend(pointer, session, text, {
      submit: !!opts.submit,
      literal: !!opts.literal,
      dryRun: !!opts.dryRun,
      json: !!cmd.parent?.opts().json,
    });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`ftown-harness: ${msg}`);
  process.exit(1);
});
