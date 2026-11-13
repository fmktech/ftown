import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fetchGrokQuota,
  fetchGrokQuotaWith,
  isOwnGrokProcess,
  parseGrokBillingLog,
  handleInterrupt,
  refreshGrokBilling,
  signalSafely,
  stopGrokProcesses,
  type GrokRefreshContext,
  type GrokRefreshState,
  type GrokSys,
} from './grok.js';

const BILLING_MESSAGE = 'billing: fetched credits config';
const NOW = new Date('2026-11-10T00:00:00.000Z');
const OLD_TS = '2026-11-09T10:08:58.931Z';
const PERIOD_START = '2026-11-06T14:47:24.201+00:00';
const PERIOD_END = '2026-11-13T14:47:24.201+00:00';
const RESETS_AT = '2026-11-13T14:47:24.201Z';

const NO_DATA = "no billing data in grok's log yet: open grok and run /usage";
const PERIOD_ENDED =
  "grok's last recorded billing period has ended: open grok and run /usage to refresh";
const ZERO_PERCENT = 'grok omitted the usage figure, which it does at 0% used';
const NOT_FOUND = 'grok log not found (is grok installed?)';

interface BillingFixture {
  ts?: string;
  creditUsagePercent?: number;
  start?: string;
  end?: string;
  tier?: string | null;
}

/** Builds one unified.jsonl line with the same nesting grok writes. */
function billingLine(fixture: BillingFixture = {}): string {
  const config: Record<string, unknown> = {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: fixture.start ?? PERIOD_START,
      end: fixture.end ?? PERIOD_END,
    },
    prepaidBalance: { val: 0 },
    isUnifiedBillingUser: false,
    historyLen: 3,
  };
  if (fixture.creditUsagePercent !== undefined) {
    config.creditUsagePercent = fixture.creditUsagePercent;
  }
  return JSON.stringify({
    ts: fixture.ts ?? OLD_TS,
    src: 'shell',
    pid: 4242,
    ver: '1.0.77',
    lvl: 'info',
    msg: BILLING_MESSAGE,
    ctx: { config, subscriptionTier: fixture.tier === undefined ? 'SuperGrok' : fixture.tier },
  });
}

