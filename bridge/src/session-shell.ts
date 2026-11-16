import { accessSync, constants, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename } from 'node:path';

/**
 * The shells ftown can launch a session with. A login shell is always started
 * with `-l`: zsh reads .zprofile, bash reads the first of .bash_profile /
 * .bash_login / .profile, sh and dash read .profile, and fish runs its login
 * configuration. `-c` keeps the command text in a single argv entry, so no
 * extra `eval` layer is introduced.
 */
export type SessionShellKind = 'zsh' | 'bash' | 'sh' | 'dash' | 'fish';

export interface SessionShell {
  file: string;
  kind: SessionShellKind;
}

export interface ResolveSessionShellOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * passwd/NSS lookup, injectable so resolution tests do not depend on the
   * host account. The default uses os.userInfo().shell, which reads the same
   * getpwuid/getent passwd entry for the current uid.
   */
  readPasswdShell?: () => string | null | undefined;
  isExecutable?: (file: string) => boolean;
}

export type ResolveSessionShell = (options?: ResolveSessionShellOptions) => SessionShell;

function defaultPasswdShell(): string | null | undefined {
  try {
    return userInfo().shell;
  } catch {
    return undefined;
  }
}

function defaultIsExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function shellForFile(file: string | null | undefined): SessionShell | undefined {
  if (!file || !file.startsWith('/')) return undefined;
  const kind = basename(file);
  switch (kind) {
    case 'zsh':
    case 'bash':
    case 'sh':
    case 'dash':
    case 'fish':
      return { file, kind };
    default:
      return undefined;
  }
}

/**
 * Resolve the user's default system shell for every session runtime.
 * Priority: executable $SHELL, executable passwd login shell, /bin/bash,
 * /bin/sh. The final fallback is unconditional so a missing/broken account
 * entry cannot stop the runtime from attempting its most portable launch.
 */
export function resolveSessionShell(options: ResolveSessionShellOptions = {}): SessionShell {
  const env = options.env ?? process.env;
  const readPasswdShell = options.readPasswdShell ?? defaultPasswdShell;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;

  const usable = (candidate: string | null | undefined): SessionShell | undefined => {
    const shell = shellForFile(candidate);
    if (!shell) return undefined;
    try {
      return isExecutable(shell.file) ? shell : undefined;
    } catch {
      return undefined;
    }
  };

  const fromEnv = usable(env.SHELL);
  if (fromEnv) return fromEnv;

  let passwdShell: string | null | undefined;
  try {
    passwdShell = readPasswdShell();
  } catch {
    passwdShell = undefined;
  }
  const fromPasswd = usable(passwdShell);
  if (fromPasswd) return fromPasswd;

  return usable('/bin/bash') ?? { file: '/bin/sh', kind: 'sh' };
}

/**
 * Quote one token for the shell that parses a launch command. Every supported
 * shell (zsh, bash, sh, dash and fish) accepts POSIX single quotes, including
 * the `'\''` escape for an embedded apostrophe, so one renderer covers them
 * all. The `-c` payload is passed as a single argv entry and is never quoted
 * again by the caller.
 */
export function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** argv for a login-shell launch; without a command this is an interactive shell. */
export function sessionShellArgs(shell: SessionShell, command?: string): string[] {
  return ['-l', ...(command === undefined ? [] : ['-c', command])];
}

/**
 * Render a login-shell launch as one command string, for launchers that take a
 * string rather than argv (tmux new-session, the plain shell harness). The
 * outer string is parsed by POSIX sh; the quoted `-c` payload reaches the
 * session shell as a literal command.
 */
export function sessionShellCommandLine(shell: SessionShell, command?: string): string {
  const parts = [quoteShellArgument(shell.file), '-l'];
  if (command !== undefined) parts.push('-c', quoteShellArgument(command));
  return parts.join(' ');
}
