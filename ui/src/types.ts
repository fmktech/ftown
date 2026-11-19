import type { PreviewChatListRequest, PreviewChatWriteRequest } from '../../bridge/src/preview-chat-protocol';
import type { SessionPreviewDescriptor, SessionPreviewStatusRequest, SessionPreviewChunkRequest } from '../../bridge/src/preview-protocol';

export type SessionStatus = 'pending' | 'running' | 'completed' | 'error' | 'disconnected';

export type BlockReason = 'usage_limit' | 'rate_limit' | 'auth' | 'crashed' | 'exited';

export interface SessionBlock {
  reason: BlockReason;
  resetAt?: string;
  screenTail: string;
  exitCode?: number;
  detectedAt: string;
  transitionKey: string;
  notifiedAt?: string;
}

const BLOCK_REASONS = new Set<BlockReason>(['usage_limit', 'rate_limit', 'auth', 'crashed', 'exited']);

/** Keep a well-formed block. Anything else is dropped rather than rejecting the session. */
export function parseSessionBlock(value: unknown): SessionBlock | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.reason !== 'string' || !BLOCK_REASONS.has(row.reason as BlockReason)) return undefined;
  if (typeof row.screenTail !== 'string' || typeof row.detectedAt !== 'string' || !row.detectedAt) return undefined;
  if (typeof row.transitionKey !== 'string' || !row.transitionKey) return undefined;
  const block: SessionBlock = {
    reason: row.reason as BlockReason,
    screenTail: row.screenTail,
    detectedAt: row.detectedAt,
    transitionKey: row.transitionKey,
  };
  if (typeof row.resetAt === 'string' && row.resetAt) block.resetAt = row.resetAt;
  if (typeof row.exitCode === 'number' && Number.isFinite(row.exitCode)) block.exitCode = row.exitCode;
  if (typeof row.notifiedAt === 'string' && row.notifiedAt) block.notifiedAt = row.notifiedAt;
  return block;
}

export type ShellType = 'claude' | 'cursor' | 'codex' | 'shell' | 'zai' | 'kimi' | 'opencode' | 'deepseek' | 'fireworks' | 'grok' | 'pi' | 'kimi-code' | 'muse' | 'antigravity';

export type AccountHarness = 'claude' | 'codex';
export interface HarnessAccount { id: string; harness: AccountHarness; label?: string; configDir: string }
export interface AccountsFile { version: 1; accounts: HarnessAccount[] }
/** Read-only account metadata returned by get_accounts; paths stay on the bridge. */
export type HarnessAccountSummary = Omit<HarnessAccount, 'configDir'> & { isDefault: boolean };

export interface Session {
  id: string;
  name: string;
  prompt?: string;
  status: SessionStatus;
  bridgeId: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  workingDir?: string;
  shellType?: ShellType;
  account?: string;
  allowedAccounts?: string[];
  claudeSessionId?: string;
  cursorSessionId?: string;
  codexSessionId?: string;
  piSessionId?: string;
  piSessionFile?: string;
  opencodeSessionId?: string;
  museSessionId?: string;
  grokSessionId?: string;
  antigravitySessionId?: string;
  command?: string;
  parentSessionId?: string;
  requireGreenPr?: boolean;
  pullRequestUrl?: string;
  pullRequestReviewGeneration?: string;
  runtime?: 'tmux' | 'direct';
  loopId?: string; // Read-only provenance on sessions created by retired recurring automation.
  usage?: SessionUsage;
  preview?: SessionPreviewDescriptor;
  card?: SessionCard;
  brief?: { text?: string; notes: { ts: string; text: string }[]; updatedAt: string };
  plan?: { seq: number; items: Array<{ id: string; title: string; note?: string; after: string[]; priority: 1 | 2 | 3; state: 'todo' | 'started' | 'done' | 'dropped'; sessionId?: string; createdAt: string; updatedAt: string }> };
  worktree?: { repoRoot: string; path: string; branch: string; base: string; createdByBridge: true; retained?: { reason: string; at: string } };
  lastError?: string;
  exitCode?: number;
  block?: SessionBlock;
}

/** Mirrors bridge SessionCardDeclared (bridge/src/coordination/contract.ts). */
export interface SessionCard {
  state: 'working' | 'blocked' | 'waiting_review' | 'done' | 'failed';
  headline: string;
  progress?: { done: number; total: number };
  blockedOn?: { kind: 'human' | 'parent' | 'session' | 'external'; ref?: string; text: string };
  next?: string;
  updatedAt: string;
}

/** Per-model token breakdown within a session's usage. */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Persisted per-session usage totals, recorded by the bridge on session completion/update. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  models: string[];
  perModel?: ModelUsage[];
  harness: string;
  collectedAt: string; // ISO
}

export type SessionMessageType = 'assistant' | 'user' | 'system' | 'tool_use' | 'tool_result';

export interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  content_block?: {
    type: string;
    text?: string;
    name?: string;
    id?: string;
    input?: Record<string, unknown>;
  };
  delta?: {
    type: string;
    text?: string;
    partial_json?: string;
  };
  index?: number;
  message?: {
    id: string;
    role: string;
    model: string;
    stop_reason?: string;
  };
  tool_name?: string;
  result?: string;
  duration_ms?: number;
  cost_usd?: number;
  session_id?: string;
  description?: string;
  last_tool_name?: string;
  model?: string;
  [key: string]: unknown;
}

