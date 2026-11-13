import { describe, expect, it } from 'vitest';
import { MODEL_ROUTING_LIMITS } from '../../../bridge/src/quota/types';
import type {
  HarnessModel,
  ModelRoutingConfig,
  ProviderModels,
  QuotaProviderId,
  QuotaReport,
  RoutingPick,
  RoutingTier,
} from '../../../bridge/src/quota/types';
import {
  defaultPickFor,
  effortOptions,
  initialRoutingEditorState,
  modelOptionLabel,
  modelOptions,
  normalizePick,
  parseModelRoutingSnapshot,
  parseSetModelRoutingResult,
  pickLabel,
  providerOptions,
  routingEditorReducer,
  uniqueTierName,
  validateRoutingDraft,
} from './model-routing';
import type { RoutingEditorAction, RoutingEditorState } from './model-routing';

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
};

const pick = (provider: QuotaProviderId, model: string, effort: string | null = null): RoutingPick => ({ provider, model, effort });
const tier = (name: string, picks: RoutingPick[] = [], description = '', guidance = ''): RoutingTier => ({ name, description, picks, guidance });
const config = (tiers: RoutingTier[] = [], steering = ''): ModelRoutingConfig => ({ version: 1, tiers, steering });

const harnessModel = (id: string, extra: Partial<HarnessModel> = {}): HarnessModel => ({
  id,
  name: null,
  isDefault: false,
  description: null,
  contextTokens: null,
  efforts: [],
  defaultEffort: null,
  ...extra,
});

const modelsEntry = (
  provider: QuotaProviderId,
  status: ProviderModels['status'],
  models: HarnessModel[],
  message: string | null = null,
): ProviderModels => ({
  provider,
  status,
  models,
  source: 'live',
  observedAt: '2026-11-13T10:00:00.000Z',
  message,
  modelFlag: '--model <id>',
  effortFlag: '--effort <level>',
});

/** Realistic report: claude + codex ok, grok error with message, muse absent, agy ok, opencode ok but empty. */
const fixtureReport = (): QuotaReport => ({
  generatedAt: '2026-11-13T10:00:00.000Z',
  providers: [],
  routing: [],
  models: [
    modelsEntry('claude', 'ok', [
      harnessModel('claude-opus-4', { name: 'Opus 4', efforts: ['low', 'high'], defaultEffort: 'high' }),
      harnessModel('claude-sonnet-4', { name: 'Sonnet 4', isDefault: true }),
    ]),
    modelsEntry('codex', 'ok', [
      harnessModel('gpt-5', { efforts: ['minimal', 'low', 'high'], defaultEffort: 'low' }),
      harnessModel('gpt-5-mini', { isDefault: true }),
    ]),
    modelsEntry('grok', 'error', [], 'login expired; run grok login'),
    modelsEntry('agy', 'ok', [
      harnessModel('gemini-3-pro-high', { isDefault: true, efforts: ['high'], defaultEffort: 'high' }),
      harnessModel('gemini-3-flash-low', { efforts: ['low'], defaultEffort: null }),
    ]),
    modelsEntry('opencode', 'ok', []),
  ],
  routingConfig: { status: 'missing', path: '/home/u/.ftown/model-routing.json', errors: [] },
  tiers: [],
  steering: '',
});

const stateOf = (cfg: ModelRoutingConfig, dirty = false): RoutingEditorState => ({ config: cfg, dirty });

const reduce = (state: RoutingEditorState, action: RoutingEditorAction): RoutingEditorState =>
  routingEditorReducer(deepFreeze(state), deepFreeze(action));

describe('initialRoutingEditorState', () => {
  it('starts clean and deep-copies the config', () => {
    const source = config([tier('simple', [pick('claude', 'claude-opus-4', 'high')])], 'note');
    const state = initialRoutingEditorState(source);
    expect(state.dirty).toBe(false);
    expect(state.config).toEqual(source);
    expect(state.config).not.toBe(source);
    expect(state.config.tiers[0].picks[0]).not.toBe(source.tiers[0].picks[0]);
  });
});

