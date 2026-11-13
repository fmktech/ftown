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

function samePick(a: RoutingPick, b: RoutingPick): boolean {
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

/** A state after a real change: always dirty. */
function edited(config: ModelRoutingConfig): RoutingEditorState {
  return { config, dirty: true };
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
  return edited({ ...state.config, tiers: replaceAt(tiers, tierIndex, updated) });
}

export function initialRoutingEditorState(config: ModelRoutingConfig): RoutingEditorState {
  return { config: copyConfig(config), dirty: false };
}

export function routingEditorReducer(state: RoutingEditorState, action: RoutingEditorAction): RoutingEditorState {
  switch (action.type) {
    case 'reset':
      return initialRoutingEditorState(action.config);

    case 'set_steering': {
      const steering = action.value.slice(0, MODEL_ROUTING_LIMITS.maxSteeringLength);
      if (steering === state.config.steering) return state;
      return edited({ ...state.config, steering });
    }

    case 'add_tier': {
      const tiers = state.config.tiers;
      if (tiers.length >= MODEL_ROUTING_LIMITS.maxTiers) return state;
      const name = uniqueTierName(tiers.map((tier) => tier.name));
      return edited({ ...state.config, tiers: [...tiers, { name, description: '', picks: [], guidance: '' }] });
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
      return edited({ ...state.config, tiers: tiers.filter((_, i) => i !== action.index) });
    }

    case 'move_tier': {
      const tiers = state.config.tiers;
      const { index, direction } = action;
      if (!inRange(tiers, index) || !inRange(tiers, index + direction)) return state;
      return edited({ ...state.config, tiers: swapWithNeighbour(tiers, index, direction) });
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

const PRICING_VALUES: readonly ModelPricing[] = ['free', 'included', 'paid'];

/** A copy of `tier` with `guidance` forced to a string ("" when missing or not a string). Null if not an object. */
function normalizeTierGuidance(tier: unknown): Record<string, unknown> | null {
  if (!isRecord(tier)) return null;
  return { ...tier, guidance: typeof tier.guidance === 'string' ? tier.guidance : '' };
}

/** Config tiers: objects with a picks array; guidance defaulted. Null when any tier is malformed. */
function normalizeConfigTiers(tiers: readonly unknown[]): Record<string, unknown>[] | null {
  const out: Record<string, unknown>[] = [];
  for (const raw of tiers) {
    const tier = normalizeTierGuidance(raw);
    if (tier === null || !Array.isArray(tier.picks)) return null;
    out.push(tier);
  }
  return out;
}

/** Annotated tiers: guidance defaulted, each pick's `checked` true only when strictly true. */
function normalizeAnnotatedTiers(tiers: readonly unknown[]): Record<string, unknown>[] | null {
  const out: Record<string, unknown>[] = [];
  for (const raw of tiers) {
    const tier = normalizeTierGuidance(raw);
    if (tier === null || !Array.isArray(tier.picks)) return null;
    const picks: Record<string, unknown>[] = [];
    for (const pick of tier.picks) {
      if (!isRecord(pick)) return null;
      picks.push({ ...pick, checked: pick.checked === true });
    }
    out.push({ ...tier, picks });
  }
  return out;
}

/** Model lists: `pricing` kept only when it is a known cost class. */
function normalizeModelLists(entries: readonly unknown[]): Record<string, unknown>[] | null {
  const out: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.models)) return null;
    const models: Record<string, unknown>[] = [];
    for (const model of entry.models) {
      if (!isRecord(model)) return null;
      const { pricing, ...rest } = model;
      models.push(PRICING_VALUES.includes(pricing as ModelPricing) ? { ...rest, pricing } : rest);
    }
    out.push({ ...entry, models });
  }
  return out;
}

/**
 * Structural check of a `get_model_routing` result. Never throws. Returns a
 * normalised copy: tier `guidance` defaults to "", annotated picks get a
 * strict boolean `checked`, unknown model `pricing` values are dropped.
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
    if (configTiers === null || reportTiers === null || models === null) return null;

    const snapshot = {
      ...data,
      config: { ...config, tiers: configTiers },
      report: { ...report, tiers: reportTiers, models },
    };
    return snapshot as unknown as ModelRoutingSnapshot;
  } catch (error) {
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
