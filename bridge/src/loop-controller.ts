import {
  createLoop as createLoopInStore,
  deleteLoop as deleteLoopInStore,
  getLoop as getLoopInStore,
  listLoops as listLoopsInStore,
  mutateLoopRuntime as mutateLoopRuntimeInStore,
  updateLoop as updateLoopInStore,
} from './loop-store.js';
import {
  deleteLoopRunRecords as deleteLoopRunRecordsInStore,
  listLoopRunRecordsWithFallback as listLoopRunRecordsWithFallbackInStore,
} from './loop-run-store.js';
import { validateLoopDraft, validateLoopPatch } from './loop-validation.js';

import type { Loop, LoopDraft, LoopRunRecord, Session } from './types.js';

/**
 * Transport-agnostic loop operations, defined ONCE and shared by the two
 * dispatch surfaces (the Centrifugo RPC switch in index.ts and the local HTTP
 * router in local-api-server.ts). Methods take already-parsed typed input and
 * return typed results/errors; the adapters own all wire concerns (command
 * envelopes, HTTP statuses, response payload shaping).
 *
 * Error-propagation contract (matches the pre-refactor adapters byte for byte):
 * - `create`/`update` catch store/publish failures and return `code: 'failed'`
 *   (the HTTP adapter mapped those to 400).
 * - `delete`/`runNow`/`runs` let unexpected failures THROW (the RPC adapter's
 *   outer catch and the HTTP router's 500 handler mapped those before).
 */

export type LoopErrorCode = 'invalid' | 'not_found' | 'failed';

export interface LoopControllerError {
  ok: false;
  code: LoopErrorCode;
  message: string;
}

export type LoopControllerResult<T> = ({ ok: true } & T) | LoopControllerError;

/** Outcome of a manual fire request. `fired: false` is NOT an error at the
 * controller level — the RPC adapter reports it as a successful response with
 * a reason, while the HTTP adapter maps `not_found` to a 404. */
export type RunLoopNowOutcome =
  | { fired: true; loop: Loop }
  | { fired: false; reason: 'not_found' | 'overlap' };

/** Injectable persistence surface (defaults to the real file-backed module). */
export interface LoopStoreApi {
  createLoop(draft: LoopDraft): Loop;
  getLoop(id: string): Loop | undefined;
  listLoops(): Loop[];
  updateLoop(id: string, patch: Partial<LoopDraft>): Loop | null;
  deleteLoop(id: string): boolean;
  mutateLoopRuntime(id: string, fn: (loop: Loop) => void): Loop | null;
}

export interface LoopRunStoreApi {
  deleteLoopRunRecords(loopId: string): void;
  listLoopRunRecordsWithFallback(
    loopId: string,
    sessions: Session[],
    loadLog?: (sessionId: string) => Promise<string>,
  ): Promise<LoopRunRecord[]>;
}

export interface LoopControllerDeps {
  /** Loops are always owned by the bridge they were created on; every draft's
   * bridgeId is forced to this value. */
  bridgeId: string;
  scheduler: {
    kick(): void;
    onLoopDeleted(loop: Loop): void;
  };
  /** runner.isRunning — used by the run-now overlap guard. */
  isSessionRunning(sessionId: string): boolean;
  publishLoopUpdate(loop: Loop): Promise<void>;
  publishLoopRemoved(loopId: string): Promise<void>;
  /** Wire-safe (env-stripped) session list, for the loop-runs fallback. */
  listWireSessions(): Promise<Session[]>;
  loadTerminalLog(sessionId: string): Promise<string>;
  loopStore?: LoopStoreApi;
  loopRunStore?: LoopRunStoreApi;
}

const defaultLoopStore: LoopStoreApi = {
  createLoop: createLoopInStore,
  getLoop: getLoopInStore,
  listLoops: listLoopsInStore,
  updateLoop: updateLoopInStore,
  deleteLoop: deleteLoopInStore,
  mutateLoopRuntime: mutateLoopRuntimeInStore,
};

const defaultLoopRunStore: LoopRunStoreApi = {
  deleteLoopRunRecords: deleteLoopRunRecordsInStore,
  listLoopRunRecordsWithFallback: listLoopRunRecordsWithFallbackInStore,
};

export class LoopController {
  private readonly deps: LoopControllerDeps;
  private readonly loopStore: LoopStoreApi;
  private readonly loopRunStore: LoopRunStoreApi;

