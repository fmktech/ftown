import { createHash } from 'node:crypto';
import type { Session } from './types.js';

export function prReviewGeneration(linkId: string): string {
  return createHash('sha256').update(`ftown-pr-review:${linkId}`, 'utf8').digest('hex');
}

/**
 * Returns a wire-safe shallow copy of a Session with `env` removed.
 *
 * `env` maps a provider token into the session (ANTHROPIC_AUTH_TOKEN /
 * ANTHROPIC_API_KEY) and must NEVER cross the wire — it would leak the token to
 * the browser via Centrifugo publications and HTTP/command response bodies.
 * The server-side store keeps `env` (spawn/resume need it); this strip is only
 * for egress. The input is never mutated.
 */
export function toWireSession(session: Session): Session {
  const { env: _env, previewSource: _previewSource, pullRequestLinkId, pullRequestReviewGeneration: _derived, ...rest } = session;
  return { ...rest, ...(session.pullRequestUrl && pullRequestLinkId ? { pullRequestReviewGeneration: prReviewGeneration(pullRequestLinkId) } : {}) };
}
