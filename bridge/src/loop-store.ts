import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import { computeNextRun } from './loop-schedule.js';
import type { Loop, LoopDraft } from './types.js';

/**
 * Atomic persistence for scheduled loops at `<ftown-home>/loops.json`.
 *
 * Clones the session-registry.ts write pattern (mkdir 0o700 -> write PATH.tmp
 * 0o600 -> renameSync) so a crash mid-write never corrupts the live file.
 *
 * The instance home is injected once at bridge startup via
 * `configureLoopStoreHome()` (index.ts passes `resolveFtownHome(dataDir)`): the
 * DEFAULT data dir keeps `$HOME/.ftown`, a non-default `--data-dir` gets its own
 * home so a co-resident bridge's loops.json is never touched. When left
 * unconfigured (unit tests, the default install path) it falls back to
 * `join(homedir(), '.ftown')` resolved at call time, so a test's $HOME override
 * still redirects every read/write — byte-for-byte the old behavior.
 */

interface LoopsFile {
  loops: Loop[];
}

let configuredFtownHome: string | undefined;

/** Inject the instance ".ftown home" once at startup (see module doc). */
export function configureLoopStoreHome(home: string | undefined): void {
  configuredFtownHome = home;
}

function ftownHome(): string {
  return configuredFtownHome ?? join(homedir(), '.ftown');
}

function loopsPath(): string {
  return join(ftownHome(), 'loops.json');
}

/** Tolerant loader: returns { loops: [] } on a missing OR corrupt file. Never throws. */
function loadLoops(): LoopsFile {
  try {
    const path = loopsPath();
    if (!existsSync(path)) return { loops: [] };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LoopsFile>;
    return { loops: Array.isArray(parsed.loops) ? parsed.loops : [] };
  } catch {
    return { loops: [] };
  }
}

function saveLoops(data: LoopsFile): void {
  mkdirSync(ftownHome(), { recursive: true, mode: 0o700 });
  const path = loopsPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path); // atomic
}

/** Trim `group`; blank/whitespace-only collapses to undefined (field absent). */
function normalizeGroup(group: string | undefined): string | undefined {
  const trimmed = group?.trim();
  return trimmed ? trimmed : undefined;
}

export function listLoops(): Loop[] {
  return loadLoops().loops;
}

export function getLoop(id: string): Loop | undefined {
  return loadLoops().loops.find((loop) => loop.id === id);
}

/**
 * Mint a Loop from a client draft: fresh id/timestamps, zeroed counters, and a
 * nextRunAt computed from now — even when created disabled, so re-enabling has a
 * target. Throws (via computeNextRun) on a malformed cron expression.
 */
export function createLoop(draft: LoopDraft): Loop {
  const data = loadLoops();
  const now = new Date();
  const loop: Loop = {
    ...draft,
    id: uuidv4(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    nextRunAt: new Date(computeNextRun(draft.schedule, now.getTime())).toISOString(),
    runCount: 0,
    skipCount: 0,
  };
  const group = normalizeGroup(draft.group);
  if (group) loop.group = group;
  else delete loop.group;
  data.loops.push(loop);
  saveLoops(data);
  return loop;
}

/**
 * Merge `patch` over an existing loop. id + createdAt are immutable; updatedAt is
 * bumped. A schedule change recomputes nextRunAt from now (the old target is
 * stale). Returns null when no loop has that id.
 */
export function updateLoop(id: string, patch: Partial<LoopDraft>): Loop | null {
  const data = loadLoops();
  const index = data.loops.findIndex((loop) => loop.id === id);
  if (index === -1) return null;

  const existing = data.loops[index];
  const updated: Loop = {
    ...existing,
    ...patch,
    id: existing.id,
    // A loop is owned by exactly one bridge (the one it is persisted on); its
    // bridgeId is the RPC routing key. Never let a patch move it — a stray
    // patch.bridgeId would otherwise desync the record from the routing guard.
    bridgeId: existing.bridgeId,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  if (patch.schedule) {
    updated.nextRunAt = new Date(computeNextRun(updated.schedule, Date.now())).toISOString();
  }
  if ('group' in patch) {
    const group = normalizeGroup(patch.group);
    if (group) updated.group = group;
    else delete updated.group;
  }

  data.loops[index] = updated;
  saveLoops(data);
  return updated;
}

export function deleteLoop(id: string): boolean {
  const data = loadLoops();
  const remaining = data.loops.filter((loop) => loop.id !== id);
  if (remaining.length === data.loops.length) return false;
  data.loops = remaining;
  saveLoops(data);
  return true;
}

/** Insert a loop, or replace the existing one with the same id, in place. */
export function upsertLoop(loop: Loop): void {
  const data = loadLoops();
  const index = data.loops.findIndex((existing) => existing.id === loop.id);
  if (index === -1) data.loops.push(loop);
  else data.loops[index] = loop;
  saveLoops(data);
}

/** The scheduler-owned runtime fields a tick is allowed to mutate. Everything
 * else on a Loop (name, schedule, enabled, task, retention, …) is user-owned
 * and edited exclusively through updateLoop. */
export type LoopRuntimeMutator = (loop: Loop) => void;

/**
 * Atomically apply a scheduler-owned mutation: reload the loop FRESH from disk,
 * apply `fn`, then save. Returns the merged loop, or null when the id no longer
 * exists (deleted concurrently) — the caller then skips its publish so a deleted
 * loop is never resurrected.
 *
 * The scheduler holds a detached Loop snapshot across long awaits (a 20s
 * preflight, an in-process spawn). Writing that whole stale snapshot back would
 * (a) resurrect a loop deleted mid-flight and (b) clobber a concurrent
 * update_loop patch to user-owned fields. Because `fn` runs on the
 * freshly-loaded record and touches only runtime fields, both hazards are gone:
 * a delete wins (null), and an unrelated enabled/schedule/task patch survives.
 */
export function mutateLoopRuntime(id: string, fn: LoopRuntimeMutator): Loop | null {
  const data = loadLoops();
  const index = data.loops.findIndex((loop) => loop.id === id);
  if (index === -1) return null;
  const loop = data.loops[index];
  fn(loop);
  data.loops[index] = loop;
  saveLoops(data);
  return loop;
}
