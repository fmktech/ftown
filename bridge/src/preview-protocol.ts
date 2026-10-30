/** Frozen cross-package session preview contract. No filesystem paths belong in wire metadata. */
export const PREVIEW_MAX_BYTES = 1_048_576;
export const PREVIEW_CHUNK_BYTES = 98_304;
export const PREVIEW_POLL_MS = 1_000;
export const PREVIEW_MAX_CONCURRENT_READS = 4;

export interface SessionPreviewDescriptor {
  id: string;
  fileName: string;
}

/** Private persistence only; strip this entire field at every session egress. */
export interface SessionPreviewSource {
  version: 1;
  id: string;
  root: string;
  filePath: string;
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
  knownRevision?: string;
}

export interface SessionPreviewChunkRequest {
  bridgeId: string;
  sessionId: string;
  previewId: string;
  revision: string;
  offset: number;
}

export interface SessionPreviewUnavailable {
  state: 'unavailable';
  previewId: string;
  reason: PreviewUnavailableReason;
}

export type SessionPreviewStatus =
  | { state: 'unregistered' }
  | SessionPreviewUnavailable
  | { state: 'ready' | 'unchanged'; previewId: string; revision: string; totalBytes: number };

export type SessionPreviewChunk =
  | { state: 'stale_revision' }
  | SessionPreviewUnavailable
  | {
      state: 'chunk';
      previewId: string;
      revision: string;
      totalBytes: number;
      offset: number;
      dataBase64: string;
      done: boolean;
    };
