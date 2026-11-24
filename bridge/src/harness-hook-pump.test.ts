import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { pumpCountPath, runHarness } from './harness-commands.js';
import { secureFixture } from './security/bridge/fixtures.test.js';
import type { MailMessage } from './wire-types.js';

interface PumpRun {
  exitCode: number;
  stdout: string[];
  stderr: string[];
  inboxRequests: string[];
  mail: MailMessage[];
}

/**
 * Runs `ftown-harness hook-pump` in-process against a fake encrypted bridge
 * whose inbox holds one undelivered message. process.env is replaced by a
 * minimal environment built from scratch (and restored), so a real bridge or
 * real FTOWN_* values in the parent environment are never touched.
 */
async function runPump(hook: Record<string, unknown>, extraEnv: Record<string, string>, codex = false, message?: Partial<MailMessage>): Promise<PumpRun> {
  const home = mkdtempSync(join(tmpdir(), 'ftown-hook-pump-'));
  const sessionId = `pump-${randomBytes(6).toString('hex')}`;
  const mail: MailMessage[] = [
    { id: 'm1', ts: '2026-01-01T00:00:00.000Z', from: 'sender', fromName: 'sender', to: sessionId, type: 'message', body: 'hello pump', ...message },
  ];
  const inboxRequests: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];

  const savedEnv = { ...process.env };
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const previousError = console.error;

  let secure: Awaited<ReturnType<typeof secureFixture>> | undefined;
  try {
    mkdirSync(join(home, '.ftown'));
    secure = await secureFixture(join(home, '.ftown'), (async (url, init) => {
      const path = new URL(String(url)).pathname;
      if ((init?.method ?? 'GET') === 'GET' && path === `/api/sessions/${sessionId}/inbox`) {
        inboxRequests.push(String(url));
        const peek = new URL(String(url)).searchParams.get('peek') === '1';
        const pending = mail.filter((m) => !m.deliveredAt);
        if (!peek) for (const m of pending) { m.deliveredAt = new Date().toISOString(); m.deliveredVia = 'cli'; }
        return new Response(JSON.stringify({ messages: pending }));
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 404 });
    }) as typeof fetch, 12346);
    writeFileSync(join(home, '.ftown', 'bridge.json'), JSON.stringify(secure.pointer));

    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, {
      HOME: home,
      FTOWN_DATA_DIR: join(home, '.ftown', 'data'),
      FTOWN_SESSION_ID: sessionId,
      ...extraEnv,
    });
    Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from([Buffer.from(JSON.stringify(hook))]) });
    globalThis.fetch = secure.fetch;
    console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(' ')); };

    const exitCode = await runHarness(['hook-pump', ...(codex ? ['--codex'] : [])]);
    return { exitCode, stdout, stderr, inboxRequests, mail };
  } finally {
    console.log = previousLog;
    console.error = previousError;
    globalThis.fetch = previousFetch;
    if (stdinDescriptor) Object.defineProperty(process, 'stdin', stdinDescriptor);
    // Remove the counter while the test env is still active: pumpCountPath()
    // derives its location from TMPDIR, which is about to be restored.
    rmSync(pumpCountPath(sessionId), { force: true });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await secure?.security.close();
    rmSync(home, { recursive: true, force: true });
  }
}

const EVENTS = [
  { name: 'Stop', grok: 'stop', hook: { hook_event_name: 'Stop', session_id: 'conv-1' } },
  { name: 'UserPromptSubmit', grok: 'user_prompt_submit', hook: { hook_event_name: 'UserPromptSubmit', session_id: 'conv-1', prompt: 'hi' } },
  { name: 'SessionStart', grok: 'session_start', hook: { hook_event_name: 'SessionStart', session_id: 'conv-1' } },
] as const;

/** Grok sends both its camelCase hookEventName and the Claude-compatible snake_case key. */
function grokPayload(event: (typeof EVENTS)[number]): Record<string, unknown> {
  return { ...event.hook, hookEventName: event.grok };
}

