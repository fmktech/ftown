import { randomUUID } from 'node:crypto';
import { constants, appendFileSync, closeSync, fstatSync, futimesSync, renameSync, rmSync, utimesSync, mkdirSync, openSync, readSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { codexHome, claudeConfigDir } from './config-dirs.js';

export const INSTRUCTIONS_LOCAL = '/api/instructions';
export const INSTRUCTIONS_WIRE = '/api/instructions/wire';
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
export function pullGlobal(remote: ReturnType<typeof readRevision>, home = homedir()): void {
  const file = instructionPath('global', home);
  const local = readRevision('global', home);
  if (remote.version < local.version || (remote.version === local.version && remote.text <= local.text)) return;
  const temp = file + '.' + randomUUID();
  try {
    writeFileSync(temp, remote.text, { flag: 'wx', mode: 0o600 });
    const timestamp = new Date(remote.version);
    utimesSync(temp, timestamp, timestamp);
    if (local.text && local.text !== remote.text) {
      const backup = temp + '.bak';
      writeFileSync(backup, local.text, { flag: 'wx', mode: 0o600 });
      console.error('Previous instructions saved to ' + backup);
    }
    renameSync(temp, file);
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
