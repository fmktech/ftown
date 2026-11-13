/** Frozen cross-package session preview contract. No filesystem paths belong in wire metadata. */
export const PREVIEW_MAX_BYTES = 1_048_576;
export const PREVIEW_MAX_FILES = 12;
export const PREVIEW_CHUNK_BYTES = 98_304;
export const PREVIEW_POLL_MS = 1_000;
export const PREVIEW_MAX_CONCURRENT_READS = 4;

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
}

export interface SessionPreviewUnavailable {
  state: 'unavailable';
  previewId: string;
  fileId: string;
  reason: PreviewUnavailableReason;
}

export type SessionPreviewStatus =
  | { state: 'unregistered' }
  | SessionPreviewUnavailable
  | { state: 'ready' | 'unchanged'; previewId: string; fileId: string; revision: string; totalBytes: number };

export type SessionPreviewChunk =
  | { state: 'stale_revision' }
  | SessionPreviewUnavailable
  | {
      state: 'chunk';
      previewId: string;
      fileId: string;
      revision: string;
      totalBytes: number;
      offset: number;
      dataBase64: string;
      done: boolean;
    };
