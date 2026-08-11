import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function defaultReadBridgePointer() {
  try {
    const raw = await readFile(join(homedir(), '.ftown', 'bridge.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.port !== 'number') return null;
    return {
      port: parsed.port,
      token: typeof parsed.token === 'string' ? parsed.token : undefined,
    };
  } catch {
    return null;
  }
}

function endpoints(env, pointer) {
  const candidates = [];
  const envPort = Number.parseInt(env.FTOWN_HOOK_PORT ?? '', 10);
  if (Number.isInteger(envPort) && envPort > 0) {
    candidates.push({ port: envPort, token: env.FTOWN_HOOK_TOKEN });
  }
  if (
    pointer?.port
    && !candidates.some((candidate) =>
      candidate.port === pointer.port && candidate.token === pointer.token)
  ) {
    candidates.push(pointer);
  }
  return candidates;
}

function headers(token, json = false, additional) {
  const result = new Headers(additional);
  if (json) result.set('content-type', 'application/json');
  if (token) result.set('authorization', `Bearer ${token}`);
  return result;
}

function sessionMetadata(ctx) {
  return {
    session_id: ctx.sessionManager.getSessionId(),
    session_file: ctx.sessionManager.getSessionFile(),
    cwd: ctx.sessionManager.getCwd(),
  };
}

function formatMail(message) {
  const sender = message.fromName
    ? `${message.fromName} (${message.from ?? 'external'})`
    : (message.from ?? 'external');
  return `[${message.type ?? 'message'} from ${sender}] ${message.body ?? ''}`;
}

function collectBranchUsage(ctx) {
  let entries;
  try {
    entries = ctx.sessionManager.getBranch();
  } catch {
    return undefined;
  }
  if (!Array.isArray(entries)) return undefined;
  const byModel = new Map();
  for (const entry of entries) {
    const message = entry?.type === 'message' ? entry.message : undefined;
    const usage = message?.role === 'assistant' ? message.usage : undefined;
    if (!usage || !message.model) continue;
    const model = message.provider ? `${message.provider}/${message.model}` : message.model;
    const current = byModel.get(model) ?? {
      model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    current.inputTokens += usage.input ?? 0;
    current.outputTokens += usage.output ?? 0;
    current.cacheReadTokens += usage.cacheRead ?? 0;
    current.cacheWriteTokens += usage.cacheWrite ?? 0;
    byModel.set(model, current);
  }
  if (byModel.size === 0) return undefined;
  const perModel = [...byModel.values()];
  const sum = (key) => perModel.reduce((total, item) => total + item[key], 0);
  const inputTokens = sum('inputTokens');
  const outputTokens = sum('outputTokens');
  const cacheReadTokens = sum('cacheReadTokens');
  const cacheWriteTokens = sum('cacheWriteTokens');
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    models: perModel.map((item) => item.model),
    perModel,
    harness: 'pi',
  };
}

function delayWithAbort(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Register ftown lifecycle forwarding and mail delivery on Pi's extension API. */
export function registerFtownPiExtension(pi, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const readBridgePointer = options.readBridgePointer ?? defaultReadBridgePointer;
  const ftownSessionId = env.FTOWN_SESSION_ID?.trim();
  const mailWakeWaitSeconds = options.mailWakeWaitSeconds ?? 30;
  const mailWakeIdleDelayMs = options.mailWakeIdleDelayMs ?? 1_000;
  const mailWakeMaxRetryDelayMs = Math.max(
    mailWakeIdleDelayMs,
    options.mailWakeMaxRetryDelayMs ?? 30_000,
  );
  const delay = options.delay ?? delayWithAbort;
  const mutationResults = new Map();
  let mailWakeController;
  let mailWakeTask;
  let mailWakeClosed = false;

  async function executeOnce(toolName, toolCallId, operation) {
    if (!toolCallId) return operation();
    const key = `${toolName}:${toolCallId}`;
    const existing = mutationResults.get(key);
    if (existing) return existing;

    const pending = Promise.resolve().then(operation);
    mutationResults.set(key, pending);
    if (mutationResults.size > 512) {
      mutationResults.delete(mutationResults.keys().next().value);
    }
    try {
      return await pending;
    } catch (error) {
      mutationResults.delete(key);
      throw error;
    }
  }

  async function request(path, init = {}) {
    const pointer = await readBridgePointer();
    let lastResponse = null;
    for (const endpoint of endpoints(env, pointer)) {
      try {
        const response = await fetchImpl(`http://127.0.0.1:${endpoint.port}${path}`, {
          ...init,
          headers: headers(endpoint.token, init.body !== undefined, init.headers),
        });
        if (response.ok) return response;
        lastResponse = response;
      } catch {
        // A tmux-resurrected session may hold a stale port. Try bridge.json next.
        if (init.signal?.aborted) break;
      }
    }
    return lastResponse;
  }

  async function requestJson(path, init = {}) {
    const response = await request(path, init);
    if (!response) throw new Error('ftown bridge is unavailable');
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      // Keep the public error sanitized when the bridge returns a non-JSON body.
    }
    if (!response.ok) {
      const message = typeof payload?.error === 'string' ? payload.error : `ftown API error (${response.status})`;
      throw new Error(message);
    }
    return payload;
  }

  async function postHook(eventName, ctx, data = {}) {
    if (!ftownSessionId) return;
    await request('/hook', {
      method: 'POST',
      body: JSON.stringify({
        ftown_session_id: ftownSessionId,
        ftown_session_source: 'env',
        hook_event_name: eventName,
        ...sessionMetadata(ctx),
        ...data,
      }),
    });
  }

  async function drainMail(wait = 0, signal) {
    if (!ftownSessionId) return [];
    const payload = await requestJson(
      `/api/sessions/${encodeURIComponent(ftownSessionId)}/inbox?wait=${wait}`,
      { method: 'GET', signal },
    );
    return Array.isArray(payload?.messages) ? payload.messages : [];
  }

  async function listSessions() {
    const payload = await requestJson('/api/sessions', { method: 'GET' });
    return Array.isArray(payload?.sessions) ? payload.sessions : [];
  }

  function resolveSession(sessions, target) {
    const normalized = target?.trim();
    if (!normalized) throw new Error('A target session id or name is required');
    if (normalized === 'parent') {
      const parent = env.FTOWN_PARENT_SESSION_ID?.trim();
      if (!parent) throw new Error('This Pi session has no ftown parent');
      return sessions.find((session) => session.id === parent) ?? { id: parent, name: parent };
    }
    const byId = sessions.find((session) => session.id === normalized);
    if (byId) return byId;
    const byName = sessions.filter((session) => session.name === normalized);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`Multiple sessions are named "${normalized}"; use an id`);
    throw new Error(`Session not found: ${normalized}`);
  }

  function hasOwn(value, key) {
    return value !== null && typeof value === 'object'
      && Object.prototype.hasOwnProperty.call(value, key);
  }

  function requireString(params, field, label = field) {
    const value = params?.[field];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  }

  function requireProperty(params, field, label = field) {
    if (!hasOwn(params, field)) throw new Error(`${label} is required`);
  }

  function requireOperation(params, allowed) {
    if (!allowed.includes(params?.operation)) {
      throw new Error(`operation must be one of: ${allowed.join(', ')}`);
    }
  }

  function validateMailParams(params) {
    requireOperation(params, ['send', 'read']);
    if (params.operation === 'send') {
      requireString(params, 'target');
      requireString(params, 'body');
    }
  }

  async function runMail(params) {
    validateMailParams(params);
    if (params.operation === 'read') {
      if (!ftownSessionId) throw new Error('FTOWN_SESSION_ID is unavailable');
      const query = new URLSearchParams({ wait: '0' });
      if (params.peek) query.set('peek', '1');
      if (params.all) query.set('all', '1');
      if (params.limit !== undefined) query.set('limit', String(params.limit));
      return requestJson(
        `/api/sessions/${encodeURIComponent(ftownSessionId)}/inbox?${query.toString()}`,
        { method: 'GET' },
      );
    }

    const sessions = await listSessions();
    const target = resolveSession(sessions, params.target);
    const self = sessions.find((session) => session.id === ftownSessionId);
    const body = {
      body: params.body,
      type: params.type ?? 'message',
      from: ftownSessionId ?? 'external',
      ...(self?.name ? { fromName: self.name } : {}),
      ...(params.threadId ? { threadId: params.threadId } : {}),
    };
    return requestJson(`/api/sessions/${encodeURIComponent(target.id)}/inbox`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  function toolResult(payload) {
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      details: payload,
    };
  }

  function toolError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: message }],
      details: { error: message },
      isError: true,
    };
  }

  pi.registerTool({
    name: 'ftown_mail',
    label: 'ftown mail',
    description: 'Send durable mail to another ftown session, or read this session inbox.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['send', 'read'] },
        target: { type: 'string', description: 'Session id/name, or "parent".' },
        body: { type: 'string', minLength: 1 },
        type: { type: 'string', enum: ['message', 'task', 'result', 'escalation'] },
        threadId: { type: 'string' },
        peek: { type: 'boolean', description: 'Do not mark messages delivered.' },
        all: { type: 'boolean', description: 'Include already-delivered messages.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    async execute(toolCallId, params) {
      try {
        if (params.operation === 'send') {
          return await executeOnce('ftown_mail', toolCallId, async () =>
            toolResult(await runMail(params)));
        }
        return toolResult(await runMail(params));
      } catch (error) {
        return toolError(error);
      }
    },
  });

  pi.registerCommand('ftown-mail', {
    description: 'Read ftown mail, or send it with: /ftown-mail send <session> <message>',
    handler: async (args, ctx) => {
      const input = args.trim();
      try {
        const payload = input === '' || input === 'read'
          ? await runMail({ operation: 'read' })
          : input.startsWith('read ')
            ? await runMail({ operation: 'read', peek: input.split(/\s+/).includes('--peek') })
            : await (() => {
                const match = input.match(/^send\s+(\S+)\s+([\s\S]+)$/);
                if (!match) throw new Error('Usage: /ftown-mail read [--peek] | send <session> <message>');
                return runMail({ operation: 'send', target: match[1], body: match[2] });
              })();
        ctx.ui.notify(JSON.stringify(payload, null, 2), 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });

  async function runSessions(params) {
    requireOperation(params, ['list', 'children', 'archive', 'get', 'usage', 'running', 'screen', 'grep']);
    if (!['list', 'children', 'archive'].includes(params.operation)) requireString(params, 'target');
    if (params.operation === 'grep') requireString(params, 'pattern');
    if (params.operation === 'archive') {
      return requestJson('/api/archive', { method: 'GET' });
    }
    const sessions = await listSessions();
    const filterByPattern = (candidates) => {
      if (!params.pattern) return candidates;
      let pattern;
      try {
        pattern = new RegExp(params.pattern, 'i');
      } catch (error) {
        throw new Error(`Invalid session pattern: ${error instanceof Error ? error.message : String(error)}`);
      }
      return candidates.filter((session) =>
        Object.values(session).some((value) => typeof value === 'string' && pattern.test(value)));
    };
    if (params.operation === 'children') {
      const parentSessionId = params.target
        ? resolveSession(sessions, params.target).id
        : ftownSessionId;
      if (!parentSessionId) throw new Error('children requires target outside an ftown session');
      const children = sessions.filter((session) => session.parentSessionId === parentSessionId);
      return { sessions: filterByPattern(children) };
    }
    if (params.operation === 'list') {
      return { sessions: filterByPattern(sessions) };
    }
    const session = resolveSession(sessions, params.target);
    if (params.operation === 'get') {
      return requestJson(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'GET' });
    }
    if (params.operation === 'running') {
      return requestJson(`/api/sessions/${encodeURIComponent(session.id)}/running`, { method: 'GET' });
    }
    if (params.operation === 'usage') {
      return requestJson(`/api/sessions/${encodeURIComponent(session.id)}/usage`, { method: 'GET' });
    }
    if (params.operation === 'screen') {
      const query = new URLSearchParams({
        offset: String(params.offset ?? 0),
        limit: String(params.limit ?? 200),
      });
      return requestJson(
        `/api/sessions/${encodeURIComponent(session.id)}/screen?${query.toString()}`,
        { method: 'GET' },
      );
    }
    return requestJson(`/api/sessions/${encodeURIComponent(session.id)}/grep`, {
      method: 'POST',
      body: JSON.stringify({
        pattern: params.pattern,
        offset: params.offset ?? 0,
        limit: params.limit ?? 30,
        context: params.context ?? 0,
      }),
    });
  }

  const targetProperty = {
    type: 'string',
    description: 'Session id or unique exact name; optional parent for children (defaults to current session).',
  };
  const pageProperties = {
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
  };

  pi.registerTool({
    name: 'ftown_sessions',
    label: 'ftown sessions',
    description: 'List, filter, or inspect ftown sessions, including children, running state, archive, token usage, terminal screen, and terminal log matches.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'children', 'archive', 'get', 'usage', 'running', 'screen', 'grep'],
        },
        target: targetProperty,
        pattern: {
          type: 'string', minLength: 1,
          description: 'Case-insensitive regex for list/children filtering; required for terminal grep.',
        },
        ...pageProperties,
        context: { type: 'integer', minimum: 0, maximum: 10 },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      try {
        return toolResult(await runSessions(params));
      } catch (error) {
        return toolError(error);
      }
    },
  });

  pi.registerCommand('ftown-sessions', {
    description: 'List ftown sessions available on this bridge.',
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify(JSON.stringify({ sessions: await listSessions() }, null, 2), 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });

  pi.registerTool({
    name: 'ftown_session_create',
    label: 'create ftown session',
    description: 'Create a structured ftown agent session. Does not allow arbitrary commands or environment variables.',
    parameters: {
      type: 'object',
      properties: {
        shell: {
          type: 'string',
          enum: ['claude', 'cursor', 'codex', 'grok', 'pi', 'kimi-code', 'opencode', 'shell', 'zai', 'kimi', 'deepseek', 'fireworks'],
        },
        prompt: { type: 'string', minLength: 1 },
        workdir: { type: 'string' },
        name: { type: 'string' },
        model: { type: 'string' },
        parent: { type: 'boolean', description: 'Make the current Pi session the parent.' },
        parentId: { type: 'string', description: 'Explicit ftown parent session id.' },
        createWorkdir: { type: 'boolean' },
        orchestrator: { type: 'boolean' },
      },
      required: ['shell', 'prompt'],
      additionalProperties: false,
    },
    async execute(toolCallId, params) {
      try {
        return await executeOnce('ftown_session_create', toolCallId, async () => {
          const body = {
            shellType: params.shell,
            prompt: params.prompt,
            ...(params.workdir ? { workingDir: params.workdir } : {}),
            ...(params.name ? { name: params.name } : {}),
            ...(params.model ? { model: params.model } : {}),
            ...(params.parentId
              ? { parentSessionId: params.parentId }
              : params.parent ? { parentSessionId: true } : {}),
            ...(params.createWorkdir ? { createMissingWorkingDir: true } : {}),
            ...(params.orchestrator ? { orchestrator: true } : {}),
          };
          const extraHeaders = params.parent && ftownSessionId
            ? { 'x-ftown-session-id': ftownSessionId }
            : undefined;
          return toolResult(await requestJson('/api/sessions', {
            method: 'POST',
            headers: extraHeaders,
            body: JSON.stringify(body),
          }));
        });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  async function runSessionManage(params) {
    requireOperation(params, ['stop', 'remove', 'revive', 'rename', 'reparent']);
    requireString(params, 'target');
    if (params.operation === 'rename') requireString(params, 'name');
    if (params.operation === 'reparent') requireProperty(params, 'parent');
    if (params.operation === 'revive') {
      const payload = await requestJson('/api/archive', { method: 'GET' });
      const archived = Array.isArray(payload?.archived) ? payload.archived : [];
      const normalized = params.target?.trim();
      const byId = archived.filter((session) => session.id === normalized);
      const byName = archived.filter((session) => session.name === normalized);
      const session = byId.at(-1) ?? (byName.length === 1 ? byName[0] : undefined);
      if (!session) {
        if (byName.length > 1) throw new Error(`Multiple archived sessions are named "${normalized}"; use an id`);
        throw new Error(`Archived session not found: ${normalized}`);
      }
      return requestJson(`/api/sessions/${encodeURIComponent(session.id)}/revive`, { method: 'POST' });
    }
    const sessions = await listSessions();
    const session = resolveSession(sessions, params.target);
    if (params.operation === 'stop') {
      if (typeof pi.exec !== 'function') throw new Error('Pi command execution is unavailable');
      const result = await pi.exec(
        join(homedir(), '.ftown', 'ftown-sessions'),
        ['stop', session.id],
        { timeout: 30_000 },
      );
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'Failed to stop ftown session');
      try {
        return JSON.parse(result.stdout);
      } catch {
        return { stopped: true, sessionId: session.id };
      }
    }
    if (params.operation === 'remove') {
      return requestJson(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
    }
    if (params.operation === 'rename') {
      return requestJson(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: 'PATCH', body: JSON.stringify({ name: params.name }),
      });
    }
    const parent = params.parent === null || params.parent === ''
      ? null
      : resolveSession(sessions, params.parent).id;
    return requestJson(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: 'PATCH', body: JSON.stringify({ parentSessionId: parent }),
    });
  }

  pi.registerTool({
    name: 'ftown_session_manage',
    label: 'manage ftown session',
    description: 'Stop, rename, reparent, remove, or revive an ftown session.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string', enum: ['stop', 'remove', 'revive', 'rename', 'reparent'],
        },
        target: targetProperty,
        name: { type: 'string', minLength: 1 },
        parent: { type: ['string', 'null'], description: 'Parent id/name; null clears it.' },
      },
      required: ['operation', 'target'],
      additionalProperties: false,
    },
    async execute(toolCallId, params) {
      try {
        return await executeOnce('ftown_session_manage', toolCallId, async () =>
          toolResult(await runSessionManage(params)));
      } catch (error) {
        return toolError(error);
      }
    },
  });

  async function listLoops() {
    const payload = await requestJson('/api/loops', { method: 'GET' });
    return Array.isArray(payload?.loops) ? payload.loops : [];
  }

  function resolveLoop(loops, target) {
    const normalized = target?.trim();
    if (!normalized) throw new Error('A loop id or name is required');
    const byId = loops.find((loop) => loop.id === normalized);
    if (byId) return byId;
    const byName = loops.filter((loop) => loop.name === normalized);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`Multiple loops are named "${normalized}"; use an id`);
    throw new Error(`Loop not found: ${normalized}`);
  }

  const loopScheduleProperty = {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['interval', 'cron'] },
      everyMs: { type: 'integer', minimum: 1000 },
      expression: { type: 'string', minLength: 1 },
      tz: { type: 'string', minLength: 1 },
    },
    required: ['kind'],
    additionalProperties: false,
  };
  const loopDraftProperties = {
    name: { type: 'string', minLength: 1 },
    task: { type: 'string', minLength: 1 },
    schedule: loopScheduleProperty,
    shell: { type: 'string', enum: ['claude', 'cursor', 'codex', 'grok', 'pi', 'kimi-code', 'opencode', 'shell'] },
    workdir: { type: 'string' },
    model: { type: 'string' },
    enabled: { type: 'boolean' },
    overlapPolicy: { type: 'string', enum: ['skip', 'allow'] },
    retention: { type: ['integer', 'null'], minimum: 0 },
    maxRuntimeMs: { type: 'integer', minimum: 1000 },
    group: { type: 'string' },
  };
  const loopDraftFields = Object.keys(loopDraftProperties);

  function validateLoopSchedule(schedule) {
    requireProperty({ schedule }, 'schedule');
    if (schedule === null || typeof schedule !== 'object') throw new Error('schedule is required');
    requireOperation({ operation: schedule.kind }, ['interval', 'cron']);
    if (schedule.kind === 'interval') requireProperty(schedule, 'everyMs', 'schedule.everyMs');
    if (schedule.kind === 'cron') requireString(schedule, 'expression', 'schedule.expression');
  }

  function validateLoopParams(params) {
    requireOperation(params, ['list', 'get', 'runs', 'run_now', 'delete', 'create', 'update']);
    if (['get', 'runs', 'run_now', 'delete', 'update'].includes(params.operation)) {
      requireString(params, 'target');
    }
    if (params.operation === 'create') {
      requireString(params, 'name');
      requireString(params, 'task');
      requireProperty(params, 'schedule');
    }
    if (params.operation === 'update' && !loopDraftFields.some((field) => hasOwn(params, field))) {
      throw new Error('At least one field to update is required');
    }
    if (hasOwn(params, 'schedule')) validateLoopSchedule(params.schedule);
  }

  function loopBody(params, create = false) {
    const body = {};
    for (const field of ['name', 'task', 'schedule', 'workdir', 'model', 'enabled', 'overlapPolicy', 'maxRuntimeMs', 'group']) {
      if (Object.prototype.hasOwnProperty.call(params, field)) body[field] = params[field];
    }
    if (Object.prototype.hasOwnProperty.call(params, 'shell')) body.harness = params.shell;
    if (Object.prototype.hasOwnProperty.call(params, 'retention')) {
      body.retention = { autoClearAfterRuns: params.retention };
    }
    if (create) {
      body.harness ??= 'pi';
      body.enabled ??= true;
      body.overlapPolicy ??= 'skip';
      body.retention ??= { autoClearAfterRuns: 10 };
    }
    return body;
  }

  pi.registerTool({
    name: 'ftown_loops',
    label: 'ftown loops',
    description: 'List, inspect, create, update, delete, or run scheduled ftown loops.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'get', 'runs', 'run_now', 'delete', 'create', 'update'],
        },
        target: { type: 'string' },
        ...loopDraftProperties,
      },
      required: ['operation'],
      additionalProperties: false,
    },
    async execute(toolCallId, params) {
      try {
        validateLoopParams(params);
        if (params.operation === 'create') {
          return await executeOnce('ftown_loops', toolCallId, async () =>
            toolResult(await requestJson('/api/loops', {
              method: 'POST', body: JSON.stringify(loopBody(params, true)),
            })));
        }
        const loops = await listLoops();
        if (params.operation === 'list') return toolResult({ loops });
        const loop = resolveLoop(loops, params.target);
        const loopPath = `/api/loops/${encodeURIComponent(loop.id)}`;
        if (params.operation === 'get') {
          return toolResult(await requestJson(loopPath, { method: 'GET' }));
        }
        if (params.operation === 'runs') {
          return toolResult(await requestJson(`${loopPath}/runs`, { method: 'GET' }));
        }
        const mutate = async () => {
          if (params.operation === 'run_now') {
            return toolResult(await requestJson(`${loopPath}/run-now`, { method: 'POST' }));
          }
          if (params.operation === 'delete') {
            return toolResult(await requestJson(loopPath, { method: 'DELETE' }));
          }
          return toolResult(await requestJson(loopPath, {
            method: 'PATCH', body: JSON.stringify(loopBody(params)),
          }));
        };
        return await executeOnce('ftown_loops', toolCallId, mutate);
      } catch (error) {
        return toolError(error);
      }
    },
  });

  async function deliverMail(wait = 0, signal) {
    const messages = await drainMail(wait, signal);
    if (signal?.aborted || messages.length === 0) return 0;
    const formatted = messages.map(formatMail).join('\n');
    pi.sendUserMessage(
      `[ftown mail]\n${formatted}\n` +
      'Handle this message and reply with the `ftown_mail` tool where appropriate.',
      { deliverAs: 'followUp' },
    );
    return messages.length;
  }

  async function runMailWake(signal) {
    let retryDelayMs = mailWakeIdleDelayMs;
    while (!signal.aborted) {
      try {
        const delivered = await deliverMail(mailWakeWaitSeconds, signal);
        retryDelayMs = mailWakeIdleDelayMs;
        if (delivered === 0 && !signal.aborted) {
          await delay(mailWakeIdleDelayMs, signal);
        }
      } catch {
        if (!signal.aborted) {
          await delay(retryDelayMs, signal);
          retryDelayMs = Math.min(retryDelayMs * 2, mailWakeMaxRetryDelayMs);
        }
      }
    }
  }

  function startMailWake() {
    if (!ftownSessionId || mailWakeClosed || mailWakeTask) return;
    const controller = new AbortController();
    mailWakeController = controller;
    const task = runMailWake(controller.signal);
    mailWakeTask = task;
    const cleanup = () => {
      if (mailWakeTask === task) mailWakeTask = undefined;
      if (mailWakeController === controller) mailWakeController = undefined;
    };
    void task.then(cleanup, cleanup);
  }

  function stopMailWake() {
    mailWakeClosed = true;
    mailWakeController?.abort();
  }

  pi.on('session_start', async (event, ctx) => {
    await postHook('SessionStart', ctx, { reason: event.reason });
    startMailWake();
  });

  pi.on('before_agent_start', async (event, ctx) => {
    await postHook('UserPromptSubmit', ctx, { prompt: event.prompt });
  });

  pi.on('tool_execution_start', async (event, ctx) => {
    await postHook('PreToolUse', ctx, {
      tool_call_id: event.toolCallId,
      tool_name: event.toolName,
      tool_input: event.args,
    });
  });

  pi.on('tool_execution_end', async (event, ctx) => {
    await postHook('PostToolUse', ctx, {
      tool_call_id: event.toolCallId,
      tool_name: event.toolName,
      is_error: event.isError,
    });
  });

  pi.on('agent_settled', async (_event, ctx) => {
    const usage = collectBranchUsage(ctx);
    await postHook('Stop', ctx, usage ? { usage } : {});
    if (!mailWakeTask) await deliverMail();
  });

  pi.on('session_shutdown', async (event, ctx) => {
    stopMailWake();
    await postHook('SessionEnd', ctx, { reason: event.reason });
  });
}

export default function ftownPiExtension(pi) {
  registerFtownPiExtension(pi);
}
