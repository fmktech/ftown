import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  LoopScheduler,
  runFlightCommand,
  type FlightResult,
  type LoopStoreApi,
  type RemoveSession,
  type RunFlight,
  type SchedulerCentrifugo,
  type SchedulerRunner,
  type SchedulerStore,
  type SpawnSession,
} from './loop-scheduler.js';
import type { CreateFtownSessionInput } from './create-ftown-session.js';
import type { RemoveFtownSessionOptions } from './remove-ftown-session.js';
import type { Loop, LoopDraft, Session } from './types.js';

// ---------------------------------------------------------------------------
// In-memory fakes — no real fs, timers, PTYs or network. Mirrors the DI style
// of workflow-runner.test.ts. Loop store clones on read/write so the engine's
// mutations only take effect through upsertLoop (like the real JSON-on-disk store).
// ---------------------------------------------------------------------------

class FakeLoopStore implements LoopStoreApi {
  private map = new Map<string, Loop>();
  seed(loop: Loop): void {
    this.map.set(loop.id, structuredClone(loop));
  }
  listLoops(): Loop[] {
    return [...this.map.values()].map((l) => structuredClone(l));
  }
  getLoop(id: string): Loop | undefined {
    const l = this.map.get(id);
    return l ? structuredClone(l) : undefined;
  }
  // Mirrors the real store: fresh-read → apply fn → save; null when the id is
  // gone (deleted concurrently). structuredClone on read AND write keeps the
  // engine operating on detached copies, exactly like JSON-on-disk.
  mutateLoopRuntime(id: string, fn: (loop: Loop) => void): Loop | null {
    const existing = this.map.get(id);
    if (!existing) return null;
    const loop = structuredClone(existing);
    fn(loop);
    this.map.set(id, structuredClone(loop));
    return structuredClone(loop);
  }
  /** Test-only: delete a loop out from under the engine mid-flight. */
  drop(id: string): void {
    this.map.delete(id);
  }
  snapshot(id: string): Loop {
    const l = this.map.get(id);
    if (!l) throw new Error(`no loop ${id}`);
    return structuredClone(l);
  }
  has(id: string): boolean {
    return this.map.has(id);
  }
}

class FakeRunner implements SchedulerRunner {
  running = new Set<string>();
  stopped: string[] = [];
  isRunning(id: string): boolean {
    return this.running.has(id);
  }
  stop(id: string): boolean {
    this.stopped.push(id);
    this.running.delete(id);
    return true;
  }
}

class FakeStore implements SchedulerStore {
  sessions = new Map<string, Session>();
  logs = new Map<string, string>();
  async loadSession(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }
  async loadTerminalLog(id: string): Promise<string> {
    return this.logs.get(id) ?? '';
  }
  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()];
  }
}

class FakeCentrifugo implements SchedulerCentrifugo {
  published: Loop[] = [];
  async publishLoopUpdate(_userId: string, loop: Loop): Promise<void> {
    this.published.push(structuredClone(loop));
  }
}

interface FlightCall {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  extraEnv?: Record<string, string>;
}

function makeHarness() {
  const loops = new FakeLoopStore();
  const runner = new FakeRunner();
  const store = new FakeStore();
  const centrifugo = new FakeCentrifugo();

  let nowValue = 0;
  const setNow = (n: number): void => {
    nowValue = n;
  };

  const spawnCalls: CreateFtownSessionInput[] = [];
  let spawnSeq = 0;
  let spawnGate: Promise<void> | null = null;
  const spawnSession: SpawnSession = async (input) => {
    spawnCalls.push(structuredClone(input));
    if (spawnGate) await spawnGate;
    const id = `run-${++spawnSeq}`;
    const session: Session = {
      id,
      name: input.name ?? 'run',
      command: 'cmd',
      status: 'running',
      bridgeId: 'b1',
      createdAt: new Date(nowValue).toISOString(),
      updatedAt: new Date(nowValue).toISOString(),
      loopId: input.loopId,
      shellType: input.shellType,
    };
    store.sessions.set(id, session);
    runner.running.add(id);
    return session;
  };

  const removed: Array<{ id: string; opts?: RemoveFtownSessionOptions }> = [];
  const removeSession: RemoveSession = async (id, opts) => {
    removed.push({ id, opts });
    const s = store.sessions.get(id) ?? null;
    if (opts?.onlyIfFinished && s && s.status !== 'completed' && s.status !== 'error') return null;
    store.sessions.delete(id);
    runner.running.delete(id);
    return s;
  };

  const flightCalls: FlightCall[] = [];
  const flightResults: FlightResult[] = [];
  const runFlight: RunFlight = async (command, cwd, timeoutMs, extraEnv) => {
    flightCalls.push({ command, cwd, timeoutMs, extraEnv });
    return flightResults.shift() ?? { stdout: '', stderr: '', exitCode: 0 };
  };

  const scheduler = new LoopScheduler({
    store,
    runner,
    centrifugo,
    userId: 'u1',
    spawnSession,
    removeSession,
    loops,
    runFlight,
    now: () => nowValue,
  });

  return {
    loops,
    runner,
    store,
    centrifugo,
    scheduler,
    spawnCalls,
    removed,
    flightCalls,
    flightResults,
    setNow,
    setSpawnGate: (p: Promise<void> | null) => {
      spawnGate = p;
    },
  };
}

