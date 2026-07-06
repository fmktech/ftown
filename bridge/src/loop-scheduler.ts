import { spawn } from 'node:child_process';

import { computeNextRun, isDue } from './loop-schedule.js';
import { renderRawLogToText } from './terminal-manager.js';
import {
  pruneLoopRunRecords,
  recordForSession,
  upsertLoopRunRecord,
} from './loop-run-store.js';
import { listLoops, mutateLoopRuntime, type LoopRuntimeMutator } from './loop-store.js';

import type { CreateFtownSessionInput } from './create-ftown-session.js';
import type { RemoveFtownSessionOptions } from './remove-ftown-session.js';
import type { Loop, LoopRunRecord, Session } from './types.js';

/** Base tick cadence; also the finalize grace so a just-spawned PTY is not mistaken for exited. */
export const LOOP_TICK_INTERVAL_MS = 30_000;

const iso = (ms: number): string => new Date(ms).toISOString();

// ---- Injected collaborators (narrow so unit tests use light fakes) ----

export interface FlightResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Preflight/postflight primitive: promisified child_process.exec (captures exit code + timeout). */
export type RunFlight = (
  command: string,
  cwd: string | undefined,
  timeoutMs?: number,
  extraEnv?: Record<string, string>,
) => Promise<FlightResult>;

/** In-process flight spawn — wraps createFtownSession(sessionDeps, input) in index.ts. */
export type SpawnSession = (input: CreateFtownSessionInput) => Promise<Session>;

/** In-process run removal — wraps removeFtownSession({store,runner,centrifugo,userId}, id, opts) in index.ts. */
export type RemoveSession = (id: string, options?: RemoveFtownSessionOptions) => Promise<Session | null>;

export interface SchedulerStore {
  loadSession(id: string): Promise<Session | null>;
  loadTerminalLog(id: string): Promise<string>;
  listSessions(): Promise<Session[]>;
}

export interface SchedulerRunner {
  isRunning(id: string): boolean;
  stop(id: string): boolean;
}

export interface SchedulerCentrifugo {
  publishLoopUpdate(userId: string, loop: Loop): Promise<void>;
}

export interface LoopStoreApi {
  listLoops(): Loop[];
  /** Fresh-read → mutate scheduler-owned fields → save; null when deleted concurrently. */
  mutateLoopRuntime(id: string, fn: LoopRuntimeMutator): Loop | null;
}

export interface LoopRunRecordStoreApi {
  upsertLoopRunRecord(record: LoopRunRecord): LoopRunRecord;
  pruneLoopRunRecords(loopId: string, keep: number | null, preserveIds?: Iterable<string | undefined>): void;
}

