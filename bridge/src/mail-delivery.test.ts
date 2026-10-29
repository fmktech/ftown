import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_BUSY_STALE_MS,
  MAIL_WAKE_TEXT,
  parseNativeWakeRegistration,
  NativeWakeRegistrationError,
  MailDeliveryService,
  type MailDeliveryMailStore,
  type MailDeliveryRunner,
  type MailDeliverySessionStore,
  type MailTimerHandle,
} from './mail-delivery.js';
import type { MailMessage, Session } from './types.js';
import type { NativeMailWaker } from './native-mail.js';

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
  private time: number;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  constructor(startTime = 1_000_000_000_000) {
    this.time = startTime;
  }

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
    return this.writes.filter((w) => w.data.includes('You have new ftown mail') || w.data.includes(MAIL_WAKE_TEXT)).map((w) => w.data);
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

function setup(startTime?: number, nativeWake?: NativeMailWaker) {
  const clock = new FakeClock(startTime);
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
    nativeWake: nativeWake ?? (async () => ({ status: 'unsupported' })),
  });
  return { clock, store, mailStore, runner, service };
}

/** A session that earns the listen window (has a parent). */
function participatingSession(id: string, overrides: Partial<Session> = {}): Session {
  return makeSession(id, { parentSessionId: 'parent-1', ...overrides });
}