function loopFixture(overrides: Partial<Loop> = {}): Loop {
  const draft: LoopDraft = {
    name: 'nightly',
    bridgeId: 'b1',
    schedule: { kind: 'interval', everyMs: 60_000 },
    harness: 'claude',
    task: 'do it',
    enabled: true,
    overlapPolicy: 'skip',
    retention: { autoClearAfterRuns: null },
  };
  return {
    ...draft,
    id: 'loop-1',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    nextRunAt: new Date(0).toISOString(), // due at now=0 by default
    runCount: 0,
    skipCount: 0,
    ...overrides,
  };
}

function runSession(id: string, loopId: string, createdAtMs: number, status: Session['status']): Session {
  return {
    id,
    name: id,
    command: 'c',
    status,
    bridgeId: 'b1',
    createdAt: new Date(createdAtMs).toISOString(),
    updatedAt: new Date(createdAtMs).toISOString(),
    loopId,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

describe('LoopScheduler — fire (interval/cron due)', () => {
  it('fires a due loop, substitutes {{preflight}}, sets FTOWN_PREFLIGHT_OUTPUT, tags loopId', async () => {
    const h = makeHarness();
    h.loops.seed(
      loopFixture({
        task: 'Report: {{preflight}}',
        preflight: { command: 'echo hi' },
      }),
    );
    h.flightResults.push({ stdout: 'PREFLIGHT-DATA', stderr: '', exitCode: 0 });

    await h.scheduler.tick(0);

    assert.strictEqual(h.spawnCalls.length, 1);
    const input = h.spawnCalls[0];
    assert.strictEqual(input.prompt, 'Report: PREFLIGHT-DATA');
    assert.deepStrictEqual(input.env, { FTOWN_PREFLIGHT_OUTPUT: 'PREFLIGHT-DATA' });
    assert.strictEqual(input.loopId, 'loop-1');
    assert.strictEqual(input.shellType, 'claude');
    assert.strictEqual(input.suppressBriefing, true);
    assert.strictEqual(input.parentSessionId, undefined);

    const loop = h.loops.snapshot('loop-1');
    assert.strictEqual(loop.lastStatus, 'running');
    assert.strictEqual(loop.runCount, 1);
    assert.strictEqual(loop.skipCount, 0);
    assert.ok(loop.lastSessionId);
    assert.strictEqual(loop.nextRunAt, iso(60_000)); // advanced by interval
    assert.strictEqual(loop.lastRunAt, iso(0));
  });

  it('a fire with no preflight passes the task verbatim and no env', async () => {
    const h = makeHarness();
    h.loops.seed(loopFixture({ task: 'plain task', schedule: { kind: 'cron', expression: '*/5 * * * *', tz: 'UTC' } }));

    await h.scheduler.tick(0);

    assert.strictEqual(h.spawnCalls.length, 1);
    assert.strictEqual(h.spawnCalls[0].prompt, 'plain task');
    assert.strictEqual(h.spawnCalls[0].env, undefined);
    // cron next boundary strictly after epoch is 00:05:00Z.
    assert.strictEqual(h.loops.snapshot('loop-1').nextRunAt, iso(300_000));
  });

  it('does not fire a loop that is not due', async () => {
    const h = makeHarness();
    h.loops.seed(loopFixture({ nextRunAt: iso(10_000) }));
    await h.scheduler.tick(0);
    assert.strictEqual(h.spawnCalls.length, 0);
  });

  it('does not fire a disabled loop, but a manual runNowRequested overrides', async () => {
    const h = makeHarness();
    h.loops.seed(loopFixture({ id: 'off', enabled: false, nextRunAt: iso(0) }));
    h.loops.seed(loopFixture({ id: 'manual', enabled: false, nextRunAt: undefined, runNowRequested: true }));

    await h.scheduler.tick(0);

    assert.deepStrictEqual(h.spawnCalls.map((s) => s.loopId).sort(), ['manual']);
    assert.strictEqual(h.loops.snapshot('manual').runNowRequested, false); // cleared on fire
  });
});

describe('LoopScheduler — preflight skip', () => {
  it('aborts without a session on non-zero preflight: skipped, skipCount++, schedule advanced', async () => {
    const h = makeHarness();
    h.loops.seed(loopFixture({ preflight: { command: 'guard' } }));
    h.flightResults.push({ stdout: 'no', stderr: '', exitCode: 3 });

    await h.scheduler.tick(0);

    assert.strictEqual(h.spawnCalls.length, 0);
    const loop = h.loops.snapshot('loop-1');
    assert.strictEqual(loop.lastStatus, 'skipped');
    assert.strictEqual(loop.skipCount, 1);
    assert.strictEqual(loop.runCount, 0);
    assert.strictEqual(loop.nextRunAt, iso(60_000));
    assert.strictEqual(h.flightCalls.length, 1); // only the preflight ran
  });

  it('runs postflight on a preflight-skip only when runOnSkip is set', async () => {
    const h = makeHarness();
    h.loops.seed(
      loopFixture({
        preflight: { command: 'guard' },
        postflight: { command: 'notify', runOnSkip: true },
      }),
    );
    h.flightResults.push({ stdout: '', stderr: '', exitCode: 1 });

    await h.scheduler.tick(0);

    assert.strictEqual(h.spawnCalls.length, 0);
    assert.strictEqual(h.flightCalls.length, 2);
    assert.strictEqual(h.flightCalls[1].command, 'notify');
    assert.deepStrictEqual(h.flightCalls[1].extraEnv, {
      FTOWN_RUN_STATUS: 'skipped',
      FTOWN_RUN_SESSION_ID: '',
      FTOWN_RUN_OUTPUT: '',
    });
  });

  it('skips postflight on a preflight-skip when runOnSkip is false', async () => {
    const h = makeHarness();
    h.loops.seed(loopFixture({ preflight: { command: 'guard' }, postflight: { command: 'notify' } }));
    h.flightResults.push({ stdout: '', stderr: '', exitCode: 1 });
    await h.scheduler.tick(0);
    assert.strictEqual(h.flightCalls.length, 1); // preflight only
  });
});

describe('LoopScheduler — overlap policy', () => {
  it("skip policy advances the schedule without firing while a run is alive", async () => {
    const h = makeHarness();
    h.runner.running.add('live');
    h.store.sessions.set('live', runSession('live', 'loop-1', 0, 'running'));
    h.loops.seed(
      loopFixture({
        overlapPolicy: 'skip',
        lastStatus: 'running',
        lastSessionId: 'live',
        lastRunAt: iso(0),
        nextRunAt: iso(100),
      }),
    );

    await h.scheduler.tick(100);

    assert.strictEqual(h.spawnCalls.length, 0);
    const loop = h.loops.snapshot('loop-1');
    assert.strictEqual(loop.lastStatus, 'running'); // untouched
    assert.strictEqual(loop.skipCount, 0); // overlap-skip != preflight-skip
    assert.strictEqual(loop.nextRunAt, iso(60_100)); // advanced from now=100
  });

  it('allow policy fires even while a previous run is alive', async () => {
    const h = makeHarness();
    h.runner.running.add('live');
    h.store.sessions.set('live', runSession('live', 'loop-1', 0, 'running'));
    h.loops.seed(
      loopFixture({
        overlapPolicy: 'allow',
        lastStatus: 'running',
        lastSessionId: 'live',
        lastRunAt: iso(0),
        nextRunAt: iso(100),
      }),
    );

    await h.scheduler.tick(100);

    assert.strictEqual(h.spawnCalls.length, 1);
    assert.strictEqual(h.loops.snapshot('loop-1').runCount, 1);
  });
});

describe('LoopScheduler — finalize', () => {
  it('finalizes a completed run to ok after the grace window, then runs postflight with FTOWN_RUN_* env', async () => {
    const h = makeHarness();
    h.store.sessions.set('run-x', runSession('run-x', 'loop-1', 0, 'completed'));
    h.store.logs.set('run-x', 'TERMINAL OUTPUT');
    h.loops.seed(
      loopFixture({
        lastStatus: 'running',
        lastSessionId: 'run-x',
        lastRunAt: iso(0),
        nextRunAt: iso(10_000_000), // far future: no re-fire
        postflight: { command: 'post' },
      }),
    );

    await h.scheduler.tick(40_000); // elapsed 40s >= 30s grace, run not running

    const loop = h.loops.snapshot('loop-1');
    assert.strictEqual(loop.lastStatus, 'ok');
    const post = h.flightCalls.find((c) => c.command === 'post');
    assert.ok(post);
    assert.deepStrictEqual(post!.extraEnv, {
      FTOWN_RUN_STATUS: 'ok',
      FTOWN_RUN_SESSION_ID: 'run-x',
      FTOWN_RUN_OUTPUT: 'TERMINAL OUTPUT',
    });
  });

  it('does not finalize while still inside the grace window', async () => {
    const h = makeHarness();
    h.store.sessions.set('run-x', runSession('run-x', 'loop-1', 0, 'completed'));
    h.loops.seed(
      loopFixture({ lastStatus: 'running', lastSessionId: 'run-x', lastRunAt: iso(0), nextRunAt: iso(10_000_000) }),
    );
    await h.scheduler.tick(5_000); // only 5s elapsed
    assert.strictEqual(h.loops.snapshot('loop-1').lastStatus, 'running');
  });

  it('marks a missing run record as error', async () => {
    const h = makeHarness();
    h.loops.seed(
      loopFixture({ lastStatus: 'running', lastSessionId: 'gone', lastRunAt: iso(0), nextRunAt: iso(10_000_000) }),
    );
    await h.scheduler.tick(40_000);
    assert.strictEqual(h.loops.snapshot('loop-1').lastStatus, 'error');
  });

  it('force-stops and errors a run that exceeds maxRuntimeMs', async () => {
    const h = makeHarness();
    h.runner.running.add('run-y');
    h.store.sessions.set('run-y', runSession('run-y', 'loop-1', 0, 'running'));
    h.loops.seed(
      loopFixture({
        lastStatus: 'running',
        lastSessionId: 'run-y',
        lastRunAt: iso(0),
        nextRunAt: iso(10_000_000),
        maxRuntimeMs: 10_000,
      }),
    );

    await h.scheduler.tick(20_000); // elapsed 20s > maxRuntime 10s, still running

    assert.ok(h.runner.stopped.includes('run-y'));
    assert.strictEqual(h.loops.snapshot('loop-1').lastStatus, 'error');
  });
});

describe('LoopScheduler — retention prune', () => {
  it('prunes runs older than the newest N, skipping running ones and the current run', async () => {
    const h = makeHarness();
    // Newest kept run is r3 (== lastSessionId). r0 is old but still running.
    h.store.sessions.set('r3', runSession('r3', 'loop-1', 3000, 'completed'));
    h.store.sessions.set('r2', runSession('r2', 'loop-1', 2000, 'completed'));
    h.store.sessions.set('r1', runSession('r1', 'loop-1', 1000, 'completed'));
    h.store.sessions.set('r0', runSession('r0', 'loop-1', 500, 'running'));
    h.runner.running.add('r0');
    // A session from a DIFFERENT loop must never be touched.
    h.store.sessions.set('other', runSession('other', 'loop-2', 100, 'completed'));

    h.loops.seed(
      loopFixture({
        lastStatus: 'running',
        lastSessionId: 'r3',
        lastRunAt: iso(0),
        nextRunAt: iso(10_000_000),
        retention: { autoClearAfterRuns: 1 },
      }),
    );

    await h.scheduler.tick(40_000);

    // newest 1 kept (r3); r2,r1 pruned; r0 skipped (running); other untouched.
    assert.deepStrictEqual(
      h.removed.map((r) => r.id),
      ['r2', 'r1'],
    );
    assert.ok(h.removed.every((r) => r.opts?.onlyIfFinished === true));
  });

  it('keeps everything when autoClearAfterRuns is null', async () => {
    const h = makeHarness();
    h.store.sessions.set('r2', runSession('r2', 'loop-1', 2000, 'completed'));
    h.store.sessions.set('r1', runSession('r1', 'loop-1', 1000, 'completed'));
    h.loops.seed(
      loopFixture({
        lastStatus: 'running',
        lastSessionId: 'r2',
        lastRunAt: iso(0),
        nextRunAt: iso(10_000_000),
        retention: { autoClearAfterRuns: null },
      }),
    );
    await h.scheduler.tick(40_000);
    assert.strictEqual(h.removed.length, 0);
  });
});

describe('LoopScheduler — re-entrancy guard', () => {
  it('a second tick while one is in-flight returns immediately (no overlap)', async () => {
    const h = makeHarness();
    let release!: () => void;
    h.setSpawnGate(new Promise<void>((r) => (release = r)));
    h.loops.seed(loopFixture());

    const first = h.scheduler.tick(0); // enters, blocks inside spawnSession
    await new Promise((r) => setTimeout(r, 0)); // flush microtasks up to the spawn gate
    await h.scheduler.tick(0); // guarded: returns at once
    assert.strictEqual(h.spawnCalls.length, 1);

    release();
    await first;
    assert.strictEqual(h.spawnCalls.length, 1);
  });

  it('one throwing loop does not abort the whole tick', async () => {
    const h = makeHarness();
    // loop-bad has a bad cron persisted; computeNextRun throws during fire.
    h.loops.seed(loopFixture({ id: 'loop-bad', schedule: { kind: 'cron', expression: 'garbage' }, nextRunAt: iso(0) }));
    h.loops.seed(loopFixture({ id: 'loop-good', nextRunAt: iso(0) }));

    await h.scheduler.tick(0);

    assert.ok(h.spawnCalls.some((s) => s.loopId === 'loop-good'));
  });
});

describe('LoopScheduler — reconcileOnStart (missed-schedule policy)', () => {
  it('skips missed fires (recomputes overdue/missing nextRunAt) and preserves manual overrides', async () => {
    const h = makeHarness();
    const now = 1_000_000;
    h.loops.seed(loopFixture({ id: 'overdue', nextRunAt: iso(now - 500_000) }));
    h.loops.seed(loopFixture({ id: 'future', nextRunAt: iso(now + 500_000) }));
    h.loops.seed(loopFixture({ id: 'missing', nextRunAt: undefined }));
    h.loops.seed(loopFixture({ id: 'manual', nextRunAt: iso(now - 500_000), runNowRequested: true }));

    await h.scheduler.reconcileOnStart(now);

    assert.strictEqual(h.loops.snapshot('overdue').nextRunAt, iso(now + 60_000));
    assert.strictEqual(h.loops.snapshot('future').nextRunAt, iso(now + 500_000)); // untouched
    assert.strictEqual(h.loops.snapshot('missing').nextRunAt, iso(now + 60_000));
    const manual = h.loops.snapshot('manual');
    assert.strictEqual(manual.runNowRequested, true); // survives restart
    assert.strictEqual(manual.nextRunAt, iso(now + 60_000));
  });

  it('skips (does not throw on) a corrupt-cron loop at boot and still reconciles the others', async () => {
    const h = makeHarness();
    const now = 1_000_000;
    h.loops.seed(loopFixture({ id: 'bad', schedule: { kind: 'cron', expression: 'garbage' }, nextRunAt: iso(0) }));
    h.loops.seed(loopFixture({ id: 'good', nextRunAt: iso(0) }));

    await h.scheduler.reconcileOnStart(now); // must not throw

    assert.strictEqual(h.loops.snapshot('good').nextRunAt, iso(now + 60_000));
    // The bad loop is left untouched here; it surfaces as an error on its first fire.
    assert.strictEqual(h.loops.snapshot('bad').nextRunAt, iso(0));
  });
});

describe('LoopScheduler — overlap skip grace window (finalize-then-fire)', () => {
  it('a run-now while the previous run is EXITED-but-in-grace finalizes it, then fires exactly once (no double-fire, no orphan)', async () => {
    const h = makeHarness();
    h.store.sessions.set('prev', runSession('prev', 'loop-1', 0, 'completed'));
    h.store.logs.set('prev', 'PREV-OUT');
    h.loops.seed(
      loopFixture({
        overlapPolicy: 'skip',
        lastStatus: 'running',
        lastSessionId: 'prev',
        lastRunAt: iso(0),
        nextRunAt: iso(60_000), // not due by schedule…
        runNowRequested: true, // …but a manual fire is pending
        postflight: { command: 'post' },
      }),
    );
    // 'prev' is NOT in runner.running (it exited) and we are still inside grace (elapsed 5s < 30s).
    await h.scheduler.tick(5_000);

    // Exactly one new run — the exited prev is not a live overlap, but it IS
    // finalized (postflighted) first so it is never orphaned.
    assert.strictEqual(h.spawnCalls.length, 1);
    const post = h.flightCalls.find((c) => c.command === 'post');
    assert.ok(post, 'the just-exited previous run was finalized + postflighted');
    assert.strictEqual(post!.extraEnv!.FTOWN_RUN_SESSION_ID, 'prev');
    assert.strictEqual(post!.extraEnv!.FTOWN_RUN_STATUS, 'ok');
    const loop = h.loops.snapshot('loop-1');
    assert.strictEqual(loop.lastSessionId, 'run-1');
    assert.strictEqual(loop.lastStatus, 'running');
    assert.strictEqual(loop.runNowRequested, false);
  });
});

describe('LoopScheduler — overlap allow finalizes EVERY run', () => {
  it('finalizes and postflights each concurrent run, not just the newest', async () => {
    const h = makeHarness();
    h.loops.seed(
      loopFixture({
        overlapPolicy: 'allow',
        schedule: { kind: 'interval', everyMs: 60_000 },
        retention: { autoClearAfterRuns: null },
        postflight: { command: 'post' },
      }),
    );

    await h.scheduler.tick(0); // fires run-1
    await h.scheduler.tick(60_000); // run-1 still alive → allow fires run-2 concurrently
    assert.deepStrictEqual(
      h.spawnCalls.map((s) => s.loopId),
      ['loop-1', 'loop-1'],
    );
    assert.strictEqual(h.runner.running.size, 2);

    // Both runs finish; a later tick must finalize BOTH (a postflight for each).
    h.store.sessions.get('run-1')!.status = 'completed';
    h.store.sessions.get('run-2')!.status = 'completed';
    h.runner.running.delete('run-1');
    h.runner.running.delete('run-2');

    await h.scheduler.tick(100_000); // run-2 elapsed 40s ≥ grace; nextRunAt 120s not yet due

    const postSessions = h.flightCalls
      .filter((c) => c.command === 'post')
      .map((c) => c.extraEnv?.FTOWN_RUN_SESSION_ID)
      .sort();
    assert.deepStrictEqual(postSessions, ['run-1', 'run-2'], 'postflight ran for BOTH overlapping runs');
  });
});

describe('LoopScheduler — bad persisted schedule', () => {
  it('reports a corrupt cron as error, publishes it, backs off, and never spawns', async () => {
    const h = makeHarness();
    h.loops.seed(loopFixture({ id: 'bad', schedule: { kind: 'cron', expression: 'garbage' }, nextRunAt: iso(0) }));

    await h.scheduler.tick(0);

    const loop = h.loops.snapshot('bad');
    assert.strictEqual(loop.lastStatus, 'error');
    assert.notStrictEqual(loop.nextRunAt, iso(0)); // advanced (backoff), not stuck overdue
    assert.ok(h.centrifugo.published.some((l) => l.id === 'bad' && l.lastStatus === 'error'));
    assert.strictEqual(h.spawnCalls.length, 0);
  });
});

describe('LoopScheduler — finalize status resolution', () => {
  it('a run that ended in error finalizes the loop to error', async () => {
    const h = makeHarness();
    h.store.sessions.set('run-e', runSession('run-e', 'loop-1', 0, 'error'));
    h.loops.seed(
      loopFixture({ lastStatus: 'running', lastSessionId: 'run-e', lastRunAt: iso(0), nextRunAt: iso(10_000_000) }),
    );
    await h.scheduler.tick(40_000);
    assert.strictEqual(h.loops.snapshot('loop-1').lastStatus, 'error');
  });

  it('a run still marked running at finalize (died without a clean transition) is error, NOT ok', async () => {
    const h = makeHarness();
    // Not in runner.running (process gone), but the store never transitioned it.
    h.store.sessions.set('run-c', runSession('run-c', 'loop-1', 0, 'running'));
    h.loops.seed(
      loopFixture({ lastStatus: 'running', lastSessionId: 'run-c', lastRunAt: iso(0), nextRunAt: iso(10_000_000) }),
    );
    await h.scheduler.tick(40_000);
    assert.strictEqual(h.loops.snapshot('loop-1').lastStatus, 'error');
  });
});

describe('LoopScheduler — flight arg forwarding', () => {
  it('forwards workdir + preflight/postflight timeoutMs as cwd/timeoutMs', async () => {
    const h = makeHarness();
    h.loops.seed(
      loopFixture({
        workdir: '/tmp/wd',
        preflight: { command: 'pre', timeoutMs: 5_000 },
        postflight: { command: 'post', timeoutMs: 7_000 },
        nextRunAt: iso(0),
      }),
    );
    h.flightResults.push({ stdout: '', stderr: '', exitCode: 0 }); // preflight passes

    await h.scheduler.tick(0);
    const pre = h.flightCalls.find((c) => c.command === 'pre');
    assert.strictEqual(pre!.cwd, '/tmp/wd');
    assert.strictEqual(pre!.timeoutMs, 5_000);

    h.store.sessions.get('run-1')!.status = 'completed';
    h.runner.running.delete('run-1');
    await h.scheduler.tick(40_000); // nextRunAt 60s not due → single finalize, one postflight
    const post = h.flightCalls.find((c) => c.command === 'post');
    assert.strictEqual(post!.cwd, '/tmp/wd');
    assert.strictEqual(post!.timeoutMs, 7_000);
  });
});

describe('LoopScheduler — FTOWN_RUN_OUTPUT truncation', () => {
  it('truncates the captured log to the last 64 KiB (tail kept, head dropped)', async () => {
    const h = makeHarness();
    const HEAD = 'HEAD_MARKER';
    const TAIL = 'TAIL_MARKER';
    const big = HEAD + 'x'.repeat(70_000) + TAIL; // > 65536 bytes
    h.store.sessions.set('run-x', runSession('run-x', 'loop-1', 0, 'completed'));
    h.store.logs.set('run-x', big);
    h.loops.seed(
      loopFixture({
        lastStatus: 'running',
        lastSessionId: 'run-x',
        lastRunAt: iso(0),
        nextRunAt: iso(10_000_000),
        postflight: { command: 'post' },
      }),
    );
    await h.scheduler.tick(40_000);
    const out = h.flightCalls.find((c) => c.command === 'post')!.extraEnv!.FTOWN_RUN_OUTPUT;
    assert.ok(Buffer.byteLength(out, 'utf8') <= 65_536);
    assert.ok(out.endsWith(TAIL));
    assert.ok(!out.includes(HEAD));
  });
});

describe('LoopScheduler — retention edge + overlap-skip postflight', () => {
  it('autoClearAfterRuns: 0 prunes every finished run except the still-current one', async () => {
    const h = makeHarness();
    h.store.sessions.set('r2', runSession('r2', 'loop-1', 2000, 'completed'));
    h.store.sessions.set('r1', runSession('r1', 'loop-1', 1000, 'completed'));
    h.loops.seed(
      loopFixture({
        lastStatus: 'running',
        lastSessionId: 'r2',
        lastRunAt: iso(0),
        nextRunAt: iso(10_000_000),
        retention: { autoClearAfterRuns: 0 },
      }),
    );
    await h.scheduler.tick(40_000);
    // keep 0: r2 is protected (== current lastSessionId), r1 pruned.
    assert.deepStrictEqual(h.removed.map((r) => r.id), ['r1']);
  });

  it('the overlap-skip advance-only branch never runs postflight', async () => {
    const h = makeHarness();
    h.runner.running.add('live');
    h.store.sessions.set('live', runSession('live', 'loop-1', 0, 'running'));
    h.loops.seed(
      loopFixture({
        overlapPolicy: 'skip',
        lastStatus: 'running',
        lastSessionId: 'live',
        lastRunAt: iso(0),
        nextRunAt: iso(100),
        postflight: { command: 'post' },
      }),
    );
    await h.scheduler.tick(100);
    assert.strictEqual(h.spawnCalls.length, 0);
    assert.ok(!h.flightCalls.some((c) => c.command === 'post'));
  });
});

describe('LoopScheduler — {{preflight}} substitution', () => {
  it('replaces EVERY {{preflight}} occurrence (replaceAll, not replace)', async () => {
    const h = makeHarness();
    h.loops.seed(loopFixture({ task: 'a {{preflight}} b {{preflight}} c', preflight: { command: 'echo' } }));
    h.flightResults.push({ stdout: 'X', stderr: '', exitCode: 0 });
    await h.scheduler.tick(0);
    assert.strictEqual(h.spawnCalls[0].prompt, 'a X b X c');
  });
});

describe('LoopScheduler — onLoopDeleted', () => {
  it('stops an in-flight run and drops tracking for a deleted loop', async () => {
    const h = makeHarness();
    h.loops.seed(loopFixture());
    await h.scheduler.tick(0); // spawns run-1 (tracked + running)
    assert.ok(h.runner.isRunning('run-1'));
    h.scheduler.onLoopDeleted(h.loops.snapshot('loop-1'));
    assert.ok(h.runner.stopped.includes('run-1'));
    assert.strictEqual(h.runner.isRunning('run-1'), false);
  });
});

describe('LoopScheduler — concurrent RPC isolation (BLOCKER)', () => {
  it('a loop deleted mid-flight is NOT resurrected and its orphan run is reaped', async () => {
    const h = makeHarness();
    let release!: () => void;
    h.setSpawnGate(new Promise<void>((r) => (release = r)));
    h.loops.seed(loopFixture());

    const tick = h.scheduler.tick(0);
    await new Promise((r) => setTimeout(r, 0)); // reach the spawn gate
    h.loops.drop('loop-1'); // delete_loop lands during the flight
    release();
    await tick;

    assert.strictEqual(h.loops.has('loop-1'), false, 'deleted loop is not written back');
    assert.deepStrictEqual(h.removed.map((r) => r.id), ['run-1'], 'orphan run reaped');
  });

  it('a concurrent update_loop pause survives the scheduler write-back', async () => {
    const h = makeHarness();
    let release!: () => void;
    h.setSpawnGate(new Promise<void>((r) => (release = r)));
    h.loops.seed(loopFixture({ enabled: true }));

    const tick = h.scheduler.tick(0);
    await new Promise((r) => setTimeout(r, 0));
    // update_loop {enabled:false} lands on disk while the fire is mid-flight.
    h.loops.mutateLoopRuntime('loop-1', (l) => {
      l.enabled = false;
    });
    release();
    await tick;

    const loop = h.loops.snapshot('loop-1');
    assert.strictEqual(loop.enabled, false, 'the user pause is not clobbered by a stale write-back');
    assert.strictEqual(loop.lastStatus, 'running', 'scheduler runtime fields still applied');
    assert.strictEqual(loop.lastSessionId, 'run-1');
  });
});

describe('runFlightCommand (real child_process)', () => {
  it('captures stdout with a zero exit code', async () => {
    const r = await runFlightCommand('echo hi', undefined, 5_000);
    assert.strictEqual(r.exitCode, 0);
    assert.strictEqual(r.stdout, 'hi\n');
  });

  it('passes a non-zero exit code straight through', async () => {
    const r = await runFlightCommand('exit 7', undefined, 5_000);
    assert.strictEqual(r.exitCode, 7);
  });

  it('kills a command that exceeds its timeout and reports 124', async () => {
    const r = await runFlightCommand('sleep 5', undefined, 200);
    assert.strictEqual(r.exitCode, 124);
  });

  it('merges extraEnv onto the child environment', async () => {
    const r = await runFlightCommand('printf %s "$FTOWN_TEST_VAR"', undefined, 5_000, { FTOWN_TEST_VAR: 'bar' });
    assert.strictEqual(r.stdout, 'bar');
  });

  it('does not hang when the command backgrounds a process that outlives the shell', async () => {
    // The classic exec footgun: sh backgrounds a long sleep (which inherits the
    // stdout pipe) then exits 0. Settling on 'exit' + destroying the pipe means
    // we return promptly instead of wedging until the grandchild dies.
    const r = await runFlightCommand('sleep 5 & echo started', undefined, 3_000);
    assert.strictEqual(r.stdout.trim(), 'started');
    assert.strictEqual(r.exitCode, 0);
  });
});
