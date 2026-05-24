export type SessionStatus = 'pending' | 'running' | 'completed' | 'error' | 'disconnected';

export type ShellType = 'claude' | 'cursor' | 'shell' | 'zai' | 'kimi' | 'opencode' | 'deepseek' | 'fireworks';

export interface Session {
  id: string;
  name: string;
  prompt: string;
  status: SessionStatus;
  bridgeId: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  workingDir?: string;
  shellType?: ShellType;
  claudeSessionId?: string;
  cursorSessionId?: string;
  command?: string;
  parentSessionId?: string;
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

export type CommandType = 'create_session' | 'stop_session' | 'list_sessions' | 'get_history' | 'retry_session' | 'rename_session' | 'remove_session' | 'bridge_exec' | 'update_session_parent';

export interface Command {
  type: CommandType;
  payload: CommandPayload;
  requestId: string;
}

export interface CreateSessionPayload {
  command: string;
  prompt: string;
  name?: string;
  model?: string;
  workingDir?: string;
  bridgeId?: string;
  shellType?: ShellType;
  claudeSessionId?: string;
  cursorSessionId?: string;
  env?: Record<string, string>;
  initialInput?: string;
  initialInputDelay?: number;
  parentSessionId?: string;
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
}

export interface BridgeExecPayload {
  command: string;
  workingDir?: string;
  timeout?: number;
  bridgeId?: string;
}

export type CommandPayload = CreateSessionPayload | StopSessionPayload | GetHistoryPayload | RenameSessionPayload | RemoveSessionPayload | BridgeExecPayload | UpdateSessionParentPayload | Record<string, unknown>;

export interface CommandResponse {
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}