describe('MailDeliveryService receiver recovery', () => {
  it('recovers Codex pending mail after the recipient returns, respecting retry spacing', async () => {
    let attempts = 0;
    const { clock, store, runner, service, mailStore } = setup(undefined, async () => { attempts++; return { status: 'accepted' }; });
    const session = makeSession('s1', { shellType: 'codex', codexSessionId: 'native-id' });
    store.add(session);
    await service.acceptMail(session, { body: 'durable payload', from: 'alice' });
    await clock.advance(10_000);
    runner.running.add(session.id);
    await Promise.all(Array.from({ length: 10 }, () => service.recoverPendingMail(session.id)));
    await clock.advance(54_999); assert.equal(attempts, 0);
    await clock.advance(1); assert.equal(attempts, 1);
    assert.equal((await mailStore.listUndelivered(session.id)).length, 0);
    assert.equal(runner.writes.length, 0); service.stop();
  });

  it('recovers persisted unread mail in a new service, deriving the sender without delivering the payload', async () => {
    const { clock, store, runner, service, mailStore } = setup();
    const session = makeSession('s1', { shellType: 'grok' });
    store.add(session);
    await service.acceptMail(session, { body: 'private payload', from: 'alice', fromName: 'Alice' });
    service.stop();
    runner.running.add(session.id);
    const restarted = new MailDeliveryService({ store, runner, mailStore, now: clock.now,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    await restarted.recoverPendingMail(session.id);
    await clock.advance(6_200);
    assert.equal(runner.nudgeLines().length, 1);
    assert.match(runner.nudgeLines()[0], /Alice/);
    assert.doesNotMatch(runner.nudgeLines()[0], /private payload/);
    assert.equal((await mailStore.listUndelivered(session.id)).length, 1);
    restarted.stop();
  });

  it('ignores Pi, stopped, deleted and drained receivers without recurring work', async () => {
    const { clock, store, runner, service, mailStore } = setup();
    for (const [id, overrides] of [
      ['pi', { shellType: 'pi' }], ['stopped', { status: 'completed' }],
      ['deleted', {}], ['drained', {}],
    ] as Array<[string, Partial<Session>]>) {
      const session = makeSession(id, { shellType: 'grok', ...overrides });
      store.add(session); runner.running.add(id);
      await service.acceptMail(session, { body: 'work', from: 'alice' });
    }
    store.sessions.delete('deleted');
    mailStore.messages = mailStore.messages.filter(message => message.to !== 'drained');
    await Promise.all(['pi', 'stopped', 'deleted', 'drained'].map(id => service.recoverPendingMail(id)));
    await clock.advance(600_000);
    assert.equal(runner.writes.length, 0);
    service.stop();
  });

  it('retains plugin lease, busy and rate-limit gates when readiness repeats', async () => {
    const { clock, store, runner, service } = setup();
    const session = makeSession('s1', { shellType: 'opencode', opencodeSessionId: 'native-id' });
    store.add(session); runner.running.add(session.id);
    await service.acceptMail(session, { body: 'work', from: 'alice' });
    service.registerNativeWake(session, { adapter: 'opencode', nativeSessionId: 'native-id' });
    service.markAgentBusy(session.id);
    await service.recoverPendingMail(session.id);
    await clock.advance(31_000);
    assert.equal(runner.writes.length, 0);
    service.markAgentIdle(session.id);
    await clock.advance(60_200);
    assert.equal(runner.nudgeLines().length, 1);
    await service.recoverPendingMail(session.id);
    await clock.advance(6_200);
    assert.equal(runner.nudgeLines().length, 1, 'a ready event cannot bypass the rate limit');
    service.stop();
  });

  for (const action of ['replace', 'stop'] as const) {
    it(`fences an awaited recovery read on ${action}`, async () => {
      const { clock, store, runner, service } = setup();
      const session = makeSession('s1', { shellType: 'grok' });
      store.add(session); runner.running.add(session.id);
      await service.acceptMail(session, { body: 'work', from: 'alice' });
      let release!: (session: Session | null) => void;
      store.loadSession = () => new Promise(resolve => { release = resolve; });
      const recovery = service.recoverPendingMail(session.id);
      if (action === 'replace') service.setRunner(new FakeRunner());
      else service.stop();
      release(session);
      await recovery;
      await clock.advance(600_000);
      assert.equal(runner.writes.length, 0);
      service.stop();
    });
  }

  it('fences an in-flight wake and aborts native probing when the runner is replaced', async () => {
    let finish!: () => void;
    let signal: AbortSignal | undefined;
    const { clock, store, runner, service } = setup(undefined, async (_session, _text, abort) => {
      signal = abort;
      await new Promise<void>(resolve => { finish = resolve; });
      return { status: 'unsupported' };
    });
    const session = makeSession('s1', { shellType: 'codex', codexSessionId: 'native-id' });
    store.add(session); runner.running.add(session.id);
    await service.acceptMail(session, { body: 'work', from: 'alice' });
    await clock.advance(5_000);
    assert.ok(signal);
    service.setRunner(new FakeRunner());
    assert.equal(signal.aborted, true);
    finish(); await flushAsync();
    await clock.advance(120_000);
    assert.equal(runner.writes.length, 0);
    service.stop();
  });
});

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

  it('does not mark mail delivered to a waiter that dies while acceptMail is checking it', async () => {
    const { store, mailStore, service } = setup();
    const session = participatingSession('s1');
    store.add(session);

    const result = await service.readMail(session, { wait: 10, peek: false, all: false, limit: 50 });
    assert.equal(result.kind, 'longpoll');
    if (result.kind !== 'longpoll') return;

    // Simulate the client disconnecting in the gap between acceptMail reading
    // the undelivered list and marking those messages delivered.
    const realListUndelivered = mailStore.listUndelivered.bind(mailStore);
    mailStore.listUndelivered = async (sessionId: string) => {
      mailStore.listUndelivered = realListUndelivered;
      result.abandon();
      return realListUndelivered(sessionId);
    };

    const accepted = await service.acceptMail(session, { body: 'hello', from: 'p1' });
    assert.equal(accepted.ok, true);

    // Note: abandon() never resolves `result.messages` (the caller already gave
    // up waiting), so we assert on store state directly rather than awaiting it.
    const stillUndelivered = await mailStore.listUndelivered('s1');
    assert.equal(stillUndelivered.length, 1, 'mail must remain undelivered for the next reader, not be lost');
  });
});

// ---------------------------------------------------------------------------
// (b) Nudge debounce/coalesce + rate limit
// ---------------------------------------------------------------------------

