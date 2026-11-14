import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEvent, AgentScript, AgentStep, Clock, Role } from '../contract.ts';
import { runAgent } from './agent.ts';
import type { AgentState, CliOpts, CliResult, StateStore } from './agent.ts';

function fakeClock(): Clock {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

/** Async iterable fed by push(); end() closes it. */
function lineQueue() {
  const buf: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(l: string) {
      buf.push(l);
      wake?.();
    },
    end() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (buf.length) yield buf.shift() as string;
        if (closed) return;
        await new Promise<void>((r) => {
          wake = r;
        });
        wake = null;
      }
    },
  };
}

type Call = { args: string[]; opts?: CliOpts };
type Handler = (call: Call, n: number) => CliResult | Promise<CliResult>;

function setup(script: Partial<AgentScript> & { steps: AgentStep[]; role?: Role }, handler: Handler, ids: Record<string, string> = {}) {
  const events: AgentEvent[] = [];
  const calls: Call[] = [];
  const stdin = lineQueue();
  let active = 0;
  let maxActive = 0;
  const cli = async (args: string[], opts?: CliOpts): Promise<CliResult> => {
    const call = { args, opts };
    calls.push(call);
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      return await handler(call, calls.length);
    } finally {
      active--;
    }
  };
  const exits: number[] = [];
  const run = () =>
    runAgent({
      script: { role: 'child1', readMailOnNudge: true, answerRoutedQuestions: false, ...script },
      clock: fakeClock(),
      cli,
      hook: async () => true,
      log: (e) => events.push(e),
      stdinLines: stdin,
      resolveId: (r) => ids[r] ?? null,
      exit: (c) => exits.push(c),
      pid: 42,
    });
  return { events, calls, stdin, exits, run, maxActive: () => maxActive };
}

const ok = (stdout = '', stderr = ''): CliResult => ({ code: 0, stdout, stderr });
const inbox = (...messages: { type?: string; body: string }[]): CliResult =>
  ok(JSON.stringify({ sessionId: 's', messages: messages.map((m, i) => ({ id: `m${i}`, from: 'x', to: 's', type: 'message', ...m })) }));
const NUDGE = '[ftown] 1 new mail (1 message) — run: ftown harness mail read';
const tick = () => new Promise<void>((r) => setImmediate(r));
const without = (events: AgentEvent[], ...evs: string[]) => events.filter((e) => !evs.includes(e.ev));

test('scripted send: tag from the agent base, --parent to the parent, id lookup for a sibling', async () => {
  const t = setup(
    {
      role: 'child2',
      steps: [
        { do: 'mail_send', to: 'parent', type: 'result', body: 'done' },
        { do: 'mail_send', to: 'child1', type: 'message', body: '' },
        { do: 'mail_send', to: 'child3', type: 'fyi', body: 'x' },
        { do: 'sleep', ms: 5 },
        { do: 'hook', event: 'Stop' },
      ],
    },
    () => ok('{}'),
    { child1: 'sid-1' },
  );
  t.stdin.end();
  await t.run();
  assert.deepEqual(t.events, [
    { ev: 'start', pid: 42 },
    { ev: 'mail_sent', tag: 'CHAOS-M-3000', to: 'root', type: 'result', accepted: true, error: null },
    { ev: 'mail_sent', tag: 'CHAOS-M-3001', to: 'child1', type: 'message', accepted: true, error: null },
    { ev: 'mail_sent', tag: 'CHAOS-M-3002', to: 'child3', type: 'fyi', accepted: false, error: 'unknown recipient' },
    { ev: 'hook_sent', event: 'Stop', ok: true },
  ]);
  assert.deepEqual(t.calls.map((c) => c.args), [
    ['harness', '--json', 'mail', 'send', '--parent', '--type', 'result', 'CHAOS-M-3000 from=child2 to=root done'],
    ['harness', '--json', 'mail', 'send', 'sid-1', '--type', 'message', 'CHAOS-M-3001 from=child2 to=child1'],
  ]);
});