describe('routingEditorReducer', () => {
  it('reset replaces the config and clears dirty', () => {
    const dirty = stateOf(config([tier('a')]), true);
    const next = reduce(dirty, { type: 'reset', config: config([tier('b')], 'fresh') });
    expect(next.dirty).toBe(false);
    expect(next.config).toEqual(config([tier('b')], 'fresh'));
  });

  it('set_steering stores the value and marks dirty', () => {
    const next = reduce(stateOf(config()), { type: 'set_steering', value: 'keep claude light' });
    expect(next.config.steering).toBe('keep claude light');
    expect(next.dirty).toBe(true);
  });

  it('set_steering returns the same state when the value is unchanged', () => {
    const state = stateOf(config([], 'same'));
    expect(reduce(state, { type: 'set_steering', value: 'same' })).toBe(state);
  });

  it('set_steering truncates to maxSteeringLength', () => {
    const long = 'x'.repeat(MODEL_ROUTING_LIMITS.maxSteeringLength + 50);
    const next = reduce(stateOf(config()), { type: 'set_steering', value: long });
    expect(next.config.steering).toHaveLength(MODEL_ROUTING_LIMITS.maxSteeringLength);
  });

  it('add_tier appends a unique default tier and marks dirty', () => {
    const next = reduce(stateOf(config([tier('tier')])), { type: 'add_tier' });
    expect(next.config.tiers.map((t) => t.name)).toEqual(['tier', 'tier-2']);
    expect(next.config.tiers[1]).toEqual({ name: 'tier-2', description: '', picks: [], guidance: '' });
    expect(next.dirty).toBe(true);
  });

  it('add_tier is a no-op at maxTiers', () => {
    const full = config(Array.from({ length: MODEL_ROUTING_LIMITS.maxTiers }, (_, i) => tier(`t${i}`)));
    const state = stateOf(full);
    expect(reduce(state, { type: 'add_tier' })).toBe(state);
  });

  it('rename_tier stores the name exactly as typed', () => {
    const next = reduce(stateOf(config([tier('a'), tier('b')])), { type: 'rename_tier', index: 1, name: '  Weird Name ' });
    expect(next.config.tiers[1].name).toBe('  Weird Name ');
    expect(next.config.tiers[0].name).toBe('a');
    expect(next.dirty).toBe(true);
  });

  it('rename_tier is a no-op for the same name or an out-of-range index', () => {
    const state = stateOf(config([tier('a')]));
    expect(reduce(state, { type: 'rename_tier', index: 0, name: 'a' })).toBe(state);
    expect(reduce(state, { type: 'rename_tier', index: 3, name: 'z' })).toBe(state);
    expect(reduce(state, { type: 'rename_tier', index: -1, name: 'z' })).toBe(state);
  });

  it('set_tier_description updates the description and no-ops when unchanged', () => {
    const state = stateOf(config([tier('a', [], 'old')]));
    const next = reduce(state, { type: 'set_tier_description', index: 0, value: 'new text' });
    expect(next.config.tiers[0].description).toBe('new text');
    expect(next.dirty).toBe(true);
    expect(reduce(state, { type: 'set_tier_description', index: 0, value: 'old' })).toBe(state);
    expect(reduce(state, { type: 'set_tier_description', index: 9, value: 'x' })).toBe(state);
  });

  it('set_tier_guidance stores the text verbatim and no-ops when unchanged or out of range', () => {
    const state = stateOf(config([tier('a', [], '', 'old'), tier('b')]));
    const next = reduce(state, { type: 'set_tier_guidance', index: 0, value: '  otherwise any free opencode model\n' });
    expect(next.config.tiers[0].guidance).toBe('  otherwise any free opencode model\n');
    expect(next.config.tiers[1].guidance).toBe('');
    expect(next.dirty).toBe(true);
    expect(reduce(state, { type: 'set_tier_guidance', index: 0, value: 'old' })).toBe(state);
    expect(reduce(state, { type: 'set_tier_guidance', index: 2, value: 'x' })).toBe(state);
    expect(reduce(state, { type: 'set_tier_guidance', index: -1, value: 'x' })).toBe(state);
  });

  it('initial state and reset keep tier guidance', () => {
    const source = config([tier('a', [], '', 'prefer cheap')]);
    expect(initialRoutingEditorState(source).config.tiers[0].guidance).toBe('prefer cheap');
    expect(reduce(stateOf(config(), true), { type: 'reset', config: source }).config.tiers[0].guidance).toBe('prefer cheap');
  });

  it('remove_tier removes by index and no-ops when out of range', () => {
    const state = stateOf(config([tier('a'), tier('b'), tier('c')]));
    const next = reduce(state, { type: 'remove_tier', index: 1 });
    expect(next.config.tiers.map((t) => t.name)).toEqual(['a', 'c']);
    expect(next.dirty).toBe(true);
    expect(reduce(state, { type: 'remove_tier', index: 3 })).toBe(state);
  });

  it('move_tier swaps with the neighbour and no-ops beyond either end', () => {
    const state = stateOf(config([tier('a'), tier('b'), tier('c')]));
    const down = reduce(state, { type: 'move_tier', index: 0, direction: 1 });
    expect(down.config.tiers.map((t) => t.name)).toEqual(['b', 'a', 'c']);
    expect(down.dirty).toBe(true);
    const up = reduce(state, { type: 'move_tier', index: 2, direction: -1 });
    expect(up.config.tiers.map((t) => t.name)).toEqual(['a', 'c', 'b']);
    expect(reduce(state, { type: 'move_tier', index: 0, direction: -1 })).toBe(state);
    expect(reduce(state, { type: 'move_tier', index: 2, direction: 1 })).toBe(state);
  });

  it('add_pick appends a copy of the pick', () => {
    const p = pick('codex', 'gpt-5', 'low');
    const next = reduce(stateOf(config([tier('a')])), { type: 'add_pick', tier: 0, pick: p });
    expect(next.config.tiers[0].picks).toEqual([p]);
    expect(next.config.tiers[0].picks[0]).not.toBe(p);
    expect(next.dirty).toBe(true);
  });

  it('add_pick is a no-op at maxPicksPerTier or for a bad tier index', () => {
    const full = config([tier('a', Array.from({ length: MODEL_ROUTING_LIMITS.maxPicksPerTier }, () => pick('claude', 'x')))]);
    const state = stateOf(full);
    expect(reduce(state, { type: 'add_pick', tier: 0, pick: pick('claude', 'y') })).toBe(state);
    expect(reduce(stateOf(config([tier('a')])), { type: 'add_pick', tier: 5, pick: pick('claude', 'y') }).dirty).toBe(false);
  });

  it('update_pick replaces the pick and no-ops when identical or out of range', () => {
    const state = stateOf(config([tier('a', [pick('claude', 'claude-opus-4', 'low')])]));
    const next = reduce(state, { type: 'update_pick', tier: 0, index: 0, pick: pick('claude', 'claude-opus-4', 'high') });
    expect(next.config.tiers[0].picks).toEqual([pick('claude', 'claude-opus-4', 'high')]);
    expect(next.dirty).toBe(true);
    expect(reduce(state, { type: 'update_pick', tier: 0, index: 0, pick: pick('claude', 'claude-opus-4', 'low') })).toBe(state);
    expect(reduce(state, { type: 'update_pick', tier: 0, index: 4, pick: pick('claude', 'x') })).toBe(state);
    expect(reduce(state, { type: 'update_pick', tier: 4, index: 0, pick: pick('claude', 'x') })).toBe(state);
  });

  it('remove_pick removes by index and no-ops when out of range', () => {
    const state = stateOf(config([tier('a', [pick('claude', 'a'), pick('codex', 'b')])]));
    const next = reduce(state, { type: 'remove_pick', tier: 0, index: 0 });
    expect(next.config.tiers[0].picks).toEqual([pick('codex', 'b')]);
    expect(next.dirty).toBe(true);
    expect(reduce(state, { type: 'remove_pick', tier: 0, index: 2 })).toBe(state);
    expect(reduce(state, { type: 'remove_pick', tier: 1, index: 0 })).toBe(state);
  });

  it('move_pick swaps with the neighbour and no-ops beyond either end', () => {
    const state = stateOf(config([tier('a', [pick('claude', 'a'), pick('codex', 'b'), pick('grok', 'c')])]));
    const next = reduce(state, { type: 'move_pick', tier: 0, index: 2, direction: -1 });
    expect(next.config.tiers[0].picks.map((p) => p.model)).toEqual(['a', 'c', 'b']);
    expect(next.dirty).toBe(true);
    expect(reduce(state, { type: 'move_pick', tier: 0, index: 0, direction: -1 })).toBe(state);
    expect(reduce(state, { type: 'move_pick', tier: 0, index: 2, direction: 1 })).toBe(state);
  });

  it('never mutates the input state (deep-frozen input does not throw)', () => {
    const state = deepFreeze(stateOf(config([tier('a', [pick('claude', 'x')]), tier('b')], 's')));
    const actions: RoutingEditorAction[] = [
      { type: 'set_steering', value: 'new' },
      { type: 'add_tier' },
      { type: 'rename_tier', index: 0, name: 'z' },
      { type: 'set_tier_description', index: 0, value: 'd' },
      { type: 'set_tier_guidance', index: 0, value: 'g' },
      { type: 'remove_tier', index: 1 },
      { type: 'move_tier', index: 0, direction: 1 },
      { type: 'add_pick', tier: 1, pick: pick('codex', 'y') },
      { type: 'update_pick', tier: 0, index: 0, pick: pick('claude', 'q', 'high') },
      { type: 'remove_pick', tier: 0, index: 0 },
      { type: 'move_pick', tier: 0, index: 0, direction: 1 },
    ];
    for (const action of actions) {
      expect(() => routingEditorReducer(state, action)).not.toThrow();
    }
    expect(state.config.tiers[0].name).toBe('a');
    expect(state.config.tiers[0].picks[0].model).toBe('x');
  });
});

