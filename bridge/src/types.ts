export type ShellType = 'claude' | 'cursor' | 'codex' | 'shell' | 'zai' | 'kimi' | 'opencode' | 'deepseek' | 'fireworks';

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
  codexSessionId?: string;
  env?: Record<string, string>;
  parentSessionId?: string;
  runtime?: SessionRuntime;
  errorReason?: string;
  loopId?: string; // set on loop-run sessions; groups the run under its Loop in the UI
}

export type SessionStatus = 'pending' | 'running' | 'completed' | 'error';

/** Tombstone written to <dataDir>/archive.jsonl when a session is removed. */
export interface ArchivedSession extends Session {
  removedAt: string;
}

export type LoopHarness = 'claude' | 'cursor' | 'codex' | 'opencode' | 'shell';

export type LoopRunStatus = 'ok' | 'error' | 'running' | 'skipped';

export type LoopSchedule =
  | { kind: 'interval'; everyMs: number }
  | { kind: 'cron'; expression: string; tz?: string };

export interface LoopFlight {
  command: string;
  timeoutMs?: number;
}

export interface LoopPostflight {
  command: string;
  timeoutMs?: number;
  /** Run postflight even when the fire was preflight-skipped. Default false. */
  runOnSkip?: boolean;
}

export interface LoopRetention {
  /** Keep newest N run-sessions; prune older ones. null = keep all. Default 10. */
  autoClearAfterRuns: number | null;
}

/** Client-authored fields (create/edit form). */
export interface LoopDraft {
  name: string;
  bridgeId: string;                 // REQUIRED: which bridge owns/runs this loop
  schedule: LoopSchedule;
  harness: LoopHarness;
  workdir?: string;
  task: string;                     // prompt run each fire; may contain "{{preflight}}"
  model?: string;
  enabled: boolean;
  overlapPolicy: 'skip' | 'allow';  // default 'skip'
  retention: LoopRetention;
  preflight?: LoopFlight;
  postflight?: LoopPostflight;
  /** Optional deterministic backstop: force-stop + mark 'error' if a flight runs longer. */
  maxRuntimeMs?: number;
}

/** Full server-authoritative record (LoopDraft + runtime state). */
export interface Loop extends LoopDraft {
  id: string;
  createdAt: string;                // ISO
  updatedAt: string;                // ISO
  lastRunAt?: string;               // ISO — fire time of the most recent flight
  nextRunAt?: string;               // ISO — authoritative, computed on the bridge
  lastStatus?: LoopRunStatus;
  lastSessionId?: string;           // id of the most recent run-Session
  runCount: number;                 // real AI/flight runs spawned
  skipCount: number;                // preflight-abort skips
  /** Transient manual-fire flag; set by run_loop_now, cleared on the next tick. */
  runNowRequested?: boolean;
}

/** A "run" is exactly a Session whose loopId === loop.id. No separate store record. */
export type LoopRun = Session & { loopId: string };

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

export type CommandType = 'create_session' | 'stop_session' | 'list_sessions' | 'get_history' | 'retry_session' | 'send_message' | 'rename_session' | 'remove_session' | 'bridge_exec' | 'clear_terminal' | 'update_session_parent' | 'create_loop' | 'list_loops' | 'update_loop' | 'delete_loop' | 'run_loop_now' | 'get_loop_runs';

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
  parentSessionId?: string;
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

export interface CreateLoopPayload extends LoopDraft { bridgeId: string }
export interface ListLoopsPayload { bridgeId?: string }
export interface UpdateLoopPayload { bridgeId: string; loopId: string; patch: Partial<LoopDraft> }
export interface DeleteLoopPayload { bridgeId: string; loopId: string }
export interface RunLoopNowPayload { bridgeId: string; loopId: string }
export interface GetLoopRunsPayload { bridgeId: string; loopId: string }

export type CommandPayload = CreateSessionPayload | StopSessionPayload | GetHistoryPayload | RenameSessionPayload | RemoveSessionPayload | BridgeExecPayload | ClearTerminalPayload | UpdateSessionParentPayload | CreateLoopPayload | ListLoopsPayload | UpdateLoopPayload | DeleteLoopPayload | RunLoopNowPayload | GetLoopRunsPayload | Record<string, unknown>;

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