export interface SchedulerDeps {
  store: SchedulerStore;
  runner: SchedulerRunner;
  centrifugo: SchedulerCentrifugo;
  userId: string;
  /** Built in index.ts as (input) => createFtownSession(sessionDeps, input) — the direct in-process call. */
  spawnSession: SpawnSession;
  /** Built in index.ts as (id, opts) => removeFtownSession({store,runner,centrifugo,userId}, id, opts). */
  removeSession: RemoveSession;
  /** Loop persistence. Defaults to the real ~/.ftown/loops.json store. */
  loops?: LoopStoreApi;
  /** Durable loop-run log persistence. Defaults to the real ~/.ftown/loop-runs.json store. */
  runRecords?: LoopRunRecordStoreApi;
  /** Flight runner. Defaults to the exec-based runFlightCommand. */
  runFlight?: RunFlight;
  /** Clock seam. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Runs child_process.exec and normalizes the result to { stdout, stderr,
 * exitCode }. Never rejects — the exit code is the signal (a timeout maps to
 * 124, any other failure to the real exit code or 1).
 *
 * The hard budget is enforced by SIGKILL on the whole process GROUP, NOT by
 * exec's built-in `timeout`. exec's timeout only sends SIGTERM to the spawned
 * `/bin/sh`; a detached grandchild that keeps the stdout pipe open, or a child
 * that traps SIGTERM, would keep the exec callback from ever firing — and since
 * the scheduler awaits every flight inside a single re-entrancy-guarded tick,
 * ONE such flight would wedge the entire scheduler permanently. Spawning
 * `detached` makes the child its own group leader, so `kill(-pid, SIGKILL)`
 * takes down the whole tree and the flight can never exceed its budget.
 */
export function runFlightCommand(
  command: string,
  cwd: string | undefined,
  timeoutMs = 30_000,
  extraEnv?: Record<string, string>,
): Promise<FlightResult> {
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  const MAX_CAPTURE = 1024 * 1024;
  return new Promise<FlightResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let killedByTimeout = false;
    let exitGrace: ReturnType<typeof setTimeout> | undefined;

    // Own process group (detached ⇒ the sh is its own group leader) so the hard
    // timeout can SIGKILL the WHOLE tree, including a grandchild that outlived
    // its parent's SIGTERM or kept the stdout pipe open. This is what stops one
    // runaway flight from wedging the awaiting tick forever.
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: cwd ?? process.cwd(),
      env,
      detached: true,
    });

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(exitGrace);
      // Release the pipe read-ends so a still-open grandchild write-end cannot
      // keep the bridge's event loop (or the test runner) alive after we return.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref?.();
      resolve({ stdout, stderr, exitCode: killedByTimeout ? 124 : (exitCode ?? 1) });
    };
    const recordExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (exitCode === null) exitCode = typeof code === 'number' ? code : signal ? 1 : 0;
    };

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString('utf8');
    });

    child.on('error', () => {
      if (exitCode === null) exitCode = 1;
      settle();
    });
    // Settle on 'exit' (the shell terminated), NOT 'close' (all stdio closed):
    // a backgrounded/detached grandchild keeps the pipe open, so 'close' may
    // never come. 'close' still wins the race when it fires first (full stdout);
    // otherwise a short grace after 'exit' lets the parent's own output flush.
    child.on('exit', (code, signal) => {
      recordExit(code, signal);
      exitGrace = setTimeout(settle, 150);
      exitGrace.unref?.();
    });
    child.on('close', (code, signal) => {
      recordExit(code, signal);
      settle();
    });

    const hardTimer = setTimeout(() => {
      killedByTimeout = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL'); // whole process group
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }
      settle();
    }, timeoutMs);
    hardTimer.unref?.();
  });
}

/** Byte-accurate tail: keep the last `maxBytes` of a (possibly huge) terminal log. */
function truncateTail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return buf.subarray(buf.length - maxBytes).toString('utf8');
}

/**
 * Resolve a finished run to ok/error. ONLY a cleanly `completed` run is 'ok';
 * a missing record (removed/lost) OR a store status still stuck at
 * running/pending at finalize time (the process died without a clean status
 * transition) is a crash ⇒ 'error'. Never reports a crashed run as success.
 */
function resolveRunStatus(run: Session | null): 'ok' | 'error' {
  return run?.status === 'completed' ? 'ok' : 'error';
}

/**
 * The scheduled-loops engine. On each 30s tick it FINALIZES each loop's
 * in-flight run(s) (Phase A) before deciding whether to FIRE a new one
 * (Phase B). All side effects go through injected collaborators so it is
 * unit-testable without a live bridge, real fs or real timers (mirrors
 * workflow-runner.ts).
 *
 * Persistence rule: the scheduler NEVER writes a whole detached Loop back
 * across an await. Every runtime-field change goes through
 * store.mutateLoopRuntime (fresh-read → mutate → save), so a loop deleted or
 * user-edited during a long flight is neither resurrected nor clobbered.
 */
export class LoopScheduler {
  private readonly store: SchedulerStore;
  private readonly runner: SchedulerRunner;
  private readonly centrifugo: SchedulerCentrifugo;
  private readonly userId: string;
  private readonly spawnSession: SpawnSession;
  private readonly removeSession: RemoveSession;
  private readonly loops: LoopStoreApi;
  private readonly runRecords: LoopRunRecordStoreApi;
  private readonly runFlight: RunFlight;
  private readonly now: () => number;

