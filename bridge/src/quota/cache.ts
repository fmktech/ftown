import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { QUOTA_PROVIDER_IDS } from './types.js';
import type { ProviderModels, ProviderQuota, QuotaProviderId, QuotaStatus } from './types.js';

/**
 * On-disk result cache for `ftown quota`.
 *
 * Each CLI call is a separate process, so the cache lives in
 * `<homeDir>/.ftown/quota-cache.json` (see {@link resolveQuotaCachePath}).
 * Entries are keyed by provider id. A provider's fetcher already resolves
 * the account from `homeDir` (for example Claude credentials under
 * `<homeDir>/.claude`), and multi-pool providers such as `agy` carry their
 * pools inside the single row's `scopedLimits`, so one entry per provider
 * is also per-account / per-pool-set for the current provider shapes.
 * One provider's entry never evicts another's: writes merge by provider.
 *
 * TTL: `ok` rows serve for {@link QUOTA_CACHE_TTL_MS} (5 minutes); every
 * non-`ok` row (including the error rows produced for hung/timed-out
 * fetches) serves for at most {@link QUOTA_CACHE_ERROR_TTL_MS} (30 s).
 *
 * Time: `observedAt` is wall-clock ISO so entries survive restarts. A row
 * whose `observedAt` is in the future relative to the caller's clock (a
 * backwards clock jump, or a file written by a machine ahead of this one)
 * is treated as expired, never as fresh. In-process waiting uses timers,
 * not wall-clock arithmetic, so a clock jump cannot extend a wait.
 *
 * Invalidation hook: {@link invalidateQuotaCacheEntry} drops one
 * provider's entry. There is currently no bridge code path outside the
 * quota fetchers themselves that observes a provider rate-limit/quota
 * error from a running session (session failure handling does not parse
 * provider quota errors), so the hook is not yet wired to a caller. Wire
 * it where such an observation lands — for example session exit/error
 * handling that detects a provider quota-exhaustion or rate-limit
 * response should call `invalidateQuotaCacheEntry(homeDir, provider)`
 * so the next `ftown quota` refetches that provider live instead of
 * serving a stale `ok` row. The fetchers' own non-`ok` rows need no
 * invalidation: they are already cached only for the short error TTL.
 */

export const QUOTA_CACHE_TTL_MS = 5 * 60_000;
export const QUOTA_CACHE_ERROR_TTL_MS = 30_000;
/** A lock whose holder pid is dead is stale at once; a corrupt lock is stale after this age. */
export const QUOTA_CACHE_STALE_LOCK_MS = 30_000;
export const QUOTA_CACHE_LOCK_POLL_MS = 50;
export const QUOTA_CACHE_RELATIVE_PATH = '.ftown/quota-cache.json';

const MAX_CACHE_BYTES = 1024 * 1024;
const QUOTA_STATUSES: readonly QuotaStatus[] = ['ok', 'no_data', 'auth', 'unavailable', 'error'];
const MODELS_STATUSES: readonly ProviderModels['status'][] = ['ok', 'unavailable', 'error'];

export interface QuotaCacheEntry {
  quota: ProviderQuota | null;
  models: ProviderModels | null;
}

export interface QuotaCacheFile {
  version: 1;
  entries: Partial<Record<QuotaProviderId, QuotaCacheEntry>>;
}

export interface QuotaCacheLockHandle {
  path: string;
  token: string;
  release: () => Promise<void>;
}

function homeIsSet(homeDir: string): boolean {
  return typeof homeDir === 'string' && homeDir !== '' && isAbsolute(homeDir);
}

/** Absolute cache path, or `""` when `homeDir` is not an absolute path. */
export function resolveQuotaCachePath(homeDir: string): string {
  return homeIsSet(homeDir) ? join(homeDir, QUOTA_CACHE_RELATIVE_PATH) : '';
}

