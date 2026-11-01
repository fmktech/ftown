import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HOOK_EVENTS = ['Notification', 'Stop', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit'] as const;
const MAIL_PUMP_EVENTS = ['Stop', 'UserPromptSubmit', 'SessionStart'] as const;

import { isFtownNotifyCommand } from './install-notify-script.js';
import { ASK_HOOK_TIMEOUT_SECONDS } from './attention-prompt-protocol.js';

/** Matches `ftown-harness hook-pump` in both bare and absolute-path forms. */
export function isFtownMailPumpCommand(command: string): boolean {
  return command.includes('ftown-harness') && command.includes('hook-pump');
}

function mailPumpCommand(): string {
  return `${join(homedir(), '.ftown', 'bin', 'ftown-harness')} hook-pump`;
}

/** Matches `ftown-harness ask-hook` in both bare and absolute-path forms. */
export function isFtownAskHookCommand(command: string): boolean {
  return command.includes('ftown-harness') && command.includes('ask-hook');
}

function askHookCommand(): string {
  return `${join(homedir(), '.ftown', 'bin', 'ftown-harness')} ask-hook`;
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
  /** Matcher for a newly added entry; defaults to '' (all tools). */
  matcher?: string;
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

  if (spec.matcher === undefined) {
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
    return;
  }

  // Matcher-aware: the entry must live in the group whose matcher is spec.matcher.
  // Matches found in other groups are removed (user hooks in those groups are kept).
  const target = spec.matcher;
  let found = false;
  let changed = false;
  for (let gi = list.length - 1; gi >= 0; gi--) {
    const entry = list[gi];
    if (!isObject(entry)) continue;
    const inner = entry.hooks;
    if (!Array.isArray(inner)) continue;
    const inTarget = (entry.matcher ?? '') === target;
    let removedHere = false;
    for (let hi = inner.length - 1; hi >= 0; hi--) {
      const h = inner[hi];
      if (!isObject(h) || typeof h.command !== 'string' || !spec.matches(h.command)) continue;
      if (inTarget && !found) {
        found = true;
        if (spec.repair(h)) changed = true;
        continue;
      }
      inner.splice(hi, 1);
      removedHere = true;
      changed = true;
    }
    if (removedHere && inner.length === 0) list.splice(gi, 1);
  }

  if (!found) {
    const group = list.find((e) => isObject(e) && (e.matcher ?? '') === target && Array.isArray(e.hooks));
    if (group && Array.isArray(group.hooks)) group.hooks.push({ ...spec.desired });
    else list.push({ matcher: target, hooks: [{ ...spec.desired }] });
    if (changed) spec.counters.repaired++;
    else spec.counters.added++;
  } else if (changed) {
    spec.counters.repaired++;
  } else {
    spec.counters.kept++;
  }
}

export function installClaudeHooks(notifyScriptPath: string): boolean {
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
    return false;
  }

  let parsed: SettingsShape;
  try {
    const trimmed = raw.trim();
    parsed = trimmed.length === 0 ? {} : JSON.parse(trimmed) as SettingsShape;
    if (!isObject(parsed)) {
      console.error('[HookInstaller] failed: settings.json root is not an object');
      return false;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[HookInstaller] failed: ${msg}`);
    return false;
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

  const askCommand = askHookCommand();
  upsertHookEntry(hooks, 'PreToolUse', {
    matches: isFtownAskHookCommand,
    matcher: 'AskUserQuestion',
    desired: { type: 'command', command: askCommand, timeout: ASK_HOOK_TIMEOUT_SECONDS },
    repair: (h) => {
      if (h.command === askCommand && h.timeout === ASK_HOOK_TIMEOUT_SECONDS && h.async === undefined) return false;
      h.command = askCommand;
      h.timeout = ASK_HOOK_TIMEOUT_SECONDS;
      delete h.async;
      return true;
    },
    counters,
  });

  const serialized = JSON.stringify(parsed, null, 2) + '\n';
  const tmpPath = `${settingsPath}.tmp`;
  try {
    writeFileSync(tmpPath, serialized, { mode: 0o600 });
    renameSync(tmpPath, settingsPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[HookInstaller] failed: ${msg}`);
    return false;
  }

  console.log(
    `[HookInstaller] settings.json: added ${counters.added}, repaired ${counters.repaired}, kept ${counters.kept}`,
  );
  return true;
}
