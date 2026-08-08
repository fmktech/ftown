#!/usr/bin/env node
/**
 * ftown-workflows CLI.
 *
 * Wires the real dependencies (HTTP loopback BridgeClient, node:fs ResultStore,
 * Date.now/setTimeout Clock, stderr Logger), loads a workflow script, and runs it
 * through the engine in `workflow-runner.ts`.
 *
 * Installed to ~/.ftown/ftown-workflows-cli.js by ftown-bridge. Must run INSIDE an
 * ftown session: spawned children need a parent, so FTOWN_SESSION_ID is required.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import { ensureClaudeWorkdirTrust } from './claude-trust.js';
import {
  parseResultFile,
  runWorkflow,
  type BridgeClient,
  type Clock,
  type Logger,
  type RawResult,
  type ResultStore,
  type RunOptions,
  type SpawnSpec,
  type WorkflowEvent,
  type WorkflowModule,
  type WorkflowShell,
} from './workflow-runner.js';

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

// ---- Real BridgeClient: HTTP to the local bridge loopback API ----

class HttpBridgeClient implements BridgeClient {
  private readonly selfSessionId: string;

  constructor(selfSessionId: string) {
    this.selfSessionId = selfSessionId;
  }

  private async api(
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

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private cursorTrustKey(lines: string[], workdir?: string): string | null {
    const text = lines.join('\n');
    if (!text.includes('Workspace Trust Required')) return null;
    if (!text.includes('Do you trust the contents of this directory?')) return null;
    if (workdir && !text.includes(workdir)) return null;
    if (text.includes('[a] Trust this workspace')) return 'a';
    if (text.includes('[y]') || /\b[Yy]es\b/.test(text)) return 'y';
    return null;
  }

  private async acceptCursorWorkspaceTrust(sessionId: string, workdir?: string): Promise<void> {
    // Cursor Agent's `--trust` only applies to headless `--print` mode. Workflow
    // workers are interactive PTYs, so accept only the exact workspace-trust prompt.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { data } = await this.api('GET', `/api/sessions/${sessionId}/screen?offset=0&limit=120`);
      const lines = (data as { lines?: string[] }).lines ?? [];
      const key = this.cursorTrustKey(lines, workdir);
      if (key) {
        await this.api('POST', `/api/sessions/${sessionId}/keys`, { keys: key });
        return;
      }
      await this.sleep(500);
    }
  }

  async createSession(opts: SpawnSpec): Promise<{ id: string }> {
    // Pre-trust the worker's working dir so a claude worker does not block on the
    // "Do you trust this folder?" dialog (which --dangerously-skip-permissions ignores).
    if (opts.shellType === 'claude' && opts.workingDir) {
      ensureClaudeWorkdirTrust(opts.workingDir);
    }
    const body: Record<string, unknown> = {
      prompt: opts.prompt,
      shellType: opts.shellType,
      parentSessionId: opts.parentSessionId,
      // Workflow children report via the result FILE, never via the mail briefing.
      suppressBriefing: true,
    };
    if (opts.workingDir) body.workingDir = opts.workingDir;
    if (opts.name) body.name = opts.name;
    if (opts.model) body.model = opts.model;

    const { data } = await this.api('POST', '/api/sessions', body, {
      'X-Ftown-Session-Id': this.selfSessionId,
    });
    const session = (data as { session?: { id?: string } }).session;
    if (!session?.id) {
      throw new Error('createSession: bridge did not return a session id');
    }
    if (opts.shellType === 'cursor' && opts.workingDir) {
      await this.acceptCursorWorkspaceTrust(session.id, opts.workingDir);
    }
    return { id: session.id };
  }

  async removeSession(id: string): Promise<void> {
    try {
      await this.api('DELETE', `/api/sessions/${id}`);
    } catch {
      // Swallow 404 / already-removed — cleanup must never throw.
    }
  }

  async isRunning(id: string): Promise<boolean> {
    try {
      const { data } = await this.api('GET', `/api/sessions/${id}/running`);
      return (data as { running?: boolean }).running === true;
    } catch {
      // If we cannot reach the session, treat it as no longer running.
      return false;
    }
  }
}

// ---- Real ResultStore: result files under ~/.ftown/workflows/<runId>/<stepKey>.json ----

class FsResultStore implements ResultStore {
  resultPath(runId: string, stepKey: string): string {
    return join(homedir(), '.ftown', 'workflows', runId, `${stepKey}.json`);
  }

  async readResult(path: string): Promise<RawResult | null> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      // ENOENT (file not written yet) and any read error → not ready.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return null;
    }
    return parseResultFile(text);
  }
}

// ---- Real Clock ----

class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

// ---- Real Logger: concise lines to stderr ----

class StderrLogger implements Logger {
  event(ev: WorkflowEvent): void {
    switch (ev.kind) {
      case 'phase':
        process.stderr.write(`\n[phase] ${ev.title}\n`);
        break;
      case 'log':
        process.stderr.write(`  ${ev.message}\n`);
        break;
      case 'agent-start':
        process.stderr.write(`  → start ${ev.label} (${ev.sessionId})\n`);
        break;
      case 'agent-done':
        process.stderr.write(`  ${ev.cached ? '⟳' : '✓'} ${ev.label}\n`);
        break;
      case 'agent-error':
        process.stderr.write(`  ✗ ${ev.label}: ${ev.error}\n`);
        break;
    }
  }
}

// ---- argv parsing ----

// Kept as a literal (this CLI is sibling-copied into ~/.ftown, so it must not
// gain a runtime import of harness-registry.js), but asserted against the
// registry-derived WorkflowShell type so any drift is a compile error.
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const SHELLS = ['claude', 'cursor', 'codex', 'pi', 'opencode', 'shell'] as const satisfies readonly WorkflowShell[];
const _shellsCoverEveryWorkflowShell: Equals<WorkflowShell, (typeof SHELLS)[number]> = true;
void _shellsCoverEveryWorkflowShell;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** Strict integer flag parser: rejects NaN / non-integer / below-min values. */
function parseIntFlag(
  raw: string | undefined,
  name: string,
  min: number,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min} (got "${raw}")`);
  }
  return n;
}

// Flags that consume the following argv token as their value — so positional
// detection must skip that token (otherwise a flag value looks like the script).
const VALUE_FLAGS = [
  '--args',
  '--workdir',
  '--shell',
  '--concurrency',
  '--timeout',
  '--max-agents',
  '--run-id',
];

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function usage(): void {
  console.error(`Usage: ftown-workflows run <script.mjs> [options]

