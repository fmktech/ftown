import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailStore } from './mail-store.js';
import { PullRequestEventWatcher } from './pull-request-events.js';
import type { PullRequestObservation } from './pull-request-status.js';
import type { Session } from './types.js';

const url = (n: number) => `https://github.com/owner/repo/pull/${n}`;
const session = (id: string, pr = url(1)): Session => ({ id, name: id, command: 'agent', bridgeId: 'bridge', status: 'running', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', pullRequestUrl: pr, pullRequestLinkId: `link-${id}` });
function statusFixture() {
  let pinned: string[] = []; let state: PullRequestObservation['state'] = 'failed', head = 'one', attempts = 0;
  const values = new Map<string, PullRequestObservation>();
  return {
    setState(next: PullRequestObservation['state'], nextHead = head) { state = next; head = nextHead; },
    setBackgroundUrls(urls: readonly string[]) { pinned = [...urls]; },
    async getObservations(urls: readonly string[]) {
      for (const item of pinned) values.set(item.toLowerCase(), { url: item, state, headOid: head, checkedAt: '2026-01-01T00:00:00.000Z', stale: false, attempt: ++attempts });
      return { observations: urls.map(item => values.get(item.toLowerCase()) ?? { url: item, state: 'unknown' as const, stale: true, checkedAt: null, attempt: 0 }), nextRefreshAt: '2026-01-01T00:01:00.000Z' };
    },
  };
}
test('two agents receive each observed transition once without a dashboard; stopped agents are retained and shell skipped', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-pr-watch-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const sessions = new Map([['a', session('a')], ['b', { ...session('b'), status: 'completed' as const }], ['shell', { ...session('shell'), shellType: 'shell' as const }]]);
  for (const id of sessions.keys()) await mkdir(join(dir, id));
  const store = { listSessions: async () => [...sessions.values()], loadSession: async (id: string) => sessions.get(id) ?? null, saveSession: async (value: Session) => { sessions.set(value.id, value); } };
  const mailStore = new MailStore(id => join(dir, id)); const service = statusFixture(); const wakes: string[] = [];
  const watcher = new PullRequestEventWatcher({ bridgeId: 'bridge', store, withSessionMutation: async (_id, fn) => fn(), statusService: service, mailStore, notifyCommitted: async s => { wakes.push(s.id); } });
  await watcher.runOnce(); assert.equal((await mailStore.listAll('a', 0)).length, 1); assert.equal((await mailStore.listAll('b', 0)).length, 1); assert.equal((await mailStore.listAll('shell', 0)).length, 0);
  await watcher.runOnce(); assert.equal((await mailStore.listAll('a', 0)).length, 1);
  service.setState('in_progress'); await watcher.runOnce();
  service.setState('failed'); await watcher.runOnce();
  service.setState('passed', 'two'); await watcher.runOnce();
  service.setState('merged'); await watcher.runOnce(); await watcher.runOnce();
  assert.equal((await mailStore.listAll('a', 0)).length, 4); assert.equal((await mailStore.listAll('b', 0)).length, 4);
  assert.ok(wakes.includes('a')); await watcher.stop();
});
test('unlink and relink during a status read fences old observation and stop fences the flight', async () => {
  let selected: Session | null = session('a'); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const inRead = new Promise<void>(resolve => { entered = resolve; }); let reads = 0, commits = 0;
  const service = { setBackgroundUrls: (_urls: readonly string[]) => {}, getObservations: async (urls: readonly string[]) => {
    if (++reads === 2) { entered(); await gate; }
    return { observations: urls.map(item => ({ url: item, state: 'failed' as const, headOid: 'one', checkedAt: '2026-01-01T00:00:00Z', stale: false, attempt: reads })), nextRefreshAt: '2026-01-01T00:01:00Z' };
  } };
  const store = { listSessions: async () => selected ? [selected] : [], loadSession: async () => selected, saveSession: async (value: Session) => { selected = value; } };
  const watcher = new PullRequestEventWatcher({ bridgeId: 'bridge', store, withSessionMutation: async (_id, fn) => fn(), statusService: service, mailStore: { commitPullRequestObservation: async () => { commits++; return { enqueued: true }; } }, notifyCommitted: async () => {} });
  const first = watcher.runOnce(); await inRead; selected = { ...session('a'), pullRequestLinkId: 'new-link' }; release(); await first; assert.equal(commits, 0);
  await watcher.stop(); await watcher.runOnce(); assert.equal(commits, 0);
});
test('rotates across more than 500 distinct linked URLs in bounded groups', async () => {
  const sessions = Array.from({ length: 501 }, (_, i) => session(`s${i}`, url(i + 1))); const seen = new Set<string>(); let max = 0;
  const service = statusFixture(); const set = service.setBackgroundUrls.bind(service);
  service.setBackgroundUrls = urls => { max = Math.max(max, urls.length); urls.forEach(item => seen.add(item)); set(urls); };
  const watcher = new PullRequestEventWatcher({ bridgeId: 'bridge', store: { listSessions: async () => sessions, loadSession: async id => sessions.find(item => item.id === id) ?? null, saveSession: async () => {} }, withSessionMutation: async (_id, fn) => fn(), statusService: service, mailStore: { commitPullRequestObservation: async () => ({ enqueued: true }) }, notifyCommitted: async () => {} });
  for (let i = 0; i < 26; i++) await watcher.runOnce();
  assert.equal(seen.size, 501); assert.equal(max, 20); await watcher.stop();
});

test('deleted sessions and shutdown are fenced while GitHub lookup is in flight', async () => {
  for (const action of ['delete', 'stop'] as const) {
    let selected: Session | null = session('a'); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const inRead = new Promise<void>(resolve => { entered = resolve; }); let reads = 0, commits = 0, wakes = 0;
    const service = { setBackgroundUrls: (_urls: readonly string[]) => {}, getObservations: async (urls: readonly string[]) => {
      if (++reads === 2) { entered(); await gate; }
      return { observations: urls.map(item => ({ url: item, state: 'passed' as const, headOid: 'one', checkedAt: '2026-01-01T00:00:00Z', stale: false, attempt: reads })), nextRefreshAt: '2026-01-01T00:01:00Z' };
    } };
    const store = { listSessions: async () => selected ? [selected] : [], loadSession: async () => selected, saveSession: async (value: Session) => { selected = value; } };
    const watcher = new PullRequestEventWatcher({ bridgeId: 'bridge', store, withSessionMutation: async (_id, fn) => fn(), statusService: service, mailStore: { commitPullRequestObservation: async () => { commits++; return { enqueued: true }; } }, notifyCommitted: async () => { wakes++; } });
    const running = watcher.runOnce(); await inRead;
    let stopped: Promise<void> | undefined;
    if (action === 'delete') selected = null; else stopped = watcher.stop();
    release(); await running; await stopped; assert.equal(commits, 0); assert.equal(wakes, 0);
    await watcher.stop();
  }
});

test('retries a failed post-commit wake even if later status reads are unavailable', async () => {
  const current = session('a'); let calls = 0, commits = 0, unavailable = false;
  const service = statusFixture(); const get = service.getObservations.bind(service);
  service.getObservations = async urls => unavailable ? { observations: urls.map(item => ({ url: item, state: 'unknown' as const, stale: true, checkedAt: null, attempt: 1 })), nextRefreshAt: '2026-01-01T00:01:00.000Z' } : get(urls);
  const watcher = new PullRequestEventWatcher({ bridgeId: 'bridge', store: { listSessions: async () => [current], loadSession: async () => current, saveSession: async () => {} }, withSessionMutation: async (_id, fn) => fn(), statusService: service,
    mailStore: { commitPullRequestObservation: async () => { commits++; return { enqueued: true }; } }, notifyCommitted: async () => { if (++calls === 1) throw new Error('wake failed'); } });
  await watcher.runOnce(); assert.equal(commits, 1); assert.equal(calls, 1);
  unavailable = true; await watcher.runOnce(); assert.equal(commits, 1); assert.equal(calls, 2); await watcher.stop();
});

test('a damaged mailbox cannot block other sessions or rotation beyond one group', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const sessions = Array.from({ length: 22 }, (_, i) => session(`s${i}`, url(i + 1)));
  const committed = new Set<string>(); let failures = 0;
  const watcher = new PullRequestEventWatcher({ bridgeId: 'bridge', store: { listSessions: async () => sessions, loadSession: async id => sessions.find(item => item.id === id) ?? null, saveSession: async () => {} }, withSessionMutation: async (_id, fn) => fn(), statusService: statusFixture(),
    mailStore: { commitPullRequestObservation: async id => { if (id === 's0') { failures++; throw new Error('private mailbox contents'); } committed.add(id); return { enqueued: true }; } }, notifyCommitted: async () => {} });
  await watcher.runOnce(); await watcher.runOnce();
  assert.equal(committed.size, 21); assert.equal(committed.has('s0'), false);
  await watcher.runOnce(); assert.ok(failures >= 2, 'damaged mailbox is retried on later rotations');
  assert.ok(log.mock.calls.length >= 2); assert.doesNotMatch(JSON.stringify(log.mock.calls.map(call => call.arguments)), /private mailbox contents/);
  await watcher.stop();
});

