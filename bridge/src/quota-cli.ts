#!/usr/bin/env node
// `ftown-quota`: subscription allowance left per harness, routing advice, the models each offers,
// and the user's model-routing tiers for a router agent.
import os from 'node:os';
import { accountEnv, loadAccounts, type HarnessAccount } from './accounts.js';
import { isCliEntry } from './cli-entry.js';
import {
  cachedModelsRow,
  cachedQuotaRow,
  readQuotaCache,
  removeStaleQuotaCacheLock,
  resolveQuotaCachePath,
  storeQuotaCacheEntries,
  tryAcquireQuotaCacheLock,
  QUOTA_CACHE_ERROR_TTL_MS,
  QUOTA_CACHE_LOCK_POLL_MS,
  QUOTA_CACHE_STALE_LOCK_MS,
  QUOTA_CACHE_TTL_MS,
  type QuotaCacheLockHandle,
} from './quota/cache.js';

export { invalidateQuotaCacheEntry } from './quota/cache.js';
import {
  QUOTA_PROVIDER_IDS,
  type AnnotatedPick,
  type AnnotatedTier,
  type HarnessModel,
  type ModelRoutingConfig,
  type ModelsFetcher,
  type ProviderModels,
  type ProviderQuota,
  type ProviderRouting,
  type QuotaFetcher,
  type QuotaProviderId,
  type QuotaReport,
  type QuotaRoutingAdvisor,
  type QuotaTableFormatter,
  type RoutingConfigState,
} from './quota/types.js';

export const QUOTA_DEFAULT_TIMEOUT_SECONDS = 15;
/** Allowed --timeout range in seconds; keeps timeoutMs + grace well inside the timer limit. */
export const QUOTA_MIN_TIMEOUT_SECONDS = 1;
export const QUOTA_MAX_TIMEOUT_SECONDS = 600;
/** Extra time past the provider timeout before the CLI gives up on a fetcher that never settles. */
export const QUOTA_GRACE_MS = 2000;

export const QUOTA_HELP_TEXT = [
  `Usage: ftown-quota [${QUOTA_PROVIDER_IDS.join('|')} ...] [--json] [--fresh] [--timeout <seconds>]`,
  '',
  'Shows how much of each subscription\'s 5-hour and weekly allowance is left, which harness to route work to first,',
  'and the models each harness offers. The report also includes your model-routing tiers and steering for a router agent.',
  '',
  'Results are cached per provider for 5 minutes in ~/.ftown/quota-cache.json (errors for 30 seconds);',
  'cached rows show "cached <age> ago" in table mode and source "cached" with the original observedAt in JSON.',
  '',
  'Options:',
  '  --json               machine-readable report (quota, routing advice, models, routing tiers, steering) for agents',
  '  --fresh              bypass the cache, fetch every provider live and refresh the cache',
  '  --models             table mode: also list the models each harness offers',
  '  --no-models          skip the model lists (JSON omits them)',
  `  --timeout <seconds>  time limit per provider, ${QUOTA_MIN_TIMEOUT_SECONDS}-${QUOTA_MAX_TIMEOUT_SECONDS} seconds (default ${QUOTA_DEFAULT_TIMEOUT_SECONDS})`,
  '  -h, --help           show this help',
].join('\n');

/** Table mode shows at most this many models per provider; JSON is never truncated. */
export const MODEL_LIST_TABLE_LIMIT = 20;

/** `default`: models in JSON only; `show`: models in table mode too; `skip`: no model fetchers at all. */
export type QuotaModelsMode = 'default' | 'show' | 'skip';

export type QuotaArgs =
  | { ok: true; providers: QuotaProviderId[]; json: boolean; fresh: boolean; timeoutMs: number; help: boolean; models: QuotaModelsMode }
  | { ok: false; error: string };

/** Reads the user's routing file; see quota/routing-config.ts. */
export type RoutingLoader = (homeDir: string) => Promise<{ state: RoutingConfigState; config: ModelRoutingConfig | null }>;

