import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type {
  AntigravityHookPayload,
  AntigravityLifecycleEventName,
  HookAdapter,
  HookEnvironment,
  HookKind,
  HookSessionSource,
  JsonObject,
  JsonValue,
  MuseSessionStartHookPayload,
  NotifyHookPayload,
  ToolHookEventName,
} from './hook-contract.js';

/**
 * Muse SessionStart — the end-to-end proof for the shared entry point.
 * Mirrors bridge/muse-plugin/lib/ftown-hook.sh: stdin is one JSON object whose
 * session_id and cwd are forwarded as strings (missing/non-string -> ''). It is
 * inert when no ftown session owns the process, and emits no stdout.
 */
export const museSessionStartAdapter: HookAdapter = async ({ input, env, post }) => {
  if (!env.FTOWN_SESSION_ID) return { status: 'ok' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { status: 'error', error: { kind: 'invalid-json', message: 'native hook payload is not valid JSON' } };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'error', error: { kind: 'invalid-input', message: 'native hook payload must be a JSON object' } };
  }
  const native = parsed as JsonObject;
  const payload: MuseSessionStartHookPayload = {
    ftown_session_id: env.FTOWN_SESSION_ID,
    ftown_session_source: 'env',
    hook_event_name: 'SessionStart',
    session_id: typeof native.session_id === 'string' ? native.session_id : '',
    cwd: typeof native.cwd === 'string' ? native.cwd : '',
  };
  const result = await post(payload);
  if (result.ok) return { status: 'ok' };
  return { status: 'error', error: { kind: result.error.kind, message: result.error.message } };
};

/**
 * Resolve a session from `~/.ftown/session-registry.json` when no env session
 * owns the process: `conversation_id` first, then `workspace_roots[0]`. Both
 * keys are read from the injected HOME so an isolated hook environment cannot
 * be redirected to the bridge process's home. Malformed/missing registries are
 * inert, matching the old jq-based lookup.
 */
function resolveRegistrySession(
  native: JsonObject,
  home: string | undefined,
): { sessionId: string; source: HookSessionSource } | undefined {
  if (!home) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(home, '.ftown', 'session-registry.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const registry = parsed as JsonObject;

  const conversationId = native.conversation_id;
  if (typeof conversationId === 'string' && conversationId) {
    const byConversation = registry.byConversation;
    if (byConversation && typeof byConversation === 'object' && !Array.isArray(byConversation)) {
      const id = (byConversation as JsonObject)[conversationId];
      if (typeof id === 'string' && id) return { sessionId: id, source: 'conversation' };
    }
  }

  const roots = native.workspace_roots;
  const firstRoot = Array.isArray(roots) ? roots[0] : undefined;
  if (typeof firstRoot === 'string' && firstRoot) {
    const byWorkspace = registry.byWorkspace;
    if (byWorkspace && typeof byWorkspace === 'object' && !Array.isArray(byWorkspace)) {
      const id = (byWorkspace as JsonObject)[firstRoot];
      if (typeof id === 'string' && id) return { sessionId: id, source: 'workspace' };
    }
  }

  return undefined;
}

/**
 * notify.sh — Claude/Codex/Cursor passthrough (and Grok's notification event).
 * Stdin is forwarded unchanged with typed identity fields appended; absent,
 * invalid or non-object stdin produces a `{hook_event_name}` fallback body. It
 * stands down for a Grok non-notification event carrying `hookEventName`, is
 * inert when no session owns the process, never drains mail and never writes
 * stdout. Deliberately involves no jq or curl.
 */
export const notifyAdapter: HookAdapter = async ({ input, env, post }) => {
  let native: JsonObject | undefined;
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) native = parsed as JsonObject;
  } catch {
    // Invalid JSON is not an error here: notify.sh forwards a fallback body.
  }

  // Grok runs Claude-compatible hooks too; its own hook handles its events.
  // An inherited GROK_HOOK_EVENT must not silence Claude/Codex/Cursor, which
  // do not send the camelCase hookEventName field.
  if (
    env.GROK_HOOK_EVENT && env.GROK_HOOK_EVENT !== 'notification'
    && native && typeof native.hookEventName === 'string' && native.hookEventName.length > 0
  ) {
    return { status: 'ok' };
  }

  let sessionId = env.FTOWN_SESSION_ID;
  let source: HookSessionSource | undefined = sessionId ? 'env' : undefined;
  if (!sessionId && native) {
    const resolved = resolveRegistrySession(native, env.HOME);
    if (resolved) {
      sessionId = resolved.sessionId;
      source = resolved.source;
    }
  }
  if (!sessionId || !source) return { status: 'ok' };

  const payload: NotifyHookPayload = native
    ? { ...native, ftown_session_id: sessionId, ftown_session_source: source }
    : {
        ftown_session_id: sessionId,
        ftown_session_source: source,
        hook_event_name: env.HOOK_EVENT_NAME || 'hook',
      };
  const result = await post(payload);
  if (result.ok) return { status: 'ok' };
  return { status: 'error', error: { kind: result.error.kind, message: result.error.message } };
};

