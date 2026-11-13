import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAskUserQuestionHookOutput,
  runAskHook,
  runningUnderGrokHook,
  type AskHookDeps,
  type AskHookResponse,
} from './ask-question-hook.js';

const toolInput = {
  questions: [
    { question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: 'x' }, { label: 'SQLite' }] },
    { question: 'Features?', header: 'F', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
  ],
  metadata: { source: 'test' },
};

describe('buildAskUserQuestionHookOutput', () => {
  it('maps single, multi-select and keeps other fields', () => {
    const out = buildAskUserQuestionHookOutput(toolInput, [{ selected: [1] }, { selected: [0, 2] }]);
    assert.deepEqual(out, {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...toolInput, answers: { 'Which DB?': 'SQLite', 'Features?': 'A, C' } },
      },
    });
  });

  it('uses free text alone and combined with labels', () => {
    const out = buildAskUserQuestionHookOutput(toolInput, [{ selected: [], text: 'MySQL' }, { selected: [1], text: 'plus D' }]);
    assert.deepEqual(out?.hookSpecificOutput.updatedInput.answers, { 'Which DB?': 'MySQL', 'Features?': 'B, plus D' });
  });

  it('preserves original strings exactly, including control characters', () => {
    const input = { questions: [{ question: 'Q\u0007 "x"\n\t', options: [{ label: 'La\u001bbel,  ' }] }] };
    const out = buildAskUserQuestionHookOutput(input, [{ selected: [0] }]);
    assert.deepEqual(out?.hookSpecificOutput.updatedInput.answers, { 'Q\u0007 "x"\n\t': 'La\u001bbel,  ' });
  });

  it('returns undefined on length mismatch, bad index or missing questions', () => {
    assert.equal(buildAskUserQuestionHookOutput(toolInput, [{ selected: [0] }]), undefined);
    assert.equal(buildAskUserQuestionHookOutput(toolInput, [{ selected: [5] }, { selected: [] }]), undefined);
    assert.equal(buildAskUserQuestionHookOutput({}, []), undefined);
  });
});

interface Harness {
  deps: AskHookDeps;
  stdout: string[];
  stderr: string[];
  calls: Array<{ method: string; path: string; body?: unknown }>;
  clock: { t: number };
}

type Handler = (method: string, path: string, body: unknown, call: number) => AskHookResponse | Error;

function makeHarness(handler: Handler, opts: { env?: Record<string, string | undefined>; stdin?: unknown; deadlineMs?: number; signal?: AbortSignal } = {}): Harness {
  const clock = { t: 1_000_000 };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: Harness['calls'] = [];
  const stdin = opts.stdin ?? { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', tool_input: toolInput };
  const deps: AskHookDeps = {
    readStdin: async () => (typeof stdin === 'string' ? stdin : JSON.stringify(stdin)),
    env: opts.env ?? { FTOWN_SESSION_ID: 'sess-1' },
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      const result = handler(method, path, body, calls.length);
      if (result instanceof Error) throw result;
      return result;
    },
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    writeStdout: (text) => { stdout.push(text); },
    writeStderr: (text) => { stderr.push(text); },
    deadlineMs: opts.deadlineMs,
    signal: opts.signal,
  };
  return { deps, stdout, stderr, calls, clock };
}

const capable: AskHookResponse = { status: 200, body: { capabilities: { attention: { version: 1, request: true, prompt: true } } } };
const asked: AskHookResponse = { status: 200, body: { event: { id: 'att-1' } } };
const pending: AskHookResponse = { status: 200, body: { event: { id: 'att-1' } } };

function standard(itemResponse: (call: number) => AskHookResponse | Error): Handler {
  return (method, path, _body, call) => {
    if (method === 'GET' && path === '/api/sessions/sess-1') return capable;
    if (method === 'POST') return asked;
    return itemResponse(call);
  };
}