/** Joins the user's tiers with live quota, routing advice and model lists; see quota/annotate.ts. */
export type TierAnnotator = (
  config: ModelRoutingConfig,
  quota: readonly ProviderQuota[],
  routing: readonly ProviderRouting[],
  models: readonly ProviderModels[],
  now?: Date,
) => AnnotatedTier[];

/** On-disk cache controls; defaults cache under `homeDir` for 5 minutes (30 s for errors). */
export interface QuotaCacheOptions {
  enabled?: boolean;
  ttlMs?: number;
  errorTtlMs?: number;
  staleLockMs?: number;
  lockPollMs?: number;
  lockWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface QuotaDeps {
  fetchers: Record<QuotaProviderId, QuotaFetcher>;
  modelFetchers: Record<QuotaProviderId, ModelsFetcher>;
  advise: QuotaRoutingAdvisor;
  format: QuotaTableFormatter;
  loadRouting: RoutingLoader;
  annotate: TierAnnotator;
  now: () => Date;
  homeDir: string;
  account?: string;
  env?: NodeJS.ProcessEnv;
  /** Grace past the provider timeout before a hung fetcher becomes an error entry. Default QUOTA_GRACE_MS. */
  graceMs?: number;
  cache?: QuotaCacheOptions;
}

export interface QuotaRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when at least one quota or model fetcher did not settle in time and was replaced. */
  hung: boolean;
}

export interface CollectQuotaInput {
  providers: QuotaProviderId[];
  timeoutMs: number;
  /** Put the model lists in the report. */
  includeModels: boolean;
  /** Also fetch model lists when the routing config has picks, so the tiers can be checked against them. */
  fetchModelsForRouting?: boolean;
  /** Bypass the on-disk cache, fetch live and refresh the cache. */
  fresh?: boolean;
}

interface AccountProvider { provider: QuotaProviderId; account: string; env?: NodeJS.ProcessEnv }

function accountProviderKey(target: AccountProvider): string { return `${target.provider}:${target.account}`; }

function providerTargets(providers: readonly QuotaProviderId[], accounts: readonly HarnessAccount[]): AccountProvider[] {
  const targets: AccountProvider[] = [];
  for (const provider of providers) {
    targets.push({ provider, account: 'default' });
    const harness = provider === 'claude' || provider === 'codex' ? provider : null;
    if (harness === null) continue;
    for (const account of accounts) if (account.harness === harness) targets.push({ provider, account: account.id, env: accountEnv(account) });
  }
  return targets;
}

export interface CollectedQuotaReport {
  report: QuotaReport;
  hung: boolean;
  /** Short stderr lines for non-fatal problems (routing advice, routing file). */
  warnings: string[];
}

function isQuotaProviderId(name: string): name is QuotaProviderId {
  return (QUOTA_PROVIDER_IDS as readonly string[]).includes(name);
}

export function parseQuotaArgs(argv: string[]): QuotaArgs {
  const selected = new Set<QuotaProviderId>();
  let json = false;
  let fresh = false;
  let help = false;
  let showModels = false;
  let skipModels = false;
  let timeoutSeconds = QUOTA_DEFAULT_TIMEOUT_SECONDS;

  const parseTimeout = (raw: string | undefined): boolean => {
    const seconds = raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(seconds) || seconds < QUOTA_MIN_TIMEOUT_SECONDS || seconds > QUOTA_MAX_TIMEOUT_SECONDS) return false;
    timeoutSeconds = seconds;
    return true;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      const name = arg.toLowerCase();
      if (!isQuotaProviderId(name)) {
        return { ok: false, error: `unknown provider: ${arg} (expected ${QUOTA_PROVIDER_IDS.join(', ')})` };
      }
      selected.add(name);
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--fresh') {
      fresh = true;
    } else if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '--models') {
      showModels = true;
    } else if (arg === '--no-models') {
      skipModels = true;
    } else if (arg === '--timeout') {
      if (!parseTimeout(argv[i + 1])) return { ok: false, error: 'invalid --timeout value' };
      i++;
    } else if (arg.startsWith('--timeout=')) {
      if (!parseTimeout(arg.slice('--timeout='.length))) return { ok: false, error: 'invalid --timeout value' };
    } else {
      return { ok: false, error: `unknown option: ${arg}` };
    }
  }

  if (showModels && skipModels) {
    return { ok: false, error: 'cannot combine --models and --no-models' };
  }

  const providers = selected.size === 0
    ? [...QUOTA_PROVIDER_IDS]
    : QUOTA_PROVIDER_IDS.filter(id => selected.has(id));
  const models: QuotaModelsMode = skipModels ? 'skip' : showModels ? 'show' : 'default';
  return { ok: true, providers, json, fresh, timeoutMs: Math.round(timeoutSeconds * 1000), help, models };
}

