import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { registerFtownPiExtension } from '../pi-extension/ftown.js';

describe('ftown Pi extension', () => {
  async function waitFor(predicate: () => boolean, message: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (predicate()) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail(message);
  }

  it('registers provider-compatible object schemas for every ftown tool', () => {
    const tools: any[] = [];
    const pi = {
      on() {}, sendUserMessage() {}, registerCommand() {},
      registerTool(tool: any) { tools.push(tool); },
    };

    registerFtownPiExtension(pi, {
      env: {},
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      readBridgePointer: async () => null,
    });

    assert.deepEqual(tools.map((tool) => tool.name), [
      'ftown_ask_user',
      'ftown_mail',
      'ftown_sessions',
      'ftown_session_create',
      'ftown_session_manage',
      'ftown_loops',
    ]);
    for (const tool of tools) {
      assert.equal(tool.parameters.type, 'object', `${tool.name} must have an object schema`);
      for (const keyword of ['oneOf', 'anyOf', 'allOf', 'enum', 'const', 'not']) {
        assert.equal(
          Object.hasOwn(tool.parameters, keyword),
          false,
          `${tool.name} must not use top-level ${keyword}`,
        );
      }
    }
  });

  it('offers a native blocking user-input tool', async () => {
    const tools = new Map<string, any>();
    const prompts: Array<{ question: string; options: string[] }> = [];
    const pi = {
      on() {}, sendUserMessage() {}, registerCommand() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    };

    registerFtownPiExtension(pi, {
      env: {},
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      readBridgePointer: async () => null,
    });

    const result = await tools.get('ftown_ask_user').execute(
      'ask-1',
      { question: 'Which environment?', options: ['staging', 'production'] },
      undefined,
      undefined,
      {
        ui: {
          async select(question: string, options: string[]) {
            prompts.push({ question, options });
            return 'staging';
          },
        },
      },
    );

    assert.deepEqual(prompts, [{
      question: 'Which environment?',
      options: ['staging', 'production'],
    }]);
    assert.deepEqual(result.details, { answer: 'staging' });
  });

  it('rejects incomplete operation-specific arguments before making bridge requests', async () => {
    const tools = new Map<string, any>();
    let requestCount = 0;
    const pi = {
      on() {}, sendUserMessage() {}, registerCommand() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    };

    registerFtownPiExtension(pi, {
      env: { FTOWN_SESSION_ID: 'self' },
      fetch: async () => {
        requestCount += 1;
        return { ok: true, json: async () => ({}) };
      },
      readBridgePointer: async () => null,
    });

    const cases = [
      ['ftown_mail', { operation: 'send', target: 'worker' }, /body is required/],
      ['ftown_sessions', { operation: 'grep', target: 'worker' }, /pattern is required/],
      ['ftown_session_manage', { operation: 'rename', target: 'worker' }, /name is required/],
      ['ftown_session_manage', { operation: 'reparent', target: 'worker' }, /parent is required/],
      ['ftown_loops', { operation: 'create', name: 'Review', task: 'Review work' }, /schedule is required/],
      ['ftown_loops', { operation: 'update', target: 'Review' }, /field to update is required/],
      ['ftown_loops', {
        operation: 'create', name: 'Review', task: 'Review work',
        schedule: { kind: 'interval' },
      }, /schedule.everyMs is required/],
      ['ftown_loops', {
        operation: 'create', name: 'Review', task: 'Review work',
        schedule: { kind: 'cron' },
      }, /schedule.expression is required/],
    ] as const;

    for (const [toolName, params, expected] of cases) {
      const result = await tools.get(toolName).execute(`invalid-${toolName}`, params);
      assert.equal(result.isError, true, `${toolName} should reject incomplete arguments`);
      assert.match(result.details.error, expected);
    }
    assert.equal(requestCount, 0);
  });

  it('forwards native lifecycle metadata and turns pending mail into a follow-up', async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const followUps: string[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const pi = {
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
        handlers.set(event, handler);
      },
      sendUserMessage(message: string) {
        followUps.push(message);
      },
      registerTool() {},
      registerCommand() {},
    };
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

    registerFtownPiExtension(pi, {
      env: {
        FTOWN_SESSION_ID: 'ftown-session',
        FTOWN_HOOK_PORT: '4321',
        FTOWN_HOOK_TOKEN: 'secret',
      },
      fetch: fetchImpl,
      readBridgePointer: async () => null,
    });

    const ctx = {
      sessionManager: {
        getSessionId: () => 'pi-session-uuid',
        getSessionFile: () => '/tmp/pi-session.jsonl',
        getCwd: () => '/tmp/project',
        getBranch: () => [{
          type: 'message',
          message: {
            role: 'assistant',
            provider: 'openai',
            model: 'gpt-5',
            usage: { input: 77, output: 9, cacheRead: 3, cacheWrite: 1 },
          },
        }],
      },
    };
    await handlers.get('agent_settled')?.({}, ctx);

    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'http://127.0.0.1:4321/hook');
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
      ftown_session_id: 'ftown-session',
      ftown_session_source: 'env',
      hook_event_name: 'Stop',
      session_id: 'pi-session-uuid',
      session_file: '/tmp/pi-session.jsonl',
      cwd: '/tmp/project',
      usage: {
        inputTokens: 77,
        outputTokens: 9,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
        totalTokens: 90,
        models: ['openai/gpt-5'],
        perModel: [{
          model: 'openai/gpt-5',
          inputTokens: 77,
          outputTokens: 9,
          cacheReadTokens: 3,
          cacheWriteTokens: 1,
        }],
        harness: 'pi',
      },
    });
    assert.equal(requests[0].init?.headers instanceof Headers, true);
    assert.equal((requests[0].init?.headers as Headers).get('authorization'), 'Bearer secret');
    assert.equal(
      requests[1].url,
      'http://127.0.0.1:4321/api/sessions/ftown-session/inbox?wait=0',
    );
    assert.deepEqual(followUps, [
      '[ftown mail]\n[task from Planner (parent-id)] Review the API\nHandle this message and reply with the `ftown_mail` tool where appropriate.',
    ]);
  });

  it('long-polls for mail and wakes an idle Pi session with a native follow-up', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown>>();
    const followUps: Array<{ message: string; options: unknown }> = [];
    const inboxRequests: Array<{ url: string; signal?: AbortSignal }> = [];
    let inboxRequestCount = 0;
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<unknown>) {
        handlers.set(event, handler);
      },
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
      registerTool() {},
      registerCommand() {},
    };
    const fetchImpl = async (url: string, init?: RequestInit): Promise<any> => {
      if (url.includes('/inbox?')) {
        inboxRequests.push({ url, signal: init?.signal ?? undefined });
        inboxRequestCount += 1;
        if (inboxRequestCount === 1) {
          return {
            ok: true,
            json: async () => ({
              messages: [{ from: 'planner-id', fromName: 'Planner', type: 'task', body: 'Wake up' }],
            }),
          };
        }
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };
    registerFtownPiExtension(pi, {
      env: { FTOWN_SESSION_ID: 'ftown-session', FTOWN_HOOK_PORT: '4321' },
      fetch: fetchImpl,
      readBridgePointer: async () => null,
    });
    const ctx = {
      sessionManager: {
        getSessionId: () => 'pi-session-uuid',
        getSessionFile: () => '/tmp/pi-session.jsonl',
        getCwd: () => '/tmp/project',
      },
    };

    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);
    await waitFor(() => followUps.length === 1, 'mail did not wake the idle Pi session');

    assert.equal(
      inboxRequests[0]?.url,
      'http://127.0.0.1:4321/api/sessions/ftown-session/inbox?wait=30',
    );
    assert.deepEqual(followUps, [{
      message: '[ftown mail]\n[task from Planner (planner-id)] Wake up\nHandle this message and reply with the `ftown_mail` tool where appropriate.',
      options: { deliverAs: 'followUp' },
    }]);

    await handlers.get('session_start')?.({ reason: 'resume' }, ctx);
    await handlers.get('agent_settled')?.({}, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      inboxRequests.length,
      2,
      'repeated starts and agent settlement must reuse the active listener',
    );

    await handlers.get('session_shutdown')?.({ reason: 'quit' }, ctx);
    assert.equal(inboxRequests[1]?.signal?.aborted, true, 'shutdown must abort the active listener');
    await handlers.get('session_start')?.({ reason: 'resume-after-shutdown' }, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(inboxRequests.length, 2, 'shutdown must permanently close the listener');
    assert.equal(followUps.length, 1, 'mail must be injected exactly once');
  });

  it('backs off repeated listener failures and stops retrying on shutdown', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown>>();
    const delays: number[] = [];
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<unknown>) {
        handlers.set(event, handler);
      },
      sendUserMessage() {},
      registerTool() {},
      registerCommand() {},
    };
    registerFtownPiExtension(pi, {
      env: { FTOWN_SESSION_ID: 'ftown-session', FTOWN_HOOK_PORT: '4321' },
      fetch: async (url: string) => {
        if (url.endsWith('/hook')) return { ok: true, json: async () => ({ ok: true }) };
        throw new Error('bridge unavailable');
      },
      readBridgePointer: async () => null,
      mailWakeIdleDelayMs: 100,
      mailWakeMaxRetryDelayMs: 400,
      delay: async (ms: number, signal: AbortSignal) => {
        delays.push(ms);
        if (delays.length < 4) return;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });
    const ctx = {
      sessionManager: {
        getSessionId: () => 'pi-session-uuid',
        getSessionFile: () => '/tmp/pi-session.jsonl',
        getCwd: () => '/tmp/project',
      },
    };

    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);
    await waitFor(() => delays.length === 4, 'listener did not retry bridge failures');
    assert.deepEqual(delays, [100, 200, 400, 400]);

    await handlers.get('session_shutdown')?.({ reason: 'quit' }, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(delays.length, 4);
  });

  it('maps Pi session, prompt, and tool events onto ftown hook events', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown>>();
    const hookPayloads: Array<Record<string, unknown>> = [];
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<unknown>) {
        handlers.set(event, handler);
      },
      sendUserMessage() {},
      registerTool() {},
      registerCommand() {},
    };
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      if (init?.body) hookPayloads.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ messages: [] }) };
    };
    registerFtownPiExtension(pi, {
      env: { FTOWN_SESSION_ID: 'ftown-session', FTOWN_HOOK_PORT: '4321' },
      fetch: fetchImpl,
      readBridgePointer: async () => null,
    });
    const ctx = {
      sessionManager: {
        getSessionId: () => 'pi-session-uuid',
        getSessionFile: () => '/tmp/pi-session.jsonl',
        getCwd: () => '/tmp/project',
      },
    };

    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);
    await handlers.get('before_agent_start')?.({ prompt: 'Ship it' }, ctx);
    await handlers.get('tool_execution_start')?.(
      { toolCallId: 'call-1', toolName: 'bash', args: { command: 'npm test' } },
      ctx,
    );
    await handlers.get('tool_execution_end')?.(
      { toolCallId: 'call-1', toolName: 'bash', isError: false },
      ctx,
    );
    await handlers.get('session_shutdown')?.({ reason: 'quit' }, ctx);

    assert.deepEqual(
      hookPayloads.map((payload) => payload.hook_event_name),
      ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd'],
    );
    assert.deepEqual(hookPayloads[2], {
      ftown_session_id: 'ftown-session',
      ftown_session_source: 'env',
      hook_event_name: 'PreToolUse',
      session_id: 'pi-session-uuid',
      session_file: '/tmp/pi-session.jsonl',
      cwd: '/tmp/project',
      tool_call_id: 'call-1',
      tool_name: 'bash',
      tool_input: { command: 'npm test' },
    });
    assert.equal(hookPayloads[3].is_error, false);
  });

  it('registers model-callable ftown tools and sends mail through the local API', async () => {
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const pi = {
      on() {},
      sendUserMessage() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
    };
    const fetchImpl = async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith('/api/sessions')) {
        return {
          ok: true,
          json: async () => ({ sessions: [
            { id: 'ftown-session', name: 'Pi worker', status: 'running' },
            { id: 'target-id', name: 'Planner', status: 'running' },
          ] }),
        };
      }
      return { ok: true, json: async () => ({ id: 'mail-1' }) };
    };

    registerFtownPiExtension(pi, {
      env: { FTOWN_SESSION_ID: 'ftown-session', FTOWN_HOOK_PORT: '4321' },
      fetch: fetchImpl,
      readBridgePointer: async () => null,
    });

    assert.equal(tools.has('ftown_mail'), true);
    assert.equal(commands.has('ftown-mail'), true);

    const result = await tools.get('ftown_mail').execute(
      'call-1',
      { operation: 'send', target: 'Planner', body: 'Please review', type: 'task' },
    );
    const retried = await tools.get('ftown_mail').execute(
      'call-1',
      { operation: 'send', target: 'Planner', body: 'Please review', type: 'task' },
    );

    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, 'http://127.0.0.1:4321/api/sessions/target-id/inbox');
    assert.deepEqual(JSON.parse(String(requests[1].init?.body)), {
      body: 'Please review',
      type: 'task',
      from: 'ftown-session',
      fromName: 'Pi worker',
    });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /mail-1/);
    assert.deepEqual(retried, result);
  });

  it('lists ftown sessions through a model tool and slash command', async () => {
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const notifications: string[] = [];
    const sessions = [
      { id: 's1', name: 'Planner', status: 'running', shellType: 'claude' },
      { id: 's2', name: 'Worker', status: 'completed', shellType: 'pi' },
    ];
    const pi = {
      on() {}, sendUserMessage() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
    };
    registerFtownPiExtension(pi, {
      env: { FTOWN_SESSION_ID: 's2', FTOWN_HOOK_PORT: '4321' },
      fetch: async () => ({ ok: true, json: async () => ({ sessions }) }),
      readBridgePointer: async () => null,
    });

    const result = await tools.get('ftown_sessions').execute('call-list', { operation: 'list' });
    assert.deepEqual(result.details, { sessions });

    await commands.get('ftown-sessions').handler('', {
      ui: { notify(message: string) { notifications.push(message); } },
    });
    assert.match(notifications[0], /Planner/);
    assert.match(notifications[0], /Worker/);
  });

  it('filters the native session list with a case-insensitive pattern', async () => {
    const tools = new Map<string, any>();
    const sessions = [
      { id: 's1', name: 'Release Planner', status: 'running', shellType: 'claude' },
      { id: 's2', name: 'API worker', status: 'completed', shellType: 'pi' },
      { id: 's3', name: 'UI worker', status: 'running', shellType: 'codex' },
    ];
    const pi = {
      on() {}, sendUserMessage() {}, registerCommand() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    };
    registerFtownPiExtension(pi, {
      env: { FTOWN_SESSION_ID: 's2', FTOWN_HOOK_PORT: '4321' },
      fetch: async () => ({ ok: true, json: async () => ({ sessions }) }),
      readBridgePointer: async () => null,
    });

    const result = await tools.get('ftown_sessions').execute(
      'call-filtered-list', { operation: 'list', pattern: 'planner|CODEX' },
    );

    assert.deepEqual(result.details, { sessions: [sessions[0], sessions[2]] });
  });

  it('lists children of the current Pi session natively', async () => {
    const tools = new Map<string, any>();
    const sessions = [
      { id: 'self', name: 'Orchestrator', status: 'running', shellType: 'pi' },
      { id: 'child-1', name: 'Reviewer', parentSessionId: 'self', status: 'running' },
      { id: 'child-2', name: 'Tester', parentSessionId: 'self', status: 'completed' },
      { id: 'other', name: 'Unrelated', parentSessionId: 'another-session', status: 'running' },
    ];
    const pi = {
      on() {}, sendUserMessage() {}, registerCommand() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    };
    registerFtownPiExtension(pi, {
      env: { FTOWN_SESSION_ID: 'self', FTOWN_HOOK_PORT: '4321' },
      fetch: async () => ({ ok: true, json: async () => ({ sessions }) }),
      readBridgePointer: async () => null,
    });

    const result = await tools.get('ftown_sessions').execute(
      'call-children', { operation: 'children' },
    );

    assert.deepEqual(result.details, { sessions: [sessions[1], sessions[2]] });
  });

  it('filters children of an explicitly targeted parent session', async () => {
    const tools = new Map<string, any>();
    const sessions = [
      { id: 'manager', name: 'Release manager', status: 'running' },
      { id: 'review', name: 'Security Reviewer', parentSessionId: 'manager', status: 'running' },
      { id: 'test', name: 'Test worker', parentSessionId: 'manager', status: 'running' },
      { id: 'self', name: 'Pi', status: 'running', shellType: 'pi' },
    ];
    const pi = {
      on() {}, sendUserMessage() {}, registerCommand() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    };
    registerFtownPiExtension(pi, {
      env: { FTOWN_SESSION_ID: 'self', FTOWN_HOOK_PORT: '4321' },
      fetch: async () => ({ ok: true, json: async () => ({ sessions }) }),
      readBridgePointer: async () => null,
    });

    const result = await tools.get('ftown_sessions').execute(
      'call-filtered-children',
      { operation: 'children', target: 'Release manager', pattern: 'security|codex' },
    );

    assert.deepEqual(result.details, { sessions: [sessions[1]] });
  });

  it('retries a refreshed bridge token when a restarted bridge reuses the same port', async () => {
    const tools = new Map<string, any>();
    const authorizations: Array<string | null> = [];
    const pi = {
      on() {}, sendUserMessage() {}, registerCommand() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    };
    registerFtownPiExtension(pi, {
      env: {
        FTOWN_SESSION_ID: 'self', FTOWN_HOOK_PORT: '4321', FTOWN_HOOK_TOKEN: 'stale-token',
      },
      fetch: async (_url: string, init?: RequestInit) => {
        const authorization = (init?.headers as Headers).get('authorization');
        authorizations.push(authorization);
        if (authorization === 'Bearer stale-token') {
          return { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) };
        }
        return { ok: true, json: async () => ({ sessions: [{ id: 's1', name: 'Worker' }] }) };
      },
      readBridgePointer: async () => ({ port: 4321, token: 'fresh-token' }),
    });

    const result = await tools.get('ftown_sessions').execute('list-call', { operation: 'list' });

    assert.equal(result.isError, undefined);
    assert.equal(result.details.sessions[0].id, 's1');
    assert.deepEqual(authorizations, ['Bearer stale-token', 'Bearer fresh-token']);
  });

  it('inspects a session usage and terminal log without terminal injection', async () => {
    const tools = new Map<string, any>();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const pi = {
      on() {}, sendUserMessage() {}, registerCommand() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    };
    const fetchImpl = async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith('/api/sessions')) {
        return { ok: true, json: async () => ({ sessions: [{ id: 's1', name: 'Worker' }] }) };
      }
      if (url.endsWith('/usage')) {
        return { ok: true, json: async () => ({ usage: { totalTokens: 123 } }) };
      }
      return { ok: true, json: async () => ({ matches: [{ lineNumber: 7, text: 'tests passed' }] }) };
    };
    registerFtownPiExtension(pi, {
      env: { FTOWN_SESSION_ID: 'self', FTOWN_HOOK_PORT: '4321' },
      fetch: fetchImpl,
      readBridgePointer: async () => null,
    });

    const usage = await tools.get('ftown_sessions').execute(
      'usage-call', { operation: 'usage', target: 'Worker' },
    );
    const grep = await tools.get('ftown_sessions').execute(
      'grep-call', { operation: 'grep', target: 's1', pattern: 'passed', limit: 10, context: 2 },
    );

    assert.equal(usage.details.usage.totalTokens, 123);
    assert.equal(requests[1].url, 'http://127.0.0.1:4321/api/sessions/s1/usage');
    assert.equal(requests[3].url, 'http://127.0.0.1:4321/api/sessions/s1/grep');
    assert.deepEqual(JSON.parse(String(requests[3].init?.body)), {
      pattern: 'passed', offset: 0, limit: 10, context: 2,
    });
    assert.match(grep.content[0].text, /tests passed/);
  });

  it('reports running state and lists archived sessions', async () => {
    const tools = new Map<string, any>();
    const requests: string[] = [];
    const pi = {
      on() {}, sendUserMessage() {}, registerCommand() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    };
    registerFtownPiExtension(pi, {
      env: { FTOWN_SESSION_ID: 'self', FTOWN_HOOK_PORT: '4321' },
      fetch: async (url: string) => {
        requests.push(url);
        if (url.endsWith('/api/archive')) {
          return { ok: true, json: async () => ({ archived: [{ id: 'old-1', name: 'Old worker' }] }) };
        }
        if (url.endsWith('/api/sessions')) {
          return { ok: true, json: async () => ({ sessions: [{ id: 's1', name: 'Worker' }] }) };
        }
        return { ok: true, json: async () => ({ sessionId: 's1', running: true }) };
      },
      readBridgePointer: async () => null,
    });

    const archived = await tools.get('ftown_sessions').execute(
      'archive-call', { operation: 'archive' },
    );
    const running = await tools.get('ftown_sessions').execute(
      'running-call', { operation: 'running', target: 'Worker' },
    );

    assert.equal(archived.details.archived[0].id, 'old-1');
    assert.equal(running.details.running, true);
    assert.equal(requests[0], 'http://127.0.0.1:4321/api/archive');
    assert.equal(requests[2], 'http://127.0.0.1:4321/api/sessions/s1/running');
  });

  it('creates a structured child session without arbitrary command or env injection', async () => {
    const tools = new Map<string, any>();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const pi = {
      on() {}, sendUserMessage() {}, registerCommand() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    };
    registerFtownPiExtension(pi, {
      env: {
        FTOWN_SESSION_ID: 'parent-id', FTOWN_HOOK_PORT: '4321', FTOWN_HOOK_TOKEN: 'secret',
      },
      fetch: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return { ok: true, json: async () => ({ session: { id: 'child-id', name: 'Reviewer' } }) };
      },
      readBridgePointer: async () => null,
    });

    const result = await tools.get('ftown_session_create').execute('create-call', {
      shell: 'pi', prompt: 'Review the API', workdir: '/tmp/project',
      model: 'openai/gpt-5', name: 'Reviewer', parent: true,
    });

    assert.equal(requests[0].url, 'http://127.0.0.1:4321/api/sessions');
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
      shellType: 'pi', prompt: 'Review the API', workingDir: '/tmp/project',
      model: 'openai/gpt-5', name: 'Reviewer', parentSessionId: true,
    });
    const requestHeaders = requests[0].init?.headers as Headers;
    assert.equal(requestHeaders.get('authorization'), 'Bearer secret');
    assert.equal(requestHeaders.get('x-ftown-session-id'), 'parent-id');
    assert.equal(result.details.session.id, 'child-id');
  });

  it('renames and stops sessions through the structured management tool', async () => {
    const tools = new Map<string, any>();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const executions: Array<{ command: string; args: string[] }> = [];
    const pi = {
      on() {}, sendUserMessage() {}, registerCommand() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
      async exec(command: string, args: string[]) {
        executions.push({ command, args });
        return { stdout: '{"stopped":true}', stderr: '', code: 0, killed: false };
      },
    };
    registerFtownPiExtension(pi, {
      env: { FTOWN_SESSION_ID: 'self', FTOWN_HOOK_PORT: '4321' },
      fetch: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (url.endsWith('/api/sessions')) {
          return { ok: true, json: async () => ({ sessions: [{ id: 's1', name: 'Worker' }] }) };
        }
        return { ok: true, json: async () => ({ session: { id: 's1', name: 'Reviewer' } }) };
      },
      readBridgePointer: async () => null,
    });

    const renamed = await tools.get('ftown_session_manage').execute(
      'rename-call', { operation: 'rename', target: 'Worker', name: 'Reviewer' },
    );
    const stopped = await tools.get('ftown_session_manage').execute(
      'stop-call', { operation: 'stop', target: 's1' },
    );

    assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { name: 'Reviewer' });
    assert.equal(renamed.details.session.name, 'Reviewer');
    assert.equal(executions[0].command.endsWith('/.ftown/ftown-sessions'), true);
    assert.deepEqual(executions[0].args, ['stop', 's1']);
    assert.equal(stopped.details.stopped, true);
  });

  it('revives an archived session through the management tool', async () => {
    const tools = new Map<string, any>();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const pi = {
      on() {}, sendUserMessage() {}, registerCommand() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    };
    registerFtownPiExtension(pi, {
      env: { FTOWN_SESSION_ID: 'self', FTOWN_HOOK_PORT: '4321' },
      fetch: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (url.endsWith('/api/archive')) {
          return { ok: true, json: async () => ({ archived: [{ id: 'old-1', name: 'Old worker' }] }) };
        }
        return { ok: true, json: async () => ({ session: { id: 'new-1' }, resumed: true }) };
      },
      readBridgePointer: async () => null,
    });

    const revived = await tools.get('ftown_session_manage').execute(
      'revive-call', { operation: 'revive', target: 'Old worker' },
    );

    assert.equal(requests[1].url, 'http://127.0.0.1:4321/api/sessions/old-1/revive');
    assert.equal(requests[1].init?.method, 'POST');
    assert.equal(revived.details.resumed, true);
  });

  it('lists loops and requests a manual loop run', async () => {
    const tools = new Map<string, any>();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const pi = {
      on() {}, sendUserMessage() {}, registerCommand() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    };
    registerFtownPiExtension(pi, {
      env: { FTOWN_SESSION_ID: 'self', FTOWN_HOOK_PORT: '4321' },
      fetch: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (url.endsWith('/api/loops')) {
          return { ok: true, json: async () => ({ loops: [{ id: 'l1', name: 'Nightly review' }] }) };
        }
        return { ok: true, json: async () => ({ requested: true, loopId: 'l1' }) };
      },
      readBridgePointer: async () => null,
    });

    const listed = await tools.get('ftown_loops').execute('list-loops', { operation: 'list' });
    const run = await tools.get('ftown_loops').execute(
      'run-loop', { operation: 'run_now', target: 'Nightly review' },
    );

    assert.equal(listed.details.loops[0].id, 'l1');
    assert.equal(requests[2].url, 'http://127.0.0.1:4321/api/loops/l1/run-now');
    assert.equal(requests[2].init?.method, 'POST');
    assert.equal(run.details.requested, true);
  });

  it('creates, updates, and deletes loops with structured fields', async () => {
    const tools = new Map<string, any>();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const pi = {
      on() {}, sendUserMessage() {}, registerCommand() {},
      registerTool(tool: any) { tools.set(tool.name, tool); },
    };
    registerFtownPiExtension(pi, {
      env: { FTOWN_SESSION_ID: 'self', FTOWN_HOOK_PORT: '4321' },
      fetch: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (url.endsWith('/api/loops') && init?.method === 'GET') {
          return { ok: true, json: async () => ({ loops: [{ id: 'l1', name: 'Review loop' }] }) };
        }
        if (url.endsWith('/api/loops') && init?.method === 'POST') {
          return { ok: true, json: async () => ({ loop: { id: 'l1', name: 'Review loop' } }) };
        }
        if (init?.method === 'DELETE') {
          return { ok: true, json: async () => ({ removed: true, loopId: 'l1' }) };
        }
        return { ok: true, json: async () => ({ loop: { id: 'l1', enabled: false } }) };
      },
      readBridgePointer: async () => null,
    });

    const create = await tools.get('ftown_loops').execute('create-loop', {
      operation: 'create', name: 'Review loop', task: 'Review open work',
      schedule: { kind: 'interval', everyMs: 300_000 }, shell: 'pi', retention: 10,
    });
    const update = await tools.get('ftown_loops').execute(
      'update-loop', { operation: 'update', target: 'Review loop', enabled: false },
    );
    const remove = await tools.get('ftown_loops').execute(
      'delete-loop', { operation: 'delete', target: 'l1' },
    );

    assert.equal(create.details.loop.id, 'l1');
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
      name: 'Review loop', task: 'Review open work',
      schedule: { kind: 'interval', everyMs: 300_000 }, harness: 'pi',
      enabled: true, overlapPolicy: 'skip', retention: { autoClearAfterRuns: 10 },
    });
    assert.equal(requests[2].url, 'http://127.0.0.1:4321/api/loops/l1');
    assert.deepEqual(JSON.parse(String(requests[2].init?.body)), { enabled: false });
    assert.equal(update.details.loop.enabled, false);
    assert.equal(requests[4].init?.method, 'DELETE');
    assert.equal(remove.details.removed, true);
  });
});
