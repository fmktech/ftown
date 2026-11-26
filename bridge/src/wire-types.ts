// Shared wire shapes for the in-process CLI runtime and local bridge API.
import { discussionReplyHint } from './project-discussion-protocol.js';

/** Contents of ~/.ftown/bridge.json, pointing a CLI at the running LocalApiServer. */
export interface BridgePointer {
  dataDir?: string;
  ownerId?: string;
  endpoint?: import('./security/protocol.js').EndpointPublic;
  port: number;
  token: string;
  bridgeId?: string;
  /** --solo only: the panel's own front origin (e.g. http://localhost:8040); invitation links are printed on it. */
  soloOrigin?: string;
  pid?: number;
  startedAt?: string;
  harness?: string;
  harnessCli?: string;
}

/**
 * Per-model token breakdown within a session.
 * Mirror of ModelUsage in ./types.ts — keep the two shapes in sync.
 */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Per-session token usage, as returned by GET /api/sessions/:id/usage.
 * Mirror of SessionUsage in ./types.ts — keep the two shapes in sync.
 */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;           // sum of the four
  models: string[];              // distinct, first-appearance order (always present)
  perModel?: ModelUsage[];       // per-model breakdown when attributable (claude); absent for codex totals
  harness: string;               // which extractor produced it
  collectedAt: string;           // ISO
}

/** Session shape as returned by GET /api/sessions and /api/sessions/:id. */
export interface Session {
  id: string;
  bridgeId?: string;
  name: string;
  status: string;
  workingDir?: string;
  shellType?: string;
  model?: string;
  account?: string;
  allowedAccounts?: string[];
  projectName?: string;
  parentBridgeId?: string;
  parentSessionId?: string;
  pullRequestUrl?: string;
  /** Historical automation provenance; new sessions cannot set it. */
  loopId?: string;
  usage?: SessionUsage;
  card?: { state: string; headline: string; progress?: { done: number; total: number }; blockedOn?: { kind: string; ref?: string; text: string }; next?: string; updatedAt: string };
  lastError?: string;
  errorReason?: string;
  exitCode?: number;
  block?: {
    reason: 'usage_limit' | 'rate_limit' | 'auth' | 'crashed' | 'exited';
    resetAt?: string;
    screenTail: string;
    exitCode?: number;
    detectedAt: string;
    transitionKey: string;
    notifiedAt?: string;
  };
}

export type MailType = 'message' | 'task' | 'result' | 'escalation' | 'fyi';
export const MAIL_TYPES: readonly MailType[] = ['message', 'task', 'result', 'escalation', 'fyi'];

/** Per-session inbox message, as returned by GET/POST /api/sessions/:id/inbox. */
export interface MailMessage {
  id: string;
  ts: string;
  from: string;
  fromName?: string;
  to: string;
  type: MailType;
  threadId?: string;
  discussion?: import('./project-discussion-protocol.js').DiscussionMailContext;
  idempotencyKey?: string;
  body: string;
  deliveredAt?: string;
  deliveredVia?: string;
  nudgedAt?: string;
}

export const AUTOMATION_REMOVED_CODE = 'automation_removed' as const;
export const AUTOMATION_REMOVED_MESSAGE = 'Recurring loops and factory automation have been removed';

/**
 * Keystrokes appended after `send`/`keys` text to submit it, keyed by shell type.
 *
 * Historically harness-cli.ts sent ESC+CR ('\x1b\r') for claude/cursor shells, on the
 * theory that Escape clears any TUI autocomplete popup before Enter submits. That is
 * wrong: ESC can also cancel/interrupt the composer itself (e.g. clear the input line
 * or exit a mode) depending on TUI state, so it is not a safe universal prefix. Plain
 * '\r' is what actually submits reliably — this matches local-api-server.ts's
 * submitSuffixFor and create-ftown-session.ts's promptSubmitSuffix, which deliberately
 * send plain '\r' for the same reason.
 */
export function submitSuffix(_shellType?: string): string {
  return '\r';
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Older bridges retained the project UUID in the delivery key but omitted the reply instruction. */
export function legacyDiscussionReplyHint(message: {
  from?: unknown;
  discussion?: unknown;
  threadId?: unknown;
  idempotencyKey?: unknown;
  body?: unknown;
}): string {
  if (message.from !== 'project-discussion' || message.discussion || typeof message.body !== 'string' ||
      typeof message.threadId !== 'string' || !uuid.test(message.threadId) || typeof message.idempotencyKey !== 'string') return '';
  const [kind, projectId, noticeId, extra] = message.idempotencyKey.split(':', 4);
  if (kind !== 'discussion' || extra !== undefined || !uuid.test(projectId) || !uuid.test(noticeId)) return '';
  // An older receiving bridge may discard the structured context on a newer sender's complete notice.
  const existingHome = / --bridge (\S+) --text "your reply"$/.exec(message.body)?.[1];
  if (message.body.endsWith(discussionReplyHint(message.threadId, projectId, existingHome))) return '';
  return discussionReplyHint(message.threadId, projectId);
}

/** Human-readable rendering of a MailMessage. */
export function formatMailMessage(m: MailMessage): string {
  return `[${m.ts}] ${m.fromName ?? m.from} (${m.type}): ${m.body}${legacyDiscussionReplyHint(m)}`;
}