function errorRow(provider: QuotaProviderId, now: Date, message: string): ProviderQuota {
  return {
    provider,
    status: 'error',
    plan: null,
    windows: [],
    source: 'live',
    observedAt: now.toISOString(),
    message,
  };
}

function modelErrorRow(provider: QuotaProviderId, now: Date, message: string): ProviderModels {
  return {
    provider,
    status: 'error',
    models: [],
    source: 'live',
    observedAt: now.toISOString(),
    message,
    modelFlag: '',
    effortFlag: null,
  };
}

function shortReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const firstLine = text.split('\n')[0].trim() || 'unknown error';
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}

type Failure = { kind: 'failed'; reason: string } | { kind: 'timeout' };

/** A fetch result; `hung` is true only when the fallback replaced a fetch that did not settle in time. */
interface Settled<T> {
  value: T;
  hung: boolean;
}

/**
 * Runs one fetch; a rejection, a synchronous throw or a hang past
 * timeoutMs + grace is turned into a fallback value by `onFailure`.
 */
function settleWithin<T>(
  start: () => Promise<T>,
  onFailure: (failure: Failure) => T,
  timeoutMs: number,
  deps: QuotaDeps,
): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hardLimit = new Promise<Settled<T>>(resolve => {
    timer = setTimeout(
      () => resolve({ value: onFailure({ kind: 'timeout' }), hung: true }),
      timeoutMs + (deps.graceMs ?? QUOTA_GRACE_MS),
    );
  });

  let attempt: Promise<T>;
  try {
    attempt = Promise.resolve(start());
  } catch (error) {
    attempt = Promise.reject(error);
  }
  const settled = attempt.then(
    value => ({ value, hung: false }),
    (error: unknown) => ({ value: onFailure({ kind: 'failed', reason: shortReason(error) }), hung: false }),
  );

  return Promise.race([settled, hardLimit]).finally(() => clearTimeout(timer));
}

function quotaWithin(
  provider: QuotaProviderId,
  fetcher: QuotaFetcher,
  timeoutMs: number,
  deps: QuotaDeps,
): Promise<Settled<ProviderQuota>> {
  return settleWithin(
    () => fetcher({ timeoutMs, now: deps.now, homeDir: deps.homeDir, account: deps.account, env: deps.env }),
    failure => errorRow(
      provider,
      deps.now(),
      failure.kind === 'timeout' ? `${provider} check timed out` : `${provider} check failed: ${failure.reason}`,
    ),
    timeoutMs,
    deps,
  );
}

function modelsWithin(
  provider: QuotaProviderId,
  fetcher: ModelsFetcher,
  timeoutMs: number,
  deps: QuotaDeps,
): Promise<Settled<ProviderModels>> {
  return settleWithin(
    () => fetcher({ timeoutMs, now: deps.now, homeDir: deps.homeDir, account: deps.account, env: deps.env }),
    failure => modelErrorRow(
      provider,
      deps.now(),
      failure.kind === 'timeout' ? `${provider} model list timed out` : `${provider} model list failed: ${failure.reason}`,
    ),
    timeoutMs,
    deps,
  );
}

/**
 * Routing advice; if the advisor throws, every provider is reported as unknown
 * so the rest of the output still prints, and the failure goes to stderr.
 */
