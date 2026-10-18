// This module intentionally submits only a pointer. Classic hooks and the mail
// CLI remain the owners of message consumption; fetching here never drains mail.
const WAKE = '[ftown mail] You have unread FTown mail. Run `ftown harness mail read` and handle the messages. Reply with `ftown harness mail send ...` where appropriate.';

/** @param {import('claude-code').On} on */
export function register(on) {
  let generation = 0;
  let nativeId = '';
  /** @type {{ generation: number } | null} */
  let pending = null;
  let polling = false;
  /** @type {Set<string>} */
  let handled = new Set();
  let retryAt = 0;
  let failures = 0;
  let blockedSignature = '';

  // session.start does not repeat after /clear or /resume. The timer reads the
  // live identity on every tick; do not cancel it on these transition events.
  on('session.end', async ($, e, next) => {
    generation += 1;
    nativeId = '';
    pending = null;
    handled.clear();
    failures = 0;
    retryAt = 0;
    blockedSignature = '';
    return next(e);
  });

  on('session.start', async ($, e, next) => {
    const ftownId = await $.env.get('FTOWN_SESSION_ID');
    if (!ftownId || !/^[a-zA-Z0-9_-]+$/.test(ftownId)) return next(e);
    const home = await $.env.get('HOME') || await $.env.get('USERPROFILE');
    const port = await $.env.get('FTOWN_HOOK_PORT');
    const token = await $.env.get('FTOWN_HOOK_TOKEN');
    let connection = /^\d+$/.test(port || '') && Number(port) > 0 && Number(port) <= 65535 && token
      ? { port: Number(port), token }
      : null;

    $.clock.every(5000, async () => {
      if (polling) return;
      polling = true;
      try {
        const currentId = await $.session.id();
        if (typeof currentId !== 'string' || !currentId) return;
        if (nativeId !== currentId) {
          generation += 1;
          nativeId = currentId;
          pending = null;
          handled.clear();
          failures = 0;
          retryAt = 0;
          blockedSignature = '';
        }
        const epoch = generation;
        /** @type {import('claude-code').HttpResponse | undefined} */
        let response;
        // A tmux process can outlive its bridge. On failure, retry once using
        // the current pointer; the bridge still verifies both exact identities.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (attempt || !connection) {
            if (!home) return;
            try {
              const pointer = JSON.parse(await $.fs.read(home + '/.ftown/bridge.json'));
              if (!Number.isInteger(pointer.port) || pointer.port < 1 || pointer.port > 65535 || typeof pointer.token !== 'string' || !pointer.token) return;
              connection = { port: pointer.port, token: pointer.token };
            } catch { return; }
          }
          const registration = blockedSignature ? '' : '&adapter=claude-mod&nativeSessionId=' + encodeURIComponent(currentId);
          const url = 'http://127.0.0.1:' + connection.port + '/api/sessions/' + encodeURIComponent(ftownId) + '/inbox?peek=1&wait=0' + registration;
          try {
            response = await $.http.fetch(url, { headers: { Authorization: 'Bearer ' + connection.token } });
          } catch { response = undefined; }
          if (response && response.ok) break;
          // Identity conflicts are authoritative: never redirect them to a
          // different bridge or submit while native registration is unresolved.
          if (response && (response.status === 400 || response.status === 409)) return;
        }
        if (!response?.ok || epoch !== generation || currentId !== await $.session.id()) return;
        /** @type {{ messages?: Array<{ id?: unknown }> }} */
        let data;
        try { data = JSON.parse(response.text); } catch { return; }
        if (!Array.isArray(data.messages)) return;
        /** @type {Set<string>} */
        const found = new Set();
        for (const message of data.messages) {
          if (typeof message?.id === 'string' && message.id.length > 0) found.add(message.id);
        }
        const ids = [...found].sort();
        const unread = new Set(ids);
        handled = new Set([...handled].filter((id) => unread.has(id)));
        const signature = JSON.stringify(ids);
        if (blockedSignature) {
          if (signature === blockedSignature) return;
          blockedSignature = '';
          failures = 0;
          retryAt = 0;
          // Re-establish the authenticated native lease on the next poll before
          // a new wake. This request deliberately omitted registration.
          return;
        }
        const fresh = ids.filter((id) => !handled.has(id));
        if (!fresh.length || pending || await $.clock.now() < retryAt) return;
        if (epoch !== generation || currentId !== await $.session.id()) return;
        const submission = { generation: epoch };
        pending = submission;
        // Never await this in a turn hook: submit waits for idle. Heartbeats
        // continue independently while the promise waits behind active work.
        void Promise.resolve().then(async () => {
          if (epoch !== generation || currentId !== await $.session.id() || epoch !== generation) return;
          return $.prompt.submit({ text: WAKE });
        }).then(async (result) => {
          if (epoch !== generation || currentId !== await $.session.id() || epoch !== generation) return;
          if (result && typeof result.text === 'string' && typeof result.drop !== 'string') {
            for (const id of fresh) handled.add(id);
            failures = 0;
            retryAt = 0;
          } else if (result && typeof result.drop === 'string') {
            failures += 1;
            retryAt = await $.clock.now() + Math.min(60000, 5000 * 2 ** (failures - 1));
            if (failures >= 3) blockedSignature = signature;
          } else {
            // Admission is unknown. Do not immediately repeat it; let the
            // native lease expire so existing compatibility delivery recovers.
            blockedSignature = signature;
          }
        }).catch(() => {
          if (epoch === generation) blockedSignature = signature;
        }).finally(() => { if (pending === submission) pending = null; });
      } catch {
        // Bridge outages, reloads and unsupported methods must not break Claude.
      } finally { polling = false; }
    });
    return next(e);
  });
}