describe('uniqueTierName', () => {
  it('uses the base when unused, else the first unused numeric suffix', () => {
    expect(uniqueTierName([])).toBe('tier');
    expect(uniqueTierName(['tier'])).toBe('tier-2');
    expect(uniqueTierName(['tier', 'tier-2'])).toBe('tier-3');
    expect(uniqueTierName(['tier-3'])).toBe('tier');
    expect(uniqueTierName(['tier', 'tier-3'], 'tier')).toBe('tier-2');
    expect(uniqueTierName(['complex'], 'complex')).toBe('complex-2');
  });
});

describe('option helpers', () => {
  const report = fixtureReport();

  it('providerOptions lists every provider in canonical order with reasons', () => {
    expect(providerOptions(report)).toEqual([
      { provider: 'claude', available: true, reason: null },
      { provider: 'codex', available: true, reason: null },
      { provider: 'grok', available: false, reason: 'login expired; run grok login' },
      { provider: 'muse', available: false, reason: 'not checked' },
      { provider: 'agy', available: true, reason: null },
      { provider: 'opencode', available: false, reason: 'no models reported' },
    ]);
  });

  it('providerOptions uses "no models reported" for an error without a message', () => {
    const bare = { ...report, models: [modelsEntry('grok', 'error', [], null)] };
    expect(providerOptions(bare).find((p) => p.provider === 'grok')?.reason).toBe('no models reported');
  });

  it('modelOptions returns the models of an ok provider and [] otherwise', () => {
    expect(modelOptions(report, 'claude').map((m) => m.id)).toEqual(['claude-opus-4', 'claude-sonnet-4']);
    expect(modelOptions(report, 'grok')).toEqual([]);
    expect(modelOptions(report, 'muse')).toEqual([]);
    expect(modelOptions(report, 'opencode')).toEqual([]);
  });

  it('modelOptionLabel shows the cost class after the name for free and included models only', () => {
    expect(modelOptionLabel(harnessModel('glm-5.3', { name: 'GLM 5.3', pricing: 'included' }))).toBe('GLM 5.3 (included in plan)');
    expect(modelOptionLabel(harnessModel('big-pickle', { name: 'Big Pickle', pricing: 'free' }))).toBe('Big Pickle (free)');
    expect(modelOptionLabel(harnessModel('gpt-5', { name: 'GPT-5', pricing: 'paid' }))).toBe('GPT-5');
    expect(modelOptionLabel(harnessModel('opus', { name: 'Opus' }))).toBe('Opus');
    expect(modelOptionLabel(harnessModel('raw-id', { pricing: 'free' }))).toBe('raw-id (free)');
    expect(modelOptionLabel(harnessModel('d', { name: 'D', isDefault: true, pricing: 'free' }))).toBe('D (free) (default)');
    expect(modelOptionLabel(harnessModel('d', { name: 'D', isDefault: true }))).toBe('D (default)');
  });

  it('modelOptions keeps the model id as the option value', () => {
    const r = fixtureReport();
    r.models = [modelsEntry('opencode', 'ok', [harnessModel('opencode/big-pickle', { name: 'Big Pickle', pricing: 'free' })])];
    expect(modelOptions(r, 'opencode').map((m) => [m.id, modelOptionLabel(m)])).toEqual([['opencode/big-pickle', 'Big Pickle (free)']]);
  });

  it('effortOptions returns efforts for a known model and empties otherwise', () => {
    expect(effortOptions(report, 'claude', 'claude-opus-4')).toEqual({ efforts: ['low', 'high'], defaultEffort: 'high' });
    expect(effortOptions(report, 'claude', 'claude-sonnet-4')).toEqual({ efforts: [], defaultEffort: null });
    expect(effortOptions(report, 'claude', 'nope')).toEqual({ efforts: [], defaultEffort: null });
    expect(effortOptions(report, 'grok', 'grok-4')).toEqual({ efforts: [], defaultEffort: null });
  });
});