function adviseOrFallback(
  rows: readonly ProviderQuota[],
  now: Date,
  deps: QuotaDeps,
): { routing: ProviderRouting[]; failure: string | null } {
  try {
    const advised = deps.advise(rows, now);
    return {
      routing: advised.map((entry, index) => ({ ...entry, account: entry.account ?? rows[index]?.account ?? 'default' })),
      failure: null,
    };
  } catch (error) {
    const routing = rows.map((row): ProviderRouting => ({
      provider: row.provider,
      availability: 'unknown',
      leftPercent: null,
      bindingWindow: null,
      resetsAt: null,
      resetsInMinutes: null,
      runway: null,
      reason: 'routing unavailable',
    }));
    return { routing, failure: `ftown-quota: routing advice failed: ${shortReason(error)}` };
  }
}

/** The state reported when the routing file could not be read or annotated at all. */
function unreadableRouting(): RoutingConfigState {
  return { status: 'invalid', path: '', errors: ['could not load the routing file'] };
}

/** Reads the routing file; a throw becomes an unreadable state plus a warning, never an exception. */
async function loadRoutingSafely(
  deps: QuotaDeps,
  warnings: string[],
): Promise<{ state: RoutingConfigState; config: ModelRoutingConfig | null }> {
  try {
    return await deps.loadRouting(deps.homeDir);
  } catch (error) {
    warnings.push(`ftown-quota: model routing could not be loaded: ${shortReason(error)}`);
    return { state: unreadableRouting(), config: null };
  }
}

function annotateRouting(
  state: RoutingConfigState,
  config: ModelRoutingConfig | null,
  rows: readonly ProviderQuota[],
  routing: readonly ProviderRouting[],
  models: readonly ProviderModels[],
  now: Date,
  deps: QuotaDeps,
  warnings: string[],
): Pick<QuotaReport, 'routingConfig' | 'tiers' | 'steering'> {
  if (state.status !== 'ok' || config === null) return { routingConfig: state, tiers: [], steering: '' };
  try {
    return { routingConfig: state, tiers: deps.annotate(config, rows, routing, models, now), steering: typeof config.steering === 'string' ? config.steering : '' };
  } catch (error) {
    warnings.push(`ftown-quota: model routing could not be annotated: ${shortReason(error)}`);
    return { routingConfig: unreadableRouting(), tiers: [], steering: '' };
  }
}

function quotaSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Gathers everything the report needs: cached or guarded live quota and
 * model fetches, routing advice, and the annotated routing tiers. Never
 * prints and never exits.
 *
 * With the on-disk cache enabled (the default under a real `homeDir`),
 * fresh per-provider rows serve from `~/.ftown/quota-cache.json` without
 * calling their fetchers. Missing or expired providers fetch live under
 * a cross-process lock file so concurrent callers share one fetch;
 * waiters poll the cache and take over a dead holder's lock instead of
 * deadlocking (see quota/cache.ts).
 */