describe('hook-pump under Grok', () => {
  for (const event of EVENTS) {
    it(`stands down on ${event.name}: no inbox request, no output, exit 0, mail stays undelivered`, async () => {
      const run = await runPump(grokPayload(event), { GROK_HOOK_EVENT: event.grok });
      assert.equal(run.exitCode, 0);
      assert.deepEqual(run.inboxRequests, []);
      assert.deepEqual(run.stdout, []);
      assert.deepEqual(run.stderr, []);
      assert.equal(run.mail[0].deliveredAt, undefined);
    });
  }

  it('points a project discussion notification at the discussion reply command during Stop', async () => {
    const run = await runPump(EVENTS[0].hook, {}, false, { from: 'project-discussion', fromName: 'Team discussion', body: 'Hi pm' });
    const { reason } = JSON.parse(run.stdout[0]);
    assert.match(reason, /Hi pm/);
    assert.match(reason, /ftown discuss reply/);
    assert.doesNotMatch(reason, /ftown harness mail send/);
  });

  it('inherited GROK_HOOK_EVENT with a Claude-shaped Stop payload still drains and blocks', async () => {
    const run = await runPump(EVENTS[0].hook, { GROK_HOOK_EVENT: 'stop' });
    assert.equal(run.exitCode, 0);
    assert.equal(run.inboxRequests.length, 1);
    assert.equal(run.stdout.length, 1);
    const output = JSON.parse(run.stdout[0]) as { decision: string; reason: string };
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /hello pump/);
    assert.deepEqual(run.stderr, []);
    assert.ok(run.mail[0].deliveredAt);
  });
});

describe('hook-pump outside Grok', () => {
  for (const event of EVENTS) {
    it(`Codex ${event.name} presents a pointer without consuming mail`, async () => {
      const run = await runPump(event.hook, {}, true);
      assert.equal(run.exitCode, 0);
      assert.match(run.inboxRequests[0], /peek=1/);
      assert.equal(run.mail[0].deliveredAt, undefined);
      assert.match(run.stdout[0], /ftown harness mail read/);
      assert.doesNotMatch(run.stdout[0], /hello pump/);
      assert.deepEqual(run.stderr, []);
    });
  }
  for (const [label, extraEnv] of [['GROK_HOOK_EVENT unset', {}], ['GROK_HOOK_EVENT empty', { GROK_HOOK_EVENT: '' }]] as const) {
    it(`${label}: Stop blocks with the drained mail`, async () => {
      const run = await runPump(EVENTS[0].hook, extraEnv);
      assert.equal(run.exitCode, 0);
      assert.equal(run.inboxRequests.length, 1);
      assert.match(run.inboxRequests[0], /wait=0/);
      assert.doesNotMatch(run.inboxRequests[0], /peek=1/);
      assert.equal(run.stdout.length, 1);
      const output = JSON.parse(run.stdout[0]) as { decision: string; reason: string };
      assert.equal(output.decision, 'block');
      assert.match(output.reason, /hello pump/);
      assert.deepEqual(run.stderr, []);
      assert.ok(run.mail[0].deliveredAt);
    });

    for (const event of EVENTS.slice(1)) {
      it(`${label}: ${event.name} adds the drained mail as additional context`, async () => {
        const run = await runPump(event.hook, extraEnv);
        assert.equal(run.exitCode, 0);
        assert.equal(run.inboxRequests.length, 1);
        assert.equal(run.stdout.length, 1);
        const output = JSON.parse(run.stdout[0]) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
        assert.equal(output.hookSpecificOutput.hookEventName, event.name);
        assert.match(output.hookSpecificOutput.additionalContext, /^\[ftown mail\]\n/);
        assert.match(output.hookSpecificOutput.additionalContext, /hello pump/);
        assert.deepEqual(run.stderr, []);
        assert.ok(run.mail[0].deliveredAt);
      });
    }
  }
});

