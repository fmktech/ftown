import { SessionUsage } from "@/types";

/** Compact token count, e.g. 1200 -> "1.2K", 3_400_000 -> "3.4M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Short one-line summary, e.g. "1.2M in · 45K out · $0.42" (cost omitted when unknown). */
export function formatUsage(u: SessionUsage): string {
  const parts = [`${formatTokens(u.inputTokens)} in`, `${formatTokens(u.outputTokens)} out`];
  if (u.costUsd !== undefined) parts.push(`$${u.costUsd.toFixed(2)}`);
  return parts.join(" · ");
}

/** Long-form breakdown for a tooltip/title: all token classes plus the model list. */
export function formatUsageDetail(u: SessionUsage): string {
  const lines = [
    `Input: ${formatTokens(u.inputTokens)}`,
    `Output: ${formatTokens(u.outputTokens)}`,
    `Cache read: ${formatTokens(u.cacheReadTokens)}`,
    `Cache write: ${formatTokens(u.cacheWriteTokens)}`,
    `Total: ${formatTokens(u.totalTokens)}`,
  ];
  if (u.costUsd !== undefined) lines.push(`Cost: $${u.costUsd.toFixed(2)}`);
  if (u.models.length > 0) lines.push(`Models: ${u.models.join(", ")}`);
  return lines.join("\n");
}