export async function collectQuotaReport(input: CollectQuotaInput, deps: QuotaDeps): Promise<CollectedQuotaReport> {
  const warnings: string[] = [];
  const loaded = await loadRoutingSafely(deps, warnings);
  const config = loaded.state.status === 'ok' ? loaded.config : null;
  const hasPicks = config !== null && Array.isArray(config.tiers)
    && config.tiers.some(tier => Array.isArray(tier.picks) && tier.picks.length > 0);
  const fetchModels = input.includeModels || (input.fetchModelsForRouting === true && hasPicks);

  const useCache = deps.cache?.enabled !== false && resolveQuotaCachePath(deps.homeDir) !== '';
  const fresh = input.fresh === true;
  const ttlMs = deps.cache?.ttlMs ?? QUOTA_CACHE_TTL_MS;
  const errorTtlMs = deps.cache?.errorTtlMs ?? QUOTA_CACHE_ERROR_TTL_MS;
  const staleLockMs = deps.cache?.staleLockMs ?? QUOTA_CACHE_STALE_LOCK_MS;
  const lockPollMs = deps.cache?.lockPollMs ?? QUOTA_CACHE_LOCK_POLL_MS;
  const lockWaitMs = deps.cache?.lockWaitMs
    ?? Math.max(staleLockMs * 2, input.timeoutMs + (deps.graceMs ?? QUOTA_GRACE_MS) + 10_000);
  const sleep = deps.cache?.sleep ?? quotaSleep;
  const nowMs = (): number => deps.now().getTime();

  const accountsFile = loadAccounts();
  const targets = providerTargets(input.providers, accountsFile.accounts);
  const quotaByProvider = new Map<string, ProviderQuota>();
  const modelsByProvider = new Map<string, ProviderModels>();
  let hung = false;

  const refreshHits = async (allowCached: boolean): Promise<void> => {
    if (!useCache || !allowCached) return;
    const cache = await readQuotaCache(deps.homeDir);
    const at = nowMs();
    for (const target of targets) {
      const key = accountProviderKey(target);
      if (!quotaByProvider.has(key)) {
        const hit = cachedQuotaRow(cache, target.provider, at, ttlMs, errorTtlMs, target.account);
        if (hit !== null) quotaByProvider.set(key, hit);
      }
      if (fetchModels && !modelsByProvider.has(key)) {
        const hit = cachedModelsRow(cache, target.provider, at, ttlMs, errorTtlMs, target.account);
        if (hit !== null) modelsByProvider.set(key, hit);
      }
    }
  };

  if (useCache && !fresh) await refreshHits(true);

  const missingQuota = (): AccountProvider[] => targets.filter(target => !quotaByProvider.has(accountProviderKey(target)));
  const missingModels = (): AccountProvider[] => (fetchModels ? targets.filter(target => !modelsByProvider.has(accountProviderKey(target))) : []);

  if (missingQuota().length > 0 || missingModels().length > 0) {
    let lock: QuotaCacheLockHandle | null = null;
    let lockUnavailable = false;
    let contended = false;
    if (useCache) {
      try {
        // Lock timestamps are real wall time, not the injectable quota
        // clock, so filesystem mtimes and holder pids compare correctly.
        lock = await tryAcquireQuotaCacheLock(deps.homeDir);
      } catch {
        lockUnavailable = true;
      }
      if (lock === null && !lockUnavailable) {
        contended = true;
        // Monotonic deadline: a wall-clock jump cannot extend the wait.
        const deadline = performance.now() + lockWaitMs;
        while ((missingQuota().length > 0 || missingModels().length > 0) && performance.now() < deadline) {
          await sleep(lockPollMs);
          // A holder's fresh write satisfies even a --fresh waiter: that
          // write was itself a live fetch shared by this call.
          await refreshHits(true);
          if (missingQuota().length === 0 && missingModels().length === 0) break;
          await removeStaleQuotaCacheLock(deps.homeDir, staleLockMs);
          try {
            lock = await tryAcquireQuotaCacheLock(deps.homeDir);
          } catch {
            lockUnavailable = true;
            break;
          }
          if (lock !== null) break;
        }
      }
    }

    const stillMissingQuota = missingQuota();
    const stillMissingModels = missingModels();
    if (stillMissingQuota.length > 0 || stillMissingModels.length > 0) {
      try {
        if (lock !== null && useCache && (!fresh || contended)) {
          // Double-check under the lock: another holder may have just
          // written a row this call had not seen when it first read.
          await refreshHits(true);
        }
        const fetchQuota = missingQuota();
        const fetchModelsFor = missingModels();
        const [quotaSettled, modelSettled] = await Promise.all([
          Promise.all(fetchQuota.map(target => quotaWithin(target.provider, deps.fetchers[target.provider], input.timeoutMs, { ...deps, account: target.account, env: target.env }))),
          Promise.all(fetchModelsFor.map(target => modelsWithin(target.provider, deps.modelFetchers[target.provider], input.timeoutMs, { ...deps, account: target.account, env: target.env }))),
        ]);
        for (const run of [...quotaSettled, ...modelSettled]) {
          if (run.hung) hung = true;
        }
        quotaSettled.forEach((run, index) => {
          const target = fetchQuota[index];
          if (target !== undefined) quotaByProvider.set(accountProviderKey(target), { ...run.value, account: target.account });
        });
        modelSettled.forEach((run, index) => {
          const target = fetchModelsFor[index];
          if (target !== undefined) modelsByProvider.set(accountProviderKey(target), { ...run.value, account: target.account });
        });
        if (useCache) {
          await storeQuotaCacheEntries(
            deps.homeDir,
            quotaSettled.map((run, index) => ({ ...run.value, account: fetchQuota[index]?.account ?? 'default' })),
            modelSettled.map((run, index) => ({ ...run.value, account: fetchModelsFor[index]?.account ?? 'default' })),
          );
        }
      } finally {
        if (lock !== null) await lock.release();
      }
    } else if (lock !== null) {
      await lock.release();
    }
  }

  const rows = targets.map(target => quotaByProvider.get(accountProviderKey(target))!);
  const models = fetchModels ? targets.map(target => modelsByProvider.get(accountProviderKey(target))!) : [];

  const now = deps.now();
  const advice = adviseOrFallback(rows, now, deps);
  if (advice.failure !== null) warnings.push(advice.failure);
  const routingSection = annotateRouting(loaded.state, config, rows, advice.routing, models, now, deps, warnings);

  const report: QuotaReport = {
    generatedAt: now.toISOString(),
    providers: rows,
    routing: advice.routing,
    models,
    ...routingSection,
  };
  return { report, hung, warnings };
}