describe('mail pump counter path', () => {
  it('honours TMPDIR instead of a hardcoded /tmp', () => {
    const previousTmpdir = process.env.TMPDIR;
    const customTmp = mkdtempSync(join(tmpdir(), 'ftown-pump-tmpdir-'));
    try {
      process.env.TMPDIR = customTmp;
      assert.equal(
        pumpCountPath('abc'),
        join(customTmp, 'ftown-mail-pump-abc.count'),
      );
      process.env.TMPDIR = join(customTmp, 'nested');
      assert.equal(
        pumpCountPath('abc'),
        join(customTmp, 'nested', 'ftown-mail-pump-abc.count'),
      );
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      rmSync(customTmp, { recursive: true, force: true });
    }
  });
});

interface MailReadOptions {
  args?: string[];
  history?: boolean;
  fetchFailure?: boolean;
  ackFailure?: boolean;
  outputFailure?: boolean;
  moreAvailable?: boolean;
  nextOffset?: number;
  oversizedMessages?: Array<{ id: string; serializedBytes: number; index?: number }>;
  oversizedBodies?: Record<string, string>;
  oversizedMetadata?: Record<string, string>;
  noReadableMessages?: boolean;
  chunkFailureAt?: number;
  continuationTickets?: Map<string, { mailId: string; body: number; metadata: number; complete: boolean }>;
  expectFailure?: boolean;
}

