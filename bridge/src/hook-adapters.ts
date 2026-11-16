import type {
  HookAdapter,
  HookKind,
  JsonObject,
  MuseSessionStartHookPayload,
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
 * Adapter registry. The four later porting tasks add one entry each and extend
 * IMPLEMENTED_HOOK_KINDS in the contract; they do not change the runner.
 */
export const HOOK_ADAPTERS: Readonly<Partial<Record<HookKind, HookAdapter>>> = Object.freeze({
  'muse-session-start': museSessionStartAdapter,
});
