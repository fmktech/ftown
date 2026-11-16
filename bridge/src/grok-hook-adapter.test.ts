import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { grokHookAdapter } from './grok-hook-adapter.js';
import type { HookAdapterContext, HookWirePayload } from './hook-contract.js';

function context(input: string, env: HookAdapterContext['env'] = { FTOWN_SESSION_ID: 'owner' }) {
  const payloads: HookWirePayload[] = [];
  const ctx: HookAdapterContext = {
    kind: 'grok', input, env,
    post: async (payload) => { payloads.push(payload); return { ok: true, candidate: { port: 1, source: 'env' } }; },
  };
  return { ctx, payloads };
}

describe('grokHookAdapter', () => {
  it('translates native fields, preserves JSON tool values and omits nulls', async () => {
    const { ctx, payloads } = context(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: '', cwd: 4, tool_name: false, tool_input: { nested: [1] }, tool_use_id: null }), { FTOWN_SESSION_ID: 'owner', GROK_SESSION_ID: 'fallback' });
    assert.deepEqual(await grokHookAdapter(ctx), { status: 'ok' });
    assert.deepEqual(payloads, [{ ftown_session_id: 'owner', ftown_session_source: 'env', hook_event_name: 'PreToolUse', session_id: 'fallback', cwd: '', tool_name: false, tool_input: { nested: [1] } }]);
  });
  it('is inert without an owner, event, or for session shutdown', async () => {
    for (const [input, env] of [
      ['invalid', {}],
      ['{"hookEventName":"SessionStart"}', { FTOWN_SESSION_ID: 'owner', GROK_HOOK_EVENT: 'SessionStart' }],
      ['{"hook_event_name":"Stop","reason":"shutdown"}', { FTOWN_SESSION_ID: 'owner' }],
      ['{"hook_event_name":"Stop","reason":"channel_closed"}', { FTOWN_SESSION_ID: 'owner' }],
    ] as const) {
      const { ctx, payloads } = context(input, env);
      assert.deepEqual(await grokHookAdapter(ctx), { status: 'ok' });
      assert.deepEqual(payloads, []);
    }
  });
  it('reports invalid JSON and non-object input without posting', async () => {
    for (const [input, kind] of [['{', 'invalid-json'], ['[]', 'invalid-input']] as const) {
      const { ctx, payloads } = context(input);
      const result = await grokHookAdapter(ctx);
      assert.equal(result.status, 'error');
      if (result.status === 'error') assert.equal(result.error.kind, kind);
      assert.deepEqual(payloads, []);
    }
  });
  it('returns a sanitized transport failure', async () => {
    const { ctx } = context('{"hook_event_name":"SessionStart"}');
    const result = await grokHookAdapter({ ...ctx, post: async () => ({ ok: false, error: { kind: 'delivery-failed', message: 'delivery failed', attempts: [] } }) });
    assert.deepEqual(result, { status: 'error', error: { kind: 'delivery-failed', message: 'delivery failed' } });
  });
});
