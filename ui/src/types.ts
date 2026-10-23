export type SessionStatus = 'pending' | 'running' | 'completed' | 'error' | 'disconnected';

export type ShellType = 'claude' | 'cursor' | 'codex' | 'shell' | 'zai' | 'kimi' | 'opencode' | 'deepseek' | 'fireworks' | 'grok' | 'pi' | 'kimi-code' | 'muse';

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
  claudeSessionId?: string;
  cursorSessionId?: string;
  codexSessionId?: string;
  piSessionId?: string;
  piSessionFile?: string;
  opencodeSessionId?: string;
  museSessionId?: string;
  command?: string;
  parentSessionId?: string;
  pullRequestUrl?: string;
  runtime?: 'tmux' | 'direct';
  loopId?: string; // Read-only provenance on sessions created by retired recurring automation.
  usage?: SessionUsage;
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

export type CommandType =
  | 'create_session' | 'stop_session' | 'list_sessions' | 'get_history'
  | 'retry_session' | 'rename_session' | 'remove_session' | 'bridge_exec'
  | 'update_session_parent'
  | 'get_session_usage' | 'get_sessions_usage';

export interface Command {
  type: CommandType;
  payload: CommandPayload;
  requestId: string;
}

export interface CreateSessionPayload {
  command?: string;
  prompt: string;
  name?: string;
  model?: string;
  workingDir?: string;
  bridgeId?: string;
  shellType?: ShellType;
  claudeSessionId?: string;
  cursorSessionId?: string;
  codexSessionId?: string;
  piSessionId?: string;
  piSessionFile?: string;
  opencodeSessionId?: string;
  museSessionId?: string;
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

export type CommandPayload = CreateSessionPayload | StopSessionPayload | GetHistoryPayload | RenameSessionPayload | RemoveSessionPayload | BridgeExecPayload | UpdateSessionParentPayload | GetSessionUsagePayload | GetSessionsUsagePayload | Record<string, unknown>;

export interface CommandResponse {
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}
