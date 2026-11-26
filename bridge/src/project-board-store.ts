import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { boardColumnId as stage, boardColumns, defaultBoardColumns, type BoardColumn } from './board-columns.js';
import type { Session } from './types.js';
import type { ProjectDirectoryEntry } from './project-directory-protocol.js';
import type { AttentionStore } from './attention-store.js';
import { initializeDiscussion, readDiscussion, writeDiscussion, type DiscussionMail } from './project-discussion.js';
import type { DiscussionAuthor } from './project-discussion-protocol.js';
import type { TicketNotice } from './ticket-notification-protocol.js';

const id = z.uuid().refine(value => value === value.toLowerCase(), 'Expected a lowercase UUID');
const name = z.string().trim().min(1).max(256);
const sessionId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const title = z.string().trim().min(1).max(512);
const assignee = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('bridge'), bridgeId: z.string().trim().min(1).max(256) }).strict(),
]).nullable();
// Keep rich text, newlines and tabs; exclude control characters outside the Markdown text format.
function markdown(bytes: number) {
  return z.string().regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f]*$/u).refine(text => Buffer.byteLength(text) <= bytes);
}
const ticketFields = { body: markdown(32 * 1024).optional(), assignee: assignee.optional(), parentTicketId: id.nullable().optional() };
const projectTarget = z.object({ bridgeId: z.string(), projectId: id });
const change = z.discriminatedUnion('action', [
  projectTarget.extend({ action: z.literal('create_project'), name }).strict(),
  projectTarget.extend({ action: z.literal('rename_project'), name }).strict(),
  projectTarget.extend({ action: z.literal('delete_project') }).strict(),
  projectTarget.extend({ action: z.literal('create_board') }).strict(),
  projectTarget.extend({ action: z.literal('delete_board') }).strict(),
  projectTarget.extend({ action: z.literal('configure_columns'), columns: boardColumns, previousColumns: boardColumns,
    moveTo: z.record(z.string(), stage).optional() }).strict(),
  projectTarget.extend({ ...ticketFields, action: z.literal('create_ticket'), ticketId: id, title, stage: stage.optional(),
    sessionIds: z.array(sessionId).max(500).optional() }).strict(),
  projectTarget.extend({ ...ticketFields, action: z.literal('update_ticket'), ticketId: id, title: title.optional(), stage: stage.optional(),
    addSessionId: sessionId.optional(), removeSessionId: sessionId.optional() }).strict(),
  projectTarget.extend({ action: z.literal('add_ticket_comment'), ticketId: id, commentId: id,
    text: markdown(8 * 1024).refine(value => !!value.trim()) }).strict(),
  projectTarget.extend({ action: z.literal('delete_ticket'), ticketId: id }).strict(),
]);

export type HomeProject = ProjectDirectoryEntry;
type ProjectWorker = Pick<Session, 'id' | 'bridgeId' | 'parentSessionId' | 'parentBridgeId' | 'projectName'>;
type Stage = z.infer<typeof stage>;
type Assignee = z.infer<typeof assignee>;
export type TicketNotification = TicketNotice & { seq: number };
interface Ticket {
  id: string; title: string; body: string; stage: Stage; assignee: Assignee; parentTicketId: string | null;
  sessionIds: string[]; sessionStatuses: Record<string, Session['status']>; blocked: boolean; commentCount: number;
}
type WorkerState = { blocked?: boolean; status?: Session['status'] | 'disconnected' };
type Routing = { destination: string | null; stage: Stage };
export interface ProjectBoard { project: HomeProject; boardEnabled: boolean; columns: BoardColumn[]; tickets: Ticket[] }

