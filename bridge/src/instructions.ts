import { randomUUID } from 'node:crypto';
import { constants, appendFileSync, closeSync, fstatSync, futimesSync, renameSync, rmSync, utimesSync, mkdirSync, openSync, readSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { codexHome, claudeConfigDir } from './config-dirs.js';

export const instructionLimit = 64 * 1024;
export type Scope = 'global' | 'bridge';
export const instructionPath = (scope: Scope, home = homedir()) => join(home, '.ftown', scope + '.md');

export function readRevision(scope: Scope, home = homedir()) {
  const fd = openSync(instructionPath(scope, home), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > instructionLimit) throw new Error('Expected an instruction file of at most 64 KiB');
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size !== stat.size) throw new Error('Instruction file changed while reading');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
    return { text, version: Math.round(stat.mtimeMs) };
  } finally { closeSync(fd); }
}

export function readInstructions(scope: Scope, home = homedir()): string {
  return readRevision(scope, home).text;
}

// Equal timestamps use a stable content order so every bridge picks the same winner.
export function mergeGlobal(value: unknown, home = homedir()) {
  const remote = value as Partial<ReturnType<typeof readRevision>> | null;
  if (!remote || typeof remote.text !== 'string' || Buffer.byteLength(remote.text) > instructionLimit
    || typeof remote.version !== 'number' || !Number.isSafeInteger(remote.version) || remote.version < 0
    || !Number.isFinite(new Date(remote.version).getTime())) throw new Error('Invalid instruction revision');
  const local = readRevision('global', home);
  if (remote.version < local.version || (remote.version === local.version && remote.text <= local.text)) return local;
  return writeRevision('global', remote.text, remote.version, home);
}

export function saveInstructions(scope: Scope, text: string, home = homedir()) {
  if (Buffer.byteLength(text) > instructionLimit) throw new Error('Instructions exceed 64 KiB');
  const local = readRevision(scope, home);
  return writeRevision(scope, text, Math.max(Date.now(), local.version + 1), home);
}

function writeRevision(scope: Scope, text: string, version: number, home: string) {
  const file = instructionPath(scope, home);
  const temp = file + '.' + randomUUID();
  try {
    writeFileSync(temp, text, { flag: 'wx', mode: 0o600 });
    const timestamp = new Date(version);
    utimesSync(temp, timestamp, timestamp);
    renameSync(temp, file);
    return { text, version };
  } finally { rmSync(temp, { force: true }); }
}

export function installInstructions(home = homedir(), env = process.env, harness?: 'claude' | 'codex'): void {
  const refs: string[] = [];
  for (const scope of ['global', 'bridge'] as const) {
    const file = instructionPath(scope, home);
    mkdirSync(dirname(file), { recursive: true });
    try {
      const fd = openSync(file, 'wx', 0o600);
      try { futimesSync(fd, new Date(0), new Date(0)); } finally { closeSync(fd); }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    refs.push('Read the ' + scope + ' ftown instructions in `' + file + '`.');
  }
  const files = [];
  if (harness !== 'claude') files.push(join(codexHome(home, env), 'AGENTS.md'));
  if (harness !== 'codex') files.push(join(claudeConfigDir(home, env), 'CLAUDE.md'));
  for (const file of files) {
    mkdirSync(dirname(file), { recursive: true });
    let prior = '';
    try { prior = readFileSync(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const missing = refs.filter(ref => !prior.split(/\r?\n/).includes(ref));
    if (missing.length) appendFileSync(file, (prior ? '\n\n' : '') + missing.join('\n') + '\n', { mode: 0o600 });
  }
}
