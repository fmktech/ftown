import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Session } from '../types.js';
import type { RouteContext, SessionBrief } from './contract-b.js';
import { BRIEF_LIMITS, RouteError } from './contract-b.js';
import { handleBriefRoutes } from './routes-brief.js';

function makeSession(id: string, brief?: SessionBrief): Session {
  const session: Session = {
    id,
    name: `name-${id}`,
    command: 'shell',
    status: 'running',
    bridgeId: 'bridge-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  if (brief) session.brief = brief;
  return session;
}

interface jsonResponse { status: number; body: unknown }

function makeCtx(sessions: Map<string, Session>, method: string, path: string, body?: unknown): RouteContext & { responses: jsonResponse[]; saved: string[]; published: string[] } {
  const responses: jsonResponse[] = [];
  const saved: string[] = [];
  const published: string[] = [];
  return {
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    method,
    path,
    query: new URLSearchParams(),
    parseBody: async () => body as Record<string, unknown>,
    json(status, result) { responses.push({ status, body: result }); },
    loadSession: async (id) => sessions.get(id) ?? null,
    saveSession: async (session) => { sessions.set(session.id, session); saved.push(session.id); },
    publishSession: (session) => { published.push(session.id); },
    responses,
    saved,
    published,
  };
}

function brief(overrides: Partial<SessionBrief> = {}): SessionBrief {
  return {
    text: '# Plan\nBuild it',
    notes: [{ ts: '2026-01-01T00:00:00.000Z', text: 'started' }],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function expectRouteError(promise: Promise<unknown>, status: number, message?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RouteError);
    assert.equal(error.status, status);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

test('returns false for non-matching paths', async () => {
  const sessions = new Map<string, Session>();
  for (const path of [
    '/api/sessions/s1/card',
    '/api/sessions/s1/brief/extra',
    '/api/sessions/s1/attention/routed',
    '/api/brief',
  ]) {
    const ctx = makeCtx(sessions, 'GET', path);
    assert.equal(await handleBriefRoutes(ctx), false);
    assert.equal(ctx.responses.length, 0);
  }
});

test('GET returns the stored brief and null when absent', async () => {
  const sessions = new Map<string, Session>([
    ['s1', makeSession('s1', brief())],
    ['s2', makeSession('s2')],
  ]);
  const ctx1 = makeCtx(sessions, 'GET', '/api/sessions/s1/brief');
  assert.equal(await handleBriefRoutes(ctx1), true);
  assert.deepEqual(ctx1.responses, [{ status: 200, body: { brief: brief() } }]);

  const ctx2 = makeCtx(sessions, 'GET', '/api/sessions/s2/brief');
  assert.equal(await handleBriefRoutes(ctx2), true);
  assert.deepEqual(ctx2.responses, [{ status: 200, body: { brief: null } }]);
});

test('GET unknown session → 404', async () => {
  const sessions = new Map<string, Session>();
  const ctx = makeCtx(sessions, 'GET', '/api/sessions/missing/brief');
  await expectRouteError(handleBriefRoutes(ctx), 404);
});

test('PUT stores cleaned text, stamps updatedAt, saves and publishes', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1')]]);
  const ctx = makeCtx(sessions, 'PUT', '/api/sessions/s1/brief', { text: '# Plan\nBuild\tit' });
  assert.equal(await handleBriefRoutes(ctx), true);
  const stored = sessions.get('s1')?.brief;
  assert.ok(stored);
  assert.equal(stored.text, '# Plan\nBuild\tit');
  assert.deepEqual(stored.notes, []);
  assert.notEqual(stored.updatedAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(ctx.responses, [{ status: 200, body: { brief: stored } }]);
  assert.deepEqual(ctx.saved, ['s1']);
  assert.deepEqual(ctx.published, ['s1']);
});

test('PUT strips control characters except \\n and \\t', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1')]]);
  const ctx = makeCtx(sessions, 'PUT', '/api/sessions/s1/brief', { text: 'ab\rc\bd\u007f\fe\rt\tg\nh' });
  assert.equal(await handleBriefRoutes(ctx), true);
  assert.equal(sessions.get('s1')?.brief?.text, 'abcdet\tg\nh');
});

test('PUT strips C1 control characters U+0080–U+009F', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1')]]);
  const ctx = makeCtx(sessions, 'PUT', '/api/sessions/s1/brief', { text: 'a\u0085b\u009fc' });
  assert.equal(await handleBriefRoutes(ctx), true);
  assert.equal(sessions.get('s1')?.brief?.text, 'abc');
});

test('text that is only control characters is treated as null', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1', brief())]]);
  const ctx = makeCtx(sessions, 'PUT', '/api/sessions/s1/brief', { text: '\u0085\u009f\r\x00' });
  assert.equal(await handleBriefRoutes(ctx), true);
  const stored = sessions.get('s1')?.brief;
  assert.ok(stored);
  assert.equal(stored.text, undefined);
  assert.deepEqual(stored.notes, brief().notes);

  const none = new Map<string, Session>([['s2', makeSession('s2')]]);
  const ctx2 = makeCtx(none, 'PUT', '/api/sessions/s2/brief', { text: '\u0085\u009f' });
  assert.equal(await handleBriefRoutes(ctx2), true);
  assert.equal(none.get('s2')?.brief, undefined);
  assert.deepEqual(ctx2.responses, [{ status: 200, body: { brief: null } }]);
});

