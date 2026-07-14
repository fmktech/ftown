import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_BUSY_STALE_MS,
  MailDeliveryService,
  type MailDeliveryMailStore,
  type MailDeliveryRunner,
  type MailDeliverySessionStore,
  type MailTimerHandle,
} from './mail-delivery.js';
import type { MailMessage, Session } from './types.js';

// ---------------------------------------------------------------------------
// Fakes: a controllable clock plus in-memory store/mail/runner doubles, so the
// nudge/long-poll timing logic runs deterministically with no real timers.
// ---------------------------------------------------------------------------

/** Let promise chains kicked off by a timer callback settle. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface FakeTimer extends MailTimerHandle {
  id: number;
}

class FakeClock {
  // Start at a realistic epoch: the rate limiter treats "never nudged" as
  // lastNudgeAt=0, so a clock starting at 0 would rate-limit the first nudge.
  private time = 1_000_000_000_000;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

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

  /** Advance fake time, firing due timers in order (including ones they schedule). */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
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

class FakeMailStore implements MailDeliveryMailStore {
  messages: MailMessage[] = [];

  async append(msg: MailMessage): Promise<void> {
    this.messages.push(msg);
  }

  async listUndelivered(sessionId: string): Promise<MailMessage[]> {
    return this.messages.filter((m) => m.to === sessionId && !m.deliveredAt);
  }

  async listAll(sessionId: string, limit: number): Promise<MailMessage[]> {
    const all = this.messages.filter((m) => m.to === sessionId);
    return limit > 0 ? all.slice(-limit) : all;
  }

  async markDelivered(
    sessionId: string,
    ids: string[],
    via: NonNullable<MailMessage['deliveredVia']>,
  ): Promise<MailMessage[]> {
    const wanted = new Set(ids);
    const marked: MailMessage[] = [];
    for (const msg of this.messages) {
      if (msg.to === sessionId && wanted.has(msg.id) && !msg.deliveredAt) {
        msg.deliveredAt = new Date().toISOString();
        msg.deliveredVia = via;
        marked.push(msg);
      }
    }
    return marked;
  }
}

class FakeRunner implements MailDeliveryRunner {
  running = new Set<string>();
  writes: Array<{ sessionId: string; data: string }> = [];

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  write(sessionId: string, data: string): boolean {
    if (!this.running.has(sessionId)) return false;
    this.writes.push({ sessionId, data });
    return true;
  }

  nudgeLines(): string[] {
    return this.writes.filter((w) => w.data.includes('You have new ftown mail')).map((w) => w.data);
  }
}

class FakeSessionStore implements MailDeliverySessionStore {
  sessions = new Map<string, Session>();

  add(session: Session): void {
    this.sessions.set(session.id, session);
  }

  async loadSession(sessionId: string): Promise<Session | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()];
  }
}

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: id,
    command: 'claude',
    status: 'running',
    bridgeId: 'bridge-1',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function setup() {
  const clock = new FakeClock();
  const store = new FakeSessionStore();
  const mailStore = new FakeMailStore();
  const runner = new FakeRunner();
  const service = new MailDeliveryService({
    store,
    mailStore,
    runner,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, store, mailStore, runner, service };
}

/** A session that earns the listen window (has a parent). */
function participatingSession(id: string, overrides: Partial<Session> = {}): Session {
  return makeSession(id, { parentSessionId: 'parent-1', ...overrides });
}

// ---------------------------------------------------------------------------
// (a) Long-poll waiters
// ---------------------------------------------------------------------------

describe('MailDeliveryService long poll', () => {
  it('resolves the waiter when mail arrives, marked delivered via poll', async () => {
    const { store, service } = setup();
    const session = participatingSession('s1');
    store.add(session);

    const result = await service.readMail(session, { wait: 10, peek: false, all: false, limit: 50 });
    assert.equal(result.kind, 'longpoll');
    if (result.kind !== 'longpoll') return;

    const accepted = await service.acceptMail(session, { body: 'hello there', from: 'p1' });
    assert.deepEqual(accepted.ok, true);

    const messages = await result.messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].body, 'hello there');
    assert.equal(messages[0].deliveredVia, 'poll');
  });

  it('times out with [] when no mail arrives within the wait', async () => {
    const { clock, store, service } = setup();
    const session = participatingSession('s1');
    store.add(session);

    const result = await service.readMail(session, { wait: 5, peek: false, all: false, limit: 50 });
    assert.equal(result.kind, 'longpoll');
    if (result.kind !== 'longpoll') return;

    await clock.advance(5_000);
    assert.deepEqual(await result.messages, []);
  });

  it('timeout sweep delivers mail that arrived without a waiter kick', async () => {
    const { clock, store, mailStore, service } = setup();
    const session = participatingSession('s1');
    store.add(session);

    const result = await service.readMail(session, { wait: 5, peek: false, all: false, limit: 50 });
    assert.equal(result.kind, 'longpoll');
    if (result.kind !== 'longpoll') return;

    // Mail appended behind the service's back (e.g. another writer).
    await mailStore.append({
      id: 'm1', ts: new Date(0).toISOString(), from: 'x', to: 's1', type: 'message', body: 'late',
    });

    await clock.advance(5_000);
    const messages = await result.messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].deliveredVia, 'poll');
  });

  it('a newer waiter resolves the previous one with []', async () => {
    const { store, service } = setup();
    const session = participatingSession('s1');
    store.add(session);

    const first = await service.readMail(session, { wait: 10, peek: false, all: false, limit: 50 });
    const second = await service.readMail(session, { wait: 10, peek: false, all: false, limit: 50 });
    assert.equal(first.kind, 'longpoll');
    assert.equal(second.kind, 'longpoll');
    if (first.kind !== 'longpoll') return;
    assert.deepEqual(await first.messages, []);
  });

  it('an abandoned waiter never marks mail delivered', async () => {
    const { clock, store, mailStore, service } = setup();
    const session = participatingSession('s1');
    store.add(session);

    const result = await service.readMail(session, { wait: 10, peek: false, all: false, limit: 50 });
    assert.equal(result.kind, 'longpoll');
    if (result.kind !== 'longpoll') return;

    result.abandon();
    await mailStore.append({
      id: 'm1', ts: new Date(0).toISOString(), from: 'x', to: 's1', type: 'message', body: 'kept',
    });
    await clock.advance(10_000);

    const undelivered = await mailStore.listUndelivered('s1');
    assert.equal(undelivered.length, 1, 'mail must survive an abandoned long poll');
  });
});

