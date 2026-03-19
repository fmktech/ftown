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
}

export type SessionStatus = 'pending' | 'running' | 'completed' | 'error';

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

export type CommandType = 'create_session' | 'stop_session' | 'list_sessions' | 'get_history' | 'retry_session' | 'send_message';

export interface CreateSessionPayload {
  prompt: string;
  name?: string;
  model?: string;
  workingDir?: string;
}

export interface StopSessionPayload {
  sessionId: string;
}

export interface GetHistoryPayload {
  sessionId: string;
}

export interface RetrySessionPayload {
  sessionId: string;
}

export interface SendMessagePayload {
  sessionId: string;
  message: string;
}

export type CommandPayload = CreateSessionPayload | StopSessionPayload | GetHistoryPayload | RetrySessionPayload | SendMessagePayload | Record<string, unknown>;

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
