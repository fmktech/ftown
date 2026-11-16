import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { grokHookAdapter } from './grok-hook-adapter.js';
import type {
  AntigravityHookPayload,
  AntigravityLifecycleEventName,
  HookAdapter,
  HookAdapterResult,
  HookEnvironment,
  HookFailure,
  HookKind,
  HookPostResult,
  HookSessionSource,
  JsonObject,
  JsonValue,
  MuseSessionStartHookPayload,
  MuseStopHookPayload,
  MuseToolHookPayload,
  MuseUserPromptSubmitHookPayload,
  NotifyHookPayload,
  ToolHookEventName,
} from './hook-contract.js';

/** Native hook stdin is always one JSON object; invalid input is a visible, non-blocking error. */
function parseMuseNative(input: string): { ok: true; native: JsonObject } | { ok: false; error: HookFailure } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { ok: false, error: { kind: 'invalid-json', message: 'native hook payload is not valid JSON' } };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: { kind: 'invalid-input', message: 'native hook payload must be a JSON object' } };
  }
  return { ok: true, native: parsed as JsonObject };
}

/** Missing/non-string native fields become empty strings, matching the old jq `// empty` lookup. */
function nativeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function fromPostResult(result: HookPostResult): HookAdapterResult {
  return result.ok ? { status: 'ok' } : { status: 'error', error: { kind: result.error.kind, message: result.error.message } };
}

/**
 * Muse SessionStart — the end-to-end proof for the shared entry point.
 * Mirrors bridge/muse-plugin/lib/ftown-hook.sh: stdin is one JSON object whose
 * session_id and cwd are forwarded as strings (missing/non-string -> ''). It is
 * inert when no ftown session owns the process, and emits no stdout.
 */
export const museSessionStartAdapter: HookAdapter = async ({ input, env, post }) => {
  if (!env.FTOWN_SESSION_ID) return { status: 'ok' };

  const parsed = parseMuseNative(input);
  if (!parsed.ok) return { status: 'error', error: parsed.error };
  const payload: MuseSessionStartHookPayload = {
    ftown_session_id: env.FTOWN_SESSION_ID,
    ftown_session_source: 'env',
    hook_event_name: 'SessionStart',
    session_id: nativeString(parsed.native.session_id),
    cwd: nativeString(parsed.native.cwd),
  };
  return fromPostResult(await post(payload));
};

/**
 * Muse UserPromptSubmit — the SessionStart envelope plus `prompt`, present only
 * when the native field is a string. No mail drain, no stdout.
 */
export const museUserPromptSubmitAdapter: HookAdapter = async ({ input, env, post }) => {
  if (!env.FTOWN_SESSION_ID) return { status: 'ok' };

  const parsed = parseMuseNative(input);
  if (!parsed.ok) return { status: 'error', error: parsed.error };
  const payload: MuseUserPromptSubmitHookPayload = {
    ftown_session_id: env.FTOWN_SESSION_ID,
    ftown_session_source: 'env',
    hook_event_name: 'UserPromptSubmit',
    session_id: nativeString(parsed.native.session_id),
    cwd: nativeString(parsed.native.cwd),
    ...(typeof parsed.native.prompt === 'string' ? { prompt: parsed.native.prompt } : {}),
  };
  return fromPostResult(await post(payload));
};

/**
 * Muse tool events use an allowlist: identity, event name and string tool name /
 * call id only. Arguments, results, cwd and the native session id never go on
 * the wire. `muse-post-tool-use-failure` registers as muse-post-tool-use, so the
 * same adapter covers success and failure.
 */
function museToolAdapter(hook_event_name: ToolHookEventName): HookAdapter {
  return async ({ input, env, post }) => {
    if (!env.FTOWN_SESSION_ID) return { status: 'ok' };

    const parsed = parseMuseNative(input);
    if (!parsed.ok) return { status: 'error', error: parsed.error };
    const payload: MuseToolHookPayload = {
      ftown_session_id: env.FTOWN_SESSION_ID,
      hook_event_name,
      ...(typeof parsed.native.tool_name === 'string' ? { tool_name: parsed.native.tool_name } : {}),
      ...(typeof parsed.native.tool_use_id === 'string' ? { tool_use_id: parsed.native.tool_use_id } : {}),
    };
    return fromPostResult(await post(payload));
  };
}

