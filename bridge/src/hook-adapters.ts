import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HookAdapter,
  HookAdapterResult,
  HookEnvironment,
  HookFailure,
  HookKind,
  HookPostResult,
  HookSessionSource,
  JsonObject,
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
 * Adapter registry. All five Muse native events and notify are ported; the
 * remaining grok/antigravity kinds still fail visibly in the runner.
 */
export const HOOK_ADAPTERS: Readonly<Partial<Record<HookKind, HookAdapter>>> = Object.freeze({
  'muse-session-start': museSessionStartAdapter,
  'muse-user-prompt-submit': museUserPromptSubmitAdapter,
  'muse-pre-tool-use': musePreToolUseAdapter,
  'muse-post-tool-use': musePostToolUseAdapter,
  'muse-stop': museStopAdapter,
  notify: notifyAdapter,
});
