import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BRIDGE_HOME } from "./config";

/**
 * Seed harness-native transcript fixtures the bridge's usage-collector reads, so
 * a usage spec can assert token extraction WITHOUT running a real LLM. Files are
 * written under the bridge's scratch HOME (e2e/.bridge-home); the running bridge
 * has HOME overridden there, so collectSessionUsage() — which defaults to
 * $HOME/.claude/projects and $HOME/.codex/sessions — reads exactly these files.
 */

/**
 * Claude Code project-directory slug: every non-alphanumeric character of the
 * working directory becomes '-'. Verified identical to claudeProjectSlug in
 * bridge/src/usage-collector.ts (`workingDir.replace(/[^a-zA-Z0-9]/g, '-')`).
 * Exported so specs can compute the expected transcript path.
 */
export function claudeProjectSlug(workingDir: string): string {
  return workingDir.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Per-message usage counts for a seeded Claude assistant turn. */
export interface TranscriptMessage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Write a Claude Code transcript fixture at
 *   $bridgeHome/.claude/projects/<slug>/<claudeSessionId>.jsonl
 * where <slug> = claudeProjectSlug(workingDir). Each message becomes one
 * `assistant` JSONL line with a UNIQUE message.id and the given usage counts,
 * mapped to the exact fields collectClaudeUsage sums:
 *   input  → usage.input_tokens
 *   output → usage.output_tokens
 *   cacheRead  → usage.cache_read_input_tokens
 *   cacheWrite → usage.cache_creation_input_tokens
 * Unique ids matter: the collector dedups by message.id, so reused ids would be
 * counted once. Returns the absolute path written.
 */
export async function seedClaudeTranscript(
  bridgeHome: string,
  claudeSessionId: string,
  workingDir: string,
  messages: TranscriptMessage[],
): Promise<string> {
  const dir = join(bridgeHome, ".claude", "projects", claudeProjectSlug(workingDir));
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${claudeSessionId}.jsonl`);

  const lines = messages.map((m, i) =>
    JSON.stringify({
      type: "assistant",
      message: {
        id: `msg-${i}-${Math.random().toString(36).slice(2, 10)}`,
        model: m.model,
        usage: {
          input_tokens: m.input,
          output_tokens: m.output,
          cache_read_input_tokens: m.cacheRead,
          cache_creation_input_tokens: m.cacheWrite,
        },
      },
    }),
  );

  await writeFile(filePath, lines.length ? lines.join("\n") + "\n" : "", "utf8");
  return filePath;
}

/** Cumulative Codex token totals (codex counts cached INSIDE input). */
export interface CodexTotals {
  input: number;
  cached: number;
  output: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Write a Codex rollout fixture at
 *   $bridgeHome/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<codexSessionId>.jsonl
 * with a `turn_context` line carrying the model and a final `token_count` line
 * carrying cumulative total_token_usage — the shape collectCodexUsage reads
 * (bridge/src/usage-collector.ts). findCodexRollout matches any file starting
 * `rollout-` and ending `-<id>.jsonl` under the date partition. Returns the
 * absolute path written.
 */
export async function seedCodexRollout(
  bridgeHome: string,
  codexSessionId: string,
  opts: { model: string; totals: CodexTotals; date?: Date },
): Promise<string> {
  const date = opts.date ?? new Date();
  const year = String(date.getFullYear());
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());

  const dir = join(bridgeHome, ".codex", "sessions", year, month, day);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `rollout-${year}-${month}-${day}T00-00-00-${codexSessionId}.jsonl`);

  const lines = [
    JSON.stringify({ type: "turn_context", payload: { model: opts.model } }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: opts.totals.input,
            cached_input_tokens: opts.totals.cached,
            output_tokens: opts.totals.output,
          },
        },
      },
    }),
  ];

  await writeFile(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

/** Convenience: default bridge scratch HOME (e2e/.bridge-home). */
export { BRIDGE_HOME };
