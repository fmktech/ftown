import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
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
  store.recordWorkerStates(id, new Map([['worker-a',{blocked:true}], ['worker-b',{blocked:true}]]));
  store.recordWorkerStates(id, new Map([['worker-b',{blocked:false}]]));
  store.mutate({ ...base, action: 'rename_project', name: 'Renamed' });

  const restoredDir = join(dataDir, 'restored');
  const dir = join(restoredDir, 'projects', id);
  await mkdir(dir, { recursive: true });
  await copyFile(join(dataDir, 'projects', id, 'board.sqlite'), join(dir, 'board.sqlite'));
  const restored = new ProjectBoardStore(restoredDir, 'replacement');
  assert.deepEqual(restored.list(), [{ id, name: 'Renamed', bridgeId: 'replacement' }]);
  assert.deepEqual(restored.read(id).tickets, [{ id: ticketId, title: 'Fix layout', stage: 'Review', sessionIds: ['worker-a', 'worker-b'], blocked: true, body: '', parentTicketId: null, assignee: null, commentCount: 0, sessionStatuses: Object.create(null) }]);
  assert.equal(restored.recordWorkerStates(id, new Map([['worker-a',{blocked:false}]])).tickets[0].blocked, false);
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

test('an existing project database upgrades in place and ticket history survives editing, child moves and deletion', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-ticket-upgrade-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const projectId = randomUUID(), parentId = randomUUID(), childId = randomUUID(), leafId = randomUUID();
  const path = join(dir, 'projects', projectId);
  await mkdir(path, { recursive: true });
  const legacy = new DatabaseSync(join(path, 'board.sqlite'));
  legacy.exec(`
    CREATE TABLE project(name TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE tickets(id TEXT PRIMARY KEY,title TEXT NOT NULL,stage TEXT NOT NULL);
    CREATE TABLE unlinked_sessions(session_id TEXT PRIMARY KEY);
    CREATE TABLE ticket_sessions(session_id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),blocked INTEGER NOT NULL DEFAULT 0);
    INSERT INTO project(name) VALUES('Existing');
  `);
  legacy.prepare('INSERT INTO tickets VALUES(?,?,?)').run(parentId,'Original','Review');
  legacy.close();
  const store = new ProjectBoardStore(dir,'home');
  const dest = { projectId, bridgeId: 'home' };
  const create = (ticketId: string, parentTicketId: string) => store.mutate({ ...dest, action:'create_ticket', ticketId, parentTicketId, title:'Subtask' });
  assert.equal(store.read(projectId).tickets[0].body, '');
  const body = 'Updated\n\n**Markdown**';
  store.mutate({ ...dest, action:'update_ticket', ticketId:parentId, body, assignee:{kind:'user'} });
  create(childId,parentId);
  create(leafId,childId);
  assert.throws(() => store.mutate({ ...dest, action:'update_ticket', ticketId:parentId, parentTicketId:leafId }), /ancestor/);
  assert.throws(() => create(randomUUID(),randomUUID()), /Parent ticket not found/);

  const commentIds: string[] = [];
  for (let i = 0; i < 12; i++) {
    const commentId = randomUUID();
    const change = { ...dest,action:'add_ticket_comment',ticketId:childId,commentId,text:'Comment ' + i };
    store.mutate(change, 'current user');
    store.mutate(change, 'current user');
    commentIds.push(commentId);
  }
  const reader = new ProjectBoardStore(dir,'home');
  const first = reader.comments(projectId,childId);
  const second = reader.comments(projectId,childId,first.nextAfter);
  assert.deepEqual([...first.comments,...second.comments].map(c => c.id), commentIds.reverse());
  assert.equal(second.nextAfter, undefined);
  assert.equal(reader.read(projectId).tickets.find(t => t.id === childId)?.commentCount, 12);
  const root = reader.read(projectId).tickets.find(t => t.id === parentId)!;
  assert.equal(root.body, body);
  assert.deepEqual(root.assignee, {kind:'user'});
  reader.mutate({ ...dest, action:'delete_ticket', ticketId:childId });
  assert.equal(reader.read(projectId).tickets.find(t => t.id === leafId)?.parentTicketId, null);
  assert.throws(() => reader.comments(projectId,childId), /not found/);
  assert.throws(() => create(childId,parentId), /deleted/);
});