function unrelatedLine(): string {
  return JSON.stringify({ ts: '2026-11-09T10:00:00.000Z', lvl: 'info', msg: 'session started', ctx: {} });
}

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'grok-quota-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('parseGrokBillingLog', () => {
  it('reports the weekly window with usage percent when present', () => {
    const quota = parseGrokBillingLog(billingLine({ creditUsagePercent: 57 }), NOW);

    assert.deepEqual(quota, {
      provider: 'grok',
      status: 'ok',
      plan: 'SuperGrok',
      windows: [{ kind: 'weekly', usedPercent: 57, resetsAt: RESETS_AT, windowMinutes: 10080, note: null }],
      source: 'cached',
      observedAt: OLD_TS,
      message: null,
    });
  });

  it('treats an absent creditUsagePercent as 0 with the explanatory message', () => {
    const quota = parseGrokBillingLog(billingLine(), NOW);

    assert.equal(quota.status, 'ok');
    assert.equal(quota.message, ZERO_PERCENT);
    assert.equal(quota.windows.length, 1);
    assert.equal(quota.windows[0].kind, 'weekly');
    assert.equal(quota.windows[0].usedPercent, 0);
    assert.equal(quota.windows[0].resetsAt, RESETS_AT);
    assert.equal(quota.windows[0].note, null);
  });

  it('keeps creditUsagePercent of 0 as 0 with no message', () => {
    const quota = parseGrokBillingLog(billingLine({ creditUsagePercent: 0 }), NOW);

    assert.equal(quota.status, 'ok');
    assert.equal(quota.windows[0].usedPercent, 0);
    assert.equal(quota.windows[0].note, null);
    assert.equal(quota.message, null);
  });

  it('does not look back: an absent last figure is 0 even when older entries had a number', () => {
    const tail = [
      billingLine({ ts: '2026-11-09T09:00:00.000Z', creditUsagePercent: 25 }),
      billingLine({ ts: '2026-11-09T11:00:00.000Z' }),
    ].join('\n');
    const quota = parseGrokBillingLog(tail, NOW);

    assert.equal(quota.windows[0].usedPercent, 0);
    assert.equal(quota.message, ZERO_PERCENT);
    assert.equal(quota.observedAt, '2026-11-09T11:00:00.000Z');
  });

  it('is unavailable with no windows once the recorded period has ended', () => {
    const quota = parseGrokBillingLog(
      billingLine({ creditUsagePercent: 90, end: '2026-11-09T00:00:00.000+00:00' }),
      NOW,
    );

    assert.equal(quota.status, 'unavailable');
    assert.deepEqual(quota.windows, []);
    assert.equal(quota.message, PERIOD_ENDED);
    assert.equal(quota.observedAt, OLD_TS);
  });

  it('is unavailable with now as observedAt when the log has no billing entries', () => {
    const tail = [unrelatedLine(), 'not json at all', '{"msg":"' + BILLING_MESSAGE + '"}'].join('\n');
    const quota = parseGrokBillingLog(tail, NOW);

    assert.equal(quota.provider, 'grok');
    assert.equal(quota.status, 'unavailable');
    assert.equal(quota.plan, null);
    assert.deepEqual(quota.windows, []);
    assert.equal(quota.source, 'cached');
    assert.equal(quota.observedAt, NOW.toISOString());
    assert.equal(quota.message, NO_DATA);
  });

  it('uses the last billing entry when several are present', () => {
    const tail = [
      billingLine({ ts: '2026-11-08T08:00:00.000Z', creditUsagePercent: 10 }),
      unrelatedLine(),
      billingLine({ ts: '2026-11-09T09:00:00.000Z', creditUsagePercent: 25 }),
      billingLine({ ts: '2026-11-09T11:00:00.000Z', creditUsagePercent: 80, tier: null }),
    ].join('\n');
    const quota = parseGrokBillingLog(tail, NOW);

    assert.equal(quota.windows[0].usedPercent, 80);
    assert.equal(quota.observedAt, '2026-11-09T11:00:00.000Z');
    assert.equal(quota.plan, null);
  });

  it('ignores a truncated first line and garbage lines', () => {
    const truncated = billingLine({ creditUsagePercent: 5, ts: '2026-11-01T00:00:00.000Z' }).slice(40);
    const tail = [truncated, 'garbage {{{', billingLine({ creditUsagePercent: 33 }), '', 'trailing garbage'].join('\n');
    const quota = parseGrokBillingLog(tail, NOW);

    assert.equal(quota.status, 'ok');
    assert.equal(quota.windows[0].usedPercent, 33);
  });

  it('skips non-object JSON lines and a billing entry with a null ctx without throwing', () => {
    const tail = [
      '5',
      'null',
      '[1,2]',
      '"str"',
      JSON.stringify({ msg: BILLING_MESSAGE, ctx: null, ts: '2026-11-09T12:00:00.000Z' }),
      billingLine({ creditUsagePercent: 7 }),
    ].join('\n');
    const quota = parseGrokBillingLog(tail, NOW);

    assert.equal(quota.status, 'ok');
    assert.equal(quota.windows[0].usedPercent, 7);
  });

  it('skips a billing entry whose currentPeriod is missing', () => {
    const malformed = JSON.stringify({
      ts: '2026-11-09T12:00:00.000Z',
      msg: BILLING_MESSAGE,
      ctx: { config: { creditUsagePercent: 99 }, subscriptionTier: 'SuperGrok' },
    });
    const quota = parseGrokBillingLog([billingLine({ creditUsagePercent: 12 }), malformed].join('\n'), NOW);

    assert.equal(quota.windows[0].usedPercent, 12);
  });

  it('reports windowMinutes 10080 for a 7-day period and null when the start is unusable', () => {
    const weekly = parseGrokBillingLog(billingLine({ creditUsagePercent: 1 }), NOW);
    assert.equal(weekly.windows[0].windowMinutes, 10080);

    const badStart = parseGrokBillingLog(billingLine({ creditUsagePercent: 1, start: 'not a date' }), NOW);
    assert.equal(badStart.windows[0].windowMinutes, null);
    assert.equal(badStart.windows[0].resetsAt, RESETS_AT);
  });
});