/** Real encrypted client with a mailbox and stdout double; no listener or live session. */
async function runMailRead(options: MailReadOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ftown-mail-read-'));
  const savedEnv = { ...process.env };
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout');
  const previousFetch = globalThis.fetch;
  const previousError = console.error;
  const requests: Array<{ method: string; url: URL; ids?: string[] }> = [];
  const events: string[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const tickets = options.continuationTickets ?? new Map<string, { mailId: string; body: number; metadata: number; complete: boolean }>();
  const mail: MailMessage[] = [{ id: 'unread', ts: '2026-01-01T00:00:00.000Z', from: 'parent', to: 'recipient', type: 'task', body: 'queued task' }];
  if (options.history) mail.push({ ...mail[0], id: 'history', body: 'old task', deliveredAt: '2026-01-02T00:00:00.000Z', deliveredVia: 'cli' });
  let outputStarted!: () => void;
  const started = new Promise<void>(resolve => { outputStarted = resolve; });
  let completeOutput: ((error?: Error | null) => void) | undefined;
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      events.push('output'); output.push(chunk.toString()); completeOutput = callback; outputStarted();
    },
  });
  let secure: Awaited<ReturnType<typeof secureFixture>> | undefined;
  try {
    mkdirSync(join(home, '.ftown'));
    secure = await secureFixture(join(home, '.ftown'), (async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const chunkId = /^\/api\/sessions\/recipient\/inbox\/([^/]+)\/chunk$/.exec(url.pathname)?.[1];
      if (method === 'GET' && chunkId) {
        requests.push({ method, url }); events.push('chunk');
        if (options.chunkFailureAt !== undefined) return new Response(JSON.stringify({ error: 'chunk failed' }), { status: 503 });
        const cursor = url.searchParams.get('cursor');
        const progress = cursor ? tickets.get(cursor) : { mailId: chunkId, body: 0, metadata: 0, complete: false };
        if (!progress || progress.mailId !== chunkId || progress.complete) return new Response(JSON.stringify({ error: 'invalid cursor' }), { status: 400 });
        const body = options.oversizedBodies?.[chunkId];
        const metadata = options.oversizedMetadata?.[chunkId] ?? JSON.stringify({ id: chunkId, ts: '', from: 'parent', to: 'recipient', type: 'task' });
        if (body === undefined) return new Response(JSON.stringify({ error: 'missing body' }), { status: 404 });
        if (cursor) tickets.delete(cursor);
        const part = (content: string, offset: number) => {
          const end = Math.min(offset + 7000, content.length);
          return { offset, chunk: content.slice(offset, end), totalChars: content.length, nextOffset: end < content.length ? end : null };
        };
        const bodyPart = part(body, progress.body); const metadataPart = part(metadata, progress.metadata);
        const complete = bodyPart.nextOffset === null && metadataPart.nextOffset === null;
        const token = randomBytes(32).toString('base64url');
        tickets.set(token, { mailId: chunkId, body: bodyPart.nextOffset ?? body.length, metadata: metadataPart.nextOffset ?? metadata.length, complete });
        return new Response(JSON.stringify({ messageId: chunkId, body: bodyPart, metadata: metadataPart,
          nextCursor: complete ? null : token, completionToken: complete ? token : null }));
      }
      if (method === 'GET' && url.pathname === '/api/sessions/recipient/inbox') {
        requests.push({ method, url }); events.push('fetch');
        if (options.fetchFailure) return new Response(JSON.stringify({ error: 'fetch failed' }), { status: 503 });
        const messages = options.noReadableMessages ? [] : url.searchParams.get('all') === '1' ? mail : mail.filter(message => !message.deliveredAt);
        if (url.searchParams.get('peek') !== '1') {
          for (const message of messages) { message.deliveredAt = new Date().toISOString(); message.deliveredVia = 'drain'; }
        }
        return new Response(JSON.stringify({ messages, moreAvailable: options.moreAvailable ?? false,
          nextOffset: options.nextOffset ?? null, oversizedMessages: options.oversizedMessages ?? [] }));
      }
      if (method === 'POST' && url.pathname === '/api/sessions/recipient/inbox/ack') {
        const { ids, completionToken } = JSON.parse(String(init?.body)) as { ids: string[]; completionToken?: string };
        if (completionToken) { assert.equal(tickets.get(completionToken)?.complete, true); assert.equal(ids.length, 1); tickets.delete(completionToken); }
        requests.push({ method, url, ids }); events.push('ack');
        if (options.ackFailure) return new Response(JSON.stringify({ error: 'ack failed' }), { status: 503 });
        const messages = mail.filter(message => ids.includes(message.id) && !message.deliveredAt);
        for (const message of messages) { message.deliveredAt = new Date().toISOString(); message.deliveredVia = 'cli'; }
        return new Response(JSON.stringify({ acknowledgedIds: messages.map(message => message.id) }));
      }
      return new Response(JSON.stringify({ error: 'unexpected route' }), { status: 404 });
    }) as typeof fetch, 12347);
    writeFileSync(join(home, '.ftown', 'bridge.json'), JSON.stringify(secure.pointer));
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, { HOME: home, FTOWN_DATA_DIR: join(home, '.ftown', 'data'), FTOWN_SESSION_ID: 'recipient' });
    Object.defineProperty(process, 'stdout', { configurable: true, value: stdout });
    globalThis.fetch = secure.fetch;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };

    const running = runHarness(['mail', 'read', ...(options.args ?? [])]);
    if (!options.fetchFailure && options.chunkFailureAt === undefined && !options.expectFailure) {
      await started;
      assert.equal(requests.some(request => request.method === 'POST'), false, 'ack must wait until stdout completes');
      events.push('output-complete');
      completeOutput?.(options.outputFailure ? new Error('stdout failed') : undefined);
    }
    const exitCode = await running;
    // A failed Writable emits its error after the write callback.
    await new Promise<void>(resolve => setImmediate(resolve));
    return { exitCode, requests, events, output, errors, mail };
  } finally {
    console.error = previousError;
    globalThis.fetch = previousFetch;
    if (stdoutDescriptor) Object.defineProperty(process, 'stdout', stdoutDescriptor);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await secure?.security.close();
    rmSync(home, { recursive: true, force: true });
  }
}