test('nudge -> read -> mail_received; nudge ignored when readMailOnNudge is false', async () => {
  const t = setup({ steps: [] }, () => inbox(
    { type: 'task', body: 'CHAOS-M-5 from=root to=child1' },
    { body: 'untagged' },
    { type: 'fyi', body: 'CHAOS-M-6 from=external to=child1' },
  ));
  t.stdin.push(NUDGE);
  t.stdin.end();
  await t.run();
  assert.deepEqual(t.events, [
    { ev: 'start', pid: 42 },
    { ev: 'stdin_line', text: NUDGE },
    { ev: 'nudge', n: 1 },
    { ev: 'mail_received', tag: 'CHAOS-M-5', type: 'task', fromRole: 'root' },
    { ev: 'mail_received', tag: 'CHAOS-M-6', type: 'fyi', fromRole: 'external' },
  ]);
  assert.deepEqual(t.calls[0].args, ['harness', '--json', 'mail', 'read']);

  const off = setup({ steps: [], readMailOnNudge: false }, () => inbox());
  off.stdin.push(NUDGE);
  off.stdin.push('not a nudge');
  off.stdin.end();
  await off.run();
  assert.equal(off.calls.length, 0);
  assert.deepEqual(off.events.map((e) => e.ev), ['start', 'stdin_line', 'nudge', 'stdin_line']);
});

test('duplicate read: concurrent triggers run one read at a time and a mail is logged once', async () => {
  let delivered = false;
  const t = setup({ steps: [{ do: 'mail_read' }, { do: 'mail_read' }] }, async () => {
    await tick();
    await tick();
    if (delivered) return inbox();
    delivered = true;
    return inbox({ body: 'CHAOS-M-9 from=root to=child1' });
  });
  t.stdin.push(NUDGE);
  t.stdin.push(NUDGE);
  t.stdin.end();
  await t.run();
  assert.equal(t.maxActive(), 1, 'reads never overlap');
  assert.equal(t.calls.length, 4);
  assert.equal(t.events.filter((e) => e.ev === 'mail_received').length, 1);
});

test('ask answered by the waiter: ask_sent on the stderr event id, later steps are not blocked', async () => {
  let release: (r: CliResult) => void = () => undefined;
  const t = setup(
    { steps: [{ do: 'ask', title: 'ignored', message: 'ignored', options: ['a'] }, { do: 'hook', event: 'Stop' }] },
    (c) => new Promise<CliResult>((r) => {
      c.opts?.onStderr?.('Waiting for an answer (attention evt-1)...\n');
      release = r;
    }),
  );
  t.stdin.end();
  const done = t.run();
  await tick();
  await tick();
  assert.deepEqual(t.events, [
    { ev: 'start', pid: 42 },
    { ev: 'ask_sent', askTag: 'CHAOS-Q-2000', accepted: true, error: null },
    { ev: 'hook_sent', event: 'Stop', ok: true },
  ]);
  release(ok('Q: CHAOS-Q-2000 from=child1\nA: yes\n', 'Waiting for an answer (attention evt-1)...\n'));
  await done;
  assert.deepEqual(t.events.at(-1), { ev: 'answer_received', askTag: 'CHAOS-Q-2000', answer: 'yes', via: 'waiter' });
  assert.deepEqual(t.calls[0].args.slice(0, 8), ['sessions', 'attention', '--title', 'CHAOS-Q-2000 from=child1', '--message', 'CHAOS-Q-2000 from=child1', '--option', 'yes']);
  assert.ok(t.calls[0].args.includes('--wait'));
});

test('ask step waits for ask_sent before next step, leaving --wait in background', async () => {
  let emitStderr: (chunk: string) => void = () => undefined;
  let release: (r: CliResult) => void = () => undefined;
  const t = setup(
    { steps: [{ do: 'ask', title: 'ignored', message: 'ignored', options: ['a'] }, { do: 'hook', event: 'Stop' }] },
    (c) => new Promise<CliResult>((r) => {
      emitStderr = (chunk) => c.opts?.onStderr?.(chunk);
      release = r;
    }),
  );
  t.stdin.end();
  const done = t.run();
  await tick();
  await tick();
  // Before event id arrives, Stop has not fired yet.
  assert.deepEqual(t.events, [{ ev: 'start', pid: 42 }]);
  emitStderr('Waiting for an answer (attention evt-2)...\n');
  await tick();
  await tick();
  // Once ask_sent is known, Stop runs without waiting for --wait to finish.
  assert.deepEqual(t.events, [
    { ev: 'start', pid: 42 },
    { ev: 'ask_sent', askTag: 'CHAOS-Q-2000', accepted: true, error: null },
    { ev: 'hook_sent', event: 'Stop', ok: true },
  ]);
  release(ok('Q: CHAOS-Q-2000 from=child1\nA: yes\n', 'Waiting for an answer (attention evt-2)...\n'));
  await done;
  assert.deepEqual(t.events.at(-1), { ev: 'answer_received', askTag: 'CHAOS-Q-2000', answer: 'yes', via: 'waiter' });
});

