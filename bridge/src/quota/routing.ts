import { formatDuration } from './format.js';
import { QUOTA_PROVIDER_IDS } from './types.js';
import type {
  ProviderQuota,
  ProviderRouting,
  QuotaAvailability,
  QuotaRoutingAdvisor,
  QuotaWindow,
  QuotaWindowKind,
} from './types.js';

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

function unknownRouting(row: ProviderQuota): ProviderRouting {
  const message = row.message?.trim() ?? '';
  return {
    provider: row.provider,
    availability: 'unknown',
    leftPercent: null,
    bindingWindow: null,
    resetsAt: null,
    resetsInMinutes: null,
    runway: null,
    reason: message.length > 0 ? message : 'no usage numbers available',
  };
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

  if (binding.resetting) {
    return duration !== null
      ? `${label} window resets in ${duration}`
      : `${label} window resets soon`;
  }
  if (binding.availability === 'exhausted') {
    return `${label} window used up${resetClause}`;
  }
  if (binding.availability === 'low' && left < 15) {
    return `only ${left}% of the ${label} window left${resetClause}${runwayClause}`;
  }
  if (binding.availability === 'low') {
    const untilReset = duration !== null ? ` but ${duration} until reset` : '';
    return `${left}% of the ${label} window left${untilReset}${runwayClause}`;
  }
  return `${left}% of the ${label} window left${resetClause}${runwayClause}`;
}

function adviseRow(row: ProviderQuota, now: Date): ProviderRouting {
  const usable: UsableWindow[] = [];
  for (const window of row.windows) {
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

  if (row.status !== 'ok' || usable.length === 0) {
    return unknownRouting(row);
  }

  const binding = usable.reduce((best, candidate) =>
    isMoreBinding(candidate, best) ? candidate : best,
  );

  return {
    provider: row.provider,
    availability: binding.availability,
    leftPercent: binding.leftPercent,
    bindingWindow: binding.window.kind,
    resetsAt: binding.window.resetsAt,
    resetsInMinutes: binding.resetsInMinutes,
    runway: binding.resetting ? null : binding.runway,
    reason: reasonFor(binding),
  };
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
