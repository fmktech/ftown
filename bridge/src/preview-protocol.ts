/** Frozen cross-package session preview contract. No filesystem paths belong in wire metadata. */
export const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
export const PREVIEW_MAX_FILES = 12;
export const PREVIEW_CHUNK_BYTES = 98_304;
export const PREVIEW_POLL_MS = 1_000;
export const PREVIEW_MAX_CONCURRENT_READS = 4;
/**
 * Waiting for a change instead of asking every second. A status request that names the revision the browser already has may add
 * `waitMs`: the bridge then answers as soon as the file changes, or `unchanged` once the wait is over. A bridge that supports this
 * marks its `ready` and `unchanged` answers with `wait: true`; a browser sends `waitMs` only to a bridge that has done so, because
 * an older bridge refuses the unknown field.
 */
export const PREVIEW_WAIT_MS = 20_000;
/** The longest wait a bridge accepts. */
export const PREVIEW_MAX_WAIT_MS = 30_000;
/** How often a held request looks at the file: a local stat, never a read or a network round trip. */
export const PREVIEW_WAIT_CHECK_MS = 250;
/** Held requests per bridge. Beyond this a request is answered at once, as if it had not asked to wait. */
export const PREVIEW_MAX_WAITERS = 16;

export type SessionPreviewKind = 'html' | 'markdown';

export interface SessionPreviewFile {
  id: string;
  fileName: string;
  kind: SessionPreviewKind;
}

export interface SessionPreviewDescriptor {
  id: string;
  files: SessionPreviewFile[];
}

/** Private persistence only; strip this entire field at every session egress. */
export interface SessionPreviewSource {
  version: 2;
  id: string;
  root: string;
  files: { id: string; filePath: string }[];
}

export function previewKindForPath(nameOrPath: string): SessionPreviewKind | null {
  const slash = Math.max(nameOrPath.lastIndexOf('/'), nameOrPath.lastIndexOf('\\'));
  const base = nameOrPath.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  return null;
}

export type PreviewUnavailableReason =
  | 'missing'
  | 'too_large'
  | 'invalid_utf8'
  | 'invalid_file'
  | 'unavailable';

export interface SessionPreviewStatusRequest {
  bridgeId: string;
  sessionId: string;
  previewId: string;
  fileId: string;
  knownRevision?: string;
}

export interface SessionPreviewChunkRequest {
  bridgeId: string;
  sessionId: string;
  previewId: string;
  fileId: string;
  revision: string;
  offset: number;
  encoding?: 'gzip';
}

export interface SessionPreviewUnavailable {
  state: 'unavailable';
  previewId: string;
  fileId: string;
  reason: PreviewUnavailableReason;
}

/** totalBytes and revision always describe the original file. gzipBytes offers an alternate transfer size. */
export type SessionPreviewStatus =
  | { state: 'unregistered' }
  | SessionPreviewUnavailable
  | { state: 'ready' | 'unchanged'; previewId: string; fileId: string; revision: string; totalBytes: number; gzipBytes?: number; wait?: true };

/** Chunk sizes and offsets refer to the requested representation. The revision still identifies the original bytes. */
export type SessionPreviewChunk =
  | { state: 'stale_revision' }
  | SessionPreviewUnavailable
  | {
      state: 'chunk';
      previewId: string;
      fileId: string;
      revision: string;
      totalBytes: number;
      encoding?: 'gzip';
      offset: number;
      dataBase64: string;
      done: boolean;
    };
