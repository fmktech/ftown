import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Dedicated tmux server socket so ftown never touches the user's tmux. */
export const TMUX_SOCKET_NAME = 'ftown';

const SESSION_PREFIX = 'ftown-';

// new-session -e requires tmux >= 3.2; older versions fall back to direct spawn.
const MIN_TMUX_VERSION = 3.02;

let tmuxAvailable: boolean | undefined;

export function isTmuxAvailable(): boolean {
  if (tmuxAvailable === undefined) {
    try {
      const output = execFileSync('tmux', ['-V'], { encoding: 'utf8' });
      const match = /(\d+)\.(\d+)/.exec(output);
      // Unparseable versions (e.g. "tmux next-3.7") are assumed recent enough.
      tmuxAvailable = match
        ? Number(match[1]) + Number(match[2]) / 100 >= MIN_TMUX_VERSION
        : true;
    } catch {
      tmuxAvailable = false;
    }
  }
  return tmuxAvailable;
}

export function tmuxSessionName(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function exitFilePath(sessionId: string): string {
  return join(tmpdir(), `ftown-exit-${sessionId}`);
}

/** Read (and remove) the real exit code of the command that ran inside tmux. */
export function readAndClearExitCode(sessionId: string): number | undefined {
  const path = exitFilePath(sessionId);
  try {
    const raw = readFileSync(path, 'utf8').trim();
    rmSync(path, { force: true });
    const code = Number.parseInt(raw, 10);
    return Number.isNaN(code) ? undefined : code;
  } catch {
    return undefined;
  }
}

function tmuxConfigPath(): string {
  const dir = join(homedir(), '.ftown');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'tmux.conf');
  // Rewritten on every server start so option changes ship with bridge updates.
  // Only applied when the ftown server starts; never touches ~/.tmux.conf.
  writeFileSync(
    path,
    [
      'set -g status off',
      'set -g prefix None',
      'set -g prefix2 None',
      'unbind-key -a -T prefix',
      'unbind-key -a -T root',
      'set -g mouse off',
      'set -g history-limit 100000',
      'set -g remain-on-exit off',
      'set -g destroy-unattached off',
      'set -g exit-empty on',
      'setw -g window-size latest',
      'setw -g aggressive-resize on',
      'set -s escape-time 0',
      'set -g default-terminal "xterm-256color"',
      // Inline TUIs (Claude Code) ignore PageUp/PageDown, so use them to scroll
      // tmux history via copy-mode (-e exits at the bottom). Alternate-screen
      // apps (less, htop) consume the keys themselves — pass through for them.
      'bind-key -n PPage if-shell -F "#{alternate_on}" "send-keys PPage" "copy-mode -eu"',
    ].join('\n') + '\n',
  );
  return path;
}

export interface CreateTmuxSessionOptions {
  sessionId: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  /**
   * Full environment for the command. Delivered via a 0600 file sourced
   * inside the session — never via `new-session -e` argv (visible to other
   * local users) and never via the tmux server env (stale after restarts).
   */
  env: Record<string, string>;
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function envFilePath(sessionId: string): string {
  return join(tmpdir(), `ftown-env-${sessionId}`);
}

export async function createTmuxSession(options: CreateTmuxSessionOptions): Promise<void> {
  const name = tmuxSessionName(options.sessionId);
  // Replace any stale session with the same name (e.g. retry after error).
  await killTmuxSession(options.sessionId);
  rmSync(exitFilePath(options.sessionId), { force: true });

  const envFile = envFilePath(options.sessionId);
  const exports = Object.entries(options.env)
    .filter(([key]) => ENV_KEY_PATTERN.test(key))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n');
  writeFileSync(envFile, exports + '\n', { mode: 0o600 });

  // Capture the real exit code so it survives the tmux attach client, whose
  // own exit code is unrelated. An EXIT trap fires even on explicit `exit`.
  const inner = [
    // buildEnv strips these, but the tmux server env may still carry them.
    'unset NO_COLOR FORCE_COLOR',
    `. ${shellQuote(envFile)}`,
    `command rm -f ${shellQuote(envFile)}`,
    `__ftown_exit_file=${shellQuote(exitFilePath(options.sessionId))}`,
    `trap 'printf "%s" "$?" > "$__ftown_exit_file"' EXIT`,
    options.command,
  ].join('\n');

  const args = [
    '-L', TMUX_SOCKET_NAME,
    '-f', tmuxConfigPath(),
    'new-session', '-d',
    '-s', name,
    '-c', options.cwd,
    '-x', String(options.cols),
    '-y', String(options.rows),
  ];
  // Single-string shell-command keeps compatibility across tmux versions.
  args.push(`/bin/zsh -l -c ${shellQuote(inner)}`);

  await execFileAsync('tmux', args, { env: options.env });
}

export function hasTmuxSession(sessionId: string): boolean {
  try {
    execFileSync(
      'tmux',
      ['-L', TMUX_SOCKET_NAME, 'has-session', '-t', `=${tmuxSessionName(sessionId)}`],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

/** Session ids of all live ftown-* sessions on the dedicated socket. */
export function listFtownTmuxSessions(): string[] {
  try {
    const output = execFileSync(
      'tmux',
      ['-L', TMUX_SOCKET_NAME, 'list-sessions', '-F', '#{session_name}'],
      { encoding: 'utf8' },
    );
    return output
      .split('\n')
      .filter((name) => name.startsWith(SESSION_PREFIX))
      .map((name) => name.slice(SESSION_PREFIX.length));
  } catch {
    return [];
  }
}

export async function killTmuxSession(sessionId: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', [
      '-L', TMUX_SOCKET_NAME,
      'kill-session',
      '-t', `=${tmuxSessionName(sessionId)}`,
    ]);
    return true;
  } catch {
    return false;
  }
}