/** Keep each command answer within the encrypted transport budget; a cursor pins the contents across requests. */
export function projectBoardPage(board: ProjectBoard, cursor?: unknown) {
  const encoded = JSON.stringify(board);
  const pageBytes = 298_000; // Leave room for command and peer response wrappers.
  if (cursor === undefined && Buffer.byteLength(encoded) <= pageBytes) return board;
  const hash = createHash('sha256').update(encoded).digest('hex');
  let offset = 0;
  if (cursor !== undefined) {
    const match = typeof cursor === 'string' && /^([0-9a-f]{64}):([1-9][0-9]{0,9})$/.exec(cursor);
    if (!match) throw new Error('Invalid project board cursor');
    if (match[1] !== hash) throw new ProjectBoardChanged();
    offset = Number(match[2]);
    if (offset >= board.tickets.length) throw new Error('Invalid project board offset');
  }
  let bytes = Buffer.byteLength(JSON.stringify({ ...board, tickets: [] })) + 120;
  const tickets: Ticket[] = [];
  for (const ticket of board.tickets.slice(offset)) {
    const size = Buffer.byteLength(JSON.stringify(ticket)) + 1;
    if (bytes + size > pageBytes) break;
    tickets.push(ticket);
    bytes += size;
  }
  if (!tickets.length && offset < board.tickets.length) throw new Error('Ticket exceeds the board transport limit');
  const next = offset + tickets.length;
  return { ...board, tickets, ...(next < board.tickets.length ? { nextCursor: hash + ':' + next } : {}) };
}

export class ProjectBoardChanged extends Error {
  constructor() { super('The board changed while loading. Refresh the board.'); }
}

export async function sessionBlocksTicket(session: Session, attention: AttentionStore): Promise<boolean> {
  if (session.block) return true;
  if (session.status !== 'pending' && session.status !== 'running') return false;
  return !!(await attention.explicitSnapshot(session.id)).attention;
}

export const supportedProjectVersion = 4;

function projectSchemaVersion(db: DatabaseSync): number {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (version > supportedProjectVersion) {
    throw new Error(`Unsupported project database version ${version}. This bridge supports ${supportedProjectVersion}. Update the project's home bridge to open this board.`);
  }
  if (version < 0) throw new Error(`Invalid project database version ${version}.`);
  return version;
}

/** Upgrade the original board in place; interruption rolls back all schema changes. */
function migrate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = projectSchemaVersion(db);
    if (version === 0) db.exec(`
      ALTER TABLE tickets ADD COLUMN body TEXT NOT NULL DEFAULT '';
      ALTER TABLE tickets ADD COLUMN assignee TEXT;
      ALTER TABLE tickets ADD COLUMN parent_id TEXT REFERENCES tickets(id) ON DELETE SET NULL;
      ALTER TABLE ticket_sessions ADD COLUMN observed_status TEXT;
      CREATE TABLE comments (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        text TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX comments_by_ticket ON comments(ticket_id, seq);
      CREATE INDEX sessions_by_ticket ON ticket_sessions(ticket_id);
      CREATE TABLE deleted_tickets (id TEXT PRIMARY KEY);
      CREATE TABLE notification_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, ticket_id TEXT NOT NULL, payload TEXT NOT NULL);
      PRAGMA user_version=1;
    `);
    if (version <= 1) {
      db.exec('ALTER TABLE project ADD COLUMN board_enabled INTEGER NOT NULL DEFAULT 1; CREATE TABLE board_columns (id TEXT PRIMARY KEY, label TEXT NOT NULL, position INTEGER NOT NULL)');
      replaceColumns(db, defaultBoardColumns);
      db.exec('PRAGMA user_version=2');
    }
    if (version <= 2) {
      initializeDiscussion(db);
      db.exec('PRAGMA user_version=3');
    }
    if (version < 4) db.exec(`
      CREATE TABLE project_home (revision INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'active', operation TEXT, target TEXT, batches INTEGER NOT NULL DEFAULT 0);
      INSERT INTO project_home DEFAULT VALUES;
      CREATE TABLE project_move_receipts (operation TEXT PRIMARY KEY, origin TEXT NOT NULL, destination TEXT NOT NULL, revision INTEGER NOT NULL);
      PRAGMA user_version=4;
    `);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function readColumns(db: DatabaseSync): BoardColumn[] {
  return db.prepare('SELECT id,label FROM board_columns ORDER BY position').all()
    .map(row => ({ id: String(row.id), label: String(row.label) }));
}

