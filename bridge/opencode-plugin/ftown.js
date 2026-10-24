import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

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


async function secureProxy(env, pointer, path, init = {}) {
  const cli = pointer?.harnessCli || join(homedir(), '.ftown', 'cli', 'dist', 'ftown-cli.js');
  const args = [cli, 'security'];
  const directory = env.FTOWN_DATA_DIR || pointer?.dataDir;
  if (directory) args.push('--data-dir', directory);
  args.push('proxy');
  const request = { method: init.method || 'GET', path, timeoutMs: 60000 };
  if (init.body !== undefined) request.body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'ignore'], signal: init.signal, env });
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

function headers(token, json = false) {
  const result = new Headers();
  if (json) result.set('content-type', 'application/json');
  if (token) result.set('authorization', `Bearer ${token}`);
  return result;
}

export const MAIL_WAKE_TEXT = 'You have new ftown mail — run `ftown harness mail read` to read it.';

/** The inbox is authoritative. Native prompts only ask the agent to read it. */
export function registerFtownOpencodePlugin(client, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const readBridgePointer = options.readBridgePointer ?? defaultReadBridgePointer;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  const now = options.now ?? Date.now;
  const ftownSessionId = env.FTOWN_SESSION_ID?.trim();
  const lifetime = new AbortController();
  const childSessions = new Set();
  let currentSessionId;
  let generation = 0;
  let busy = false;
  let closed = false;
  let wakeEnabled = true;
  let timer;
  let polling = false;
  let inflight = false;
  let seen = new Set();
  let retryAt = 0;
  let retryDelay = 5_000;

  function disableNativeWake() {
    wakeEnabled = false; generation++;
    if (timer) cancel(timer);
    timer = undefined;
    seen.clear();
  }

  function dispose() {
    if (closed) return;
    closed = true; generation++;
    lifetime.abort();
    if (timer) cancel(timer);
    timer = undefined;
    seen.clear();
  }

  async function request(path, init = {}) {
    const pointer = await readBridgePointer();
    if (path.startsWith('/api/')) {
      try { return await (options.proxy ?? ((p, i) => secureProxy(env, pointer, p, i)))(path, init); }
      catch { return null; } // Delivery may be unknown: never retry a mutation through another endpoint.
    }
    if (closed) return null;
    let lastResponse = null;
    for (const endpoint of endpoints(env, pointer)) {
      if (closed) return null;
      try {
        const response = await fetchImpl(`http://127.0.0.1:${endpoint.port}${path}`, {
          ...init,
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(3_000)]),
          headers: headers(endpoint.token, init.body !== undefined),
        });
        if (response.ok) return response;
        lastResponse = response;
      } catch { /* Bridge restart: try the current bridge pointer. */ }
    }
    return lastResponse;
  }

  async function postHook(eventName, data = {}) {
    if (!ftownSessionId || !currentSessionId || closed) return;
    await request('/hook', { method: 'POST', body: JSON.stringify({
      ftown_session_id: ftownSessionId, ftown_session_source: 'env',
      hook_event_name: eventName, session_id: currentSessionId, ...data,
    }) });
  }

  function schedulePoll() {
    if (closed || !wakeEnabled || !ftownSessionId || !currentSessionId || timer) return;
    timer = schedule(() => { timer = undefined; void poll(); }, 5_000);
    timer?.unref?.();
  }

  async function submitWake(id, epoch, ids) {
    inflight = true;
    for (const messageId of ids) seen.add(messageId);
    try {
      const result = await client.session.prompt({ path: { id }, body: {
        parts: [{ type: 'text', text: `[ftown mail] ${MAIL_WAKE_TEXT}` }],
      } });
      if (closed || epoch !== generation) return;
      // Only an explicit rejection may retry this unread batch. A thrown or
      // ambiguous response may already have started a turn; keep it suppressed.
      if (result?.error && [400, 401, 403, 404, 409, 422].includes(result.response?.status)) {
        for (const messageId of ids) seen.delete(messageId);
        retryAt = now() + retryDelay;
        retryDelay = Math.min(60_000, retryDelay * 2);
      } else { retryDelay = 5_000; retryAt = 0; }
    } catch { /* Unknown admission: never immediately duplicate the wake. */ }
    finally { inflight = false; }
  }

  async function poll() {
    if (closed || !wakeEnabled || !ftownSessionId || !currentSessionId || polling) return;
    polling = true;
    const id = currentSessionId;
    const epoch = generation;
    try {
      const query = new URLSearchParams({ wait: '0', peek: '1', adapter: 'opencode', nativeSessionId: id });
      const response = await request(`/api/sessions/${encodeURIComponent(ftownSessionId)}/inbox?${query}`);
      if (closed || epoch !== generation || !response?.ok) return;
      const payload = await response.json();
      if (closed || epoch !== generation || !Array.isArray(payload?.messages)) return;
      const unread = new Set(payload.messages.filter(message => typeof message.id === 'string').map(message => message.id));
      seen = new Set([...seen].filter(messageId => unread.has(messageId)));
      const fresh = [...unread].filter(messageId => !seen.has(messageId));
      if (!busy && !inflight && fresh.length && now() >= retryAt) void submitWake(id, epoch, fresh);
    } catch { /* A failed heartbeat leaves mail untouched; bridge fallback expires. */ }
    finally { polling = false; schedulePoll(); }
  }

  async function identify(properties, created = false) {
    const info = properties?.info;
    const id = properties?.sessionID ?? info?.sessionID ?? (created ? info?.id : undefined);
    if (typeof id !== 'string' || !id.trim() || closed) return false;
    if (created && info?.parentID) { childSessions.add(id); return false; }
    if (childSessions.has(id)) return false;
    // A shared event stream cannot prove which competing root is active in
    // the TUI. Stop native wake rather than guessing; legacy hooks/PTY remain.
    if (created && currentSessionId && id !== currentSessionId) { disableNativeWake(); return false; }
    if (currentSessionId) {
      if (id === currentSessionId) return true;
      // A plugin loaded after session creation can encounter another existing
      // root too. Verify it instead of keeping the original wake target active.
      if (typeof client.session.get === 'function') {
        const epoch = generation;
        const result = await client.session.get({ path: { id } });
        if (closed || epoch !== generation) return false;
        if (!result?.error && result?.data?.id === id) {
          if (result.data.parentID) childSessions.add(id);
          else disableNativeWake();
        }
      }
      return false;
    }
    // Late-loaded plugins may miss session.created. Verify the native session
    // before binding; arbitrary child/message events cannot retarget the bridge.
    if (!created) {
      if (typeof client.session.get !== 'function') return false;
      const result = await client.session.get({ path: { id } });
      if (closed || result?.error || result?.data?.id !== id || result.data.parentID) {
        if (result?.data?.parentID) childSessions.add(id);
        return false;
      }
      if (currentSessionId) return id === currentSessionId;
    }
    currentSessionId = id;
    generation++;
    seen.clear();
    return true;
  }

  async function handleEvent(event) {
    if (!ftownSessionId || closed) return;
    if (event.type === 'server.instance.disposed') { dispose(); return; }
    if (!await identify(event.properties, event.type === 'session.created')) return;
    switch (event.type) {
      case 'session.created':
        await postHook('SessionStart');
        await poll();
        break;
      case 'message.updated':
        if (event.properties?.info?.role === 'user') { busy = true; await postHook('UserPromptSubmit'); }
        break;
      case 'session.status':
        if (event.properties?.status?.type === 'busy') { busy = true; await postHook('PreToolUse'); break; }
        if (event.properties?.status?.type !== 'idle') break;
        // falls through
      case 'session.idle':
        busy = false;
        await postHook('Stop');
        await poll();
        break;
      case 'session.error':
        busy = false;
        await postHook('SessionEnd', { reason: event.type });
        await poll();
        break;
      case 'session.deleted':
        await postHook('SessionEnd', { reason: event.type });
        dispose();
        break;
    }
    schedulePoll();
  }

  return { event: async ({ event }) => {
    try { await handleEvent(event); } catch { /* Never break the agent TUI. */ }
  }, dispose };
}

export const FtownOpencodePlugin = async ({ client }) => {
  if (!process.env.FTOWN_SESSION_ID?.trim()) return {};
  return registerFtownOpencodePlugin(client);
};
export default FtownOpencodePlugin;