describe('fetchGrokQuotaWith', () => {
  const options = (homeDir: string, timeoutMs = 15000) => ({ timeoutMs, now: () => NOW, homeDir });
  const logPath = (home: string) => join(home, '.grok', 'logs', 'unified.jsonl');

  async function makeHome(name: string, body: string | null): Promise<string> {
    const home = join(root, name);
    await mkdir(join(home, '.grok', 'logs'), { recursive: true });
    if (body !== null) {
      await writeFile(logPath(home), body);
    }
    return home;
  }

  function fakeRefresh(onRefresh: (ctx: GrokRefreshContext) => Promise<void>) {
    const calls: GrokRefreshContext[] = [];
    const refresh = async (ctx: GrokRefreshContext): Promise<void> => {
      calls.push(ctx);
      await onRefresh(ctx);
    };
    return { calls, refresh };
  }

  const noop = async (): Promise<void> => undefined;

  it('uses a fresh entry appended by the refresh and labels the result live', async () => {
    const home = await makeHome('refresh-appends', unrelatedLine() + '\n' + billingLine({ creditUsagePercent: 33 }) + '\n');
    const fresh = billingLine({ ts: '2026-11-09T23:59:50.000Z', creditUsagePercent: 61 });
    const { calls, refresh } = fakeRefresh(() => appendFile(logPath(home), fresh + '\n'));

    const quota = await fetchGrokQuotaWith(options(home), { refresh, shouldRefresh: true });

    assert.equal(calls.length, 1);
    assert.equal(quota.status, 'ok');
    assert.equal(quota.windows[0].usedPercent, 61);
    assert.equal(quota.source, 'live');
    assert.equal(quota.observedAt, '2026-11-09T23:59:50.000Z');
  });

  it('keeps the cached entry and labels it cached when the refresh does nothing', async () => {
    const home = await makeHome('refresh-noop', billingLine({ creditUsagePercent: 33 }) + '\n');
    const { calls, refresh } = fakeRefresh(noop);

    const quota = await fetchGrokQuotaWith(options(home), { refresh, shouldRefresh: true });

    assert.equal(calls.length, 1);
    assert.equal(quota.windows[0].usedPercent, 33);
    assert.equal(quota.source, 'cached');
    assert.equal(quota.observedAt, OLD_TS);
  });

  it('passes the newest billing ts as previousTs, or null when the log has none', async () => {
    const withBilling = await makeHome('prev-ts', unrelatedLine() + '\n' + billingLine({ creditUsagePercent: 2 }) + '\n');
    const first = fakeRefresh(noop);
    await fetchGrokQuotaWith(options(withBilling), { refresh: first.refresh, shouldRefresh: true });
    assert.equal(first.calls[0].previousTs, OLD_TS);
    assert.equal(first.calls[0].budgetMs, 11500);

    const withoutBilling = await makeHome('prev-ts-none', unrelatedLine() + '\n');
    const second = fakeRefresh(noop);
    await fetchGrokQuotaWith(options(withoutBilling), { refresh: second.refresh, shouldRefresh: true });
    assert.equal(second.calls[0].previousTs, null);
  });

  it('skips the refresh when the newest entry is younger than 60 s and labels it live', async () => {
    const home = await makeHome(
      'fresh-entry',
      billingLine({ ts: '2026-11-09T23:59:30.000Z', creditUsagePercent: 12 }) + '\n',
    );
    const { calls, refresh } = fakeRefresh(noop);

    const quota = await fetchGrokQuotaWith(options(home), { refresh, shouldRefresh: true });

    assert.equal(calls.length, 0);
    assert.equal(quota.windows[0].usedPercent, 12);
    assert.equal(quota.source, 'live');
  });

  it('does not call the refresh when shouldRefresh is false', async () => {
    const home = await makeHome('disabled', billingLine({ creditUsagePercent: 5 }) + '\n');
    const { calls, refresh } = fakeRefresh(noop);

    const quota = await fetchGrokQuotaWith(options(home), { refresh, shouldRefresh: false });

    assert.equal(calls.length, 0);
    assert.equal(quota.source, 'cached');
    assert.equal(quota.windows[0].usedPercent, 5);
  });

  it('does not refresh when the budget would be under 2 s', async () => {
    const home = await makeHome('small-budget', billingLine({ creditUsagePercent: 5 }) + '\n');
    const { calls, refresh } = fakeRefresh(noop);

    await fetchGrokQuotaWith(options(home, 3000), { refresh, shouldRefresh: true });

    assert.equal(calls.length, 0);
  });

  it('still returns the cached result when the refresh rejects', async () => {
    const home = await makeHome('refresh-rejects', billingLine({ creditUsagePercent: 44 }) + '\n');
    const { refresh } = fakeRefresh(async () => {
      throw new Error('boom');
    });

    const quota = await fetchGrokQuotaWith(options(home), { refresh, shouldRefresh: true });

    assert.equal(quota.status, 'ok');
    assert.equal(quota.windows[0].usedPercent, 44);
    assert.equal(quota.source, 'cached');
  });

  it('attempts the refresh when the log is missing and uses the file it creates', async () => {
    const home = await makeHome('missing-created', null);
    const fresh = billingLine({ ts: '2026-11-09T23:59:55.000Z', creditUsagePercent: 9 });
    const { calls, refresh } = fakeRefresh(() => writeFile(logPath(home), fresh + '\n'));

    const quota = await fetchGrokQuotaWith(options(home), { refresh, shouldRefresh: true });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].previousTs, null);
    assert.equal(quota.status, 'ok');
    assert.equal(quota.windows[0].usedPercent, 9);
    assert.equal(quota.source, 'live');
  });

  it('is unavailable when the log is still missing after the refresh', async () => {
    const home = await makeHome('missing-still', null);
    const { calls, refresh } = fakeRefresh(noop);

    const quota = await fetchGrokQuotaWith(options(home), { refresh, shouldRefresh: true });

    assert.equal(calls.length, 1);
    assert.equal(quota.status, 'unavailable');
    assert.deepEqual(quota.windows, []);
    assert.equal(quota.message, NOT_FOUND);
    assert.equal(quota.observedAt, NOW.toISOString());
  });

  it('is error with a short reason on an I/O failure', async () => {
    const home = join(root, 'io-error');
    await mkdir(logPath(home), { recursive: true });
    const { calls, refresh } = fakeRefresh(noop);

    const quota = await fetchGrokQuotaWith(options(home), { refresh, shouldRefresh: false });

    assert.equal(quota.status, 'error');
    assert.deepEqual(quota.windows, []);
    assert.match(quota.message ?? '', /^grok log read failed \(/);
    assert.ok(!(quota.message ?? '').includes(root));
    assert.equal(calls.length, 0);
  });
});

