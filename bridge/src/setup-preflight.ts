/**
 * Environment preflight for `ftown setup` and `ftown env doctor`.
 *
 * All I/O is injectable through PreflightEnv so the checks can be exercised with
 * a faked PATH and a faked /etc/os-release. Only what ftown cannot run without
 * (a supported Node and a usable shell) is required; the rest is warned about.
 */
import { accessSync, constants, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export type PackageManager = 'apt' | 'dnf' | 'pacman' | 'apk' | 'brew' | 'zypper';
export type CheckName = 'node' | 'shell' | 'git' | 'tmux' | 'jq' | 'curl';
export type CheckStatus = 'ok' | 'missing' | 'unsupported';

export interface PreflightCheck {
  name: CheckName;
  required: boolean;
  status: CheckStatus;
  detail: string;
  /** Single-tool install command; the report carries the combined command. */
  hint?: string;
}

export interface PreflightReport {
  platform: NodeJS.Platform;
  distro: string;
  packageManager: PackageManager | 'unknown';
  checks: PreflightCheck[];
  problems: string[];
  warnings: string[];
  /** Combined install command for every failing check. */
  hint: string;
  ok: boolean;
}

/** Everything the preflight reads from the machine, injectable for tests. */
export interface PreflightEnv {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  nodeVersion: string;
  osReleasePath: string;
  passwdPath: string;
  uid: number | undefined;
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
}

export function defaultPreflightEnv(): PreflightEnv {
  return {
    env: process.env,
    platform: process.platform,
    nodeVersion: process.versions.node,
    osReleasePath: '/etc/os-release',
    passwdPath: '/etc/passwd',
    uid: process.getuid?.(),
    exists: (path) => {
      try { accessSync(path, constants.X_OK); return true; } catch { return false; }
    },
    readFile: (path) => readFileSync(path, 'utf8'),
  };
}

/** Resolve a binary through PATH (POSIX semantics; empty segments mean cwd). */
export function which(name: string, env: PreflightEnv): string | undefined {
  const path = env.env.PATH;
  if (!path) return undefined;
  for (const segment of path.split(delimiter)) {
    const candidate = join(segment || '.', name);
    if (env.exists(candidate)) return candidate;
  }
  return undefined;
}

export interface DistroInfo { distro: string; packageManager: PackageManager | 'unknown' }

const MANAGER_BY_ID: Record<string, PackageManager> = {
  ubuntu: 'apt', debian: 'apt', linuxmint: 'apt', raspbian: 'apt', pop: 'apt', elementary: 'apt', kali: 'apt',
  fedora: 'dnf', rhel: 'dnf', centos: 'dnf', rocky: 'dnf', almalinux: 'dnf', amzn: 'dnf',
  arch: 'pacman', manjaro: 'pacman', endeavouros: 'pacman',
  alpine: 'apk',
  opensuse: 'zypper', 'opensuse-leap': 'zypper', 'opensuse-tumbleweed': 'zypper', sles: 'zypper', sled: 'zypper',
};

const LIKE_MANAGERS: Array<[needle: string, manager: PackageManager]> = [
  ['debian', 'apt'], ['ubuntu', 'apt'],
  ['fedora', 'dnf'], ['rhel', 'dnf'], ['centos', 'dnf'],
  ['arch', 'pacman'],
  ['suse', 'zypper'],
];

function parseOsRelease(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Detect the distro from /etc/os-release and pick the matching package manager. */
export function detectDistro(env: PreflightEnv): DistroInfo {
  if (env.platform === 'darwin') return { distro: 'darwin', packageManager: 'brew' };
  if (env.platform === 'win32') return { distro: 'windows', packageManager: 'unknown' };
  let release: Record<string, string> = {};
  try { release = parseOsRelease(env.readFile(env.osReleasePath)); } catch { /* unrecognised system */ }
  const id = (release.ID ?? '').toLowerCase();
  const direct = MANAGER_BY_ID[id];
  if (direct) return { distro: id, packageManager: direct };
  const like = (release.ID_LIKE ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  for (const token of [id, ...like]) {
    for (const [needle, manager] of LIKE_MANAGERS) {
      if (token.includes(needle)) return { distro: id || 'unknown', packageManager: manager };
    }
  }
  return { distro: id || 'unknown', packageManager: 'unknown' };
}

const INSTALL_COMMANDS: Record<PackageManager, (packages: string[]) => string> = {
  apt: (p) => `sudo apt-get update && sudo apt-get install -y ${p.join(' ')}`,
  dnf: (p) => `sudo dnf install -y ${p.join(' ')}`,
  pacman: (p) => `sudo pacman -S --noconfirm ${p.join(' ')}`,
  apk: (p) => `apk add --no-cache ${p.join(' ')}`,
  brew: (p) => `brew install ${p.join(' ')}`,
  zypper: (p) => `sudo zypper install -y ${p.join(' ')}`,
};

/** The exact install command for a detected package manager. */
export function installHint(manager: PackageManager | 'unknown', packages: string[]): string {
  if (packages.length === 0) return '';
  if (manager === 'unknown') return `install ${packages.join(', ')} with your system package manager`;
  return INSTALL_COMMANDS[manager](packages);
}

/** Node check. The documented floor is Node.js 22+ (README prerequisites). */
export function nodeStatus(version: string): { ok: boolean; detail: string } {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return { ok: false, detail: `unrecognised Node version "${version}" (Node.js 22+ required)` };
  const major = Number(match[1]);
  const ok = Number.isFinite(major) && major >= 22;
  return {
    ok,
    detail: `v${match[1]}.${match[2]}.${match[3]}${ok ? '' : ' (Node.js 22+ required)'}`,
  };
}

export interface ShellInfo { path: string; source: string }

const SHELL_NAMES = new Set(['bash', 'zsh', 'sh', 'dash']);

function shellName(path: string): string {
  return path.split(/[\\/]/).pop() ?? '';
}

function usable(path: string | undefined, env: PreflightEnv): path is string {
  return !!path && SHELL_NAMES.has(shellName(path)) && env.exists(path);
}

function readPasswdShell(env: PreflightEnv): string | undefined {
  if (env.uid === undefined) return undefined;
  try {
    for (const line of env.readFile(env.passwdPath).split('\n')) {
      const fields = line.split(':');
      if (fields.length >= 7 && fields[2].trim() === String(env.uid)) return fields[6].trim();
    }
  } catch { /* no passwd database available */ }
  return undefined;
}

/**
 * Find a usable shell with the same preference order the shell resolver uses:
 * preferred /bin/zsh, else $SHELL, else the passwd login shell, else bash/sh on PATH.
 */
export function detectShell(env: PreflightEnv): ShellInfo | undefined {
  if (env.exists('/bin/zsh')) return { path: '/bin/zsh', source: 'default shell' };
  if (usable(env.env.SHELL, env)) return { path: env.env.SHELL!, source: '$SHELL' };
  const passwd = readPasswdShell(env);
  if (usable(passwd, env)) return { path: passwd!, source: '/etc/passwd' };
  const bash = which('bash', env);
  if (usable(bash, env)) return { path: bash!, source: 'bash on PATH' };
  const sh = which('sh', env);
  if (usable(sh, env)) return { path: sh!, source: 'sh on PATH' };
  return undefined;
}

const OPTIONAL_CHECKS: CheckName[] = ['git', 'tmux', 'jq', 'curl'];

const CONSEQUENCE: Record<string, string> = {
  git: 'git worktrees and PR status will be unavailable',
  tmux: 'sessions will fall back to the direct runtime',
  jq: 'shell hooks will not report status, attention or session ids',
  curl: 'grok and antigravity hooks will be inert',
};

/** Run every check and build a report. Never throws for a missing tool. */
export function runPreflight(env: PreflightEnv = defaultPreflightEnv()): PreflightReport {
  const { distro, packageManager } = detectDistro(env);
  const checks: PreflightCheck[] = [];

  const node = nodeStatus(env.nodeVersion);
  checks.push({ name: 'node', required: true, status: node.ok ? 'ok' : 'unsupported', detail: node.detail });

  const shell = detectShell(env);
  checks.push({
    name: 'shell',
    required: true,
    status: shell ? 'ok' : 'missing',
    detail: shell ? `${shell.path} (${shell.source})` : 'no usable shell found (bash or zsh required)',
  });

  for (const name of OPTIONAL_CHECKS) {
    const found = which(name, env);
    checks.push({ name, required: false, status: found ? 'ok' : 'missing', detail: found ?? 'not found on PATH' });
  }

  // Only installable tools go in the combined command; node/shell have their own guidance.
  const missingTools = checks.filter((check) => !check.required && check.status === 'missing');
  const hint = installHint(packageManager, missingTools.map((check) => check.name));
  for (const check of checks) {
    if (check.status === 'ok') continue;
    if (check.name === 'node') check.hint = 'upgrade to Node.js 22+';
    else if (check.name === 'shell') check.hint = installHint(packageManager, ['zsh']) || 'install zsh or bash';
    else check.hint = installHint(packageManager, [check.name]);
  }

  const problems = checks
    .filter((check) => check.required && check.status !== 'ok')
    .map((check) => `required ${check.name} check failed: ${check.detail}`);
  const warnings = checks
    .filter((check) => !check.required && check.status === 'missing')
    .map((check) => `${check.name}: not found on PATH (${CONSEQUENCE[check.name]})`);

  return { platform: env.platform, distro, packageManager, checks, problems, warnings, hint, ok: problems.length === 0 };
}

/** Human-readable lines, shared by setup and env doctor. */
export function formatPreflight(report: PreflightReport): string[] {
  const lines = [`ftown preflight (${report.distro}${report.packageManager === 'unknown' ? '' : `, ${report.packageManager}`}):`];
  for (const check of report.checks) {
    const label = `${check.name}:`.padEnd(8);
    const status = check.status === 'ok' ? 'ok' : check.status.toUpperCase();
    lines.push(`  ${label} ${status.padEnd(11)} ${check.detail}${check.required ? ' [required]' : ''}`);
  }
  for (const problem of report.problems) lines.push(`  ERROR ${problem}`);
  for (const warning of report.warnings) lines.push(`  WARN  ${warning}`);
  if (report.hint) lines.push(`  install hint: ${report.hint}`);
  return lines;
}

/** Block setup only on required checks; optional tools are advisory. */
export function assertPreflightReady(report: PreflightReport): void {
  if (!report.ok) throw new Error(report.problems.join('; '));
}
