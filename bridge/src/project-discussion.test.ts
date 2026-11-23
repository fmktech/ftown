import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ProjectBoardStore } from './project-board-store.js';
import type { DiscussionAuthor, DiscussionPost, DiscussionThread } from './project-discussion-protocol.js';

const user: DiscussionAuthor = {name: 'User'};
const worker: DiscussionAuthor = {name: 'Build worker', sessionId: 'b-worker', bridgeId: 'B'};

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-discussion-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ProjectBoardStore(dir, 'A');
  const projectId = randomUUID();
  const board = (action: string, fields = {}) => store.mutate({bridgeId: 'A', projectId, action, ...fields});
  board('create_project', { name: 'Release' });
  const write = (payload: Record<string, unknown>, author = user) => store.discussion(projectId, payload, author, true);
  const read = (payload: Record<string, unknown>) => store.discussion(projectId, payload);
  return { dir, store, projectId, board, write, read };
}

test('following a thread and being mentioned enqueue one durable notification per recipient and post', async t => {
  const { dir, store, projectId, read, write } = await fixture(t);
  assert.deepEqual(read({action:'channels'}).channels, [{id:'general', name:'general', archived:false}]);
  const threadId = randomUUID(), channelId = randomUUID();
  write({action:'create_channel', channelId, name:'Releases'});
  const first = {action:'create_thread', channelId, threadId, title:'Builds', postId:randomUUID(), text:'Who can test this?'};
  write(first);
  write({action:'follow', threadId}, worker);
  const reply = {action:'reply', threadId, postId:randomUUID(), text:'Can you verify?', mentions:[{bridgeId:'B', sessionId:'b-worker'}]};
  write(reply);
  write(reply);
  write({action:'reply', threadId, postId:randomUUID(), text:'Running now'}, worker);
  write({action:'unfollow', threadId}, worker);
  write({action:'reply', threadId, postId:randomUUID(), text:'Result received'});
  const restart = new ProjectBoardStore(dir, 'A');
  const mail = restart.pendingDiscussionMail(projectId);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].postId, reply.postId);
  assert.equal(mail[0].sessionId, worker.sessionId);
  assert.match(mail[0].body, /Can you verify/);
  restart.acknowledgeDiscussionMail(projectId, mail[0].id);
  assert.deepEqual(store.pendingDiscussionMail(projectId), []);
  const posts = read({action:'posts',threadId}).posts as DiscussionPost[];
  assert.deepEqual(posts.map(post => post.text), ['Who can test this?', 'Can you verify?', 'Running now', 'Result received']);
  assert.deepEqual(posts[2].author, worker);
  assert.deepEqual(read({action:'posts',channelId,after:posts[1].seq}).posts, posts.slice(2));
  assert.throws(() => write({...reply,text:'Modified'}), /ID already in use/);
});

test('ticket and discussion links survive channel archival, and deleting the board preserves discussion history', async t => {
  const { board, store, read, write, projectId } = await fixture(t);
  const threadId = randomUUID(), ticketId = randomUUID(), channelId = randomUUID();
  write({action:'create_channel',channelId,name:'QA'});
  write({action:'create_thread',channelId,threadId,title:'Linux smoke',postId:randomUUID(),text:'Test output'});
  const create = {action:'create_ticket',threadId,ticketId,title:'Investigate Linux build'};
  write(create); write(create);
  assert.deepEqual(store.read(projectId).tickets.map(t => t.id), [ticketId]);
  assert.equal((read({action:'threads',ticketId}).threads as DiscussionThread[])[0].id, threadId);
  write({action:'rename_channel',channelId,name:'linux'});
  write({action:'archive_channel',channelId});
  assert.throws(() => write({action:'reply',threadId,postId:randomUUID(),text:'Reopen?'}), /archived/);
  assert.equal((read({action:'thread',threadId}).thread as DiscussionThread).ticketId, ticketId);
  board('delete_board');
  assert.equal((read({action:'thread',threadId}).thread as DiscussionThread).ticketId, null);
  assert.equal((read({action:'posts',channelId}).posts as DiscussionPost[]).length, 1);
  board('delete_project');
  assert.throws(() => read({action:'channels'}), /deleted/);
});

test('channel activity resumes at a committed post cursor across interleaved threads and independent projects', async t => {
  const {store, projectId, write, read} = await fixture(t);
  const otherProject = randomUUID();
  store.mutate({bridgeId:'A', projectId:otherProject, name:'Other', action:'create_project'});
  const threads = [randomUUID(), randomUUID()];
  for (const threadId of threads) write({action:'create_thread', channelId:'general', threadId, title:'Build', postId:randomUUID(), text:'Opening'});
  for (let index = 0; index < 10; index++) write({action:'reply', threadId:threads[index % 2], postId:randomUUID(), text:'Reply ' + index});
  const first = read({action:'posts', channelId:'general'}) as {posts:DiscussionPost[]; nextAfter:number};
  assert.equal(first.nextAfter, first.posts.at(-1)?.seq);
  const last = read({action:'posts', channelId:'general', after:first.nextAfter}) as {posts:DiscussionPost[]; nextAfter?:number};
  assert.equal(last.nextAfter, undefined);
  assert.deepEqual(last.posts.map(post => post.text), ['Reply 8', 'Reply 9']);
  assert.deepEqual(store.discussion(otherProject, {action:'posts',channelId:'general'}).posts, []);
  assert.throws(() => store.discussion(otherProject, {action:'thread',threadId:threads[0]}), /not found/);
  assert.throws(() => store.discussion(projectId, {action:'archive_channel',channelId:'general'}));
  assert.throws(() => write({action:'follow',threadId:threads[0]}), /requires a session/);
});
