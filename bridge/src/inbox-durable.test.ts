import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalApiServer } from './local-api-server.js';
import type { HookEvent } from './local-api-server.js';
import { SessionStore } from './session-store.js';
import { MailStore } from './mail-store.js';
import { MailDeliveryService, MAIL_WAKE_TEXT, OPENCODE_MAIL_WAKE_TEXT, type MailTimerHandle } from './mail-delivery.js';
import { AttentionStore } from './attention-store.js';
import type { Session } from './types.js';
import type { ProcessRunner } from './claude-runner.js';
import type { CentrifugoClient } from './centrifugo-client.js';
import { createCommandHandler } from './command-rpc.js';
import type { Command, CommandResponse } from './types.js';
import type { BridgeSecurityService } from './security/bridge/security.js';
import type { VerifiedApplication } from './security/protocol.js';
import type { SessionController } from './session-controller.js';

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Advance the fake clock in steps, letting real-fs IO settle between steps. */
async function settle(clock: FakeClock, ms: number): Promise<void> {
  const step = 1_000;
  let left = ms;
  while (left > 0) {
    const chunk = Math.min(step, left);
    await clock.advance(chunk);
    await new Promise((resolve) => setTimeout(resolve, 10));
    left -= chunk;
  }
  await flushAsync();
}

interface FakeTimer extends MailTimerHandle { id: number; }
class FakeClock {
  private time: number;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  constructor(startTime = 1_000_000_000_000) { this.time = startTime; }
  now = (): number => this.time;
  setTimeout = (fn: () => void, ms: number): MailTimerHandle => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.time + ms, fn });
    const handle: FakeTimer = { id, unref: () => undefined };
    return handle;
  };
  clearTimeout = (handle: MailTimerHandle): void => {
    const id = (handle as FakeTimer).id;
    if (typeof id === 'number') this.timers.delete(id);
  };
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) { nextAt = timer.at; nextId = id; }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.time = timer.at;
      timer.fn();
      await flushAsync();
    }
    this.time = target;
    await flushAsync();
  }
}

class FakeRunner {
  running = new Set<string>();
  writes: Array<{ sessionId: string; data: string }> = [];
  isRunning(sessionId: string): boolean { return this.running.has(sessionId); }
  write(sessionId: string, data: string): boolean {
    if (!this.running.has(sessionId)) return false;
    this.writes.push({ sessionId, data });
    return true;
  }
  nudgeLines(): string[] {
    return this.writes.filter((w) => w.data.includes('You have new ftown mail') || w.data.includes('FTown mail may be available') || w.data.includes('[ftown mail]')).map((w) => w.data);
  }
}

async function hook(port: number, token: string, body: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

const makeSession = (id: string, overrides: Partial<Session> = {}): Session => ({
  id, name: id, command: 'claude', status: 'running', bridgeId: 'machine-a',
  createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z', shellType: 'cursor', ...overrides,
});

async function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const home = mkdtempSync(join(tmpdir(), 'ftown-inbox-durable-'));
  const store = new SessionStore(join(home, 'data'));
  const session = makeSession('s1');
  await store.saveSession(session);
  const mailStore = new MailStore((id) => store.sessionDir(id));
  const attention = new AttentionStore((id) => store.sessionDir(id));
  const clock = new FakeClock();
  const runner = new FakeRunner();
  runner.running.add('s1');
  const mail = new MailDeliveryService({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, nativeWake: async () => ({ status: 'unsupported' }) });
  const server = new LocalApiServer();
  (server as unknown as { mail: MailDeliveryService }).mail = mail;
  const token = 'inbox-durable-token';
  server.setAuthToken(token);
  server.setDependencies(store, runner as unknown as ProcessRunner, { publishSessionUpdate: async () => {} } as unknown as CentrifugoClient, 'user-a');
  server.setAttentionStore(attention);
  // Wire mailStore after dependencies so the replaced service sees it.
  (server as unknown as { setMailStore: (m: MailStore) => void }).setMailStore(mailStore);
  const events: HookEvent[] = [];
  server.on('event', (event: HookEvent) => { events.push(event); });
  const port = await server.start();
  t.after(async () => { attention.stopNotifications(); mail.stop(); server.getHttpServer()?.closeAllConnections(); server.stop(); rmSync(home, { recursive: true, force: true }); });
  return { home, store, mailStore, attention, clock, runner, mail, server, token, port, events, session };
}

