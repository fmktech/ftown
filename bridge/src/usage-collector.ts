import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ModelUsage, Session, SessionUsage } from './types.js';

/**
 * Per-session token usage extraction from harness-native session files.
 *
 * The extractor is keyed by which NATIVE session id is present on the Session,
 * not by shellType: provider flavors (zai/kimi/deepseek/fireworks) run the
 * claude CLI under the hood and get a claudeSessionId persisted by the hook
 * pipeline, so any session with a claudeSessionId uses the claude extractor
 * regardless of shellType. Sessions with neither a claude nor a codex id
 * (cursor, grok, plain shell) have no structured usage source and yield null.
 *
 * TODO(opencode): add an opencode extractor once Session carries an
 * opencodeSessionId (no such field exists yet).
 *
 * Robustness contract: missing files, unparseable lines, and I/O errors never
 * throw — they degrade to null (or to a partial sum if the read-time cap fires
 * mid-file).
 */

export type UsageSessionRef = Pick<
  Session,
  'shellType' | 'claudeSessionId' | 'codexSessionId' | 'workingDir'
>;

export interface UsageCollectorOptions {
  /** Override for tests. Default: ~/.claude/projects */
  claudeProjectsDir?: string;
  /** Override for tests. Default: ~/.codex/sessions */
  codexSessionsDir?: string;
  /** Cap on wall-clock read time per collection. Default 15s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Claude Code project-directory slug: every non-alphanumeric character of the
 * working directory becomes '-'. Verified against real transcript dirs on this
 * machine — e.g. /Users/x/projects/ftown/.claude/worktrees/foo maps to
 * -Users-x-projects-ftown--claude-worktrees-foo ('.' → '-', '/' → '-').
 */
export function claudeProjectSlug(workingDir: string): string {
  return workingDir.replace(/[^a-zA-Z0-9]/g, '-');
}

export async function collectSessionUsage(
  session: UsageSessionRef,
  options: UsageCollectorOptions = {},
): Promise<SessionUsage | null> {
  try {
    if (session.claudeSessionId && session.workingDir) {
      return await collectClaudeUsage(session.claudeSessionId, session.workingDir, options);
    }
    if (session.codexSessionId) {
      return await collectCodexUsage(session.codexSessionId, options);
    }
    return null;
  } catch {
    return null;
  }
}

/** Stream a JSONL file line by line (files can be tens of MB — never buffer whole). */
async function* jsonlLines(filePath: string, deadline: number): AsyncGenerator<unknown> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (Date.now() > deadline) break;
      if (!line) continue;
      try {
        yield JSON.parse(line) as unknown;
      } catch {
        // Skip unparseable lines (truncated tail writes, etc.).
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

interface ClaudeUsageLine {
  type?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

async function collectClaudeUsage(
  claudeSessionId: string,
  workingDir: string,
  options: UsageCollectorOptions,
): Promise<SessionUsage | null> {
  const baseDir = options.claudeProjectsDir ?? join(homedir(), '.claude', 'projects');
  const filePath = join(baseDir, claudeProjectSlug(workingDir), `${claudeSessionId}.jsonl`);
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let counted = 0;
  // Keyed by model id; Map preserves first-appearance order.
  const byModel = new Map<string, ModelUsage>();
  // An assistant message spans MULTIPLE jsonl lines (one per content block),
  // each repeating the same message.id and identical usage — count each
  // message id exactly once or sums double/triple.
  const seenMessageIds = new Set<string>();

  for await (const raw of jsonlLines(filePath, deadline)) {
    const entry = raw as ClaudeUsageLine;
    if (entry?.type !== 'assistant') continue;
    const message = entry.message;
    const usage = message?.usage;
    if (!message || !usage) continue;
    const model = message.model ?? '';
    // '<synthetic>' rows are harness-injected placeholders with zero usage.
    if (!model || model === '<synthetic>') continue;
    const id = message.id;
    if (id) {
      if (seenMessageIds.has(id)) continue;
      seenMessageIds.add(id);
    }

    // Models can vary mid-session — attribute tokens per message's model.
    let acc = byModel.get(model);
    if (!acc) {
      acc = { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      byModel.set(model, acc);
    }
    acc.inputTokens += usage.input_tokens ?? 0;
    acc.outputTokens += usage.output_tokens ?? 0;
    acc.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    acc.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    counted += 1;
  }

  if (counted === 0) return null;

  const perModel = [...byModel.values()];
  const sum = (pick: (m: ModelUsage) => number): number =>
    perModel.reduce((acc, m) => acc + pick(m), 0);
  const inputTokens = sum((m) => m.inputTokens);
  const outputTokens = sum((m) => m.outputTokens);
  const cacheReadTokens = sum((m) => m.cacheReadTokens);
  const cacheWriteTokens = sum((m) => m.cacheWriteTokens);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    models: perModel.map((m) => m.model),
    perModel,
    harness: 'claude',
    collectedAt: new Date().toISOString(),
  };
}

interface CodexRolloutLine {
  type?: string;
  payload?: {
    type?: string;
    model?: string;
    info?: {
      total_token_usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
      };
    } | null;
  };
}

/** Resolve ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*-<id>.jsonl (date-partitioned). */
async function findCodexRollout(baseDir: string, codexSessionId: string): Promise<string | null> {
  const suffix = `-${codexSessionId}.jsonl`;
  const listDirs = async (dir: string): Promise<string[]> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      // Newest partitions first — sessions are usually recent.
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };
  for (const year of await listDirs(baseDir)) {
    for (const month of await listDirs(join(baseDir, year))) {
      for (const day of await listDirs(join(baseDir, year, month))) {
        const dir = join(baseDir, year, month, day);
        let files: string[];
        try {
          files = await readdir(dir);
        } catch {
          continue;
        }
        const hit = files.find((f) => f.startsWith('rollout-') && f.endsWith(suffix));
        if (hit) return join(dir, hit);
      }
    }
  }
  return null;
}

async function collectCodexUsage(
  codexSessionId: string,
  options: UsageCollectorOptions,
): Promise<SessionUsage | null> {
  const baseDir = options.codexSessionsDir ?? join(homedir(), '.codex', 'sessions');
  const filePath = await findCodexRollout(baseDir, codexSessionId);
  if (!filePath) return null;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const models: string[] = [];
  let lastTotals: { input: number; cached: number; output: number } | null = null;

  for await (const raw of jsonlLines(filePath, deadline)) {
    const entry = raw as CodexRolloutLine;
    const payload = entry?.payload;
    if (!payload) continue;
    if (entry.type === 'turn_context' && payload.model) {
      if (!models.includes(payload.model)) models.push(payload.model);
      continue;
    }
    // token_count events carry cumulative totals — the LAST one wins. Some
    // token_count events have info: null (rate-limit-only updates); skip them.
    if (payload.type === 'token_count') {
      const totals = payload.info?.total_token_usage;
      if (totals) {
        lastTotals = {
          input: totals.input_tokens ?? 0,
          cached: totals.cached_input_tokens ?? 0,
          output: totals.output_tokens ?? 0,
        };
      }
    }
  }

  if (!lastTotals) return null;

  // Codex counts cached tokens INSIDE input_tokens (input 11276 / cached 9088 /
  // total 11305 = 11276 + 29 in real rollouts) — split them so totalTokens
  // (sum of the four) matches codex's own total_tokens. output_tokens already
  // includes reasoning tokens. Codex reports no cache writes.
  const cacheReadTokens = Math.min(lastTotals.cached, lastTotals.input);
  const inputTokens = lastTotals.input - cacheReadTokens;
  const outputTokens = lastTotals.output;
  const cacheWriteTokens = 0;

  // Codex rollouts carry only cumulative totals — there is no per-model
  // attribution, so perModel is deliberately absent (models lists what ran).
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    models,
    harness: 'codex',
    collectedAt: new Date().toISOString(),
  };
}
