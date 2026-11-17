import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionFailureMonitor } from './session-block.js';
import type { Session } from './types.js';
import { AUTOMATION_REMOVED_MESSAGE } from './wire-types.js';

interface SentMail { to: string; from: string; type: string; body: string; idempotencyKey?: string }
interface Attention { sessionId: string; title: string; message: string; notificationId: string }

function session(partial: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    name: partial.id,
    command: 'muse',
    status: 'running',
    bridgeId: 'bridge',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    shellType: 'muse',
    ...partial,
  };
}

function harness() {
  const sessions = new Map<string, Session>();
  const mail: SentMail[] = [];
  const attention: Attention[] = [];
  let now = new Date('2026-01-01T12:00:00.000Z');
  let mailOk = true;
  let mailCalls = 0;
  const acceptedKeys: Array<string | undefined> = [];
  const deps = {
    loadSession: async (id) => {
      const found = sessions.get(id);
      return found ? structuredClone(found) : null;
    },
    saveSession: async (next) => { sessions.set(next.id, structuredClone(next)); },
    publishSession: async () => {},
    withSessionWrite: async (_id, task) => { await task(); },
    listMail: async (id) => mail.filter((item) => item.to === id),
    acceptMail: async (parent, body) => {
      mailCalls += 1;
      acceptedKeys.push(body.idempotencyKey);
      if (!mailOk) return { ok: false, error: 'down' };
      if (body.idempotencyKey !== undefined && !mail.some((existing) => existing.to === parent.id && existing.idempotencyKey === body.idempotencyKey)) {
        mail.push({ to: parent.id, from: body.from, type: body.type, body: body.body, idempotencyKey: body.idempotencyKey });
      }
      return { ok: true };
    },
    recordAttention: async (sessionId, input) => {
      attention.push({ sessionId, title: input.title, message: input.message, notificationId: input.notificationId });
      return true;
    },
    now: () => now,
    debounceMs: 60_000,
  };
  const monitor = new SessionFailureMonitor(deps);
  return {
    sessions,
    mail,
    attention,
    monitor,
    deps,
    mailCalls: () => mailCalls,
    acceptedKeys,
    setNow(next: Date) { now = next; },
    setMailOk(ok: boolean) { mailOk = ok; },
  };
}

