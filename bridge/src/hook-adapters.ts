import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HookAdapter,
  HookKind,
  HookSessionSource,
  JsonObject,
  MuseSessionStartHookPayload,
  NotifyHookPayload,
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
 * Adapter registry. The four later porting tasks add one entry each and extend
 * IMPLEMENTED_HOOK_KINDS in the contract; they do not change the runner.
 */
export const HOOK_ADAPTERS: Readonly<Partial<Record<HookKind, HookAdapter>>> = Object.freeze({
  'muse-session-start': museSessionStartAdapter,
  notify: notifyAdapter,
});
