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
