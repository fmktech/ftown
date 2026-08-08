import { createReadStream } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import type { ModelUsage, Session, SessionUsage } from './types.js';

/**
 * Per-session token usage extraction from harness-native session files.
 *
 * The extractor is keyed by which NATIVE session id is present on the Session,
 * not by shellType: provider flavors (zai/kimi/deepseek/fireworks) run the
 * claude CLI under the hood and get a claudeSessionId persisted by the hook
 * pipeline, so any session with a claudeSessionId uses the claude extractor
 * regardless of shellType. Pi records a native id/file when its extension is
 * active and falls back to workingDir + createdAt discovery; kimi-code uses the
 * same workdir-based discovery model. Sessions with none of these (cursor,
 * grok, plain shell) have no structured usage source and yield null.
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
  'shellType' | 'claudeSessionId' | 'codexSessionId' | 'piSessionId' | 'piSessionFile' | 'workingDir'
> &
  // createdAt is consumed by workdir-based extractors to disambiguate sessions
  // sharing a workingDir; optional so id-based callers/tests need not set it.
  Partial<Pick<Session, 'createdAt'>>;

export interface UsageCollectorOptions {
  /** Override for tests. Default: ~/.claude/projects */
  claudeProjectsDir?: string;
  /** Override for tests. Default: ~/.codex/sessions */
  codexSessionsDir?: string;
  /** Override for tests. Default: ~/.pi/agent/sessions */
  piSessionsDir?: string;
  /**
   * Override for tests. Default: ~/.kimi-code. The kimi-code home dir holding
   * session_index.jsonl and sessions/<...>/session_<uuid>/.
   */
  kimiCodeDir?: string;
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
    if (session.shellType === 'pi' && session.workingDir) {
      return await collectPiUsage(
        session.workingDir,
        session.createdAt,
        options,
        session.piSessionFile,
      );
    }
    if (session.shellType === 'kimi-code' && session.workingDir) {
      return await collectKimiCodeUsage(session.workingDir, session.createdAt, options);
    }
    return null;
  } catch {
    return null;
  }
}

function piWorkspaceDirName(workingDir: string): string {
  const resolved = resolve(workingDir);
  return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

interface PiSessionHeader {
  type?: string;
  timestamp?: string;
  cwd?: string;
}

interface PiUsageLine {
  type?: string;
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  };
}

async function resolvePiSessionFile(
  baseDir: string,
  workingDir: string,
  sessionCreatedAt: string | undefined,
  deadline: number,
): Promise<string | null> {
  const dir = join(baseDir, piWorkspaceDirName(workingDir));
  let files: string[];
  try {
    files = (await readdir(dir)).filter((file) => file.endsWith('.jsonl'));
  } catch {
    return null;
  }

  const candidates: Array<{ path: string; createdAtMs: number }> = [];
  for (const file of files) {
    const path = join(dir, file);
    for await (const raw of jsonlLines(path, deadline)) {
      const header = raw as PiSessionHeader;
      if (header?.type === 'session' && header.cwd === resolve(workingDir)) {
        const createdAtMs = header.timestamp ? Date.parse(header.timestamp) : NaN;
        candidates.push({ path, createdAtMs: Number.isNaN(createdAtMs) ? 0 : createdAtMs });
      }
      break;
    }
  }
  if (candidates.length === 0) return null;

  const sessionMs = sessionCreatedAt ? Date.parse(sessionCreatedAt) : NaN;
  if (!Number.isNaN(sessionMs)) {
    const atOrAfter = candidates.filter((candidate) => candidate.createdAtMs >= sessionMs);
    if (atOrAfter.length > 0) {
      return atOrAfter.reduce((closest, candidate) =>
        candidate.createdAtMs < closest.createdAtMs ? candidate : closest).path;
    }
  }

  return candidates.reduce((newest, candidate) =>
    candidate.createdAtMs >= newest.createdAtMs ? candidate : newest).path;
}

async function collectPiUsage(
  workingDir: string,
  sessionCreatedAt: string | undefined,
  options: UsageCollectorOptions,
  nativeSessionFile?: string,
): Promise<SessionUsage | null> {
  const baseDir = options.piSessionsDir ?? join(homedir(), '.pi', 'agent', 'sessions');
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const candidatePath = nativeSessionFile
    ?? await resolvePiSessionFile(baseDir, workingDir, sessionCreatedAt, deadline);
  if (!candidatePath) return null;
  const filePath = await containedPiSessionFile(baseDir, candidatePath);
  if (!filePath) return null;

  let counted = 0;
  const byModel = new Map<string, ModelUsage>();
  for await (const raw of jsonlLines(filePath, deadline)) {
    const entry = raw as PiUsageLine;
    const message = entry?.type === 'message' ? entry.message : undefined;
    const usage = message?.role === 'assistant' ? message.usage : undefined;
    if (!message || !usage || typeof message.model !== 'string' || !message.model) continue;
    const model = typeof message.provider === 'string' && message.provider
      ? `${message.provider}/${message.model}`
      : message.model;

    let acc = byModel.get(model);
    if (!acc) {
      acc = { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      byModel.set(model, acc);
    }
    acc.inputTokens += safeTokenCount(usage.input);
    acc.outputTokens += safeTokenCount(usage.output);
    acc.cacheReadTokens += safeTokenCount(usage.cacheRead);
    acc.cacheWriteTokens += safeTokenCount(usage.cacheWrite);
    counted += 1;
  }
  if (counted === 0) return null;

  const perModel = [...byModel.values()];
  const sum = (pick: (model: ModelUsage) => number): number =>
    perModel.reduce((total, model) => total + pick(model), 0);
  const inputTokens = sum((model) => model.inputTokens);
  const outputTokens = sum((model) => model.outputTokens);
  const cacheReadTokens = sum((model) => model.cacheReadTokens);
  const cacheWriteTokens = sum((model) => model.cacheWriteTokens);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    models: perModel.map((model) => model.model),
    perModel,
    harness: 'pi',
    collectedAt: new Date().toISOString(),
  };
}

function safeTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

async function containedPiSessionFile(baseDir: string, filePath: string): Promise<string | null> {
  try {
    const [base, file, info] = await Promise.all([
      realpath(baseDir),
      realpath(filePath),
      stat(filePath),
    ]);
    if (!info.isFile() || !file.startsWith(`${base}${sep}`)) return null;
    return file;
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

interface KimiIndexLine {
  sessionId?: string;
  sessionDir?: string;
  workDir?: string;
}

interface KimiUsageRecord {
  type?: string;
  model?: string;
  usage?: {
    inputOther?: number;
    output?: number;
    inputCacheRead?: number;
    inputCacheCreation?: number;
  };
}

/**
 * Resolve the kimi-code session dir that this ftown session spawned.
 *
 * session_index.jsonl is an append log mapping workDir → sessionDir; multiple
 * lines can share a workDir (successive runs in the same directory). Among the
 * candidates matching this session's workingDir we pick by OWN creation time:
 * each candidate's session dir has a state.json whose createdAt is when kimi
 * started. The ftown session spawned kimi, so the true match is the newest
 * candidate created at-or-after the ftown session — falling back to the newest
 * overall when clock skew / a missing state.json leaves none at-or-after.
 */
async function resolveKimiSessionDir(
  baseDir: string,
  indexPath: string,
  workingDir: string,
  sessionCreatedAt: string | undefined,
  deadline: number,
): Promise<string | null> {
  // Dedupe: the same sessionDir can appear on multiple index lines.
  const dirs = new Set<string>();
  for await (const raw of jsonlLines(indexPath, deadline)) {
    const line = raw as KimiIndexLine;
    if (line?.workDir === workingDir && typeof line.sessionDir === 'string') {
      dirs.add(line.sessionDir);
    }
  }
  if (dirs.size === 0) return null;

  // Read each candidate's own creation time from its state.json.
  const candidates: Array<{ dir: string; createdAtMs: number }> = [];
  for (const dir of dirs) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as {
        createdAt?: string;
      };
      const createdAtMs = parsed?.createdAt ? Date.parse(parsed.createdAt) : NaN;
      candidates.push({ dir, createdAtMs: Number.isNaN(createdAtMs) ? 0 : createdAtMs });
    } catch {
      // Missing / unparseable state.json — still a candidate, just undatable.
      candidates.push({ dir, createdAtMs: 0 });
    }
  }

  const sessionMs = sessionCreatedAt ? Date.parse(sessionCreatedAt) : NaN;
  const newest = (list: Array<{ dir: string; createdAtMs: number }>) =>
    list.reduce((best, c) => (c.createdAtMs >= best.createdAtMs ? c : best));

  if (!Number.isNaN(sessionMs)) {
    const atOrAfter = candidates.filter((c) => c.createdAtMs >= sessionMs);
    if (atOrAfter.length > 0) return newest(atOrAfter).dir;
  }
  return newest(candidates).dir;
}

async function collectKimiCodeUsage(
  workingDir: string,
  sessionCreatedAt: string | undefined,
  options: UsageCollectorOptions,
): Promise<SessionUsage | null> {
  const baseDir = options.kimiCodeDir ?? join(homedir(), '.kimi-code');
  const indexPath = join(baseDir, 'session_index.jsonl');
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const sessionDir = await resolveKimiSessionDir(
    baseDir,
    indexPath,
    workingDir,
    sessionCreatedAt,
    deadline,
  );
  if (!sessionDir) return null;

  // Sum usage.record events across every agent's wire.jsonl (main + sub-agents).
  const agentsDir = join(sessionDir, 'agents');
  let agentNames: string[];
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    // Sort for deterministic per-model first-appearance order across agents.
    agentNames = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return null;
  }

  let counted = 0;
  // Keyed by model id; Map preserves first-appearance order across agents.
  const byModel = new Map<string, ModelUsage>();

  for (const agent of agentNames) {
    const wirePath = join(agentsDir, agent, 'wire.jsonl');
    for await (const raw of jsonlLines(wirePath, deadline)) {
      const entry = raw as KimiUsageRecord;
      if (entry?.type !== 'usage.record') continue;
      const usage = entry.usage;
      if (!usage) continue;
      const model = entry.model ?? '';
      if (!model) continue;

      let acc = byModel.get(model);
      if (!acc) {
        acc = { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        byModel.set(model, acc);
      }
      // Per-turn incremental records — SUM across all of them.
      acc.inputTokens += usage.inputOther ?? 0;
      acc.outputTokens += usage.output ?? 0;
      acc.cacheReadTokens += usage.inputCacheRead ?? 0;
      acc.cacheWriteTokens += usage.inputCacheCreation ?? 0;
      counted += 1;
    }
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
    harness: 'kimi-code',
    collectedAt: new Date().toISOString(),
  };
}