// ---------------------------------------------------------------------------
// (b) Nudge debounce/coalesce + rate limit
// ---------------------------------------------------------------------------

describe('MailDeliveryService nudges', () => {
  it('coalesces two rapid mails into one nudge crediting the latest sender', async () => {
    const { clock, store, runner, service } = setup();
    const session = makeSession('s1', { shellType: 'opencode' });
    store.add(session);
    runner.running.add('s1');

    await service.acceptMail(session, { body: 'first', from: 'alice' });
    await clock.advance(1_000);
    await service.acceptMail(session, { body: 'second', from: 'bob' });

    // Debounce window (5s for non-hooked agents) from the FIRST mail.
    await clock.advance(3_000);
    assert.equal(runner.nudgeLines().length, 0, 'no nudge before the debounce fires');
    await clock.advance(1_000);
    await clock.advance(600); // composer-paste settle for the submit CR

    const nudges = runner.nudgeLines();
    assert.equal(nudges.length, 1, 'rapid mails must coalesce into a single nudge');
    assert.ok(nudges[0].includes('from bob'), 'coalesced nudge credits the latest sender');
    // Paste-then-submit: the CR is a separate write after the settle window.
    assert.equal(runner.writes.at(-1)?.data, '\r');
  });

  it('rate-limits nudges to one per 30s, retrying when the window reopens', async () => {
    const { clock, store, runner, service } = setup();
    const session = makeSession('s1', { shellType: 'opencode' });
    store.add(session);
    runner.running.add('s1');

    await service.acceptMail(session, { body: 'first', from: 'alice' });
    await clock.advance(5_600); // first nudge fires at t=5s
    assert.equal(runner.nudgeLines().length, 1);

    await service.acceptMail(session, { body: 'second', from: 'bob' });
    // Debounce fires at t≈10.6s but the 30s window (opened at t=5s) blocks it.
    await clock.advance(24_000);
    assert.equal(runner.nudgeLines().length, 1, 'second nudge is rate-limited');

    // Window reopens 30s after the first nudge; the deferred retry fires then.
    await clock.advance(10_000);
    assert.equal(runner.nudgeLines().length, 2, 'deferred nudge fires once the window reopens');
    assert.ok(runner.nudgeLines()[1].includes('from bob'));
  });

  it('does not nudge when the mail was already consumed by delivery', async () => {
    const { clock, store, runner, service } = setup();
    const session = participatingSession('s1', { shellType: 'opencode' });
    store.add(session);
    runner.running.add('s1');

    await service.acceptMail(session, { body: 'first', from: 'alice' });
    // Drain the inbox before the nudge timer fires.
    await service.readMail(session, { wait: 0, peek: false, all: false, limit: 50 });
    await clock.advance(60_000);
    assert.equal(runner.nudgeLines().length, 0, 'no nudge for already-delivered mail');
  });
});

// ---------------------------------------------------------------------------
// (c) Busy re-check
// ---------------------------------------------------------------------------

