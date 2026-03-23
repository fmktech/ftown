export type SessionStatus = 'pending' | 'running' | 'completed' | 'error' | 'disconnected';

export type ShellType = 'claude' | 'shell';

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
  command?: string;
  diffStat?: string;
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

export type CommandType = 'create_session' | 'stop_session' | 'list_sessions' | 'get_history' | 'retry_session' | 'rename_session' | 'remove_session' | 'bridge_exec' | 'get_diff';

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
  env?: Record<string, string>;
  initialInput?: string;
  initialInputDelay?: number;
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

export interface RemoveSessionPayload {
  sessionId: string;
}

export interface BridgeExecPayload {
  command: string;
  workingDir?: string;
  timeout?: number;
  bridgeId?: string;
}

export interface GetDiffPayload {
  sessionId: string;
  bridgeId?: string;
}

export type CommandPayload = CreateSessionPayload | StopSessionPayload | GetHistoryPayload | RenameSessionPayload | RemoveSessionPayload | BridgeExecPayload | GetDiffPayload | Record<string, unknown>;

export interface CommandResponse {
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}
