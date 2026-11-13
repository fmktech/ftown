import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const GROK_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'] as const;
const GROK_HOOK_TIMEOUT_SECONDS = 10;
const SCRIPT_MODE = 0o755;
const CONFIG_MODE = 0o600;

/** Absolute path where the Grok hook script is installed: <home>/.ftown/grok-hook.sh. */
export function grokHookScriptPath(home: string = homedir()): string {
  return join(home, '.ftown', 'grok-hook.sh');
}

/**
 * The object written to <home>/.grok/hooks/ftown.json for the given script path.
 * `args: []` makes Grok run the command as one program with no shell, so a
 * home directory containing spaces is not word-split.
 */
export function buildGrokHooksConfig(scriptPath: string): unknown {
  const hooks: Record<string, unknown[]> = {};
  for (const event of GROK_HOOK_EVENTS) {
    hooks[event] = [
      {
        hooks: [
          { type: 'command', command: scriptPath, args: [], timeout: GROK_HOOK_TIMEOUT_SECONDS },
        ],
      },
    ];
  }
  return { hooks };
}

/**
 * Write `content` to `destination` through a uniquely named temp file created
 * exclusively (never follows a pre-existing link), chmod'ed before it is renamed
 * into place so the destination is never visible with the wrong mode.
 */
function writeAtomic(destination: string, content: Buffer | string, mode: number): void {
  const tmpPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    writeFileSync(tmpPath, content, { mode, flag: 'wx' });
    created = true;
    chmodSync(tmpPath, mode);
    renameSync(tmpPath, destination);
  } catch (err) {
    if (created) rmSync(tmpPath, { force: true });
    throw err;
  }
}

/** Installs the bundled Grok hook script and registers it in ~/.grok/hooks/ftown.json. Never throws. */
export function installGrokHooks(bundledScriptPath: string, home: string = homedir()): boolean {
  try {
    const grokDir = join(home, '.grok');
    if (!existsSync(grokDir) || !statSync(grokDir).isDirectory()) return false;

    if (!existsSync(bundledScriptPath)) {
      console.error(`[GrokHookInstaller] failed: bundled script not found at ${bundledScriptPath}`);
      return false;
    }

    const scriptPath = grokHookScriptPath(home);
    const scriptDir = join(home, '.ftown');
    mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
    const bundled = readFileSync(bundledScriptPath);
    const scriptIsCurrent = existsSync(scriptPath) && readFileSync(scriptPath).equals(bundled);
    if (!scriptIsCurrent) {
      writeAtomic(scriptPath, bundled, SCRIPT_MODE);
    }
    // Always enforce the mode, including when the content already matched.
    chmodSync(scriptPath, SCRIPT_MODE);

    const hooksDir = join(grokDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const configPath = join(hooksDir, 'ftown.json');
    const serialized = JSON.stringify(buildGrokHooksConfig(scriptPath), null, 2) + '\n';
    const configIsCurrent = existsSync(configPath) && readFileSync(configPath, 'utf8') === serialized;
    if (!configIsCurrent) {
      writeAtomic(configPath, serialized, CONFIG_MODE);
    }

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[GrokHookInstaller] failed: ${msg}`);
    return false;
  }
}