describe('isOwnGrokProcess', () => {
  const scratch = '/var/folders/x/T/ftown-quota-grok-abc123';

  it('is true when the command line contains the exact scratch dir', () => {
    assert.equal(isOwnGrokProcess(`/Users/u/.grok/bin/grok --cwd ${scratch}\n`, scratch), true);
  });

  it('is false for a different path that only starts with the scratch dir', () => {
    assert.equal(isOwnGrokProcess(`/Users/u/.grok/bin/grok --cwd ${scratch}d`, scratch), false);
  });

  it('is false for empty ps output and for an unrelated command', () => {
    assert.equal(isOwnGrokProcess('', scratch), false);
    assert.equal(isOwnGrokProcess('/Users/u/.grok/bin/grok --cwd /tmp/other', scratch), false);
  });

  it('is false for an empty scratch dir', () => {
    assert.equal(isOwnGrokProcess('/Users/u/.grok/bin/grok --cwd ', ''), false);
  });

  it('accepts a left boundary of whitespace or "=" and a right boundary of "/"', () => {
    assert.equal(isOwnGrokProcess(`grok --cwd=${scratch}`, scratch), true);
    assert.equal(isOwnGrokProcess(`grok --cwd ${scratch}/sub`, scratch), true);
  });

  it('is false when the scratch path is preceded by another character', () => {
    assert.equal(isOwnGrokProcess(`grok /opt${scratch}`, scratch), false);
  });
});

