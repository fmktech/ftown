import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Cursor CLI hook events with reliable CLI support (see cursor.com/docs/hooks). */
const CURSOR_HOOK_EVENTS = [
  'sessionStart',
  'preToolUse',
  'postToolUse',
  'beforeShellExecution',
  'afterShellExecution',
  'afterFileEdit',
  'stop',
  'beforeSubmitPrompt',
] as const;

import { isFtownNotifyCommand } from './install-notify-script.js';

interface CursorHookEntry {
  command?: string;
  [key: string]: unknown;
}

interface CursorHooksFile {
  version?: number;
  hooks?: Record<string, CursorHookEntry[]>;
  [key: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeHooksFile(settingsPath: string, notifyScriptPath: string, label: string): void {

  let raw: string;
  try {
    if (!existsSync(settingsPath)) {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, '{}\n', { mode: 0o600 });
      raw = '{}';
    } else {
      raw = readFileSync(settingsPath, 'utf8');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CursorHookInstaller] failed: ${msg}`);
    return;
  }

  let parsed: CursorHooksFile;
  try {
    const trimmed = raw.trim();
    parsed = trimmed.length === 0 ? {} : JSON.parse(trimmed) as CursorHooksFile;
    if (!isObject(parsed)) {
      console.error('[CursorHookInstaller] failed: hooks.json root is not an object');
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CursorHookInstaller] failed: ${msg}`);
    return;
  }

  if (typeof parsed.version !== 'number') {
    parsed.version = 1;
  }

  if (!isObject(parsed.hooks)) {
    parsed.hooks = {};
  }
  const hooks = parsed.hooks as Record<string, CursorHookEntry[]>;

  let added = 0;
  let repaired = 0;
  let kept = 0;

  for (const event of CURSOR_HOOK_EVENTS) {
    const list: CursorHookEntry[] = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = list;

    const foundIndex = list.findIndex(
      (entry) =>
        isObject(entry) &&
        typeof entry.command === 'string' &&
        isFtownNotifyCommand(entry.command),
    );

    if (foundIndex === -1) {
      list.push({ command: notifyScriptPath });
      added++;
    } else if (list[foundIndex].command === notifyScriptPath) {
      kept++;
    } else {
      list[foundIndex].command = notifyScriptPath;
      repaired++;
    }
  }

  const serialized = JSON.stringify(parsed, null, 2) + '\n';
  const tmpPath = `${settingsPath}.tmp`;
  try {
    writeFileSync(tmpPath, serialized, { mode: 0o600 });
    renameSync(tmpPath, settingsPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CursorHookInstaller] failed: ${msg}`);
    return;
  }

  console.log(`[CursorHookInstaller] ${label}: added ${added}, repaired ${repaired}, kept ${kept}`);
}

/** User-level ~/.cursor/hooks.json (global Cursor CLI). */
export function installCursorHooks(notifyScriptPath: string): void {
  mergeHooksFile(join(homedir(), '.cursor', 'hooks.json'), notifyScriptPath, 'hooks.json');
}

/** Project-level .cursor/hooks.json — Cursor CLI prefers this when agent runs in a repo. */
export function installProjectCursorHooks(projectRoot: string, notifyScriptPath: string): void {
  const root = resolve(projectRoot);
  const settingsPath = join(root, '.cursor', 'hooks.json');
  try {
    mkdirSync(join(root, '.cursor'), { recursive: true });
    mergeHooksFile(settingsPath, notifyScriptPath, `project hooks (${root})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CursorHookInstaller] project failed: ${msg}`);
  }
}
