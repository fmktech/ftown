// Real implementations of the fake agent's injected dependencies. Node built-ins only.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUEST, ROLES } from '../contract.ts';
import type { AgentEvent, AgentLogLine, Clock, Role } from '../contract.ts';
import type { CliOpts, CliResult } from './agent.ts';

const DEFAULT_FTOWN_CLI = '/opt/ftown/bridge/dist/ftown-cli.js';
const DEFAULT_TIMEOUT_MS = 120_000;
const HOOK_TIMEOUT_MS = 10_000;

function run(
  file: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number; onStderr?: (chunk: string) => void },
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code, stdout, stderr: timedOut ? `${stderr}timeout` : stderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
    });
    child.stderr.on('data', (d: string) => {
      stderr += d;
      opts.onStderr?.(d);
    });
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => {
      stderr += String(err.message);
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
    child.stdin.end(opts.stdin ?? '');
  });
}

/** `node $FTOWN_CLI <args>` with the agent's environment passed through unchanged. */
export function realCli(): (args: string[], opts?: CliOpts) => Promise<CliResult> {
  const cliPath = process.env.FTOWN_CLI || DEFAULT_FTOWN_CLI;
  return (args, opts) => run(process.execPath, [cliPath, ...args], opts ?? {});
}

/**
 * Posts one hook event through the installed hook script ($CHAOS_HOOK_SCRIPT, bridge/hooks/notify.sh).
 * The script reads the hook JSON on stdin; it exits 0 even when the bridge is unreachable.
 */
export function realHook(): (event: string) => Promise<boolean> {
  return async (event) => {
    const script = process.env.CHAOS_HOOK_SCRIPT;
    if (!script) return false;
    // notify.sh always exits 0 (even with the bridge unreachable), so ok only means "exit code 0".
    const payload = JSON.stringify({ hook_event_name: event, session_id: process.env.FTOWN_SESSION_ID ?? '' });
    const r = await run('/bin/bash', [script], { stdin: payload, timeoutMs: HOOK_TIMEOUT_MS });
    return r.code === 0;
  };
}

/** Session ids by role from the JSON file at $CHAOS_IDS_FILE ({role: id}); re-read on every call. */
export function idsFromFile(path: string | undefined): (role: Role) => string | null {
  return (role) => {
    if (!path) return null;
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const id = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[role] : undefined;
      return typeof id === 'string' && id !== '' ? id : null;
    } catch {
      return null;
    }
  };
}

/** Appends AgentLogLine JSON lines to <dir>/<role>.jsonl; t comes from the Clock. */
export function fileLogger(dir: string, role: Role, clock: Clock): (e: AgentEvent) => void {
  const file = join(dir, `${role}.jsonl`);
  return (e) => {
    const line: AgentLogLine = { t: clock.now(), role, e };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  };
}

/**
 * Shared-epoch clock: now() = floor((hrtime - t0) / 1e6) with t0 (decimal ns string) read once
 * from `path`. Throws when the file is missing or not a decimal integer: no private fallback epoch.
 */
export function epochClock(path: string): Clock {
  const raw = readFileSync(path, 'utf8').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`clock epoch file ${path} does not hold a decimal nanosecond string`);
  const t0 = BigInt(raw);
  return {
    now: () => Number((process.hrtime.bigint() - t0) / 1_000_000n),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
