import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IPty } from 'node-pty';
import { ProcessRunner } from './claude-runner.js';
import { SessionFailureMonitor } from './session-block.js';
import { TerminalPump } from './terminal-pump.js';
import type { Session } from './types.js';

function session(partial: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    name: partial.id,
    command: 'opencode',
    status: 'running',
    bridgeId: 'bridge',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    shellType: 'opencode',
    ...partial,
  };
}

function controlledPty() {
  let onExit!: (event: { exitCode: number | null; signal?: number }) => void;
  let onData!: (value: string) => void;
  const writes: string[] = [];
  const process = {
    pid: 4,
    onData: (handler: (value: string) => void) => { onData = handler; return { dispose() {} }; },
    onExit: (handler: (event: { exitCode: number | null; signal?: number }) => void) => { onExit = handler; return { dispose() {} }; },
    write: (value: string) => { writes.push(value); },
    resize: () => {},
    kill: () => {},
  } as unknown as IPty;
  return {
    process,
    writes,
    data: (value: string) => onData(value),
    exit: (code: number | null) => onExit({ exitCode: code }),
  };
}

test('a harness that dies on launch records a reason and mails the parent once', async () => {
  const sessions = new Map<string, Session>();
  sessions.set('parent', session({ id: 'parent', shellType: 'shell', command: 'zsh' }));
  sessions.set('child', session({ id: 'child', parentSessionId: 'parent', name: 'worker' }));
  const mail: Array<{ type: string; body: string }> = [];
  const log: string[] = [];
  const pty = controlledPty();
  const runner = new ProcessRunner({ spawn: () => pty.process });
  runner.getPreferredRuntime = () => 'direct';
  const monitor = new SessionFailureMonitor({
    loadSession: async (id) => {
      const found = sessions.get(id);
      return found ? structuredClone(found) : null;
    },
    saveSession: async (next) => { sessions.set(next.id, structuredClone(next)); },
    publishSession: async () => {},
    withSessionWrite: async (_id, task) => { await task(); },
    loadTerminalLog: async () => log.join(''),
    listMail: async () => mail.map((item) => ({ from: 'child', type: item.type })),
    acceptMail: async (_parent, body) => {
      mail.push({ type: body.type, body: body.body });
      return { ok: true };
    },
    recordAttention: async () => false,
    debounceMs: 60_000,
  });
  const pump = new TerminalPump({
    store: {
      appendTerminalData: async (_id, data) => { log.push(data); },
      loadSession: async (id) => sessions.get(id) ?? null,
      saveSession: async (next) => { sessions.set(next.id, structuredClone(next)); },
      loadTerminalLog: async () => log.join(''),
    },
    terminalManager: { write: () => {}, destroy: () => {} },
    publishTerminalData: () => {},
    publishSessionUpdate: async () => {},
    publishHookEvent: async () => {},
    unregisterSession: () => {},
    onOutput: (id, data) => { monitor.observe(id, data); },
    onLifecycle: (id, event) => monitor.settle(id, event),
  });
  pump.attach(runner);
  runner.run('child', 'opencode', { initialInput: 'do the task', initialInputDelay: 0 });
  pty.data('unrecognized flag\n');
  pty.exit(1);

  const deadline = Date.now() + 2000;
  while (mail.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const child = sessions.get('child')!;
  assert.equal(child.status, 'error');
  assert.ok(child.errorReason && child.errorReason.length > 0);
  assert.ok(child.lastError && child.lastError.length > 0);
  assert.equal(child.block?.reason, 'crashed');
  assert.equal(mail.length, 1);
  assert.equal(mail[0].type, 'escalation');
  assert.match(mail[0].body, /reason: crashed/);
  assert.match(mail[0].body, /unrecognized flag/);
  assert.deepEqual(pty.writes, []);

  await monitor.settle('child', { kind: 'error', message: 'Process exited with code 1' });
  assert.equal(mail.length, 1);
});