  /** Re-entrancy guard: tick N+1 never overlaps N. */
  private tickRunning = false;
  /** Set once start() runs (after reconcileOnStart). kick() no-ops before this so an
   *  early run_loop_now cannot trigger an un-reconciled tick that stampedes overdue loops. */
  private started = false;
  /** Per-loop in-memory fire lock, shared by tick + run_loop_now/kick. */
  private readonly firingLoops = new Set<string>();
  /** loopId -> (runSessionId -> fire-time ms). Every run THIS process spawned, so under
   *  overlapPolicy:'allow' each concurrent run is finalized/postflighted/maxRuntime-checked
   *  independently — not just the newest. Rebuilt lazily from the persisted primary on restart. */
  private readonly inFlight = new Map<string, Map<string, number>>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: SchedulerDeps) {
    this.store = deps.store;
    this.runner = deps.runner;
    this.centrifugo = deps.centrifugo;
    this.userId = deps.userId;
    this.spawnSession = deps.spawnSession;
    this.removeSession = deps.removeSession;
    this.loops = deps.loops ?? { listLoops, mutateLoopRuntime };
    this.runRecords = deps.runRecords ?? { upsertLoopRunRecord, pruneLoopRunRecords };
    this.runFlight = deps.runFlight ?? runFlightCommand;
    this.now = deps.now ?? ((): number => Date.now());
  }

  start(): void {
    this.started = true;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, LOOP_TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Immediate, guarded, out-of-band tick (used by run_loop_now). No-op until start()
   *  has run, so a kick that races startup cannot fire before reconcileOnStart. */
  kick(): void {
    if (!this.started) return;
    if (!this.tickRunning) void this.tick();
  }

  /** Drop scheduler tracking for a deleted loop and stop any run it left alive, so a
   *  just-deleted loop never leaks a live AI session with nothing left to finalize it. */
  onLoopDeleted(loop: Loop): void {
    const ids = new Set<string>();
    const tracked = this.inFlight.get(loop.id);
    if (tracked) for (const id of tracked.keys()) ids.add(id);
    if (loop.lastStatus === 'running' && loop.lastSessionId) ids.add(loop.lastSessionId);
    for (const id of ids) {
      if (this.runner.isRunning(id)) this.runner.stop(id);
    }
    this.inFlight.delete(loop.id);
  }

  /**
   * Missed-schedule policy, run once before the first tick: for every loop whose
   * nextRunAt is missing or already past, recompute it from now (skip missed
   * occurrences; never stampede overdue loops). runNowRequested is preserved so a
   * manual override survives a restart and still fires on the first tick. A loop
   * with a corrupt persisted schedule is skipped here (logged) and reported as an
   * error on its first fire.
   */
  async reconcileOnStart(now: number = this.now()): Promise<void> {
    for (const loop of this.loops.listLoops()) {
      try {
        const overdue = loop.nextRunAt ? Date.parse(loop.nextRunAt) <= now : true;
        if (!overdue) continue;
        const nextRunMs = computeNextRun(loop.schedule, now); // may throw on a corrupt cron
        await this.persist(loop.id, (l) => {
          l.nextRunAt = iso(nextRunMs);
          l.updatedAt = iso(now);
        });
      } catch (err) {
        console.error(`[LoopScheduler] reconcile failed for loop ${loop.id}:`, err);
      }
    }
  }

  async tick(now: number = this.now()): Promise<void> {
    if (this.tickRunning) return; // tick N+1 never overlaps N
    this.tickRunning = true;
    try {
      for (const loop of this.loops.listLoops()) {
        try {
          await this.processLoop(loop, now);
        } catch (err) {
          // One bad loop must not kill the tick (mirrors resurrectSessions).
          console.error(`[LoopScheduler] loop ${loop.id} failed:`, err);
        }
      }
    } finally {
      this.tickRunning = false;
    }
  }

  private async processLoop(loop: Loop, now: number): Promise<void> {
    await this.finalizePhase(loop, now); // Phase A — finalize before fire
    await this.firePhase(loop, now); // Phase B
  }

  /** Phase A: finalize each in-flight run once its PTY is confirmed gone (past grace)
   *  or over its per-run maxRuntime budget. Under 'allow' this walks every tracked run,
   *  not just the newest, so none is orphaned. */
  private async finalizePhase(loop: Loop, now: number): Promise<void> {
    this.ensureTracked(loop);
    const tracked = this.inFlight.get(loop.id);
    if (!tracked || tracked.size === 0) return;

    // Snapshot: finalizeRun mutates the map while we iterate.
    for (const [runId, startedMs] of [...tracked]) {
      const running = this.runner.isRunning(runId);
      const elapsed = now - startedMs;
      if (running && loop.maxRuntimeMs && elapsed > loop.maxRuntimeMs) {
        this.runner.stop(runId);
        await this.finalizeRun(loop, now, runId, true);
      } else if (!running && elapsed >= LOOP_TICK_INTERVAL_MS) {
        await this.finalizeRun(loop, now, runId, false);
      }
      // else: still running, or still inside the grace window — leave it.
    }
  }

  /** Seed the persisted primary run into in-memory tracking after a restart (when this
   *  process has spawned nothing yet for the loop), so a run left 'running' by a prior
   *  process is still finalized. */
  private ensureTracked(loop: Loop): void {
    if (loop.lastStatus !== 'running' || !loop.lastSessionId) return;
    const existing = this.inFlight.get(loop.id);
    if (existing && existing.size > 0) return; // already tracking this process's run(s)
    const parsed = Date.parse(loop.lastRunAt ?? '');
    const startedMs = Number.isNaN(parsed) ? this.now() : parsed;
    const map = existing ?? new Map<string, number>();
    map.set(loop.lastSessionId, startedMs);
    this.inFlight.set(loop.id, map);
  }

  private track(loopId: string, sessionId: string, startedMs: number): void {
    const map = this.inFlight.get(loopId) ?? new Map<string, number>();
    map.set(sessionId, startedMs);
    this.inFlight.set(loopId, map);
  }

  /** Phase B: fire the loop if due, honoring the per-loop lock and the overlap policy. */
  private async firePhase(loop: Loop, now: number): Promise<void> {
    if (!isDue(loop, now)) return;
    if (this.firingLoops.has(loop.id)) return;

    // A previous run that has EXITED but was not yet finalized (still inside the
    // grace window) must be finalized BEFORE we decide to fire. Otherwise a
    // skip-policy loop double-fires in the grace window (isRunning is already
    // false, so the overlap guard below misses it) and the just-finished run is
    // orphaned — its finalize/postflight never runs.
    if (loop.lastStatus === 'running' && loop.lastSessionId && !this.runner.isRunning(loop.lastSessionId)) {
      await this.finalizeRun(loop, now, loop.lastSessionId, false);
      const fresh = this.loops.listLoops().find((l) => l.id === loop.id);
      if (!fresh) return; // deleted during finalize
      loop = fresh;
    }

    // Overlap guard: a skip-policy loop whose previous run is STILL alive advances
    // its schedule only — no new fire, no skipCount bump (overlap-skip is not a
    // preflight-skip).
    if (
      loop.overlapPolicy === 'skip' &&
      loop.lastStatus === 'running' &&
      loop.lastSessionId &&
      this.runner.isRunning(loop.lastSessionId)
    ) {
      await this.persist(loop.id, (l) => {
        try {
          l.nextRunAt = iso(computeNextRun(l.schedule, now));
        } catch {
          /* corrupt schedule surfaces as an error on the fire path, not here */
        }
        l.runNowRequested = false;
        l.updatedAt = iso(now);
      });
      return;
    }

    this.firingLoops.add(loop.id);
    try {
      await this.fireLoop(loop, now);
    } finally {
      this.firingLoops.delete(loop.id);
    }
  }

  /** Advance the schedule up front (so failures/skips never stampede), then preflight → flight. */
  private async fireLoop(loop: Loop, now: number): Promise<void> {
    // Compute the next fire first so a persisted-corrupt schedule is reported as an
    // error (with a bounded backoff) instead of silently re-throwing every tick.
    let nextRunMs: number;
    try {
      nextRunMs = computeNextRun(loop.schedule, now);
    } catch (err) {
      await this.persist(loop.id, (l) => {
        l.lastRunAt = iso(now);
        l.nextRunAt = iso(now + LOOP_TICK_INTERVAL_MS); // bounded backoff — no stampede
        l.runNowRequested = false;
        l.lastStatus = 'error';
        l.updatedAt = iso(now);
      });
      console.error(`[LoopScheduler] bad schedule for loop ${loop.id}:`, err);
      return;
    }

    try {
      let preflightOut = '';
      if (loop.preflight) {
        const r = await this.runFlight(loop.preflight.command, loop.workdir, loop.preflight.timeoutMs);
        preflightOut = r.stdout;
        if (r.exitCode !== 0) {
          const skippedAt = iso(now);
          const reasonSource = r.stderr.trim() || r.stdout.trim();
          const reasonFull = `Preflight exited with code ${r.exitCode}.${reasonSource ? ` ${reasonSource}` : ''}`;
          const reason = reasonFull.length > 512 ? `${reasonFull.slice(0, 511)}…` : reasonFull;
          // ABORT: skip (not error), no session, no run-node.
          const skipped = await this.persist(loop.id, (l) => {
            l.lastRunAt = skippedAt;
            l.nextRunAt = iso(nextRunMs);
            l.runNowRequested = false;
            l.lastStatus = 'skipped';
            l.skipCount += 1;
            l.lastSkipAt = skippedAt;
            l.lastSkipReason = reason;
            l.updatedAt = skippedAt;
          });
          if (skipped && loop.postflight?.runOnSkip) {
            await this.runPostflight(loop, { status: 'skipped', sessionId: '', output: '' });
          }
          return;
        }
      }

      const task = loop.task.replaceAll('{{preflight}}', preflightOut);
      const spawnInput: CreateFtownSessionInput = {
        shellType: loop.harness,
        prompt: task,
        workingDir: loop.workdir,
        model: loop.model,
        env: preflightOut ? { FTOWN_PREFLIGHT_OUTPUT: preflightOut } : undefined,
        loopId: loop.id,
        suppressBriefing: true, // no child/orchestrator briefing paragraph in the task
        name: `${loop.name} · ${iso(now)}`,
        // parentSessionId intentionally omitted — loopId is the sole grouping key.
      };
      if (loop.harness === 'shell') {
        // Loop shell runs are one-shot jobs, not interactive terminals. Persist
        // the task as prompt metadata, but execute it as the command and suppress
        // typed injection so the shell exits when the job is done.
        spawnInput.command = task;
        spawnInput.initialInput = '';
      }

      const session = await this.spawnSession(spawnInput);

      const updated = await this.persist(loop.id, (l) => {
        l.lastRunAt = iso(now);
        l.nextRunAt = iso(nextRunMs);
        l.runNowRequested = false;
        l.lastSessionId = session.id;
        l.lastStatus = 'running';
        l.runCount += 1;
        l.updatedAt = iso(now);
      });

      if (!updated) {
        // The loop was deleted during preflight/spawn: do not resurrect it and do
        // not leave an orphan run that nothing would ever finalize or prune.
        this.runner.stop(session.id);
        await this.removeSession(session.id).catch(() => undefined);
        return;
      }
      this.runRecords.upsertLoopRunRecord(recordForSession(updated, session, iso(now)));
      this.track(loop.id, session.id, now);
    } catch (err) {
      // A failure after the schedule was computed: record error + persist so the
      // loop resumes its cadence instead of stampede-retrying every tick.
      await this.persist(loop.id, (l) => {
        l.lastRunAt = iso(now);
        l.nextRunAt = iso(nextRunMs);
        l.runNowRequested = false;
        l.lastStatus = 'error';
        l.updatedAt = iso(now);
      });
      console.error(`[LoopScheduler] fire failed for loop ${loop.id}:`, err);
    }
  }

  /** Resolve one finished run to ok/error, update the loop badge (only if this is the
   *  loop's tracked/latest run), then run postflight + retention for it. */
  private async finalizeRun(loop: Loop, now: number, runId: string, forcedError: boolean): Promise<void> {
    const tracked = this.inFlight.get(loop.id);
    const startedMs = tracked?.get(runId) ?? Date.parse(loop.lastRunAt ?? iso(now));
    if (tracked) {
      tracked.delete(runId);
      if (tracked.size === 0) this.inFlight.delete(loop.id);
    }

    const run = runId ? await this.store.loadSession(runId) : null;
    const status: 'ok' | 'error' = forcedError ? 'error' : resolveRunStatus(run);
    const rawOutput = runId ? await this.store.loadTerminalLog(runId) : '';
    // The pty log is raw terminal traffic (repaints, cursor moves, erase codes);
    // replay it through a headless terminal so we persist what the screen showed.
    const fullOutput = await renderRawLogToText(rawOutput);
    const output = truncateTail(fullOutput, 65_536);
    const outputBytes = Buffer.byteLength(fullOutput, 'utf8');
    const tailBytes = Buffer.byteLength(output, 'utf8');

    // Only the loop's most-recently-STARTED run (lastSessionId) drives the badge;
    // an older overlapping 'allow' run finalizes silently (still postflight +
    // retention) without flipping the badge away from a newer run's state.
    const updated = await this.persist(loop.id, (l) => {
      if (l.lastSessionId === runId) l.lastStatus = status;
      l.updatedAt = iso(now);
    });
    void updated;

    const baseRecord = run
      ? recordForSession(loop, run, Number.isFinite(startedMs) ? iso(startedMs) : run.createdAt)
      : {
          id: runId,
          loopId: loop.id,
          bridgeId: loop.bridgeId,
          sessionId: runId,
          name: `${loop.name} · ${runId}`,
          status,
          startedAt: Number.isFinite(startedMs) ? iso(startedMs) : iso(now),
          updatedAt: iso(now),
          harness: loop.harness,
          workdir: loop.workdir,
          task: loop.task,
          model: loop.model,
          sessionStatus: undefined,
        };
    this.runRecords.upsertLoopRunRecord({
      ...baseRecord,
      status,
      sessionStatus: run?.status,
      errorReason: forcedError ? 'max_runtime_exceeded' : run?.errorReason,
      updatedAt: iso(now),
      finishedAt: iso(now),
      durationMs: Math.max(0, now - (Number.isFinite(startedMs) ? startedMs : now)),
      logTail: output,
      logBytes: outputBytes,
      logTruncated: outputBytes > tailBytes,
    });

    if (loop.postflight) {
      await this.runPostflight(loop, { status, sessionId: runId, output });
    }
    await this.pruneRuns(loop);
  }

  private async runPostflight(
    loop: Loop,
    ctx: { status: 'ok' | 'error' | 'skipped'; sessionId: string; output: string },
  ): Promise<void> {
    if (!loop.postflight) return;
    await this.runFlight(loop.postflight.command, loop.workdir, loop.postflight.timeoutMs, {
      FTOWN_RUN_STATUS: ctx.status,
      FTOWN_RUN_SESSION_ID: ctx.sessionId,
      FTOWN_RUN_OUTPUT: ctx.output,
    });
  }

  /** Keep the newest N run-sessions for this loop; prune older finished ones. */
  private async pruneRuns(loop: Loop): Promise<void> {
    const keep = loop.retention.autoClearAfterRuns;
    if (keep == null) return;

    const runs = (await this.store.listSessions())
      .filter((s) => s.loopId === loop.id)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    for (const run of runs.slice(keep)) {
      if (this.runner.isRunning(run.id)) continue;
      if (run.id === loop.lastSessionId) continue;
      await this.removeSession(run.id, { onlyIfFinished: true });
    }
    this.runRecords.pruneLoopRunRecords(loop.id, keep, [loop.lastSessionId, ...runs.filter((run) => this.runner.isRunning(run.id)).map((run) => run.id)]);
  }

  private async persist(id: string, fn: LoopRuntimeMutator): Promise<Loop | null> {
    const updated = this.loops.mutateLoopRuntime(id, fn);
    if (updated) await this.publish(updated);
    return updated;
  }

  private async publish(loop: Loop): Promise<void> {
    try {
      await this.centrifugo.publishLoopUpdate(this.userId, loop);
    } catch (err) {
      // A UI-sync failure must never break the scheduler (matches session create).
      console.error(`[LoopScheduler] Failed to publish loop update for ${loop.id}:`, err);
    }
  }
}
