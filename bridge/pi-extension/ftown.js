import { readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

async function defaultReadBridgePointer() {
  try {
    const raw = await readFile(process.env.FTOWN_BRIDGE_POINTER || (process.env.FTOWN_DATA_DIR ? join(process.env.FTOWN_DATA_DIR, 'bridge.json') : join(homedir(), '.ftown', 'bridge.json')), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.port !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}


async function secureProxy(node, env, pointer, path, init = {}) {
  const cli = pointer?.harnessCli || join(homedir(), '.ftown', 'cli', 'dist', 'ftown-cli.js');
  const args = [cli, 'security'];
  const directory = env.FTOWN_DATA_DIR || pointer?.dataDir;
  if (directory) args.push('--data-dir', directory);
  args.push('proxy');
  const request = { method: init.method || 'GET', path, timeoutMs: 60000 };
  if (init.body !== undefined) request.body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
  return new Promise((resolve, reject) => {
    const child = spawn(node, args, { stdio: ['pipe', 'pipe', 'ignore'], signal: init.signal, env });
    const chunks = []; let bytes = 0;
    const timeout = setTimeout(() => child.kill(), 65000); timeout.unref?.();
    child.on('error', () => { clearTimeout(timeout); reject(new Error('Encrypted bridge request failed')); });
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 1048576) child.kill(); else chunks.push(data); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || bytes > 1048576) return reject(new Error('Encrypted bridge request failed'));
      try { const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(new Response(JSON.stringify(response.body), { status: response.status })); }
      catch { reject(new Error('Encrypted bridge response failed')); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request));
  });
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

function discussionReplyHint(message) {
  if (message.from !== 'project-discussion') return '';
  const legacyProject = /^discussion:([0-9a-f-]{36}):[0-9a-f-]{36}$/i.exec(message.idempotencyKey ?? '')?.[1];
  const project = message.discussion?.projectId || legacyProject || message.fromName?.replace(/ discussion$/, '');
  if (!project || !message.threadId) return 'Reply in the project thread using ftown_discuss or ftown discuss reply.';
  const args = { operation: 'reply', project, threadId: message.threadId, text: '<reply>' };
  if (message.discussion?.homeBridgeId) args.bridge = message.discussion.homeBridgeId;
  return 'Reply to the thread using ftown_discuss ' + JSON.stringify(args);
}

function formatMail(message) {
  const sender = message.fromName
    ? `${message.fromName} (${message.from ?? 'external'})`
    : (message.from ?? 'external');
  const hint = discussionReplyHint(message);
  const notice = `[${message.type ?? 'message'} from ${sender}] ${message.body ?? ''}`;
  return hint ? notice + '\n' + hint : notice;
}

function collectBranchUsage(ctx, harness) {
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
    harness,
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
  const harness = options.harness ?? 'pi';
  // OMP is a standalone Bun executable. Its process.execPath launches OMP itself.
  const node = harness === 'omp' ? 'node' : process.execPath;
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
    if (path.startsWith('/api/')) {
      try { return await (options.proxy ?? ((p, i) => secureProxy(node, env, pointer, p, i)))(path, init); }
      catch { return null; } // Delivery may be unknown: never retry a mutation through another endpoint.
    }
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
      if (!parent) throw new Error('This session has no ftown parent');
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
      const payload = await requestJson(
        `/api/sessions/${encodeURIComponent(ftownSessionId)}/inbox?${query.toString()}`,
        { method: 'GET' },
      );
      if (!Array.isArray(payload?.messages)) return payload;
      return { ...payload, messages: payload.messages.map(message => {
        const replyHint = discussionReplyHint(message);
        return replyHint ? { ...message, replyHint } : message;
      }) };
    }

    const sessions = await listSessions();
    if (params.target.trim() === 'project-discussion' && !sessions.some(s => s.name === 'project-discussion' || s.id === 'project-discussion')) {
      throw new Error('Use ftown_discuss with operation "reply", the project, threadId and text from the discussion notification.');
    }
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
    name: 'ftown_ask_user',
    label: 'ask user',
    description: 'Pause and ask the user for manual input. Prefer options when the valid choices are known.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', minLength: 1 },
        options: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 2,
          maxItems: 12,
          description: 'Optional choices. Omit for a free-form answer.',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        requireString(params, 'question');
        if (!ctx?.ui) throw new Error('Interactive UI is unavailable');
        const answer = Array.isArray(params.options) && params.options.length > 0
          ? await ctx.ui.select(params.question, params.options)
          : await ctx.ui.input(params.question);
        return toolResult(answer === undefined
          ? { answer: null, cancelled: true }
          : { answer });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  pi.registerTool({
    name: 'ftown_mail',
    label: 'ftown mail',
    description: 'Send direct mail to another ftown session or read this session inbox. Use ftown_discuss to reply to project discussion notifications.',
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

  pi.registerTool({
    name: 'ftown_discuss',
    label: 'ftown discussion',
    description: 'Post a reply to a project discussion thread as the current session.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['reply'] },
        project: { type: 'string', description: 'Project ID or exact name.' },
        threadId: { type: 'string', description: 'Thread ID from the project discussion notification.' },
        text: { type: 'string', minLength: 1 },
        bridge: { type: 'string', description: 'Optional project home bridge ID or name.' },
      },
      required: ['operation', 'project', 'threadId', 'text'],
      additionalProperties: false,
    },
    async execute(toolCallId, params, signal) {
      try {
        requireOperation(params, ['reply']);
        for (const key of ['project', 'threadId', 'text']) requireString(params, key);
        if (params.bridge !== undefined) requireString(params, 'bridge');
        if (!ftownSessionId) throw new Error('FTOWN_SESSION_ID is unavailable');
        return await executeOnce('ftown_discuss', toolCallId, async () => {
          const pointer = await readBridgePointer();
          const cli = pointer?.harnessCli || join(homedir(), '.ftown', 'cli', 'dist', 'ftown-cli.js');
          const args = [cli, 'discuss', 'reply', '--json', '--project=' + params.project, '--text=' + params.text];
          if (params.bridge) args.push('--bridge=' + params.bridge);
          if (toolCallId) {
            // A retried tool call can run in a new extension process after the original post was saved.
            const bytes = createHash('sha256').update(JSON.stringify([ftownSessionId, toolCallId])).digest().subarray(0, 16);
            bytes[6] = (bytes[6] & 0x0f) | 0x80;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            const hex = bytes.toString('hex');
            args.push('--id=' + [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-'));
          }
          args.push('--', params.threadId);
          const directory = env.FTOWN_DATA_DIR || pointer?.dataDir;
          let stdout;
          try {
            ({ stdout } = await execFileAsync(node, args, {
              env: { ...env, FTOWN_BRIDGE: '', ...(directory && { FTOWN_DATA_DIR: directory }) },
              signal, timeout: 180_000, maxBuffer: 64 * 1024,
            }));
          } catch (error) {
            const detail = error.stderr?.split('\n').find(line => /^(?:ftown(?: discuss)?|error): /.test(line));
            throw new Error(detail?.slice(0, 500) || 'Could not confirm the project discussion reply.');
          }
          try { return toolResult(JSON.parse(stdout)); }
          catch { throw new Error('Invalid response from ftown discuss reply.'); }
        });
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
    description: 'Create a structured ftown agent session. Omit shell to inherit the current harness; set it only for an explicit override. Does not allow arbitrary commands or environment variables.',
    parameters: {
      type: 'object',
      properties: {
        shell: {
          type: 'string',
          enum: ['claude', 'cursor', 'codex', 'grok', 'muse', 'antigravity', 'pi', 'omp', 'kimi-code', 'opencode', 'shell', 'zai', 'kimi', 'deepseek', 'fireworks'],
          description: 'Optional harness override. Omit to inherit the current harness.',
        },
        prompt: { type: 'string', minLength: 1 },
        workdir: { type: 'string' },
        name: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string', description: 'Optional reasoning effort for a harness that supports it.' },
        parent: { type: 'boolean', description: 'Make the current session the parent.' },
        parentId: { type: 'string', description: 'Explicit ftown parent session id.' },
        createWorkdir: { type: 'boolean' },
        orchestrator: { type: 'boolean', description: 'Deprecated compatibility input; ignored.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    async execute(toolCallId, params) {
      try {
        return await executeOnce('ftown_session_create', toolCallId, async () => {
          const body = {
            ...(params.shell ? { shellType: params.shell } : {}),
            prompt: params.prompt,
            ...(params.workdir ? { workingDir: params.workdir } : {}),
            ...(params.name ? { name: params.name } : {}),
            ...(params.model ? { model: params.model } : {}),
            ...(params.effort ? { effort: params.effort } : {}),
            ...(params.parentId
              ? { parentSessionId: params.parentId }
              : params.parent ? { parentSessionId: true } : {}),
            ...(params.createWorkdir ? { createMissingWorkingDir: true } : {}),
          };
          const extraHeaders = ftownSessionId
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
      if (typeof pi.exec !== 'function') throw new Error('Command execution is unavailable');
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

  let sessionContext;

  async function deliverMail(wait = 0, signal) {
    const messages = await drainMail(wait, signal);
    if (signal?.aborted || messages.length === 0) return 0;
    const formatted = messages.map(formatMail).join('\n');
    const text = `[ftown mail]\n${formatted}`;
    if (harness === 'omp' && sessionContext?.isIdle()) {
      // OMP queues explicit follow-ups even when idle. A normal message starts
      // a turn, whose promise lasts until completion. Keep polling during it.
      void pi.sendUserMessage(text).catch(() => console.error('[ftown] OMP could not start a mail turn'));
    } else {
      await pi.sendUserMessage(text, { deliverAs: 'followUp' });
    }
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
    sessionContext = ctx;
    await postHook('SessionStart', ctx, { reason: event.reason });
    startMailWake();
  });

  pi.on('before_agent_start', async (event, ctx) => {
    await postHook('UserPromptSubmit', ctx, { prompt: event.prompt });
  });

  function toolIdentity(event) {
    // OMP's interactive form tool is called "ask". Use the bridge's ask-user
    // spelling only for this native tool so other harnesses retain their names.
    const toolName = harness === 'omp' && event.toolName === 'ask' ? 'ask_user' : event.toolName;
    return { tool_call_id: event.toolCallId, tool_use_id: event.toolCallId, tool_name: toolName };
  }

  pi.on('tool_execution_start', async (event, ctx) => {
    await postHook('PreToolUse', ctx, {
      ...toolIdentity(event),
      tool_input: event.args,
    });
  });

  pi.on('tool_execution_end', async (event, ctx) => {
    await postHook('PostToolUse', ctx, {
      ...toolIdentity(event),
      is_error: event.isError,
    });
  });

  pi.on(harness === 'omp' ? 'agent_end' : 'agent_settled', async (_event, ctx) => {
    const usage = collectBranchUsage(ctx, harness);
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