describe('explicit mail read acknowledgment', () => {
  for (const args of [[], ['--json']]) {
    it(`emits ${args.length ? 'JSON' : 'human'} output before acknowledging queued mail`, async () => {
      const run = await runMailRead({ args });
      assert.equal(run.exitCode, 0);
      assert.equal(run.requests[0].url.searchParams.get('peek'), '1');
      assert.deepEqual(run.events, ['fetch', 'output', 'output-complete', 'ack']);
      assert.deepEqual(run.requests[1].ids, ['unread']);
      assert.match(run.output.join(''), /queued task/);
      assert.equal(run.mail[0].deliveredVia, 'cli');
    });
  }

  it('peek emits queued mail without acknowledging it', async () => {
    const run = await runMailRead({ args: ['--peek', '--json'] });
    assert.equal(run.exitCode, 0);
    assert.equal(run.requests.length, 1);
    assert.equal(run.mail[0].deliveredAt, undefined);
  });

  it('all includes history but acknowledges only undelivered rows', async () => {
    const run = await runMailRead({ args: ['--all', '--json'], history: true });
    assert.equal(run.exitCode, 0);
    assert.equal(run.requests[0].url.searchParams.get('all'), '1');
    assert.deepEqual(run.requests[1].ids, ['unread']);
    assert.equal(run.mail[1].deliveredAt, '2026-01-02T00:00:00.000Z');
    assert.match(run.output.join(''), /old task/);
  });

  it('passes history offsets and reports the next page in JSON output', async () => {
    const run = await runMailRead({ args: ['--all', '--offset', '2', '--limit', '1', '--json'], moreAvailable: true, nextOffset: 3 });
    assert.equal(run.exitCode, 0);
    assert.equal(run.requests[0].url.searchParams.get('offset'), '2');
    assert.equal(run.requests[0].url.searchParams.get('limit'), '1');
    assert.equal(JSON.parse(run.output.join('')).nextOffset, 3);
    assert.equal(JSON.parse(run.output.join('')).moreAvailable, true);
  });

  it('uses opaque one-time cursors for contiguous exact output and acknowledges only the final token', async () => {
    const body = '\0'.repeat(65536);
    const metadata = JSON.stringify({ id: 'too-large', from: 'parent', fromName: '\0'.repeat(12000), threadId: 'thread'.repeat(3000), to: 'recipient', type: 'task' });
    const tickets = new Map<string, { mailId: string; body: number; metadata: number; complete: boolean }>();
    const bodies: string[] = []; const metas: string[] = []; let cursor: string | undefined;
    for (;;) {
      const run = await runMailRead({ args: ['--message-id', 'too-large', ...(cursor ? ['--cursor', cursor] : []), '--json'],
        oversizedBodies: { 'too-large': body }, oversizedMetadata: { 'too-large': metadata }, continuationTickets: tickets });
      assert.equal(run.exitCode, 0); assert.ok(Buffer.byteLength(run.output.join('')) < 100000);
      const output = JSON.parse(run.output.join('')); bodies.push(output.body.chunk); metas.push(output.metadata.chunk);
      if (output.complete) {
        assert.deepEqual(run.requests.find(request => request.method === 'POST')?.ids, ['too-large']);
        assert.deepEqual(run.events, ['chunk', 'output', 'output-complete', 'ack']); break;
      }
      assert.equal(run.requests.some(request => request.method === 'POST'), false);
      assert.ok(output.continuation.includes(`--cursor ${output.nextCursor}`)); cursor = output.nextCursor;
    }
    assert.equal(bodies.join(''), body); assert.equal(metas.join(''), metadata);
  });

  it('rejects numeric end-offset skips, fabricated cursors, replay and cross-message continuation without acknowledgment', async () => {
    const tickets = new Map<string, { mailId: string; body: number; metadata: number; complete: boolean }>();
    const common = { oversizedBodies: { large: 'x'.repeat(20000), other: 'other' }, continuationTickets: tickets };
    const bypass = await runMailRead({ ...common, args: ['--message-id', 'large', '--body-offset', '20000', '--metadata-offset', '10000'], expectFailure: true });
    assert.equal(bypass.exitCode, 1); assert.equal(bypass.requests.length, 0);
    const first = await runMailRead({ ...common, args: ['--message-id', 'large', '--json'] });
    const cursor = JSON.parse(first.output.join('')).nextCursor as string;
    const wrong = await runMailRead({ ...common, args: ['--message-id', 'other', '--cursor', cursor, '--json'], expectFailure: true });
    assert.equal(wrong.exitCode, 1);
    const second = await runMailRead({ ...common, args: ['--message-id', 'large', '--cursor', cursor, '--json'] });
    assert.equal(second.exitCode, 0);
    for (const value of [cursor, 'x'.repeat(43)]) {
      const bad = await runMailRead({ ...common, args: ['--message-id', 'large', '--cursor', value, '--json'], expectFailure: true });
      assert.equal(bad.exitCode, 1); assert.equal(bad.requests.some(request => request.method === 'POST'), false);
    }
  });

  it('a failed body chunk prevents partial output and all acknowledgment', async () => {
    const run = await runMailRead({ args: ['--message-id', 'too-large', '--json'],
      oversizedBodies: { 'too-large': '\0'.repeat(65536) }, chunkFailureAt: 0 });
    assert.equal(run.exitCode, 1);
    assert.deepEqual(run.output, []);
    assert.equal(run.requests.some(request => request.method === 'POST'), false);
    assert.equal(run.mail[0].deliveredAt, undefined);
    assert.match(run.errors.join(''), /chunk failed/);
  });

  it('failed final stdout completion and peek completion never submit the completion token', async () => {
    for (const peek of [false, true]) {
      const tickets = new Map<string, { mailId: string; body: number; metadata: number; complete: boolean }>();
      const common = { oversizedBodies: { large: 'x'.repeat(9000) }, continuationTickets: tickets };
      const first = await runMailRead({ ...common, args: ['--message-id', 'large', '--json'] });
      const cursor = JSON.parse(first.output.join('')).nextCursor as string;
      const last = await runMailRead({ ...common, args: ['--message-id', 'large', '--cursor', cursor, '--json', ...(peek ? ['--peek'] : [])], outputFailure: !peek });
      assert.equal(last.exitCode, peek ? 0 : 1); assert.equal(last.requests.some(request => request.method === 'POST'), false);
    }
  });

  it('keeps 50 maximum-size messages as bounded unread descriptors without eager chunk requests', async () => {
    const run = await runMailRead({ args: ['--json'], noReadableMessages: true,
      oversizedMessages: Array.from({ length: 50 }, (_, index) => ({ id: `large-${index}`, serializedBytes: 393400, index })) });
    assert.equal(run.exitCode, 0); assert.ok(Buffer.byteLength(run.output.join('')) < 100000);
    assert.equal(JSON.parse(run.output.join('')).oversizedMessages.length, 50);
    assert.deepEqual(run.events, ['fetch', 'output', 'output-complete']);
    assert.equal(run.mail[0].deliveredAt, undefined);
  });

  it('unread peeks expose continuation offsets with the actual non-consuming command', async () => {
    const run = await runMailRead({ args: ['--peek', '--offset', '1', '--limit', '1'], moreAvailable: true, nextOffset: 2 });
    assert.equal(run.exitCode, 0);
    assert.equal(run.requests[0].url.searchParams.get('offset'), '1');
    assert.match(run.output.join(''), /ftown harness mail read --peek --limit 1 --offset 2/);
    assert.equal(run.requests.some(request => request.method === 'POST'), false);
  });

  for (const failure of ['fetchFailure', 'outputFailure', 'ackFailure'] as const) {
    it(`${failure} reports failure while retaining queued mail`, async () => {
      const run = await runMailRead({ [failure]: true, args: ['--json'] });
      assert.equal(run.exitCode, 1);
      assert.equal(run.mail[0].deliveredAt, undefined);
      assert.match(run.errors.join(''), new RegExp(failure === 'fetchFailure' ? 'fetch failed' : failure === 'outputFailure' ? 'stdout failed' : 'ack failed'));
      if (failure !== 'ackFailure') assert.equal(run.requests.some(request => request.method === 'POST'), false);
    });
  }
});