  constructor(deps: LoopControllerDeps) {
    this.deps = deps;
    this.loopStore = deps.loopStore ?? defaultLoopStore;
    this.loopRunStore = deps.loopRunStore ?? defaultLoopRunStore;
  }

  /** Create a loop owned by this bridge. bridgeId is forced to THIS bridge —
   * a loop is always owned by its runner, whatever the caller sent. */
  async create(input: Partial<LoopDraft>): Promise<LoopControllerResult<{ loop: Loop }>> {
    const candidate: Partial<LoopDraft> = { ...input, bridgeId: this.deps.bridgeId };
    const error = validateLoopDraft(candidate);
    if (error) {
      return { ok: false, code: 'invalid', message: error };
    }

    const draft: LoopDraft = {
      name: candidate.name!.trim(),
      bridgeId: this.deps.bridgeId,
      schedule: candidate.schedule!,
      harness: candidate.harness!,
      workdir: candidate.workdir,
      task: candidate.task!,
      model: candidate.model,
      enabled: candidate.enabled!,
      overlapPolicy: candidate.overlapPolicy!,
      retention: candidate.retention!,
      preflight: candidate.preflight,
      postflight: candidate.postflight,
      maxRuntimeMs: candidate.maxRuntimeMs,
      group: candidate.group,
    };

    try {
      const loop = this.loopStore.createLoop(draft);
      await this.deps.publishLoopUpdate(loop);
      return { ok: true, loop };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: 'failed', message };
    }
  }

  list(): Loop[] {
    return this.loopStore.listLoops();
  }

  get(loopId: string): LoopControllerResult<{ loop: Loop }> {
    const loop = this.loopStore.getLoop(loopId);
    if (!loop) {
      return { ok: false, code: 'not_found', message: 'Loop not found' };
    }
    return { ok: true, loop };
  }

  async update(
    loopId: string,
    patch: Partial<LoopDraft>,
  ): Promise<LoopControllerResult<{ loop: Loop }>> {
    const error = validateLoopPatch(patch);
    if (error) {
      return { ok: false, code: 'invalid', message: error };
    }

    try {
      const loop = this.loopStore.updateLoop(loopId, patch);
      if (!loop) {
        return { ok: false, code: 'not_found', message: 'Loop not found' };
      }
      await this.deps.publishLoopUpdate(loop);
      return { ok: true, loop };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: 'failed', message };
    }
  }

  async delete(loopId: string): Promise<{ removed: boolean }> {
    const existingLoop = this.loopStore.getLoop(loopId);
    const removed = this.loopStore.deleteLoop(loopId);
    if (removed) {
      // Stop any in-flight run and drop scheduler tracking so a just-deleted
      // loop never leaves a live AI session with nothing left to finalize/prune it.
      if (existingLoop) this.deps.scheduler.onLoopDeleted(existingLoop);
      this.loopRunStore.deleteLoopRunRecords(loopId);
      await this.deps.publishLoopRemoved(loopId);
    }
    return { removed };
  }

  async runNow(loopId: string): Promise<RunLoopNowOutcome> {
    const loop = this.loopStore.getLoop(loopId);
    if (!loop) {
      return { fired: false, reason: 'not_found' };
    }
    // A skip-policy loop with a live run cannot be manually fired either —
    // report overlap synchronously (the async tick would otherwise swallow it).
    if (
      loop.overlapPolicy === 'skip' &&
      loop.lastStatus === 'running' &&
      loop.lastSessionId &&
      this.deps.isSessionRunning(loop.lastSessionId)
    ) {
      return { fired: false, reason: 'overlap' };
    }
    // Reload-check-write via mutateLoopRuntime: if the loop was deleted
    // between the getLoop() above and this write, this returns null and
    // nothing is written/published — a stale in-memory snapshot must never
    // be upserted back, or a deleted loop resurrects.
    const updated = this.loopStore.mutateLoopRuntime(loopId, (l) => {
      l.runNowRequested = true;
      l.updatedAt = new Date().toISOString();
    });
    if (!updated) {
      return { fired: false, reason: 'not_found' };
    }
    await this.deps.publishLoopUpdate(updated);
    this.deps.scheduler.kick();
    return { fired: true, loop: updated };
  }

  async runs(loopId: string): Promise<LoopRunRecord[]> {
    const sessions = await this.deps.listWireSessions();
    return this.loopRunStore.listLoopRunRecordsWithFallback(loopId, sessions, (sessionId) =>
      this.deps.loadTerminalLog(sessionId),
    );
  }
}
