export type SessionStatus = 'pending' | 'running' | 'completed' | 'error' | 'disconnected';

export type ShellType = 'claude' | 'cursor' | 'codex' | 'shell' | 'zai' | 'kimi' | 'opencode' | 'deepseek' | 'fireworks' | 'grok' | 'pi' | 'kimi-code';

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
  codexSessionId?: string;
  piSessionId?: string;
  piSessionFile?: string;
  command?: string;
  parentSessionId?: string;
  loopId?: string; // set on loop-run sessions; groups the run under its Loop in the UI
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

// ---------------------------------------------------------------------------
// Scheduled Loops
// ---------------------------------------------------------------------------

export type LoopHarness = 'claude' | 'cursor' | 'codex' | 'opencode' | 'shell' | 'grok' | 'pi' | 'kimi-code';

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
  /** Optional free-text grouping label (e.g. "Software Factory"), used to fold related loops in the UI. */
  group?: string;
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
  lastSkipAt?: string;              // ISO — fire time of the most recent preflight skip
  lastSkipReason?: string;          // preflight exit code + trimmed stderr/stdout, capped at 512 chars
  /** Transient manual-fire flag; set by run_loop_now, cleared on the next tick. */
  runNowRequested?: boolean;
}

/** Legacy shape from older bridges that exposed loop runs as sessions. */
export type LoopRun = Session & { loopId: string };

export interface LoopRunRecord {
  id: string;
  loopId: string;
  bridgeId: string;
  sessionId?: string;
  name: string;
  status: LoopRunStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs?: number;
  harness?: LoopHarness;
  workdir?: string;
  task?: string;
  model?: string;
  sessionStatus?: SessionStatus;
  errorReason?: string;
  logTail?: string;
  logBytes?: number;
  logTruncated?: boolean;
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
  | 'create_loop' | 'list_loops' | 'update_loop'
  | 'delete_loop' | 'run_loop_now' | 'get_loop_runs'
  | 'get_session_usage' | 'get_sessions_usage';

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
  codexSessionId?: string;
  piSessionId?: string;
  piSessionFile?: string;
  env?: Record<string, string>;
  initialInput?: string;
  initialInputDelay?: number;
  parentSessionId?: string;
  orchestrator?: boolean;
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

export interface CreateLoopPayload extends LoopDraft { bridgeId: string }
export interface ListLoopsPayload { bridgeId?: string }
export interface UpdateLoopPayload { bridgeId: string; loopId: string; patch: Partial<LoopDraft> }
export interface DeleteLoopPayload { bridgeId: string; loopId: string }
export interface RunLoopNowPayload { bridgeId: string; loopId: string }
export interface GetLoopRunsPayload { bridgeId?: string; loopId: string }

export type CommandPayload = CreateSessionPayload | StopSessionPayload | GetHistoryPayload | RenameSessionPayload | RemoveSessionPayload | BridgeExecPayload | UpdateSessionParentPayload | GetSessionUsagePayload | GetSessionsUsagePayload | CreateLoopPayload | ListLoopsPayload | UpdateLoopPayload | DeleteLoopPayload | RunLoopNowPayload | GetLoopRunsPayload | Record<string, unknown>;

export interface CommandResponse {
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}