test('PUT text over BRIEF_LIMITS.text → 400 and nothing saved', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1')]]);
  const ctx = makeCtx(sessions, 'PUT', '/api/sessions/s1/brief', { text: 'x'.repeat(BRIEF_LIMITS.text + 1) });
  await expectRouteError(handleBriefRoutes(ctx), 400);
  assert.equal(sessions.get('s1')?.brief, undefined);
  assert.deepEqual(ctx.saved, []);
});

test('PUT keeps existing notes and rejects unknown body keys', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1', brief())]]);
  const ctx = makeCtx(sessions, 'PUT', '/api/sessions/s1/brief', { text: 'new text', extra: 1 });
  await expectRouteError(handleBriefRoutes(ctx), 400);
  assert.deepEqual(sessions.get('s1')?.brief, brief());
});

test('PUT without text → 400', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1', brief())]]);
  await expectRouteError(handleBriefRoutes(makeCtx(sessions, 'PUT', '/api/sessions/s1/brief', {})), 400);
  await expectRouteError(handleBriefRoutes(makeCtx(sessions, 'PUT', '/api/sessions/s1/brief', { text: 42 })), 400);
});

test('PUT text:null clears text but keeps notes; clearing an empty brief drops it', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1', brief())]]);
  const ctx = makeCtx(sessions, 'PUT', '/api/sessions/s1/brief', { text: null });
  assert.equal(await handleBriefRoutes(ctx), true);
  const stored = sessions.get('s1')?.brief;
  assert.ok(stored);
  assert.equal(stored.text, undefined);
  assert.deepEqual(stored.notes, brief().notes);
  assert.deepEqual(ctx.responses.at(-1), { status: 200, body: { brief: stored } });

  const empty = new Map<string, Session>([['s2', makeSession('s2', { notes: [], updatedAt: '2026-01-01T00:00:00.000Z' })]]);
  const ctx2 = makeCtx(empty, 'PUT', '/api/sessions/s2/brief', { text: null });
  assert.equal(await handleBriefRoutes(ctx2), true);
  assert.equal(empty.get('s2')?.brief, undefined);
  assert.deepEqual(ctx2.responses, [{ status: 200, body: { brief: null } }]);

  const none = new Map<string, Session>([['s3', makeSession('s3')]]);
  const ctx3 = makeCtx(none, 'PUT', '/api/sessions/s3/brief', { text: null });
  assert.equal(await handleBriefRoutes(ctx3), true);
  assert.equal(none.get('s3')?.brief, undefined);
  assert.deepEqual(ctx3.responses, [{ status: 200, body: { brief: null } }]);
});

test('DELETE removes the brief and publishes; absent brief is a no-op ok', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1', brief())]]);
  const ctx = makeCtx(sessions, 'DELETE', '/api/sessions/s1/brief');
  assert.equal(await handleBriefRoutes(ctx), true);
  assert.equal(sessions.get('s1')?.brief, undefined);
  assert.deepEqual(ctx.responses, [{ status: 200, body: { ok: true } }]);
  assert.deepEqual(ctx.saved, ['s1']);
  assert.deepEqual(ctx.published, ['s1']);

  const bare = new Map<string, Session>([['s2', makeSession('s2')]]);
  const ctx2 = makeCtx(bare, 'DELETE', '/api/sessions/s2/brief');
  assert.equal(await handleBriefRoutes(ctx2), true);
  assert.deepEqual(ctx2.responses, [{ status: 200, body: { ok: true } }]);
  assert.deepEqual(ctx2.saved, ['s2']);
});

test('POST notes appends a cleaned single-line note, newest last', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1', brief())]]);
  const ctx = makeCtx(sessions, 'POST', '/api/sessions/s1/brief/notes', { text: '  milestone\tone\nsecond line ' });
  assert.equal(await handleBriefRoutes(ctx), true);
  const stored = sessions.get('s1')?.brief;
  assert.ok(stored);
  assert.equal(stored.notes.length, 2);
  assert.deepEqual(stored.notes[0], brief().notes[0]);
  assert.equal(stored.notes[1].text, 'milestone one second line');
  assert.match(stored.notes[1].ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(stored.text, brief().text);
  assert.notEqual(stored.updatedAt, brief().updatedAt);
  assert.deepEqual(ctx.responses.at(-1), { status: 200, body: { brief: stored } });
  assert.deepEqual(ctx.saved, ['s1']);
  assert.deepEqual(ctx.published, ['s1']);
});