Runs a deterministic multi-session workflow. Must run INSIDE an ftown session
(FTOWN_SESSION_ID must be set — spawned children need a parent).

Options:
  --args <json>        JSON passed to the script as ctx.args
  --workdir <path>     Default working dir for spawned child sessions
  --shell <type>       Default child shell: ${SHELLS.join(' | ')} (default: claude)
  --concurrency <n>    Max concurrently-running child sessions (default: 4)
  --timeout <ms>       Default per-agent timeout in ms (default: 1800000)
  --max-agents <n>     Cap total agent() spawns this run (default: unbounded)
  --run-id <id>        Reuse a run id to RESUME (skips already-completed steps)
  --json               Print the workflow return value as compact JSON

Reads ~/.ftown/bridge.json (ftown-bridge must be running).`);
}

function parseShell(value: string | undefined): WorkflowShell | undefined {
  if (value === undefined) return undefined;
  if ((SHELLS as readonly string[]).includes(value)) return value as WorkflowShell;
  throw new Error(`Invalid --shell "${value}" — use one of: ${SHELLS.join(', ')}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    usage();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  if (argv[0] !== 'run') {
    usage();
    process.exit(1);
  }

  const rest = argv.slice(1);
  const scriptArg = positionals(rest)[0];
  if (!scriptArg) {
    throw new Error('Missing <script.mjs> — usage: ftown-workflows run <script.mjs> [options]');
  }

  const selfSessionId = process.env.FTOWN_SESSION_ID?.trim();
  if (!selfSessionId) {
    throw new Error(
      'FTOWN_SESSION_ID is not set. ftown-workflows must run inside an ftown session ' +
        'so spawned child sessions have a parent.',
    );
  }

  // Fail fast if the bridge is down/misconfigured, instead of running a whole
  // workflow that returns nothing but null results.
  try {
    loadBridge();
  } catch (e) {
    throw new Error(
      'ftown-bridge is not running or ~/.ftown/bridge.json is invalid: ' +
        (e instanceof Error ? e.message : String(e)),
    );
  }

  const jsonOut = hasFlag(rest, '--json');
  const runId = flag(rest, '--run-id') ?? randomUUID().slice(0, 8);
  const concurrencyRaw = flag(rest, '--concurrency');
  const timeoutRaw = flag(rest, '--timeout');
  const maxAgentsRaw = flag(rest, '--max-agents');
  const argsRaw = flag(rest, '--args');

  let parsedArgs: unknown;
  if (argsRaw !== undefined) {
    try {
      parsedArgs = JSON.parse(argsRaw);
    } catch {
      throw new Error('--args must be valid JSON');
    }
  }

  const opts: RunOptions = {
    runId,
    selfSessionId,
    args: parsedArgs,
    defaultShell: parseShell(flag(rest, '--shell')) ?? 'claude',
  };
  // Default child workdir to the orchestrator's cwd so workers never launch in an
  // undefined/untrusted directory; the trust pre-acceptance above keys off this.
  const workdir = flag(rest, '--workdir');
  opts.workdir = workdir ? resolve(workdir) : process.cwd();
  const concurrency = parseIntFlag(concurrencyRaw, '--concurrency', 1);
  if (concurrency !== undefined) opts.maxConcurrent = concurrency;
  const timeout = parseIntFlag(timeoutRaw, '--timeout', 0);
  if (timeout !== undefined) opts.defaultTimeoutMs = timeout;
  const maxAgents = parseIntFlag(maxAgentsRaw, '--max-agents', 0);
  if (maxAgents !== undefined) opts.maxAgents = maxAgents;

  // Run dir holds every step's result file — print it so the user can resume.
  const store = new FsResultStore();
  const runDir = join(homedir(), '.ftown', 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  process.stderr.write(`[ftown-workflows] run ${runId}\n`);
  process.stderr.write(`[ftown-workflows] run dir: ${runDir}\n`);
  process.stderr.write(`[ftown-workflows] resume with: --run-id ${runId}\n`);

  const scriptUrl = pathToFileURL(resolve(scriptArg)).href;
  const mod = (await import(scriptUrl)) as WorkflowModule;

  const deps = {
    bridge: new HttpBridgeClient(selfSessionId),
    store,
    clock: new RealClock(),
    logger: new StderrLogger(),
  };

  const out = await runWorkflow(deps, mod, opts);

  if (out !== undefined) {
    console.log(jsonOut ? JSON.stringify(out) : JSON.stringify(out, null, 2));
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`ftown-workflows: ${msg}`);
  process.exit(1);
});