describe('defaultPickFor', () => {
  const report = fixtureReport();

  it('returns null when the provider has no models', () => {
    expect(defaultPickFor(report, 'grok')).toBeNull();
    expect(defaultPickFor(report, 'opencode')).toBeNull();
    expect(defaultPickFor(report, 'muse')).toBeNull();
  });

  it('uses the isDefault model with its effort when valid', () => {
    expect(defaultPickFor(report, 'agy')).toEqual({ provider: 'agy', model: 'gemini-3-pro-high', effort: 'high' });
  });

  it('uses the isDefault model with null effort when its defaultEffort is not among its efforts', () => {
    const r = fixtureReport();
    r.models = [modelsEntry('claude', 'ok', [harnessModel('m', { isDefault: true, efforts: ['low'], defaultEffort: 'high' })])];
    expect(defaultPickFor(r, 'claude')).toEqual({ provider: 'claude', model: 'm', effort: null });
  });

  it('falls back to the first model when none is flagged default', () => {
    expect(defaultPickFor(report, 'codex')).toEqual({ provider: 'codex', model: 'gpt-5-mini', effort: null });
    const r = fixtureReport();
    r.models = [modelsEntry('codex', 'ok', [harnessModel('first', { efforts: ['low'], defaultEffort: 'low' }), harnessModel('second')])];
    expect(defaultPickFor(r, 'codex')).toEqual({ provider: 'codex', model: 'first', effort: 'low' });
  });
});

