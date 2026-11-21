import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  HarnessModel, ModelsFetcher, ProviderModels, ProviderQuota, QuotaFetcher,
  QuotaFetchOptions, QuotaWindow, QuotaWindowKind, ScopedLimit,
} from './types.js';

const exec = promisify(execFile);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function readOmp(command: 'models' | 'usage', options: QuotaFetchOptions): Promise<Record<string, unknown>> {
  const args = [command, '--json'];
  if (command === 'usage') args.push('--redact');
  const { stdout } = await exec('omp', args, {
    cwd: options.homeDir, env: { ...process.env, HOME: options.homeDir, ...options.env },
    timeout: options.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
  const data: unknown = JSON.parse(stdout);
  if (!record(data)) throw new Error('invalid JSON object');
  return data;
}

function failure(error: unknown, command: string): { status: 'error' | 'unavailable'; message: string } {
  if (record(error) && error.code === 'ENOENT') return { status: 'unavailable', message: 'OMP executable unavailable' };
  // The subprocess error can contain stdout, stderr, and account identifiers.
  return { status: 'error', message: `Could not read omp ${command} --json` };
}

export const fetchOmpModels: ModelsFetcher = async options => {
  const row: ProviderModels = {
    provider: 'omp', source: 'live', observedAt: options.now().toISOString(), status: 'ok', message: null,
    modelFlag: '--model <id>', effortFlag: '--thinking <level>', models: [],
  };
  try {
    const { models } = await readOmp('models', options);
    if (!Array.isArray(models)) throw new Error('missing models');
    for (const item of models) {
      if (!record(item) || typeof item.selector !== 'string' || !item.selector.includes('/')) continue;
      const model: HarnessModel = {
        id: item.selector, name: typeof item.name === 'string' ? item.name : null,
        description: null, isDefault: false, defaultEffort: null,
        contextTokens: typeof item.contextWindow === 'number' ? item.contextWindow : null,
        efforts: Array.isArray(item.thinking) ? item.thinking.filter((effort): effort is string => typeof effort === 'string') : [],
      };
      row.models.push(model);
    }
    return row;
  } catch (error) {
    return { ...row, ...failure(error, 'models') };
  }
};

function windowKind(window: unknown, durationMs: unknown): QuotaWindowKind | undefined {
  if (durationMs === 300 * 60_000 || window === '5h') return 'five_hour';
  if (durationMs === 7 * 86400_000 || window === '7d' || window === 'weekly') return 'weekly';
  if ((typeof durationMs === 'number' && durationMs >= 28 * 86400_000 && durationMs <= 31 * 86400_000)
    || (typeof window === 'string' && /^(monthly|month|1mo|30d)$/i.test(window))) return 'monthly';
  return undefined;
}

// An aggregated pool can span accounts with different reset instants. Only
// advertise a reset when every contributing limit agrees on it.
function sharedReset(reports: unknown, provider: string, meter: string, kind: QuotaWindowKind): string | null {
  const resets = new Set<number | undefined>();
  for (const report of Array.isArray(reports) ? reports : []) {
    if (!record(report) || report.provider !== provider || !Array.isArray(report.limits)) continue;
    for (const limit of report.limits) {
      if (!record(limit) || !record(limit.window) || windowKind(limit.window.id, limit.window.durationMs) !== kind) continue;
      const scope = record(limit.scope) ? limit.scope : {};
      let limitMeter = '';
      if (provider === 'openai-codex' || provider === 'anthropic') {
        if (typeof scope.tier === 'string') limitMeter = scope.tier.toLowerCase();
        if (!limitMeter && provider === 'openai-codex') {
          const slug = typeof limit.id === 'string' ? limit.id.split(':')[1] : '';
          limitMeter = slug && slug !== 'primary' && slug !== 'secondary' ? slug : 'chat';
        }
      }
      if (limitMeter === meter) resets.add(typeof limit.window.resetsAt === 'number' ? limit.window.resetsAt : undefined);
    }
  }
  const [epoch] = resets;
  return resets.size === 1 && epoch !== undefined && Number.isFinite(new Date(epoch).getTime()) ? new Date(epoch).toISOString() : null;
}

export const fetchOmpQuota: QuotaFetcher = async options => {
  const row: ProviderQuota = {
    provider: 'omp', source: 'live', observedAt: options.now().toISOString(), plan: null,
    status: 'no_data', windows: [], message: 'OMP reported no supported subscription windows',
  };
  try {
    const { capacity, reports } = await readOmp('usage', options);
    if (!record(capacity)) throw new Error('missing capacity');
    const scopedLimits: ScopedLimit[] = [];
    const tightest = new Map<QuotaWindowKind, QuotaWindow>();
    for (const [provider, pools] of Object.entries(capacity)) {
      if (!Array.isArray(pools)) continue;
      for (const pool of pools) {
        if (!record(pool) || typeof pool.usedAccounts !== 'number' || typeof pool.accounts !== 'number' || pool.accounts <= 0) continue;
        const kind = windowKind(pool.window, pool.durationMs);
        if (!kind) continue;
        // OMP aggregates all reporting accounts for this exact provider, meter and duration.
        const usedPercent = 100 * pool.usedAccounts / pool.accounts;
        const meter = typeof pool.meter === 'string' ? pool.meter : '';
        const scope = meter ? `${provider}/${meter}` : provider;
        const resetsAt = sharedReset(reports, provider, meter, kind);
        scopedLimits.push({ scope, kind, usedPercent, resetsAt });
        if ((tightest.get(kind)?.usedPercent ?? -Infinity) < usedPercent) {
          tightest.set(kind, {
            kind, usedPercent, resetsAt, note: scope,
            windowMinutes: typeof pool.durationMs === 'number' ? pool.durationMs / 60_000 : null,
          });
        }
      }
    }
    if (!scopedLimits.length) return row;
    return { ...row, status: 'ok', message: null, windows: [...tightest.values()], scopedLimits };
  } catch (error) {
    return { ...row, ...failure(error, 'usage') };
  }
};
