import { describe, expect, it } from 'vitest';

import {
  buildAgentPrompt,
  parseResultFile,
  runWorkflow,
  type BridgeClient,
  type Clock,
  type Logger,
  type RawResult,
  type ResultStore,
  type RunnerDeps,
  type RunOptions,
  type SpawnSpec,
  type WorkflowContext,
  type WorkflowEvent,
} from './workflow-runner.js';

// ---------------------------------------------------------------------------
// Fakes — fully in-memory, no network, no real fs, no real timers.
// The fake Clock resolves sleeps immediately but ADVANCES virtual `now` by the
// slept amount, so wall-clock timeouts terminate and `await sleep` still yields
// a microtask (which is what lets concurrent agents interleave deterministically).
// ---------------------------------------------------------------------------

class FakeClock implements Clock {
  current = 0;
  /** Every ms value passed to sleep(), in order — used to assert the poll floor. */
  slept: number[] = [];
  now(): number {
    return this.current;
  }
  async sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    this.current += ms;
  }
}

/** A store whose FIRST readResult (the resume cache-check) throws, then succeeds. */
class ThrowOnceStore implements ResultStore {
  result: RawResult = { ok: true, result: 'recovered' };
  calls = 0;
  resultPath(runId: string, stepKey: string): string {
    return `/wf/${runId}/${stepKey}.json`;
  }
  async readResult(_path: string): Promise<RawResult | null> {
    this.calls += 1;
    if (this.calls === 1) throw new Error('cache read blew up');
    return this.result;
  }
}

class FakeBridge implements BridgeClient {
  created: SpawnSpec[] = [];
  removed: string[] = [];
  /** Sessions created but not yet removed — used to measure concurrency. */
  inFlight = 0;
  /** High-water mark of inFlight across the whole run. */
  peak = 0;
  running: boolean;
  /** Optional sequence of isRunning() values; the last element persists once consumed. */
  runningSeq: boolean[] | null = null;
  private seq = 0;
  private live = new Set<string>();

  constructor(running = true) {
    this.running = running;
  }

  async createSession(opts: SpawnSpec): Promise<{ id: string }> {
    // Increment synchronously, before any await, so the high-water mark is exact.
    this.created.push(opts);
    this.inFlight += 1;
    if (this.inFlight > this.peak) this.peak = this.inFlight;
    const id = `s${(this.seq += 1)}`;
    this.live.add(id);
    return { id };
  }

  async removeSession(id: string): Promise<void> {
    this.removed.push(id);
    if (this.live.delete(id)) this.inFlight -= 1;
    // Real impl swallows 404 — the fake simply never throws.
  }

  async isRunning(_id: string): Promise<boolean> {
    if (this.runningSeq && this.runningSeq.length > 0) {
      return this.runningSeq.length > 1 ? this.runningSeq.shift()! : this.runningSeq[0];
    }
    return this.running;
  }
}

type StoreMode =
  | 'gated' // first read of a path is null (so cache-check misses + agent spawns), then result once virtual time advances
  | 'present' // result is there immediately, even on the cache-check read (resume)
  | 'absent'; // never any result (session exits w/o writing, or times out)

class FakeStore implements ResultStore {
  result: RawResult = { ok: true, result: 'hello' };
  mode: StoreMode = 'gated';
  reads: string[] = [];
  private firstSeen = new Map<string, number>();

  constructor(private clock: FakeClock) {}

  resultPath(runId: string, stepKey: string): string {
    return `/wf/${runId}/${stepKey}.json`;
  }

  async readResult(path: string): Promise<RawResult | null> {
    this.reads.push(path);
    if (this.mode === 'absent') return null;
    if (this.mode === 'present') return this.result;
    // gated
    if (!this.firstSeen.has(path)) {
      this.firstSeen.set(path, this.clock.now());
      return null; // cache-check / first poll always misses
    }
    return this.clock.now() > this.firstSeen.get(path)! ? this.result : null;
  }
}

class FakeLogger implements Logger {
  events: WorkflowEvent[] = [];
  event(ev: WorkflowEvent): void {
    this.events.push(ev);
  }
}