describe('MailDeliveryService nudges', () => {
  it('never injects a PTY nudge for Pi when its native listener is between polls', async () => {
    const { clock, store, mailStore, runner, service } = setup();
    const session = makeSession('pi-1', { shellType: 'pi' });
    store.add(session);
    runner.running.add(session.id);

    await service.acceptMail(session, { body: 'wake natively', from: 'planner' });
    await clock.advance(120_000);

    assert.equal(runner.writes.length, 0);
    assert.equal((await mailStore.listUndelivered(session.id)).length, 1);
  });

  it('coalesces two rapid mails into one nudge crediting the latest sender', async () => {
    const { clock, store, runner, service } = setup();
    const session = makeSession('s1', { shellType: 'grok' });
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
    const session = makeSession('s1', { shellType: 'grok' });
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
    const session = participatingSession('s1', { shellType: 'grok' });
    store.add(session);
    runner.running.add('s1');

    await service.acceptMail(session, { body: 'first', from: 'alice' });
    // Drain the inbox before the nudge timer fires.
    await service.readMail(session, { wait: 0, peek: false, all: false, limit: 50 });
    await clock.advance(60_000);
    assert.equal(runner.nudgeLines().length, 0, 'no nudge for already-delivered mail');
  });

  it('nudges immediately even on a clock that starts near zero (never-nudged is not epoch 0)', async () => {
    // A clock near zero would make old code's `lastNudgeAt ?? 0` compute a
    // tiny `sinceLast`, incorrectly rate-limiting the very first nudge.
    const { clock, store, runner, service } = setup(500);
    const session = makeSession('s1', { shellType: 'grok' });
    store.add(session);
    runner.running.add('s1');

    await service.acceptMail(session, { body: 'first', from: 'alice' });
    await clock.advance(5_600); // debounce (5s) + composer-paste settle (600ms)

    assert.equal(runner.nudgeLines().length, 1, 'the first-ever nudge must not be rate-limited');
  });

  it('keeps the pending nudge marker when the session is not running, for a later retry', async () => {
    const { clock, store, runner, service } = setup();
    const session = makeSession('s1', { shellType: 'grok' });
    store.add(session);
    // Session is not running yet — the nudge timer will fire while it's down.

    await service.acceptMail(session, { body: 'work item', from: 'alice' });
    await clock.advance(5_600);
    assert.equal(runner.nudgeLines().length, 0, 'no nudge while the session is down');

    // Actual runner readiness now has a public recovery path.
    runner.running.add('s1');
    await Promise.all([service.recoverPendingMail('s1'), service.recoverPendingMail('s1')]);
    await clock.advance(6_200);

    const nudges = runner.nudgeLines();
    assert.equal(nudges.length, 1, 'the retry must still nudge for mail that arrived while down');
    assert.ok(nudges[0].includes('from alice'), 'the original sender label must survive the not-running skip');
  });
});

// ---------------------------------------------------------------------------
// (c) Busy re-check
// ---------------------------------------------------------------------------

