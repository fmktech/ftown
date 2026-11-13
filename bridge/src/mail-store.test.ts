import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailStore, createMailMessage } from './mail-store.js';
import type { PullRequestObservation } from './pull-request-status.js';

const url = 'https://github.com/owner/repo/pull/1';
const observation = (state: PullRequestObservation['state'], headOid = 'abc'): PullRequestObservation => ({ url, state, checkedAt: '2026-01-01T00:00:00.000Z', stale: false, attempt: 1, headOid });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-pr-mail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 's'));
  return { dir, store: new MailStore(id => join(dir, id)) };
}
test('atomically commits observed transitions and survives restart and delivered pruning', async t => {
  const { dir, store } = await fixture(t);
  const first = await store.commitPullRequestObservation('s', 'link', observation('failed'));
  assert.equal(first.enqueued, true);
  assert.equal((await store.commitPullRequestObservation('s', 'link', observation('failed'))).enqueued, false);
  const mail = await store.listAll('s', 0); assert.equal(mail.length, 1);
  assert.match(mail[0].body, /rollup checks failed/); assert.match(mail[0].body, /Observed head: abc/);
  assert.equal((await store.commitPullRequestObservation('s', 'link', observation('unknown'))).enqueued, false);
  assert.equal((await store.commitPullRequestObservation('s', 'link', { ...observation('passed'), stale: true })).enqueued, false);
  assert.equal((await store.commitPullRequestObservation('s', 'link', observation('in_progress'))).enqueued, false);
  assert.equal((await store.commitPullRequestObservation('s', 'link', observation('failed'))).enqueued, true);
  assert.equal((await store.commitPullRequestObservation('s', 'link', observation('passed'))).enqueued, true);
  assert.equal((await store.commitPullRequestObservation('s', 'link', observation('passed', 'def'))).enqueued, true);
  assert.equal((await store.commitPullRequestObservation('s', 'link', observation('merged'))).enqueued, true);
  assert.equal((await store.commitPullRequestObservation('s', 'link', observation('merged'))).enqueued, false);
  const messages = await store.listAll('s', 0); assert.equal(messages.length, 5);
  assert.deepEqual(messages.map(m => m.type), ['message', 'message', 'fyi', 'fyi', 'message']);
  assert.equal((await store.listUnnudgedWaking('s')).length, 3);
  for (let i = 0; i < 505; i++) await store.append(createMailMessage({ from: 'other', to: 's', type: 'message', body: `message-${i}` }));
  await store.markDelivered('s', (await store.listAll('s', 0)).map(item => item.id), 'poll');
  const restarted = new MailStore(id => join(dir, id));
  assert.equal((await restarted.commitPullRequestObservation('s', 'link', observation('merged'))).enqueued, false);
  assert.equal((await restarted.listAll('s', 0)).length, 500);
  assert.equal((await restarted.commitPullRequestObservation('s', 'new-link', observation('merged'))).enqueued, true);
});
test('preserves legacy and concurrent ordinary mail and rejects malformed checkpoint without creating directories', async t => {
  const { dir, store } = await fixture(t);
  await writeFile(join(dir, 's', 'inbox.jsonl'), '{broken ordinary line\n');
  await Promise.all([store.append(createMailMessage({ from: 'a', to: 's', type: 'message', body: 'ordinary' })), store.commitPullRequestObservation('s', 'link', observation('passed'))]);
  assert.equal((await store.listAll('s', 0)).length, 2);
  await assert.rejects(store.commitPullRequestObservation('missing', 'link', observation('failed')));
  await assert.rejects(readFile(join(dir, 'missing', 'inbox.jsonl')));
  await writeFile(join(dir, 's', 'inbox.jsonl'), '{"_ftown":"pr-event-checkpoint","version":2}\n');
  await assert.rejects(store.commitPullRequestObservation('s', 'link', observation('failed')), /Invalid PR event checkpoint/);
  await assert.rejects(store.listAll('s', 0), /Invalid PR event checkpoint/);
});

test('retries before-rename and ambiguous after-rename failures without losing or duplicating a transition', async t => {
  const { store } = await fixture(t);
  const internal = store as unknown as { replaceInbox(id: string, inbox: unknown): Promise<void> };
  const replace = internal.replaceInbox.bind(store);
  internal.replaceInbox = async () => { throw new Error('before rename'); };
  await assert.rejects(store.commitPullRequestObservation('s', 'link', observation('failed')), /before rename/);
  assert.equal((await store.listAll('s', 0)).length, 0);
  let fail = true;
  internal.replaceInbox = async (id, inbox) => { await replace(id, inbox); if (fail) { fail = false; throw new Error('after rename'); } };
  await assert.rejects(store.commitPullRequestObservation('s', 'link', observation('failed')), /after rename/);
  assert.equal((await store.listAll('s', 0)).length, 1);
  assert.equal((await store.commitPullRequestObservation('s', 'link', observation('failed'))).enqueued, false);
  assert.equal((await store.listAll('s', 0)).length, 1);
});

