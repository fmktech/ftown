import { agyWindowsForModel } from './agy.js';
import { formatDuration } from './format.js';
import { QUOTA_PROVIDER_IDS } from './types.js';
import type {
  ProviderQuota,
  ProviderRouting,
  QuotaAvailability,
  QuotaRoutingAdvisor,
  QuotaWindow,
  QuotaWindowKind,
  RoutingPick,
} from './types.js';

export interface WindowAdvice {
  availability: QuotaAvailability;
  leftPercent: number | null;
  bindingWindow: QuotaWindowKind | null;
  resetsAt: string | null;
  resetsInMinutes: number | null;
  runway: number | null;
  reason: string;
}

const MINUTE_MS = 60_000;
const IMMINENT_RESET_MINUTES = 10;
const RUNWAY_LOW = 0.5;
const RUNWAY_CAP = 99;

/** Higher = more binding (worse for routing). unknown never binds. */
const SEVERITY: Record<QuotaAvailability, number> = {
  available: 0,
  low: 1,
  exhausted: 2,
  unknown: -1,
};

/** Sort rank for routing advice, best first. */
const RANK: Record<QuotaAvailability, number> = {
  available: 0,
  low: 1,
  unknown: 2,
  exhausted: 3,
};

const KIND_ORDER: Record<QuotaWindowKind, number> = {
  five_hour: 0,
  weekly: 1,
};

const LABEL: Record<QuotaWindowKind, string> = {
  five_hour: '5-hour',
  weekly: 'weekly',
};

/** Assesses one window against `now`. Pure: never reads the clock. */
export function assessWindow(
  window: QuotaWindow,
  now: Date,
): {
  availability: QuotaAvailability;
  leftPercent: number | null;
  resetsInMinutes: number | null;
  runway: number | null;
  resetting: boolean;
} {
  const used = window.usedPercent;
  const measuredLeft =
    used !== null && Number.isFinite(used)
      ? Math.round(Math.min(100, Math.max(0, 100 - used)))
      : null;

  const resetMs = window.resetsAt !== null ? Date.parse(window.resetsAt) : Number.NaN;
  const resetsInMinutes = Number.isNaN(resetMs)
    ? null
    : Math.max(0, Math.floor((resetMs - now.getTime()) / MINUTE_MS));

  if (
    measuredLeft !== null &&
    resetsInMinutes !== null &&
    resetsInMinutes <= IMMINENT_RESET_MINUTES
  ) {
    // About to reset: the current figure is irrelevant, so it counts as fully available.
    return {
      availability: 'available',
      leftPercent: 100,
      resetsInMinutes,
      runway: null,
      resetting: true,
    };
  }

  const windowMinutes = window.windowMinutes;
  let runway: number | null = null;
  if (
    measuredLeft !== null &&
    windowMinutes !== null &&
    Number.isFinite(windowMinutes) &&
    windowMinutes > 0 &&
    resetsInMinutes !== null &&
    resetsInMinutes > 0
  ) {
    const raw = (measuredLeft / 100) / (resetsInMinutes / windowMinutes);
    runway = Math.min(RUNWAY_CAP, Math.round(raw * 100) / 100);
  }

  let availability: QuotaAvailability;
  if (measuredLeft === null) {
    availability = 'unknown';
  } else if (measuredLeft <= 1) {
    availability = 'exhausted';
  } else if (measuredLeft < 15) {
    availability = 'low';
  } else if (runway !== null && runway < RUNWAY_LOW) {
    availability = 'low';
  } else {
    availability = 'available';
  }

  return {
    availability,
    leftPercent: measuredLeft,
    resetsInMinutes,
    runway,
    resetting: false,
  };
}

interface UsableWindow {
  window: QuotaWindow;
  availability: QuotaAvailability;
  leftPercent: number;
  resetsInMinutes: number | null;
  runway: number | null;
  resetting: boolean;
}

/** True when `a` should bind over `b`: worse availability, then less left, then kind order. */
function isMoreBinding(a: UsableWindow, b: UsableWindow): boolean {
  const severityA = SEVERITY[a.availability];
  const severityB = SEVERITY[b.availability];
  if (severityA !== severityB) return severityA > severityB;
  if (a.leftPercent !== b.leftPercent) return a.leftPercent < b.leftPercent;
  return KIND_ORDER[a.window.kind] < KIND_ORDER[b.window.kind];
}

function unknownAdvice(rawMessage?: string | null): WindowAdvice {
  const message = rawMessage?.trim() ?? '';
  return {
    availability: 'unknown',
    leftPercent: null,
    bindingWindow: null,
    resetsAt: null,
    resetsInMinutes: null,
    runway: null,
    reason: message.length > 0 ? message : 'no usage numbers available',
  };
}

function unknownRouting(row: ProviderQuota): ProviderRouting {
  return {
    provider: row.provider,
    ...unknownAdvice(row.message),
  };
}

function noteSuffixFor(window: QuotaWindow): string {
  const note = window.note?.trim() ?? '';
  if (note.startsWith('tightest:')) return ` (${note})`;
  return '';
}