/** Lock file path next to the cache file, or `""` when the cache is disabled. */
export function resolveQuotaCacheLockPath(homeDir: string): string {
  const cachePath = resolveQuotaCachePath(homeDir);
  return cachePath === '' ? '' : `${cachePath}.lock`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidQuotaRow(value: unknown, provider: QuotaProviderId): value is ProviderQuota {
  if (!isRecord(value)) return false;
  if (value.provider !== provider) return false;
  if (typeof value.status !== 'string' || !(QUOTA_STATUSES as readonly string[]).includes(value.status)) return false;
  if (!(value.plan === null || typeof value.plan === 'string')) return false;
  if (!Array.isArray(value.windows)) return false;
  for (const window of value.windows) {
    if (!isRecord(window)) return false;
    if (window.kind !== 'five_hour' && window.kind !== 'weekly') return false;
    if (!(window.usedPercent === null || (typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)))) return false;
    if (!(window.resetsAt === null || typeof window.resetsAt === 'string')) return false;
    if (!(window.windowMinutes === null || (typeof window.windowMinutes === 'number' && Number.isFinite(window.windowMinutes)))) return false;
    if (!(window.note === null || typeof window.note === 'string')) return false;
  }
  if (value.source !== 'live' && value.source !== 'cached') return false;
  if (typeof value.observedAt !== 'string' || Number.isNaN(Date.parse(value.observedAt))) return false;
  if (!(value.message === null || typeof value.message === 'string')) return false;
  if (value.scopedLimits !== undefined) {
    if (!Array.isArray(value.scopedLimits)) return false;
    for (const limit of value.scopedLimits) {
      if (!isRecord(limit)) return false;
      if (typeof limit.scope !== 'string') return false;
      if (limit.kind !== 'five_hour' && limit.kind !== 'weekly') return false;
      if (!(limit.usedPercent === null || (typeof limit.usedPercent === 'number' && Number.isFinite(limit.usedPercent)))) return false;
      if (!(limit.resetsAt === null || typeof limit.resetsAt === 'string')) return false;
    }
  }
  return true;
}

function isValidModelsRow(value: unknown, provider: QuotaProviderId): value is ProviderModels {
  if (!isRecord(value)) return false;
  if (value.provider !== provider) return false;
  if (typeof value.status !== 'string' || !(MODELS_STATUSES as readonly string[]).includes(value.status)) return false;
  if (!Array.isArray(value.models)) return false;
  if (value.source !== 'live' && value.source !== 'cached') return false;
  if (typeof value.observedAt !== 'string' || Number.isNaN(Date.parse(value.observedAt))) return false;
  if (!(value.message === null || typeof value.message === 'string')) return false;
  if (typeof value.modelFlag !== 'string') return false;
  if (!(value.effortFlag === null || typeof value.effortFlag === 'string')) return false;
  return true;
}

function emptyCache(): QuotaCacheFile {
  return { version: 1, entries: {} };
}

function parseCacheFile(text: string): QuotaCacheFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyCache();
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.entries)) return emptyCache();
  const entries: Partial<Record<QuotaProviderId, QuotaCacheEntry>> = {};
  for (const provider of QUOTA_PROVIDER_IDS) {
    const raw = parsed.entries[provider];
    if (!isRecord(raw)) continue;
    const quota = isValidQuotaRow(raw.quota, provider) ? (raw.quota as ProviderQuota) : null;
    const models = isValidModelsRow(raw.models, provider) ? (raw.models as ProviderModels) : null;
    if (quota === null && models === null) continue;
    entries[provider] = { quota, models };
  }
  return { version: 1, entries };
}

/** Reads the cache; a missing, unreadable, oversized or corrupt file reads as empty. Never throws. */
export async function readQuotaCache(homeDir: string): Promise<QuotaCacheFile> {
  const cachePath = resolveQuotaCachePath(homeDir);
  if (cachePath === '') return emptyCache();
  try {
    const info = await stat(cachePath);
    if (!info.isFile() || info.size > MAX_CACHE_BYTES) return emptyCache();
    return parseCacheFile(await readFile(cachePath, 'utf8'));
  } catch {
    return emptyCache();
  }
}

