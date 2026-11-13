import { randomUUID } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const LOG_PREFIX = '[AntigravityHookInstaller]';
const SAFE_COMMAND_PATH = /^[A-Za-z0-9_./-]+$/;

type TempNameGenerator = (destination: string) => string;

const defaultTempName: TempNameGenerator = (destination) =>
  `${destination}.${process.pid}.${randomUUID()}.tmp`;

let tempNameGenerator: TempNameGenerator = defaultTempName;

/**
 * Test seam: replace the temp-file name generator, or pass null to restore the
 * default. Not for production use; the public install signatures are unchanged.
 */
export function setTempNameGeneratorForTests(generator: TempNameGenerator | null): void {
  tempNameGenerator = generator ?? defaultTempName;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Canonical copy of the ftown hook script under the user's home. */
export function antigravityHookScriptPath(home: string = homedir()): string {
  return join(home, '.ftown', 'antigravity-hook.sh');
}

/**
 * Command string stored in hooks.json. agy runs it with `sh -c`. The path is
 * unquoted when it only contains safe characters, otherwise POSIX single-quoted.
 * The `2>/dev/null || true` guard is required: the entry outlives the script,
 * and a missing script (exit 127) would otherwise block every PreToolUse call.
 * stdout is not redirected, so the Stop `decision` line still passes through.
 */
export function antigravityHookCommand(scriptPath: string): string {
  const quoted = SAFE_COMMAND_PATH.test(scriptPath)
    ? scriptPath
    : `'${scriptPath.split("'").join(`'\\''`)}'`;
  return `${quoted} 2>/dev/null || true`;
}

/** Value stored under the top-level "ftown" key of ~/.gemini/config/hooks.json. */
export function buildAntigravityHookEntry(scriptPath: string): unknown {
  const h = { type: 'command', command: antigravityHookCommand(scriptPath), timeout: 10 };
  return {
    SessionStart: [h],
    PreInvocation: [h],
    PreToolUse: [{ matcher: '*', hooks: [h] }],
    PostToolUse: [{ matcher: '*', hooks: [h] }],
    Stop: [h],
  };
}

/**
 * Atomically replace `destination` with `content`. The temp file is created
 * with openSync(..., 'wx'), so an existing file or symlink at the temp name is
 * never followed or truncated. The call fails with EEXIST in that case; it does
 * not retry with another name. Only a temp file this call created is removed on
 * failure.
 */
function writeFileAtomic(destination: string, content: string | Buffer, mode: number): void {
  const tmpPath = tempNameGenerator(destination);
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(tmpPath, 'wx', mode);
    created = true;
    const openFd = fd;
    fd = undefined;
    writeFileSync(openFd, content);
    closeSync(openFd);
    chmodSync(tmpPath, mode);
    renameSync(tmpPath, destination);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    if (created) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // already gone; nothing else to clean up
      }
    }
    throw err;
  }
}

/**
 * Install the bundled script at `scriptPath`. The file is never visible
 * non-executable: content is written to a temp file, chmodded 0755, then
 * renamed over the destination. Identical content only gets its mode fixed.
 */
function installScript(bundledScriptPath: string, scriptPath: string): void {
  mkdirSync(dirname(scriptPath), { recursive: true });
  const bundled = readFileSync(bundledScriptPath);
  const identical = existsSync(scriptPath) && readFileSync(scriptPath).equals(bundled);
  if (identical) {
    chmodSync(scriptPath, 0o755);
    return;
  }
  writeFileAtomic(scriptPath, bundled, 0o755);
}

/**
 * Where hooks.json really lives. A symlink is followed so the link itself is
 * kept; a dangling or unreadable link yields null.
 */
function resolveHooksTarget(hooksPath: string): string | null {
  let stat;
  try {
    stat = lstatSync(hooksPath);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return hooksPath;
    throw err;
  }
  if (!stat.isSymbolicLink()) return hooksPath;
  try {
    return realpathSync(hooksPath);
  } catch {
    return null;
  }
}

/**
 * Set only the top-level "ftown" key of hooks.json, preserving every other key.
 *
 * Accepted behaviour, not to be changed: the rewrite reformats to 2-space JSON
 * with LF line endings; integer-like top-level keys may be reordered; duplicate
 * keys collapse to the last one; numbers are normalised by JSON round-tripping.
 *
 * Returns false and leaves the target byte-identical when the content is not a
 * JSON object (including a BOM, comments or trailing commas), when the file is
 * not writable by the current user, or when the path is a directory or a
 * dangling symlink.
 */
function mergeHooksFile(hooksPath: string, scriptPath: string): boolean {
  mkdirSync(dirname(hooksPath), { recursive: true });

  const target = resolveHooksTarget(hooksPath);
  if (target === null) {
    console.error(`${LOG_PREFIX} failed: ${hooksPath} is a dangling symlink; left untouched`);
    return false;
  }
  if (isDirectory(target)) {
    console.error(`${LOG_PREFIX} failed: ${target} is a directory; left untouched`);
    return false;
  }

  const existed = existsSync(target);
  if (existed) {
    try {
      accessSync(target, constants.W_OK);
    } catch {
      console.error(`${LOG_PREFIX} failed: ${target} is not writable; left untouched`);
      return false;
    }
  }

  const raw = existed ? readFileSync(target, 'utf8') : null;

  let root: Record<string, unknown> = {};
  if (raw !== null && raw.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(`${LOG_PREFIX} failed: ${target} is not valid JSON (${errorMessage(err)}); left untouched`);
      return false;
    }
    if (!isPlainObject(parsed)) {
      console.error(`${LOG_PREFIX} failed: ${target} root is not a JSON object; left untouched`);
      return false;
    }
    root = parsed;
  }

  root.ftown = buildAntigravityHookEntry(scriptPath);
  const serialized = `${JSON.stringify(root, null, 2)}\n`;
  if (raw === serialized) return true;

  const mode = existed ? statSync(target).mode & 0o777 : 0o644;
  writeFileAtomic(target, serialized, mode);
  console.log(`${LOG_PREFIX} installed ftown hooks into ${target}`);
  return true;
}

/**
 * Register ftown's hook script with the Google Antigravity CLI (agy).
 * Returns false (creating nothing) when `<home>/.gemini` is not a directory.
 * The script is installed before hooks.json is merged, so a false return from
 * the hooks step still leaves the script copied. Never throws.
 */
export function installAntigravityHooks(bundledScriptPath: string, home: string = homedir()): boolean {
  try {
    const geminiDir = join(home, '.gemini');
    if (!isDirectory(geminiDir)) return false;

    if (!existsSync(bundledScriptPath)) {
      console.error(`${LOG_PREFIX} failed: bundled hook script not found at ${bundledScriptPath}`);
      return false;
    }

    const scriptPath = antigravityHookScriptPath(home);
    installScript(bundledScriptPath, scriptPath);
    return mergeHooksFile(join(geminiDir, 'config', 'hooks.json'), scriptPath);
  } catch (err) {
    console.error(`${LOG_PREFIX} failed: ${errorMessage(err)}`);
    return false;
  }
}