test('bridge assignment and effective stage transitions enqueue once with the ticket and durable acknowledgements', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-ticket-notifications-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const store = new ProjectBoardStore(dir,'home');
  const projectId = randomUUID(), ticketId = randomUUID();
  const base = { bridgeId:'home', projectId };
  store.mutate({ ...base, action:'create_project', name:'Board' });
  const ticket = { ...base, ticketId, action:'create_ticket', title:'Connect workers', assignee:{kind:'bridge',bridgeId:'desk'}, sessionIds:['worker'] };
  store.mutate(ticket); store.mutate(ticket);
  const update = (patch: Record<string, unknown>) => store.mutate({ ...base,ticketId,action:'update_ticket',...patch });
  update({body:'Background'}); update({assignee:ticket.assignee});
  const observe = (state: { status?: 'running'|'completed'|'disconnected'; blocked?:boolean }) => store.recordWorkerStates(projectId, new Map([['worker',state]]));
  observe({status:'running'}); observe({status:'running'});
  assert.equal(observe({status:'disconnected'}).tickets[0].sessionStatuses.worker,'running');
  observe({blocked:true}); update({stage:'Review'});
  observe({blocked:false,status:'completed'});
  assert.throws(() => update({assignee:{kind:'bridge',bridgeId:'studio'}, parentTicketId:ticketId}), /ancestor/);
  const restarted = new ProjectBoardStore(dir,'home');
  const events = restarted.pendingNotifications(projectId);
  assert.deepEqual(events.map(({bridgeId,stage,reason}) => [bridgeId,stage,reason]), [
    ['desk','Backlog','assignment'], ['desk','In progress','stage'], ['desk','Blocked','stage'], ['desk','Review','stage'],
  ]);
  restarted.acknowledgeNotification(projectId,events[0].id);
  restarted.acknowledgeNotification(projectId,events[0].id);
  assert.deepEqual(store.pendingNotifications(projectId).map(e=>e.id),events.slice(1).map(e=>e.id));
  update({assignee:{kind:'user'}}); update({stage:'Done'});
  assert.equal(store.pendingNotifications(projectId).length,3);
});