test('ask answered by mail: the answer mail is logged with via mail', async () => {
  const t = setup(
    { steps: [{ do: 'ask', title: 't', message: 'm', options: [] }] },
    (c) => {
      if (c.args[0] === 'sessions') return { code: 124, stdout: '', stderr: 'Waiting for an answer (attention evt-1)...\nTimed out' };
      return inbox({ body: '[ftown attention answer id=evt-1]\nRe: CHAOS-Q-2000 from=child1\n\nQ: CHAOS-Q-2000 from=child1\nA: no' });
    },
  );
  t.stdin.push(NUDGE);
  t.stdin.end();
  await t.run();
  assert.ok(t.events.some((e) => e.ev === 'answer_received' && e.via === 'mail' && e.askTag === 'CHAOS-Q-2000' && e.answer === 'no'));
  assert.ok(t.events.some((e) => e.ev === 'ask_sent' && e.accepted));
  assert.ok(!t.events.some((e) => e.ev === 'answer_received' && e.via === 'waiter'));
});

const ESCALATION =
  '[ftown question id=evt-7 from=child2 (sid-c2)] CHAOS-Q-3000 from=child2\nCHAOS-Q-3000 from=child2\nOptions: 1) yes 2) no\nAnswer: ftown attention answer sid-c2 evt-7 --option <n> | --text "<reply>"';

test('routed question answered with option 0 when answerRoutedQuestions', async () => {
  const t = setup({ role: 'root', steps: [], answerRoutedQuestions: true }, (c) => (c.args[0] === 'attention' ? ok('{}') : inbox({ type: 'escalation', body: ESCALATION })));
  t.stdin.push(NUDGE);
  t.stdin.end();
  await t.run();
  assert.deepEqual(without(t.events, 'start', 'stdin_line', 'nudge'), [{ ev: 'routed_answer_sent', askTag: 'CHAOS-Q-3000', accepted: true, error: null }]);
  assert.deepEqual(t.calls[1].args, ['attention', 'answer', 'sid-c2', 'evt-7', '--option', '1']);
});

test('routed question is only recorded when answerRoutedQuestions is false, then answered by the step', async () => {
  const t = setup({ role: 'root', steps: [{ do: 'mail_read' }, { do: 'answer_routed', optionIndex: 1 }] }, (c) => (c.args[0] === 'attention' ? ok('{}') : inbox({ type: 'escalation', body: ESCALATION })));
  t.stdin.end();
  await t.run();
  assert.deepEqual(t.calls.map((c) => c.args[0]), ['harness', 'attention']);
  assert.deepEqual(t.calls[1].args.slice(-2), ['--option', '2']);
  assert.equal(t.events.filter((e) => e.ev === 'routed_answer_sent').length, 1);
});

test('CLI failure: logged as cli_error, not retried', async () => {
  const t = setup(
    { steps: [{ do: 'mail_send', to: 'parent', type: 'message', body: 'b' }, { do: 'mail_read' }, { do: 'status', state: 'working', headline: 'h' }] },
    (c) => (c.args[1] === 'status' || c.args[0] === 'status' ? { code: 124, stdout: '', stderr: 'timeout' } : { code: 1, stdout: '', stderr: 'bridge down' }),
  );
  t.stdin.end();
  await t.run();
  assert.deepEqual(without(t.events, 'start'), [
    { ev: 'mail_sent', tag: 'CHAOS-M-2000', to: 'root', type: 'message', accepted: false, error: 'exit 1' },
    { ev: 'cli_error', cmd: 'mail send', error: 'exit 1' },
    { ev: 'cli_error', cmd: 'mail read', error: 'exit 1' },
    { ev: 'cli_error', cmd: 'status set', error: 'timeout' },
  ]);
  assert.equal(t.calls.length, 3);
});

test('ask failing before an event id exists logs ask_sent accepted=false', async () => {
  const t = setup({ steps: [{ do: 'ask', title: 't', message: 'm', options: [] }] }, () => ({ code: 1, stdout: '', stderr: 'nope' }));
  t.stdin.end();
  await t.run();
  assert.deepEqual(without(t.events, 'start'), [
    { ev: 'ask_sent', askTag: 'CHAOS-Q-2000', accepted: false, error: 'exit 1' },
    { ev: 'cli_error', cmd: 'attention', error: 'exit 1' },
  ]);
});