/**
 * Antigravity hook — camelCase native events translated to the snake_case wire
 * format. No jq or curl: native parsing, mapping, tool-field allowlisting and
 * the Stop inbox drain all live here in Node.
 */

/** Reasons agy will not continue the turn; on Stop they skip the inbox drain. */
const NO_DRAIN_REASONS = new Set(['MAX_FORCED_INVOCATIONS', 'USER_CANCELED', 'ERROR']);
const PASSTHROUGH_EVENTS = new Set<AntigravityLifecycleEventName | ToolHookEventName>([
  'SessionStart', 'PreToolUse', 'PostToolUse', 'Stop',
]);

/** jq-style coercion: strings pass through, null/missing become '', others stringify. */
function antigravityString(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Render an agy Stop mail decision, byte-for-byte matching the retired jq hook. */
export function formatAntigravityMail(messages: JsonValue[]): string {
  const lines = messages.map((message) => {
    const m = isJsonObject(message) ? message : {};
    const from = m.fromName ?? m.from ?? 'external';
    const type = m.type ?? 'message';
    return `[${antigravityString(m.ts)}] ${antigravityString(from)} (${antigravityString(type)}): ${antigravityString(m.body)}`;
  });
  return `[ftown mail]\n${lines.join('\n')}`;
}

/** The reader is injectable so unit tests need no real `ftown` subprocess. */
export type AntigravityInboxReader = (
  sessionId: string,
  env: HookEnvironment,
) => Promise<JsonObject | undefined>;

/** Resolve `ftown` the way the retired shell hook did: PATH, then ~/.ftown/bin. */
function resolveFtownCli(env: HookEnvironment): string | undefined {
  const path = process.env.PATH ?? '';
  for (const directory of path.split(delimiter)) {
    const candidate = join(directory || '.', 'ftown');
    if (existsSync(candidate)) return candidate;
  }
  const homeCli = env.HOME ? join(env.HOME, '.ftown', 'bin', 'ftown') : undefined;
  return homeCli && existsSync(homeCli) ? homeCli : undefined;
}

/**
 * Bounded `ftown security proxy` call: one wait=0 inbox read that marks the
 * mail delivered. Never throws and never leaks the CLI's stderr into the hook.
 */
const readInboxViaFtownCli: AntigravityInboxReader = (sessionId, env) => new Promise((resolve) => {
  const cli = resolveFtownCli(env);
  if (!cli) return resolve(undefined);
  const request = JSON.stringify({
    method: 'GET',
    path: `/api/sessions/${encodeURIComponent(sessionId)}/inbox?wait=0`,
    timeoutMs: 2000,
  });
  let settled = false;
  const done = (value: JsonObject | undefined): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  let stdout = '';
  let overflowed = false;
  const child = spawn(cli, ['security', 'proxy'], {
    env: { ...process.env, ...(env.HOME ? { HOME: env.HOME } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => { child.kill('SIGKILL'); done(undefined); }, 3000);
  timer.unref();
  child.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length + chunk.length > 1024 * 1024) { overflowed = true; child.kill('SIGKILL'); return; }
    stdout += chunk.toString('utf8');
  });
  child.stderr.resume();
  child.on('error', () => done(undefined));
  child.on('close', () => {
    if (overflowed) return done(undefined);
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (!isJsonObject(parsed) || typeof parsed.status !== 'number' || parsed.status < 200 || parsed.status >= 300) {
        return done(undefined);
      }
      done(isJsonObject(parsed.body) ? parsed.body : undefined);
    } catch {
      done(undefined);
    }
  });
  child.stdin.on('error', () => { /* a receiver may close stdin before EOF */ });
  child.stdin.end(request);
});