const TIGHTEST_REASON_PATTERN = /\((tightest:\s*[^()]+)\)$/;

function tightestNoteOf(entry: ProviderRouting): string | null {
  if (typeof entry.reason !== 'string') return null;
  const match = entry.reason.match(TIGHTEST_REASON_PATTERN);
  return match ? match[1].trim() : null;
}

/** `claude (low)`, `grok (exhausted)`, or just the provider name when available (with tightest pool when multi-pool). */
function routeLabel(entry: ProviderRouting): string {
  const tightest = tightestNoteOf(entry);
  if (entry.availability === 'available') {
    return tightest ? `${entry.provider} (${tightest})` : entry.provider;
  }
  return tightest
    ? `${entry.provider} (${entry.availability}, ${tightest})`
    : `${entry.provider} (${entry.availability})`;
}

function pickLine(index: number, pick: AnnotatedPick): string {
  let line = `  ${index}. ${pick.provider} ${pick.model}`;
  if (pick.effort) line += ` @${pick.effort}`;
  line += `  ${pick.availability}`;
  if (typeof pick.leftPercent === 'number' && Number.isFinite(pick.leftPercent)) line += ` ${pick.leftPercent}% left`;
  if (pick.problem) line += `  ! ${pick.problem}`;
  else if (pick.checked === false) line += ' (not checked: model list unavailable)';
  return line;
}

const GUIDANCE_LABEL = 'guidance: ';

/**
 * A tier's guidance as indented lines: the first labelled, further lines aligned under its text.
 * Empty when the guidance is missing, not a string, or blank.
 */
function guidanceLines(guidance: unknown): string[] {
  if (typeof guidance !== 'string') return [];
  const lines = guidance.split(/\r?\n/).map(line => line.trimEnd());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return [];
  const indent = ' '.repeat(2 + GUIDANCE_LABEL.length);
  return lines.map((line, index) => {
    if (index === 0) return `  ${GUIDANCE_LABEL}${line}`;
    return line === '' ? '' : `${indent}${line}`;
  });
}

function tierBlock(tiers: readonly AnnotatedTier[]): string[] {
  const lines = ['Your tiers:'];
  for (const tier of tiers) {
    const picks = Array.isArray(tier.picks) ? tier.picks : [];
    lines.push(tier.description ? `${tier.name} - ${tier.description}` : tier.name);
    if (picks.length === 0) lines.push('  (no picks yet)');
    picks.forEach((pick, index) => lines.push(pickLine(index + 1, pick)));
    lines.push(...guidanceLines(tier.guidance));
  }
  return lines;
}