test('exit step logs exit, calls exit and skips later steps', async () => {
  const t = setup({ steps: [{ do: 'exit', code: 7 }, { do: 'hook', event: 'Stop' }] }, () => ok());
  t.stdin.end();
  const r = await t.run();
  assert.deepEqual(without(t.events, 'start'), [{ ev: 'exit', code: 7 }]);
  assert.deepEqual(t.exits, [7]);
  assert.equal(r.exitCode, 7);
});

test('a throwing mail read is a cli_error; later reads still run and the agent finishes', async () => {
  let n = 0;
  const t = setup({ steps: [{ do: 'mail_read' }, { do: 'mail_read' }] }, () => {
    n++;
    if (n === 1) return ok('this is not json');
    if (n === 2) throw new Error('spawn blew up');
    return inbox();
  });
  t.stdin.push(NUDGE);
  t.stdin.end();
  const r = await t.run();
  assert.equal(r.exitCode, null);
  assert.deepEqual(t.events.filter((e) => e.ev === 'cli_error'), [
    { ev: 'cli_error', cmd: 'mail read', error: 'unparseable output' },
    { ev: 'cli_error', cmd: 'mail read', error: 'exception' },
  ]);
  assert.equal(t.calls.length, 3);
});

function memStore(initial: AgentState | null = null): { store: StateStore; saved: AgentState[]; current: () => AgentState | null } {
  let state: AgentState | null = initial ? { ...initial } : null;
  const saved: AgentState[] = [];
  return {
    saved,
    current: () => state,
    store: {
      load: () => (state ? { ...state } : null),
      save: (s) => {
        state = { ...s };
        saved.push({ ...s });
      },
    },
  };
}

test('resume after kill at each point never reuses a tag and never skips a step', async () => {
  const script: AgentScript = {
    role: 'child1',
    readMailOnNudge: false,
    answerRoutedQuestions: false,
    steps: [
      { do: 'mail_send', to: 'parent', type: 'message', body: 'a' },
      { do: 'mail_send', to: 'parent', type: 'message', body: 'b' },
      { do: 'ask', title: 't', message: 'm', options: ['yes', 'no'] },
      { do: 'mail_send', to: 'parent', type: 'result', body: 'c' },
    ],
  };

  // 1. Kill BEFORE tag is persisted (state is still null / initial { nextTag: 2000, cursor: 0 }).
  //    On resume, step 0 runs with CHAOS-M-2000 (never used before).
  {
    const mem = memStore(null);
    const events: AgentEvent[] = [];
    const stdin = lineQueue();
    stdin.end();
    await runAgent({
      script,
      clock: fakeClock(),
      cli: async () => ok('{}'),
      hook: async () => true,
      log: (e) => events.push(e),
      stdinLines: stdin,
      state: mem.store,
      pid: 101,
    });
    const tags = events.filter((e) => e.ev === 'mail_sent').map((e) => e.tag);
    assert.deepEqual(tags, ['CHAOS-M-2000', 'CHAOS-M-2001', 'CHAOS-M-2003']);
    assert.deepEqual(mem.current(), { nextTag: 2004, cursor: 4 });
  }

  // 2. Kill AFTER tag is persisted, BEFORE CLI call returns (step 0 was in flight with 2000;
  //    state file has { nextTag: 2001, cursor: 0 }).
  //    On resume, step 0 re-runs with CHAOS-M-2001 (never reuses 2000), and all 4 steps complete.
  {
    const mem = memStore({ nextTag: 2001, cursor: 0 });
    const events: AgentEvent[] = [];
    const calls: string[][] = [];
    const stdin = lineQueue();
    stdin.end();
    await runAgent({
      script,
      clock: fakeClock(),
      cli: async (args) => {
        calls.push(args);
        return ok('{}');
      },
      hook: async () => true,
      log: (e) => events.push(e),
      stdinLines: stdin,
      state: mem.store,
      pid: 102,
    });
    assert.equal(events[0].ev, 'start');
    const mailTags = events.filter((e) => e.ev === 'mail_sent').map((e) => e.tag);
    assert.deepEqual(mailTags, ['CHAOS-M-2001', 'CHAOS-M-2002', 'CHAOS-M-2004']);
    const askTags = events.filter((e) => e.ev === 'ask_sent').map((e) => e.askTag);
    assert.deepEqual(askTags, ['CHAOS-Q-2003']);
    assert.equal(calls.length, 4);
    assert.deepEqual(mem.current(), { nextTag: 2005, cursor: 4 });
  }

  // 3. Kill AFTER step 0 completes (state file has { nextTag: 2001, cursor: 1 }).
  //    On resume, step 0 is NOT re-run; continues at step 1 with CHAOS-M-2001.
  {
    const mem = memStore({ nextTag: 2001, cursor: 1 });
    const events: AgentEvent[] = [];
    const calls: string[][] = [];
    const stdin = lineQueue();
    stdin.end();
    await runAgent({
      script,
      clock: fakeClock(),
      cli: async (args) => {
        calls.push(args);
        return ok('{}');
      },
      hook: async () => true,
      log: (e) => events.push(e),
      stdinLines: stdin,
      state: mem.store,
      pid: 103,
    });
    const mailTags = events.filter((e) => e.ev === 'mail_sent').map((e) => e.tag);
    assert.deepEqual(mailTags, ['CHAOS-M-2001', 'CHAOS-M-2003']);
    const askTags = events.filter((e) => e.ev === 'ask_sent').map((e) => e.askTag);
    assert.deepEqual(askTags, ['CHAOS-Q-2002']);
    assert.equal(calls.length, 3);
    assert.deepEqual(mem.current(), { nextTag: 2004, cursor: 4 });
  }

  // 4. Verify persistence order during a single run: nextTag is persisted BEFORE cli() is called,
  //    and cursor is persisted AFTER the step completes.
  {
    const mem = memStore(null);
    const snapshotsAtCli: (AgentState | null)[] = [];
    const stdin = lineQueue();
    stdin.end();
    await runAgent({
      script: { role: 'child1', readMailOnNudge: false, answerRoutedQuestions: false, steps: [script.steps[0]] },
      clock: fakeClock(),
      cli: async () => {
        snapshotsAtCli.push(mem.current());
        return ok('{}');
      },
      hook: async () => true,
      log: () => undefined,
      stdinLines: stdin,
      state: mem.store,
      pid: 104,
    });
    assert.deepEqual(snapshotsAtCli, [{ nextTag: 2001, cursor: 0 }]);
    assert.deepEqual(mem.saved, [
      { nextTag: 2001, cursor: 0 },
      { nextTag: 2001, cursor: 1 },
    ]);
  }
});