describe('MailDeliveryService busy re-check', () => {
  it('defers nudging a busy session, then fires once it goes idle', async () => {
    const { clock, store, runner, service } = setup();
    const session = makeSession('s1', { shellType: 'opencode' });
    store.add(session);
    runner.running.add('s1');

    service.markAgentBusy('s1');
    await service.acceptMail(session, { body: 'work item', from: 'boss' });

    await clock.advance(5_600);
    assert.equal(runner.nudgeLines().length, 0, 'busy session must not be nudged');

    service.markAgentIdle('s1');
    // Busy re-check interval is 60s from the deferred fire.
    await clock.advance(60_600);
    assert.equal(runner.nudgeLines().length, 1, 'nudge fires on the re-check after idle');
    assert.ok(runner.nudgeLines()[0].includes('from boss'));
  });

  it('ignores a busy marker old enough to be a crash', async () => {
    const { clock, store, runner, service } = setup();
    const session = makeSession('s1', { shellType: 'opencode' });
    store.add(session);
    runner.running.add('s1');

    service.markAgentBusy('s1');
    await service.acceptMail(session, { body: 'ping', from: 'alice' });

    // Never goes idle: re-checks every 60s until the marker exceeds the stale
    // threshold, then the nudge finally fires.
    await clock.advance(AGENT_BUSY_STALE_MS + 60_600 + 5_600);
    assert.equal(runner.nudgeLines().length, 1, 'stale busy marker no longer blocks the nudge');
  });
});

// ---------------------------------------------------------------------------
// (d) participatesInMail gating
// ---------------------------------------------------------------------------

describe('MailDeliveryService participatesInMail gating', () => {
  it('a session with no mail relationships gets an instant drain instead of a long poll', async () => {
    const { store, service } = setup();
    const session = makeSession('loner');
    store.add(session);

    assert.equal(await service.participatesInMail(session), false);
    const result = await service.readMail(session, { wait: 10, peek: false, all: false, limit: 50 });
    assert.equal(result.kind, 'immediate', 'ungated wait must collapse to an instant stop');
    if (result.kind === 'immediate') assert.deepEqual(result.messages, []);
  });

  it('a parent, a child, the orchestrator marker, or mail history earns the window', async () => {
    const { store, mailStore, service } = setup();

    const withParent = makeSession('a', { parentSessionId: 'p' });
    assert.equal(await service.participatesInMail(withParent), true);

    const orchestrator = makeSession('b', { env: { FTOWN_ORCHESTRATOR: '1' } });
    assert.equal(await service.participatesInMail(orchestrator), true);

    const parent = makeSession('c');
    store.add(parent);
    store.add(makeSession('c-child', { parentSessionId: 'c' }));
    assert.equal(await service.participatesInMail(parent), true);

    const veteran = makeSession('d');
    store.add(veteran);
    await mailStore.append({
      id: 'm1', ts: new Date(0).toISOString(), from: 'x', to: 'd', type: 'message',
      body: 'old', deliveredAt: new Date(0).toISOString(), deliveredVia: 'poll',
    });
    assert.equal(await service.participatesInMail(veteran), true);

    const loner = makeSession('e');
    store.add(loner);
    assert.equal(await service.participatesInMail(loner), false);
  });

  it('a participating session holds the long poll open', async () => {
    const { store, service } = setup();
    const session = participatingSession('s1');
    store.add(session);

    const result = await service.readMail(session, { wait: 10, peek: false, all: false, limit: 50 });
    assert.equal(result.kind, 'longpoll');
  });
});

// ---------------------------------------------------------------------------
// injectPtyLine composer-paste timing
// ---------------------------------------------------------------------------

describe('MailDeliveryService injectPtyLine', () => {
  it('submits the CR only after the 600ms paste-settle window', async () => {
    const { clock, store, runner, service } = setup();
    const session = makeSession('s1', { shellType: 'opencode' });
    store.add(session);
    runner.running.add('s1');

    const done = service.injectPtyLine(session, 'alice', 'hi there');
    await flushAsync();
    assert.equal(runner.writes.length, 1, 'only the message line before the settle window');
    assert.equal(runner.writes[0].data, '[ftown msg from alice] hi there');

    await clock.advance(600);
    assert.equal(await done, true);
    assert.equal(runner.writes.length, 2);
    assert.equal(runner.writes[1].data, '\r');
  });

  it('wraps plain-shell messages in a quoted no-op', async () => {
    const { clock, store, runner, service } = setup();
    const session = makeSession('s1', { shellType: 'shell' });
    store.add(session);
    runner.running.add('s1');

    const done = service.injectPtyLine(session, 'alice', "don't run this");
    await clock.advance(600);
    assert.equal(await done, true);
    assert.equal(runner.writes[0].data, ": '[ftown msg from alice] dont run this'");
  });
});
