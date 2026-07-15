// Per-model token pricing used to estimate session cost in usage-collector.ts.
//
// ⚠️ These rates are ESTIMATES maintained by hand from public price sheets
// (USD per 1M tokens). They are not fetched from any API and can drift from
// the real billed rates — treat costUsd as an approximation. Models with no
// entry here (unknown/new/synthetic ids) yield costUsd === undefined rather
// than a guessed number.

export interface ModelPrice {
  /** USD per 1M uncached input tokens. */
  inPerM: number;
  /** USD per 1M output tokens. */
  outPerM: number;
  /** USD per 1M cache-read input tokens (~0.1x input on Anthropic). */
  cacheReadPerM: number;
  /** USD per 1M cache-write input tokens (~1.25x input on Anthropic; 0 on OpenAI). */
  cacheWritePerM: number;
}

/**
 * Keyed by model-id prefix — see priceFor() for the matching rule. Anthropic
 * ids sometimes carry date suffixes (claude-haiku-4-5-20251001), OpenAI codex
 * ids carry variant suffixes (gpt-5.6-luna); prefix matching absorbs both.
 */
export const PRICES: Record<string, ModelPrice> = {
  // Anthropic — cache read = 0.1x input, cache write (5m) = 1.25x input.
  'claude-fable-5':   { inPerM: 10,   outPerM: 50, cacheReadPerM: 1,    cacheWritePerM: 12.5 },
  'claude-opus-4-8':  { inPerM: 5,    outPerM: 25, cacheReadPerM: 0.5,  cacheWritePerM: 6.25 },
  'claude-opus-4-7':  { inPerM: 5,    outPerM: 25, cacheReadPerM: 0.5,  cacheWritePerM: 6.25 },
  'claude-opus-4-6':  { inPerM: 5,    outPerM: 25, cacheReadPerM: 0.5,  cacheWritePerM: 6.25 },
  'claude-opus-4-5':  { inPerM: 5,    outPerM: 25, cacheReadPerM: 0.5,  cacheWritePerM: 6.25 },
  'claude-sonnet-5':  { inPerM: 3,    outPerM: 15, cacheReadPerM: 0.3,  cacheWritePerM: 3.75 },
  'claude-sonnet-4-5': { inPerM: 3,   outPerM: 15, cacheReadPerM: 0.3,  cacheWritePerM: 3.75 },
  'claude-sonnet-4-6': { inPerM: 3,   outPerM: 15, cacheReadPerM: 0.3,  cacheWritePerM: 3.75 },
  'claude-haiku-4-5': { inPerM: 1,    outPerM: 5,  cacheReadPerM: 0.1,  cacheWritePerM: 1.25 },

  // OpenAI codex rollouts (model ids observed in ~/.codex/sessions rollout
  // files: gpt-5.4, gpt-5.4-mini, gpt-5.5, gpt-5.6-luna/sol/terra). Rates
  // estimated from the gpt-5 family price sheet; cached input = 0.1x input,
  // cache writes are free on OpenAI.
  'gpt-5.4-mini': { inPerM: 0.25, outPerM: 2,  cacheReadPerM: 0.025, cacheWritePerM: 0 },
  'gpt-5.4':      { inPerM: 1.25, outPerM: 10, cacheReadPerM: 0.125, cacheWritePerM: 0 },
  'gpt-5.5':      { inPerM: 1.25, outPerM: 10, cacheReadPerM: 0.125, cacheWritePerM: 0 },
  'gpt-5.6':      { inPerM: 1.25, outPerM: 10, cacheReadPerM: 0.125, cacheWritePerM: 0 },
};

/**
 * Longest-prefix match so date/variant suffixes resolve to their base entry
 * (claude-opus-4-8-20260115 → claude-opus-4-8; gpt-5.6-luna → gpt-5.6) while
 * more specific entries win over shorter ones (gpt-5.4-mini over gpt-5.4).
 * Returns undefined for unknown models — callers must then omit costUsd.
 */
export function priceFor(model: string): ModelPrice | undefined {
  let best: string | undefined;
  for (const key of Object.keys(PRICES)) {
    if (model === key || model.startsWith(key)) {
      if (best === undefined || key.length > best.length) best = key;
    }
  }
  return best === undefined ? undefined : PRICES[best];
}
