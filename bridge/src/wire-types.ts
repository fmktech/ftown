// Shared wire shapes for the in-process CLI runtime and local bridge API.

/** Contents of ~/.ftown/bridge.json, pointing a CLI at the running LocalApiServer. */
export interface BridgePointer {
  dataDir?: string;
  ownerId?: string;
  endpoint?: import('./security/protocol.js').EndpointPublic;
  port: number;
  token: string;
  bridgeId?: string;
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
  name: string;
  status: string;
  workingDir?: string;
  shellType?: string;
  model?: string;
  parentSessionId?: string;
  pullRequestUrl?: string;
  /** Historical automation provenance; new sessions cannot set it. */
  loopId?: string;
  usage?: SessionUsage;
}

export type MailType = 'message' | 'task' | 'result' | 'escalation';
export const MAIL_TYPES: readonly MailType[] = ['message', 'task', 'result', 'escalation'];

/** Per-session inbox message, as returned by GET/POST /api/sessions/:id/inbox. */
export interface MailMessage {
  id: string;
  ts: string;
  from: string;
  fromName?: string;
  to: string;
  type: MailType;
  threadId?: string;
  body: string;
  deliveredAt?: string;
  deliveredVia?: string;
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

/** Human-readable one-line rendering of a MailMessage. */
export function formatMailMessage(m: MailMessage): string {
  return `[${m.ts}] ${m.fromName ?? m.from} (${m.type}): ${m.body}`;
}
