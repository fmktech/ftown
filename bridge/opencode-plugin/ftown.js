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

function headers(token, json = false) {
  const result = new Headers();
  if (json) result.set('content-type', 'application/json');
  if (token) result.set('authorization', `Bearer ${token}`);
  return result;
}

function formatMail(message) {
  const sender = message.fromName
    ? `${message.fromName} (${message.from ?? 'external'})`
    : (message.from ?? 'external');
  return `[${message.type ?? 'message'} from ${sender}] ${message.body ?? ''}`;
}

/**
 * Register ftown lifecycle forwarding and mail delivery on opencode's plugin
 * event stream. The plugin is inert unless FTOWN_SESSION_ID is present in the
 * opencode process env (i.e. the session was spawned by ftown), so manual
 * `opencode` runs are unaffected.
 *
 * Mirrors bridge/pi-extension/ftown.js: forwards Claude-style hook events to
 * the bridge /hook endpoint (session-id capture + busy/idle live status) and
 * delivers inbox mail as a new prompt at turn boundaries.
 */
export function registerFtownOpencodePlugin(client, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const readBridgePointer = options.readBridgePointer ?? defaultReadBridgePointer;
  const ftownSessionId = env.FTOWN_SESSION_ID?.trim();

  // The opencode session id this plugin instance tracks — updated from every
  // event that carries one, so it stays correct across TUI session switches.
  let currentSessionId;

  async function request(path, init = {}) {
    const pointer = await readBridgePointer();
    let lastResponse = null;
    for (const endpoint of endpoints(env, pointer)) {
      try {
        const response = await fetchImpl(`http://127.0.0.1:${endpoint.port}${path}`, {
          ...init,
          headers: headers(endpoint.token, init.body !== undefined),
        });
        if (response.ok) return response;
        lastResponse = response;
      } catch {
        // A resurrected PTY may hold a stale port. Try bridge.json next.
      }
    }
    return lastResponse;
  }

  async function postHook(eventName, data = {}) {
    if (!ftownSessionId || !currentSessionId) return;
    await request('/hook', {
      method: 'POST',
      body: JSON.stringify({
        ftown_session_id: ftownSessionId,
        ftown_session_source: 'env',
        hook_event_name: eventName,
        session_id: currentSessionId,
        ...data,
      }),
    });
  }

  async function drainMail() {
    if (!ftownSessionId) return [];
    const response = await request(
      `/api/sessions/${encodeURIComponent(ftownSessionId)}/inbox?wait=0`,
      { method: 'GET' },
    );
    if (!response) return [];
    try {
      const payload = await response.json();
      return Array.isArray(payload?.messages) ? payload.messages : [];
    } catch {
      return [];
    }
  }

  async function deliverMail() {
    const messages = await drainMail();
    if (messages.length === 0 || !currentSessionId) return;
    const formatted = messages.map(formatMail).join('\n');
    // Submitting a prompt starts a new turn; when it finishes, session.idle
    // fires again and any mail that arrived meanwhile is delivered then.
    await client.session.prompt({
      path: { id: currentSessionId },
      body: {
        parts: [
          {
            type: 'text',
            text:
              `[ftown mail]\n${formatted}\n` +
              'Handle this message and reply with a message to the sender where appropriate.',
          },
        ],
      },
    });
  }

  function trackSessionId(properties) {
    const id = properties?.info?.id ?? properties?.sessionID ?? properties?.info?.sessionID;
    if (typeof id === 'string' && id.trim()) currentSessionId = id.trim();
  }

  async function handleEvent(event) {
    switch (event.type) {
      case 'session.created':
        trackSessionId(event.properties);
        await postHook('SessionStart');
        break;
      case 'message.updated': {
        trackSessionId(event.properties);
        const role = event.properties?.info?.role;
        if (role === 'user') await postHook('UserPromptSubmit', { prompt: event.properties?.info?.summary });
        break;
      }
      case 'session.idle':
        trackSessionId(event.properties);
        await postHook('Stop');
        await deliverMail();
        break;
      case 'session.error':
        trackSessionId(event.properties);
        await postHook('SessionEnd', { reason: 'error' });
        break;
      default:
        break;
    }
  }

  return {
    event: async ({ event }) => {
      try {
        await handleEvent(event);
      } catch {
        // A failed hook POST or mail delivery must never crash the agent TUI.
      }
    },
  };
}

/** opencode plugin entry — auto-loaded from ~/.config/opencode/plugins/. */
export const FtownOpencodePlugin = async ({ client }) => {
  if (!process.env.FTOWN_SESSION_ID?.trim()) return {};
  return registerFtownOpencodePlugin(client);
};

export default FtownOpencodePlugin;
