import {
  MODEL_ROUTING_LIMITS,
  MODEL_ROUTING_SCHEMA,
  QUOTA_PROVIDER_IDS,
  ROUTING_TIER_NAME_PATTERN,
} from '../../../bridge/src/quota/types';
import type {
  HarnessModel,
  ModelPricing,
  ModelRoutingConfig,
  ModelRoutingSnapshot,
  QuotaProviderId,
  QuotaReport,
  RoutingPick,
  RoutingTier,
  SetModelRoutingResult,
} from '../../../bridge/src/quota/types';

/** Pure client-side logic for the dashboard's model routing editor. No React, no I/O. */

export type RoutingEditorAction =
  | { type: 'reset'; config: ModelRoutingConfig }
  | { type: 'set_steering'; value: string }
  | { type: 'add_tier' }
  | { type: 'rename_tier'; index: number; name: string }
  | { type: 'set_tier_description'; index: number; value: string }
  | { type: 'set_tier_guidance'; index: number; value: string }
  | { type: 'remove_tier'; index: number }
  | { type: 'move_tier'; index: number; direction: -1 | 1 }
  | { type: 'add_pick'; tier: number; pick: RoutingPick }
  | { type: 'update_pick'; tier: number; index: number; pick: RoutingPick }
  | { type: 'remove_pick'; tier: number; index: number }
  | { type: 'move_pick'; tier: number; index: number; direction: -1 | 1 };

