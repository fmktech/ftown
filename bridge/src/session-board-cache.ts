import { createHash } from 'node:crypto';
import type { BoardSnapshot } from './coordination/contract-c.js';
import {
  SESSION_BOARD_CACHE_BYTES, SESSION_BOARD_CACHE_ENTRIES, SESSION_BOARD_CACHE_TTL_MS,
  SESSION_BOARD_CHUNK_BYTES, SESSION_BOARD_INLINE_BYTES, SESSION_BOARD_MAX_BYTES,
  type SessionBoardChunk, type SessionBoardFailureCode, type SessionBoardManifest,
} from './session-board-protocol.js';

export class SessionBoardRequestError extends Error {
  constructor(readonly code: SessionBoardFailureCode, readonly status: 400 | 404 | 413) {
    super(code === 'invalid_session_board_request' ? 'Invalid board request'
      : code === 'session_board_snapshot_too_large' ? 'Board snapshot is too large'
      : 'Board snapshot is no longer available');
    this.name = 'SessionBoardRequestError';
  }
}

interface Snapshot { bytes: Buffer; rootId: string; expiresAt: number }

/** Immutable snapshots. Scope is supplied only after live owner/read checks at the RPC boundary. */
export function createSessionBoardCache(now: () => number = Date.now) {
  const entries = new Map<string, Snapshot>();
  let retainedBytes = 0;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let scheduledExpiry: number | undefined;
  const remove = (key: string): void => {
    const previous = entries.get(key);
    if (previous) retainedBytes -= previous.bytes.length;
    entries.delete(key);
  };
  const sweep = (): void => {
    for (const [key, value] of entries) if (now() >= value.expiresAt) remove(key);
  };
  const scheduleExpiry = (): void => {
    const next = entries.size ? Math.min(...Array.from(entries.values(), entry => entry.expiresAt)) : undefined;
    if (expiry && next === scheduledExpiry) return;
    if (expiry) clearTimeout(expiry);
    expiry = undefined; scheduledExpiry = next;
    if (next === undefined) return;
    expiry = setTimeout(() => {
      expiry = undefined; scheduledExpiry = undefined;
      sweep(); scheduleExpiry();
    }, Math.max(1, next - now()));
    expiry.unref?.();
  };
  const key = (scope: string, snapshotId: string): string => JSON.stringify([scope, snapshotId]);
  return {
    /** Resource accounting; inspecting it never extends retention or performs a sweep. */
    get size() { return entries.size; },
    get retainedBytes() { return retainedBytes; },
    store(scope: string, snapshot: BoardSnapshot): BoardSnapshot | SessionBoardManifest {
      const bytes = Buffer.from(JSON.stringify(snapshot), 'utf8');
      if (bytes.length > SESSION_BOARD_MAX_BYTES) throw new SessionBoardRequestError('session_board_snapshot_too_large', 413);
      if (bytes.length <= SESSION_BOARD_INLINE_BYTES) return snapshot;
      sweep();
      const snapshotId = createHash('sha256').update(bytes).digest('hex');
      const cacheKey = key(scope, snapshotId);
      remove(cacheKey);
      while (entries.size >= SESSION_BOARD_CACHE_ENTRIES || retainedBytes + bytes.length > SESSION_BOARD_CACHE_BYTES) {
        remove(entries.keys().next().value!);
      }
      entries.set(cacheKey, { bytes, rootId: snapshot.board.rootId, expiresAt: now() + SESSION_BOARD_CACHE_TTL_MS });
      retainedBytes += bytes.length;
      scheduleExpiry();
      return { type: 'session_board_chunks', snapshotId, rootId: snapshot.board.rootId, totalBytes: bytes.length, chunkBytes: SESSION_BOARD_CHUNK_BYTES };
    },
    chunk(scope: string, snapshotId: string, offset: number): SessionBoardChunk {
      if (!/^[a-f0-9]{64}$/.test(snapshotId) || !Number.isSafeInteger(offset) || offset < 0 || offset % SESSION_BOARD_CHUNK_BYTES !== 0) {
        throw new SessionBoardRequestError('invalid_session_board_request', 400);
      }
      sweep();
      scheduleExpiry();
      const snapshot = entries.get(key(scope, snapshotId));
      if (!snapshot || offset >= snapshot.bytes.length) throw new SessionBoardRequestError('session_board_snapshot_unavailable', 404);
      return { type: 'session_board_chunk', snapshotId, rootId: snapshot.rootId, offset, totalBytes: snapshot.bytes.length,
        data: snapshot.bytes.subarray(offset, offset + SESSION_BOARD_CHUNK_BYTES).toString('base64') };
    },
  };
}
