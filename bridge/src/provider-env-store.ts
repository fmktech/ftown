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

export const PROVIDER_RUNTIME_ENV: Record<string, Record<string, string>> = {
  zai: {
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2[1m]',
    API_TIMEOUT_MS: '3000000',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
  },
  kimi: {
    ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
    API_TIMEOUT_MS: '3000000',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '256000',
  },
  deepseek: {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
    API_TIMEOUT_MS: '3000000',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
  },
  fireworks: {
    ANTHROPIC_BASE_URL: 'https://api.fireworks.ai/inference',
    ANTHROPIC_MODEL: 'accounts/fireworks/models/kimi-k2p6',
    ANTHROPIC_SMALL_FAST_MODEL: 'accounts/fireworks/models/gpt-oss-120b',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'accounts/fireworks/models/gpt-oss-120b',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'accounts/fireworks/models/kimi-k2p6',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'accounts/fireworks/models/deepseek-v4-pro',
    API_TIMEOUT_MS: '3000000',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
  },
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