export const musePreToolUseAdapter: HookAdapter = museToolAdapter('PreToolUse');
export const musePostToolUseAdapter: HookAdapter = museToolAdapter('PostToolUse');

interface MailMessage {
  ts?: unknown;
  from?: unknown;
  fromName?: unknown;
  type?: unknown;
  body?: unknown;
}

interface SecureProxyResult {
  stdout: string;
  exitCode: number;
}

/** One encrypted local API request through the same CLI the old shell helper used. */
function runSecureProxy(cli: string, request: string, env: HookEnvironment): Promise<SecureProxyResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ['security', 'proxy'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const finish = (result: SecureProxyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (stdout.length < 1_048_576) stdout += chunk; });
    child.stdin.on('error', () => { /* a CLI that exits early closes the pipe; the result still settles */ });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => finish({ stdout, exitCode: code ?? 1 }));
    child.stdin.end(request);
  });
}

/** The installed `ftown` CLI is the secure bridge client; HOME keeps tests isolated. */
function resolveSecureCli(env: HookEnvironment): string | undefined {
  const homeCli = env.HOME ? join(env.HOME, '.ftown', 'bin', 'ftown') : undefined;
  if (homeCli && existsSync(homeCli)) return homeCli;
  return 'ftown';
}

/**
 * Stop posts the hook first, then drains the inbox once (wait=0, marks
 * delivered). Pending mail is emitted as hookSpecificOutput.additionalContext;
 * an empty inbox, a down bridge or a missing CLI leaves stdout untouched. Best
 * effort: a mail failure never turns into a hook error.
 */
async function drainMuseMail(env: HookEnvironment, sessionId: string): Promise<string | undefined> {
  const cli = resolveSecureCli(env);
  if (!cli) return undefined;
  const request = JSON.stringify({
    method: 'GET',
    path: `/api/sessions/${encodeURIComponent(sessionId)}/inbox?wait=0`,
    timeoutMs: 2000,
  });
  try {
    const { stdout, exitCode } = await runSecureProxy(cli, request, env);
    if (exitCode !== 0) return undefined;
    const parsed = JSON.parse(stdout) as { status?: unknown; body?: { messages?: unknown } };
    if (!parsed || typeof parsed.status !== 'number' || parsed.status < 200 || parsed.status >= 300) return undefined;
    const messages = parsed.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    const formatted = messages.map((raw) => {
      const message = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as MailMessage;
      const from = (typeof message.fromName === 'string' && message.fromName)
        || (typeof message.from === 'string' && message.from) || 'external';
      const type = typeof message.type === 'string' ? message.type : 'message';
      const body = typeof message.body === 'string' ? message.body : '';
      return `[${nativeString(message.ts)}] ${from} (${type}): ${body}`;
    }).join('\n');
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: `[ftown mail]\n${formatted}`,
      },
    });
  } catch {
    return undefined;
  }
}

/** Muse Stop — posts the typed envelope, then drains mail into stdout. */
export const museStopAdapter: HookAdapter = async ({ input, env, post }) => {
  if (!env.FTOWN_SESSION_ID) return { status: 'ok' };

  const parsed = parseMuseNative(input);
  if (!parsed.ok) return { status: 'error', error: parsed.error };
  const payload: MuseStopHookPayload = {
    ftown_session_id: env.FTOWN_SESSION_ID,
    ftown_session_source: 'env',
    hook_event_name: 'Stop',
    session_id: nativeString(parsed.native.session_id),
    cwd: nativeString(parsed.native.cwd),
  };
  const result = await post(payload);
  const stdout = await drainMuseMail(env, env.FTOWN_SESSION_ID);
  const adapterResult = fromPostResult(result);
  return stdout === undefined ? adapterResult : { ...adapterResult, stdout };
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
 * Adapter registry for all implemented hook kinds.
 */
export const HOOK_ADAPTERS: Readonly<Partial<Record<HookKind, HookAdapter>>> = Object.freeze({
  'muse-session-start': museSessionStartAdapter,
  grok: grokHookAdapter,
  'muse-user-prompt-submit': museUserPromptSubmitAdapter,
  'muse-pre-tool-use': musePreToolUseAdapter,
  'muse-post-tool-use': musePostToolUseAdapter,
  'muse-stop': museStopAdapter,
  notify: notifyAdapter,
  antigravity: antigravityAdapter,
});
