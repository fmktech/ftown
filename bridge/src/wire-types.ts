// No imports beyond Node builtins — this file must stay dependency-free so compiled
// sibling copies work standalone when this file is copied alongside harness-cli.js
// and ftown-sessions-cli.js into ~/.ftown (see harness-installer.ts / install-ftown-cli.ts).
//
// This module holds the wire shapes shared by the standalone CLIs (harness-cli.ts,
// ftown-sessions-cli.ts) that talk to LocalApiServer over ~/.ftown/bridge.json. These
// are the shapes as seen over the wire by those CLIs — not necessarily identical to the
// richer internal types in ./types.ts.

/** Contents of ~/.ftown/bridge.json, pointing a CLI at the running LocalApiServer. */
export interface BridgePointer {
  port: number;
  token: string;
  bridgeId?: string;
  pid?: number;
  startedAt?: string;
  harness?: string;
  harnessCli?: string;
}

/**
 * Per-session token/cost usage, as returned by GET /api/sessions/:id/usage.
 * Mirror of SessionUsage in ./types.ts — keep the two shapes in sync.
 */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;           // sum of the four
  models: string[];              // distinct, order of first appearance
  costUsd?: number;              // omitted when any model lacks pricing
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

export type LoopHarness = 'claude' | 'cursor' | 'codex' | 'grok' | 'opencode' | 'shell';

export type LoopSchedule =
  | { kind: 'interval'; everyMs: number }
  | { kind: 'cron'; expression: string; tz?: string };

/** Body for POST /api/loops and PATCH /api/loops/:id (as a Partial). */
export interface LoopDraft {
  name: string;
  schedule: LoopSchedule;
  harness: LoopHarness;
  workdir?: string;
  task: string;
  model?: string;
  enabled: boolean;
  overlapPolicy: 'skip' | 'allow';
  retention: { autoClearAfterRuns: number | null };
  preflight?: { command: string; timeoutMs?: number };
  postflight?: { command: string; timeoutMs?: number; runOnSkip?: boolean };
  maxRuntimeMs?: number;
  group?: string;
}

/** Loop shape as returned by GET /api/loops and /api/loops/:id. */
export interface LoopInfo extends LoopDraft {
  id: string;
  bridgeId: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastStatus?: 'ok' | 'error' | 'running' | 'skipped';
  lastSessionId?: string;
  runCount: number;
  skipCount: number;
  runNowRequested?: boolean;
}

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