export interface RoutingEditorState {
  config: ModelRoutingConfig;
  dirty: boolean;
  /** Stored name of each tier when it was loaded or reset. Null if this draft added the tier. Not saved. */
  tierOrigins: (string | null)[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function copyPick(pick: RoutingPick): RoutingPick {
  return { provider: pick.provider, model: pick.model, effort: pick.effort };
}

function copyTier(tier: RoutingTier): RoutingTier {
  return { name: tier.name, description: tier.description, picks: tier.picks.map(copyPick), guidance: tier.guidance };
}

function copyConfig(config: ModelRoutingConfig): ModelRoutingConfig {
  return { version: config.version, tiers: config.tiers.map(copyTier), steering: config.steering };
}

function samePick(
  a: { provider: string; model: string; effort: string | null },
  b: { provider: string; model: string; effort: string | null },
): boolean {
  return a.provider === b.provider && a.model === b.model && a.effort === b.effort;
}

function inRange(list: readonly unknown[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < list.length;
}

function replaceAt<T>(list: readonly T[], index: number, value: T): T[] {
  const next = list.slice();
  next[index] = value;
  return next;
}

function swapWithNeighbour<T>(list: readonly T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  const next = list.slice();
  next[index] = list[target];
  next[target] = list[index];
  return next;
}

/** A state after a real change: always dirty. Origins are copied so the previous state stays untouched. */
function edited(config: ModelRoutingConfig, tierOrigins: readonly (string | null)[]): RoutingEditorState {
  return { config, dirty: true, tierOrigins: tierOrigins.slice() };
}

/**
 * Applies `change` to one tier. `change` returns null for a no-op, in which
 * case the original state object is returned unchanged.
 */
function changeTier(
  state: RoutingEditorState,
  tierIndex: number,
  change: (tier: RoutingTier) => RoutingTier | null,
): RoutingEditorState {
  const tiers = state.config.tiers;
  if (!inRange(tiers, tierIndex)) return state;
  const updated = change(tiers[tierIndex]);
  if (updated === null) return state;
  return edited({ ...state.config, tiers: replaceAt(tiers, tierIndex, updated) }, state.tierOrigins);
}

export function initialRoutingEditorState(config: ModelRoutingConfig): RoutingEditorState {
  const copy = copyConfig(config);
  return { config: copy, dirty: false, tierOrigins: copy.tiers.map((tier) => tier.name) };
}

export function routingEditorReducer(state: RoutingEditorState, action: RoutingEditorAction): RoutingEditorState {
  switch (action.type) {
    case 'reset':
      return initialRoutingEditorState(action.config);

    case 'set_steering': {
      const steering = action.value.slice(0, MODEL_ROUTING_LIMITS.maxSteeringLength);
      if (steering === state.config.steering) return state;
      return edited({ ...state.config, steering }, state.tierOrigins);
    }

    case 'add_tier': {
      const tiers = state.config.tiers;
      if (tiers.length >= MODEL_ROUTING_LIMITS.maxTiers) return state;
      const name = uniqueTierName(tiers.map((tier) => tier.name));
      return edited(
        { ...state.config, tiers: [...tiers, { name, description: '', picks: [], guidance: '' }] },
        [...state.tierOrigins, null],
      );
    }

    case 'rename_tier': {
      const { index, name } = action;
      return changeTier(state, index, (tier) => (tier.name === name ? null : { ...tier, name }));
    }

    case 'set_tier_description': {
      const { index, value } = action;
      return changeTier(state, index, (tier) => (tier.description === value ? null : { ...tier, description: value }));
    }

    case 'set_tier_guidance': {
      const { index, value } = action;
      return changeTier(state, index, (tier) => (tier.guidance === value ? null : { ...tier, guidance: value }));
    }

    case 'remove_tier': {
      const tiers = state.config.tiers;
      if (!inRange(tiers, action.index)) return state;
      return edited(
        { ...state.config, tiers: tiers.filter((_, i) => i !== action.index) },
        state.tierOrigins.filter((_, i) => i !== action.index),
      );
    }

    case 'move_tier': {
      const tiers = state.config.tiers;
      const { index, direction } = action;
      if (!inRange(tiers, index) || !inRange(tiers, index + direction)) return state;
      return edited(
        { ...state.config, tiers: swapWithNeighbour(tiers, index, direction) },
        swapWithNeighbour(state.tierOrigins, index, direction),
      );
    }

    case 'add_pick': {
      const { tier: tierIndex, pick } = action;
      return changeTier(state, tierIndex, (tier) =>
        tier.picks.length >= MODEL_ROUTING_LIMITS.maxPicksPerTier
          ? null
          : { ...tier, picks: [...tier.picks, copyPick(pick)] },
      );
    }

    case 'update_pick': {
      const { tier: tierIndex, index, pick } = action;
      return changeTier(state, tierIndex, (tier) => {
        if (!inRange(tier.picks, index) || samePick(tier.picks[index], pick)) return null;
        return { ...tier, picks: replaceAt(tier.picks, index, copyPick(pick)) };
      });
    }

    case 'remove_pick': {
      const { tier: tierIndex, index } = action;
      return changeTier(state, tierIndex, (tier) =>
        inRange(tier.picks, index) ? { ...tier, picks: tier.picks.filter((_, i) => i !== index) } : null,
      );
    }

    case 'move_pick': {
      const { tier: tierIndex, index, direction } = action;
      return changeTier(state, tierIndex, (tier) =>
        inRange(tier.picks, index) && inRange(tier.picks, index + direction)
          ? { ...tier, picks: swapWithNeighbour(tier.picks, index, direction) }
          : null,
      );
    }

    default:
      return state;
  }
}

/** `base` if unused, else `base-2`, `base-3`, ... (the first unused). */
export function uniqueTierName(existing: readonly string[], base: string = 'tier'): string {
  if (!existing.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

function modelsEntry(report: QuotaReport, provider: QuotaProviderId) {
  return report.models.find((entry) => entry.provider === provider);
}

export function providerOptions(
  report: QuotaReport,
): { provider: QuotaProviderId; available: boolean; reason: string | null }[] {
  return QUOTA_PROVIDER_IDS.map((provider) => {
    const entry = modelsEntry(report, provider);
    if (entry === undefined) return { provider, available: false, reason: 'not checked' };
    const available = entry.status === 'ok' && entry.models.length > 0;
    if (available) return { provider, available: true, reason: null };
    const message = entry.message !== null && entry.message.trim() !== '' ? entry.message : null;
    return { provider, available: false, reason: message ?? 'no models reported' };
  });
}

export function modelOptions(report: QuotaReport, provider: QuotaProviderId): HarnessModel[] {
  const entry = modelsEntry(report, provider);
  return entry !== undefined && entry.status === 'ok' ? entry.models.slice() : [];
}

const PRICING_LABEL: Record<ModelPricing, string> = { free: ' (free)', included: ' (included in plan)', paid: '' };

/**
 * Text of a model's <option>: its name (or id), then its cost class for free
 * and included models, then " (default)" for the harness default. The option
 * value stays the model id.
 */
export function modelOptionLabel(model: HarnessModel): string {
  const pricing = model.pricing !== undefined ? (PRICING_LABEL[model.pricing] ?? '') : '';
  return `${model.name ?? model.id}${pricing}${model.isDefault ? ' (default)' : ''}`;
}

export function effortOptions(
  report: QuotaReport,
  provider: QuotaProviderId,
  model: string,
): { efforts: string[]; defaultEffort: string | null } {
  const found = modelOptions(report, provider).find((candidate) => candidate.id === model);
  if (found === undefined) return { efforts: [], defaultEffort: null };
  return { efforts: found.efforts.slice(), defaultEffort: found.defaultEffort };
}

export function defaultPickFor(report: QuotaReport, provider: QuotaProviderId): RoutingPick | null {
  const models = modelOptions(report, provider);
  if (models.length === 0) return null;
  const model = models.find((candidate) => candidate.isDefault) ?? models[0];
  const effort =
    model.defaultEffort !== null && model.efforts.includes(model.defaultEffort) ? model.defaultEffort : null;
  return { provider, model: model.id, effort };
}

export function normalizePick(report: QuotaReport, pick: RoutingPick): RoutingPick {
  const models = modelOptions(report, pick.provider);
  if (models.length === 0) return copyPick(pick);

  let model = models.find((candidate) => candidate.id === pick.model);
  if (model === undefined) {
    const fallback = defaultPickFor(report, pick.provider);
    if (fallback === null) return copyPick(pick);
    model = models.find((candidate) => candidate.id === fallback.model);
    if (model === undefined) return copyPick(pick);
  }

  let effort: string | null;
  if (model.efforts.length === 0 || pick.effort === null) {
    effort = null;
  } else if (model.efforts.includes(pick.effort)) {
    effort = pick.effort;
  } else {
    effort =
      model.defaultEffort !== null && model.efforts.includes(model.defaultEffort) ? model.defaultEffort : null;
  }
  return { provider: pick.provider, model: model.id, effort };
}

/** Structural checks mirroring the bridge's rules, so errors show before saving. Empty list = valid. */
export function validateRoutingDraft(config: ModelRoutingConfig): string[] {
  const errors: string[] = [];
  const limits = MODEL_ROUTING_LIMITS;
  const tiers = config.tiers;

  if (tiers.length > limits.maxTiers) {
    errors.push(`There are ${tiers.length} tiers; the limit is ${limits.maxTiers}.`);
  }

  const namesSeen = new Map<string, number>();
  tiers.forEach((tier, tierIndex) => {
    const label = `Tier ${tierIndex + 1}`;
    const name = tier.name.trim();
    if (name === '') {
      errors.push(`${label}: name is required.`);
    } else {
      if (name.length > limits.maxTierNameLength) {
        errors.push(`${label}: name must be at most ${limits.maxTierNameLength} characters.`);
      }
      if (!ROUTING_TIER_NAME_PATTERN.test(name)) {
        errors.push(`${label}: name must be lowercase letters, digits, "-" or "_".`);
      }
      const firstSeen = namesSeen.get(name);
      if (firstSeen !== undefined) {
        errors.push(`${label}: name "${name}" is already used by Tier ${firstSeen}.`);
      } else {
        namesSeen.set(name, tierIndex + 1);
      }
    }

    if (tier.description.length > limits.maxTierDescriptionLength) {
      errors.push(`${label}: description must be at most ${limits.maxTierDescriptionLength} characters.`);
    }

    if (tier.guidance.length > limits.maxTierGuidanceLength) {
      errors.push(`${label}: guidance must be at most ${limits.maxTierGuidanceLength} characters.`);
    }

    if (tier.picks.length > limits.maxPicksPerTier) {
      errors.push(`${label}: at most ${limits.maxPicksPerTier} picks are allowed.`);
    }

    const keysSeen = new Set<string>();
    tier.picks.forEach((pick, pickIndex) => {
      const pickLabel = `${label}, pick ${pickIndex + 1}`;
      if (pick.model.trim() === '') {
        errors.push(`${pickLabel}: model is required.`);
      }
      const key = JSON.stringify([pick.provider, pick.model, pick.effort]);
      if (keysSeen.has(key)) {
        errors.push(`${pickLabel}: duplicates an earlier pick in this tier.`);
      }
      keysSeen.add(key);
    });
  });

  if (config.steering.length > limits.maxSteeringLength) {
    errors.push(`Steering must be at most ${limits.maxSteeringLength} characters.`);
  }

  return errors;
}

/** The annotated pick in the tier originally named `originName` with this provider, model and effort. */
export function findAnnotatedPick<T extends { provider: string; model: string; effort: string | null }>(
  tiers: readonly { name: string; picks: readonly T[] }[],
  originName: string | null,
  pick: { provider: string; model: string; effort: string | null },
): T | null {
  if (originName === null) return null;
  const tier = tiers.find((candidate) => candidate.name === originName);
  if (tier === undefined) return null;
  return tier.picks.find((candidate) => samePick(candidate, pick)) ?? null;
}

/** Config to keep after a successful save: the snapshot loaded after the save, or the saved draft if that load failed. */
export function configBaselineAfterSave(draft: ModelRoutingConfig, fresh: ModelRoutingSnapshot | null): ModelRoutingConfig {
  return fresh === null ? draft : fresh.config;
}

const PRICING_VALUES: readonly ModelPricing[] = ['free', 'included', 'paid'];
const AVAILABILITIES = ['available', 'low', 'exhausted', 'unknown'] as const;

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Tier name must be a string. Description and guidance default to "". Null if the tier is not usable. */
function normalizeTierShape(tier: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof tier.name !== 'string') return null;
  return {
    ...tier,
    description: typeof tier.description === 'string' ? tier.description : '',
    guidance: typeof tier.guidance === 'string' ? tier.guidance : '',
  };
}

/** A stored pick the editor can copy. Null when provider/model/effort are not usable. Missing effort becomes null. */
function normalizeConfigPick(pick: unknown): Record<string, unknown> | null {
  if (!isRecord(pick)) return null;
  if (typeof pick.provider !== 'string' || typeof pick.model !== 'string') return null;
  if (pick.effort !== null && pick.effort !== undefined && typeof pick.effort !== 'string') return null;
  return { provider: pick.provider, model: pick.model, effort: typeof pick.effort === 'string' ? pick.effort : null };
}

/** Config tiers. Null when any tier or pick is malformed. */
function normalizeConfigTiers(tiers: readonly unknown[]): Record<string, unknown>[] | null {
  const out: Record<string, unknown>[] = [];
  for (const raw of tiers) {
    if (!isRecord(raw) || !Array.isArray(raw.picks)) return null;
    const tier = normalizeTierShape(raw);
    if (tier === null) return null;
    const picks: Record<string, unknown>[] = [];
    for (const pick of raw.picks) {
      const normalized = normalizeConfigPick(pick);
      if (normalized === null) return null;
      picks.push(normalized);
    }
    out.push({ ...tier, picks });
  }
  return out;
}

/** Annotated tiers. A null or non-object pick rejects the snapshot. `problem` is a string or null. */
function normalizeAnnotatedTiers(tiers: readonly unknown[]): Record<string, unknown>[] | null {
  const out: Record<string, unknown>[] = [];
  for (const raw of tiers) {
    if (!isRecord(raw) || !Array.isArray(raw.picks)) return null;
    const tier = normalizeTierShape(raw);
    if (tier === null) return null;
    const picks: Record<string, unknown>[] = [];
    for (const pick of raw.picks) {
      if (!isRecord(pick)) return null;
      picks.push({ ...pick, checked: pick.checked === true, problem: typeof pick.problem === 'string' ? pick.problem : null });
    }
    out.push({ ...tier, picks });
  }
  return out;
}

/** One harness model. Null when it is not an object or has no string id. Efforts default to []. */
function normalizeModel(model: unknown): Record<string, unknown> | null {
  if (!isRecord(model) || typeof model.id !== 'string') return null;
  const { pricing, ...rest } = model;
  const efforts = Array.isArray(model.efforts) ? model.efforts.filter((effort): effort is string => typeof effort === 'string') : [];
  const normalized: Record<string, unknown> = {
    ...rest,
    id: model.id,
    name: stringOrNull(model.name),
    description: stringOrNull(model.description),
    isDefault: model.isDefault === true,
    efforts,
    defaultEffort: stringOrNull(model.defaultEffort),
  };
  if (PRICING_VALUES.includes(pricing as ModelPricing)) normalized.pricing = pricing;
  return normalized;
}

/** Model lists. `pricing` is kept only for a known cost class. `message` is a string or null. */
function normalizeModelLists(entries: readonly unknown[]): Record<string, unknown>[] | null {
  const out: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.models)) return null;
    const models: Record<string, unknown>[] = [];
    for (const model of entry.models) {
      const normalized = normalizeModel(model);
      if (normalized === null) return null;
      models.push(normalized);
    }
    out.push({ ...entry, models, message: stringOrNull(entry.message) });
  }
  return out;
}

/** One quota window, or null when the element is not an object (the row is kept). */
function normalizeWindow(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return {
    kind: typeof value.kind === 'string' ? value.kind : null,
    usedPercent: finiteOrNull(value.usedPercent),
    resetsAt: stringOrNull(value.resetsAt),
    windowMinutes: finiteOrNull(value.windowMinutes),
    note: stringOrNull(value.note),
  };
}

/** Provider rows. Null when a row is not an object or its provider is not a string. Missing windows become []. */
function normalizeProviders(rows: readonly unknown[]): Record<string, unknown>[] | null {
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.provider !== 'string') return null;
    const windows = Array.isArray(row.windows)
      ? row.windows.flatMap((item) => {
          const window = normalizeWindow(item);
          return window === null ? [] : [window];
        })
      : [];
    out.push({
      ...row,
      provider: row.provider,
      status: typeof row.status === 'string' ? row.status : 'error',
      plan: stringOrNull(row.plan),
      message: stringOrNull(row.message),
      windows,
    });
  }
  return out;
}