/** Each block is printed after a blank line: the tiers, the steering, or a setup message. */
function routingBlocks(report: QuotaReport): string[][] {
  const state = report.routingConfig;
  if (state.status === 'missing') {
    return [['No model routing set up yet: open Model routing for this bridge in the dashboard.']];
  }
  if (state.status === 'invalid') {
    return [[`Model routing file has errors: ${state.errors[0] ?? 'unknown error'}`]];
  }
  const blocks: string[][] = [];
  if (report.tiers.length > 0) blocks.push(tierBlock(report.tiers));
  const steering = typeof report.steering === 'string' ? report.steering.replace(/\s*\r?\n\s*/g, ' ').trim() : '';
  if (steering) blocks.push([`Steering: ${steering}`]);
  return blocks;
}

function modelLine(model: HarnessModel): string {
  const marker = model.pricing === 'free' ? ' [free]' : model.pricing === 'included' ? ' [included in plan]' : '';
  const parts = [`  ${model.id}${marker}`];
  if (model.isDefault) parts.push('[default]');
  const efforts = Array.isArray(model.efforts) ? model.efforts : [];
  if (efforts.length > 0) {
    parts.push(`efforts: ${efforts.map(effort => (effort === model.defaultEffort ? `${effort}*` : effort)).join(', ')}`);
  }
  if (typeof model.contextTokens === 'number') parts.push(`ctx ${Math.round(model.contextTokens / 1000)}k`);
  return parts.join('  ');
}

function modelSectionLines(list: ProviderModels): string[] {
  const header = list.modelFlag ? `${list.provider} models (${list.modelFlag}):` : `${list.provider} models:`;
  if (list.status !== 'ok') return [header, `  ${list.message ?? list.status}`];
  const models = Array.isArray(list.models) ? list.models : [];
  if (models.length === 0) return [header, '  (none listed)'];
  const shown = models.slice(0, MODEL_LIST_TABLE_LIMIT).map(modelLine);
  const hidden = models.length - shown.length;
  if (hidden > 0) shown.push(`  ... and ${hidden} more (use --json for the full list)`);
  return [header, ...shown];
}

export async function runQuota(argv: string[], deps: QuotaDeps): Promise<QuotaRunResult> {
  return runQuotaLazy(argv, async () => deps);
}

/** Like runQuota, but builds its deps only when providers must run, so help and usage errors load no module. */
async function runQuotaLazy(argv: string[], getDeps: () => Promise<QuotaDeps>): Promise<QuotaRunResult> {
  const args = parseQuotaArgs(argv);
  if (!args.ok) {
    return { exitCode: 2, stdout: '', stderr: `${args.error}\n${QUOTA_HELP_TEXT}`, hung: false };
  }
  if (args.help) {
    return { exitCode: 0, stdout: QUOTA_HELP_TEXT, stderr: '', hung: false };
  }
  const deps = await getDeps();

  const { report, hung, warnings } = await collectQuotaReport({
    providers: args.providers,
    timeoutMs: args.timeoutMs,
    includeModels: args.models === 'show' || (args.models === 'default' && args.json),
    fetchModelsForRouting: args.models === 'default',
    fresh: args.fresh,
  }, deps);
  const stderr = warnings.join('\n');

  if (args.json) {
    return { exitCode: 0, stdout: JSON.stringify(report, null, 2), stderr, hung };
  }

  const lines = [
    deps.format(report.providers, new Date(report.generatedAt)),
    '',
    `Route first: ${report.routing.map(routeLabel).join(' > ')}`,
  ];
  for (const block of routingBlocks(report)) lines.push('', ...block);
  if (args.models === 'show') {
    lines.push('');
    for (const list of report.models) lines.push(...modelSectionLines(list));
  }
  return { exitCode: 0, stdout: lines.join('\n'), stderr, hung };
}

