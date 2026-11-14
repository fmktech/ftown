// The box under test: start/stop the bridge (chaos/box/up.sh, down.sh) and run the ftown CLI as
// the bridge user through the same environment chaos/box/env.sh's as_ftown sets.
import { spawn } from 'node:child_process';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GUEST } from '../contract.ts';

export const BOX_DIR = join(GUEST.chaosDir, 'box');
export const RUN_DIR = '/run/chaos';
export const BRIDGE_PID_FILE = join(RUN_DIR, 'bridge.pid');
export const TMUX_TMPDIR = join(RUN_DIR, 'tmux');
export const PANEL_DIR = '/opt/chaos-seed/panel';

/** Environment of every CLI call and of tmux, as box/env.sh as_ftown sets it. */
export const FTOWN_ENV: Readonly<Record<string, string>> = {
  HOME: GUEST.home,
  USER: GUEST.user,
  LOGNAME: GUEST.user,
  SHELL: '/bin/zsh',
  LANG: 'C.UTF-8',
  TERM: 'xterm-256color',
  PATH: '/opt/chaos-bin:/home/ftown/.ftown/bin:/usr/local/bin:/usr/bin:/bin',
  FTOWN_DATA_DIR: GUEST.dataDir,
  TMUX_TMPDIR,
  FTOWN_SOLO_PANEL_DIR: PANEL_DIR,
};

export interface ExecOut {
  /** Exit code; 124 when the timeout killed it; 127 when it could not be spawned. */
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command with a bounded timeout. Never throws. */
export function exec(file: string, args: readonly string[], opts: { timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<ExecOut> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const child = spawn(file, [...args], { env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (code: number): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (e) => {
      stderr += e.message;
      finish(127);
    });
    child.on('close', (code, signal) => finish(code ?? (signal ? 128 : 1)));
  });
}

/** argv that runs `args` as the bridge user with FTOWN_ENV (plus extra env), like as_ftown. */
export function asFtownArgv(args: readonly string[], extraEnv: Readonly<Record<string, string>> = {}): { file: string; args: string[] } {
  const env = { ...FTOWN_ENV, ...extraEnv };
  const envArgs = Object.keys(env).sort().map((k) => `${k}=${env[k]}`);
  return { file: 'setpriv', args: ['--reuid=1000', '--regid=1000', '--init-groups', '--', 'env', '-i', ...envArgs, ...args] };
}

export function asFtown(args: readonly string[], opts: { timeoutMs: number; env?: Readonly<Record<string, string>> }): Promise<ExecOut> {
  const a = asFtownArgv(args, opts.env);
  return exec(a.file, a.args, { timeoutMs: opts.timeoutMs });
}

/** `ftown <args>` as the bridge user. */
export function ftown(args: readonly string[], opts: { timeoutMs: number; env?: Readonly<Record<string, string>> }): Promise<ExecOut> {
  return asFtown(['ftown', ...args], opts);
}

/** Process state letter from /proc/<pid>/stat, or null when the process does not exist. */
export async function procState(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const m = /\)\s+(\S)/.exec(stat);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Alive = exists and is not a zombie/dead (the supervisor may be PID 1 and never reap). */
export async function isAlive(pid: number | null): Promise<boolean> {
  if (pid === null) return false;
  const s = await procState(pid);
  return s !== null && s !== 'Z' && s !== 'X' && s !== 'x';
}

export async function readBridgePid(): Promise<number | null> {
  try {
    const n = Number((await readFile(BRIDGE_PID_FILE, 'utf8')).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export interface UpResult {
  ok: boolean;
  pid: number | null;
  /** up.sh output, for the side log only. */
  output: string;
}

/** Starts the bridge with box/up.sh (bounded by up.sh's own 60 s readiness wait). */
export async function up(): Promise<UpResult> {
  // up.sh refuses to start when kill -0 succeeds on the old pid; a zombie (unreaped child of a
  // PID-1 supervisor) passes kill -0, so drop a stale pid file first.
  const old = await readBridgePid();
  if (old !== null && !(await isAlive(old))) await rm(BRIDGE_PID_FILE, { force: true });
  const r = await exec('/bin/sh', [join(BOX_DIR, 'up.sh')], { timeoutMs: 90_000 });
  const pid = await readBridgePid();
  return { ok: r.code === 0 && (await isAlive(pid)), pid, output: r.stdout + r.stderr };
}

export async function down(): Promise<ExecOut> {
  return exec('/bin/sh', [join(BOX_DIR, 'down.sh')], { timeoutMs: 30_000 });
}

/** Pids of fake agent processes for a role (argv has `--role <role>` and a fake-agent token), sorted. */
export async function agentPids(role: string): Promise<number[]> {
  const out: number[] = [];
  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    let raw: string;
    try {
      raw = await readFile(`/proc/${e}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (isAgentCmdline(raw, role)) out.push(Number(e));
  }
  return out.sort((a, b) => a - b);
}

/** Exact-token match on a NUL-separated cmdline (a shell wrapping the whole line as one arg does not match). */
export function isAgentCmdline(raw: string, role: string): boolean {
  const argv = raw.split('\0');
  if (!argv.some((a) => a.endsWith('fake-agent/main.ts'))) return false;
  for (let i = 0; i + 1 < argv.length; i++) if (argv[i] === '--role' && argv[i + 1] === role) return true;
  return false;
}
