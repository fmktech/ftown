import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HOOK_EVENTS = ['Notification', 'Stop', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit'] as const;
const MAIL_PUMP_EVENTS = ['Stop', 'UserPromptSubmit', 'SessionStart'] as const;

import { isFtownNotifyCommand } from './install-notify-script.js';

/** Matches `ftown-harness hook-pump` in both bare and absolute-path forms. */
export function isFtownMailPumpCommand(command: string): boolean {
  return command.includes('ftown-harness') && command.includes('hook-pump');
}

function mailPumpCommand(): string {
  return `${join(homedir(), '.ftown', 'bin', 'ftown-harness')} hook-pump`;
}

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

interface UpsertSpec {
  matches: (command: string) => boolean;
  desired: HookCommandEntry;
  /** Returns true when an existing entry was modified. */
  repair: (entry: HookCommandEntry) => boolean;
  counters: { added: number; repaired: number; kept: number };
}

function upsertHookEntry(
  hooks: Record<string, HookMatcherEntry[]>,
  event: string,
  spec: UpsertSpec,
): void {
  const existing = hooks[event];
  const list: HookMatcherEntry[] = Array.isArray(existing) ? existing : [];
  hooks[event] = list;

  for (const entry of list) {
    if (!isObject(entry)) continue;
    const inner = entry.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (isObject(h) && typeof h.command === 'string' && spec.matches(h.command)) {
        if (spec.repair(h)) spec.counters.repaired++;
        else spec.counters.kept++;
        return;
      }
    }
  }

  list.push({ matcher: '', hooks: [{ ...spec.desired }] });
  spec.counters.added++;
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

  const counters = { added: 0, repaired: 0, kept: 0 };

  for (const event of HOOK_EVENTS) {
    upsertHookEntry(hooks, event, {
      matches: isFtownNotifyCommand,
      desired: { type: 'command', command: notifyScriptPath, async: true },
      repair: (h) => {
        if (h.command === notifyScriptPath) return false;
        h.command = notifyScriptPath;
        return true;
      },
      counters,
    });
  }

  const pumpCommand = mailPumpCommand();
  for (const event of MAIL_PUMP_EVENTS) {
    upsertHookEntry(hooks, event, {
      matches: isFtownMailPumpCommand,
      desired: { type: 'command', command: pumpCommand, timeout: 30 },
      repair: (h) => {
        if (h.command === pumpCommand && h.timeout === 30 && h.async === undefined) return false;
        h.command = pumpCommand;
        h.timeout = 30;
        delete h.async;
        return true;
      },
      counters,
    });
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

  console.log(
    `[HookInstaller] settings.json: added ${counters.added}, repaired ${counters.repaired}, kept ${counters.kept}`,
  );
}
