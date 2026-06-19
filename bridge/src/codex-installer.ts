import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { CANONICAL_NOTIFY_PATH, isFtownNotifyCommand } from './install-notify-script.js';
import { isFtownMailPumpCommand } from './hook-installer.js';

const execAsync = promisify(exec);

/**
 * Codex hooks fire on these events in the TUI; the payload schema and output
 * protocol are Claude-compatible. Stop/UserPromptSubmit must omit "matcher".
 */
const CODEX_HOOK_EVENTS = ['Stop', 'UserPromptSubmit', 'SessionStart'] as const;
const CODEX_NOTIFY_TIMEOUT_SECONDS = 10;

interface HookCommandEntry {
  type?: string;
  command?: string;
  timeout?: number;
  async?: boolean;
  [key: string]: unknown;
}

interface HookMatcherEntry {
  matcher?: string;
  hooks?: HookCommandEntry[];
  [key: string]: unknown;
}

interface CodexHooksFile {
  hooks?: Record<string, HookMatcherEntry[]>;
  [key: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the `codex` binary is reachable on PATH (cheap probe). */
export async function codexBinaryAvailable(): Promise<boolean> {
  try {
    await execAsync('command -v codex', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

interface UpsertSpec {
  matches: (command: string) => boolean;
  desired: HookCommandEntry;
  /** Returns true when an existing entry was modified. */
  repair: (entry: HookCommandEntry) => boolean;
  counters: { added: number; repaired: number; kept: number };
}

function upsertCodexHookEntry(
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

  // No "matcher" field: codex does not support matchers on these events.
  list.push({ hooks: [{ ...spec.desired }] });
  spec.counters.added++;
}

/**
 * Merge ftown hook entries into ~/.codex/hooks.json (Claude-settings-shaped
 * schema). Installs `<harness> hook-pump` (mail delivery at turn boundaries)
 * and the notify.sh forwarder on Stop / UserPromptSubmit / SessionStart.
 * Idempotent; preserves unknown content; atomic tmp+rename.
 */
export function ensureCodexHooks(
  harnessBinPath: string,
  notifyScriptPath: string = CANONICAL_NOTIFY_PATH,
): void {
  const hooksPath = join(homedir(), '.codex', 'hooks.json');

  let raw: string;
  try {
    if (!existsSync(hooksPath)) {
      mkdirSync(dirname(hooksPath), { recursive: true });
      writeFileSync(hooksPath, '{}\n', { mode: 0o600 });
      raw = '{}';
    } else {
      raw = readFileSync(hooksPath, 'utf8');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CodexHookInstaller] failed: ${msg}`);
    return;
  }

  let parsed: CodexHooksFile;
  try {
    const trimmed = raw.trim();
    parsed = trimmed.length === 0 ? {} : JSON.parse(trimmed) as CodexHooksFile;
    if (!isObject(parsed)) {
      console.error('[CodexHookInstaller] failed: hooks.json root is not an object');
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CodexHookInstaller] failed: ${msg}`);
    return;
  }

  if (!isObject(parsed.hooks)) {
    parsed.hooks = {};
  }
  const hooks = parsed.hooks as Record<string, HookMatcherEntry[]>;

  const counters = { added: 0, repaired: 0, kept: 0 };
  const pumpCommand = `${harnessBinPath} hook-pump`;

  for (const event of CODEX_HOOK_EVENTS) {
    upsertCodexHookEntry(hooks, event, {
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

    upsertCodexHookEntry(hooks, event, {
      matches: isFtownNotifyCommand,
      desired: { type: 'command', command: notifyScriptPath, timeout: CODEX_NOTIFY_TIMEOUT_SECONDS },
      repair: (h) => {
        if (
          h.command === notifyScriptPath
          && h.timeout === CODEX_NOTIFY_TIMEOUT_SECONDS
          && h.async === undefined
        ) {
          return false;
        }
        h.command = notifyScriptPath;
        h.timeout = CODEX_NOTIFY_TIMEOUT_SECONDS;
        delete h.async;
        return true;
      },
      counters,
    });
  }

  const serialized = JSON.stringify(parsed, null, 2) + '\n';
  const tmpPath = `${hooksPath}.tmp`;
  try {
    writeFileSync(tmpPath, serialized, { mode: 0o600 });
    renameSync(tmpPath, hooksPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CodexHookInstaller] failed: ${msg}`);
    return;
  }

  console.log(
    `[CodexHookInstaller] hooks.json: added ${counters.added}, repaired ${counters.repaired}, kept ${counters.kept}`,
  );
}

/** Escape a path for use inside a TOML basic (double-quoted) key. */
function tomlEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Ensure ~/.codex/config.toml trusts `dir`, so spawned codex TUIs skip the
 * blocking "Do you trust this directory?" prompt. The section key must be the
 * resolved real path (macOS /tmp -> /private/tmp); `-c` overrides do not work.
 * String-level check + append only — the file holds user content and is never
 * parsed or rewritten. Idempotent.
 */
export function ensureCodexWorkdirTrust(dir: string): void {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // Path may not exist yet; fall back to the input verbatim.
  }

  const configPath = join(homedir(), '.codex', 'config.toml');

  let raw = '';
  try {
    if (existsSync(configPath)) {
      raw = readFileSync(configPath, 'utf8');
    } else {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, '', { mode: 0o600 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CodexTrust] failed to read config.toml: ${msg}`);
    return;
  }

  const header = `[projects."${tomlEscape(real)}"]`;
  // Line-anchored: a commented-out `# [projects...]` line must not count.
  if (raw.split('\n').some((line) => line.trim() === header)) return;

  const lead = raw.length > 0 && !raw.endsWith('\n') ? '\n' : '';
  const section = `${lead}\n${header}\ntrust_level = "trusted"\n`;

  const tmpPath = `${configPath}.tmp`;
  try {
    writeFileSync(tmpPath, raw + section, { mode: 0o600 });
    renameSync(tmpPath, configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CodexTrust] failed to write config.toml: ${msg}`);
    return;
  }

  console.log(`[CodexTrust] trusted workdir ${real}`);
}
