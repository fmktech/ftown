import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { runHarness } from './harness-commands.js';
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
async function runPump(hook: Record<string, unknown>, extraEnv: Record<string, string>): Promise<PumpRun> {
  const home = mkdtempSync(join(tmpdir(), 'ftown-hook-pump-'));
  const sessionId = `pump-${randomBytes(6).toString('hex')}`;
  const mail: MailMessage[] = [
    { id: 'm1', ts: '2026-01-01T00:00:00.000Z', from: 'sender', fromName: 'sender', to: sessionId, type: 'message', body: 'hello pump' },
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

    const exitCode = await runHarness(['hook-pump']);
    return { exitCode, stdout, stderr, inboxRequests, mail };
  } finally {
    console.log = previousLog;
    console.error = previousError;
    globalThis.fetch = previousFetch;
    if (stdinDescriptor) Object.defineProperty(process, 'stdin', stdinDescriptor);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await secure?.security.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(`/tmp/ftown-mail-pump-${sessionId}.count`, { force: true });
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
