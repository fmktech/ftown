import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectBoardChanged, ProjectBoardStore, projectBoardPage, type ProjectBoard } from './project-board-store.js';
import { classifyCommand } from './security/bridge/permissions.js';

test('restoring one project database independently retains its renamed board, linked workers and last known blockers', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ftown-project-storage-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new ProjectBoardStore(dataDir, 'home');
  const id = randomUUID(), ticketId = randomUUID();
  const base = { bridgeId: 'home', projectId: id };
  store.mutate({ ...base, action: 'create_project', name: 'First' });
  store.mutate({ ...base, projectId: randomUUID(), action: 'create_project', name: 'Second' });
  const create = { ...base, action: 'create_ticket', title: 'Fix layout', ticketId, sessionIds: ['worker-a', 'worker-b'] };
  store.mutate(create);
  store.mutate({ ...base, action: 'update_ticket', ticketId, stage: 'Review' });
  store.mutate(create);
  store.recordBlockers(id, new Map([['worker-a',true], ['worker-b',true]]));
  store.recordBlockers(id, new Map([['worker-b',false]]));
  store.mutate({ ...base, action: 'rename_project', name: 'Renamed' });

  const restoredDir = join(dataDir, 'restored');
  const dir = join(restoredDir, 'projects', id);
  await mkdir(dir, { recursive: true });
  await copyFile(join(dataDir, 'projects', id, 'board.sqlite'), join(dir, 'board.sqlite'));
  const restored = new ProjectBoardStore(restoredDir, 'replacement');
  assert.deepEqual(restored.list(), [{ id, name: 'Renamed', bridgeId: 'replacement' }]);
  assert.deepEqual(restored.read(id).tickets, [{ id: ticketId, title: 'Fix layout', stage: 'Review', sessionIds: ['worker-a', 'worker-b'], blocked: true }]);
  assert.equal(restored.recordBlockers(id, new Map([['worker-a',false]])).tickets[0].blocked, false);
  restored.mutate({ projectId: id, bridgeId: 'replacement', action: 'delete_project' });
  assert.deepEqual(restored.list(), []);
  assert.throws(() => restored.read(id), /deleted/);
  assert.equal(store.list().length, 2);
});

test('a cross-bridge descendant inherits once while explicit assignments and unlinks survive rediscovery', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-ticket-workers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ProjectBoardStore(dir, 'A');
  const projectId = randomUUID(), first = randomUUID(), second = randomUUID();
  const base = { projectId, bridgeId: 'A' };
  store.mutate({ ...base, action: 'create_project', name: 'Work' });
  store.mutate({ ...base, action: 'create_ticket', title: 'Implementation', ticketId: first, sessionIds: ['manager'] });
  store.mutate({ ...base, action: 'create_ticket', title: 'Review', ticketId: second, sessionIds: ['reviewer'] });
  const manager = { projectName: 'Work', bridgeId: 'A', id: 'manager' };
  const child = { projectName: 'Work', bridgeId: 'B', parentBridgeId: 'A', parentSessionId: 'manager', id: 'worker' };
  const reviewer = { ...child, id: 'reviewer' };
  const workers = [{ ...child, bridgeId: 'C', parentBridgeId: 'B', parentSessionId: 'reviewer', id: 'assistant' }, reviewer, child, manager,
    { ...child, id: 'other-project', projectName: 'Side' }, { ...child, id: 'wrong-parent', parentBridgeId: 'C' }];
  const initial = store.inheritWorkers(projectId, workers);
  assert.deepEqual(initial.tickets.map(ticket => ticket.sessionIds), [['manager', 'worker'], ['reviewer', 'assistant']]);
  store.mutate({ ...base, action: 'update_ticket', ticketId: first, removeSessionId: 'worker' });
  const restarted = new ProjectBoardStore(dir, 'A');
  restarted.mutate({ ...base, action: 'update_ticket', ticketId: second, addSessionId: 'manager' });
  assert.deepEqual(restarted.inheritWorkers(projectId, workers).tickets.map(ticket => ticket.sessionIds),
    [[], ['manager', 'reviewer', 'assistant']]);
});

test('large project responses fit the wire budget and reject mixed-revision pages', () => {
  const ticket = { id: '', title: 'Fix', stage: 'Review' as const, blocked: false,
    sessionIds: Array.from({length: 450}, () => randomUUID()) };
  const board: ProjectBoard = { project: { id: randomUUID(), name: 'Infra', bridgeId: 'home' },
    tickets: Array.from({ length: 30 }, () => ({ ...ticket, id: randomUUID() })) };
  const loaded: string[] = [];
  let cursor: string | undefined;
  do {
    const page = projectBoardPage(board, cursor);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 300_000);
    loaded.push(...page.tickets.map(row => row.id));
    cursor = 'nextCursor' in page ? page.nextCursor as string : undefined;
    if (cursor) assert.throws(() => projectBoardPage({ ...board, tickets: board.tickets.slice(1) }, cursor), ProjectBoardChanged);
  } while (cursor);
  assert.deepEqual(loaded, board.tickets.map(row => row.id));
});

test('project catalog and board reads are available to readers and board changes require control', () => {
  assert.equal(classifyCommand('list_projects').permission, 'read');
  assert.equal(classifyCommand('get_project_board').permission, 'read');
  const write = classifyCommand('mutate_project_board');
  assert.equal(write.permission, 'control');
  assert.equal(write.mutating, true);
});