export interface SessionMessage {
  sessionId: string;
  type: SessionMessageType;
  content: string;
  timestamp: string;
  toolName?: string;
  raw?: ClaudeStreamEvent;
}

import type { GetBridgeUpdatePayload, UpdateBridgePayload } from '../../bridge/src/update-protocol';
import type { GetPullRequestStatusesPayload } from '../../bridge/src/pull-request-status-protocol';
import type { SendSessionMessagePayload } from '../../bridge/src/session-inbox-protocol';
export type { SendSessionMessagePayload, SessionMessageAccepted, SessionMessageErrorCode } from '../../bridge/src/session-inbox-protocol';
import type { AnswerSessionAttentionPayload, AttentionAnswerDelivery, AttentionPrompt } from '../../bridge/src/attention-prompt-protocol';
export type { AnswerSessionAttentionPayload } from '../../bridge/src/attention-prompt-protocol';

export type CommandType =
  | 'get_accounts'
  | 'preview_chat_list' | 'preview_chat_send' | 'preview_chat_reply'
  | 'session_preview_status' | 'session_preview_chunk'
  | 'get_bridge_update' | 'get_direct_address' | 'update_bridge' | 'get_pull_request_statuses' | 'get_pull_request_review' | 'get_pull_request_review_chunk'
  | 'get_model_routing' | 'set_model_routing'
  | 'get_session_attention' | 'resolve_session_attention' | 'answer_session_attention' | 'get_session_board' | 'send_message'
  | 'create_session' | 'stop_session' | 'list_sessions' | 'get_history'
  | 'dismiss_session_block' | 'retry_session' | 'handoff_session' | 'rename_session' | 'remove_session' | 'bridge_exec'
  | 'list_native_sessions'
  | 'update_session_parent'
  | 'get_session_usage' | 'get_sessions_usage' | 'get_attention_summary';

export interface Command {
  type: CommandType;
  payload: CommandPayload;
  requestId: string;
}

export interface GetSessionAttentionPayload { bridgeId: string; sessionId: string }
export interface GetAttentionSummaryPayload { bridgeId: string; sessionIds: string[] }
export interface ResolveSessionAttentionPayload extends GetSessionAttentionPayload { eventId: string }
export interface PersistedSessionAttention {
  id: string; sequence: number; type: 'agent_needs_input' | 'ask_user'; title: string; message: string; createdAt: string;
  prompt?: AttentionPrompt;
  /** Parent-first routing (coordination phase B). */
  route?: 'parent' | 'human'; routedTo?: string; escalatedAt?: string; escalationNote?: string;
  answeredBy?: { kind: 'human' | 'session'; sessionId?: string; name?: string };
}
export interface SessionAttentionResponse { sessionId: string; attention: PersistedSessionAttention | null; sequence: number }
export type AnswerSessionAttentionResponse = SessionAttentionResponse & { delivery: AttentionAnswerDelivery };

export interface CreateSessionPayload {
  command?: string;
  prompt: string;
  name?: string;
  model?: string;
  workingDir?: string;
  bridgeId?: string;
  shellType?: ShellType;
  account?: string;
  allowedAccounts?: string[];
  claudeSessionId?: string;
  cursorSessionId?: string;
  codexSessionId?: string;
  piSessionId?: string;
  piSessionFile?: string;
  opencodeSessionId?: string;
  museSessionId?: string;
  grokSessionId?: string;
  antigravitySessionId?: string;
  env?: Record<string, string>;
  initialInput?: string;
  initialInputDelay?: number;
  parentSessionId?: string;
  createMissingWorkingDir?: boolean;
}

export interface StopSessionPayload {
  sessionId: string;
}

export interface GetHistoryPayload {
  sessionId: string;
}

export interface RenameSessionPayload {
  sessionId: string;
  name: string;
}

export interface UpdateSessionParentPayload {
  sessionId: string;
  parentSessionId: string | null;
}

export interface RemoveSessionPayload {
  sessionId: string;
  /** Only remove if the session is completed/error (bulk-clear race guard). */
  onlyIfFinished?: boolean;
}

export interface HandoffSessionPayload {
  sessionId: string;
  shellType?: ShellType;
  model?: string;
  name?: string;
}

export interface GetSessionUsagePayload {
  sessionId: string;
  bridgeId?: string;
}

export interface GetSessionsUsagePayload {
  sessionIds: string[];
  bridgeId?: string;
}

export interface BridgeExecPayload {
  command: string;
  workingDir?: string;
  timeout?: number;
  bridgeId?: string;
}

export type CommandPayload = PreviewChatListRequest | PreviewChatWriteRequest | SendSessionMessagePayload | GetPullRequestStatusesPayload | SessionPreviewStatusRequest | SessionPreviewChunkRequest | GetBridgeUpdatePayload | UpdateBridgePayload | GetSessionAttentionPayload | GetAttentionSummaryPayload | ResolveSessionAttentionPayload | AnswerSessionAttentionPayload | CreateSessionPayload | StopSessionPayload | HandoffSessionPayload | GetHistoryPayload | RenameSessionPayload | RemoveSessionPayload | BridgeExecPayload | UpdateSessionParentPayload | GetSessionUsagePayload | GetSessionsUsagePayload | Record<string, unknown>;

export interface CommandResponse {
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}