test('a running usage limit mails the parent once and keeps the session running', async () => {
  const h = harness();
  h.sessions.set('parent', session({ id: 'parent', shellType: 'shell', command: 'zsh' }));
  h.sessions.set('child', session({
    id: 'child',
    name: 'worker',
    parentSessionId: 'parent',
    workingDir: '/work/child',
    pullRequestUrl: 'https://github.com/owner/repo/pull/7',
    worktree: { repoRoot: '/work', path: '/work/child', branch: 'ftown/worker', base: 'main', createdByBridge: true },
  }));
  h.sessions.get('parent')!.plan = {
    seq: 2,
    items: [{ id: 'p2', title: 'Ship the limit notice', after: [], priority: 1, state: 'started', sessionId: 'child', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  };
  h.monitor.observe('child', 'Usage limit reached\nresets at 9:00 PM\n');
  await h.monitor.flush('child');
  await h.monitor.flush('child');
  const child = h.sessions.get('child')!;
  assert.equal(child.status, 'running');
  assert.equal(child.errorReason, undefined);
  assert.equal(child.block?.reason, 'usage_limit');
  assert.ok(child.block?.resetAt);
  assert.ok(child.block?.notifiedAt);
  assert.match(child.lastError ?? '', /usage_limit/);
  assert.equal(h.mail.length, 1);
  assert.equal(h.mail[0].type, 'escalation');
  assert.equal(h.mail[0].from, 'child');
  assert.equal(h.mail[0].to, 'parent');
  assert.match(h.mail[0].body, /reason: usage_limit/);
  assert.match(h.mail[0].body, /resetAt: /);
  assert.match(h.mail[0].body, /worktree: \/work\/child/);
  assert.match(h.mail[0].body, /pullRequest: https:\/\/github.com\/owner\/repo\/pull\/7/);
  assert.match(h.mail[0].body, /planItem: p2 Ship the limit notice/);
  assert.match(h.mail[0].body, /Usage limit reached/);
  assert.equal(h.mailCalls(), 1);
  assert.equal(h.mail[0].idempotencyKey, `session-block:child:${child.block?.transitionKey}`);
});

test('a restart after durable mail append retries with the same transition key and does not duplicate escalation', async () => {
  const h = harness();
  h.sessions.set('parent', session({ id: 'parent' }));
  h.sessions.set('child', session({ id: 'child', parentSessionId: 'parent' }));
  h.deps.loadTerminalLog = async () => 'Usage limit reached\nresets at 9:00 PM\n';

  const save = h.deps.saveSession;
  let crashAfterSend = true;
  h.deps.saveSession = async (next) => {
    if (crashAfterSend && next.block?.notifiedAt) {
      crashAfterSend = false;
      throw new Error('simulated crash after mail append');
    }
    await save(next);
  };
  h.monitor.observe('child', 'Usage limit reached\nresets at 9:00 PM\n');
  await assert.rejects(() => h.monitor.flush('child'), /simulated crash after mail append/);
  assert.equal(h.mail.length, 1);
  assert.equal(h.sessions.get('child')?.block?.notifiedAt, undefined);

  const restarted = new SessionFailureMonitor(h.deps);
  await restarted.flush('child');
  assert.ok(h.acceptedKeys[0]);
  assert.equal(h.acceptedKeys[1], h.acceptedKeys[0]);
  assert.equal(h.mail.length, 1);
  assert.equal(h.mailCalls(), 2);
  assert.ok(h.sessions.get('child')?.block?.notifiedAt);
});

test('a tmux capability sequence before a limit phrase still blocks', async () => {
  const h = harness();
  h.sessions.set('child', session({ id: 'child' }));
  h.monitor.observe('child', '\x1b=\x1b(B\x1b>\x1b[?1;2c\x1b>\x1b[?qUsage limit reached\nresets at 9:00 PM\n');
  await h.monitor.flush('child');
  const child = h.sessions.get('child')!;
  assert.equal(child.block?.reason, 'usage_limit');
  assert.ok(child.block?.resetAt);
});

test('a later error is a new transition and mails again', async () => {
  const h = harness();
  h.sessions.set('parent', session({ id: 'parent' }));
  h.sessions.set('child', session({ id: 'child', parentSessionId: 'parent' }));
  h.monitor.observe('child', 'Usage limit reached\n');
  await h.monitor.flush('child');
  const running = h.sessions.get('child')!;
  running.status = 'error';
  h.sessions.set('child', running);
  await h.monitor.settle('child', { kind: 'error', message: 'Process exited with code 1' });
  const child = h.sessions.get('child')!;
  assert.equal(h.mail.length, 2);
  assert.equal(child.exitCode, 1);
  assert.equal(child.block?.exitCode, 1);
  assert.equal(child.errorReason, child.lastError);
  assert.ok(child.errorReason);
  assert.notEqual(child.block?.transitionKey, 'usage_limit||running');
});

test('a clean exit that already reported a result does not send exited', async () => {
  const h = harness();
  h.sessions.set('parent', session({ id: 'parent' }));
  h.sessions.set('child', session({ id: 'child', parentSessionId: 'parent' }));
  h.monitor.observe('child', 'Usage limit reached\nresets at 9:00 PM\n');
  await h.monitor.flush('child');
  h.mail.push({ to: 'parent', from: 'child', type: 'result', body: 'done' });
  const current = h.sessions.get('child')!;
  current.status = 'completed';
  h.sessions.set('child', current);
  await h.monitor.settle('child', { kind: 'completed', message: 'Process exited with code 0' });
  assert.equal(h.mail.filter((item) => item.type === 'escalation').length, 1);
  assert.equal(h.sessions.get('child')!.block, undefined);
});

test('a completed shell is not a failure and raises no attention', async () => {
  const h = harness();
  h.sessions.set('solo', session({ id: 'solo', shellType: 'shell', command: 'zsh', status: 'completed' }));
  h.monitor.observe('solo', 'user% \n[lost tty]\n');
  await h.monitor.flush('solo');
  await h.monitor.settle('solo', { kind: 'completed', message: 'Process exited with code 0' });
  const solo = h.sessions.get('solo')!;
  assert.equal(solo.block, undefined);
  assert.equal(solo.lastError, undefined);
  assert.equal(h.attention.length, 0);
  assert.equal(h.mail.length, 0);
});

test('an exit without a result is a failure with a non-empty reason', async () => {
  const h = harness();
  h.sessions.set('parent', session({ id: 'parent' }));
  h.sessions.set('child', session({ id: 'child', parentSessionId: 'parent', status: 'completed' }));
  await h.monitor.settle('child', { kind: 'completed' });
  const child = h.sessions.get('child')!;
  assert.equal(child.block?.reason, 'exited');
  assert.equal(child.exitCode, undefined);
  assert.match(child.lastError ?? '', /without a result/);
  assert.equal(h.mail.length, 1);
  assert.match(h.mail[0].body, /reason: exited/);
});

test('an error with no exit code stores a reason instead of nulls', async () => {
  const h = harness();
  h.sessions.set('parent', session({ id: 'parent' }));
  h.sessions.set('child', session({ id: 'child', parentSessionId: 'parent', status: 'error' }));
  await h.monitor.settle('child', { kind: 'error', message: 'tmux session ended without recording an exit code' });
  const child = h.sessions.get('child')!;
  assert.equal(child.block?.reason, 'crashed');
  assert.equal(child.exitCode, undefined);
  assert.equal(child.block?.exitCode, undefined);
  assert.match(child.lastError ?? '', /exit code unavailable/);
  assert.equal(child.errorReason, child.lastError);
  assert.equal(JSON.parse(JSON.stringify(child)).exitCode, undefined);
});

test('a session with no parent raises one human attention item', async () => {
  const h = harness();
  h.sessions.set('solo', session({ id: 'solo', status: 'error' }));
  await h.monitor.settle('solo', { kind: 'error', message: 'Process exited with code 2' });
  await h.monitor.settle('solo', { kind: 'error', message: 'Process exited with code 2' });
  assert.equal(h.mail.length, 0);
  assert.equal(h.attention.length, 1);
  assert.equal(h.attention[0].title, 'Session blocked');
  assert.match(h.attention[0].notificationId, /^block:solo:crashed\|/);
  assert.ok(h.sessions.get('solo')!.block?.notifiedAt);
});

test('a failed report is retried after the backoff, not on the next tick', async () => {
  const h = harness();
  h.sessions.set('parent', session({ id: 'parent' }));
  h.sessions.set('child', session({ id: 'child', parentSessionId: 'parent', status: 'error' }));
  h.setMailOk(false);
  await h.monitor.settle('child', { kind: 'error', message: 'Process exited with code 1' });
  assert.equal(h.mailCalls(), 1);
  assert.equal(h.sessions.get('child')!.block?.notifiedAt, undefined);
  await h.monitor.settle('child', { kind: 'error', message: 'Process exited with code 1' });
  assert.equal(h.mailCalls(), 1);
  h.setMailOk(true);
  h.setNow(new Date('2026-01-01T12:00:06.000Z'));
  await h.monitor.settle('child', { kind: 'error', message: 'Process exited with code 1' });
  assert.equal(h.mailCalls(), 2);
  assert.equal(h.mail.length, 1);
  assert.ok(h.sessions.get('child')!.block?.notifiedAt);
});

test('automation retirement is not a harness failure', async () => {
  const h = harness();
  h.sessions.set('child', session({ id: 'child', status: 'error', errorReason: AUTOMATION_REMOVED_MESSAGE }));
  await h.monitor.settle('child', { kind: 'error', message: AUTOMATION_REMOVED_MESSAGE });
  assert.equal(h.sessions.get('child')!.block, undefined);
  assert.equal(h.mail.length, 0);
  assert.equal(h.attention.length, 0);
});


test('fresh healthy output clears a recorded auth block without rescanning old log', async () => {
  const h = harness();
  h.sessions.set('child', session({ id: 'child' }));
  h.deps.loadTerminalLog = async () => 'Not logged in · Please run /login\n';
  h.monitor.observe('child', 'Not logged in · Please run /login\n');
  await h.monitor.flush('child');
  assert.equal(h.sessions.get('child')?.block?.reason, 'auth');
  h.monitor.observe('child', 'Working on the requested task\n');
  await h.monitor.flush('child');
  assert.equal(h.sessions.get('child')?.block, undefined);
  h.monitor.observe('child', 'More work\n');
  await h.monitor.flush('child');
  assert.equal(h.sessions.get('child')?.block, undefined);
});

test('expired blocks are removed at startup using the injected clock', async () => {
  const h = harness();
  h.sessions.set('child', session({ id: 'child', block: { reason: 'crashed', screenTail: '', detectedAt: '2025-12-20T00:00:00.000Z', transitionKey: 'crashed||error' } }));
  await h.monitor.expire('child');
  assert.equal(h.sessions.get('child')?.block, undefined);
});
