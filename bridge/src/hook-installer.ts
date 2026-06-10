import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HOOK_EVENTS = ['Notification', 'Stop', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit'] as const;

import { isFtownNotifyCommand } from './install-notify-script.js';

interface HookCommandEntry {
  type?: string;
  command?: string;
  async?: boolean;
  [key: string]: unknown;
}

interface HookMatcherEntry {
  matcher?: string;
  hooks?: HookCommandEntry[];
  [key: string]: unknown;
}

interface SettingsShape {
  hooks?: Record<string, HookMatcherEntry[]>;
  [key: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function installClaudeHooks(notifyScriptPath: string): void {
  const settingsPath = join(homedir(), '.claude', 'settings.json');

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
    console.error(`[HookInstaller] failed: ${msg}`);
    return;
  }

  let parsed: SettingsShape;
  try {
    const trimmed = raw.trim();
    parsed = trimmed.length === 0 ? {} : JSON.parse(trimmed) as SettingsShape;
    if (!isObject(parsed)) {
      console.error('[HookInstaller] failed: settings.json root is not an object');
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[HookInstaller] failed: ${msg}`);
    return;
  }

  if (!isObject(parsed.hooks)) {
    parsed.hooks = {};
  }
  const hooks = parsed.hooks as Record<string, HookMatcherEntry[]>;

  let added = 0;
  let repaired = 0;
  let kept = 0;

  for (const event of HOOK_EVENTS) {
    const existing = hooks[event];
    const list: HookMatcherEntry[] = Array.isArray(existing) ? existing : [];
    hooks[event] = list;

    let foundIndex = -1;
    let foundHookIndex = -1;
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (!isObject(entry)) continue;
      const inner = (entry as HookMatcherEntry).hooks;
      if (!Array.isArray(inner)) continue;
      for (let j = 0; j < inner.length; j++) {
        const h = inner[j];
        if (isObject(h) && typeof h.command === 'string' && isFtownNotifyCommand(h.command)) {
          foundIndex = i;
          foundHookIndex = j;
          break;
        }
      }
      if (foundIndex !== -1) break;
    }

    if (foundIndex === -1) {
      list.push({
        matcher: '',
        hooks: [{ type: 'command', command: notifyScriptPath, async: true }],
      });
      added++;
    } else {
      const inner = list[foundIndex].hooks as HookCommandEntry[];
      const target = inner[foundHookIndex];
      if (target.command === notifyScriptPath) {
        kept++;
      } else {
        target.command = notifyScriptPath;
        repaired++;
      }
    }
  }

  const serialized = JSON.stringify(parsed, null, 2) + '\n';
  const tmpPath = `${settingsPath}.tmp`;
  try {
    writeFileSync(tmpPath, serialized, { mode: 0o600 });
    renameSync(tmpPath, settingsPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[HookInstaller] failed: ${msg}`);
    return;
  }

  console.log(`[HookInstaller] settings.json: added ${added}, repaired ${repaired}, kept ${kept}`);
}
