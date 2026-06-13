/**
 * ftown-workflows engine.
 *
 * Brings Workflow-tool-style deterministic orchestration to REAL ftown sessions:
 * each `agent()` call spawns a real ftown session via the bridge loopback API, the
 * child writes its result to a file, the runner polls the filesystem for that file
 * (race-free — no inbox / Stop-hook contention), removes the session and returns it.
 *
 * The engine is fully dependency-injected (BridgeClient / ResultStore / Clock /
 * Logger) so it is unit-testable without a live bridge, real fs or real timers.
 */

// ---- Injected dependencies (so the engine is unit-testable without a live bridge) ----

/** Minimal session-control surface the engine needs. Real impl = HTTP loopback API. */
export interface BridgeClient {
  /** Create a session; returns its id. Mirrors POST /api/sessions. */
  createSession(opts: SpawnSpec): Promise<{ id: string }>;
  /** Remove (tombstone) a session. Mirrors DELETE /api/sessions/:id. Must not throw on 404. */
  removeSession(id: string): Promise<void>;
  /** True if the session PTY is alive. Mirrors GET /api/sessions/:id/running. */
  isRunning(id: string): Promise<boolean>;
}

/** Reads result files written by child sessions. Real impl = node:fs. */
export interface ResultStore {
  /** Absolute path where step `stepKey` of `runId` writes its result. */
  resultPath(runId: string, stepKey: string): string;
  /**
   * Returns the parsed RawResult if the file exists AND is valid JSON matching
   * RawResult; returns null if the file is absent OR not yet valid JSON (partial
   * write). MUST NOT throw for absent/partial files.
   */
  readResult(path: string): Promise<RawResult | null>;
}

/** Time abstraction so tests run instantly (fake clock). */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface Logger {
  /** Emitted for phase()/log() and lifecycle events. */
  event(ev: WorkflowEvent): void;
}

export type WorkflowEvent =
  | { kind: 'phase'; title: string }
  | { kind: 'log'; message: string }
  | { kind: 'agent-start'; label: string; phase?: string; sessionId: string }
  | { kind: 'agent-done'; label: string; phase?: string; ok: boolean; cached: boolean }
  | { kind: 'agent-error'; label: string; phase?: string; error: string };

// ---- Spawn + result wire types ----

export type WorkflowShell = 'claude' | 'cursor' | 'codex' | 'opencode' | 'shell';

/** What the engine asks BridgeClient to create. */
export interface SpawnSpec {
  prompt: string; // full child prompt (task + result-file protocol)
  shellType: WorkflowShell;
  workingDir?: string;
  name?: string;
  model?: string;
  parentSessionId: string; // the orchestrator session id (RunOptions.selfSessionId)
}

/** Shape the child writes into its result file. */
export interface RawResult {
  ok: boolean;
  result?: unknown; // present when ok === true
  error?: string; // present when ok === false
}

// ---- Script-facing API ----

export interface AgentOptions {
  label?: string; // display + step key base; default `step-<n>`
  phase?: string; // progress grouping
  schema?: object; // JSON schema; when set, result must be JSON; agent() returns the parsed `result`
  shell?: WorkflowShell; // default RunOptions.defaultShell
  model?: string;
  workdir?: string; // default RunOptions.workdir
  name?: string; // session dashboard name; default = label
  timeoutMs?: number; // default RunOptions.defaultTimeoutMs
  pollIntervalMs?: number; // default 2000 (floored at 50)
  startupGraceMs?: number; // grace before a never-running child is deemed failed-to-start; default 30000
}

export interface Budget {
  /** Max total agent() spawns allowed this run (null = unbounded). */
  maxAgents: number | null;
  /** Count of agent() spawns started so far (cached results do NOT count). */
  spent(): number;
  /** maxAgents - spent(), or Infinity if maxAgents is null. */
  remaining(): number;
}

export interface WorkflowContext {
  /**
   * Spawn a real ftown session for `prompt`, block until its result file appears,
   * remove the session, and return the result.
   *  - without schema: returns the result as a string. A string `result` is returned
   *    as-is; a non-string `result` is returned as a JSON string (JSON.stringify).
   *  - with schema: returns the parsed RawResult.result (validated as JSON; on parse
   *    failure the agent is treated as failed).
   * Returns null if: the session exits without writing a valid result, the timeout
   * elapses, ok===false, or the budget is exhausted. NEVER rejects for these — only
   * programming errors (bad args) throw.
   */
  agent(prompt: string, opts?: AgentOptions): Promise<string | unknown | null>;

