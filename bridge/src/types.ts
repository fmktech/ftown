export type ShellType = 'claude' | 'cursor' | 'shell' | 'zai' | 'kimi' | 'opencode' | 'deepseek' | 'fireworks';

export type SessionRuntime = 'tmux' | 'direct';

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
  env?: Record<string, string>;
  parentSessionId?: string;
  runtime?: SessionRuntime;
}

export type SessionStatus = 'pending' | 'running' | 'completed' | 'error';

/** Tombstone written to <dataDir>/archive.jsonl when a session is removed. */
export interface ArchivedSession extends Session {
  removedAt: string;
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

export type CommandType = 'create_session' | 'stop_session' | 'list_sessions' | 'get_history' | 'retry_session' | 'send_message' | 'rename_session' | 'remove_session' | 'bridge_exec' | 'clear_terminal' | 'update_session_parent';

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
  parentSessionId?: string;
  orchestrator?: boolean;
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

export type CommandPayload = CreateSessionPayload | StopSessionPayload | GetHistoryPayload | RenameSessionPayload | RemoveSessionPayload | BridgeExecPayload | ClearTerminalPayload | UpdateSessionParentPayload | Record<string, unknown>;

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