function replaceColumns(db: DatabaseSync, columns: BoardColumn[]): void {
  db.exec('DELETE FROM board_columns');
  const insert = db.prepare('INSERT INTO board_columns (id,label,position) VALUES (?,?,?)');
  columns.forEach((column, position) => insert.run(column.id, column.label, position));
}

function configureColumns(db: DatabaseSync, mutation: Extract<z.infer<typeof change>, {action: 'configure_columns'}>): void {
  const saved = readColumns(db);
  const desired = JSON.stringify(mutation.columns);
  if (JSON.stringify(saved) === desired) return; // a retry of a committed edit
  if (JSON.stringify(saved) !== JSON.stringify(mutation.previousColumns)) throw new Error('Board columns changed. Reload before editing.');
  const retained = new Set(mutation.columns.map(column => column.id));
  const removed = saved.filter(column => !retained.has(column.id));
  for (const [source, to] of Object.entries(mutation.moveTo ?? {})) {
    if (!removed.some(column => column.id === source) || !retained.has(to)) throw new Error('Invalid column move destination');
  }
  for (const column of removed) {
    const to = mutation.moveTo?.[column.id];
    if (to) db.prepare('UPDATE tickets SET stage=? WHERE stage=?').run(to, column.id);
    else if (db.prepare('SELECT 1 FROM tickets WHERE stage=? LIMIT 1').get(column.id)) {
      throw new Error('Select a destination for tickets in ' + column.label);
    }
  }
  replaceColumns(db, mutation.columns);
}

function assigneeValue(value: Assignee): string | null {
  return value ? JSON.stringify(value) : null;
}

function routingBefore(db: DatabaseSync): Map<string, Routing> {
  const rows = db.prepare(`
    SELECT t.id, json_extract(t.assignee, '$.bridgeId') AS destination,
      CASE WHEN EXISTS(SELECT 1 FROM board_columns WHERE id='Blocked') AND EXISTS(SELECT 1 FROM ticket_sessions s WHERE s.ticket_id=t.id AND s.blocked=1) THEN 'Blocked' ELSE t.stage END AS stage
    FROM tickets t WHERE t.assignee IS NOT NULL
  `).all();
  return new Map(rows.map(row => [String(row.id), { destination: row.destination === null ? null : String(row.destination), stage: row.stage as Stage }]));
}

function queueChanges(db: DatabaseSync, before: Map<string, Routing>, board: ProjectBoard): void {
  const insert = db.prepare('INSERT INTO notification_outbox(id, ticket_id, payload) VALUES(?, ?, ?)');
  for (const ticket of board.tickets) {
    if (ticket.assignee?.kind !== 'bridge') continue;
    const bridgeId = ticket.assignee.bridgeId;
    const old = before.get(ticket.id);
    const current = ticket.blocked && board.columns.some(column => column.id === 'Blocked') ? 'Blocked' : ticket.stage;
    const reason = old?.destination !== bridgeId ? 'assignment' : old.stage !== current ? 'stage' : undefined;
    if (!reason) continue;
    const event: Omit<TicketNotification, 'seq'> = { id: randomUUID(), projectId: board.project.id, projectName: board.project.name,
      ticketId: ticket.id, title: ticket.title, bridgeId, reason, stage: board.columns.find(column => column.id === current)!.label, createdAt: new Date().toISOString() };
    insert.run(event.id, ticket.id, JSON.stringify(event));
  }
}