test('an ambiguous committed event retries wake when GitHub becomes unavailable', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const dir = await mkdtemp(join(tmpdir(), 'ftown-pr-ambiguous-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'a')); const mail = new MailStore(id => join(dir, id)); const current = session('a');
  const service = statusFixture(); const get = service.getObservations.bind(service); let unavailable = false, wakes = 0;
  service.getObservations = async urls => unavailable ? { observations: urls.map(item => ({ url: item, state: 'unknown' as const, stale: true, checkedAt: null, attempt: 1 })), nextRefreshAt: '2026-01-01T00:01:00.000Z' } : get(urls);
  const watcher = new PullRequestEventWatcher({ bridgeId: 'bridge', store: { listSessions: async () => [current], loadSession: async () => current, saveSession: async () => {} }, withSessionMutation: async (_id, fn) => fn(), statusService: service,
    mailStore: { commitPullRequestObservation: async (id, link, observation) => { await mail.commitPullRequestObservation(id, link, observation); throw new Error('ambiguous after rename'); } }, notifyCommitted: async () => { wakes++; } });
  await watcher.runOnce(); assert.equal((await mail.listAll('a', 0)).length, 1); assert.equal(wakes, 0); assert.equal(log.mock.calls.length, 1);
  unavailable = true; await watcher.runOnce(); assert.equal(wakes, 1); assert.equal((await mail.listAll('a', 0)).length, 1);
  await watcher.stop();
});

test('rotates all punctuation-mixed URLs using the same ordering for sorting and cursor selection', async () => {
  const sessions = Array.from({ length: 30 }, (_, i) => session(`mixed${i}`, `https://github.com/owner/${i < 15 ? 'repo_z' : 'repo-z'}/pull/${i + 1}`));
  const seen = new Set<string>(); const service = statusFixture();
  const watcher = new PullRequestEventWatcher({ bridgeId: 'bridge', store: { listSessions: async () => sessions, loadSession: async id => sessions.find(item => item.id === id) ?? null, saveSession: async () => {} }, withSessionMutation: async (_id, fn) => fn(), statusService: service,
    mailStore: { commitPullRequestObservation: async id => { seen.add(id); return { enqueued: true }; } }, notifyCommitted: async () => {} });
  await watcher.runOnce(); await watcher.runOnce();
  assert.equal(seen.size, 30); await watcher.stop();
});

test('unsupported GraphQL integer is skipped without blocking more than one group of valid links', async () => {
  const sessions = [session('oversized', url(2_147_483_648)), ...Array.from({ length: 25 }, (_, i) => session(`ok${i}`, url(i + 1)))];
  const seen = new Set<string>(), pinned: string[] = []; const service = statusFixture(), set = service.setBackgroundUrls.bind(service);
  service.setBackgroundUrls = urls => { pinned.push(...urls); set(urls); };
  const watcher = new PullRequestEventWatcher({ bridgeId: 'bridge', store: { listSessions: async () => sessions, loadSession: async id => sessions.find(item => item.id === id) ?? null, saveSession: async () => {} }, withSessionMutation: async (_id, fn) => fn(), statusService: service,
    mailStore: { commitPullRequestObservation: async id => { seen.add(id); return { enqueued: true }; } }, notifyCommitted: async () => {} });
  await watcher.runOnce(); await watcher.runOnce();
  assert.equal(seen.size, 25); assert.equal(seen.has('oversized'), false); assert.equal(pinned.includes(url(2_147_483_648)), false);
  await watcher.stop();
});

test('legacy load and token-save failures retry without blocking healthy links or mutating failed snapshots', async t => {
  t.mock.method(console, 'error', () => {});
  const legacy = { ...session('bad-save', url(99)), pullRequestLinkId: undefined };
  const unreadable = session('bad-load', url(98));
  const sessions = [legacy, unreadable, ...Array.from({ length: 25 }, (_, i) => session(`ok${i}`, url(i + 1)))];
  const seen = new Set<string>(); let saveAttempts = 0, loadAttempts = 0;
  const watcher = new PullRequestEventWatcher({ bridgeId: 'bridge', store: {
    listSessions: async () => sessions,
    loadSession: async id => { if (id === 'bad-load') { loadAttempts++; throw new Error('private read error'); } return sessions.find(item => item.id === id) ?? null; },
    saveSession: async value => { if (value.id === 'bad-save') { saveAttempts++; throw new Error('private save error'); } },
  }, withSessionMutation: async (_id, fn) => fn(), statusService: statusFixture(),
  mailStore: { commitPullRequestObservation: async id => { seen.add(id); return { enqueued: true }; } }, notifyCommitted: async () => {} });
  await watcher.runOnce(); await watcher.runOnce();
  assert.equal(seen.size, 25); assert.equal(saveAttempts, 2); assert.equal(loadAttempts, 2); assert.equal(legacy.pullRequestLinkId, undefined);
  await watcher.stop();
});
