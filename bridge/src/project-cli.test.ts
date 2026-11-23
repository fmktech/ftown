import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runFtown } from './ftown-cli.js';
import { ProjectBoardStore, projectBoardPage } from './project-board-store.js';
import { secureFixture } from './security/bridge/fixtures.test.js';

test('a session can address its remote project by name, read every page and disambiguate projects by ID', async t => {
  const work = mkdtempSync(join(tmpdir(), 'ftown-project-cli-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const remote = new ProjectBoardStore(join(work, 'remote'), 'remote');
  const projectId = randomUUID();
  const target = { bridgeId: 'remote', projectId };
  remote.mutate({ ...target, action: 'create_project', name: 'Product' });
  const ids = Array.from({ length: 13 }, () => randomUUID());
  for (const ticketId of ids) remote.mutate({ ...target, action: 'create_ticket', ticketId, title: 'A task', body: 'a'.repeat(30_000) });
  const ticketId = ids.at(-1)!;
  for (let n = 0; n < 12; n++) remote.mutate({ ...target, action: 'add_ticket_comment', ticketId, commentId: randomUUID(), text: 'Comment ' + n }, 'Worker');
  let duplicate = false;
  const home = join(work, '.ftown');
  mkdirSync(home);
  const secure = await secureFixture(home, async (url, init) => {
    const route = new URL(String(url)).pathname;
    if (route === '/api/project-board/list_projects') {
      const projects = remote.list();
      if (duplicate) projects.push({ id: randomUUID(), bridgeId: 'bridge', name: 'Product' });
      return Response.json({ homeBridgeId: 'bridge', projects });
    }
    const forwarded = JSON.parse(String(init?.body));
    if (route !== '/api/peers/http' || forwarded.bridge !== 'remote') return Response.json({ error: 'Wrong home bridge' }, { status: 404 });
    const payload = forwarded.body;
    if (forwarded.path.endsWith('_project_discussion')) {
      const { projectId, actorSessionId, ...operation } = payload;
      return Response.json(remote.discussion(projectId, operation, { name: 'Tester', bridgeId: 'bridge', sessionId: actorSessionId },
        forwarded.path.endsWith('/mutate_project_discussion')));
    }
    if (forwarded.path === '/api/project-board/get_ticket_comments') {
      return Response.json(remote.comments(payload.projectId, payload.ticketId, payload.after));
    }
    if (forwarded.path === '/api/project-board/get_project_board') return Response.json(projectBoardPage(remote.read(payload.projectId), payload.cursor));
    if (forwarded.path === '/api/project-board/mutate_project_board') return Response.json(projectBoardPage(remote.mutate({ ...payload, bridgeId: 'remote' })));
    return Response.json({ error: 'Unknown command' }, { status: 404 });
  });
  t.after(() => secure.security.close());
  writeFileSync(join(home, 'bridge.json'), JSON.stringify(secure.pointer));
  const previous = { fetch: globalThis.fetch, dir: process.env.FTOWN_DATA_DIR, bridge: process.env.FTOWN_BRIDGE };
  process.env.FTOWN_DATA_DIR = home;
  delete process.env.FTOWN_BRIDGE;
  globalThis.fetch = secure.fetch;
  t.after(() => {
    globalThis.fetch = previous.fetch;
    if (previous.dir === undefined) delete process.env.FTOWN_DATA_DIR; else process.env.FTOWN_DATA_DIR = previous.dir;
    if (previous.bridge === undefined) delete process.env.FTOWN_BRIDGE; else process.env.FTOWN_BRIDGE = previous.bridge;
  });
  const messages: string[] = [];
  t.mock.method(console, 'log', (message: string) => messages.push(message));
  t.mock.method(console, 'error', (message: string) => messages.push(message));
  const tickets = (...args: string[]) => runFtown(['tickets', '--json', ...args]);
  const discuss = (...args: string[]) => runFtown(['discuss', ...args, '--project', 'Product', '--json']);
  const thread = randomUUID();
  assert.equal(await discuss('post', '#general', '--id', thread, '--title', 'Review', '--text', 'Please review.'), 0);
  assert.equal(await discuss('post', 'general', '--id', thread, '--title', 'Review', '--text', 'Please review.'), 0);
  assert.equal(await discuss('read', thread), 0);
  const posts = JSON.parse(messages.pop()!).posts;
  assert.equal(posts.length, 1);
  assert.equal(await discuss('link', thread, ticketId), 0);
  assert.equal(await discuss('for-ticket', ticketId), 0);
  assert.equal(JSON.parse(messages.pop()!).threads[0].id, thread);
  assert.equal(await discuss('activity', 'general', '--after', String(posts[0].seq)), 0);
  assert.deepEqual(JSON.parse(messages.pop()!).posts, []);
  assert.equal(await discuss('activity', 'general', '--after', '-1'), 1);

  assert.equal(await tickets('list', '--project', 'Product'), 0, messages.at(-1));
  assert.deepEqual(JSON.parse(messages.pop()!).tickets.map((ticket: { id: string }) => ticket.id), ids);
  assert.equal(await tickets('update', ticketId, '--project', 'Product', '--stage', 'Review', '--link', 'worker'), 0);
  assert.equal(JSON.parse(messages.pop()!).ticket.stage, 'Review');
  assert.deepEqual(remote.read(projectId).tickets.at(-1)?.sessionIds, ['worker']);
  const boards = (...args: string[]) => runFtown(['boards', ...args, '--project', projectId, '--json']);
  assert.equal(await boards('columns', 'add', 'QA'), 0, messages.at(-1));
  const added = JSON.parse(messages.pop()!).columns.at(-1);
  assert.equal(added.label, 'QA');
  assert.equal(await tickets('update', ticketId, '--project', projectId, '--stage', 'QA'), 0);
  assert.equal(JSON.parse(messages.pop()!).ticket.stage, added.id);
  assert.equal(await boards('columns', 'rename', added.id, 'Quality'), 0, messages.at(-1));
  assert.equal(await boards('columns', 'reorder', 'Quality', 'Backlog', 'In progress', 'Blocked', 'Review', 'Done'), 0, messages.at(-1));
  assert.equal(JSON.parse(messages.pop()!).columns[0].id, added.id);
  assert.equal(await boards('columns', 'remove', 'Quality'), 1);
  assert.equal(await boards('columns', 'remove', 'Quality', '--move-to', 'Done'), 0, messages.at(-1));
  assert.equal(remote.read(projectId).tickets.at(-1)?.stage, 'Done');
  assert.equal(await boards('columns', 'rename', 'Backlog', 'Queue'), 0);
  assert.equal(await boards('columns', 'rename', 'Review', 'Backlog'), 0);
  assert.equal(await tickets('update', ticketId, '--project', projectId, '--stage', 'Backlog'), 0);
  assert.equal(JSON.parse(messages.pop()!).ticket.stage, 'Review');
  assert.equal(await tickets('update', ticketId, '--project', projectId, '--stage', 'id:Backlog'), 0);
  assert.equal(JSON.parse(messages.pop()!).ticket.stage, 'Backlog');
  duplicate = true;
  assert.equal(await tickets('comments', ticketId, '--project', 'Product'), 1);
  assert.match(messages.pop()!, /Ambiguous project/);
  assert.equal(await tickets('comments', ticketId, '--project', projectId), 0);
  assert.deepEqual(JSON.parse(messages.pop()!).comments.map((comment: { text: string }) => comment.text),
    Array.from({ length: 12 }, (_, i) => 'Comment ' + (11 - i)));
  assert.equal(await boards('delete'), 0, messages.at(-1));
  assert.equal(JSON.parse(messages.pop()!).boardEnabled, false);
  assert.equal(await boards('create'), 0, messages.at(-1));
  assert.equal(JSON.parse(messages.pop()!).boardEnabled, true);
  assert.equal(remote.read(projectId).tickets.length, 0);
});
