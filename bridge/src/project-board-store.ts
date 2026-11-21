import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Session } from './types.js';
import type { ProjectDirectoryEntry } from './project-directory-protocol.js';
import type { AttentionStore } from './attention-store.js';

const id = z.uuid().refine(value => value === value.toLowerCase(), 'Expected a lowercase UUID');
const name = z.string().trim().min(1).max(256);
const stage = z.enum(['Backlog', 'In progress', 'Blocked', 'Review', 'Done']);
const sessionId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const title = z.string().trim().min(1).max(512);
const projectTarget = z.object({ bridgeId: z.string(), projectId: id });
const change = z.discriminatedUnion('action', [
  projectTarget.extend({ action: z.literal('create_project'), name }).strict(),
  projectTarget.extend({ action: z.literal('rename_project'), name }).strict(),
  projectTarget.extend({ action: z.literal('delete_project') }).strict(),
  projectTarget.extend({ action: z.literal('create_ticket'), ticketId: id, title, stage: stage.optional(),
    sessionIds: z.array(sessionId).max(500).optional() }).strict(),
  projectTarget.extend({ action: z.literal('update_ticket'), ticketId: id, title: title.optional(), stage: stage.optional(),
    addSessionId: sessionId.optional(), removeSessionId: sessionId.optional() }).strict(),
]);

export type HomeProject = ProjectDirectoryEntry;
interface Ticket { id: string; title: string; stage: z.infer<typeof stage>; sessionIds: string[]; blocked: boolean }
export interface ProjectBoard { project: HomeProject; tickets: Ticket[] }

/** Keep each command answer within the encrypted transport budget; a cursor pins the contents across requests. */
export function projectBoardPage(board: ProjectBoard, cursor?: unknown) {
  const encoded = JSON.stringify(board);
  const pageBytes = 200_000;
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
  let bytes = 0;
  const tickets: Ticket[] = [];
  for (const ticket of board.tickets.slice(offset)) {
    const size = Buffer.byteLength(JSON.stringify(ticket)) + 1;
    if (bytes + size > pageBytes) break;
    tickets.push(ticket);
    bytes += size;
  }
  const next = offset + tickets.length;
  return { project: board.project, tickets, ...(next < board.tickets.length ? { nextCursor: hash + ':' + next } : {}) };
}

export class ProjectBoardChanged extends Error {
  constructor() { super('The board changed while loading. Refresh the board.'); }
}

export async function sessionBlocksTicket(session: Session, attention: AttentionStore): Promise<boolean> {
  if (session.block) return true;
  if (session.status !== 'pending' && session.status !== 'running') return false;
  return !!(await attention.explicitSnapshot(session.id)).attention;
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
    const db = new DatabaseSync(path, { readOnly });
    try { return fn(db); } finally { db.close(); }
  }

  list(): HomeProject[] {
    if (!existsSync(this.root)) return [];
    const projects: HomeProject[] = [];
    for (const dir of readdirSync(this.root, { withFileTypes: true })) {
      if (!dir.isDirectory() || !id.safeParse(dir.name).success) continue;
      const row = this.withDb(dir.name, true, db => db.prepare('SELECT name FROM project WHERE deleted = 0').get());
      if (row) projects.push({ id: dir.name, name: String(row.name), bridgeId: this.bridgeId });
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  private initialize(projectId: string, projectName: string): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(this.root, '.creating-'));
    try {
      const db = new DatabaseSync(join(dir, 'board.sqlite'));
      try {
        db.exec(`
          CREATE TABLE project (name TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE tickets (id TEXT PRIMARY KEY, title TEXT NOT NULL, stage TEXT NOT NULL);
          CREATE TABLE ticket_sessions (
            session_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id), blocked INTEGER NOT NULL DEFAULT 0
          );
        `);
        db.prepare('INSERT INTO project (name) VALUES (?)').run(projectName);
      } finally { db.close(); }
      renameSync(dir, join(this.root, projectId));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  private snapshot(db: DatabaseSync, projectId: string): ProjectBoard {
    const meta = db.prepare('SELECT name FROM project WHERE deleted = 0').get();
    if (!meta) throw new Error('Project has been deleted');
    const tickets = new Map<string, Ticket>();
    for (const row of db.prepare('SELECT id, title, stage FROM tickets ORDER BY rowid').all()) {
      const ticket: Ticket = { id: String(row.id), title: String(row.title), stage: stage.parse(row.stage), sessionIds: [], blocked: false };
      tickets.set(ticket.id, ticket);
    }
    for (const row of db.prepare('SELECT session_id, ticket_id, blocked FROM ticket_sessions ORDER BY rowid').all()) {
      const ticket = tickets.get(String(row.ticket_id))!;
      ticket.sessionIds.push(String(row.session_id));
      if (row.blocked) ticket.blocked = true;
    }
    return { project: { id: projectId, name: String(meta.name), bridgeId: this.bridgeId }, tickets: [...tickets.values()] };
  }

  read(projectId: string): ProjectBoard {
    return this.withDb(projectId, true, db => this.snapshot(db, projectId));
  }

  /** Keep the last owner observation for linked workers whose bridges are unreachable. */
  recordBlockers(projectId: string, observations: ReadonlyMap<string, boolean>): ProjectBoard {
    return this.withDb(projectId, false, db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const set = db.prepare('UPDATE ticket_sessions SET blocked=? WHERE session_id=? AND blocked<>?');
        for (const [session, blocked] of observations) set.run(Number(blocked), session, Number(blocked));
        const board = this.snapshot(db, projectId);
        db.exec('COMMIT');
        return board;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }

  mutate(payload: unknown): ProjectBoard {
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
        const project = db.prepare('SELECT name, deleted FROM project').get()!;
        if (project.deleted && m.action !== 'delete_project') throw new Error('Project has been deleted');
        if (m.action === 'delete_project') {
          db.exec('UPDATE project SET deleted=1; DELETE FROM ticket_sessions; DELETE FROM tickets; COMMIT');
          return { project: { id: m.projectId, name: String(project.name), bridgeId: this.bridgeId }, tickets: [] };
        }
        if (m.action === 'rename_project') db.prepare('UPDATE project SET name=?').run(m.name);
        const link = db.prepare('INSERT INTO ticket_sessions (session_id, ticket_id) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET ticket_id=excluded.ticket_id');
        if (m.action === 'create_ticket') {
          const result = db.prepare('INSERT INTO tickets VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').run(m.ticketId, m.title, m.stage ?? 'Backlog');
          if (result.changes) for (const session of m.sessionIds ?? []) link.run(session, m.ticketId);
        }
        if (m.action === 'update_ticket') {
          if (!db.prepare('SELECT 1 FROM tickets WHERE id=?').get(m.ticketId)) throw new Error('Ticket not found');
          if (m.title !== undefined) db.prepare('UPDATE tickets SET title=? WHERE id=?').run(m.title, m.ticketId);
          if (m.stage !== undefined) db.prepare('UPDATE tickets SET stage=? WHERE id=?').run(m.stage, m.ticketId);
          if (m.removeSessionId) db.prepare('DELETE FROM ticket_sessions WHERE ticket_id=? AND session_id=?').run(m.ticketId, m.removeSessionId);
          if (m.addSessionId) {
            link.run(m.addSessionId, m.ticketId);
            const count = db.prepare('SELECT count(*) AS total FROM ticket_sessions WHERE ticket_id=?').get(m.ticketId)!;
            if (Number(count.total) > 500) throw new Error('A ticket can link up to 500 sessions');
          }
        }
        const board = this.snapshot(db, m.projectId);
        db.exec('COMMIT');
        return board;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }
}