function linkWorker(db: DatabaseSync, session: string, ticket: string): void {
  const link = db.prepare(`
    INSERT INTO ticket_sessions (session_id, ticket_id) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET ticket_id=excluded.ticket_id WHERE ticket_id<>excluded.ticket_id
  `).run(session, ticket);
  if (link.changes) {
    db.prepare(`
      UPDATE tickets SET stage='In progress' WHERE id=? AND stage='Backlog' AND EXISTS(SELECT 1 FROM board_columns WHERE id='In progress')
      AND EXISTS(SELECT 1 FROM ticket_sessions WHERE session_id=? AND observed_status='running')
    `).run(ticket, session);
  }
}

function validateParent(db: DatabaseSync, ticketId: string, parentId: string | null | undefined): void {
  if (!parentId) return;
  if (!db.prepare('SELECT 1 FROM tickets WHERE id=?').get(parentId)) throw new Error('Parent ticket not found in this project');
  const cycle = db.prepare(`
    WITH RECURSIVE chain(id, parent_id) AS (
      SELECT id, parent_id FROM tickets WHERE id=?
      UNION SELECT t.id, t.parent_id FROM tickets t JOIN chain c ON t.id=c.parent_id
    ) SELECT 1 FROM chain WHERE id=? LIMIT 1
  `).get(parentId, ticketId);
  if (cycle) throw new Error('A ticket cannot be its own ancestor');
}

export function initializeProjectDatabase(db: DatabaseSync, projectName: string): void {
  db.exec(`
    CREATE TABLE project (name TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE unlinked_sessions (session_id TEXT PRIMARY KEY);
    CREATE TABLE tickets (id TEXT PRIMARY KEY, title TEXT NOT NULL, stage TEXT NOT NULL);
    CREATE TABLE ticket_sessions (
      session_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id), blocked INTEGER NOT NULL DEFAULT 0
    );
  `);
  migrate(db);
  db.prepare('INSERT INTO project (name) VALUES (?)').run(projectName);
}

/** Every visible project directory contains one fully initialized, independently restorable database. */
export class ProjectBoardStore {
  private readonly root: string;
  constructor(dataDir: string, private readonly bridgeId: string) {
    this.root = join(dataDir, 'projects');
  }

  private withDb<T>(projectId: string, readOnly: boolean, fn: (db: DatabaseSync) => T): T {
    if (!id.safeParse(projectId).success) throw new Error('Invalid project ID');
    const path = join(this.root, projectId, 'board.sqlite');
    if (!existsSync(path)) throw new Error('Project not found on this bridge');
    let db = new DatabaseSync(path, { readOnly });
    try {
      const version = projectSchemaVersion(db);
      if (version < supportedProjectVersion) {
        if (readOnly) {
          db.close();
          db = new DatabaseSync(path);
        }
        migrate(db);
      }
      const home = db.prepare('SELECT phase,target FROM project_home').get()!;
      if (home.phase === 'moved') throw new Error('Project storage moved to bridge ' + home.target);
      if (!readOnly && home.phase !== 'active') throw new Error('Project storage is moving. Retry when the move finishes.');
      return fn(db);
    } finally { db.close(); }
  }

