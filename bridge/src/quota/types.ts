/**
 * Frozen contract for the subscription-quota tool (`ftown-quota`).
 *
 * "Quota" here means SUBSCRIPTION PLAN limits (the short ~5-hour window and
 * the weekly window), not per-session token counts (see usage-collector.ts).
 *
 * This file is types only. Do not add logic and do not edit it from a task.
 */

export type QuotaProviderId = 'claude' | 'codex' | 'grok' | 'muse' | 'agy' | 'opencode';

export const QUOTA_PROVIDER_IDS: readonly QuotaProviderId[] = ['claude', 'codex', 'grok', 'muse', 'agy', 'opencode'];

/**
 * `five_hour` is the provider's short rolling block (its real length is in
 * `windowMinutes` when the provider states it). `weekly` is the 7-day block.
 */
export type QuotaWindowKind = 'five_hour' | 'weekly';

export interface QuotaWindow {
  kind: QuotaWindowKind;
  /**
   * Percent of the window already used, 0-100 scale (may exceed 100).
   * null when the provider reports the window but no number for it.
   */
  usedPercent: number | null;
  /** ISO-8601 UTC instant the window resets, or null when unknown. */
  resetsAt: string | null;
  /** Window length in minutes as stated by the provider, or null. */
  windowMinutes: number | null;
  /** Short human note for this window (e.g. "no active window"), or null. */
  note: string | null;
}

/**
 * ok          - at least one window with data.
 * no_data     - provider reachable but it reported no allowance right now.
 * auth        - credentials missing or expired; `message` says how to fix.
 * unavailable - the provider has no usable source on this machine right now.
 * error       - unexpected failure; `message` carries a short reason.
 */
export type QuotaStatus = 'ok' | 'no_data' | 'auth' | 'unavailable' | 'error';

export interface ProviderQuota {
  provider: QuotaProviderId;
  status: QuotaStatus;
  /** Plan / tier name as reported by the provider, or null. */
  plan: string | null;
  /**
   * Only windows the provider actually reported. A kind missing from this
   * array means the provider did not report that window (for example the
   * plan has no 5-hour window). At most one entry per kind.
   */
  windows: QuotaWindow[];
  /** live = asked the provider just now; cached = read from a local file. */
  source: 'live' | 'cached';
  /** ISO-8601 UTC instant the numbers were observed by the provider/file. */
  observedAt: string;
  /** Short single-line explanation for any non-ok status, else null. */
  message: string | null;
  /**
   * Extra limits that apply to only part of the plan (for example a weekly
   * limit for one model family). Omitted or empty when the provider reports none.
   */
  scopedLimits?: ScopedLimit[];
}

/** A limit that applies to a subset of the plan, e.g. one model family. */
export interface ScopedLimit {
  /** What the limit applies to, as the provider names it (e.g. "Fable"). */
  scope: string;
  kind: QuotaWindowKind;
  /** Percent used, 0-100 scale, or null when not reported. */
  usedPercent: number | null;
  /** ISO-8601 UTC reset instant, or null. */
  resetsAt: string | null;
}

export interface QuotaFetchOptions {
  /** Hard cap for the whole fetch of one provider, in milliseconds. */
  timeoutMs: number;
  /** Clock, injectable for tests. */
  now: () => Date;
  /** Home directory to resolve provider state under (os.homedir() in prod). */
  homeDir: string;
}

/**
 * Every provider module exports one of these. It MUST NOT throw or reject:
 * any failure becomes a ProviderQuota with a non-ok status. It MUST NOT
 * print anything, and MUST NOT include secrets in `message`.
 */
export type QuotaFetcher = (options: QuotaFetchOptions) => Promise<ProviderQuota>;

/** Signature of the table renderer in format.ts. Returns text without a trailing newline. */
export type QuotaTableFormatter = (rows: readonly ProviderQuota[], now: Date) => string;

// ---------------------------------------------------------------------------
// Routing advice: derived data that lets an agent choose which provider to
// send work to. Computed purely from ProviderQuota rows (see routing.ts).
// ---------------------------------------------------------------------------

/**
 * available - enough quota left for normal work.
 * low       - usable, but close to its limit or burning faster than the window allows.
 * exhausted - effectively no quota left until the window resets.
 * unknown   - no usable numbers (provider status not ok, or no numeric window).
 */
export type QuotaAvailability = 'available' | 'low' | 'exhausted' | 'unknown';