describe('runningUnderGrokHook', () => {
  it('requires a non-empty GROK_HOOK_EVENT and a Grok-shaped payload', () => {
    const stop = { GROK_HOOK_EVENT: 'stop' };
    for (const payload of [{ hookEventName: 'stop' }, {}, null, undefined]) {
      assert.equal(runningUnderGrokHook(payload, {}), false);
      assert.equal(runningUnderGrokHook(payload, { GROK_HOOK_EVENT: undefined }), false);
    }
    assert.equal(runningUnderGrokHook({ hookEventName: 'stop' }, stop), true);
    assert.equal(runningUnderGrokHook({ hookEventName: 'stop', hook_event_name: 'Stop' }, stop), true);
    assert.equal(runningUnderGrokHook({ hook_event_name: 'Stop' }, stop), false);
    for (const payload of [null, 'x', [], { hookEventName: '' }, { hookEventName: 5 }]) {
      assert.equal(runningUnderGrokHook(payload, stop), false, JSON.stringify(payload));
    }
    assert.equal(runningUnderGrokHook({ hookEventName: 'stop' }, { GROK_HOOK_EVENT: '' }), false);
  });
});

describe('runAskHook', () => {
  const answered = (): AskHookResponse => ({
    status: 200,
    body: { event: { id: 'att-1', resolution: 'answered', answer: { answers: [{ selected: [0] }, { selected: [1] }] } } },
  });

  const grokEnv = { FTOWN_SESSION_ID: 'sess-1', GROK_HOOK_EVENT: 'pre_tool_use' };
  const countReads = (h: Harness): { reads: number } => {
    const counter = { reads: 0 };
    const read = h.deps.readStdin;
    h.deps.readStdin = async () => { counter.reads += 1; return read(); };
    return counter;
  };

  it('stands down for a Grok-shaped payload: reads stdin once, no bridge call, no output', async () => {
    const h = makeHarness(standard(answered), {
      env: grokEnv,
      stdin: { hookEventName: 'pre_tool_use', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', tool_input: toolInput },
    });
    const counter = countReads(h);
    assert.equal(await runAskHook(h.deps), 0);
    assert.equal(counter.reads, 1);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.stdout, []);
    assert.deepEqual(h.stderr, []);
  });

  it('proceeds as today for a Claude-shaped payload when GROK_HOOK_EVENT is inherited', async () => {
    const h = makeHarness(standard(answered), { env: grokEnv });
    const counter = countReads(h);
    assert.equal(await runAskHook(h.deps), 0);
    assert.equal(counter.reads, 1);
    assert.ok(h.calls.length >= 3);
    assert.equal(h.stdout.length, 1);
    assert.deepEqual(h.stderr, []);
  });

  it('treats a stdin read failure under GROK_HOOK_EVENT as not Grok (same outcome as today)', async () => {
    const h = makeHarness(() => capable, { env: grokEnv });
    let reads = 0;
    h.deps.readStdin = async () => { reads += 1; throw new Error('EPIPE'); };
    assert.equal(await runAskHook(h.deps), 0);
    assert.equal(reads, 1);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.stdout, []);
    assert.deepEqual(h.stderr, ['ftown ask-hook: EPIPE\n']);
  });

  it('treats unparseable stdin under GROK_HOOK_EVENT as not Grok (same outcome as today)', async () => {
    const h = makeHarness(() => capable, { env: grokEnv, stdin: 'not json' });
    assert.equal(await runAskHook(h.deps), 0);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.stdout, []);
    assert.equal(h.stderr.length, 1);
  });

  it('treats an empty GROK_HOOK_EVENT as not under Grok', async () => {
    const h = makeHarness(standard(answered), { env: { FTOWN_SESSION_ID: 'sess-1', GROK_HOOK_EVENT: '' } });
    assert.equal(await runAskHook(h.deps), 0);
    assert.ok(h.calls.length >= 3);
    assert.equal(h.stdout.length, 1);
  });

  it('exits quietly without session env and does not call the bridge', async () => {
    for (const env of [{}, { FTOWN_SESSION_ID: '' }, { FTOWN_SESSION_ID: '../x' }]) {
      const h = makeHarness(() => capable, { env });
      assert.equal(await runAskHook(h.deps), 0);
      assert.equal(h.calls.length, 0);
      assert.deepEqual(h.stdout, []);
      assert.deepEqual(h.stderr, []);
    }
  });

  it('exits quietly for other tools, bad input and unparsable stdin', async () => {
    for (const stdin of [
      { tool_name: 'Bash', tool_use_id: 't', tool_input: {} },
      { tool_name: 'AskUserQuestion', tool_input: {} },
      { tool_name: 'AskUserQuestion', tool_use_id: 't', tool_input: 'x' },
    ]) {
      const h = makeHarness(() => capable, { stdin });
      assert.equal(await runAskHook(h.deps), 0);
      assert.equal(h.calls.length, 0);
      assert.deepEqual(h.stdout, []);
    }
    const bad = makeHarness(() => capable, { stdin: 'not json' });
    assert.equal(await runAskHook(bad.deps), 0);
    assert.deepEqual(bad.stdout, []);
    assert.equal(bad.stderr.length, 1);
  });

  it('exits quietly on an old bridge without prompt capability', async () => {
    const h = makeHarness(() => ({ status: 200, body: { capabilities: { attention: { version: 1, request: true } } } }));
    assert.equal(await runAskHook(h.deps), 0);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.stdout, []);
  });

  it('exits quietly when the bridge returns a null event', async () => {
    const h = makeHarness((method, path) => (method === 'GET' && path === '/api/sessions/sess-1' ? capable : { status: 200, body: { event: null } }));
    assert.equal(await runAskHook(h.deps), 0);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[1], { method: 'POST', path: '/api/sessions/sess-1/attention/ask', body: { toolName: 'AskUserQuestion', toolUseId: 'toolu_1', toolInput } });
    assert.deepEqual(h.stdout, []);
  });

  it('prints the hook output once the item is answered', async () => {
    const h = makeHarness(standard((call) => (call < 5
      ? pending
      : { status: 200, body: { event: { id: 'att-1', resolution: 'answered', answer: { answeredAt: 'x', answers: [{ selected: [0] }, { selected: [1, 2] }] } } } })));
    assert.equal(await runAskHook(h.deps), 0);
    assert.equal(h.stdout.length, 1);
    assert.deepEqual(JSON.parse(h.stdout[0]!), buildAskUserQuestionHookOutput(toolInput, [{ selected: [0] }, { selected: [1, 2] }]));
    assert.equal(h.calls[2]?.path, '/api/sessions/sess-1/attention/att-1?waitSeconds=25');
  });

  it('prints nothing when answered output cannot be built', async () => {
    const h = makeHarness(standard(() => ({ status: 200, body: { event: { id: 'att-1', resolution: 'answered', answer: { answeredAt: 'x', answers: [{ selected: [0] }] } } } })));
    assert.equal(await runAskHook(h.deps), 0);
    assert.deepEqual(h.stdout, []);
  });

  it('prints nothing when dismissed or otherwise resolved', async () => {
    for (const resolution of ['manual', 'user_prompt', 'session_end', 'tool_complete']) {
      const h = makeHarness(standard(() => ({ status: 200, body: { event: { id: 'att-1', resolution, resolvedAt: 'x' } } })));
      assert.equal(await runAskHook(h.deps), 0);
      assert.deepEqual(h.stdout, []);
    }
  });

  it('prints nothing when the item disappears (404)', async () => {
    const h = makeHarness(standard(() => ({ status: 404, body: { error: 'x', code: 'attention_not_found' } })));
    assert.equal(await runAskHook(h.deps), 0);
    assert.deepEqual(h.stdout, []);
  });

  it('stops polling at the deadline without output', async () => {
    const h = makeHarness(standard(() => { return pending; }), { deadlineMs: 100_000 });
    h.deps.request = ((orig) => async (method, path, body, signal) => {
      const result = await orig(method, path, body, signal);
      if (path.includes('waitSeconds')) h.clock.t += 25_000;
      return result;
    })(h.deps.request);
    assert.equal(await runAskHook(h.deps), 0);
    assert.deepEqual(h.stdout, []);
    assert.ok(h.clock.t - 1_000_000 >= 100_000);
    assert.ok(h.calls.length < 12);
  });

  it('retries transient failures and then succeeds', async () => {
    const h = makeHarness(standard((call) => {
      if (call === 3) return new Error('ECONNRESET');
      if (call === 4) return { status: 503, body: {} };
      return { status: 200, body: { event: { id: 'att-1', resolution: 'answered', answer: { answeredAt: 'x', answers: [{ selected: [0] }, { selected: [0] }] } } } };
    }));
    assert.equal(await runAskHook(h.deps), 0);
    assert.equal(h.stdout.length, 1);
    assert.equal(h.clock.t - 1_000_000, 4_000);
  });

  it('gives up after 60 s without a successful response', async () => {
    const h = makeHarness(standard(() => new Error('ECONNREFUSED')));
    assert.equal(await runAskHook(h.deps), 0);
    assert.deepEqual(h.stdout, []);
    assert.ok(h.clock.t - 1_000_000 > 60_000 && h.clock.t - 1_000_000 <= 64_000);
  });

  it('exits quietly when aborted', async () => {
    const controller = new AbortController();
    const h = makeHarness(standard(() => { controller.abort(); return new Error('aborted'); }), { signal: controller.signal });
    assert.equal(await runAskHook(h.deps), 0);
    assert.deepEqual(h.stdout, []);
    assert.deepEqual(h.stderr, []);
  });

  it('exits quietly when the session GET is non-2xx or throws', async () => {
    for (const result of [{ status: 500, body: {} }, new Error('boom')]) {
      const h = makeHarness(() => result);
      assert.equal(await runAskHook(h.deps), 0);
      assert.deepEqual(h.stdout, []);
      assert.equal(h.calls.length, 1);
    }
  });

  it('does not retry a non-2xx ask POST', async () => {
    const h = makeHarness((method) => (method === 'POST' ? { status: 400, body: { error: 'x' } } : capable));
    assert.equal(await runAskHook(h.deps), 0);
    assert.deepEqual(h.stdout, []);
    assert.equal(h.calls.filter((c) => c.method === 'POST').length, 1);
  });

  it('retries the ask POST once after a throw and then succeeds', async () => {
    let posts = 0;
    const h = makeHarness((method, path) => {
      if (method === 'GET' && path === '/api/sessions/sess-1') return capable;
      if (method === 'POST') { posts += 1; return posts === 1 ? new Error('timeout') : asked; }
      return { status: 200, body: { event: { id: 'att-1', resolution: 'answered', answer: { answeredAt: 'x', answers: [{ selected: [0] }, { selected: [0] }] } } } };
    });
    assert.equal(await runAskHook(h.deps), 0);
    assert.equal(posts, 2);
    assert.equal(h.stdout.length, 1);
  });

  it('exits quietly when the ask POST throws twice', async () => {
    const h = makeHarness((method, path) => (method === 'GET' && path === '/api/sessions/sess-1' ? capable : new Error('down')));
    assert.equal(await runAskHook(h.deps), 0);
    assert.deepEqual(h.stdout, []);
    assert.equal(h.calls.filter((c) => c.method === 'POST').length, 2);
  });

  it('retries repeated 500s on the item GET until the 60 s outage exit', async () => {
    const h = makeHarness(standard(() => ({ status: 500, body: {} })));
    assert.equal(await runAskHook(h.deps), 0);
    assert.deepEqual(h.stdout, []);
    assert.ok(h.clock.t - 1_000_000 > 60_000 && h.clock.t - 1_000_000 <= 64_000);
  });
});