test('resume during sleep re-runs the sleep in full', async () => {
  let slept = 0;
  const clock: Clock = {
    now: () => slept,
    sleep: async (ms) => {
      slept += ms;
    },
  };
  const mem = memStore({ nextTag: 2000, cursor: 0 });
  const stdin = lineQueue();
  stdin.end();
  await runAgent({
    script: {
      role: 'child1',
      readMailOnNudge: false,
      answerRoutedQuestions: false,
      steps: [{ do: 'sleep', ms: 500 }, { do: 'hook', event: 'Stop' }],
    },
    clock,
    cli: async () => ok('{}'),
    hook: async () => true,
    log: () => undefined,
    stdinLines: stdin,
    state: mem.store,
    pid: 105,
  });
  assert.equal(slept, 500);
  assert.deepEqual(mem.current(), { nextTag: 2000, cursor: 2 });
});

test('corrupt state logs cli_error, writes stderr, and exits non-zero without running steps', async () => {
  const events: AgentEvent[] = [];
  const stderrOut: string[] = [];
  const exits: number[] = [];
  const calls: string[][] = [];
  const stdin = lineQueue();
  stdin.end();
  const res = await runAgent({
    script: {
      role: 'child2',
      readMailOnNudge: false,
      answerRoutedQuestions: false,
      steps: [{ do: 'mail_send', to: 'parent', type: 'message', body: 'should-not-run' }],
    },
    clock: fakeClock(),
    cli: async (args) => {
      calls.push(args);
      return ok('{}');
    },
    hook: async () => true,
    log: (e) => events.push(e),
    stdinLines: stdin,
    state: {
      load: () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
      save: () => undefined,
    },
    stderr: (m) => stderrOut.push(m),
    exit: (c) => exits.push(c),
    pid: 106,
  });
  assert.equal(res.exitCode, 1);
  assert.deepEqual(exits, [1]);
  assert.equal(calls.length, 0);
  assert.deepEqual(events, [
    { ev: 'start', pid: 106 },
    { ev: 'cli_error', cmd: 'state', error: 'corrupt state file' },
  ]);
  assert.ok(stderrOut.join('').includes('corrupt state file'));
});
