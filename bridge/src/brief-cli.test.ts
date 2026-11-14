import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runBrief, type BriefCliDeps } from './brief-cli.js';
import { BRIEF_LIMITS, type SessionBrief } from './coordination/contract-b.js';

const SELF = 'self-123';

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

type Handler = (call: RecordedCall) => unknown;

function harness(handler: Handler, extra?: Partial<BriefCliDeps>): {
  deps: Partial<BriefCliDeps>;
  calls: RecordedCall[];
  out: string[];
  err: string[];
} {
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: Partial<BriefCliDeps> = {
    api: async (method: string, path: string, body?: unknown) => {
      const call: RecordedCall = { method, path, body };
      calls.push(call);
      return handler(call);
    },
    env: { FTOWN_SESSION_ID: SELF },
    log: (text: string) => out.push(text),
    errorLog: (text: string) => err.push(text),
    ...extra,
  };
  return { deps, calls, out, err };
}

function briefWithNotes(count: number): SessionBrief {
  const notes = Array.from({ length: count }, (_, i) => ({
    ts: new Date(2026, 0, 2, 9, i).toISOString(),
    text: `note ${i + 1}`,
  }));
  return { text: '# Plan\nShip phase B', notes, updatedAt: new Date(2026, 0, 2, 9, count).toISOString() };
}

test('show plain prints text, then notes: and the last 10 notes as HH:MM <text>', async () => {
  const brief = briefWithNotes(12);
  const h = harness(() => ({ brief }));

  const code = await runBrief(['show'], h.deps);

  assert.equal(code, 0);
  assert.deepEqual(h.calls, [{ method: 'GET', path: `/api/sessions/${SELF}/brief`, body: undefined }]);
  const expectedNotes = brief.notes.slice(-10).map((note) => {
    const date = new Date(note.ts);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${hh}:${mm} ${note.text}`;
  });
  assert.deepEqual(h.out, ['# Plan\nShip phase B', 'notes:', ...expectedNotes]);
});

test('show --json prints the API response and --session-id overrides the env default', async () => {
  const h = harness(() => ({ brief: null }));

  const code = await runBrief(['show', '--json', '--session-id', 'other-9'], h.deps);

  assert.equal(code, 0);
  assert.deepEqual(h.calls, [{ method: 'GET', path: '/api/sessions/other-9/brief', body: undefined }]);
  assert.deepEqual(JSON.parse(h.out.join('\n')), { brief: null });
});

test('show with no brief prints a plain placeholder', async () => {
  const h = harness(() => ({ brief: null }));

  assert.equal(await runBrief(['show'], h.deps), 0);
  assert.deepEqual(h.out, ['No brief set.']);
});

test('set --text PUTs the text and prints the returned brief', async () => {
  const brief: SessionBrief = { text: 'Hello brief', notes: [], updatedAt: '2026-01-02T09:00:00.000Z' };
  const h = harness(() => ({ brief }));

  const code = await runBrief(['set', '--text', 'Hello brief'], h.deps);

  assert.equal(code, 0);
  assert.deepEqual(h.calls, [{ method: 'PUT', path: `/api/sessions/${SELF}/brief`, body: { text: 'Hello brief' } }]);
  assert.deepEqual(h.out, ['Hello brief', 'notes:']);
});

test('set --file reads a real file and PUTs its contents', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-brief-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'brief.md');
  await writeFile(file, '# From file\nMilestones');
  const h = harness(() => ({ brief: { text: '# From file\nMilestones', notes: [], updatedAt: '2026-01-02T09:00:00.000Z' } }));

  const code = await runBrief(['set', '--file', file], h.deps);

  assert.equal(code, 0);
  assert.deepEqual(h.calls, [{ method: 'PUT', path: `/api/sessions/${SELF}/brief`, body: { text: '# From file\nMilestones' } }]);
});

test('set --file over the byte limit exits 1 without calling the API; missing file exits 1', async () => {
  const big = harness(() => ({ brief: null }), { readFile: async () => Buffer.alloc(BRIEF_LIMITS.text + 1) });
  assert.equal(await runBrief(['set', '--file', 'big.md'], big.deps), 1);
  assert.equal(big.calls.length, 0);
  assert.match(big.err.join('\n'), /exceeds/);

  const missing = harness(() => ({ brief: null }));
  assert.equal(await runBrief(['set', '--file', join(tmpdir(), 'ftown-brief-definitely-missing.md')], missing.deps), 1);
  assert.equal(missing.calls.length, 0);
});

test('set --clear PUTs text:null (notes kept server-side)', async () => {
  const h = harness(() => ({ brief: { notes: [], updatedAt: '2026-01-02T09:00:00.000Z' } }));

  const code = await runBrief(['set', '--clear'], h.deps);

  assert.equal(code, 0);
  assert.deepEqual(h.calls, [{ method: 'PUT', path: `/api/sessions/${SELF}/brief`, body: { text: null } }]);
});

test('set requires exactly one of --file/--text/--clear (usage exit 2, no API call)', async () => {
  const none = harness(() => ({ brief: null }));
  assert.equal(await runBrief(['set'], none.deps), 2);
  assert.equal(none.calls.length, 0);

  const both = harness(() => ({ brief: null }));
  assert.equal(await runBrief(['set', '--text', 'x', '--clear'], both.deps), 2);
  assert.equal(both.calls.length, 0);
});

test('set --text over the limit exits 1 without calling the API', async () => {
  const h = harness(() => ({ brief: null }));

  assert.equal(await runBrief(['set', '--text', 'x'.repeat(BRIEF_LIMITS.text + 1)], h.deps), 1);
  assert.equal(h.calls.length, 0);
});

test('note joins words, POSTs to the notes route, and honours a trailing --session-id', async () => {
  const brief: SessionBrief = {
    text: 'Plan',
    notes: [{ ts: new Date(2026, 0, 2, 14, 30).toISOString(), text: 'hello world' }],
    updatedAt: '2026-01-02T14:30:00.000Z',
  };
  const h = harness(() => ({ brief }));

  const code = await runBrief(['note', 'hello', 'world', '--session-id', 'other-9'], h.deps);

  assert.equal(code, 0);
  assert.deepEqual(h.calls, [{ method: 'POST', path: '/api/sessions/other-9/brief/notes', body: { text: 'hello world' } }]);
  assert.equal(h.out[h.out.length - 1], '14:30 hello world');
});

test('usage and API errors: no command, unknown command, missing note text -> 2; API failure -> 1; no session id -> 2', async () => {
  const empty = harness(() => ({ brief: null }));
  assert.equal(await runBrief([], empty.deps), 2);

  const unknown = harness(() => ({ brief: null }));
  assert.equal(await runBrief(['bogus'], unknown.deps), 2);
  assert.equal(unknown.calls.length, 0);

  const noText = harness(() => ({ brief: null }));
  assert.equal(await runBrief(['note'], noText.deps), 2);
  assert.equal(noText.calls.length, 0);

  const failing = harness(() => { throw new Error('bridge down'); });
  assert.equal(await runBrief(['show'], failing.deps), 1);
  assert.match(failing.err.join('\n'), /bridge down/);

  const noId = harness(() => ({ brief: null }), { env: {} });
  assert.equal(await runBrief(['show'], noId.deps), 2);
  assert.equal(noId.calls.length, 0);
});