test('markNudged, listUnnudgedWaking, and unreadCount persist across restarts and ignore fyi for waking', async t => {
  const { dir, store } = await fixture(t);
  assert.equal(await store.unreadCount('s'), 0);
  assert.deepEqual(await store.listUnnudgedWaking('s'), []);

  const mTask = createMailMessage({ from: 'a', to: 's', type: 'task', body: 'do work' });
  const mFyi = createMailMessage({ from: 'a', to: 's', type: 'fyi', body: 'just fyi' });
  const mMsg = createMailMessage({ from: 'b', to: 's', type: 'message', body: 'hello' });
  await store.append(mTask);
  await store.append(mFyi);
  await store.append(mMsg);

  assert.equal(await store.unreadCount('s'), 3);
  assert.deepEqual((await store.listUnnudgedWaking('s')).map(m => m.id), [mTask.id, mMsg.id]);

  // Empty markNudged is a no-op
  assert.deepEqual(await store.markNudged('s', []), []);

  const stamped = await store.markNudged('s', [mTask.id], '2026-01-01T00:00:00.000Z#tok1');
  assert.equal(stamped.length, 1);
  assert.equal(stamped[0].nudgedAt, '2026-01-01T00:00:00.000Z#tok1');

  // Re-stamping already stamped id is a no-op and does not overwrite token
  assert.deepEqual(await store.markNudged('s', [mTask.id], '2026-01-01T00:00:00.000Z#tok2'), []);

  // unreadCount still includes nudged (undelivered) and fyi messages
  assert.equal(await store.unreadCount('s'), 3);
  assert.deepEqual((await store.listUnnudgedWaking('s')).map(m => m.id), [mMsg.id]);

  // Survives store restart
  const restarted = new MailStore(id => join(dir, id));
  assert.equal(await restarted.unreadCount('s'), 3);
  assert.deepEqual((await restarted.listUnnudgedWaking('s')).map(m => m.id), [mMsg.id]);
  const allAfterRestart = await restarted.listAll('s', 0);
  assert.equal(allAfterRestart.find(m => m.id === mTask.id)?.nudgedAt, stamped[0].nudgedAt);

  // unmarkNudged with mismatched token is a no-op
  assert.deepEqual(await restarted.unmarkNudged('s', [], '2026-01-01T00:00:00.000Z#tok1'), []);
  assert.deepEqual(await restarted.unmarkNudged('s', [mTask.id], '2026-01-01T00:00:00.000Z#wrong'), []);
  assert.deepEqual((await restarted.listUnnudgedWaking('s')).map(m => m.id), [mMsg.id]);

  // unmarkNudged with matching token removes nudgedAt durably
  const unstamped = await restarted.unmarkNudged('s', [mTask.id], stamped[0].nudgedAt!);
  assert.equal(unstamped.length, 1);
  assert.equal(unstamped[0].nudgedAt, undefined);
  assert.deepEqual(await restarted.unmarkNudged('s', [mTask.id], stamped[0].nudgedAt!), []);
  assert.deepEqual((await restarted.listUnnudgedWaking('s')).map(m => m.id), [mTask.id, mMsg.id]);
  await restarted.markNudged('s', [mTask.id]);

  // Delivering messages decrements unreadCount and removes from listUnnudgedWaking
  await restarted.markDelivered('s', [mTask.id, mFyi.id], 'drain');
  assert.equal(await restarted.unreadCount('s'), 1);
  await restarted.markDelivered('s', [mMsg.id], 'drain');
  assert.equal(await restarted.unreadCount('s'), 0);
  assert.deepEqual(await restarted.listUnnudgedWaking('s'), []);
});

test('commitPullRequestObservation uses fyi for passed and message for failed and merged', async t => {
  const { store } = await fixture(t);
  await store.commitPullRequestObservation('s', 'link', observation('passed', 'h1'));
  await store.commitPullRequestObservation('s', 'link', observation('failed', 'h2'));
  await store.commitPullRequestObservation('s', 'link', observation('merged'));

  const all = await store.listAll('s', 0);
  assert.equal(all.length, 3);
  assert.equal(all[0].type, 'fyi');
  assert.equal(all[1].type, 'message');
  assert.equal(all[2].type, 'message');

  // Only failed and merged are waking
  const waking = await store.listUnnudgedWaking('s');
  assert.deepEqual(waking.map(m => m.id), [all[1].id, all[2].id]);
});
