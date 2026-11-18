import type { BoardSnapshot } from './coordination/contract-c.js';

/** Small snapshots preserve the existing command response. Larger ones use immutable byte chunks. */
export const SESSION_BOARD_INLINE_BYTES = 300_000;
export const SESSION_BOARD_CHUNK_BYTES = 60_000;
export const SESSION_BOARD_MAX_BYTES = 16 * 1024 * 1024;
/** Combined retained UTF-8 bytes across all principals and snapshots in one cache. */
export const SESSION_BOARD_CACHE_BYTES = 16 * 1024 * 1024;
export const SESSION_BOARD_CACHE_ENTRIES = 4;
export const SESSION_BOARD_CACHE_TTL_MS = 60_000;

export interface SessionBoardBaseRequest {
  bridgeId: string;
  sessionId: string;
}

export interface SessionBoardInitialRequest extends SessionBoardBaseRequest {
  snapshotId?: never;
  offset?: never;
}

export interface SessionBoardChunkRequest extends SessionBoardBaseRequest {
  /** Lowercase SHA-256 hex digest (64 characters) of the immutable UTF-8 snapshot. */
  snapshotId: string;
  offset: number;
}

export type SessionBoardRequest = SessionBoardInitialRequest | SessionBoardChunkRequest;

export interface SessionBoardManifest {
  type: 'session_board_chunks';
  /** Lowercase SHA-256 hex digest, scoped to the authenticated principal, bridge and requested session. */
  snapshotId: string;
  rootId: string;
  totalBytes: number;
  chunkBytes: typeof SESSION_BOARD_CHUNK_BYTES;
}

export interface SessionBoardChunk {
  type: 'session_board_chunk';
  snapshotId: string;
  rootId: string;
  offset: number;
  totalBytes: number;
  /** Standard base64 encoding of at most SESSION_BOARD_CHUNK_BYTES UTF-8 bytes. */
  data: string;
}

export type SessionBoardResponse = BoardSnapshot | SessionBoardManifest | SessionBoardChunk;

export type SessionBoardFailureCode =
  | 'invalid_session_board_request'
  | 'session_board_snapshot_unavailable'
  | 'session_board_snapshot_too_large';

/** Existing command-response error envelope. Unavailable covers missing, expired and mismatched snapshots. */
export interface SessionBoardFailure {
  requestId: string;
  success: false;
  error: string;
  data: { code: SessionBoardFailureCode };
}