  /** Run thunks concurrently (BARRIER, respects maxConcurrent). A thunk that throws
   *  or whose agent errors resolves to null in the result array; the call never rejects. */
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;

  /** Run each item through all stages independently, NO barrier between stages.
   *  Stage callback signature: (prev, originalItem, index). A stage that throws drops
   *  that item to null and skips its remaining stages. */
  pipeline(
    items: unknown[],
    ...stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>>
  ): Promise<unknown[]>;

  phase(title: string): void;
  log(message: string): void;
  readonly args: unknown;
  readonly budget: Budget;
}

// ---- Runner entry ----

export interface RunOptions {
  runId: string; // unique per run (CLI uses crypto.randomUUID short form)
  selfSessionId: string; // orchestrator session id => children's parentSessionId
  args?: unknown;
  workdir?: string; // default workdir for spawned children
  defaultShell?: WorkflowShell; // default 'claude'
  defaultTimeoutMs?: number; // default 1_800_000 (30 min)
  maxConcurrent?: number; // default 4  (real sessions are heavy — keep low)
  maxAgents?: number | null; // default null
}

export interface RunnerDeps {
  bridge: BridgeClient;
  store: ResultStore;
  clock: Clock;
  logger: Logger;
}

/** A loaded workflow module: default export is the script body fn, or a `run` export. */
export type WorkflowModule = {
  default?: (ctx: WorkflowContext) => Promise<unknown> | unknown;
  run?: (ctx: WorkflowContext) => Promise<unknown> | unknown;
};

const DEFAULT_SHELL: WorkflowShell = 'claude';
const DEFAULT_TIMEOUT_MS = 1_800_000;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_POLL_INTERVAL_MS = 2000;
// A new session reports running:false for a short startup window; only after this grace
// (with the child never observed running) do we treat it as failed-to-start.
const DEFAULT_STARTUP_GRACE_MS = 30_000;

// ---- Pure helpers (exported + individually unit-tested) ----

/**
 * Build the full child prompt: the user's `task`, then a clearly delimited protocol
 * block instructing the child to write its final result as JSON to `resultFilePath`
 * and then stop. When `schema` is provided, the block embeds the schema and says
 * `result` must conform. The block always literally contains `resultFilePath`.
 */
export function buildAgentPrompt(task: string, resultFilePath: string, schema?: object): string {
  const lines: string[] = [
    task.trim(),
    '',
    '--- ftown-workflows RESULT PROTOCOL (read carefully) ---',
    'You are a worker session in a deterministic workflow. When you have finished the',
    'task above, you MUST write your FINAL result as a single JSON object to this file:',
    '',
    `  RESULT FILE: ${resultFilePath}`,
    '',
    'The JSON object must have this exact shape:',
    '  { "ok": true, "result": <your result> }   on success',
    '  { "ok": false, "error": "<why it failed>" } on failure',
    '',
  ];

  if (schema) {
    lines.push(
      'On success, `result` MUST be valid JSON conforming to this JSON schema:',
      '',
      JSON.stringify(schema, null, 2),
      '',
    );
  } else {
    lines.push(
      'On success, `result` may be a plain string or any JSON value. (Without a schema, a',
      'non-string `result` is returned to the calling script as a JSON string.)',
      '',
    );
  }

  lines.push(
    'Write the file atomically (write fully, then save). Do NOT print the result to the',
    'terminal instead of the file.',
    'The result FILE is the ONLY accepted output channel. Do NOT report via ftown-harness mail, the terminal, or any other channel.',
    'After the file is written, STOP — do no further work.',
    `Reminder: the result file path is ${resultFilePath}`,
    '--- end protocol ---',
  );

  return lines.join('\n');
}

/**
 * Parse raw file text into RawResult. Returns null if text is empty or not valid
 * JSON (partial write). Throws nothing. If JSON parses but lacks a boolean `ok`,
 * treat as null (not yet complete).
 */
export function parseResultFile(text: string): RawResult | null {
  if (!text || text.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.ok !== 'boolean') return null;
  return obj as unknown as RawResult;
}

