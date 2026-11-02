import type { VerifiedPrincipal } from './security/protocol.js';

/** Browser-only, session-scoped, read-only PR review protocol. */
export const PR_REVIEW_MAX_DIFF_BYTES = 1_048_576;
export const PR_REVIEW_CHUNK_BYTES = 98_304;
export const PR_REVIEW_MAX_TITLE_BYTES = 1024;
export const PR_REVIEW_MAX_BODY_BYTES = 32_768;
export type PrReviewUnavailableReason = 'unlinked' | 'unauthenticated' | 'rate_limited' | 'not_found_or_forbidden' | 'timeout' | 'too_large' | 'unsupported' | 'stale' | 'unavailable';
export interface PrReviewRequest { bridgeId: string; sessionId: string; linkGeneration: string }
export interface PrReviewChunkRequest extends PrReviewRequest { revision: string; offset: number }
export interface PrReviewMetadata {
  url: string;
  title: string;
  body: string;
  author: string;
  state: 'open' | 'closed' | 'merged';
  baseRef: string;
  headRef: string;
  baseOid: string;
  headOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  fetchedAt: string;
}
export type PrReviewResult = { state: 'unavailable'; reason: PrReviewUnavailableReason } | { state: 'ready'; linkGeneration: string; metadata: PrReviewMetadata; revision: string; totalBytes: number };
export type PrReviewChunk = { state: 'stale_revision' } | { state: 'unavailable'; reason: PrReviewUnavailableReason } | { state: 'chunk'; revision: string; totalBytes: number; offset: number; dataBase64: string; done: boolean };

/** All principals are server-provided; consumers never construct them from wire data. */
export interface PrReviewService {
  get(principal: VerifiedPrincipal, request: PrReviewRequest): Promise<PrReviewResult>;
  chunk(principal: VerifiedPrincipal, request: PrReviewChunkRequest): Promise<PrReviewChunk>;
}