describe('normalizePick', () => {
  const report = fixtureReport();

  it('keeps the pick unchanged when the provider has no models', () => {
    expect(normalizePick(report, pick('grok', 'grok-4', 'high'))).toEqual(pick('grok', 'grok-4', 'high'));
  });

  it('replaces a model the provider does not offer with the default model', () => {
    expect(normalizePick(report, pick('claude', 'gpt-9', 'high'))).toEqual(pick('claude', 'claude-sonnet-4', null));
    expect(normalizePick(report, pick('codex', 'gone', 'low'))).toEqual(pick('codex', 'gpt-5-mini', null));
  });

  it('keeps a null effort as null', () => {
    expect(normalizePick(report, pick('claude', 'claude-opus-4', null))).toEqual(pick('claude', 'claude-opus-4', null));
  });

  it('clears the effort when the model has no efforts', () => {
    expect(normalizePick(report, pick('claude', 'claude-sonnet-4', 'high'))).toEqual(pick('claude', 'claude-sonnet-4', null));
  });

  it('keeps an effort the model supports', () => {
    expect(normalizePick(report, pick('claude', 'claude-opus-4', 'low'))).toEqual(pick('claude', 'claude-opus-4', 'low'));
  });

  it('replaces an unsupported effort with the model default effort when valid', () => {
    expect(normalizePick(report, pick('claude', 'claude-opus-4', 'max'))).toEqual(pick('claude', 'claude-opus-4', 'high'));
  });

  it('clears an unsupported effort when the model default is not valid', () => {
    const r = fixtureReport();
    r.models = [modelsEntry('codex', 'ok', [harnessModel('m', { efforts: ['low'], defaultEffort: null })])];
    expect(normalizePick(r, pick('codex', 'm', 'high'))).toEqual(pick('codex', 'm', null));
  });

  it('handles agy-style models whose only effort equals the id suffix', () => {
    expect(normalizePick(report, pick('agy', 'gemini-3-pro-high', 'high'))).toEqual(pick('agy', 'gemini-3-pro-high', 'high'));
    expect(normalizePick(report, pick('agy', 'gemini-3-pro-high', 'low'))).toEqual(pick('agy', 'gemini-3-pro-high', 'high'));
    expect(normalizePick(report, pick('agy', 'gemini-3-flash-low', 'low'))).toEqual(pick('agy', 'gemini-3-flash-low', 'low'));
    expect(normalizePick(report, pick('agy', 'gemini-3-flash-low', 'high'))).toEqual(pick('agy', 'gemini-3-flash-low', null));
    expect(normalizePick(report, pick('agy', 'gemini-retired', 'high'))).toEqual(pick('agy', 'gemini-3-pro-high', 'high'));
  });
});