// ---- Internal helpers ----

/** Async counting semaphore: caps concurrently-running spawn+poll cycles. */
class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = Number.isFinite(permits) ? Math.max(1, Math.floor(permits)) : 1;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the permit directly to the next waiter (keeps the cap exact).
      next();
    } else {
      this.permits += 1;
    }
  }
}

/** Make a label filesystem-safe for use as a result-file stem. */
function sanitizeStepKey(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'step';
}

/** Map a successful RawResult to the value agent() returns. */
function mapOk(raw: RawResult, hasSchema: boolean): unknown {
  const value = raw.result;
  if (hasSchema) return value ?? null;
  if (value === undefined || value === null) return null;
  // No schema: a string is returned as-is; a non-string structured value is
  // JSON-stringified (NOT lossily String()-coerced to "[object Object]").
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Build + run the context, execute the module, return its return value. */
export async function runWorkflow(
  deps: RunnerDeps,
  mod: WorkflowModule,
  opts: RunOptions,
): Promise<unknown> {
  const body = mod.default ?? mod.run;
  if (typeof body !== 'function') {
    throw new Error('workflow module has no default or `run` export');
  }

  const { bridge, store, clock, logger } = deps;
  const defaultShell = opts.defaultShell ?? DEFAULT_SHELL;
  // Resolve numerics defensively: `??` does NOT catch NaN, and a NaN cap would
  // deadlock the semaphore / make every timeout comparison false. Coerce non-finite
  // values to the documented defaults.
  const maxConcurrent = Number.isFinite(opts.maxConcurrent)
    ? Math.max(1, Math.floor(opts.maxConcurrent as number))
    : DEFAULT_MAX_CONCURRENT;
  const defaultTimeoutMs = Number.isFinite(opts.defaultTimeoutMs)
    ? Math.max(0, opts.defaultTimeoutMs as number)
    : DEFAULT_TIMEOUT_MS;
  // Number.isFinite(null) === false, so both NaN and null collapse to null (unbounded).
  const maxAgents = Number.isFinite(opts.maxAgents)
    ? Math.max(0, Math.floor(opts.maxAgents as number))
    : null;

  const sem = new Semaphore(maxConcurrent);

  // Per-run step-key state (drives resumability + dedup).
  const usedKeys = new Set<string>();
  let agentSeq = 0;
  // Budget accounting — only NON-cached spawns count.
  let spentCount = 0;

  function deriveStepKey(label?: string): string {
    agentSeq += 1;
    const base = sanitizeStepKey(label ?? `step-${agentSeq}`);
    let key = base;
    let n = 2;
    while (usedKeys.has(key)) {
      key = `${base}-${n}`;
      n += 1;
    }
    usedKeys.add(key);
    return key;
  }

  const budget: Budget = {
    maxAgents,
    spent: () => spentCount,
    remaining: () => (maxAgents === null ? Infinity : maxAgents - spentCount),
  };

  /** Poll the result file until it appears, the session dies, or we hit the cap. */
  async function pollForResult(
    sessionId: string,
    path: string,
    pollIntervalMs: number,
    timeoutMs: number,
    startupGraceMs: number,
  ): Promise<RawResult | null> {
    const start = clock.now();
    // A freshly-created session reports `running: false` for a brief startup window
    // (the PTY exists but the child process is not registered as running yet). If we
    // treated that first `!running` as terminal we would kill the child before it ever
    // booted. So `!running` is only terminal once the child has been observed running
    // at least once (it ran, then exited), or once the startup grace has elapsed
    // without it ever coming up (it failed to start).
    let everRunning = false;
    for (;;) {
      const found = await store.readResult(path);
      if (found) return found;
      const elapsed = clock.now() - start;
      if (elapsed >= timeoutMs) return null;
      const running = await bridge.isRunning(sessionId);
      if (running) {
        everRunning = true;
      } else if (everRunning || elapsed >= startupGraceMs) {
        // Ran-then-exited (do one final read for the wrote-then-exited race) or
        // never started within the grace window.
        return await store.readResult(path);
      }
      await clock.sleep(pollIntervalMs);
    }
  }

  async function agent(prompt: string, agentOpts: AgentOptions = {}): Promise<unknown> {
    if (typeof prompt !== 'string' || prompt.length === 0) {
      throw new Error('agent(): prompt must be a non-empty string');
    }

    const stepKey = deriveStepKey(agentOpts.label);
    const label = agentOpts.label ?? stepKey;
    const phase = agentOpts.phase;
    const hasSchema = agentOpts.schema !== undefined;
    const path = store.resultPath(opts.runId, stepKey);

    // 1. Resume: a valid result already on disk → return without spawning.
    //    A failing cache read is treated as a MISS (proceed to spawn) so agent()
    //    honors its never-rejects contract; the poll read inside the try block
    //    surfaces real store failures as null.
    let cached: RawResult | null = null;
    try {
      cached = await store.readResult(path);
    } catch {
      cached = null;
    }
    if (cached) {
      logger.event({ kind: 'agent-done', label, phase, ok: cached.ok, cached: true });
      return cached.ok ? mapOk(cached, hasSchema) : null;
    }

    // 7. Budget: a set cap blocks further spawns once exhausted.
    if (maxAgents !== null && spentCount >= maxAgents) {
      logger.event({ kind: 'agent-error', label, phase, error: 'budget exhausted' });
      return null;
    }
    spentCount += 1;

    const spec: SpawnSpec = {
      prompt: buildAgentPrompt(prompt, path, agentOpts.schema),
      shellType: agentOpts.shell ?? defaultShell,
      parentSessionId: opts.selfSessionId,
    };
    if (agentOpts.workdir ?? opts.workdir) spec.workingDir = agentOpts.workdir ?? opts.workdir;
    spec.name = agentOpts.name ?? label;
    if (agentOpts.model) spec.model = agentOpts.model;

    // 6. Concurrency: only `maxConcurrent` spawn+poll cycles run at once.
    await sem.acquire();
    let sessionId: string | undefined;
    try {
      const session = await bridge.createSession(spec);
      sessionId = session.id;
      logger.event({ kind: 'agent-start', label, phase, sessionId });

      const pollInterval = Number.isFinite(agentOpts.pollIntervalMs)
        ? Math.max(50, agentOpts.pollIntervalMs as number)
        : DEFAULT_POLL_INTERVAL_MS;
      const startupGrace = Number.isFinite(agentOpts.startupGraceMs)
        ? Math.max(0, agentOpts.startupGraceMs as number)
        : DEFAULT_STARTUP_GRACE_MS;
      const raw = await pollForResult(
        sessionId,
        path,
        pollInterval,
        agentOpts.timeoutMs ?? defaultTimeoutMs,
        startupGrace,
      );

      if (raw && raw.ok) {
        logger.event({ kind: 'agent-done', label, phase, ok: true, cached: false });
        return mapOk(raw, hasSchema);
      }

      const error = raw
        ? (raw.error ?? 'agent reported failure')
        : 'no result (session exited or timed out)';
      logger.event({ kind: 'agent-error', label, phase, error });
      return null;
    } catch (err) {
      // Real bridge/store errors must not reject agent() — map to a failure.
      const message = err instanceof Error ? err.message : String(err);
      logger.event({ kind: 'agent-error', label, phase, error: message });
      return null;
    } finally {
      // 5. Cleanup: ALWAYS remove the session, swallowing 404s.
      if (sessionId !== undefined) {
        try {
          await bridge.removeSession(sessionId);
        } catch {
          /* removeSession must not throw on 404 — ignore. */
        }
      }
      sem.release();
    }
  }

  async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> {
    return Promise.all(
      thunks.map(async (thunk) => {
        try {
          return await thunk();
        } catch {
          return null;
        }
      }),
    );
  }

  async function pipeline(
    items: unknown[],
    ...stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>>
  ): Promise<unknown[]> {
    return Promise.all(
      items.map(async (item, index) => {
        let prev: unknown = item;
        try {
          for (const stage of stages) {
            prev = await stage(prev, item, index);
          }
          return prev;
        } catch {
          return null;
        }
      }),
    );
  }

  const ctx: WorkflowContext = {
    agent,
    parallel,
    pipeline,
    phase: (title: string) => logger.event({ kind: 'phase', title }),
    log: (message: string) => logger.event({ kind: 'log', message }),
    args: opts.args,
    budget,
  };

  return await body(ctx);
}