// Type-narrowing selectors over the recorded event log.
const starts = (l: FakeLogger) =>
  l.events.filter((e): e is Extract<WorkflowEvent, { kind: 'agent-start' }> => e.kind === 'agent-start');
const dones = (l: FakeLogger) =>
  l.events.filter((e): e is Extract<WorkflowEvent, { kind: 'agent-done' }> => e.kind === 'agent-done');
const errors = (l: FakeLogger) =>
  l.events.filter((e): e is Extract<WorkflowEvent, { kind: 'agent-error' }> => e.kind === 'agent-error');

function setup(): {
  clock: FakeClock;
  bridge: FakeBridge;
  store: FakeStore;
  logger: FakeLogger;
  deps: RunnerDeps;
} {
  const clock = new FakeClock();
  const bridge = new FakeBridge();
  const store = new FakeStore(clock);
  const logger = new FakeLogger();
  const deps: RunnerDeps = { bridge, store, clock, logger };
  return { clock, bridge, store, logger, deps };
}

/** Run a script body through the real runner with sensible defaults. */
function run(
  deps: RunnerDeps,
  body: (ctx: WorkflowContext) => Promise<unknown> | unknown,
  opts: Partial<RunOptions> = {},
): Promise<unknown> {
  return runWorkflow(
    deps,
    { default: body },
    { runId: 'run1', selfSessionId: 'self-1', ...opts },
  );
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('buildAgentPrompt', () => {
  it('includes the task and literally contains the result file path', () => {
    const prompt = buildAgentPrompt('Review the diff', '/wf/run1/rev.json');
    expect(prompt).toContain('Review the diff');
    expect(prompt).toContain('/wf/run1/rev.json');
  });

  it('reinforces the file-only protocol (ONLY accepted output channel, no mail)', () => {
    const prompt = buildAgentPrompt('Do it', '/wf/run1/x.json');
    expect(prompt).toContain('/wf/run1/x.json');
    expect(prompt).toContain('ONLY accepted output channel');
    expect(prompt).toContain('Do NOT report via ftown-harness mail');
  });

  it('embeds the schema text only when a schema is provided', () => {
    const schema = {
      type: 'object',
      properties: { widgetCount: { type: 'integer' } },
      required: ['widgetCount'],
    };
    const withSchema = buildAgentPrompt('Count widgets', '/wf/run1/count.json', schema);
    expect(withSchema).toContain('/wf/run1/count.json');
    // distinctive token from the schema, robust to pretty vs compact JSON
    expect(withSchema).toContain('widgetCount');

    const withoutSchema = buildAgentPrompt('Count widgets', '/wf/run1/count.json');
    expect(withoutSchema).not.toContain('widgetCount');
  });
});

describe('parseResultFile', () => {
  it('parses a valid ok:true result', () => {
    expect(parseResultFile('{"ok":true,"result":"x"}')).toEqual({ ok: true, result: 'x' });
  });

  it('parses a valid ok:false result', () => {
    expect(parseResultFile('{"ok":false,"error":"bad"}')).toEqual({ ok: false, error: 'bad' });
  });

  it('returns null for empty text (no file / partial write)', () => {
    expect(parseResultFile('')).toBeNull();
  });

  it('returns null for non-JSON garbage', () => {
    expect(parseResultFile('not json {')).toBeNull();
  });

  it('returns null when JSON parses but has no boolean ok', () => {
    expect(parseResultFile('{"result":"x"}')).toBeNull();
    expect(parseResultFile('{"ok":"true"}')).toBeNull(); // ok must be a boolean
  });
});

// ---------------------------------------------------------------------------
// agent()
// ---------------------------------------------------------------------------

describe('agent()', () => {
  it('happy path: spawns once, returns the result string, removes the session', async () => {
    const { bridge, store, logger, deps } = setup();
    store.result = { ok: true, result: 'hello' };

    const out = await run(deps, (ctx) => ctx.agent('review the PR', { label: 'rev' }));

    expect(out).toBe('hello');
    expect(bridge.created).toHaveLength(1);
    expect(bridge.removed).toHaveLength(1);

    // The spawn spec wires the child to the orchestrator and embeds the result path.
    const spec = bridge.created[0];
    expect(spec.parentSessionId).toBe('self-1');
    expect(spec.shellType).toBe('claude'); // default shell
    expect(spec.prompt).toContain(store.resultPath('run1', 'rev'));

    // Lifecycle events.
    expect(starts(logger)[0]).toMatchObject({ label: 'rev', sessionId: 's1' });
    expect(dones(logger)[0]).toMatchObject({ label: 'rev', ok: true, cached: false });
  });

  it('with a schema returns the parsed result object (not coerced to a string)', async () => {
    const { store, deps } = setup();
    store.result = { ok: true, result: { name: 'Ada', score: 9 } };

    const out = await run(deps, (ctx) =>
      ctx.agent('extract', { label: 'x', schema: { type: 'object' } }),
    );

    expect(out).toEqual({ name: 'Ada', score: 9 });
  });

  it('resume: an existing valid result is returned without spawning', async () => {
    const { bridge, store, logger, deps } = setup();
    store.mode = 'present'; // file already on disk before the run
    store.result = { ok: true, result: 'cached' };

    const out = await run(deps, (ctx) => ctx.agent('redo', { label: 'rev' }));

    expect(out).toBe('cached');
    expect(bridge.created).toHaveLength(0); // never spawned
    expect(dones(logger)[0]).toMatchObject({ cached: true });
  });

  it('session exits without writing a result → returns null, session removed', async () => {
    const { bridge, store, logger, deps } = setup();
    store.mode = 'absent';
    bridge.running = false; // PTY already dead, never wrote a result

    const out = await run(deps, (ctx) => ctx.agent('do work', { label: 'rev' }));

    expect(out).toBeNull();
    expect(bridge.created).toHaveLength(1);
    expect(bridge.removed).toHaveLength(1); // cleaned up even on failure
    const failed =
      errors(logger).length > 0 || dones(logger).some((d) => d.ok === false);
    expect(failed).toBe(true);
  });

  it('timeout: result never appears while still running → returns null, session removed', async () => {
    const { bridge, store, logger, deps } = setup();
    store.mode = 'absent';
    bridge.running = true; // stays alive forever; only the wall-clock cap stops us

    const out = await run(deps, (ctx) =>
      ctx.agent('hang', { label: 't', timeoutMs: 30, pollIntervalMs: 10 }),
    );

    expect(out).toBeNull();
    expect(bridge.removed).toHaveLength(1);
    const failed =
      errors(logger).length > 0 || dones(logger).some((d) => d.ok === false);
    expect(failed).toBe(true);
  });

  it('startup race: isRunning is false on the first poll then true — agent waits instead of bailing', async () => {
    // Regression for the live bug: a freshly-created session reports running:false for a
    // brief startup window. The engine must NOT treat that first !running as terminal
    // (which removed the child before it ever booted). Pre-fix this returned null.
    const { bridge, store, logger, deps } = setup();
    bridge.runningSeq = [false, true]; // false right after create, then running
    store.result = { ok: true, result: 'pong' };

    const out = await run(deps, (ctx) => ctx.agent('health check', { label: 'ping' }));

    expect(out).toBe('pong');
    expect(bridge.created).toHaveLength(1);
    expect(bridge.removed).toHaveLength(1);
    expect(dones(logger)[0]).toMatchObject({ ok: true, cached: false });
  });

  it('ran then exited without writing a result → returns null (everRunning path)', async () => {
    const { bridge, store, deps } = setup();
    store.mode = 'absent';
    bridge.runningSeq = [true, false]; // came up, then died without writing
    store.result = { ok: true, result: 'unused' };

    const out = await run(deps, (ctx) =>
      ctx.agent('crash', { label: 'rev', pollIntervalMs: 50 }),
    );

    expect(out).toBeNull();
    expect(bridge.removed).toHaveLength(1);
  });

  it('ok:false result → returns null (never throws), session removed', async () => {
    const { bridge, store, logger, deps } = setup();
    store.result = { ok: false, error: 'nope' };

    const out = await run(deps, (ctx) => ctx.agent('try', { label: 'rev' }));

    expect(out).toBeNull();
    expect(bridge.created).toHaveLength(1);
    expect(bridge.removed).toHaveLength(1);
    const failed =
      errors(logger).length > 0 || dones(logger).some((d) => d.ok === false);
    expect(failed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parallel()
// ---------------------------------------------------------------------------

describe('parallel()', () => {
  it('runs all thunks, preserves order, maps a throwing thunk to null, never rejects', async () => {
    const { deps } = setup();

    const out = await run(deps, (ctx) =>
      ctx.parallel<string>([
        async () => 'a',
        async () => {
          throw new Error('boom');
        },
        async () => 'c',
      ]),
    );

    expect(out).toEqual(['a', null, 'c']);
  });
});

// ---------------------------------------------------------------------------
// pipeline()
// ---------------------------------------------------------------------------

describe('pipeline()', () => {
  it('threads stage outputs; a per-item stage throw drops that item to null and skips its rest', async () => {
    const { deps } = setup();

    const out = await run(deps, (ctx) =>
      ctx.pipeline(
        [1, 2, 3],
        // stage 1: prev is the original item here
        async (prev) => (prev as number) * 10,
        // stage 2: receives (prevStageOutput, originalItem, index)
        async (prev, item, index) => {
          if (item === 2) throw new Error('drop'); // assert `item` is the ORIGINAL item, not prev
          return `${prev}-${index}`;
        },
      ),
    );

    // item 1: 1 -> 10 -> '10-0'
    // item 2: 2 -> 20 -> throws  -> null
    // item 3: 3 -> 30 -> '30-2'   (no barrier: not blocked by item 2's failure)
    expect(out).toEqual(['10-0', null, '30-2']);
  });
});

// ---------------------------------------------------------------------------
// concurrency cap
// ---------------------------------------------------------------------------

describe('concurrency', () => {
  it('caps concurrently-running spawns at maxConcurrent', async () => {
    const { bridge, deps } = setup();

    const out = (await run(
      deps,
      (ctx) =>
        ctx.parallel<string>(
          Array.from({ length: 5 }, (_, i) => () =>
            ctx.agent(`task ${i}`, { label: `a${i}`, pollIntervalMs: 5 }),
          ) as Array<() => Promise<string>>,
        ),
      { maxConcurrent: 2 },
    )) as Array<string | null>;

    expect(bridge.created).toHaveLength(5); // every agent ran
    expect(bridge.removed).toHaveLength(5); // every session cleaned up
    expect(bridge.peak).toBeLessThanOrEqual(2); // the hard cap
    expect(bridge.peak).toBe(2); // and it actually overlapped (real concurrency)
    expect(out.every((r) => r === 'hello')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

describe('budget', () => {
  it('maxAgents=2: the third spawn returns null without spawning', async () => {
    const { bridge, logger, deps } = setup();

    const out = (await run(
      deps,
      async (ctx) => {
        const r1 = await ctx.agent('one', { label: 'a' });
        const r2 = await ctx.agent('two', { label: 'b' });
        const r3 = await ctx.agent('three', { label: 'c' });
        return { r1, r2, r3, spent: ctx.budget.spent(), remaining: ctx.budget.remaining() };
      },
      { maxAgents: 2 },
    )) as {
      r1: unknown;
      r2: unknown;
      r3: unknown;
      spent: number;
      remaining: number;
    };

    expect(out.r1).toBe('hello');
    expect(out.r2).toBe('hello');
    expect(out.r3).toBeNull(); // budget exhausted
    expect(bridge.created).toHaveLength(2); // third never spawned
    expect(out.spent).toBe(2);
    expect(out.remaining).toBe(0);
    expect(errors(logger).some((e) => /budget/i.test(e.error))).toBe(true);
  });

  it('exposes args and an unbounded budget by default', async () => {
    const { deps } = setup();

    const out = (await run(
      deps,
      (ctx) => ({
        args: ctx.args,
        spent: ctx.budget.spent(),
        remaining: ctx.budget.remaining(),
        maxAgents: ctx.budget.maxAgents,
      }),
      { args: { foo: 1 } },
    )) as { args: unknown; spent: number; remaining: number; maxAgents: number | null };

    expect(out.args).toEqual({ foo: 1 });
    expect(out.spent).toBe(0);
    expect(out.remaining).toBe(Infinity); // maxAgents null => unbounded
    expect(out.maxAgents).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// phase() / log()
// ---------------------------------------------------------------------------

describe('phase() and log()', () => {
  it('emit phase and log events to the logger', async () => {
    const { logger, deps } = setup();

    await run(deps, (ctx) => {
      ctx.phase('analyze');
      ctx.log('working');
    });

    expect(logger.events).toContainEqual({ kind: 'phase', title: 'analyze' });
    expect(logger.events).toContainEqual({ kind: 'log', message: 'working' });
  });
});

// ---------------------------------------------------------------------------
// NaN hardening (FIX A)
// ---------------------------------------------------------------------------

describe('NaN hardening', () => {
  it('maxConcurrent NaN does not deadlock — the agent still runs (finite fallback)', async () => {
    const { bridge, deps } = setup();

    const out = await run(deps, (ctx) => ctx.agent('go', { label: 'a' }), {
      maxConcurrent: NaN,
    });

    expect(out).toBe('hello');
    expect(bridge.created).toHaveLength(1);
    expect(bridge.removed).toHaveLength(1);
  });

  it('defaultTimeoutMs NaN falls back to a finite default — absent agent returns null', async () => {
    const { bridge, store, deps } = setup();
    store.mode = 'absent';
    bridge.running = true; // never exits; only the wall-clock cap can stop the poll

    const out = await run(
      deps,
      // large finite poll keeps the virtual clock advancing in few iterations
      (ctx) => ctx.agent('hang', { label: 't', pollIntervalMs: 100_000 }),
      { defaultTimeoutMs: NaN },
    );

    expect(out).toBeNull();
    expect(bridge.removed).toHaveLength(1);
  });

  it('maxAgents NaN is treated as unbounded (null budget) — spawns are not blocked', async () => {
    const { bridge, deps } = setup();

    const out = (await run(
      deps,
      async (ctx) => {
        const r = await ctx.agent('one', { label: 'a' });
        return {
          r,
          remaining: ctx.budget.remaining(),
          maxAgents: ctx.budget.maxAgents,
        };
      },
      { maxAgents: NaN },
    )) as { r: unknown; remaining: number; maxAgents: number | null };

    expect(out.r).toBe('hello');
    expect(out.remaining).toBe(Infinity);
    expect(out.maxAgents).toBeNull();
    expect(bridge.created).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// pollInterval floor (FIX E)
// ---------------------------------------------------------------------------

describe('pollInterval floor', () => {
  it('pollIntervalMs 0 is clamped to >= 50 — correctness unchanged, no zero-sleep spin', async () => {
    const { bridge, clock, deps } = setup();

    const out = await run(deps, (ctx) =>
      ctx.agent('go', { label: 'a', pollIntervalMs: 0 }),
    );

    expect(out).toBe('hello');
    expect(bridge.created).toHaveLength(1);
    expect(clock.slept.length).toBeGreaterThan(0);
    expect(clock.slept.every((ms) => ms >= 50)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// no-schema structured result (FIX I)
// ---------------------------------------------------------------------------

describe('mapOk no-schema', () => {
  it('returns a non-string object result as a JSON string (not "[object Object]")', async () => {
    const { store, deps } = setup();
    store.result = { ok: true, result: { a: 1 } };

    const out = await run(deps, (ctx) => ctx.agent('go', { label: 'a' }));

    expect(out).toBe('{"a":1}');
  });
});

// ---------------------------------------------------------------------------
// cache-read throw (FIX D)
// ---------------------------------------------------------------------------

describe('cache-read throw', () => {
  it('a throwing resume cache read is treated as a miss — agent() proceeds and never rejects', async () => {
    const clock = new FakeClock();
    const bridge = new FakeBridge();
    const store = new ThrowOnceStore();
    const logger = new FakeLogger();
    const deps: RunnerDeps = { bridge, store, clock, logger };

    const out = await run(deps, (ctx) => ctx.agent('go', { label: 'a' }));

    // The first (cache) read threw; the engine swallowed it, spawned, and the
    // poll read recovered the result. The call resolved — it never rejected.
    expect(out).toBe('recovered');
    expect(bridge.created).toHaveLength(1);
    expect(bridge.removed).toHaveLength(1);
  });
});