  list(): HomeProject[] {
    if (!existsSync(this.root)) return [];
    const projects: HomeProject[] = [];
    for (const dir of readdirSync(this.root, { withFileTypes: true })) {
      if (!dir.isDirectory() || !id.safeParse(dir.name).success) continue;
      // Project discovery uses the original directory metadata, even when a newer
      // home bridge has upgraded the ticket or discussion tables.
      const db = new DatabaseSync(join(this.root, dir.name, 'board.sqlite'), { readOnly: true });
      try {
        const row = db.prepare('SELECT name FROM project WHERE deleted = 0').get();
        if (row) {
          const hasHome = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='project_home'").get();
          const revision = hasHome ? Number(db.prepare('SELECT revision FROM project_home').get()?.revision ?? 0) : 0;
          projects.push({ id: dir.name, name: String(row.name), bridgeId: this.bridgeId, ...(revision ? { homeRevision: revision } : {}) });
        }
      } finally { db.close(); }
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  movedHome(projectId: string): HomeProject | undefined {
    if (!id.safeParse(projectId).success) return;
    const file = join(this.root, projectId, 'board.sqlite');
    if (!existsSync(file)) return;
    const db = new DatabaseSync(file, { readOnly:true });
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='project_home'").get()) return;
      const row = db.prepare("SELECT name, target, revision FROM project,project_home WHERE phase='moved'").get();
      if (row) return {id:projectId, name:String(row.name), bridgeId:String(row.target), homeRevision:Number(row.revision)};
    } finally { db.close(); }
  }

  private initialize(projectId: string, projectName: string): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(this.root, '.creating-'));
    try {
      const db = new DatabaseSync(join(dir, 'board.sqlite'));
      try {
        initializeProjectDatabase(db, projectName);
      } finally { db.close(); }
      renameSync(dir, join(this.root, projectId));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  private snapshot(db: DatabaseSync, projectId: string): ProjectBoard {
    const meta = db.prepare('SELECT name,board_enabled FROM project WHERE deleted = 0').get();
    if (!meta) throw new Error('Project has been deleted');
    const tickets = new Map<string, Ticket>();
    for (const row of db.prepare(`
      SELECT t.*, (SELECT count(*) FROM comments c WHERE c.ticket_id=t.id) AS comment_count FROM tickets t ORDER BY t.rowid
    `).all()) {
      const ticket: Ticket = { id: String(row.id), title: String(row.title), body: String(row.body), stage: stage.parse(row.stage),
        assignee: row.assignee === null ? null : assignee.parse(JSON.parse(String(row.assignee))),
        parentTicketId: row.parent_id === null ? null : String(row.parent_id), commentCount: Number(row.comment_count),
        sessionIds: [], sessionStatuses: Object.create(null), blocked: false };
      tickets.set(ticket.id, ticket);
    }
    for (const row of db.prepare('SELECT session_id, ticket_id, blocked, observed_status FROM ticket_sessions ORDER BY rowid').all()) {
      const ticket = tickets.get(String(row.ticket_id))!;
      const workerId = String(row.session_id);
      ticket.sessionIds.push(workerId);
      if (row.observed_status !== null) ticket.sessionStatuses[workerId] = row.observed_status as Session['status'];
      if (row.blocked) ticket.blocked = true;
    }
    const revision = Number(db.prepare('SELECT revision FROM project_home').get()!.revision);
    return { project: { id: projectId, name: String(meta.name), bridgeId: this.bridgeId, ...(revision ? { homeRevision: revision } : {}) }, boardEnabled: Boolean(meta.board_enabled), columns: readColumns(db), tickets: [...tickets.values()] };
  }

  read(projectId: string): ProjectBoard {
    return this.withDb(projectId, true, db => this.snapshot(db, projectId));
  }

  projectName(projectId: string): string {
    return this.withDb(projectId, true, db => {
      const row = db.prepare('SELECT name FROM project WHERE deleted=0').get();
      if (!row) throw new Error('Project has been deleted');
      return String(row.name);
    });
  }

  discussion(projectId: string, payload: unknown, author?: DiscussionAuthor, writing = false): Record<string, unknown> {
    return this.withDb(projectId, !writing, db => {
      db.exec(writing ? 'BEGIN IMMEDIATE' : 'BEGIN');
      try {
        const project = db.prepare('SELECT name FROM project WHERE deleted=0').get();
        if (!project) throw new Error('Project has been deleted');
        if (writing && !author) throw new Error('A verified discussion author is required');
        const response = writing ? writeDiscussion(db, String(project.name), payload, author!) : readDiscussion(db, payload);
        db.exec('COMMIT');
        return response;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }

  pendingDiscussionMail(projectId: string, after = 0, limit = 100): DiscussionMail[] {
    return this.withDb(projectId, true, db => db.prepare("SELECT * FROM discussion_mail WHERE seq>? AND (SELECT phase FROM project_home)='active' ORDER BY seq LIMIT ?")
      .all(after, limit).map(row => ({
        seq: Number(row.seq), id: String(row.id), threadId: String(row.thread_id), postId: String(row.post_id),
        bridgeId: String(row.bridge_id), sessionId: String(row.session_id), body: String(row.body),
      })));
  }

  acknowledgeDiscussionMail(projectId: string, id: string): void {
    this.withDb(projectId, false, db => { db.prepare('DELETE FROM discussion_mail WHERE id=?').run(id); });
  }

  comments(projectId: string, ticketId: string, after?: number) {
    if (!id.safeParse(ticketId).success || (after !== undefined && (!Number.isSafeInteger(after) || after <= 0))) {
      throw new Error('Invalid ticket comment cursor or ID');
    }
    return this.withDb(projectId, true, db => {
      if (!db.prepare('SELECT 1 FROM tickets WHERE id=?').get(ticketId)) throw new Error('Ticket not found');
      const rows = db.prepare(`
        SELECT * FROM comments WHERE ticket_id=? AND seq<? ORDER BY seq DESC LIMIT 11
      `).all(ticketId, after ?? Number.MAX_SAFE_INTEGER);
      const page = rows.slice(0, 10);
      return { comments: page.map(row => ({ id: String(row.id), text: String(row.text), author: String(row.author),
        createdAt: String(row.created_at) })), ...(rows.length > page.length ? { nextAfter: Number(page[page.length - 1].seq) } : {}) };
    });
  }

  pendingNotifications(projectId: string, after = 0, limit = 100): TicketNotification[] {
    return this.withDb(projectId, true, db => db.prepare("SELECT seq, payload FROM notification_outbox WHERE seq>? AND (SELECT phase FROM project_home)='active' ORDER BY seq LIMIT ?")
      .all(after, limit).map(row => ({ ...JSON.parse(String(row.payload)), seq: Number(row.seq) })));
  }

  acknowledgeNotification(projectId: string, eventId: string): void {
    this.withDb(projectId, false, db => { db.prepare('DELETE FROM notification_outbox WHERE id=?').run(eventId); });
  }

  /** A newly observed child inherits its parent's ticket once. Existing and explicitly removed links win. */
  inheritWorkers(projectId: string, sessions: ProjectWorker[]): ProjectBoard {
    return this.withDb(projectId, false, db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const board = this.snapshot(db, projectId);
        const workers = new Map(sessions.map(session => [session.id, session]));
        const children = new Map<string, string[]>();
        for (const worker of sessions) {
          if (worker.projectName !== board.project.name || !worker.parentSessionId || !sessionId.safeParse(worker.id).success) continue;
          const parent = workers.get(worker.parentSessionId);
          if (!parent || (worker.parentBridgeId && worker.parentBridgeId !== parent.bridgeId)) continue;
          const siblings = children.get(parent.id) ?? [];
          siblings.push(worker.id);
          children.set(parent.id, siblings);
        }
        const claimed = new Set(db.prepare('SELECT session_id FROM unlinked_sessions').all().map(row => String(row.session_id)));
        for (const ticket of board.tickets) for (const worker of ticket.sessionIds) claimed.add(worker);
        const insert = db.prepare('INSERT INTO ticket_sessions (session_id, ticket_id) VALUES (?, ?)');
        for (const ticket of board.tickets) {
          // Appending also visits deeper descendants. Claimed ids terminate cycles and preserve explicit assignments.
          for (const parent of ticket.sessionIds) {
            for (const child of children.get(parent) ?? []) {
              if (ticket.sessionIds.length >= 500 || claimed.has(child)) continue;
              insert.run(child, ticket.id);
              ticket.sessionIds.push(child);
              claimed.add(child);
            }
          }
        }
        db.exec('COMMIT');
        return board;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }

  /** Keep the last owner observation for linked workers whose bridges are unreachable. */
  recordWorkerStates(projectId: string, observations: ReadonlyMap<string, WorkerState>): ProjectBoard {
    return this.withDb(projectId, false, db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const before = routingBefore(db);
        const observe = db.prepare(`
          UPDATE ticket_sessions SET blocked=COALESCE(:blocked, blocked), observed_status=COALESCE(:status, observed_status)
          WHERE session_id=:session AND ((:blocked IS NOT NULL AND blocked<>:blocked) OR (:status IS NOT NULL AND observed_status IS NOT :status))
        `);
        const start = db.prepare(`
          UPDATE tickets SET stage='In progress' WHERE stage='Backlog' AND EXISTS(SELECT 1 FROM board_columns WHERE id='In progress') AND id IN
            (SELECT ticket_id FROM ticket_sessions WHERE session_id=? AND observed_status IS NOT 'running')
        `);
        for (const [session, { blocked, status }] of observations) {
          if (status === 'running') start.run(session);
          if (status === 'disconnected') continue;
          observe.run({ blocked: blocked === undefined ? null : Number(blocked), status: status ?? null, session });
        }
        const board = this.snapshot(db, projectId);
        queueChanges(db, before, board);
        db.exec('COMMIT');
        return board;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }

  mutate(payload: unknown, author?: string): ProjectBoard {
    const parsed = change.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid project change');
    const m = parsed.data;
    if (m.bridgeId !== this.bridgeId) throw new Error('Incorrect project home bridge');
    if (m.action === 'create_project' || m.action === 'rename_project') {
      if (this.list().some(project => project.name === m.name && project.id !== m.projectId)) throw new Error('Project name is already in use on this bridge');
      if (m.action === 'create_project' && !existsSync(join(this.root, m.projectId))) this.initialize(m.projectId, m.name);
    }
    return this.withDb(m.projectId, false, db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const project = db.prepare('SELECT name, deleted, board_enabled FROM project').get()!;
        if (project.deleted && m.action !== 'delete_project') throw new Error('Project has been deleted');
        if (m.action === 'delete_project') {
          db.exec('UPDATE project SET deleted=1; DELETE FROM discussion_channels; DELETE FROM notification_outbox; DELETE FROM comments; DELETE FROM ticket_sessions; DELETE FROM unlinked_sessions; DELETE FROM deleted_tickets; DELETE FROM tickets; COMMIT');
          return { project: { id: m.projectId, name: String(project.name), bridgeId: this.bridgeId }, tickets: [], boardEnabled: false, columns: [] };
        }
        if (m.action === 'rename_project') db.prepare('UPDATE project SET name=?').run(m.name);
        const before = routingBefore(db);
        if (m.action === 'delete_board') {
          db.exec(`UPDATE project SET board_enabled=0;
            INSERT OR IGNORE INTO deleted_tickets SELECT id FROM tickets;
            DELETE FROM notification_outbox; DELETE FROM comments; DELETE FROM ticket_sessions;
            DELETE FROM unlinked_sessions; DELETE FROM tickets; DELETE FROM board_columns`);
        } else if (m.action === 'create_board' && !project.board_enabled) {
          db.exec('UPDATE project SET board_enabled=1');
          replaceColumns(db, defaultBoardColumns);
        } else if (!project.board_enabled && m.action !== 'create_project' && m.action !== 'rename_project') {
          throw new Error('Board has been deleted. Create a new board first.');
        }
        if (m.action === 'configure_columns') configureColumns(db, m);
        if ((m.action === 'create_ticket' || m.action === 'update_ticket') && m.stage !== undefined &&
            !db.prepare('SELECT 1 FROM board_columns WHERE id=?').get(m.stage)) throw new Error('Unknown board column');
        if (m.action === 'create_ticket') {
          if (db.prepare('SELECT 1 FROM deleted_tickets WHERE id=?').get(m.ticketId)) throw new Error('Ticket has been deleted');
          if (!db.prepare('SELECT 1 FROM tickets WHERE id=?').get(m.ticketId)) {
            validateParent(db, m.ticketId, m.parentTicketId);
            db.prepare('INSERT INTO tickets (id,title,stage,body,assignee,parent_id) VALUES (?,?,?,?,?,?)')
              .run(m.ticketId, m.title, m.stage ?? readColumns(db)[0].id, m.body ?? '', assigneeValue(m.assignee ?? null), m.parentTicketId ?? null);
            for (const session of m.sessionIds ?? []) linkWorker(db, session, m.ticketId);
          }
        }
        if (m.action === 'delete_ticket') {
          const removed = db.prepare('DELETE FROM tickets WHERE id=? RETURNING id');
          db.prepare('DELETE FROM ticket_sessions WHERE ticket_id=?').run(m.ticketId);
          db.prepare('DELETE FROM notification_outbox WHERE ticket_id=?').run(m.ticketId);
          if (removed.get(m.ticketId)) db.prepare('INSERT INTO deleted_tickets VALUES (?)').run(m.ticketId);
        }
        if (m.action === 'add_ticket_comment') {
          if (!author || author.length > 256) throw new Error('A verified comment author is required');
          if (!db.prepare('SELECT 1 FROM tickets WHERE id=?').get(m.ticketId)) throw new Error('Ticket not found');
          const previous = db.prepare('SELECT ticket_id, text, author FROM comments WHERE id=?').get(m.commentId);
          if (previous && (previous.ticket_id !== m.ticketId || previous.text !== m.text || previous.author !== author)) {
            throw new Error('Comment ID is already in use');
          }
          if (!previous) db.prepare('INSERT INTO comments(id,ticket_id,text,author,created_at) VALUES (?,?,?,?,?)')
            .run(m.commentId,m.ticketId,m.text,author,new Date().toISOString());
        }
        if (m.action === 'update_ticket') {
          if (!db.prepare('SELECT 1 FROM tickets WHERE id=?').get(m.ticketId)) throw new Error('Ticket not found');
          if (m.assignee !== undefined) db.prepare('UPDATE tickets SET assignee=? WHERE id=?').run(assigneeValue(m.assignee), m.ticketId);
          if (m.body !== undefined) db.prepare('UPDATE tickets SET body=? WHERE id=?').run(m.body, m.ticketId);
          if (m.parentTicketId !== undefined) {
            validateParent(db, m.ticketId, m.parentTicketId);
            db.prepare('UPDATE tickets SET parent_id=? WHERE id=?').run(m.parentTicketId, m.ticketId);
          }
          if (m.title !== undefined) db.prepare('UPDATE tickets SET title=? WHERE id=?').run(m.title, m.ticketId);
          if (m.stage !== undefined) db.prepare('UPDATE tickets SET stage=? WHERE id=?').run(m.stage, m.ticketId);
          if (m.removeSessionId) {
            const removed = db.prepare('DELETE FROM ticket_sessions WHERE ticket_id=? AND session_id=?').run(m.ticketId, m.removeSessionId);
            if (removed.changes) db.prepare('INSERT OR IGNORE INTO unlinked_sessions VALUES (?)').run(m.removeSessionId);
          }
          if (m.addSessionId) {
            linkWorker(db, m.addSessionId, m.ticketId);
            db.prepare('DELETE FROM unlinked_sessions WHERE session_id=?').run(m.addSessionId);
            const count = db.prepare('SELECT count(*) AS total FROM ticket_sessions WHERE ticket_id=?').get(m.ticketId)!;
            if (Number(count.total) > 500) throw new Error('A ticket can link up to 500 sessions');
          }
        }
        const board = this.snapshot(db, m.projectId);
        queueChanges(db, before, board);
        db.exec('COMMIT');
        return board;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }
}
