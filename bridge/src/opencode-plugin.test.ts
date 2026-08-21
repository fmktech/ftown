import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { registerFtownOpencodePlugin } from '../opencode-plugin/ftown.js';

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

function makeClient(promptCalls: Array<{ path: { id: string }; body: unknown }> = []) {
  return {
    session: {
      prompt: async (call: { path: { id: string }; body: unknown }) => {
        promptCalls.push(call);
        return { data: {} };
      },
    },
  };
}

describe('ftown opencode plugin', () => {
  it('forwards lifecycle hooks to the bridge and delivers mail as a new prompt at turn end', async () => {
    const promptCalls: Array<{ path: { id: string }; body: unknown }> = [];
    const client = makeClient(promptCalls);
    const requests: RecordedRequest[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith('/inbox?wait=0')) {
        return {
          ok: true,
          json: async () => ({
            messages: [{ from: 'parent-id', fromName: 'Planner', type: 'task', body: 'Review the API' }],
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    const hooks = registerFtownOpencodePlugin(client as any, {
      env: {
        FTOWN_SESSION_ID: 'ftown-session',
        FTOWN_HOOK_PORT: '4321',
        FTOWN_HOOK_TOKEN: 'secret',
      },
      fetch: fetchImpl as any,
      readBridgePointer: async () => null,
    });

    // Session creation captures the opencode-native id and announces start.
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_1' } } } });
    assert.equal(requests[0].url, 'http://127.0.0.1:4321/hook');
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
      ftown_session_id: 'ftown-session',
      ftown_session_source: 'env',
      hook_event_name: 'SessionStart',
      session_id: 'ses_1',
    });

    // A user message marks the agent busy.
    await hooks.event({
      event: { type: 'message.updated', properties: { info: { id: 'msg_1', role: 'user', sessionID: 'ses_1' } } },
    });

    // Turn end posts Stop, then drains mail into a new prompt on the same session.
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
    assert.equal(requests.length, 4);
    assert.deepEqual(JSON.parse(String(requests[2].init?.body)), {
      ftown_session_id: 'ftown-session',
      ftown_session_source: 'env',
      hook_event_name: 'Stop',
      session_id: 'ses_1',
    });
    assert.ok(requests[3].url.endsWith('/inbox?wait=0'));
    assert.equal(promptCalls.length, 1);
    assert.deepEqual(promptCalls[0].path, { id: 'ses_1' });
    const parts = (promptCalls[0].body as { parts: Array<{ type: string; text: string }> }).parts;
    assert.match(parts[0].text, /\[ftown mail\]/);
    assert.match(parts[0].text, /\[task from Planner \(parent-id\)\] Review the API/);

    // The hook request carried the bridge token when one is configured.
    const headers = new Headers(requests[0].init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer secret');
  });

  it('is inert without FTOWN_SESSION_ID (no requests, no prompts)', async () => {
    const promptCalls: Array<{ path: { id: string }; body: unknown }> = [];
    const client = makeClient(promptCalls);
    let requestCount = 0;
    const hooks = registerFtownOpencodePlugin(client as any, {
      env: {},
      fetch: async () => {
        requestCount += 1;
        throw new Error('should not be called');
      },
      readBridgePointer: async () => null,
    });

    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });

    assert.equal(requestCount, 0);
    assert.equal(promptCalls.length, 0);
  });

  it('never lets handler failures escape into the agent TUI', async () => {
    const hooks = registerFtownOpencodePlugin(makeClient() as any, {
      env: { FTOWN_SESSION_ID: 'ftown-session', FTOWN_HOOK_PORT: '4321' },
      fetch: async () => {
        throw new Error('bridge unreachable');
      },
      readBridgePointer: async () => null,
    });

    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_1' } } } });
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
  });

  it('skips mail delivery when the inbox is empty', async () => {
    const promptCalls: Array<{ path: { id: string }; body: unknown }> = [];
    const client = makeClient(promptCalls);
    const requests: RecordedRequest[] = [];
    const hooks = registerFtownOpencodePlugin(client as any, {
      env: { FTOWN_SESSION_ID: 'ftown-session', FTOWN_HOOK_PORT: '4321' },
      fetch: (async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (url.endsWith('/inbox?wait=0')) {
          return { ok: true, json: async () => ({ messages: [] }) };
        }
        return { ok: true, json: async () => ({ ok: true }) };
      }) as any,
      readBridgePointer: async () => null,
    });

    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_9' } } } });
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_9' } } });

    assert.equal(promptCalls.length, 0);
    assert.equal(requests.filter((request) => request.url.endsWith('/hook')).length, 2);
  });
});
