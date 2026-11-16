// FROZEN CONTRACT — immutable once this PR lands. Four later tasks port one hook
// each against these types; do not amend locally. Report a gap to the orchestrator
// instead of diverging the interface.

/**
 * Shared contract for `ftown-harness hook <kind>`.
 *
 * Import direction: the CLI runner and every per-hook adapter import this file.
 * Adapters do not import one another. The runner owns stdin/stdout/stderr and
 * exit codes; adapters own native-event translation and event/mail ordering;
 * the transport owns loopback POSTs and bridge-pointer fallback.
 *
 * This file is types and documentation only. It contains no runtime behavior.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

/** `kind` selects one native input dialect, not a bridge event name. */
export const HOOK_KINDS = [
  'notify',
  'grok',
  'antigravity',
  'muse-session-start',
  'muse-user-prompt-submit',
  'muse-pre-tool-use',
  'muse-post-tool-use',
  'muse-stop',
] as const;
export type HookKind = (typeof HOOK_KINDS)[number];

/** Only this kind has an adapter in the contract step; other kinds fail visibly. */
export const IMPLEMENTED_HOOK_KINDS = ['muse-session-start'] as const;
export type ImplementedHookKind = (typeof IMPLEMENTED_HOOK_KINDS)[number];

export type HookSessionSource = 'env' | 'conversation' | 'workspace';
export type ToolHookEventName = 'PreToolUse' | 'PostToolUse';
export type AntigravityLifecycleEventName = 'SessionStart' | 'UserPromptSubmit' | 'Stop';

/** Optional means the native field was absent, null, or rejected by that hook's current allowlist. */
export interface HookToolFields {
  tool_name?: JsonValue;
  tool_input?: JsonValue;
  tool_use_id?: JsonValue;
}

/**
 * notify.sh — Claude/Codex/Cursor passthrough (plus Grok's notification event).
 * Reads: all of stdin as one JSON object; FTOWN_SESSION_ID, FTOWN_HOOK_PORT,
 * FTOWN_HOOK_TOKEN, FTOWN_BRIDGE_POINTER, HOME, HOOK_EVENT_NAME, GROK_HOOK_EVENT;
 * `~/.ftown/session-registry.json` when no env session id (byConversation, then
 * byWorkspace from workspace_roots[0]).
 * Posts: the parsed stdin object unchanged plus ftown_session_id and
 * ftown_session_source. When stdin is absent or not an object, posts a fallback
 * body with a string hook_event_name (HOOK_EVENT_NAME or 'hook'). When
 * GROK_HOOK_EVENT names a non-notification event and stdin has a non-empty string
 * hookEventName, it stands down and posts nothing. No mail drain, no stdout.
 */
export type NotifyHookPayload = JsonObject & {
  ftown_session_id: string;
  ftown_session_source: HookSessionSource;
  hook_event_name?: JsonValue;
};

/**
 * Grok hook — every non-empty hook_event_name except Stop reasons
 * 'shutdown' and 'channel_closed'.
 * Reads: stdin JSON; FTOWN_SESSION_ID, FTOWN_HOOK_PORT, FTOWN_HOOK_TOKEN,
 * FTOWN_BRIDGE_POINTER, HOME, GROK_SESSION_ID.
 * Posts: ftown_session_id (env), ftown_session_source 'env', hook_event_name,
 * session_id (stdin session_id if non-empty string, else GROK_SESSION_ID, else
 * ''), cwd (stdin string else ''), and tool_name / tool_input / tool_use_id
 * when present. On Stop/end_turn it drains the inbox first: with mail it prints
 * a `block` decision and posts nothing; otherwise it posts Stop.
 */
export type GrokHookPayload = HookToolFields & {
  ftown_session_id: string;
  ftown_session_source: 'env';
  hook_event_name: string;
  session_id: string;
  cwd: string;
};

/**
 * Antigravity hook — camelCase native events translated to snake_case wire.
 * Reads: stdin JSON; FTOWN_SESSION_ID, FTOWN_HOOK_PORT, FTOWN_HOOK_TOKEN,
 * FTOWN_BRIDGE_POINTER, HOME, ANTIGRAVITY_CONVERSATION_ID.
 * Native mapping: SessionStart/PreToolUse/PostToolUse/Stop pass through;
 * PreInvocation with invocationNum == 0 becomes UserPromptSubmit; anything else
 * posts nothing. conversationId and cwd are coerced to strings (missing -> '');
 * toolCall.args is forwarded only when it is an object, toolCall.id only when a
 * string. On Stop it drains first unless terminationReason is
 * MAX_FORCED_INVOCATIONS / USER_CANCELED / ERROR: with mail it prints a
 * `continue` decision and still posts Stop (to clear the busy marker).
 */
export type AntigravityHookPayload =
  | (HookToolFields & {
      ftown_session_id: string;
      ftown_session_source: 'env';
      hook_event_name: ToolHookEventName;
      session_id: string;
      cwd: string;
      /** Present only when toolCall.args is an object; arrays and scalars are omitted. */
      tool_input?: JsonObject;
      /** Present only when toolCall.id is a string. */
      tool_use_id?: string;
    })
  | {
      ftown_session_id: string;
      ftown_session_source: 'env';
      hook_event_name: AntigravityLifecycleEventName;
      session_id: string;
      cwd: string;
    };

export interface MuseNativeFields {
  session_id: string;
  cwd: string;
}

/** Muse SessionStart — the end-to-end proof event implemented in this PR. */
export type MuseSessionStartHookPayload = MuseNativeFields & {
  ftown_session_id: string;
  ftown_session_source: 'env';
  hook_event_name: 'SessionStart';
};

