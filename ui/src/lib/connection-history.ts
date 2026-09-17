export interface ConnectionEvent {
  at: string;
  event: string;
  details: Record<string, string | number | boolean | null>;
}

// Per-tab memory only. Never store tokens, nonces, user IDs, or raw server payloads.
const history: ConnectionEvent[] = [];
export function recordConnectionEvent(event: string, details: ConnectionEvent['details'] = {}) {
  history.push({ at: new Date().toISOString(), event, details });
  if (history.length > 100) history.shift();
}
export function getConnectionHistory(): ConnectionEvent[] {
  return history.map((entry) => ({ ...entry, details: { ...entry.details } }));
}
export function clearConnectionHistory() { history.length = 0; }

export function diagnosticEndpoint(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch { return 'invalid endpoint'; }
}

/** No authentication needed: measures opening the socket, not server login. */
export function probeWebSocket(url: string, signal: AbortSignal): Promise<Record<string, string | number | boolean | null>> {
  const start = performance.now();
  return new Promise((resolve) => {
    let ws: WebSocket | undefined;
    let done = false;
    let sawError = false;
    const finish = (result: Record<string, string | number | boolean | null>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (ws) {
        ws.onopen = ws.onclose = ws.onerror = null;
        // Closing a CONNECTING socket may still emit an error in browsers.
        ws.onerror = () => {};
        try { ws.close(); } catch { /* already closed */ }
      }
      resolve({ ...result, durationMs: Math.round(performance.now() - start) });
    };
    const abort = () => finish({ result: 'cancelled' });
    const timer = setTimeout(() => finish({ result: sawError ? 'error' : 'timeout', stage: 'before WebSocket open' }), 5000);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    try {
      ws = new WebSocket(url);
      ws.onopen = () => finish({ result: 'open' });
      // Browsers normally emit error then close. Wait for close to retain its code.
      ws.onerror = () => { sawError = true; };
      ws.onclose = (event) => finish({ result: 'closed', code: event.code, clean: event.wasClean, sawError });
    } catch { finish({ result: 'invalid URL or browser restriction' }); }
  });
}

export async function probeWebsite(signal: AbortSignal): Promise<Record<string, string | number | boolean | null>> {
  const start = performance.now();
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 5000);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const response = await fetch('/favicon.ico', { method: 'HEAD', cache: 'no-store', signal: controller.signal });
    return { result: 'HTTP response', status: response.status, durationMs: Math.round(performance.now() - start) };
  } catch {
    return { result: signal.aborted ? 'cancelled' : controller.signal.aborted ? 'timeout' : 'network error', durationMs: Math.round(performance.now() - start) };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