/** Routing advice. Null when an entry is not an object. Availability outside the known set becomes "unknown". */
function normalizeRouting(entries: readonly unknown[]): Record<string, unknown>[] | null {
  const out: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) return null;
    const availability = (AVAILABILITIES as readonly string[]).includes(entry.availability as string)
      ? entry.availability
      : 'unknown';
    out.push({
      ...entry,
      provider: typeof entry.provider === 'string' ? entry.provider : '',
      availability,
      leftPercent: finiteOrNull(entry.leftPercent),
      reason: typeof entry.reason === 'string' ? entry.reason : '',
    });
  }
  return out;
}

/** routingConfig. Non-string errors are dropped. A non-string status becomes "invalid". */
function normalizeRoutingConfig(value: Record<string, unknown>): Record<string, unknown> {
  const errors = Array.isArray(value.errors) ? value.errors.filter((item): item is string => typeof item === 'string') : [];
  return {
    ...value,
    status: typeof value.status === 'string' ? value.status : 'invalid',
    path: typeof value.path === 'string' ? value.path : '',
    errors,
  };
}

/**
 * Structural check of a `get_model_routing` result. Never throws. Returns a
 * normalised copy, or null when a tier, pick, model or provider row is not
 * usable. Loose fields the dialog reads are coerced so render cannot throw.
 */