describe('validateRoutingDraft', () => {
  it('accepts a valid config and a config with zero tiers', () => {
    expect(validateRoutingDraft(config())).toEqual([]);
    expect(
      validateRoutingDraft(
        config(
          [
            tier('advisory', [pick('claude', 'claude-opus-4', 'high'), pick('claude', 'claude-opus-4', null)], 'Planning'),
            tier('simple_1-b', [pick('codex', 'gpt-5-mini')]),
          ],
          'Do not exhaust Claude.',
        ),
      ),
    ).toEqual([]);
  });

  it('rejects more tiers than maxTiers', () => {
    const tiers = Array.from({ length: MODEL_ROUTING_LIMITS.maxTiers + 1 }, (_, i) => tier(`t${i}`));
    expect(validateRoutingDraft(config(tiers))).toEqual([
      `There are ${MODEL_ROUTING_LIMITS.maxTiers + 1} tiers; the limit is ${MODEL_ROUTING_LIMITS.maxTiers}.`,
    ]);
  });

  it('rejects an empty name after trimming', () => {
    expect(validateRoutingDraft(config([tier('   ')]))).toEqual(['Tier 1: name is required.']);
  });

  it('rejects a name over maxTierNameLength', () => {
    const name = 'a'.repeat(MODEL_ROUTING_LIMITS.maxTierNameLength + 1);
    expect(validateRoutingDraft(config([tier(name)]))).toEqual([
      `Tier 1: name must be at most ${MODEL_ROUTING_LIMITS.maxTierNameLength} characters.`,
    ]);
  });

  it('rejects a name that does not match ROUTING_TIER_NAME_PATTERN', () => {
    expect(validateRoutingDraft(config([tier('Complex')]))).toEqual([
      'Tier 1: name must be lowercase letters, digits, "-" or "_".',
    ]);
    expect(validateRoutingDraft(config([tier('a b')]))).toEqual([
      'Tier 1: name must be lowercase letters, digits, "-" or "_".',
    ]);
  });

  it('rejects duplicate names after trimming, naming the first tier', () => {
    expect(validateRoutingDraft(config([tier('simple'), tier(' simple ')]))).toEqual([
      'Tier 2: name "simple" is already used by Tier 1.',
    ]);
  });

  it('rejects a description over maxTierDescriptionLength', () => {
    const description = 'd'.repeat(MODEL_ROUTING_LIMITS.maxTierDescriptionLength + 1);
    expect(validateRoutingDraft(config([tier('a', [], description)]))).toEqual([
      `Tier 1: description must be at most ${MODEL_ROUTING_LIMITS.maxTierDescriptionLength} characters.`,
    ]);
  });

  it('accepts guidance at the limit and rejects guidance over it, naming the tier', () => {
    const atLimit = 'g'.repeat(MODEL_ROUTING_LIMITS.maxTierGuidanceLength);
    expect(validateRoutingDraft(config([tier('a', [], '', atLimit)]))).toEqual([]);
    expect(validateRoutingDraft(config([tier('a'), tier('b', [], '', atLimit + 'g')]))).toEqual([
      `Tier 2: guidance must be at most ${MODEL_ROUTING_LIMITS.maxTierGuidanceLength} characters.`,
    ]);
  });

  it('rejects more picks than maxPicksPerTier', () => {
    const picks = Array.from({ length: MODEL_ROUTING_LIMITS.maxPicksPerTier + 1 }, (_, i) => pick('claude', `m${i}`));
    expect(validateRoutingDraft(config([tier('a', picks)]))).toEqual([
      `Tier 1: at most ${MODEL_ROUTING_LIMITS.maxPicksPerTier} picks are allowed.`,
    ]);
  });

  it('rejects a pick with an empty model', () => {
    expect(validateRoutingDraft(config([tier('a', [pick('claude', '  ')])]))).toEqual(['Tier 1, pick 1: model is required.']);
  });

  it('rejects a duplicate pick (same provider, model and effort) within a tier', () => {
    expect(validateRoutingDraft(config([tier('a', [pick('claude', 'm', 'low'), pick('claude', 'm', 'low')])]))).toEqual([
      'Tier 1, pick 2: duplicates an earlier pick in this tier.',
    ]);
  });

  it('allows the same model with different efforts, and the same pick in different tiers', () => {
    expect(
      validateRoutingDraft(
        config([tier('a', [pick('claude', 'm', 'low'), pick('claude', 'm', 'high')]), tier('b', [pick('claude', 'm', 'low')])]),
      ),
    ).toEqual([]);
  });

  it('rejects steering over maxSteeringLength', () => {
    const steering = 's'.repeat(MODEL_ROUTING_LIMITS.maxSteeringLength + 1);
    expect(validateRoutingDraft(config([], steering))).toEqual([
      `Steering must be at most ${MODEL_ROUTING_LIMITS.maxSteeringLength} characters.`,
    ]);
  });
});