const askInput = { questions: [{ question: 'Pick one', header: 'Choice', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] };

async function openTwo(f: { attention: AttentionStore }) {
  const req = await f.attention.record('s1', 'Notification', { notification_type: 'agent_needs_input', title: 'Need you', message: 'Please review' });
  assert.ok(req);
  const q = await f.attention.record('s1', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q1', tool_input: askInput });
  assert.ok(q);
  assert.equal((await f.attention.list('s1')).events.length, 2);
  return { req: req!, q: q! };
}

describe('mail nudge vs open attention (real handleHook + store)', () => {
  it('injected mail-nudge UserPromptSubmit resolves nothing and publishes injected:true', async (t) => {
    const f = await fixture(t);
    await openTwo(f);
    // Agent-to-agent mail is nudged: bridge types the pointer into the PTY.
    await f.mail.acceptMail(f.session, { body: 'hello from agent', from: 'agent-2', fromName: 'Agent 2' });
    await settle(f.clock, 10_000);
    await flushAsync();
    const nudges = f.runner.nudgeLines();
    assert.ok(nudges.length > 0, 'nudge should type a pointer line');
    const injectedLine = nudges[0].trim();
    // The harness fires UserPromptSubmit with the submitted prompt text.
    const res = await hook(f.port, f.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit', prompt: injectedLine });
    assert.equal(res.status, 200);
    // Root cause: items must stay open.
    const page = await f.attention.list('s1');
    assert.equal(page.events.length, 2, `expected 2 open items, got ${page.events.length}: ${JSON.stringify(page.events.map((e) => [e.id, e.resolvedAt, e.resolution]))}`);
    const published = f.events.find((e) => e.eventName === 'UserPromptSubmit');
    assert.ok(published, 'hook event should be published');
    assert.equal(published.data.injected, true, 'published hook event should carry injected:true');
  });

  it('no-prompt-text UserPromptSubmit within 15s of injection is injected; 16s later is human', async (t) => {
    const f = await fixture(t);
    const { req } = await openTwo(f);
    await f.mail.acceptMail(f.session, { body: 'hi', from: 'agent-2' });
    await settle(f.clock, 10_000);
    await flushAsync();
    assert.ok(f.runner.nudgeLines().length > 0);
    // Within 15s, no prompt text (opencode shape): injected, resolves nothing.
    await hook(f.port, f.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit' });
    let page = await f.attention.list('s1');
    assert.equal(page.events.length, 2, `no-prompt within 15s must not resolve, got ${page.events.length}`);
    let published = f.events.filter((e) => e.eventName === 'UserPromptSubmit').at(-1)!;
    assert.equal(published.data.injected, true);
    // 16s after the injection: human, resolves agent_needs_input but not the ask_user question.
    await settle(f.clock, 16_000);
    await hook(f.port, f.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit', prompt: 'human answer in terminal' });
    page = await f.attention.list('s1');
    const open = await f.attention.list('s1', { includeResolved: true });
    const reqItem = open.events.find((e) => e.id === req.id)!;
    assert.equal(reqItem.resolution, 'user_prompt', 'human prompt should resolve agent_needs_input');
    assert.equal(page.events.length, 1, `human prompt should leave the ask_user question open, got ${page.events.length}`);
    published = f.events.filter((e) => e.eventName === 'UserPromptSubmit').at(-1)!;
    assert.equal(published.data.injected, undefined, 'human prompt should not carry injected');
  });

  it('human UserPromptSubmit resolves non-explicit items and agent_needs_input but leaves ask_user with a prompt', async (t) => {
    const f = await fixture(t);
    const { req } = await openTwo(f);
    await f.attention.record('s1', 'Notification', { notification_type: 'permission_prompt', message: 'Approve?' });
    assert.equal((await f.attention.list('s1')).events.length, 3);
    await hook(f.port, f.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit', prompt: 'human typed' });
    const page = await f.attention.list('s1');
    assert.equal(page.events.length, 1, `expected only the ask_user question to remain, got ${page.events.length}`);
    assert.equal(page.events[0].type, 'ask_user');
    const resolved = await f.attention.list('s1', { includeResolved: true });
    assert.equal(resolved.events.filter((e) => e.resolvedAt && e.resolution === 'user_prompt').length, 2);
    assert.ok(resolved.events.find((e) => e.id === req.id)?.resolution === 'user_prompt');
  });

  it('preview-conversation mail and child-idle style mail nudge as injected (resolve nothing)', async (t) => {
    const f = await fixture(t);
    await openTwo(f);
    // Preview-conversation path: LocalApiServer.enqueuePreviewChat -> acceptMail -> nudge.
    await f.server.enqueuePreviewChat(f.session, 'preview hello');
    await settle(f.clock, 10_000);
    await flushAsync();
    assert.ok(f.runner.nudgeLines().length > 0, 'preview mail should nudge');
    const line = f.runner.nudgeLines()[0].trim();
    await hook(f.port, f.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit', prompt: line });
    assert.equal((await f.attention.list('s1')).events.length, 2, 'preview mail injected prompt must not resolve');
    assert.equal(f.events.filter((e) => e.eventName === 'UserPromptSubmit').at(-1)?.data.injected, true);
    // Child-idle style: same durable path with a threadId; behavior identical.
    const f2 = await fixture(t);
    await openTwo(f2);
    await f2.mail.acceptMail(f2.session, { body: 'Child session c has been idle for 120 seconds.', from: 'child-1', fromName: 'Child', threadId: 'cycle-1' });
    await settle(f2.clock, 10_000);
    await flushAsync();
    const line2 = f2.runner.nudgeLines()[0].trim();
    await hook(f2.port, f2.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit', prompt: line2 });
    assert.equal((await f2.attention.list('s1')).events.length, 2, 'child-idle injected prompt must not resolve');
  });

  it('attention-status waiter survives an injected prompt', async (t) => {
    const f = await fixture(t);
    const { q } = await openTwo(f);
    await f.mail.acceptMail(f.session, { body: 'hi', from: 'agent-2' });
    await settle(f.clock, 10_000);
    await flushAsync();
    const poll = f.attention.waitForItem('s1', q.id, 200);
    // Give the waiter a moment to register liveness.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const line = f.runner.nudgeLines()[0].trim();
    await hook(f.port, f.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit', prompt: line });
    const item = await poll;
    assert.equal(item.resolvedAt, undefined, 'waiter must survive injected prompt');
    assert.equal(f.attention.hasLiveWaiter(q.id), true, 'waiter liveness must remain');
  });
});

function replyHandler(f: { session: Session; attention: AttentionStore }, enqueue: NonNullable<import('./command-rpc.js').CommandRpcDeps['enqueueSessionMessage']>) {
  const responses: CommandResponse[] = [];
  const security = { revalidate: async () => {}, policy: { revalidate: async () => {} } } as unknown as BridgeSecurityService;
  const verified = { principal: {} } as VerifiedApplication;
  const sessionController = { get: async (id: string) => (id === f.session.id ? f.session : null) } as unknown as SessionController;
  const handler = createCommandHandler({
    bridgeId: 'machine-a', security, sessionController, enqueueSessionMessage: enqueue,
    attentionStore: f.attention, publishCommandResponse: async (response: CommandResponse) => { responses.push(response); },
  });
  return { handler, verified, responses };
}

describe('inbox reply resolves exactly its item', () => {
  it('reply with eventId resolves that item with replied and leaves a second open item', async (t) => {
    const f = await fixture(t);
    const first = (await f.attention.record('s1', 'Notification', { notification_type: 'agent_needs_input', title: 'One', message: 'First' }))!;
    const second = (await f.attention.record('s1', 'Notification', { notification_type: 'agent_needs_input', title: 'Two', message: 'Second' }))!;
    assert.equal((await f.attention.list('s1')).events.length, 2);
    const { handler, verified, responses } = replyHandler(f, async (session, message) => ({ ok: true, id: 'mail-1' }));
    const command: Command = { type: 'send_message', requestId: 'r1', payload: { bridgeId: 'machine-a', sessionId: 's1', message: 'my reply', eventId: first.id } } as Command;
    await handler(command, verified);
    assert.equal(responses.at(-1)?.success, true);
    const open = await f.attention.list('s1');
    assert.equal(open.events.length, 1);
    assert.equal(open.events[0].id, second.id, 'second item must remain');
    const all = await f.attention.list('s1', { includeResolved: true });
    assert.equal(all.events.find((e) => e.id === first.id)?.resolution, 'replied');
  });

  it('reply whose mail is rejected resolves nothing', async (t) => {
    const f = await fixture(t);
    const first = (await f.attention.record('s1', 'Notification', { notification_type: 'agent_needs_input', title: 'One', message: 'First' }))!;
    const { handler, verified, responses } = replyHandler(f, async () => ({ ok: false, error: 'Mail store not ready' }));
    const command: Command = { type: 'send_message', requestId: 'r2', payload: { bridgeId: 'machine-a', sessionId: 's1', message: 'my reply', eventId: first.id } } as Command;
    await handler(command, verified);
    assert.equal(responses.at(-1)?.success, false);
    assert.equal((await f.attention.list('s1')).events.length, 1, 'rejected mail must not resolve');
  });
});

describe('injected prefix sources (plugin self-submits)', () => {
  const cases: Array<[string, string]> = [
    ['pty nudge', '[ftown msg from ftown-mail] You have new ftown mail from bob — run `ftown harness mail read` to read it.'],
    ['codex native wake', '[ftown mail] id="m1" from="bob" type="message"\n\nBody text'],
    ['muse native wake', MAIL_WAKE_TEXT],
    ['claude-mod WAKE', MAIL_WAKE_TEXT],
    ['opencode effective wake', OPENCODE_MAIL_WAKE_TEXT],
    ['pi deliverMail', '[ftown mail]\n[2026-01-01T00:00:00Z] bob (message): hello\nHandle this message and reply with the `ftown_mail` tool where appropriate.'],
  ];
  for (const [name, prompt] of cases) {
    it(`${name} is injected and resolves nothing`, async (t) => {
      const f = await fixture(t);
      await openTwo(f);
      assert.equal(f.mail.isInjectedPrompt('s1', { prompt }), true, `${name} prefix`);
      await hook(f.port, f.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit', prompt });
      assert.equal((await f.attention.list('s1')).events.length, 2, `${name} must resolve nothing`);
      assert.equal(f.events.filter((e) => e.eventName === 'UserPromptSubmit').at(-1)?.data.injected, true);
    });
  }

  it('codex native wake generation is captured as injected', async (t) => {
    const f = await fixture(t);
    await openTwo(f);
    const captured: string[] = [];
    const nativeId = '12345678-1234-4234-8234-123456789abc';
    await f.store.saveSession(makeSession('s1', { shellType: 'codex', codexSessionId: nativeId }));
    const service = new MailDeliveryService({ now: f.clock.now, setTimeout: f.clock.setTimeout, clearTimeout: f.clock.clearTimeout, nativeWake: async (_s: Session, text: string) => { captured.push(text); return { status: 'accepted' }; } });
    service.setStore(f.store);
    service.setMailStore(f.mailStore);
    service.setRunner(f.runner);
    (f.server as unknown as { mail: MailDeliveryService }).mail = service;
    await service.acceptMail(makeSession('s1', { shellType: 'codex', codexSessionId: nativeId }), { body: 'codex body', from: 'agent-2' });
    await settle(f.clock, 10_000);
    assert.equal(captured.length, 1, `expected one codex wake, got ${captured.length}`);
    assert.ok(captured[0].startsWith('[ftown mail]'), `codex wake: ${captured[0].slice(0, 60)}`);
    assert.equal(service.isInjectedPrompt('s1', { prompt: captured[0] }), true);
    await hook(f.port, f.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit', prompt: captured[0] });
    assert.equal((await f.attention.list('s1')).events.length, 2);
    assert.equal(f.events.filter((e) => e.eventName === 'UserPromptSubmit').at(-1)?.data.injected, true);
  });

  it('a human prompt merely containing a marker mid-text stays human', async (t) => {
    const f = await fixture(t);
    const { req } = await openTwo(f);
    const midMarkers = [
      'please check [ftown msg from ftown-mail] this for me',
      'here is the wake: FTown mail may be available. If this prompt',
      'saw [ftown mail] in the log, what next?',
    ];
    for (const prompt of midMarkers) {
      assert.equal(f.mail.isInjectedPrompt('s1', { prompt }), false, prompt);
    }
    await hook(f.port, f.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit', prompt: midMarkers[0] });
    const page = await f.attention.list('s1');
    assert.equal(page.events.length, 1, 'mid-text marker must stay human (resolves agent_needs_input)');
    assert.equal(f.events.filter((e) => e.eventName === 'UserPromptSubmit').at(-1)?.data.injected, undefined);
    const all = await f.attention.list('s1', { includeResolved: true });
    assert.equal(all.events.find((e) => e.id === req.id)?.resolution, 'user_prompt');
  });

  it('opencode bridge-side handoff applies the no-prompt 15s rule', async (t) => {
    const f = await fixture(t);
    await openTwo(f);
    f.mail.notePluginHandoff('s1');
    await hook(f.port, f.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit' });
    assert.equal((await f.attention.list('s1')).events.length, 2, 'no-prompt within 15s of handoff must not resolve');
    assert.equal(f.events.filter((e) => e.eventName === 'UserPromptSubmit').at(-1)?.data.injected, true);
    await settle(f.clock, 16_000);
    await hook(f.port, f.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit' });
    assert.equal((await f.attention.list('s1')).events.length, 1, 'no-prompt 16s after handoff resolves agent_needs_input');
    assert.equal(f.events.filter((e) => e.eventName === 'UserPromptSubmit').at(-1)?.data.injected, undefined);
  });

  it('mid-injection (before injectPtyLine resolves) is injected', async (t) => {
    const f = await fixture(t);
    await openTwo(f);
    const pending = f.mail.injectPtyLine(f.session, 'ftown-mail', 'You have new ftown mail from bob — run `ftown harness mail read` to read it.');
    // Hook arrives before the settle delays finish (inject not yet resolved).
    await hook(f.port, f.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit' });
    assert.equal((await f.attention.list('s1')).events.length, 2, 'mid-injection no-prompt hook must not resolve');
    assert.equal(f.events.filter((e) => e.eventName === 'UserPromptSubmit').at(-1)?.data.injected, true);
    await settle(f.clock, 2_000);
    assert.equal(await pending, true);
  });

  it('mid native-wake (before nativeWake resolves) is injected', async (t) => {
    const f = await fixture(t);
    await openTwo(f);
    const nativeId = '12345678-1234-4234-8234-123456789abc';
    await f.store.saveSession(makeSession('s1', { shellType: 'codex', codexSessionId: nativeId }));
    let release!: (v: { status: 'accepted' }) => void;
    const gate = new Promise<{ status: 'accepted' }>((resolve) => { release = resolve; });
    const captured: string[] = [];
    const service = new MailDeliveryService({ now: f.clock.now, setTimeout: f.clock.setTimeout, clearTimeout: f.clock.clearTimeout, nativeWake: async (_s: Session, text: string) => { captured.push(text); return gate; } });
    service.setStore(f.store);
    service.setMailStore(f.mailStore);
    service.setRunner(f.runner);
    (f.server as unknown as { mail: MailDeliveryService }).mail = service;
    await service.acceptMail(makeSession('s1', { shellType: 'codex', codexSessionId: nativeId }), { body: 'codex body', from: 'agent-2' });
    await settle(f.clock, 6_000);
    assert.equal(captured.length, 1, 'nativeWake should be in flight');
    // Hook arrives before nativeWake resolves.
    await hook(f.port, f.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit' });
    assert.equal((await f.attention.list('s1')).events.length, 2, 'mid-wake no-prompt hook must not resolve');
    assert.equal(f.events.filter((e) => e.eventName === 'UserPromptSubmit').at(-1)?.data.injected, true);
    release({ status: 'accepted' });
    await settle(f.clock, 2_000);
  });

  it('no-prompt 15s rule is one-shot; text rule is not consumed', async (t) => {
    const f = await fixture(t);
    await openTwo(f);
    f.mail.notePluginHandoff('s1');
    await hook(f.port, f.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit' });
    assert.equal(f.events.filter((e) => e.eventName === 'UserPromptSubmit').at(-1)?.data.injected, true);
    await settle(f.clock, 2_000);
    await hook(f.port, f.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit' });
    assert.equal((await f.attention.list('s1')).events.length, 1, 'second no-prompt hook 2s later is human');
    assert.equal(f.events.filter((e) => e.eventName === 'UserPromptSubmit').at(-1)?.data.injected, undefined);
    // Text rule not consumed: two prefixed prompts are both injected.
    const f2 = await fixture(t);
    await openTwo(f2);
    for (let i = 0; i < 2; i++) {
      await hook(f2.port, f2.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit', prompt: '[ftown mail] id="x" from="b" type="message"' });
      assert.equal(f2.events.filter((e) => e.eventName === 'UserPromptSubmit').at(-1)?.data.injected, true);
      await settle(f2.clock, 1_000);
    }
    assert.equal((await f2.attention.list('s1')).events.length, 2);
  });

  it('SessionEnd deletes the injection record', async (t) => {
    const f = await fixture(t);
    await openTwo(f);
    f.mail.notePluginHandoff('s1');
    assert.ok(f.mail.lastPromptInjection('s1'), 'record exists');
    await hook(f.port, f.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'SessionEnd' });
    assert.equal(f.mail.lastPromptInjection('s1'), undefined, 'SessionEnd must delete the record');
    await hook(f.port, f.token, { ftown_session_id: 's1', ftown_session_source: 'env', hook_event_name: 'UserPromptSubmit' });
    assert.equal(f.events.filter((e) => e.eventName === 'UserPromptSubmit').at(-1)?.data.injected, undefined);
  });
});