export function parseModelRoutingSnapshot(data: unknown): ModelRoutingSnapshot | null {
  try {
    if (!isRecord(data) || data.schema !== MODEL_ROUTING_SCHEMA) return null;

    const config = data.config;
    if (
      !isRecord(config) ||
      config.version !== 1 ||
      !Array.isArray(config.tiers) ||
      typeof config.steering !== 'string'
    ) {
      return null;
    }

    const report = data.report;
    if (
      !isRecord(report) ||
      !['providers', 'routing', 'models', 'tiers'].every((key) => Array.isArray(report[key])) ||
      !isRecord(report.routingConfig) ||
      typeof report.steering !== 'string'
    ) {
      return null;
    }

    if (typeof data.cached !== 'boolean') return null;

    const configTiers = normalizeConfigTiers(config.tiers);
    const reportTiers = normalizeAnnotatedTiers(report.tiers as unknown[]);
    const models = normalizeModelLists(report.models as unknown[]);
    const providers = normalizeProviders(report.providers as unknown[]);
    const routing = normalizeRouting(report.routing as unknown[]);
    if (configTiers === null || reportTiers === null || models === null || providers === null || routing === null) return null;

    const snapshot = {
      ...data,
      config: { ...config, tiers: configTiers },
      report: {
        ...report,
        providers,
        routing,
        tiers: reportTiers,
        models,
        routingConfig: normalizeRoutingConfig(report.routingConfig as Record<string, unknown>),
      },
    };
    return snapshot as unknown as ModelRoutingSnapshot;
  } catch {
    return null;
  }
}

/** Shallow structural check of a `set_model_routing` result. Never throws. `invalidFileBlocked` is true only when strictly true. */
export function parseSetModelRoutingResult(data: unknown): SetModelRoutingResult | null {
  try {
    if (!isRecord(data) || data.schema !== MODEL_ROUTING_SCHEMA) return null;
    if (typeof data.saved !== 'boolean') return null;
    if (!Array.isArray(data.errors) || !data.errors.every((item) => typeof item === 'string')) return null;
    return {
      schema: MODEL_ROUTING_SCHEMA,
      saved: data.saved,
      errors: data.errors.slice() as string[],
      invalidFileBlocked: data.invalidFileBlocked === true,
    };
  } catch (error) {
    return null;
  }
}

/** `<provider> / <model>` plus ` @ <effort>` when an effort is set. */
export function pickLabel(pick: RoutingPick): string {
  return `${pick.provider} / ${pick.model}${pick.effort ? ` @ ${pick.effort}` : ''}`;
}
