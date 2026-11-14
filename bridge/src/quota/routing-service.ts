// Bridge-side model routing for the dashboard: the stored routing config joined
// with live quota, behind a short cache so opening the screen does not re-run
// every quota and model fetch. The routing file itself is never cached.
import { annotateTiers } from './annotate.js';
import {
  loadRoutingConfig,
  parseModelRoutingConfig,
  saveRoutingConfig,
  starterRoutingConfig,
  validatePicksAgainstModels,
} from './routing-config.js';
import {
  MODEL_ROUTING_MIN_REFRESH_MS,
  MODEL_ROUTING_SCHEMA,
  QUOTA_PROVIDER_IDS,
  type GetModelRoutingPayload,
  type ModelRoutingSnapshot,
  type QuotaReport,
  type SetModelRoutingPayload,
  type SetModelRoutingResult,
} from './types.js';

/** How long a collected report serves `get` without `refresh`. */
export const MODEL_ROUTING_CACHE_MS = 60_000;
/** How old a cached report may be and still validate a `set`. */
export const MODEL_ROUTING_VALIDATION_MAX_AGE_MS = 10 * 60_000;
/** Per-provider fetch timeout used by the real service. */
export const MODEL_ROUTING_COLLECT_TIMEOUT_MS = 15_000;

export interface ModelRoutingServiceOptions {
  homeDir: string;
  now: () => number;
  /** Collects a full report; `refresh` is true when the caller asked to bypass the cache. */
  collect: (refresh: boolean) => Promise<QuotaReport>;
  cacheMs?: number;
}

export interface ModelRoutingService {
  get(payload: GetModelRoutingPayload): Promise<ModelRoutingSnapshot>;
  set(payload: SetModelRoutingPayload): Promise<SetModelRoutingResult>;
}

interface CachedReport {
  report: QuotaReport;
  /** When the collect started; ages the cache. */
  collectedAt: number;
  /** When the collect finished; the refresh floor counts from here. */
  completedAt: number;
}

const INVALID_FILE_BLOCKED = 'The existing routing file is invalid; confirm to replace it.';

function shortReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line || 'unknown error';
}

export function createModelRoutingService(options: ModelRoutingServiceOptions): ModelRoutingService {
  const cacheMs = options.cacheMs ?? MODEL_ROUTING_CACHE_MS;
  let cache: CachedReport | null = null;
  let inFlight: Promise<QuotaReport> | null = null;
  let setQueue: Promise<unknown> = Promise.resolve();

  const fresh = (maxAgeMs: number): CachedReport | null =>
    cache !== null && options.now() - cache.collectedAt < maxAgeMs ? cache : null;

  /**
   * One collect at a time; callers arriving while it runs share it. Failures are not cached.
   * `options.collect` is invoked on a microtask so a synchronous throw becomes a rejection of
   * `run`, and the slot is cleared only by the run that owns it.
   */
  const collect = (refresh: boolean): Promise<QuotaReport> => {
    if (inFlight) return inFlight;
    const startedAt = options.now();
    const run: Promise<QuotaReport> = Promise.resolve()
      .then(() => options.collect(refresh))
      .then(
        report => {
          cache = { report, collectedAt: startedAt, completedAt: options.now() };
          return report;
        },
        (error: unknown) => {
          throw new Error(`quota could not be collected: ${shortReason(error)}`);
        },
      );
    inFlight = run;
    // Registered before any caller can await `run`, so the slot is free when they resume.
    const clear = (): void => { if (inFlight === run) inFlight = null; };
    run.then(clear, clear);
    return run;
  };

  const get = async (payload: GetModelRoutingPayload): Promise<ModelRoutingSnapshot> => {
    // The floor applies only when nothing is collecting. A refresh that arrives during a collect
    // joins it. Otherwise a refresh inside the floor is the last completed report, even when
    // cacheMs has elapsed or a slow collect has aged the report past the normal cache window.
    const refreshRequested = payload.refresh === true;
    const insideFloor = inFlight === null && cache !== null && options.now() - cache.completedAt < MODEL_ROUTING_MIN_REFRESH_MS;
    const refresh = refreshRequested && !insideFloor;
    const hit = refreshRequested && insideFloor ? cache : refresh ? null : fresh(cacheMs);
    const base = hit ? hit.report : await collect(refresh);
    const loaded = await loadRoutingConfig(options.homeDir);
    const config = loaded.state.status === 'ok' ? loaded.config : null;
    const generatedMs = Date.parse(base.generatedAt);
    const reportNow = Number.isFinite(generatedMs) ? new Date(generatedMs) : new Date(options.now());
    const report: QuotaReport = {
      ...base,
      routingConfig: loaded.state,
      tiers: config ? annotateTiers(config, base.providers, base.routing, base.models, reportNow) : [],
      steering: config ? config.steering : '',
    };
    return { schema: MODEL_ROUTING_SCHEMA, config: config ?? starterRoutingConfig(), report, cached: hit !== null };
  };

  const saveOne = async (payload: SetModelRoutingPayload): Promise<SetModelRoutingResult> => {
    const parsed = parseModelRoutingConfig(payload.config);
    if (!parsed.ok) return { schema: MODEL_ROUTING_SCHEMA, saved: false, errors: parsed.errors };
    if (payload.overwriteInvalid !== true && (await loadRoutingConfig(options.homeDir)).state.status === 'invalid') {
      return { schema: MODEL_ROUTING_SCHEMA, saved: false, errors: [INVALID_FILE_BLOCKED], invalidFileBlocked: true };
    }
    const recent = fresh(MODEL_ROUTING_VALIDATION_MAX_AGE_MS);
    const report = recent ? recent.report : await collect(false);
    const pickErrors = validatePicksAgainstModels(parsed.config, report.models);
    if (pickErrors.length > 0) return { schema: MODEL_ROUTING_SCHEMA, saved: false, errors: pickErrors };
    const written = await saveRoutingConfig(options.homeDir, parsed.config);
    if (!written.ok) return { schema: MODEL_ROUTING_SCHEMA, saved: false, errors: [written.error] };
    return { schema: MODEL_ROUTING_SCHEMA, saved: true, errors: [] };
  };

  const set = (payload: SetModelRoutingPayload): Promise<SetModelRoutingResult> => {
    const run = setQueue.then(() => saveOne(payload));
    setQueue = run.catch(() => undefined);
    return run;
  };

  return { get, set };
}

/**
 * The bridge's service: every provider, model lists included. The quota modules
 * load on the first collect, so creating the service costs nothing at start-up.
 */
export function createRealModelRoutingService(homeDir: string): ModelRoutingService {
  let loading: Promise<{ collect: typeof import('../quota-cli.js').collectQuotaReport; deps: import('../quota-cli.js').QuotaDeps }> | null = null;
  const load = () => {
    if (!loading) {
      loading = (async () => {
        const cli = await import('../quota-cli.js');
        return { collect: cli.collectQuotaReport, deps: await cli.loadRealQuotaDeps() };
      })();
      loading.catch(() => { loading = null; });
    }
    return loading;
  };
  return createModelRoutingService({
    homeDir,
    now: () => Date.now(),
    collect: async () => {
      const { collect, deps } = await load();
      const { report } = await collect(
        { providers: [...QUOTA_PROVIDER_IDS], timeoutMs: MODEL_ROUTING_COLLECT_TIMEOUT_MS, includeModels: true },
        { ...deps, homeDir },
      );
      return report;
    },
  });
}
