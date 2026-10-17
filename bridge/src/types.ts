// Derived from the harness registry (single source of truth for supported
// harnesses); re-exported here so existing `from './types.js'` imports keep working.
// Type-only, so this adds no runtime dependency on harness-registry.js.
export type { ShellType } from './harness-registry.js';
import type { ShellType } from './harness-registry.js';

export type SessionRuntime = 'tmux' | 'direct';

/** Per-model token breakdown within a session. */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Per-session token usage, extracted from harness-native session files. */
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

export interface Session {
  id: string;
  name: string;
  command: string;
  prompt?: string;
  status: SessionStatus;
  bridgeId: string;
  createdAt: string;
  updatedAt: string;
  workingDir?: string;
  shellType?: ShellType;
  model?: string;
  claudeSessionId?: string;
  cursorSessionId?: string;
  codexSessionId?: string;
  piSessionId?: string;
  piSessionFile?: string;
  opencodeSessionId?: string;
  museSessionId?: string;
  env?: Record<string, string>;
  parentSessionId?: string;
  runtime?: SessionRuntime;
  errorReason?: string;
  loopId?: string; // Historical provenance only; retired automation can never be relaunched
  usage?: SessionUsage;
}

export type SessionStatus = 'pending' | 'running' | 'completed' | 'error';

/** Tombstone written to <dataDir>/archive.jsonl when a session is removed. */
export interface ArchivedSession extends Session {
  removedAt: string;
}

/** Inter-agent mail stored in <dataDir>/sessions/<id>/inbox.jsonl. */
export interface MailMessage {
  id: string;            // `${Date.now().toString(36)}-${random6}`
  ts: string;            // ISO timestamp
  from: string;          // sender ftown session id, or 'external'
  fromName?: string;     // friendly sender name
  to: string;            // recipient ftown session id
  type: 'message' | 'task' | 'result' | 'escalation';
  threadId?: string;
  body: string;          // plain text, capped at 64KB
  deliveredAt?: string;  // ISO, set when handed to the session (not for peek)
  deliveredVia?: 'poll' | 'drain' | 'nudge' | 'cli';
}

export interface SessionMessage {
  sessionId: string;
  type: SessionMessageType;
  content: string;
  timestamp: string;
  toolName?: string;
  raw?: ClaudeStreamEvent;
}

export type SessionMessageType = 'assistant' | 'user' | 'system' | 'tool_use' | 'tool_result';

export interface Command {
  type: CommandType;
  payload: CommandPayload;
  requestId: string;
}

export type CommandType = 'mcp_request' | 'create_session' | 'stop_session' | 'list_sessions' | 'get_history' | 'retry_session' | 'send_message' | 'rename_session' | 'remove_session' | 'bridge_exec' | 'clear_terminal' | 'update_session_parent' | 'get_session_usage' | 'get_sessions_usage';

export interface CreateSessionPayload {
  command: string;
  prompt?: string;
  name?: string;
  workingDir?: string;
  bridgeId?: string;
  env?: Record<string, string>;
  initialInput?: string;
  initialInputDelay?: number;
  shellType?: ShellType;
  model?: string;
  claudeSessionId?: string;
  cursorSessionId?: string;
  codexSessionId?: string;
  piSessionId?: string;
  piSessionFile?: string;
  opencodeSessionId?: string;
  museSessionId?: string;
  parentSessionId?: string;
  /** @deprecated Ignored compatibility input. Ordinary sessions use task + parent. */
  orchestrator?: boolean;
  suppressBriefing?: boolean;
  createMissingWorkingDir?: boolean;
}

export interface BridgeExecPayload {
  command: string;
  workingDir?: string;
  timeout?: number;
  bridgeId?: string;
}

export interface StopSessionPayload {
  sessionId: string;
  bridgeId?: string;
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

export interface ClearTerminalPayload {
  sessionId: string;
}

export interface GetSessionUsagePayload {
  sessionId: string;
  bridgeId?: string;
}

export interface GetSessionsUsagePayload {
  sessionIds: string[];
  bridgeId?: string;
}

export type CommandPayload = CreateSessionPayload | StopSessionPayload | GetHistoryPayload | RenameSessionPayload | RemoveSessionPayload | BridgeExecPayload | ClearTerminalPayload | UpdateSessionParentPayload | GetSessionUsagePayload | GetSessionsUsagePayload | Record<string, unknown>;

export interface CommandResponse {
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

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
  duration_api_ms?: number;
  is_error?: boolean;
  num_turns?: number;
  session_id?: string;
  cost_usd?: number;
}

export interface BridgeConfig {
  token: string;
  centrifugoUrl: string;
  dataDir: string;
  bridgeId: string;
  userId: string;
}

export interface BridgePresenceInfo {
  bridgeId: string;
  hostname: string;
  connectedAt: string;
}