function reasonFor(binding: UsableWindow): string {
  const label = LABEL[binding.window.kind];
  const left = binding.leftPercent;
  const duration =
    binding.resetsInMinutes !== null
      ? formatDuration(binding.resetsInMinutes * MINUTE_MS)
      : null;
  const resetClause = duration !== null ? `, resets in ${duration}` : '';
  const runwayClause =
    binding.runway !== null && binding.runway > 0 ? ` (runway ${binding.runway}x)` : '';
  const suffix = noteSuffixFor(binding.window);

  if (binding.resetting) {
    const base =
      duration !== null
        ? `${label} window resets in ${duration}`
        : `${label} window resets soon`;
    return `${base}${suffix}`;
  }
  if (binding.availability === 'exhausted') {
    return `${label} window used up${resetClause}${suffix}`;
  }
  if (binding.availability === 'low' && left < 15) {
    return `only ${left}% of the ${label} window left${resetClause}${runwayClause}${suffix}`;
  }
  if (binding.availability === 'low') {
    const untilReset = duration !== null ? ` but ${duration} until reset` : '';
    return `${left}% of the ${label} window left${untilReset}${runwayClause}${suffix}`;
  }
  return `${left}% of the ${label} window left${resetClause}${runwayClause}${suffix}`;
}

/** Assesses a list of quota windows against `now` and returns the most binding advice. Pure. */
export function adviseWindows(
  windows: readonly QuotaWindow[],
  now: Date,
  fallbackMessage?: string | null,
): WindowAdvice {
  const usable: UsableWindow[] = [];
  for (const window of windows) {
    const assessed = assessWindow(window, now);
    if (assessed.availability !== 'unknown' && assessed.leftPercent !== null) {
      usable.push({
        window,
        availability: assessed.availability,
        leftPercent: assessed.leftPercent,
        resetsInMinutes: assessed.resetsInMinutes,
        runway: assessed.runway,
        resetting: assessed.resetting,
      });
    }
  }

  if (usable.length === 0) {
    return unknownAdvice(fallbackMessage);
  }

  const binding = usable.reduce((best, candidate) =>
    isMoreBinding(candidate, best) ? candidate : best,
  );

  return {
    availability: binding.availability,
    leftPercent: binding.leftPercent,
    bindingWindow: binding.window.kind,
    resetsAt: binding.window.resetsAt,
    resetsInMinutes: binding.resetsInMinutes,
    runway: binding.resetting ? null : binding.runway,
    reason: reasonFor(binding),
  };
}

function providerSummaryWindows(row: ProviderQuota): readonly QuotaWindow[] {
  if (row.provider !== 'agy' || !Array.isArray(row.scopedLimits) || row.scopedLimits.length === 0) {
    return row.windows;
  }
  const scopes = new Set(row.scopedLimits.map((entry) => entry.scope));
  if (scopes.size < 2) return row.windows;
  return row.windows.map((window) => {
    if (window.note && window.note.trim().length > 0) return window;
    const candidates = row.scopedLimits!.filter(
      (entry) => entry.kind === window.kind && entry.usedPercent !== null,
    );
    if (candidates.length === 0) return window;
    let best = candidates[0];
    for (const entry of candidates.slice(1)) {
      if ((entry.usedPercent ?? -1) > (best.usedPercent ?? -1)) best = entry;
    }
    return { ...window, note: `tightest: ${best.scope}` };
  });
}

function adviseRow(row: ProviderQuota, now: Date): ProviderRouting {
  if (row.status !== 'ok') {
    return unknownRouting(row);
  }
  const advice = adviseWindows(providerSummaryWindows(row), now, row.message);
  return {
    provider: row.provider,
    ...advice,
  };
}

function resolvePickNow(now: Date | undefined, observedAt: string | undefined): Date {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now;
  if (typeof observedAt === 'string') {
    const parsed = Date.parse(observedAt);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  return new Date();
}

/**
 * Computes routing availability for a single routing pick (`provider` + `model`).
 * For `agy`, evaluates the quota windows of the rate-limit pool that governs `pick.model`
 * (or the tightest pool when the model ID is unknown or has no matching `scopedLimits`).
 * For all other providers, uses the provider-level routing entry.
 */
export function advisePickRouting(
  pick: Pick<RoutingPick, 'provider' | 'model'>,
  quota: readonly ProviderQuota[],
  routing: readonly ProviderRouting[],
  now?: Date,
): WindowAdvice {
  const quotaRow = quota.find((entry) => entry.provider === pick.provider);
  const route = routing.find((entry) => entry.provider === pick.provider);

  if (pick.provider === 'agy' && quotaRow !== undefined && quotaRow.status === 'ok') {
    const poolWindows = agyWindowsForModel(quotaRow, pick.model);
    if (poolWindows.length > 0) {
      const refNow = resolvePickNow(now, quotaRow.observedAt);
      const advice = adviseWindows(poolWindows, refNow, quotaRow.message);
      if (advice.availability !== 'unknown' || route === undefined) {
        return advice;
      }
    }
  }

  if (route !== undefined) {
    return {
      availability: route.availability,
      leftPercent: route.leftPercent,
      bindingWindow: route.bindingWindow,
      resetsAt: route.resetsAt,
      resetsInMinutes: route.resetsInMinutes,
      runway: route.runway,
      reason: route.reason,
    };
  }

  return unknownAdvice(quotaRow?.message);
}

/** Quota left scaled by pace: 0% left always scores 0; null left scores -1. */
function score(advice: ProviderRouting): number {
  if (advice.leftPercent === null) return -1;
  return (advice.leftPercent / 100) * Math.min(1, advice.runway ?? 1);
}

function compareRouting(a: ProviderRouting, b: ProviderRouting): number {
  const rankDiff = RANK[a.availability] - RANK[b.availability];
  if (rankDiff !== 0) return rankDiff;

  const scoreDiff = score(b) - score(a);
  if (scoreDiff !== 0) return scoreDiff;

  return QUOTA_PROVIDER_IDS.indexOf(a.provider) - QUOTA_PROVIDER_IDS.indexOf(b.provider);
}

export const adviseQuotaRouting: QuotaRoutingAdvisor = (rows, now) =>
  rows.map((row) => adviseRow(row, now)).sort(compareRouting);