interface FakeSysOptions {
  scriptPid?: number | undefined;
  scriptExited?: boolean;
  /** Pids returned by listChildren. */
  listed?: number[];
  /** ps command line per pid; an Error value makes commandOf reject. */
  commands?: Record<number, string | Error>;
  /** Pids that stop existing when they receive SIGTERM. */
  dieOnTerm?: number[];
  /** Pids that exist before any signal. */
  alive?: number[];
  /** Return a command line naming the spawned scratch dir for every pid. */
  commandForAll?: boolean;
}

interface KillCall {
  pid: number;
  signal: NodeJS.Signals | 0;
  group: boolean;
}

function fakeSys(options: FakeSysOptions) {
  const kills: KillCall[] = [];
  const commandCalls: number[] = [];
  const sleeps: number[] = [];
  const alive = new Set(options.alive ?? []);
  let scratchSeen = '';
  const tuiState = { exited: options.scriptExited ?? false };
  const sys: GrokSys = {
    spawnTui: (_grokBinary, scratchDir) => {
      scratchSeen = scratchDir;
      return { pid: options.scriptPid, hasExited: () => tuiState.exited };
    },
    listChildren: async () => options.listed ?? [],
    commandOf: async (pid) => {
      commandCalls.push(pid);
      if (options.commandForAll) {
        return `grok --cwd ${scratchSeen}`;
      }
      const value = options.commands?.[pid];
      if (value === undefined) {
        throw new Error('no such process');
      }
      if (value instanceof Error) {
        throw value;
      }
      return value;
    },
    kill: (pid, signal, group) => {
      kills.push({ pid, signal, group });
      if (signal === 0) {
        return alive.has(pid);
      }
      if (signal === 'SIGTERM' && options.dieOnTerm?.includes(pid)) {
        alive.delete(pid);
      }
      if (signal === 'SIGKILL') {
        alive.delete(pid);
      }
      return true;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  const stateFor = (scratchDir: string): GrokRefreshState => ({
    scratchDir,
    tui: { pid: options.scriptPid, hasExited: () => tuiState.exited },
    children: new Set(options.listed ?? []),
  });
  return { sys, kills, commandCalls, sleeps, stateFor };
}

const SCRATCH = '/var/folders/x/T/ftown-quota-grok-test';

describe('signalSafely', () => {
  it('refuses every pid that is not an integer greater than 1', () => {
    for (const pid of [0, 1, -5, -0, Number.NaN, 2.5]) {
      const { sys, kills } = fakeSys({});
      assert.equal(signalSafely(sys, pid, 'SIGTERM'), false, `pid ${pid}`);
      assert.equal(signalSafely(sys, pid, 0), false, `pid ${pid} with signal 0`);
      assert.equal(signalSafely(sys, pid, 'SIGKILL', true), false, `pid ${pid} group`);
      assert.equal(kills.length, 0, `no kill call for pid ${pid}`);
    }
  });

  it('passes a valid pid through, with the group flag', () => {
    const { sys, kills } = fakeSys({});
    assert.equal(signalSafely(sys, 4242, 'SIGTERM', true), true);
    assert.deepEqual(kills, [{ pid: 4242, signal: 'SIGTERM', group: true }]);
  });
});

describe('stopGrokProcesses', () => {
  it('never signals a script pid that has exited', async () => {
    const { sys, kills, stateFor } = fakeSys({ scriptPid: 4000, scriptExited: true });
    await stopGrokProcesses(sys, stateFor(SCRATCH));
    assert.equal(kills.filter((k) => k.pid === 4000).length, 0);
  });

  it('makes no kill calls at all when the script pid is undefined and no children are recorded', async () => {
    const { sys, kills, stateFor } = fakeSys({ scriptPid: undefined });
    await stopGrokProcesses(sys, stateFor(SCRATCH));
    assert.equal(kills.length, 0);
  });

  it('TERMs the script group while it runs and KILLs it after the wait', async () => {
    const { sys, kills, stateFor } = fakeSys({ scriptPid: 4000 });
    await stopGrokProcesses(sys, stateFor(SCRATCH));
    const signals = kills.filter((k) => k.pid === 4000 && k.signal !== 0);
    assert.deepEqual(signals, [
      { pid: 4000, signal: 'SIGTERM', group: true },
      { pid: 4000, signal: 'SIGKILL', group: true },
    ]);
  });

  it('never signals a recorded child whose command line lacks the scratch dir', async () => {
    const { sys, kills, stateFor } = fakeSys({
      scriptPid: undefined,
      listed: [777],
      commands: { 777: '/bin/sleep 600' },
    });
    await stopGrokProcesses(sys, stateFor(SCRATCH));
    assert.equal(kills.filter((k) => k.pid === 777).length, 0);
  });

  it('sends a verified child SIGTERM then SIGKILL only while it is still alive', async () => {
    const owned = `grok --cwd ${SCRATCH}`;
    const stubborn = fakeSys({ scriptPid: undefined, listed: [777], commands: { 777: owned }, alive: [777] });
    await stopGrokProcesses(stubborn.sys, stubborn.stateFor(SCRATCH));
    assert.deepEqual(
      stubborn.kills.filter((k) => k.pid === 777 && k.signal !== 0),
      [
        { pid: 777, signal: 'SIGTERM', group: false },
        { pid: 777, signal: 'SIGTERM', group: true },
        { pid: 777, signal: 'SIGKILL', group: false },
        { pid: 777, signal: 'SIGKILL', group: true },
      ],
    );

    const polite = fakeSys({
      scriptPid: undefined,
      listed: [777],
      commands: { 777: owned },
      alive: [777],
      dieOnTerm: [777],
    });
    await stopGrokProcesses(polite.sys, polite.stateFor(SCRATCH));
    assert.equal(
      polite.kills.filter((k) => k.pid === 777 && k.signal === 'SIGKILL').length,
      0,
      'no SIGKILL once the child is gone',
    );
  });

  it('gives up on a child whose ps fails twice and sends it no signal', async () => {
    const failing = fakeSys({
      scriptPid: undefined,
      listed: [777],
      commands: { 777: new Error('ps timed out') },
    });
    await stopGrokProcesses(failing.sys, failing.stateFor(SCRATCH));
    assert.equal(failing.commandCalls.filter((pid) => pid === 777).length, 2);
    assert.equal(failing.kills.filter((k) => k.pid === 777).length, 0);
  });
});

describe('refreshGrokBilling with an injected sys', () => {
  it('returns at once when the script has exited and never signals it', async () => {
    const fake = fakeSys({ scriptPid: 4000, scriptExited: true, commandForAll: true });
    await refreshGrokBilling({ homeDir: root, previousTs: null, budgetMs: 11500 }, fake.sys);
    assert.equal(fake.sleeps.length, 1);
    assert.equal(fake.kills.filter((k) => k.pid === 4000).length, 0);
  });

  it('never passes invalid pids from listChildren to kill', async () => {
    const fake = fakeSys({
      scriptPid: 4000,
      listed: [0, 1, -5, Number.NaN],
      commandForAll: true,
    });
    await refreshGrokBilling({ homeDir: root, previousTs: null, budgetMs: 0 }, fake.sys);
    assert.ok(fake.kills.length > 0, 'the script group is still signalled');
    assert.ok(fake.kills.every((k) => k.pid === 4000), 'only the script pid is signalled');
  });

  it('removes its interrupt handlers when it finishes', async () => {
    const before = process.listenerCount('SIGTERM');
    const fake = fakeSys({ scriptPid: 4000, scriptExited: true });
    await refreshGrokBilling({ homeDir: root, previousTs: null, budgetMs: 11500 }, fake.sys);
    assert.equal(process.listenerCount('SIGTERM'), before);
  });
});

describe('handleInterrupt', () => {
  function recorder(listenerCount: number) {
    const calls: string[] = [];
    const deps = {
      emitter: { listenerCount: () => listenerCount },
      cleanup: () => {
        calls.push('cleanup');
      },
      removeHandlers: () => {
        calls.push('remove');
      },
      reraise: (signal: NodeJS.Signals) => {
        calls.push(`reraise:${signal}`);
      },
    };
    return { calls, deps };
  }

  it('re-raises exactly once when no other listener is registered', () => {
    const { calls, deps } = recorder(0);
    handleInterrupt('SIGTERM', deps);
    assert.deepEqual(calls, ['cleanup', 'remove', 'reraise:SIGTERM']);
  });

  it('does not re-raise when another listener already handles the signal', () => {
    const { calls, deps } = recorder(1);
    handleInterrupt('SIGINT', deps);
    assert.deepEqual(calls, ['cleanup', 'remove']);
  });

  it('decides from the real process listener count', () => {
    const calls: string[] = [];
    const common = {
      cleanup: () => {
        calls.push('cleanup');
      },
      removeHandlers: () => {
        calls.push('remove');
      },
      reraise: (signal: NodeJS.Signals) => {
        calls.push(`reraise:${signal}`);
      },
    };
    const baseline = process.listenerCount('SIGUSR2');
    const other = (): void => undefined;
    process.on('SIGUSR2', other);
    handleInterrupt('SIGUSR2', { ...common, emitter: process });
    process.removeListener('SIGUSR2', other);
    assert.deepEqual(calls, ['cleanup', 'remove'], 'another listener present: no re-raise');

    calls.length = 0;
    handleInterrupt('SIGUSR2', { ...common, emitter: process });
    const expected = baseline === 0 ? ['cleanup', 'remove', 'reraise:SIGUSR2'] : ['cleanup', 'remove'];
    assert.deepEqual(calls, expected, 're-raise follows the real listener count');
  });
});

describe('fetchGrokQuotaWith with a throwing clock', () => {
  it('resolves with an error quota instead of rejecting', async () => {
    const home = join(root, 'clock-throws');
    await mkdir(join(home, '.grok', 'logs'), { recursive: true });
    await writeFile(join(home, '.grok', 'logs', 'unified.jsonl'), billingLine({ creditUsagePercent: 3 }) + '\n');

    const quota = await fetchGrokQuotaWith(
      {
        timeoutMs: 15000,
        now: () => {
          throw new Error('clock failure');
        },
        homeDir: home,
      },
      { refresh: async () => undefined, shouldRefresh: false },
    );

    assert.equal(quota.provider, 'grok');
    assert.equal(quota.status, 'error');
    assert.deepEqual(quota.windows, []);
  });
});

describe('fetchGrokQuota', () => {
  it('reads the cached log without refreshing when grok is not installed under homeDir', async () => {
    const home = join(root, 'no-binary');
    await mkdir(join(home, '.grok', 'logs'), { recursive: true });
    await writeFile(join(home, '.grok', 'logs', 'unified.jsonl'), billingLine({ creditUsagePercent: 21 }) + '\n');

    const quota = await fetchGrokQuota({ timeoutMs: 15000, now: () => NOW, homeDir: home });

    assert.equal(quota.status, 'ok');
    assert.equal(quota.source, 'cached');
    assert.equal(quota.windows[0].usedPercent, 21);
  });
});