export interface ProviderRouting {
  provider: QuotaProviderId;
  availability: QuotaAvailability;
  /**
   * Percent LEFT (0-100) in the binding window: the window with the least
   * left among those that have a number. null when unknown.
   */
  leftPercent: number | null;
  /** Which window is the binding one, or null when unknown. */
  bindingWindow: QuotaWindowKind | null;
  /** When the binding window resets (ISO-8601 UTC), or null. */
  resetsAt: string | null;
  /** Whole minutes until the binding window resets (>= 0), or null. */
  resetsInMinutes: number | null;
  /**
   * Quota left relative to time left in the binding window:
   * (leftPercent / 100) / (minutes until reset / windowMinutes).
   * 1 = exactly on pace, > 1 = spare capacity, < 1 = will run out before the
   * reset at an even pace. null when the window length or reset is unknown.
   */
  runway: number | null;
  /** One short sentence an agent can read to understand the verdict. */
  reason: string;
}

/** The `--json` output of ftown-quota. */
export interface QuotaReport {
  /** ISO-8601 UTC instant the report was produced. */
  generatedAt: string;
  /** Raw per-provider readings, in canonical provider order. */
  providers: ProviderQuota[];
  /** Routing advice, best provider to use FIRST. Same providers as above. */
  routing: ProviderRouting[];
  /** Models each provider offers, in canonical provider order. */
  models: ProviderModels[];
  /** State of the user's model-routing file on this machine. */
  routingConfig: RoutingConfigState;
  /** The user's tiers, each pick annotated with live availability. Empty unless routingConfig.status is "ok". */
  tiers: AnnotatedTier[];
  /** The user's free-text guidance for the router agent, passed through verbatim ("" when none). */
  steering: string;
}

/** Signature of the advisor in routing.ts. Returns advice sorted best-first. */
export type QuotaRoutingAdvisor = (rows: readonly ProviderQuota[], now: Date) => ProviderRouting[];

// ---------------------------------------------------------------------------
// Model lists: which models each harness offers to the logged-in account.
// ---------------------------------------------------------------------------

/**
 * What a model costs the logged-in account. free = zero-priced on a
 * pay-per-use provider; included = covered by a subscription plan the user
 * holds; paid = billed per use.
 */
export type ModelPricing = 'free' | 'included' | 'paid';

export interface HarnessModel {
  /** Exact value to pass to the harness's model flag. */
  id: string;
  /** Human display name, or null. */
  name: string | null;
  /** True for the model a new session uses when no model flag is given. */
  isDefault: boolean;
  /** Provider's own one-line description, or null. */
  description: string | null;
  /** Largest context window in tokens the provider states, or null. */
  contextTokens: number | null;
  /** Reasoning-effort levels the model supports, in the provider's order. Empty when none/unknown. */
  efforts: string[];
  /** Effort used when none is given, or null when unknown. */
  defaultEffort: string | null;
  /** Cost class when the harness states prices; omitted when unknown or not applicable. */
  pricing?: ModelPricing;
}

export interface ProviderModels {
  provider: QuotaProviderId;
  /** ok = list read; unavailable = no source on this machine; error = unexpected failure. */
  status: 'ok' | 'unavailable' | 'error';
  /** Models a user can select (hidden/internal ones excluded). Empty unless status is ok. */
  models: HarnessModel[];
  /** live = asked the harness just now; cached = read from a file the harness maintains. */
  source: 'live' | 'cached';
  /** ISO-8601 UTC instant the list was produced or last refreshed by the harness. */
  observedAt: string;
  /** Short single-line explanation for any non-ok status, else null. */
  message: string | null;
  /** How to select a model when launching the harness, e.g. "--model <id>". */
  modelFlag: string;
  /** How to select a reasoning effort when launching, e.g. "--effort <level>", or null. */
  effortFlag: string | null;
}

/**
 * Every models module exports one of these. Same rules as QuotaFetcher:
 * never throw or reject, never print, no secrets in `message`, never start
 * a model turn.
 */
export type ModelsFetcher = (options: QuotaFetchOptions) => Promise<ProviderModels>;

// ---------------------------------------------------------------------------
// Model routing: the user's own tiers. For each tier the user picks, in order
// of preference, concrete (harness CLI + model + effort) entries on a
// per-bridge screen in the dashboard, plus free-text steering. The tool never
// ranks models itself and never chooses: it joins the picks with live quota so
// that a ROUTER AGENT can choose the CLI, model and effort for a given task.
// Stored on the bridge machine; one file per machine.
// ---------------------------------------------------------------------------

/** Location of the routing file, relative to the home directory. */
export const MODEL_ROUTING_RELATIVE_PATH = '.ftown/model-routing.json';

/** Limits enforced when validating a routing config. */
export const MODEL_ROUTING_LIMITS = {
  maxTiers: 12,
  maxPicksPerTier: 12,
  maxTierNameLength: 40,
  maxTierDescriptionLength: 200,
  maxTierGuidanceLength: 1000,
  maxSteeringLength: 4000,
} as const;