/** Muse UserPromptSubmit — `prompt` is present only when a string. */
export type MuseUserPromptSubmitHookPayload = MuseNativeFields & {
  ftown_session_id: string;
  ftown_session_source: 'env';
  hook_event_name: 'UserPromptSubmit';
  prompt?: string;
};

/** Muse Stop posts before draining; pending mail is emitted as additionalContext. */
export type MuseStopHookPayload = MuseNativeFields & {
  ftown_session_id: string;
  ftown_session_source: 'env';
  hook_event_name: 'Stop';
};

/**
 * Muse tool events deliberately omit arguments, results, cwd, native session id
 * and source. `post-tool-use-failure` maps to PostToolUse.
 */
export type MuseToolHookPayload = {
  ftown_session_id: string;
  hook_event_name: ToolHookEventName;
  tool_name?: string;
  tool_use_id?: string;
};

export type MuseHookPayload =
  | MuseSessionStartHookPayload
  | MuseUserPromptSubmitHookPayload
  | MuseToolHookPayload
  | MuseStopHookPayload;

export type HookWirePayload =
  | NotifyHookPayload
  | GrokHookPayload
  | AntigravityHookPayload
  | MuseHookPayload;

/** Environment read by one or more adapters; absent means unset or an empty value. */
export interface HookEnvironment {
  readonly FTOWN_SESSION_ID?: string;
  readonly FTOWN_HOOK_PORT?: string;
  readonly FTOWN_HOOK_TOKEN?: string;
  readonly FTOWN_BRIDGE_POINTER?: string;
  readonly HOME?: string;
  readonly HOOK_EVENT_NAME?: string;
  readonly GROK_HOOK_EVENT?: string;
  readonly GROK_SESSION_ID?: string;
  readonly ANTIGRAVITY_CONVERSATION_ID?: string;
}

/** Per-attempt budget; two candidates therefore have a four-second POST budget. */
export const HOOK_REQUEST_TIMEOUT_MS = 2000;

export interface HookBridgeCandidate {
  readonly port: number;
  /** Absent or empty sends no Authorization header; the bridge may then reject the POST. */
  readonly token?: string;
  readonly source: 'env' | 'pointer';
}

export interface HookTransportConfig {
  readonly candidates: readonly HookBridgeCandidate[];
  /** Defaults to HOOK_REQUEST_TIMEOUT_MS when absent. */
  readonly timeoutMs?: number;
}

export type HookAttemptError = {
  readonly port: number;
  readonly source: HookBridgeCandidate['source'];
  readonly status?: number; // Present for a non-2xx HTTP response, absent for network/timeout failures.
  readonly message: string; // Sanitized: no token, pointer contents, payload, or native input.
};

export type HookPostResult =
  | { readonly ok: true; readonly candidate: HookBridgeCandidate }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind: 'no-endpoint' | 'delivery-failed';
        readonly message: string;
        readonly attempts: readonly HookAttemptError[];
      };
    };

/** First 2xx wins; non-2xx/network/timeout tries the next candidate in order. */
export type PostHookPayload = (
  payload: HookWirePayload,
  config: HookTransportConfig,
) => Promise<HookPostResult>;

export type HookFailureKind =
  | 'stdin-error'
  | 'invalid-json'
  | 'invalid-input'
  | 'unsupported-kind'
  | 'no-endpoint'
  | 'delivery-failed';

export interface HookFailure {
  readonly kind: HookFailureKind;
  /** One sanitized line suitable for stderr. Never contains tokens or hook payload text. */
  readonly message: string;
}

export type HookAdapterResult =
  | { readonly status: 'ok'; readonly stdout?: string }
  | { readonly status: 'error'; readonly error: HookFailure; readonly stdout?: string };

export interface HookAdapterContext {
  readonly kind: HookKind;
  /** Complete UTF-8 stdin, read once before adapter dispatch. */
  readonly input: string;
  readonly env: HookEnvironment;
  /** Adapters control when this is called so Grok/antigravity/muse retain their Stop ordering. */
  readonly post: (payload: HookWirePayload) => Promise<HookPostResult>;
}

/** Optional stdout is emitted exactly once; absence means no stdout bytes. */
export type HookAdapter = (context: HookAdapterContext) => Promise<HookAdapterResult>;

/** Arguments after the executable for direct-exec harnesses. */
export type BuildHookArgv = (kind: HookKind) => readonly ['hook', HookKind];
/** Full argv when the harness spawns the executable directly (no shell). */
export type BuildHookExecArgv = (executablePath: string, kind: HookKind) => readonly [string, 'hook', HookKind];
/** POSIX-shell command for harnesses that store a command string; path is quoted. */
export type BuildHookShellCommand = (executablePath: string, kind: HookKind) => string;

/** Valid-kind failures are reported on stderr but return 0 so a hook cannot block its agent. */
export type HookEventExitCode = 0;
/** Missing/unknown kind or extra arguments are CLI usage errors and return 2. */
export type HookUsageExitCode = 2;

/**
 * Decision Log
 * - Kinds name native dialects: notify forwards open payloads, while each Muse wrapper has a fixed kind.
 * - JSON passthrough is confined to notify and the legacy Grok tool keys; all constructed identity fields are typed.
 * - Env precedes pointer fallback and exact endpoint duplicates are removed: resurrected sessions retain stale-env recovery.
 * - Valid hook failures return 0 with visible stderr: current hooks never block agents, but lost events are no longer silent.
 * - Unset FTOWN_SESSION_ID may still be intentionally inert: manually launched agents must not require a bridge or emit noise.
 * - Registration exposes argv and POSIX-shell forms: direct-exec harnesses must not concatenate a shell command.
 * - No idempotency key is invented: fallback preserves today's at-least-once behavior after an ambiguous network failure.
 */
