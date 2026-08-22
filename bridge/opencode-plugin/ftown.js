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
  // Serializes turn-end handling: opencode may emit BOTH session.status(idle)
  // and session.idle for the same boundary. Unordered, two concurrent drains
  // could read the same undelivered mail before either marks it delivered and
  // inject it twice.
  let turnEndChain = Promise.resolve();

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

  async function listInbox(peek) {
    if (!ftownSessionId) return [];
    const response = await request(
      `/api/sessions/${encodeURIComponent(ftownSessionId)}/inbox?wait=0${peek ? '&peek=1' : ''}`,
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

  /**
   * Peek first, and only mark delivered AFTER the prompt was accepted. If
   * submission fails, mail stays queued for the next boundary instead of
   * being silently lost between a marking drain and a failed injection.
   */
  async function deliverMail() {
    if (!currentSessionId) return;
    const messages = await listInbox(true);
    if (messages.length === 0) return;
    const formatted = messages.map(formatMail).join('\n');
    // Submitting a prompt starts a new turn; when it finishes, the next idle
    // boundary fires and any mail that arrived meanwhile is delivered then.
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
    // Accepted — only now let the bridge mark the peeked messages delivered.
    await listInbox(false);
  }

  /**
   * Extract the opencode SESSION id from event properties. `info.id` is only
   * trustworthy on session.created — on message.updated it is a MESSAGE id
   * (msg_…), which must never be stored as the resume id.
   */
  function trackSessionId(properties, preferInfoId = false) {
    const id = properties?.sessionID
      ?? properties?.info?.sessionID
      ?? (preferInfoId ? properties?.info?.id : undefined);
    if (typeof id === 'string' && id.trim()) currentSessionId = id.trim();
  }

  /** Turn boundary: mark idle, then drain and inject pending mail. */
  function endTurn(properties) {
    trackSessionId(properties);
    const run = turnEndChain.then(async () => {
      await postHook('Stop');
      await deliverMail();
    }).catch(() => {
      // A failed hook POST or mail delivery must never crash the agent TUI.
    });
    turnEndChain = run;
    return run;
  }

  async function handleEvent(event) {
    switch (event.type) {
      case 'session.created':
        trackSessionId(event.properties, true);
        await postHook('SessionStart');
        break;
      case 'message.updated': {
        trackSessionId(event.properties);
        const role = event.properties?.info?.role;
        if (role === 'user') await postHook('UserPromptSubmit', { prompt: event.properties?.info?.summary });
        break;
      }
      case 'session.idle':
        await endTurn(event.properties);
        break;
      case 'session.status': {
        trackSessionId(event.properties);
        // v1.18.x fires session.status(busy/idle) reliably; session.idle may
        // not reach plugins at all. Busy keeps the mail pump from nudging
        // mid-turn; idle is a full turn boundary.
        if (event.properties?.status?.type === 'busy') await postHook('PreToolUse');
        else if (event.properties?.status?.type === 'idle') await endTurn(event.properties);
        break;
      }
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
