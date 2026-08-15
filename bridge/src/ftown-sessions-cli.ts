#!/usr/bin/env node
/**
 * Local API client for ftown cross-session control.
 * Installed to ~/.ftown/ftown-sessions by ftown-bridge.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  MAIL_TYPES,
  formatMailMessage,
  type BridgePointer,
  type LoopDraft,
  type LoopHarness,
  type LoopInfo,
  type LoopSchedule,
  type MailMessage,
  type Session,
  type SessionUsage,
} from './wire-types.js';

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

type SessionInfo = Session;

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

function parseDurationMs(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!match) {
    throw new Error(`${label} must be a duration like 30s, 5m, 2h, or 1000ms`);
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative duration`);
  }
  const unit = match[2] ?? 'ms';
  const factor: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Math.round(value * factor[unit]);
}

function parseNonNegativeInt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function parseRetention(raw: string | undefined): number | null {
  if (raw === undefined) return 10;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'all' || trimmed === 'none' || trimmed === 'null') return null;
  const value = parseNonNegativeInt(trimmed, '--retention');
  return value ?? 10;
}

function parseLoopSchedule(args: string[], required: boolean): LoopSchedule | undefined {
  const every = flag(args, '--every');
  const cron = flag(args, '--cron');
  if (every && cron) throw new Error('Use only one of --every or --cron');
  if (every) {
    const everyMs = parseDurationMs(every, '--every');
    if (!everyMs || everyMs < 1000) throw new Error('--every must be at least 1s');
    return { kind: 'interval', everyMs };
  }
  if (cron) {
    const schedule: LoopSchedule = { kind: 'cron', expression: cron };
    const tz = flag(args, '--tz');
    if (tz) schedule.tz = tz;
    return schedule;
  }
  if (required) throw new Error('Missing schedule: provide --every <duration> or --cron <expr>');
  return undefined;
}

function parseLoopHarness(raw: string | undefined): LoopHarness {
  const harness = (raw ?? 'claude') as LoopHarness;
  if (!['claude', 'cursor', 'codex', 'grok', 'pi', 'kimi-code', 'opencode', 'shell'].includes(harness)) {
    throw new Error(`Invalid --shell "${raw}"`);
  }
  return harness;
}

function parseLoopCreate(args: string[]): LoopDraft {
  const name = flag(args, '--name')?.trim();
  const task = (flag(args, '--task') ?? flag(args, '--prompt'))?.trim();
  if (!name) throw new Error('Missing --name');
  if (!task) throw new Error('Missing --task');

  const preflightCommand = flag(args, '--preflight')?.trim();
  const postflightCommand = flag(args, '--postflight')?.trim();
  const maxRuntime =
    parseDurationMs(flag(args, '--max-runtime'), '--max-runtime') ??
    parseDurationMs(flag(args, '--max-runtime-ms'), '--max-runtime-ms');

  return {
    name,
    schedule: parseLoopSchedule(args, true)!,
    harness: parseLoopHarness(flag(args, '--shell') ?? flag(args, '--harness')),
    workdir: flag(args, '--workdir'),
    task,
    model: flag(args, '--model'),
    enabled: !hasFlag(args, '--disabled'),
    overlapPolicy: hasFlag(args, '--allow-overlap') ? 'allow' : 'skip',
    retention: { autoClearAfterRuns: parseRetention(flag(args, '--retention')) },
    preflight: preflightCommand
      ? {
          command: preflightCommand,
          timeoutMs:
            parseDurationMs(flag(args, '--preflight-timeout'), '--preflight-timeout') ??
            parseDurationMs(flag(args, '--preflight-timeout-ms'), '--preflight-timeout-ms'),
        }
      : undefined,
    postflight: postflightCommand
      ? {
          command: postflightCommand,
          timeoutMs:
            parseDurationMs(flag(args, '--postflight-timeout'), '--postflight-timeout') ??
            parseDurationMs(flag(args, '--postflight-timeout-ms'), '--postflight-timeout-ms'),
          runOnSkip: hasFlag(args, '--postflight-on-skip') || undefined,
        }
      : undefined,
    maxRuntimeMs: maxRuntime,
    group: flag(args, '--group'),
  };
}

function parseLoopPatch(args: string[]): Partial<LoopDraft> {
  const patch: Partial<LoopDraft> = {};
  const name = flag(args, '--name')?.trim();
  const task = (flag(args, '--task') ?? flag(args, '--prompt'))?.trim();
  const workdir = flag(args, '--workdir');
  const model = flag(args, '--model');
  const shell = flag(args, '--shell') ?? flag(args, '--harness');
  const retention = flag(args, '--retention');
  const schedule = parseLoopSchedule(args, false);
  const maxRuntime = flag(args, '--max-runtime') ?? flag(args, '--max-runtime-ms');

  if (name !== undefined) patch.name = name;
  if (task !== undefined) patch.task = task;
  if (workdir !== undefined) patch.workdir = workdir || undefined;
  if (model !== undefined) patch.model = model || undefined;
  if (shell !== undefined) patch.harness = parseLoopHarness(shell);
  if (schedule) patch.schedule = schedule;
  if (retention !== undefined) patch.retention = { autoClearAfterRuns: parseRetention(retention) };
  if (hasFlag(args, '--enabled')) patch.enabled = true;
  if (hasFlag(args, '--disabled')) patch.enabled = false;
  if (hasFlag(args, '--allow-overlap')) patch.overlapPolicy = 'allow';
  if (hasFlag(args, '--skip-overlap')) patch.overlapPolicy = 'skip';
  if (maxRuntime !== undefined) patch.maxRuntimeMs = parseDurationMs(maxRuntime, '--max-runtime');
  const group = flag(args, '--group');
  if (group !== undefined) patch.group = group;

  const preflightCommand = flag(args, '--preflight');
  if (preflightCommand !== undefined) {
    patch.preflight = preflightCommand.trim()
      ? {
          command: preflightCommand.trim(),
          timeoutMs:
            parseDurationMs(flag(args, '--preflight-timeout'), '--preflight-timeout') ??
            parseDurationMs(flag(args, '--preflight-timeout-ms'), '--preflight-timeout-ms'),
        }
      : undefined;
  }

  const postflightCommand = flag(args, '--postflight');
  if (postflightCommand !== undefined) {
    patch.postflight = postflightCommand.trim()
      ? {
          command: postflightCommand.trim(),
          timeoutMs:
            parseDurationMs(flag(args, '--postflight-timeout'), '--postflight-timeout') ??
            parseDurationMs(flag(args, '--postflight-timeout-ms'), '--postflight-timeout-ms'),
          runOnSkip: hasFlag(args, '--postflight-on-skip') || undefined,
        }
      : undefined;
  }

  if (Object.keys(patch).length === 0) throw new Error('No loop fields to update');
  return patch;
}

function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function describeSchedule(schedule: LoopSchedule): string {
  if (schedule.kind === 'interval') return `every ${formatDuration(schedule.everyMs)}`;
  return schedule.tz ? `cron ${schedule.expression} (${schedule.tz})` : `cron ${schedule.expression}`;
}

function formatTimestamp(ts: string | undefined): string {
  if (!ts) return '-';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toISOString();
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
  usage <session-id...>         Model/token usage per session (--json for raw)
  remove <session-id>           Stop and remove a session (archived as a tombstone)
  archive                       List archived (removed) sessions
  revive <session-id>           Recreate a removed session from its tombstone
  loops | loop list             List scheduled loops
  loop create [options]         Create a scheduled loop on this bridge
  loop get <loop-id>            Loop metadata
  loop update <loop-id> [opts]  Update loop fields
  loop run <loop-id>            Request an immediate run
  loop pause|resume <loop-id>   Disable or enable a loop
  loop delete <loop-id>         Delete a loop, stopping any in-flight run
  loop runs <loop-id>           List run sessions for a loop

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
  --orchestrator                Brief the new agent to spawn and coordinate sibling sessions
  --model <name>                Model (cursor, codex)
  --json                        Output raw JSON (default for most commands)

Screen/grep options:
  --offset <n>                  Pagination offset (default: 0)
  --limit <n>                   Max lines/matches (default: 200)

Grep options:
  --pattern <regex>             Required for grep

Loop create/update options:
  --name <label>                Loop name
  --task <text>                 Prompt run each time (alias: --prompt)
  --every <duration>            Interval schedule, e.g. 30s, 5m, 2h
  --cron <expr>                 Cron schedule, e.g. "*/15 * * * *"
  --tz <iana-zone>              Cron timezone
  --shell <type>                claude | cursor | codex | grok | pi | kimi-code | opencode | shell (default: claude)
  --workdir <path>              Working directory
  --model <name>                Agent model
  --disabled                    Create/update as disabled
  --enabled                     Update as enabled
  --allow-overlap               Allow concurrent runs (default is skip)
  --skip-overlap                Update back to skip overlap
  --retention <n|all>           Keep newest N runs, or all (default: 10)
  --preflight <cmd>             Shell guard; non-zero skips the run
  --postflight <cmd>            Shell hook after each run
  --postflight-on-skip          Also run postflight after preflight skip
  --max-runtime <duration>      Force-stop a run after duration
  --group <label>               Optional label the UI uses to fold loops into groups; pass "" on update to clear

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
        if (orchestrator) body.orchestrator = true;
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

      case 'loops':
      case 'loop-list': {
        const { data } = await api('GET', '/api/loops');
        console.log(jsonOut ? JSON.stringify(data, null, 2) : formatLoopList(data));
        break;
      }

      case 'loop': {
        const sub = rest[0];
        const loopArgs = rest.slice(1);
        if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
          usage();
          break;
        }

        switch (sub) {
          case 'list': {
            const { data } = await api('GET', '/api/loops');
            console.log(jsonOut ? JSON.stringify(data, null, 2) : formatLoopList(data));
            break;
          }

          case 'create': {
            const body = parseLoopCreate(loopArgs);
            const { data } = await api('POST', '/api/loops', body);
            console.log(jsonOut ? JSON.stringify(data, null, 2) : formatLoopCreated(data));
            break;
          }

          case 'get': {
            const id = loopArgs.find((a) => !a.startsWith('--'));
            if (!id) throw new Error('Missing loop-id');
            const { data } = await api('GET', `/api/loops/${id}`);
            console.log(JSON.stringify(data, null, 2));
            break;
          }

          case 'update': {
            const id = loopArgs.find((a) => !a.startsWith('--'));
            if (!id) throw new Error('Missing loop-id');
            const patch = parseLoopPatch(loopArgs.slice(1));
            const { data } = await api('PATCH', `/api/loops/${id}`, patch);
            console.log(jsonOut ? JSON.stringify(data, null, 2) : formatLoopCreated(data));
            break;
          }

          case 'run':
          case 'run-now': {
            const id = loopArgs.find((a) => !a.startsWith('--'));
            if (!id) throw new Error('Missing loop-id');
            const { data } = await api('POST', `/api/loops/${id}/run-now`);
            console.log(jsonOut ? JSON.stringify(data, null, 2) : formatLoopRunNow(data));
            break;
          }

          case 'pause':
          case 'disable': {
            const id = loopArgs.find((a) => !a.startsWith('--'));
            if (!id) throw new Error('Missing loop-id');
            const { data } = await api('PATCH', `/api/loops/${id}`, { enabled: false });
            console.log(jsonOut ? JSON.stringify(data, null, 2) : formatLoopCreated(data));
            break;
          }

          case 'resume':
          case 'enable': {
            const id = loopArgs.find((a) => !a.startsWith('--'));
            if (!id) throw new Error('Missing loop-id');
            const { data } = await api('PATCH', `/api/loops/${id}`, { enabled: true });
            console.log(jsonOut ? JSON.stringify(data, null, 2) : formatLoopCreated(data));
            break;
          }

          case 'delete':
          case 'rm': {
            const id = loopArgs.find((a) => !a.startsWith('--'));
            if (!id) throw new Error('Missing loop-id');
            const { data } = await api('DELETE', `/api/loops/${id}`);
            console.log(jsonOut ? JSON.stringify(data, null, 2) : `deleted ${id}`);
            break;
          }

          case 'runs': {
            const id = loopArgs.find((a) => !a.startsWith('--'));
            if (!id) throw new Error('Missing loop-id');
            const { data } = await api('GET', `/api/loops/${id}/runs`);
            console.log(JSON.stringify(data, null, 2));
            break;
          }

          default:
            usage();
            process.exit(1);
        }
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

function formatLoopList(data: unknown): string {
  const loops = (data as { loops?: LoopInfo[] }).loops ?? [];
  if (loops.length === 0) return '(no loops)';
  return loops
    .map((loop) => {
      const status = loop.enabled ? loop.lastStatus ?? 'never' : 'disabled';
      return `${loop.id}  ${status}  ${describeSchedule(loop.schedule)}  next:${formatTimestamp(loop.nextRunAt)}  runs:${loop.runCount}  ${loop.name}`;
    })
    .join('\n');
}

function formatLoopCreated(data: unknown): string {
  const loop = (data as { loop?: LoopInfo }).loop;
  if (!loop) return JSON.stringify(data, null, 2);
  const status = loop.enabled ? loop.lastStatus ?? 'never' : 'disabled';
  return `${loop.id}  ${status}  ${describeSchedule(loop.schedule)}  next:${formatTimestamp(loop.nextRunAt)}  ${loop.name}`;
}

function formatLoopRunNow(data: unknown): string {
  const result = data as { fired?: boolean; reason?: string };
  if (result.fired) return 'run requested';
  return `not fired${result.reason ? `: ${result.reason}` : ''}`;
}

main();