/** Tier names are lowercase slugs so a router agent can refer to them unambiguously. */
export const ROUTING_TIER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export interface RoutingPick {
  /** Harness CLI. */
  provider: QuotaProviderId;
  /** Model id exactly as that harness's model list gives it. */
  model: string;
  /** Reasoning effort to request, or null to use the harness default. */
  effort: string | null;
}

export interface RoutingTier {
  /** Unique within the config; matches ROUTING_TIER_NAME_PATTERN. */
  name: string;
  /** What kind of work belongs in this tier, in the user's words ("" when none). */
  description: string;
  /** Preferred entries, most preferred first. May be empty. */
  picks: RoutingPick[];
  /**
   * Free-text instruction for this tier, interpreted by the router agent and
   * never by the tool, e.g. "otherwise any free opencode model" ("" when none).
   */
  guidance: string;
}

export interface ModelRoutingConfig {
  version: 1;
  /** In the user's order. */
  tiers: RoutingTier[];
  /** Free-text guidance for the router agent, e.g. "don't fully exhaust Claude". */
  steering: string;
}

/** The tiers offered when no routing file exists yet. Picks start empty: the user fills them in. */
export const DEFAULT_ROUTING_TIERS: readonly Readonly<Pick<RoutingTier, 'name' | 'description'>>[] = [
  { name: 'advisory', description: 'Planning, architecture, review and second opinions' },
  { name: 'complex', description: 'Hard development and debugging' },
  { name: 'moderate', description: 'Ordinary development tasks' },
  { name: 'simple', description: 'Research, lookups and mechanical edits' },
];

export interface RoutingConfigState {
  /** ok = loaded; missing = no file yet; invalid = the file has errors. */
  status: 'ok' | 'missing' | 'invalid';
  /** Absolute path of the routing file. */
  path: string;
  /** Validation errors when invalid, else []. */
  errors: string[];
}

/** Result of validating a routing config document. Never a partially valid config. */
export type RoutingConfigParseResult =
  | { ok: true; config: ModelRoutingConfig }
  | { ok: false; errors: string[] };

export interface AnnotatedPick extends RoutingPick {
  /** Display name of the model from the live list, or null. */
  modelName: string | null;
  /** The provider's current availability (from the routing advice). */
  availability: QuotaAvailability;
  /** Percent left in the provider's binding window, or null. */
  leftPercent: number | null;
  /** When that binding window resets (ISO-8601 UTC), or null. */
  resetsAt: string | null;
  /** The provider's partial limits (e.g. per model family), for the router to weigh. */
  scopedLimits: ScopedLimit[];
  /**
   * Non-null when the pick cannot be used as configured: the model is no
   * longer offered by the harness, or the effort is not one it supports.
   * Null when the pick is valid or could not be checked (no model list).
   */
  problem: string | null;
  /** false when the harness's model list could not be read, so the pick was not checked. */
  checked: boolean;
}

export interface AnnotatedTier {
  name: string;
  description: string;
  /** In the user's order of preference. */
  picks: AnnotatedPick[];
  /** The tier's free-text guidance, verbatim. */
  guidance: string;
}

// ---------------------------------------------------------------------------
// Dashboard <-> bridge protocol for model routing (bridge command RPC).
// The dashboard imports these types from this file directly; do not copy them.
// ---------------------------------------------------------------------------

export const MODEL_ROUTING_SCHEMA = 1;

/** A `refresh: true` request arriving sooner than this after the last collection is served from cache. */
export const MODEL_ROUTING_MIN_REFRESH_MS = 15_000;

/** Payload of the `get_model_routing` command. */
export interface GetModelRoutingPayload {
  /** true = bypass the bridge's cache and read quota and model lists again. */
  refresh?: boolean;
}

/** Result of `get_model_routing`. */
export interface ModelRoutingSnapshot {
  schema: 1;
  /** The stored config, or a starter config (default tiers, no picks, no steering) when none is stored or it is invalid. */
  config: ModelRoutingConfig;
  /** Full report: quota, routing advice, model lists, and the annotated tiers. */
  report: QuotaReport;
  /** true when the quota/model part of `report` came from the bridge's cache. */
  cached: boolean;
}

/** Payload of the `set_model_routing` command. */
export interface SetModelRoutingPayload {
  config: ModelRoutingConfig;
  /** Must be true to replace a routing file that exists but is invalid. */
  overwriteInvalid?: boolean;
}

/** Result of `set_model_routing`. */
export interface SetModelRoutingResult {
  schema: 1;
  /** false when validation failed; nothing was written. */
  saved: boolean;
  /** Validation errors, each a short sentence naming the offending field; [] when saved. */
  errors: string[];
  /** true when nothing was written because the existing file is invalid and overwriteInvalid was not set. */
  invalidFileBlocked?: boolean;
}