test('POST notes strips control characters including C1 U+0080–U+009F', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1')]]);
  const ctx = makeCtx(sessions, 'POST', '/api/sessions/s1/brief/notes', { text: '\u0093hidden\u0084\n\u0007ok' });
  assert.equal(await handleBriefRoutes(ctx), true);
  assert.equal(sessions.get('s1')?.brief?.notes.at(-1)?.text, 'hidden ok');
});

test('POST notes keeps concurrent appends: brief is rebuilt from the freshly reloaded session', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1', brief())]]);
  const base = makeCtx(sessions, 'POST', '/api/sessions/s1/brief/notes', { text: 'mine' });
  let loads = 0;
  const ctx: RouteContext = {
    ...base,
    loadSession: async (id) => {
      loads += 1;
      if (loads === 2) {
        // Another writer appends between the handler's first load and the reload inside the save step.
        const concurrent = sessions.get(id);
        if (concurrent?.brief) concurrent.brief.notes.push({ ts: '2026-01-02T00:00:00.000Z', text: 'concurrent' });
      }
      return sessions.get(id) ?? null;
    },
  };
  assert.equal(await handleBriefRoutes(ctx), true);
  const stored = sessions.get('s1')?.brief;
  assert.ok(stored);
  assert.deepEqual(stored.notes.map((note) => note.text), ['started', 'concurrent', 'mine']);
});

test('POST notes creates a brief when none exists', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1')]]);
  const ctx = makeCtx(sessions, 'POST', '/api/sessions/s1/brief/notes', { text: 'first note' });
  assert.equal(await handleBriefRoutes(ctx), true);
  const stored = sessions.get('s1')?.brief;
  assert.ok(stored);
  assert.equal(stored.text, undefined);
  assert.deepEqual(stored.notes, [{ ts: stored.notes[0]?.ts, text: 'first note' }]);
});

test('POST notes validation: empty, over-limit, multi-line collapsed, unknown keys', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1', brief())]]);
  await expectRouteError(
    handleBriefRoutes(makeCtx(sessions, 'POST', '/api/sessions/s1/brief/notes', { text: '   ' })),
    400,
  );
  await expectRouteError(
    handleBriefRoutes(makeCtx(sessions, 'POST', '/api/sessions/s1/brief/notes', { text: 'y'.repeat(BRIEF_LIMITS.note + 1) })),
    400,
  );
  const ok = makeCtx(sessions, 'POST', '/api/sessions/s1/brief/notes', { text: 'z'.repeat(BRIEF_LIMITS.note) });
  assert.equal(await handleBriefRoutes(ok), true);
  await expectRouteError(
    handleBriefRoutes(makeCtx(sessions, 'POST', '/api/sessions/s1/brief/notes', { text: 'note', junk: true })),
    400,
  );
  await expectRouteError(
    handleBriefRoutes(makeCtx(sessions, 'POST', '/api/sessions/s1/brief/notes', {})),
    400,
  );
  assert.equal(sessions.get('s1')?.brief?.notes.length, 2);
});

test('notes list is capped at BRIEF_LIMITS.notes by dropping the oldest', async () => {
  const notes = Array.from({ length: BRIEF_LIMITS.notes }, (_, i) => ({ ts: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`, text: `n${i}` }));
  const sessions = new Map<string, Session>([['s1', makeSession('s1', brief({ notes }))]]);
  const ctx = makeCtx(sessions, 'POST', '/api/sessions/s1/brief/notes', { text: 'latest' });
  assert.equal(await handleBriefRoutes(ctx), true);
  const stored = sessions.get('s1')?.brief;
  assert.ok(stored);
  assert.equal(stored.notes.length, BRIEF_LIMITS.notes);
  assert.equal(stored.notes[0].text, 'n1');
  assert.equal(stored.notes.at(-1)?.text, 'latest');
});

test('unsupported method on a matching path → 405', async () => {
  const sessions = new Map<string, Session>([['s1', makeSession('s1')]]);
  await expectRouteError(handleBriefRoutes(makeCtx(sessions, 'POST', '/api/sessions/s1/brief', { text: 'x' })), 405);
  await expectRouteError(handleBriefRoutes(makeCtx(sessions, 'GET', '/api/sessions/s1/brief/notes')), 405);
});

test('PUT/POST on unknown session → 404 before validation side effects', async () => {
  const sessions = new Map<string, Session>();
  await expectRouteError(handleBriefRoutes(makeCtx(sessions, 'PUT', '/api/sessions/missing/brief', { text: 'x' })), 404);
  await expectRouteError(handleBriefRoutes(makeCtx(sessions, 'POST', '/api/sessions/missing/brief/notes', { text: 'x' })), 404);
});
