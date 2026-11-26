import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { ProjectStorageMoves } from './project-storage-move.js';
import { ProjectBoardStore } from './project-board-store.js';
import { PROJECT_MOVE } from './project-directory-protocol.js';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-move-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const projectId = randomUUID();
  const services = new Map<string, ProjectStorageMoves>();
  const link = {
    online: true,
    before: (_action: string) => {},
    after: (_action: string) => {},
  };
  const bridge = (id: string) => {
    const data = join(dir, id);
    const store = new ProjectBoardStore(data, id);
    const moves = new ProjectStorageMoves(data, id, store, {
      resolve: (bridgeId) => ({ bridgeId }),
      connectDirect: async () => link.online,
      directHttp: async (target, path, body) => {
        assert.equal(path, PROJECT_MOVE);
        const { action } = body as { action: string };
        link.before(action);
        let result;
        try {
          result = services.get(target)!.receive(id, body);
        } catch (e) {
          return { status: 409, body: { error: String(e) } };
        }
        link.after(action);
        return { status: 200, body: result };
      },
    });
    services.set(id, moves);
    const edit = (action: string, fields = {}) =>
      store.mutate({ projectId, bridgeId: id, action, ...fields }, 'User');
    return { store, moves, edit };
  };
  const a = bridge('A'),
    b = bridge('B');
  a.edit('create_project', { name: 'Planner' });
  return { projectId, a, b, bridge, link };
}

test('moving a project carries its board, history, workers and undelivered notifications, including on a return move', async (t) => {
  const { projectId, a, b } = fixture(t);
  const ticketId = randomUUID(),
    child = randomUUID(),
    threadId = randomUUID(),
    commentId = randomUUID();
  a.edit('create_ticket', {
    ticketId,
    title: 'Implement',
    assignee: { kind: 'bridge', bridgeId: 'B' },
    sessionIds: ['worker'],
  });
  a.edit('create_ticket', { ticketId: child, title: 'Review', parentTicketId: ticketId });
  a.edit('add_ticket_comment', { ticketId, commentId, text: 'Reviewed' });
  a.store.recordWorkerStates(projectId, new Map([['worker', { blocked: true }]]));
  a.store.discussion(
    projectId,
    {
      action: 'create_thread',
      channelId: 'general',
      threadId,
      postId: randomUUID(),
      title: 'Design',
      text: 'Ready',
      mentions: [{ bridgeId: 'B', sessionId: 'worker' }],
    },
    { name: 'User' },
    true,
  );
  const board = a.store.read(projectId);
  const comments = a.store.comments(projectId, ticketId);
  const posts = a.store.discussion(projectId, { action: 'posts', threadId });
  const notices = a.store.pendingNotifications(projectId);
  const mail = a.store.pendingDiscussionMail(projectId);
  assert.ok(notices.length && mail.length);
  const arrived = await a.moves.move(projectId, 'B');
  assert.deepEqual(arrived, { id: projectId, name: 'Planner', bridgeId: 'B', homeRevision: 1 });
  assert.deepEqual(a.store.list(), []);
  assert.throws(() => a.edit('rename_project', { name: 'stale' }), /moved to bridge B/);
  assert.deepEqual(b.store.read(projectId), { ...board, project: arrived });
  assert.deepEqual(b.store.comments(projectId, ticketId), comments);
  assert.deepEqual(b.store.discussion(projectId, { action: 'posts', threadId }), posts);
  assert.deepEqual(b.store.pendingNotifications(projectId), notices);
  assert.deepEqual(b.store.pendingDiscussionMail(projectId), mail);
  b.edit('rename_project', { name: 'Renamed' });
  await b.moves.move(projectId, 'A');
  assert.deepEqual(a.store.list(), [{ id: projectId, name: 'Renamed', bridgeId: 'A', homeRevision: 2 }]);
  assert.deepEqual(a.store.read(projectId).tickets, board.tickets);
});

test('a lost activation acknowledgement fences the source until a restarted bridge confirms the receipt', async (t) => {
  const { projectId, a, b, bridge, link } = fixture(t);
  link.after = (action) => {
    if (action === 'commit') throw new Error('link lost');
  };
  await assert.rejects(a.moves.move(projectId, 'B'), /link lost/);
  b.edit('rename_project', { name: 'After cutover' });
  assert.throws(() => a.edit('rename_project', { name: 'Conflict' }), /moving/);
  link.after = () => {};
  const restart = bridge('A');
  restart.moves.recover(projectId);
  await restart.moves.move(projectId, 'B');
  assert.deepEqual(restart.store.list(), []);
  assert.equal(b.store.projectName(projectId), 'After cutover');
});

test('partial transfers stay invisible, source edits are fenced during copy, and failed transfers can be retried', async (t) => {
  const { projectId, a, b, link } = fixture(t);
  link.online = false;
  await assert.rejects(a.moves.move(projectId, 'B'), /online/);
  link.online = true;
  link.before = (action) => {
    if (action !== 'rows') return;
    assert.deepEqual(b.store.list(), []);
    assert.throws(() => a.edit('rename_project', { name: 'Conflict' }), /moving/);
    throw new Error('copy interrupted');
  };
  await assert.rejects(a.moves.move(projectId, 'B'), /copy interrupted/);
  a.edit('rename_project', { name: 'After retry' });
  link.before = () => {};
  await a.moves.move(projectId, 'B');
  assert.equal(b.store.projectName(projectId), 'After retry');
});

test('a conflicting project created at the destination during transfer leaves both originals editable', async (t) => {
  const { projectId, a, b, link } = fixture(t);
  const other = randomUUID();
  link.before = (action) => {
    if (action === 'commit')
      b.store.mutate({ action: 'create_project', bridgeId: 'B', projectId: other, name: 'Planner' });
  };
  await assert.rejects(a.moves.move(projectId, 'B'), /name is already in use/);
  a.edit('rename_project', { name: 'New name' });
  assert.deepEqual(
    b.store.list().map((p) => p.id),
    [other],
  );
  link.before = () => {};
  await a.moves.move(projectId, 'B');
  assert.equal(b.store.projectName(projectId), 'New name');
});

test('a concurrent local create using the same ID cannot strand the original home in cutover', async (t) => {
  const { projectId, a, b, link } = fixture(t);
  link.before = (action) => {
    if (action === 'commit') b.edit('create_project', { name: 'Independent' });
  };
  await assert.rejects(a.moves.move(projectId, 'B'), /already has this project/);
  a.edit('rename_project', { name: 'Preserved' });
  assert.equal(a.store.projectName(projectId), 'Preserved');
  assert.equal(b.store.projectName(projectId), 'Independent');
});

test('long-running move requests return progress and a poll joins the same transfer', async (t) => {
  const { projectId, a, b, link } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let copies = 0;
  link.before = (action) => {
    if (action === 'begin') {
      copies++;
      t.mock.timers.tick(4_000);
    }
  };
  assert.deepEqual(await a.moves.waitForMove(projectId, 'B', false), { moving: true });
  assert.deepEqual(await a.moves.waitForMove(projectId, 'B', true), { project: b.store.list()[0] });
  assert.equal(copies, 1);
  assert.equal(b.store.projectName(projectId), 'Planner');
});