describe('parseModelRoutingSnapshot', () => {
  const validSnapshot = () => ({
    schema: 1,
    config: { version: 1, tiers: [], steering: '' },
    report: {
      providers: [],
      routing: [],
      models: [],
      tiers: [],
      routingConfig: { status: 'missing', path: '/p', errors: [] },
      steering: '',
    },
    cached: false,
  });

  it('accepts a structurally valid snapshot and returns an equal copy', () => {
    const data = validSnapshot();
    expect(parseModelRoutingSnapshot(data)).toEqual(data);
  });

  const annotatedPick = (extra: Record<string, unknown> = {}) => ({
    provider: 'claude', model: 'opus', effort: null, modelName: null, availability: 'available',
    leftPercent: 80, resetsAt: null, scopedLimits: [], problem: null, ...extra,
  });
  const richSnapshot = () => {
    const base = validSnapshot();
    return {
      ...base,
      config: {
        version: 1,
        steering: '',
        tiers: [
          { name: 'a', description: '', picks: [], guidance: 'any free model' },
          { name: 'b', description: '', picks: [] },
          { name: 'c', description: '', picks: [], guidance: 7 },
        ],
      },
      report: {
        ...base.report,
        tiers: [
          { name: 'a', description: '', guidance: 'keep', picks: [annotatedPick({ checked: true }), annotatedPick({ checked: false }), annotatedPick(), annotatedPick({ checked: 'true' }), annotatedPick({ checked: 1 })] },
          { name: 'b', description: '', picks: [] },
        ],
        models: [
          {
            provider: 'opencode', status: 'ok', source: 'live', observedAt: '', message: null, modelFlag: '--model <id>', effortFlag: null,
            models: [
              { ...harnessModel('free-one'), pricing: 'free' },
              { ...harnessModel('inc'), pricing: 'included' },
              { ...harnessModel('paid'), pricing: 'paid' },
              { ...harnessModel('none') },
              { ...harnessModel('weird'), pricing: 'cheap' },
              { ...harnessModel('nul'), pricing: null },
            ],
          },
        ],
      },
    };
  };

  it('defaults tier guidance to "" when missing or not a string, in config and report', () => {
    const parsed = parseModelRoutingSnapshot(richSnapshot());
    expect(parsed?.config.tiers.map((t) => t.guidance)).toEqual(['any free model', '', '']);
    expect(parsed?.report.tiers.map((t) => t.guidance)).toEqual(['keep', '']);
  });

  it('sets annotated pick checked to true only when it is strictly true', () => {
    const parsed = parseModelRoutingSnapshot(richSnapshot());
    expect(parsed?.report.tiers[0].picks.map((p) => p.checked)).toEqual([true, false, false, false, false]);
  });

  it('keeps model pricing only when it is free, included or paid', () => {
    const parsed = parseModelRoutingSnapshot(richSnapshot());
    const models = parsed?.report.models[0].models ?? [];
    expect(models.map((m) => m.pricing)).toEqual(['free', 'included', 'paid', undefined, undefined, undefined]);
    expect(models.slice(3).every((m) => !('pricing' in m))).toBe(true);
  });

  it('does not mutate the input while normalising', () => {
    const data = deepFreeze(richSnapshot());
    expect(() => parseModelRoutingSnapshot(data)).not.toThrow();
    expect('guidance' in data.config.tiers[1]).toBe(false);
  });

  it('rejects malformed tiers, picks and model entries', () => {
    const base = validSnapshot();
    expect(parseModelRoutingSnapshot({ ...base, config: { ...base.config, tiers: ['x'] } })).toBeNull();
    expect(parseModelRoutingSnapshot({ ...base, config: { ...base.config, tiers: [{ name: 'a', description: '' }] } })).toBeNull();
    expect(parseModelRoutingSnapshot({ ...base, report: { ...base.report, tiers: [{ name: 'a', description: '', picks: [null] }] } })).toBeNull();
    expect(parseModelRoutingSnapshot({ ...base, report: { ...base.report, models: [{ provider: 'claude', models: 'x' }] } })).toBeNull();
  });

  it('rejects a wrong schema or config version', () => {
    expect(parseModelRoutingSnapshot({ ...validSnapshot(), schema: 2 })).toBeNull();
    expect(parseModelRoutingSnapshot({ ...validSnapshot(), config: { version: 2, tiers: [], steering: '' } })).toBeNull();
  });

  it('rejects missing or mistyped fields', () => {
    const base = validSnapshot();
    expect(parseModelRoutingSnapshot({ ...base, config: { version: 1, tiers: {}, steering: '' } })).toBeNull();
    expect(parseModelRoutingSnapshot({ ...base, config: { version: 1, tiers: [], steering: 3 } })).toBeNull();
    expect(parseModelRoutingSnapshot({ ...base, report: { ...base.report, models: 'x' } })).toBeNull();
    expect(parseModelRoutingSnapshot({ ...base, report: { ...base.report, routingConfig: null } })).toBeNull();
    expect(parseModelRoutingSnapshot({ ...base, report: { ...base.report, steering: undefined } })).toBeNull();
    expect(parseModelRoutingSnapshot({ ...base, cached: 'no' })).toBeNull();
  });

  it('rejects null, arrays, strings and other non-objects without throwing', () => {
    for (const value of [null, undefined, [], [validSnapshot()], 'snapshot', 1, true]) {
      expect(parseModelRoutingSnapshot(value)).toBeNull();
    }
  });
});