test('large project responses fit the wire budget and reject mixed-revision pages', () => {
  const ticket = { id: '', title: 'Fix', stage: 'Review' as const, blocked: false, body: '', parentTicketId: null, assignee: null, commentCount: 0, sessionStatuses: {},
    sessionIds: Array.from({length: 450}, () => randomUUID()) };
  const board: ProjectBoard = { boardEnabled: true, columns: [{id: 'Review', label: 'Review'}], project: { id: randomUUID(), name: 'Infra', bridgeId: 'home' },
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

test('maximum escaped ticket and comment text still fit a sealed command response page', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-ticket-page-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ProjectBoardStore(dir, 'home');
  const projectId = randomUUID(), ticketId = randomUUID();
  const base = { bridgeId: 'home', projectId };
  const initial = store.mutate({ ...base, action: 'create_project', name: 'Work' });
  const columns = Array.from({ length: 32 }, (_, i) => ({ id: randomUUID(), label: '驗'.repeat(62) + String(i).padStart(2, '0') }));
  store.mutate({ ...base, action: 'configure_columns', previousColumns: initial.columns, columns });
  const sessionIds = Array.from({ length: 500 }, (_, index) => String(index).padStart(200, 'x'));
  const body = '\t'.repeat(32 * 1024);
  const create = { ...base, action: 'create_ticket', ticketId, title: '\u0001'.repeat(511) + '!', body, sessionIds,
    assignee: {kind:'bridge', bridgeId:'b'.repeat(256)} };
  store.mutate(create);
  const next = randomUUID();
  store.mutate({ ...create, ticketId: next, sessionIds: [] });
  const board = store.recordWorkerStates(projectId, new Map(sessionIds.map(id => [id, { status: 'completed' as const }])));
  const first = projectBoardPage(board);
  assert.deepEqual(first.tickets.map(ticket => ticket.id), [ticketId]);
  assert.deepEqual(first.columns, columns);
  const bytes = (response: unknown) => Buffer.byteLength(JSON.stringify({ type: 'command_response', response: {
    requestId: randomUUID(), success: true, data: response,
  } }));
  assert.ok(bytes(first) < 300_000);
  const cursor = 'nextCursor' in first ? first.nextCursor : undefined;
  assert.ok(cursor);
  assert.deepEqual(projectBoardPage(board,cursor).tickets.map(ticket => ticket.id), [next]);
  const add = { ...base, ticketId, action: 'add_ticket_comment', text: '\t'.repeat(8 * 1024 - 1) + '!' };
  for (let i = 0; i < 11; i++) store.mutate({ ...add, commentId: randomUUID() }, 'a'.repeat(256));
  const page = store.comments(projectId,ticketId);
  assert.equal(page.comments.length, 10);
  assert.ok(bytes(page) < 300_000);
  assert.equal(store.comments(projectId,ticketId,page.nextAfter).comments.length, 1);
  assert.throws(() => store.mutate({ ...create, body: '\u0001'.repeat(32 * 1024) }), /Invalid project change/);
  assert.throws(() => store.mutate({ ...add, commentId: randomUUID(), text: '\u0001'.repeat(8 * 1024) }, 'me'), /Invalid project change/);
});

test('project catalog and board reads are available to readers and board changes require control', () => {
  assert.equal(classifyCommand('list_projects').permission, 'read');
  assert.equal(classifyCommand('get_project_board').permission, 'read');
  const write = classifyCommand('mutate_project_board');
  assert.equal(write.permission, 'control');
  assert.equal(write.mutating, true);
});

test('column edits migrate occupied stages atomically and preserve worker behavior under renames', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-board-columns-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ProjectBoardStore(dir, 'home');
  const projectId = randomUUID(), ticketId = randomUUID(), customId = randomUUID();
  const change = (action: string, payload: Record<string, unknown> = {}) => store.mutate({ bridgeId: 'home', projectId, action, ...payload });
  const original = change('create_project', { name: 'Work' }).columns;
  const columns = [{ id: customId, label: 'Ideas' }, ...original.map(c => c.id === 'Blocked' ? { ...c, label: 'Needs help' } : c)];
  change('configure_columns', { previousColumns: original, columns });
  assert.equal(change('create_ticket', { ticketId, title: 'Ship', assignee: { kind: 'bridge', bridgeId: 'home' }, sessionIds: ['worker'] }).tickets[0].stage, customId);
  assert.throws(() => change('configure_columns', { previousColumns: original, columns: original }), /Reload/);
  assert.throws(() => change('configure_columns', { previousColumns: columns, columns: original }), /destination/);
  assert.deepEqual(store.read(projectId).columns, columns);

  const dropCustom = columns.slice(1);
  change('configure_columns', { previousColumns: columns, columns: dropCustom, moveTo: { [customId]: 'Backlog' } });
  const state = (status: 'running'|'completed', blocked: boolean) => store.recordWorkerStates(projectId, new Map([['worker', { status, blocked }]]));
  assert.equal(state('running', true).tickets[0].stage, 'In progress');
  assert.deepEqual(store.pendingNotifications(projectId).map(e => e.stage), ['Ideas', 'Backlog', 'Needs help']);
  const noRoles = dropCustom.filter(c => c.id !== 'Blocked' && c.id !== 'In progress');
  change('configure_columns', { previousColumns: dropCustom, columns: noRoles, moveTo: { 'In progress': 'Backlog' } });
  state('completed', false);
  assert.equal(state('running', true).tickets[0].stage, 'Backlog');
  assert.throws(() => change('update_ticket', { ticketId, stage: 'Blocked' }), /Unknown board column/);
  assert.deepEqual(new ProjectBoardStore(dir, 'home').read(projectId).columns, noRoles);
});

test('deleting and recreating a board preserves its project and rejects replayed ticket creation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-board-lifecycle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ProjectBoardStore(dir, 'home');
  const projectId = randomUUID(), ticketId = randomUUID();
  const change = (action: string, payload: Record<string, unknown> = {}) => store.mutate({ bridgeId: 'home', projectId, action, ...payload });
  const initial = change('create_project', { name: 'Work' });
  const ticket = { ticketId, title: 'Ship', sessionIds: ['worker'], assignee: { kind: 'bridge', bridgeId: 'home' } };
  change('create_ticket', ticket);
  store.mutate({ bridgeId: 'home', projectId, action: 'add_ticket_comment', ticketId, commentId: randomUUID(), text: 'Ready' }, 'Operator');
  change('delete_board');
  const reader = new ProjectBoardStore(dir, 'home');
  assert.deepEqual(reader.list(), [initial.project]);
  assert.deepEqual(reader.read(projectId), { project: initial.project, boardEnabled: false, columns: [], tickets: [] });
  assert.deepEqual(reader.pendingNotifications(projectId), []);
  assert.throws(() => reader.comments(projectId, ticketId), /not found/);
  assert.throws(() => change('create_ticket', { ...ticket, ticketId: randomUUID() }), /Board has been deleted/);
  assert.equal(change('rename_project', { name: 'Release' }).boardEnabled, false);
  assert.deepEqual(change('create_board').columns, initial.columns);
  assert.throws(() => change('create_ticket', ticket), /deleted/);
  change('create_ticket', { ...ticket, ticketId: randomUUID() });
  assert.equal(change('create_board').tickets.length, 1);
});