/** The real fetchers, models, routing, formatter and clock: what the bridge passes to collectQuotaReport. */
export async function loadRealQuotaDeps(): Promise<QuotaDeps> {
  const [
    claude, codex, grok, muse, agy, opencode,
    claudeModels, codexModels, grokModels, museModels, agyModels, opencodeModels,
    routing, format, routingConfigModule, annotateModule,
  ] = await Promise.all([
    import('./quota/claude.js'),
    import('./quota/codex.js'),
    import('./quota/grok.js'),
    import('./quota/muse.js'),
    import('./quota/agy.js'),
    import('./quota/opencode.js'),
    import('./quota/models-claude.js'),
    import('./quota/models-codex.js'),
    import('./quota/models-grok.js'),
    import('./quota/models-muse.js'),
    import('./quota/models-agy.js'),
    import('./quota/models-opencode.js'),
    import('./quota/routing.js'),
    import('./quota/format.js'),
    import('./quota/routing-config.js'),
    import('./quota/annotate.js'),
  ]);
  return {
    fetchers: {
      claude: claude.fetchClaudeQuota,
      codex: codex.fetchCodexQuota,
      grok: grok.fetchGrokQuota,
      muse: muse.fetchMuseQuota,
      agy: agy.fetchAgyQuota,
      opencode: opencode.fetchOpencodeQuota,
    },
    modelFetchers: {
      claude: claudeModels.fetchClaudeModels,
      codex: codexModels.fetchCodexModels,
      grok: grokModels.fetchGrokModels,
      muse: museModels.fetchMuseModels,
      agy: agyModels.fetchAgyModels,
      opencode: opencodeModels.fetchOpencodeModels,
    },
    advise: routing.adviseQuotaRouting,
    format: format.formatQuotaTable,
    loadRouting: routingConfigModule.loadRoutingConfig,
    annotate: annotateModule.annotateTiers,
    now: () => new Date(),
    homeDir: os.homedir(),
  };
}

/** Writes one line (text plus newline) without waiting on any write callback. */
function writeLine(stream: NodeJS.WriteStream, text: string): void {
  if (text) stream.write(`${text}\n`);
}

/**
 * Forced exit after a hung fetcher: exit once stdout has flushed, or after
 * 250 ms if the stream never calls back, so a stuck stream cannot block exit.
 */
function exitAfterWriting(code: number, stdoutText: string): void {
  const exit = (): void => { process.exit(code); };
  setTimeout(exit, 250);
  process.stdout.write(stdoutText ? `${stdoutText}\n` : '', exit);
}

/**
 * Entry for `ftown-quota` and the umbrella `ftown` CLI: runs with the real
 * modules and writes stdout/stderr. Returns the exit code, except when a
 * fetcher hung: then the process exits with that code after output is flushed,
 * because a hung fetcher's handle would otherwise keep the event loop alive.
 */
export async function runQuotaCli(argv: string[]): Promise<number> {
  const stdoutFailure: { message: string | null } = { message: null };
  const onStdoutError = (error: NodeJS.ErrnoException): void => {
    // A closed pipe (for example `| head`) is the reader being done, not a failure.
    if (error.code !== 'EPIPE') stdoutFailure.message = error.message;
  };
  process.stdout.on('error', onStdoutError);

  let exitCode = 1;
  let hung = false;
  let stdoutText = '';
  let stderrText = '';
  try {
    const result = await runQuotaLazy(argv, loadRealQuotaDeps);
    hung = result.hung;
    stdoutText = result.stdout;
    stderrText = result.stderr;
    exitCode = result.exitCode;
    if (stdoutFailure.message !== null) {
      stderrText = `${stderrText}${stderrText ? '\n' : ''}ftown-quota: stdout failed: ${stdoutFailure.message}`;
      exitCode = 1;
    }
  } catch (error) {
    stderrText = `ftown-quota: ${error instanceof Error ? error.message : String(error)}`;
    exitCode = 1;
  } finally {
    process.stdout.off('error', onStdoutError);
  }

  if (hung) {
    writeLine(process.stderr, stderrText);
    exitAfterWriting(exitCode, stdoutText);
    return exitCode;
  }
  writeLine(process.stdout, stdoutText);
  writeLine(process.stderr, stderrText);
  return exitCode;
}

async function main(argv: string[]): Promise<void> {
  process.exitCode = await runQuotaCli(argv);
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  void main(process.argv.slice(2));
}