export function makeAntigravityAdapter(readInbox: AntigravityInboxReader): HookAdapter {
  return async ({ input, env, post }) => {
    // A manually launched agent has no bridge session: stay inert and silent.
    if (!env.FTOWN_SESSION_ID) return { status: 'ok' };

    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return { status: 'ok' };
    }
    if (!isJsonObject(parsed)) return { status: 'ok' };
    const native = parsed;
    const nativeEvent = native.hookEventName;
    if (typeof nativeEvent !== 'string' || nativeEvent.length === 0) return { status: 'ok' };

    let event: AntigravityLifecycleEventName | ToolHookEventName;
    if (PASSTHROUGH_EVENTS.has(nativeEvent as AntigravityLifecycleEventName)) {
      event = nativeEvent as AntigravityLifecycleEventName | ToolHookEventName;
    } else if (nativeEvent === 'PreInvocation' && native.invocationNum === 0) {
      event = 'UserPromptSubmit';
    } else {
      return { status: 'ok' };
    }

    const nativeConv = antigravityString(native.conversationId);
    const sessionId = nativeConv !== '' ? nativeConv : (env.ANTIGRAVITY_CONVERSATION_ID ?? '');
    const identity = {
      ftown_session_id: env.FTOWN_SESSION_ID,
      ftown_session_source: 'env' as const,
      session_id: sessionId,
      cwd: antigravityString(native.cwd),
    };

    let payload: AntigravityHookPayload;
    if (event === 'PreToolUse' || event === 'PostToolUse') {
      const toolCall = isJsonObject(native.toolCall) ? native.toolCall : undefined;
      const args = toolCall?.args;
      payload = {
        ...identity,
        hook_event_name: event,
        ...(toolCall?.name !== undefined && toolCall.name !== null ? { tool_name: toolCall.name } : {}),
        ...(isJsonObject(args) ? { tool_input: args } : {}),
        ...(typeof toolCall?.id === 'string' ? { tool_use_id: toolCall.id } : {}),
      };
    } else {
      payload = { ...identity, hook_event_name: event };
    }

    // Stop drains first: with mail it still posts Stop to clear the busy marker.
    let stdout: string | undefined;
    if (event === 'Stop' && !(typeof native.terminationReason === 'string' && NO_DRAIN_REASONS.has(native.terminationReason))) {
      // The inbox belongs to the ftown session, not the native conversation id.
      const inbox = await readInbox(env.FTOWN_SESSION_ID, env);
      const messages = inbox && Array.isArray(inbox.messages) ? inbox.messages : [];
      if (messages.length > 0) stdout = JSON.stringify({ decision: 'continue', reason: formatAntigravityMail(messages) });
    }

    const result = await post(payload);
    if (result.ok) return { status: 'ok', ...(stdout !== undefined ? { stdout } : {}) };
    return {
      status: 'error',
      error: { kind: result.error.kind, message: result.error.message },
      ...(stdout !== undefined ? { stdout } : {}),
    };
  };
}

export const antigravityAdapter: HookAdapter = makeAntigravityAdapter(readInboxViaFtownCli);

/**
 * Adapter registry. The four later porting tasks add one entry each and extend
 * IMPLEMENTED_HOOK_KINDS in the contract; they do not change the runner.
 */
export const HOOK_ADAPTERS: Readonly<Partial<Record<HookKind, HookAdapter>>> = Object.freeze({
  'muse-session-start': museSessionStartAdapter,
  notify: notifyAdapter,
  antigravity: antigravityAdapter,
});
