// Process-truth observers. All return booleans and never throw.
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Role } from '../contract.ts';

export interface ExecResult {
  /** Exit code; null when the command could not run or was killed. */
  code: number | null;
}
export type ExecFn = (file: string, args: string[], env: Readonly<Record<string, string>>) => Promise<ExecResult>;

export interface TmuxOpts {
  /** Bridge user. When set, tmux runs through `runuser -u <user> -- env K=V… tmux …`. */
  user?: string;
  /** HOME / TMUX_TMPDIR (and anything else) the bridge runs with; passed to tmux via env(1). */
  env: Readonly<Record<string, string>>;
  exec?: ExecFn;
}

const TMUX_TIMEOUT_MS = 5_000;

export const defaultExec: ExecFn = (file, args, env) =>
  new Promise((resolve) => {
    try {
      execFile(file, args, { env: { ...process.env, ...env }, timeout: TMUX_TIMEOUT_MS }, (error) => {
        if (!error) return resolve({ code: 0 });
        const code = (error as { code?: unknown }).code;
        resolve({ code: typeof code === 'number' ? code : null });
      });
    } catch {
      resolve({ code: null });
    }
  });

/** The exact command run for tmuxAlive; exported so tests can assert it. */
export function tmuxCommand(id: string, opts: Pick<TmuxOpts, 'user' | 'env'>): { file: string; args: string[] } {
  const tmux = ['tmux', '-L', 'ftown', 'has-session', '-t', `=ftown-${id}`];
  if (!opts.user) return { file: tmux[0], args: tmux.slice(1) };
  const pairs = Object.keys(opts.env).sort().map((k) => `${k}=${opts.env[k]}`);
  return { file: 'runuser', args: ['-u', opts.user, '--', 'env', ...pairs, ...tmux] };
}

export async function tmuxAlive(id: string, opts: TmuxOpts): Promise<boolean> {
  try {
    const { file, args } = tmuxCommand(id, opts);
    const result = await (opts.exec ?? defaultExec)(file, args, opts.user ? {} : opts.env);
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * True when some process's argv contains the consecutive tokens `--role <role>` and a token naming
 * the fake agent. Exact token match: a tmux server whose single argument is the whole command line
 * does not count. A stopped process still counts; a zombie has an empty cmdline and does not.
 */
export async function procAlive(role: Role, opts: { procRoot?: string } = {}): Promise<boolean> {
  const root = opts.procRoot ?? '/proc';
  try {
    const entries = await readdir(root);
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      let raw: string;
      try {
        raw = await readFile(join(root, entry, 'cmdline'), 'utf8');
      } catch {
        continue;
      }
      const argv = raw.split('\0');
      if (!argv.some((a) => a.includes('fake-agent'))) continue;
      for (let i = 0; i + 1 < argv.length; i++) {
        if (argv[i] === '--role' && argv[i + 1] === role) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** /proc/<pid> exists and the process is not a zombie or dead. */
export async function bridgeAlive(pid: number | null, opts: { procRoot?: string } = {}): Promise<boolean> {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  const dir = join(opts.procRoot ?? '/proc', String(pid));
  try {
    await stat(dir);
  } catch {
    return false;
  }
  try {
    const text = await readFile(join(dir, 'stat'), 'utf8');
    const state = text.slice(text.lastIndexOf(')') + 2, text.lastIndexOf(')') + 3);
    return state !== 'Z' && state !== 'X';
  } catch {
    return true;
  }
}
