import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Self-contained per-provider machine-token store at `~/.ftown/env.json`.
 *
 * Imports ONLY node builtins so the compiled file can be sibling-copied next to
 * the `ftown-env` CLI (which has no further local imports). Never throws on read;
 * writes are atomic (mkdir 0o700 -> write tmp 0o600 -> rename), mirroring the
 * shape of session-registry.ts. Callers MUST mask token values before printing —
 * this module never logs them.
 */

export type ProviderFlavor = 'zai' | 'fireworks' | 'kimi' | 'deepseek';

export const PROVIDER_FLAVORS: readonly ProviderFlavor[] = ['zai', 'fireworks', 'kimi', 'deepseek'];

export interface ProviderAuthMapping {
  source: string;
  target: string;
}

export const PROVIDER_AUTH_ENV: Record<string, ProviderAuthMapping> = {
  zai: { source: 'ZAI_API_TOKEN', target: 'ANTHROPIC_AUTH_TOKEN' },
  fireworks: { source: 'FIREWORKS_API_TOKEN', target: 'ANTHROPIC_AUTH_TOKEN' },
  kimi: { source: 'KIMI_API_TOKEN', target: 'ANTHROPIC_API_KEY' },
  deepseek: { source: 'DEEPSEEK_API_TOKEN', target: 'ANTHROPIC_API_KEY' },
};

// homedir() is read at call time (it resolves $HOME), so the path follows a
// test's $HOME override — the same reason claude-trust.ts recomputes per call.
function envJsonPath(): string {
  return join(homedir(), '.ftown', 'env.json');
}

/** Tolerant loader: returns {} on a missing OR corrupt file. Never throws. */
export function loadProviderEnv(): Record<string, string> {
  try {
    const path = envJsonPath();
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function getProviderToken(key: string): string | undefined {
  return loadProviderEnv()[key];
}

/** Atomic write: mkdir 0o700 -> write `${path}.tmp` mode 0o600 -> renameSync. */
export function setProviderToken(key: string, value: string): void {
  const store = loadProviderEnv();
  store[key] = value;
  const path = envJsonPath();
  mkdirSync(join(homedir(), '.ftown'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/** Removes a key, persisting atomically. Returns whether the key existed. */
export function removeProviderToken(key: string): boolean {
  const store = loadProviderEnv();
  if (!(key in store)) return false;
  delete store[key];
  const path = envJsonPath();
  mkdirSync(join(homedir(), '.ftown'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  return true;
}

/** Raw stored map. CALLERS MUST mask token values before printing. */
export function listProviderEnv(): Record<string, string> {
  return loadProviderEnv();
}
