import { SessionUsage } from "@/types";

/** Compact token count, e.g. 1200 -> "1.2K", 3_400_000 -> "3.4M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Strip common vendor-style prefixes from a model id for brevity, e.g. "claude-opus-4" -> "opus-4". */
function shortModelName(model: string): string {
  return model.replace(/^(claude-|gpt-|gemini-|grok-)/, "");
}

/** Short one-line summary, e.g. "1.2M in · 45K out · opus-4" (model suffix omitted unless exactly one model). */
export function formatUsage(u: SessionUsage): string {
  const parts = [`${formatTokens(u.inputTokens)} in`, `${formatTokens(u.outputTokens)} out`];
  if (u.models.length === 1) parts.push(shortModelName(u.models[0]));
  return parts.join(" · ");
}

/** Long-form breakdown for a tooltip/title: all token classes plus a per-model breakdown (or model list). */
export function formatUsageDetail(u: SessionUsage): string {
  const lines = [
    `Input: ${formatTokens(u.inputTokens)}`,
    `Output: ${formatTokens(u.outputTokens)}`,
    `Cache read: ${formatTokens(u.cacheReadTokens)}`,
    `Cache write: ${formatTokens(u.cacheWriteTokens)}`,
    `Total: ${formatTokens(u.totalTokens)}`,
  ];
  if (u.perModel && u.perModel.length > 0) {
    for (const m of u.perModel) {
      lines.push(
        `${m.model}: ${formatTokens(m.inputTokens)} in · ${formatTokens(m.outputTokens)} out · ${formatTokens(m.cacheReadTokens)} cacheR · ${formatTokens(m.cacheWriteTokens)} cacheW`
      );
    }
  } else if (u.models.length > 0) {
    lines.push(`Models: ${u.models.join(", ")}`);
  }
  return lines.join("\n");
}