describe('MailDeliveryService busy re-check', () => {
  it('defers nudging a busy session, then fires once it goes idle', async () => {
    const { clock, store, runner, service } = setup();
    const session = makeSession('s1', { shellType: 'grok' });
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
    const session = makeSession('s1', { shellType: 'grok' });
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

  it('a parent, a child, or mail history earns the window; obsolete role env is inert', async () => {
    const { store, mailStore, service } = setup();

    const withParent = makeSession('a', { parentSessionId: 'p' });
    assert.equal(await service.participatesInMail(withParent), true);

    const orchestrator = makeSession('b', { env: { FTOWN_ORCHESTRATOR: '1' } });
    assert.equal(await service.participatesInMail(orchestrator), false);

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

  it('a standalone Pi session holds the long poll open for its native mail listener', async () => {
    const { store, service } = setup();
    const session = makeSession('pi-loner', { shellType: 'pi' });
    store.add(session);

    assert.equal(await service.participatesInMail(session), true);
    const result = await service.readMail(session, { wait: 30, peek: false, all: false, limit: 50 });
    assert.equal(result.kind, 'longpoll');
  });
});

// ---------------------------------------------------------------------------
// injectPtyLine composer-paste timing
// ---------------------------------------------------------------------------

describe('MailDeliveryService injectPtyLine', () => {
  it('submits two separate CRs after successive 600ms settle windows for agents', async () => {
    const { clock, store, runner, service } = setup();
    const session = makeSession('s1', { shellType: 'grok' });
    store.add(session);
    runner.running.add('s1');

    const done = service.injectPtyLine(session, 'alice', 'hi there');
    let completed = false;
    void done.then(() => { completed = true; });
    await flushAsync();
    assert.equal(runner.writes.length, 1, 'only the message line before the settle window');
    assert.equal(runner.writes[0].data, '[ftown msg from alice] hi there');

    await clock.advance(599);
    assert.equal(runner.writes.length, 1);
    await clock.advance(1);
    assert.equal(runner.writes.length, 2);
    assert.equal(runner.writes[1].data, '\r');
    assert.equal(completed, false);

    await clock.advance(599);
    assert.equal(runner.writes.length, 2, 'no second CR before its settle window');
    assert.equal(completed, false);
    await clock.advance(1);
    assert.equal(await done, true);
    assert.deepEqual(runner.writes.map((write) => write.data), [
      '[ftown msg from alice] hi there', '\r', '\r',
    ]);
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
    await clock.advance(600);
    assert.deepEqual(runner.writes.map((write) => write.data), [
      ": '[ftown msg from alice] dont run this'", '\r',
    ]);
  });

  it('preserves the quoted no-op and single CR when shellType is undefined', async () => {
    const { clock, runner, service } = setup();
    runner.running.add('s1');
    const done = service.injectPtyLine(makeSession('s1'), 'alice', "don't run this");
    await clock.advance(600);
    assert.equal(await done, true);
    await clock.advance(600);
    assert.deepEqual(runner.writes.map((write) => write.data), [
      ": '[ftown msg from alice] dont run this'", '\r',
    ]);
  });

  it('returns false without a runner or when the initial line is rejected', async () => {
    const session = makeSession('s1', { shellType: 'codex' });
    assert.equal(await new MailDeliveryService().injectPtyLine(session, 'alice', 'hello'), false);

    const { clock, runner, service } = setup();
    assert.equal(await service.injectPtyLine(session, 'alice', 'hello'), false);
    runner.running.add('s1');
    await clock.advance(1_200);
    assert.deepEqual(runner.writes, [], 'a rejected initial line schedules no submits');
  });

  it('returns false after a rejected first submit without attempting a late second submit', async () => {
    const { clock, runner, service } = setup();
    const attempts: string[] = [];
    const write = runner.write.bind(runner);
    runner.write = (sessionId, data) => {
      attempts.push(data);
      return write(sessionId, data);
    };
    runner.running.add('s1');
    const done = service.injectPtyLine(makeSession('s1', { shellType: 'claude' }), 'alice', 'hello');
    runner.running.delete('s1');
    await clock.advance(600);
    assert.equal(await done, false);
    runner.running.add('s1');
    await clock.advance(1_200);
    assert.deepEqual(attempts, ['[ftown msg from alice] hello', '\r']);
  });

  it('returns false when the second submit is rejected', async () => {
    const { clock, runner, service } = setup();
    const attempts: string[] = [];
    const write = runner.write.bind(runner);
    runner.write = (sessionId, data) => {
      attempts.push(data);
      return write(sessionId, data);
    };
    runner.running.add('s1');
    const done = service.injectPtyLine(makeSession('s1', { shellType: 'codex' }), 'alice', 'hello');
    await clock.advance(600);
    runner.running.delete('s1');
    await clock.advance(600);
    assert.equal(await done, false);
    assert.deepEqual(attempts, ['[ftown msg from alice] hello', '\r', '\r']);
    assert.equal(runner.writes.length, 2, 'only the line and first CR succeeded');
  });

  it('strips quotes and newlines from the sender label (shell-quote breakout)', async () => {
    const { clock, store, runner, service } = setup();
    const shellSession = makeSession('s1', { shellType: 'shell' });
    store.add(shellSession);
    runner.running.add('s1');

    const evilSender = "'; touch /tmp/pwned; '";
    const done = service.injectPtyLine(shellSession, evilSender, 'hello');
    await clock.advance(600);
    assert.equal(await done, true);
    assert.equal(runner.writes[0].data, ": '[ftown msg from ; touch /tmp/pwned; ] hello'");

    const agentSession = makeSession('s2', { shellType: 'claude' });
    store.add(agentSession);
    runner.running.add('s2');

    const doneAgent = service.injectPtyLine(agentSession, "a'\nb", 'hello');
    await flushAsync();
    assert.equal((runner.writes.at(-1) as { data: string }).data, '[ftown msg from ab] hello');
    await clock.advance(1_200);
    assert.equal(await doneAgent, true);
    assert.deepEqual(runner.writes.slice(-2).map((write) => write.data), ['\r', '\r']);
  });
});


const nativeSession = (id = 'native') => makeSession(id, { shellType: 'codex', codexSessionId: '00000000-0000-4000-8000-000000000001' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe('MailDeliveryService Codex body delivery', () => {
  it('delivers exact body and bounded metadata while busy, acknowledges only the queued ID', async () => {
    const calls: Array<{ session: Session; text: string }> = [];
    const f = setup(undefined, async (session, text, _signal, current) => {
      assert.equal(await current?.(), true); calls.push({ session, text }); return { status: 'accepted' };
    });
    const session = nativeSession(); f.store.add(session); f.runner.running.add(session.id); f.service.markAgentBusy(session.id);
    const body = "  line one\n'`$(touch nope) 雪\n  ";
    const sent = await f.service.acceptMail(session, { body, from: 'child\nspoof', fromName: '名', type: 'task', threadId: 'thread' });
    assert.equal(sent.ok, true); await f.clock.advance(5_000);
    assert.equal(calls.length, 1); assert.equal(calls[0].session.codexSessionId, session.codexSessionId);
    assert.match(calls[0].text, /^\[ftown mail\] id=/); assert.match(calls[0].text, /from="child spoof"/);
    assert.match(calls[0].text, /fromName="名"/); assert.match(calls[0].text, /type="task"/);
    assert.match(calls[0].text, /threadId="thread"/); assert.ok(calls[0].text.endsWith('\n\n' + body));
    assert.ok(sent.ok && calls[0].text.includes(sent.id));
    assert.equal((await f.mailStore.listUndelivered(session.id)).length, 0);
    assert.equal(f.mailStore.messages[0].deliveredVia, 'cli'); assert.deepEqual(f.runner.writes, []);
    await f.clock.advance(120_000); assert.equal(calls.length, 1); f.service.stop();
  });

  it('excludes an in-flight claim from immediate and long-poll hook drains, but not peek', async () => {
    const pending = deferred<{ status: 'accepted' }>(); let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const f = setup(undefined, async () => { entered(); return pending.promise; });
    const session = nativeSession(); f.store.add(session); f.runner.running.add(session.id);
    await f.service.acceptMail(session, { body: 'claimed' }); await f.clock.advance(5_000); await started;
    for (const wait of [0, 30]) {
      const read = await f.service.readMail(session, { peek: false, wait, all: false, limit: 50 });
      assert.deepEqual(read, { kind: 'immediate', messages: [] });
    }
    const peek = await f.service.readMail(session, { peek: true, wait: 0, all: false, limit: 50 });
    assert.equal(peek.kind, 'immediate'); if (peek.kind === 'immediate') assert.equal(peek.messages[0].body, 'claimed');
    pending.resolve({ status: 'accepted' }); await flushAsync();
    assert.equal(f.mailStore.messages[0].deliveredVia, 'cli'); f.service.stop();
  });

  it('serializes simultaneous arrivals and dispatches each once in order', async () => {
    const first = deferred<{ status: 'accepted' }>(); const calls: string[] = [];
    const f = setup(undefined, async (_session, text) => { calls.push(text); return calls.length === 1 ? first.promise : { status: 'accepted' }; });
    const session = nativeSession(); f.store.add(session); f.runner.running.add(session.id);
    await Promise.all([f.service.acceptMail(session, { body: 'one' }), f.service.acceptMail(session, { body: 'two' })]);
    await f.clock.advance(5_000); assert.equal(calls.length, 1);
    await f.service.acceptMail(session, { body: 'three' }); await f.clock.advance(5_000); assert.equal(calls.length, 1);
    first.resolve({ status: 'accepted' }); await flushAsync(); await f.clock.advance(10_000);
    assert.deepEqual(calls.map(text => text.split('\n\n')[1]), ['one', 'two', 'three']);
    assert.deepEqual(f.mailStore.messages.map(m => m.deliveredVia), ['cli', 'cli', 'cli']); f.service.stop();
  });

  it('retains failures and ambiguous receipts, retries after 60 seconds even with new mail, and never writes PTY', async () => {
    for (const status of ['unsupported', 'rejected', 'unknown'] as const) {
      const calls: string[] = []; const f = setup(undefined, async (_s, text) => { calls.push(text); return { status }; });
      const session = nativeSession(); f.store.add(session); f.runner.running.add(session.id);
      await f.service.acceptMail(session, { body: 'first' }); await f.clock.advance(5_000);
      await f.service.acceptMail(session, { body: 'second' }); await f.clock.advance(59_999);
      assert.equal(calls.length, 1, status); assert.equal((await f.mailStore.listUndelivered(session.id)).length, 2);
      await f.clock.advance(1); assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]);
      assert.deepEqual(f.runner.writes, []); f.service.stop();
    }
  });

  it('revalidates identity and aborts on replacement or shutdown without marking the old store', async () => {
    const gate = deferred<void>(); let entered!: () => void; let allowed: boolean | undefined; let signal: AbortSignal | undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const f = setup(undefined, async (_s, _text, abort, current) => { signal = abort; entered(); await gate.promise; allowed = await current?.(); return { status: 'accepted' }; });
    const session = nativeSession(); f.store.add(session); f.runner.running.add(session.id);
    await f.service.acceptMail(session, { body: 'one' }); await f.clock.advance(5_000); await started;
    f.store.add({ ...session, codexSessionId: '00000000-0000-4000-8000-000000000002' });
    f.service.setMailStore(new FakeMailStore()); assert.equal(signal?.aborted, true);
    gate.resolve(); await flushAsync(); assert.equal(allowed, false);
    assert.equal((await f.mailStore.listUndelivered(session.id)).length, 1); await f.clock.advance(120_000);
    assert.equal(f.runner.writes.length, 0); f.service.stop();
  });

  it('long-poll timeout cannot consume a claim and a later failed enqueue leaves it readable', async () => {
    const gate = deferred<{ status: 'unknown' }>(); let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const f = setup(undefined, async () => { entered(); return gate.promise; });
    const session = { ...nativeSession(), parentSessionId: 'parent' }; f.store.add(session); f.runner.running.add(session.id);
    const poll = await f.service.readMail(session, { peek: false, wait: 10, all: false, limit: 50 });
    assert.equal(poll.kind, 'longpoll');
    // Insert as a durable recovery record without a waiter kick.
    f.mailStore.messages.push({ id: 'persisted', ts: new Date().toISOString(), from: 'external', to: session.id, type: 'message', body: 'claimed' });
    await f.service.recoverPendingMail(session.id); await f.clock.advance(5_000); await started;
    await f.clock.advance(5_000); if (poll.kind === 'longpoll') assert.deepEqual(await poll.messages, []);
    gate.resolve({ status: 'unknown' }); await flushAsync();
    const read = await f.service.readMail(session, { peek: false, wait: 0, all: false, limit: 50 });
    assert.equal(read.kind, 'immediate'); if (read.kind === 'immediate') assert.deepEqual(read.messages.map(m => m.id), ['persisted']);
    assert.equal(f.mailStore.messages[0].deliveredVia, 'drain'); f.service.stop();
  });

  it('fences a changed native identity after the probe, then retries with the current identity', async () => {
    const gate = deferred<void>(); let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
    const identities: Array<string | undefined> = [];
    const f = setup(undefined, async (session, _text, _signal, current) => {
      identities.push(session.codexSessionId); if (identities.length === 1) { entered(); await gate.promise; }
      return { status: await current?.() ? 'accepted' : 'rejected' };
    });
    const session = nativeSession(); f.store.add(session); f.runner.running.add(session.id);
    await f.service.acceptMail(session, { body: 'identity test' }); await f.clock.advance(5_000); await started;
    const newId = '00000000-0000-4000-8000-000000000002'; f.store.add({ ...session, codexSessionId: newId });
    gate.resolve(); await flushAsync(); assert.equal((await f.mailStore.listUndelivered(session.id)).length, 1);
    await f.clock.advance(60_000); assert.deepEqual(identities, [session.codexSessionId, newId]);
    assert.equal(f.mailStore.messages[0].deliveredVia, 'cli'); f.service.stop();
  });

  it('stops an in-flight wake and leaves mail pending without scheduling a retry', async () => {
    const gate = deferred<{ status: 'accepted' }>(); let signal: AbortSignal | undefined; let count = 0;
    const f = setup(undefined, async (_s, _text, abort) => { count++; signal = abort; return gate.promise; });
    const session = nativeSession(); f.store.add(session); f.runner.running.add(session.id);
    await f.service.acceptMail(session, { body: 'pending' }); await f.clock.advance(5_000);
    f.service.stop(); assert.equal(signal?.aborted, true); gate.resolve({ status: 'accepted' }); await flushAsync();
    await f.clock.advance(120_000); assert.equal(count, 1); assert.equal((await f.mailStore.listUndelivered(session.id)).length, 1);
  });

  it('does not hot-loop if acknowledgment persistence fails', async () => {
    let calls = 0; const f = setup(undefined, async () => { calls++; return { status: 'accepted' }; });
    const session = nativeSession(); f.store.add(session); f.runner.running.add(session.id);
    const mark = f.mailStore.markDelivered.bind(f.mailStore); let fail = true;
    f.mailStore.markDelivered = async (...args) => { if (fail) { fail = false; throw new Error('disk'); } return mark(...args); };
    await f.service.acceptMail(session, { body: 'durable' }); await f.clock.advance(5_000);
    assert.equal((await f.mailStore.listUndelivered(session.id)).length, 1); await f.clock.advance(59_999); assert.equal(calls, 1);
    await f.clock.advance(1); assert.equal(calls, 2); assert.equal(f.mailStore.messages[0].deliveredVia, 'cli'); f.service.stop();
  });

  it('leaves missing native ID available and prevents Codex PTY fallback while preserving other fallback', async () => {
    const f = setup(); const codex = makeSession('codex', { shellType: 'codex' }); const other = makeSession('other', { shellType: 'grok' });
    f.store.add(codex); f.store.add(other); f.runner.running.add(codex.id); f.runner.running.add(other.id);
    await f.service.acceptMail(codex, { body: 'private codex body' }); await f.service.acceptMail(other, { body: 'private grok body', from: 'bob' });
    await f.clock.advance(61_200); assert.equal(f.runner.nudgeLines().length, 1);
    assert.match(f.runner.nudgeLines()[0], /You have new ftown mail from bob/);
    assert.equal((await f.mailStore.listUndelivered(codex.id)).length, 1); f.service.stop();
  });
});

describe('MailDeliveryService native wakes', () => {
  it('healthy native plugin lease suppresses already scheduled PTY and expiry restores fallback', async () => {
    const f = setup(); const session = makeSession('claude', { shellType: 'claude', claudeSessionId: 'native-id' });
    f.store.add(session); f.runner.running.add(session.id);
    await f.service.acceptMail(session, { body: 'task' });
    await f.clock.advance(59_000);
    f.service.registerNativeWake(session, { adapter: 'claude-mod', nativeSessionId: 'native-id' });
    await f.clock.advance(30_000); await f.clock.advance(1_200);
    assert.equal(f.runner.nudgeLines().length, 1, 'lease expiry, not original timer, permits PTY');
    f.service.stop();
  });

  it('lease refreshes while native prompt is pending; stale native IDs and stopped processes cannot suppress fallback', async () => {
    const f = setup(); const session = makeSession('claude', { shellType: 'fireworks', claudeSessionId: 'native-id' });
    f.store.add(session); f.runner.running.add(session.id);
    await f.service.acceptMail(session, { body: 'task' });
    for (let i = 0; i < 15; i++) { f.service.registerNativeWake(session, { adapter: 'claude-mod', nativeSessionId: 'native-id' }); await f.clock.advance(5_000); }
    assert.equal(f.runner.writes.length, 0);
    f.store.add({ ...session, claudeSessionId: 'changed' });
    await f.clock.advance(31_200); assert.equal(f.runner.nudgeLines().length, 1);
    assert.throws(() => f.service.registerNativeWake(session, { adapter: 'claude-mod', nativeSessionId: 'wrong' }), (error: unknown) => error instanceof NativeWakeRegistrationError && error.status === 409);
    f.runner.running.delete(session.id);
    assert.throws(() => f.service.registerNativeWake(session, { adapter: 'claude-mod', nativeSessionId: 'native-id' }), /running process/);
    f.service.stop();
  });

  it('shutdown fences PTY submits already awaiting paste settle', async () => {
    const f = setup(); const session = makeSession('s', { shellType: 'grok' }); f.runner.running.add(session.id);
    const done = f.service.injectPtyLine(session, 'sender', 'pointer'); await flushAsync();
    f.service.stop(); await f.clock.advance(1_200); assert.equal(await done, false);
    assert.equal(f.runner.writes.length, 1, 'no delayed carriage return after stop');
  });
});

describe('native heartbeat parsing', () => {
  it('keeps ordinary peeks unchanged and rejects partial, malformed or destructive registrations', () => {
    assert.equal(parseNativeWakeRegistration(new URLSearchParams('peek=1')), undefined);
    const valid = 'peek=1&wait=0&adapter=claude-mod&nativeSessionId=native-id';
    assert.deepEqual(parseNativeWakeRegistration(new URLSearchParams(valid)), { adapter: 'claude-mod', nativeSessionId: 'native-id' });
    for (const query of ['adapter=claude-mod', 'nativeSessionId=native-id', valid.replace('peek=1', 'peek=0'), valid.replace('wait=0', 'wait=1'), valid.replace('claude-mod', 'unknown'), valid + '&adapter=opencode', valid.replace('native-id', 'unsafe/id')]) {
      assert.throws(() => parseNativeWakeRegistration(new URLSearchParams(query)), (error: unknown) => error instanceof NativeWakeRegistrationError && error.status === 400, query);
    }
  });
});


describe('late mail wake revalidation', () => {
    it('selects Muse identity by harness even when an unrelated Codex ID is present', async () => {
      const gate = deferred<void>(); let current: (() => Promise<boolean>) | undefined; let allowed: boolean | undefined;
      const f = setup(undefined, async (_session, _text, _signal, check) => { current = check; await gate.promise; allowed = await check?.(); return { status: 'unknown' }; });
      const session = makeSession('muse', { shellType: 'muse', museSessionId: '00000000-0000-4000-8000-000000000001', codexSessionId: 'stale-unrelated' });
      f.store.add(session); f.runner.running.add(session.id);
      await f.service.acceptMail(session, { body: 'task' }); await f.clock.advance(5_000); assert.ok(current);
      f.store.add({ ...session, museSessionId: '00000000-0000-4000-8000-000000000002' });
      gate.resolve(); await flushAsync(); assert.equal(allowed, false); assert.equal(f.runner.writes.length, 0); f.service.stop();
    });
    it('does not write a legacy pointer when the recipient becomes Codex mid-wake', async () => {
      const calls: string[] = []; const f = setup(undefined, async (_s, text) => { calls.push(text); return { status: 'accepted' }; });
      const session = makeSession('switch', { shellType: 'grok' }); f.store.add(session); f.runner.running.add(session.id);
      const read = f.mailStore.listUndelivered.bind(f.mailStore); let reads = 0;
      f.mailStore.listUndelivered = async id => { const messages = await read(id); if (++reads === 2) f.store.add({ ...session, shellType: 'codex', codexSessionId: '00000000-0000-4000-8000-000000000001' }); return messages; };
      await f.service.acceptMail(session, { body: 'body' }); await f.clock.advance(10_000);
      assert.deepEqual(f.runner.writes, []); assert.equal(calls.length, 1); assert.ok(calls[0].endsWith('\n\nbody')); f.service.stop();
    });
    it('rechecks resumed activity during the final awaited mail scan before PTY input', async () => {
      const f = setup(); const session = makeSession('grok', { shellType: 'grok' }); f.store.add(session); f.runner.running.add(session.id);
      const read = f.mailStore.listUndelivered.bind(f.mailStore); let reads = 0;
      f.mailStore.listUndelivered = async id => { const messages = await read(id); if (++reads === 2) f.service.markAgentBusy(id); return messages; };
      await f.service.acceptMail(session, { body: 'task' }); await f.clock.advance(6_200);
      assert.equal(f.runner.writes.length, 0); f.service.stop();
    });
  });