describe('parseSetModelRoutingResult', () => {
  it('accepts a saved and a rejected result', () => {
    expect(parseSetModelRoutingResult({ schema: 1, saved: true, errors: [] })).toEqual({ schema: 1, saved: true, errors: [], invalidFileBlocked: false });
    expect(parseSetModelRoutingResult({ schema: 1, saved: false, errors: ['Tier 1: name is required.'] })).toEqual({
      schema: 1,
      saved: false,
      errors: ['Tier 1: name is required.'],
      invalidFileBlocked: false,
    });
  });

  it('reads invalidFileBlocked as strictly boolean true', () => {
    expect(parseSetModelRoutingResult({ schema: 1, saved: false, errors: [], invalidFileBlocked: true })?.invalidFileBlocked).toBe(true);
    for (const value of [false, 'true', 1, null, undefined]) {
      expect(parseSetModelRoutingResult({ schema: 1, saved: false, errors: [], invalidFileBlocked: value })?.invalidFileBlocked).toBe(false);
    }
  });

  it('rejects a wrong schema, non-boolean saved, or non-string errors', () => {
    expect(parseSetModelRoutingResult({ schema: 2, saved: true, errors: [] })).toBeNull();
    expect(parseSetModelRoutingResult({ schema: 1, saved: 'yes', errors: [] })).toBeNull();
    expect(parseSetModelRoutingResult({ schema: 1, saved: false, errors: [1] })).toBeNull();
    expect(parseSetModelRoutingResult({ schema: 1, saved: false, errors: 'bad' })).toBeNull();
  });

  it('rejects null, arrays, strings and other non-objects without throwing', () => {
    for (const value of [null, undefined, [], ['x'], 'result', 0]) {
      expect(parseSetModelRoutingResult(value)).toBeNull();
    }
  });
});

describe('pickLabel', () => {
  it('formats provider and model, adding the effort only when set', () => {
    expect(pickLabel(pick('claude', 'claude-opus-4', 'high'))).toBe('claude / claude-opus-4 @ high');
    expect(pickLabel(pick('codex', 'gpt-5', null))).toBe('codex / gpt-5');
  });
});