/** Atomically replaces the cache file (temp file + rename). Never throws. */
export async function writeQuotaCache(homeDir: string, cache: QuotaCacheFile): Promise<void> {
  const cachePath = resolveQuotaCachePath(homeDir);
  if (cachePath === '') return;
  const directory = dirname(cachePath);
  const temp = join(directory, `.quota-cache.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, cachePath);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

/** Merges fetched rows into the on-disk cache, preserving every other provider. Never throws. */
export async function storeQuotaCacheEntries(
  homeDir: string,
  quotaRows: readonly ProviderQuota[],
  modelRows: readonly ProviderModels[],
): Promise<void> {
  if (quotaRows.length === 0 && modelRows.length === 0) return;
  const cache = await readQuotaCache(homeDir);
  for (const row of quotaRows) {
    const entry = cache.entries[row.provider] ?? { quota: null, models: null };
    entry.quota = row;
    cache.entries[row.provider] = entry;
  }
  for (const row of modelRows) {
    const entry = cache.entries[row.provider] ?? { quota: null, models: null };
    entry.models = row;
    cache.entries[row.provider] = entry;
  }
  await writeQuotaCache(homeDir, cache);
}

/**
 * Drops one provider's cached quota and model rows; other providers are
 * preserved. See the module header for where a bridge quota-error
 * observation should call this. Never throws.
 */
export async function invalidateQuotaCacheEntry(homeDir: string, provider: QuotaProviderId): Promise<void> {
  const cachePath = resolveQuotaCachePath(homeDir);
  if (cachePath === '') return;
  try {
    const cache = await readQuotaCache(homeDir);
    if (!(provider in cache.entries)) return;
    delete cache.entries[provider];
    await writeQuotaCache(homeDir, cache);
  } catch {
    // Best effort: a failed invalidation only leaves a TTL-bounded stale row.
  }
}

export function quotaRowTtlMs(status: QuotaStatus, ttlMs: number = QUOTA_CACHE_TTL_MS, errorTtlMs: number = QUOTA_CACHE_ERROR_TTL_MS): number {
  return status === 'ok' ? ttlMs : errorTtlMs;
}

export function modelsRowTtlMs(status: ProviderModels['status'], ttlMs: number = QUOTA_CACHE_TTL_MS, errorTtlMs: number = QUOTA_CACHE_ERROR_TTL_MS): number {
  return status === 'ok' ? ttlMs : errorTtlMs;
}

/**
 * True when `row` may still serve at wall time `nowMs`. A future
 * `observedAt` (backwards clock) is expired, never fresh.
 */
export function isQuotaRowFresh(
  row: ProviderQuota,
  nowMs: number,
  ttlMs: number = QUOTA_CACHE_TTL_MS,
  errorTtlMs: number = QUOTA_CACHE_ERROR_TTL_MS,
): boolean {
  const observedMs = Date.parse(row.observedAt);
  if (!Number.isFinite(observedMs) || !Number.isFinite(nowMs)) return false;
  if (observedMs > nowMs) return false;
  const age = nowMs - observedMs;
  return age >= 0 && age < quotaRowTtlMs(row.status, ttlMs, errorTtlMs);
}

export function isModelsRowFresh(
  row: ProviderModels,
  nowMs: number,
  ttlMs: number = QUOTA_CACHE_TTL_MS,
  errorTtlMs: number = QUOTA_CACHE_ERROR_TTL_MS,
): boolean {
  const observedMs = Date.parse(row.observedAt);
  if (!Number.isFinite(observedMs) || !Number.isFinite(nowMs)) return false;
  if (observedMs > nowMs) return false;
  const age = nowMs - observedMs;
  return age >= 0 && age < modelsRowTtlMs(row.status, ttlMs, errorTtlMs);
}

export function asCachedQuota(row: ProviderQuota): ProviderQuota {
  const copy: ProviderQuota = {
    ...row,
    source: 'cached',
    windows: row.windows.map(window => ({ ...window })),
  };
  if (row.scopedLimits !== undefined) copy.scopedLimits = row.scopedLimits.map(limit => ({ ...limit }));
  return copy;
}

export function asCachedModels(row: ProviderModels): ProviderModels {
  return {
    ...row,
    source: 'cached',
    models: row.models.map(model => ({ ...model, efforts: [...model.efforts] })),
  };
}

/** The provider's quota row from `cache` when fresh at `nowMs`, marked `cached`; else null. */
export function cachedQuotaRow(
  cache: QuotaCacheFile,
  provider: QuotaProviderId,
  nowMs: number,
  ttlMs: number = QUOTA_CACHE_TTL_MS,
  errorTtlMs: number = QUOTA_CACHE_ERROR_TTL_MS,
): ProviderQuota | null {
  const row = cache.entries[provider]?.quota ?? null;
  if (row === null || !isQuotaRowFresh(row, nowMs, ttlMs, errorTtlMs)) return null;
  return asCachedQuota(row);
}

/** The provider's model list from `cache` when fresh at `nowMs`, marked `cached`; else null. */
export function cachedModelsRow(
  cache: QuotaCacheFile,
  provider: QuotaProviderId,
  nowMs: number,
  ttlMs: number = QUOTA_CACHE_TTL_MS,
  errorTtlMs: number = QUOTA_CACHE_ERROR_TTL_MS,
): ProviderModels | null {
  const row = cache.entries[provider]?.models ?? null;
  if (row === null || !isModelsRowFresh(row, nowMs, ttlMs, errorTtlMs)) return null;
  return asCachedModels(row);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

interface LockPayload {
  pid: number;
  token: string;
  createdAt: number;
}

function parseLockPayload(text: string): LockPayload | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    if (typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid < 1) return null;
    if (typeof parsed.token !== 'string' || parsed.token === '') return null;
    if (typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt)) return null;
    return { pid: parsed.pid, token: parsed.token, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

/**
 * Creates the lock file exclusively. Returns null only when another holder
 * already has it; other filesystem failures throw so the caller can fall
 * back to an unlocked fetch instead of waiting on a lock that cannot exist.
 */
export async function tryAcquireQuotaCacheLock(homeDir: string, nowMs: number = Date.now()): Promise<QuotaCacheLockHandle | null> {
  const lockPath = resolveQuotaCacheLockPath(homeDir);
  if (lockPath === '') return null;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = randomBytes(16).toString('hex');
  const payload: LockPayload = { pid: process.pid, token, createdAt: nowMs };
  try {
    await writeFile(lockPath, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
  return {
    path: lockPath,
    token,
    release: async () => {
      try {
        const current = parseLockPayload(await readFile(lockPath, 'utf8'));
        if (current !== null && current.token === token) await rm(lockPath, { force: true });
      } catch {
        // Already gone or replaced by a stale-lock takeover: nothing to release.
      }
    },
  };
}

/**
 * True when the lock at `homeDir` can be taken over: its holder pid is
 * dead, or the file is corrupt and older than `staleLockMs`. A live
 * holder (including another call in this same process) is never stale,
 * however long its fetch runs; waiters bound their wait instead. Never throws.
 */
export async function isQuotaCacheLockStale(
  homeDir: string,
  staleLockMs: number = QUOTA_CACHE_STALE_LOCK_MS,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const lockPath = resolveQuotaCacheLockPath(homeDir);
  if (lockPath === '') return false;
  let text: string;
  let mtimeMs: number;
  try {
    text = await readFile(lockPath, 'utf8');
    mtimeMs = (await stat(lockPath)).mtimeMs;
  } catch {
    return false;
  }
  const payload = parseLockPayload(text);
  if (payload === null) return nowMs - mtimeMs > staleLockMs;
  if (payload.pid === process.pid) return false;
  return !isPidAlive(payload.pid);
}

/** Removes the lock only when it is stale (see {@link isQuotaCacheLockStale}). Returns true when removed. Never throws. */
export async function removeStaleQuotaCacheLock(
  homeDir: string,
  staleLockMs: number = QUOTA_CACHE_STALE_LOCK_MS,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const lockPath = resolveQuotaCacheLockPath(homeDir);
  if (lockPath === '') return false;
  try {
    if (!(await isQuotaCacheLockStale(homeDir, staleLockMs, nowMs))) return false;
    await rm(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}
