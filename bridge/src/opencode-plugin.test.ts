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
      if (url.includes('/inbox')) {
        // Peek sees the mail; the post-injection mark returns an empty box.
        const messages = url.includes('peek=1')
          ? [{ from: 'parent-id', fromName: 'Planner', type: 'task', body: 'Review the API' }]
          : [];
        return { ok: true, json: async () => ({ messages }) };
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
    assert.equal(requests.length, 5);
    assert.deepEqual(JSON.parse(String(requests[2].init?.body)), {
      ftown_session_id: 'ftown-session',
      ftown_session_source: 'env',
      hook_event_name: 'Stop',
      session_id: 'ses_1',
    });
    // Peek before injecting, mark delivered only after the prompt was accepted.
    assert.ok(requests[3].url.includes('peek=1'));
    assert.ok(requests[4].url.endsWith('/inbox?wait=0'));
    assert.ok(requests[4].url !== requests[3].url);
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

  it('message.updated never captures a message id as the session id (regression)', async () => {
    const promptCalls: Array<{ path: { id: string }; body: unknown }> = [];
    const client = makeClient(promptCalls);
    const hookBodies: Record<string, unknown>[] = [];
    const hooks = registerFtownOpencodePlugin(client as any, {
      env: { FTOWN_SESSION_ID: 'ftown-session', FTOWN_HOOK_PORT: '4321' },
      // No session.created event: capture must come from message.updated's
      // info.sessionID, never from info.id (a msg_… message id).
      fetch: (async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/hook')) {
          hookBodies.push(JSON.parse(String(init?.body)));
          return { ok: true, json: async () => ({ ok: true }) };
        }
        return { ok: true, json: async () => ({ messages: [] }) };
      }) as any,
      readBridgePointer: async () => null,
    });

    await hooks.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'msg_wrong', sessionID: 'ses_right', role: 'user' } },
      },
    });
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_right' } } });

    assert.equal(hookBodies.length, 2);
    assert.equal(hookBodies[0].session_id, 'ses_right');
    assert.equal(hookBodies[0].hook_event_name, 'UserPromptSubmit');
    assert.equal(hookBodies[1].session_id, 'ses_right');
  });

  it('treats session.status busy as activity and idle as a turn boundary', async () => {
    const promptCalls: Array<{ path: { id: string }; body: unknown }> = [];
    const client = makeClient(promptCalls);
    const requests: RecordedRequest[] = [];
    const hooks = registerFtownOpencodePlugin(client as any, {
      env: { FTOWN_SESSION_ID: 'ftown-session', FTOWN_HOOK_PORT: '4321' },
      fetch: (async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (url.includes('/inbox')) {
          const messages = url.includes('peek=1')
            ? [{ from: 'parent-id', type: 'task', body: 'check this' }]
            : [];
          return { ok: true, json: async () => ({ messages }) };
        }
        return { ok: true, json: async () => ({ ok: true }) };
      }) as any,
      readBridgePointer: async () => null,
    });

    // v1.18.x fires session.status instead of session.idle.
    await hooks.event({
      event: { type: 'session.status', properties: { sessionID: 'ses_7', status: { type: 'busy' } } },
    });
    await hooks.event({
      event: { type: 'session.status', properties: { sessionID: 'ses_7', status: { type: 'idle' } } },
    });

    const hookEvents = requests
      .filter((request) => request.url.endsWith('/hook'))
      .map((request) => JSON.parse(String(request.init?.body)).hook_event_name);
    assert.deepEqual(hookEvents, ['PreToolUse', 'Stop']);
    assert.equal(promptCalls.length, 1);
    assert.deepEqual(promptCalls[0].path, { id: 'ses_7' });
  });

  it('delivers mail once when status(idle) and idle both fire for the same boundary', async () => {
    const promptCalls: Array<{ path: { id: string }; body: unknown }> = [];
    let inboxReads = 0;
    let delivered = false;
    const hooks = registerFtownOpencodePlugin(makeClient(promptCalls) as any, {
      env: { FTOWN_SESSION_ID: 'ftown-session', FTOWN_HOOK_PORT: '4321' },
      fetch: (async (url: string) => {
        if (String(url).includes('/inbox')) {
          inboxReads += 1;
          if (!url.includes('peek=1')) {
            // The post-injection mark: mail leaves the queue.
            delivered = true;
            return { ok: true, json: async () => ({ messages: [] }) };
          }
          // Peeks that start before the mark see the mail; later ones don't.
          // Unserialized concurrent boundaries would both peek it and inject
          // it twice.
          const undelivered = delivered ? [] : [{ from: 'x', body: 'hi' }];
          return new Promise((resolve) => {
            setTimeout(() => resolve({ ok: true, json: async () => ({ messages: undelivered }) }), 5);
          });
        }
        return { ok: true, json: async () => ({ ok: true }) };
      }) as any,
      readBridgePointer: async () => null,
    });

    await Promise.all([
      hooks.event({ event: { type: 'session.status', properties: { sessionID: 'ses_2', status: { type: 'idle' } } } }),
      hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_2' } } }),
    ]);

    assert.ok(inboxReads >= 3);
    assert.equal(promptCalls.length, 1);
  });

  it('a failed prompt injection leaves mail queued (no mark, retried next boundary)', async () => {
    const promptCalls: Array<{ path: { id: string }; body: unknown }> = [];
    let markRequests = 0;
    const failingClient = {
      session: {
        prompt: async () => {
          throw new Error('opencode server rejected the prompt');
        },
      },
    };
    const hooks = registerFtownOpencodePlugin(failingClient as any, {
      env: { FTOWN_SESSION_ID: 'ftown-session', FTOWN_HOOK_PORT: '4321' },
      fetch: (async (url: string) => {
        if (String(url).includes('/inbox')) {
          if (!url.includes('peek=1')) markRequests += 1;
          return { ok: true, json: async () => ({ messages: [{ from: 'x', body: 'hi' }] }) };
        }
        return { ok: true, json: async () => ({ ok: true }) };
      }) as any,
      readBridgePointer: async () => null,
    });

    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_3' } } } });
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_3' } } });
    // Second boundary retries — still no mark on failure.
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_3' } } });

    assert.equal(promptCalls.length, 0);
    assert.equal(markRequests, 0);
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
