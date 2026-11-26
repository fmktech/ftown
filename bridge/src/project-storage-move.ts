import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import {
  initializeProjectDatabase,
  supportedProjectVersion,
  type HomeProject,
  type ProjectBoardStore,
} from './project-board-store.js';
import { PROJECT_MOVE } from './project-directory-protocol.js';
import type { PeerControl } from './peer-control.js';

// Only application data crosses the link. Each destination builds indexes, constraints and
// tables with its installed schema. Never execute SQL or install a database file supplied by a peer.
const tables = [
  'project',
  'board_columns',
  'tickets',
  'comments',
  'ticket_sessions',
  'deleted_tickets',
  'unlinked_sessions',
  'notification_outbox',
  'discussion_channels',
  'discussion_threads',
  'discussion_posts',
  'discussion_followers',
  'discussion_mail',
  'sqlite_sequence',
] as const;
const uuid = z.uuid().refine((s) => s === s.toLowerCase());
const base = z.object({ projectId: uuid, operation: uuid, revision: z.number().int().positive() });
const schema = z.discriminatedUnion('action', [
  base
    .extend({
      action: z.literal('begin'),
      version: z.literal(supportedProjectVersion),
      name: z.string().trim().min(1).max(256),
    })
    .strict(),
  base
    .extend({
      action: z.literal('rows'),
      batch: z.number().int().nonnegative(),
      table: z.enum(tables),
      rows: z
        .array(z.array(z.union([z.string(), z.number().int(), z.null()])).max(30))
        .min(1)
        .max(128),
    })
    .strict(),
  base.extend({ action: z.literal('commit'), batches: z.number().int().nonnegative() }).strict(),
  base.extend({ action: z.literal('discard') }).strict(),
]);
type Request = z.infer<typeof schema>;
type Manifest = { projectId: string; operation: string; revision: number };
type Home = { revision: number; phase: string; operation: string | null; target: string | null; batches: number };
class DestinationRefused extends Error {}

type Peer = Pick<PeerControl, 'connectDirect' | 'directHttp'> & { resolve(selector: string): { bridgeId: string } };

function database<T>(path: string, fn: (db: DatabaseSync) => T, readOnly = false): T {
  const db = new DatabaseSync(path, { readOnly });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// SQLite syncs the contents. Persist the directory entries that publish the DB
// before the source may retire its copy. Windows does not expose directory fsync.
function syncPublication(file: string) {
  if (process.platform === 'win32') return;
  for (const path of [dirname(file), dirname(dirname(file))]) {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function columnsFor(db: DatabaseSync, table: (typeof tables)[number]): string[] {
  return db
    .prepare('PRAGMA table_info(' + table + ')')
    .all()
    .map((row) => String(row.name))
    .sort();
}

function home(db: DatabaseSync): Home {
  return db.prepare('SELECT * FROM project_home').get() as unknown as Home;
}

function receipt(db: DatabaseSync, origin: string, destination: string, m: Manifest): boolean {
  return !!db
    .prepare('SELECT 1 FROM project_move_receipts WHERE operation=? AND origin=? AND destination=? AND revision=?')
    .get(m.operation, origin, destination, m.revision);
}

export class ProjectStorageMoves {
  private readonly projects: string;
  private readonly sending = new Map<string, { target: string; promise: Promise<HomeProject> }>();

  constructor(
    dataDir: string,
    private readonly local: string,
    private readonly store: ProjectBoardStore,
    private readonly peers: Peer,
    private readonly rememberMove?: (project: HomeProject) => Promise<void>,
  ) {
    this.projects = join(dataDir, 'projects');
  }

  private file(id: string): string {
    return join(this.projects, uuid.parse(id), 'board.sqlite');
  }
  private stage(id: string, operation: string): string {
    return join(this.projects, '.receiving', uuid.parse(id), operation, 'board.sqlite');
  }

  // A source remains fenced across a restart until the destination acknowledges activation.
  // In particular, a lost commit response must never make the old home writable.
  move(id: string, targetSelector: string): Promise<HomeProject> {
    if (targetSelector === this.local) {
      const project = this.store.list().find((entry) => entry.id === id);
      if (!project || this.sending.has(id)) throw new Error('Project is unavailable on this bridge');
      const state = database(
        this.file(id),
        (db) => (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='project_home'").get() ? home(db) : undefined),
        true,
      );
      if (state && state.phase !== 'active') throw new Error('A storage move is in progress');
      return Promise.resolve(project);
    }
    const target = this.peers.resolve(targetSelector).bridgeId;
    const current = this.sending.get(id);
    if (current) {
      if (current.target !== target) throw new Error('A move to another bridge is in progress');
      return current.promise;
    }
    const promise = this.transfer(id, target).finally(() => this.sending.delete(id));
    this.sending.set(id, { target, promise });
    return promise;
  }

  // Bound each browser or forwarded CLI request while a large project crosses
  // the link. Polls join the existing transfer and never restart a rejected copy.
  async waitForMove(
    id: string,
    target: string,
    polling: boolean,
  ): Promise<{ project: HomeProject } | { moving: true }> {
    if (polling && !this.sending.has(id)) {
      const state = database(this.file(id), (db) => home(db), true);
      if (state.phase === 'active') throw new Error('Project transfer stopped before cutover. Retry the move.');
    }
    const completed = this.move(id, target).then((project) => ({ project }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        completed,
        new Promise<{ moving: true }>((resolve) => {
          timer = setTimeout(() => resolve({ moving: true }), 3_000);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async transfer(projectId: string, target: string): Promise<HomeProject> {
    const file = this.file(projectId);
    if (!existsSync(file)) throw new Error('Project not found on this bridge');
    // Upgrade existing project files through the normal schema owner.
    const listed = this.store.list().find((project) => project.id === projectId);
    if (listed) this.store.projectName(projectId);
    const initial = database(file, (db) => home(db), true);
    if (initial.phase !== 'active' && initial.target !== target)
      throw new Error('Project has a different storage destination');
    if (!listed && initial.phase !== 'moved') throw new Error('Project has been deleted');
    const name = database(file, (db) => String(db.prepare('SELECT name FROM project').get()!.name), true);
    if (initial.phase === 'moved') return { id: projectId, name, bridgeId: target, homeRevision: initial.revision };
    if (!(await this.peers.connectDirect(target)))
      throw new Error('The destination bridge must be online with a direct connection');

    const m = database(file, (db) =>
      transaction(db, () => {
        const row = db.prepare('SELECT name FROM project WHERE deleted=0').get();
        if (!row || row.name !== name) throw new Error('Project changed before the move. Retry.');
        const state = home(db);
        if (state.phase !== 'active' && state.target !== target) throw new Error('Another move is in progress');
        const operation = state.operation && state.phase !== 'active' ? state.operation : randomUUID();
        if (state.phase !== 'committing')
          db.prepare("UPDATE project_home SET phase='copying', operation=?, target=?, batches=0").run(
            operation,
            target,
          );
        return { projectId, operation, revision: state.revision + 1 };
      }),
    );
    const send = async (request: Request) => {
      const response = await this.peers.directHttp(target, PROJECT_MOVE, request);
      if (response.status !== 200) {
        const reason = z.object({ error: z.string() }).safeParse(response.body);
        throw new DestinationRefused(
          reason.success ? reason.data.error : 'Destination refused project storage move',
        );
      }
      if (
        !(
          response.body &&
          typeof response.body === 'object' &&
          'operation' in response.body &&
          response.body.operation === m.operation
        )
      )
        throw new Error('Destination did not confirm the project move');
    };
    let batches = initial.batches;
    if (initial.phase !== 'committing') {
      try {
        await send({ ...m, action: 'begin', version: supportedProjectVersion, name });
        batches = 0;
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          for (const table of tables) {
            let rows: (string | number | null)[][] = [];
            let bytes = 0;
            const columns = columnsFor(db, table);
            for (const row of db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').iterate()) {
              const values = columns.map((column) => row[column]) as (string | number | null)[];
              const size = Buffer.byteLength(JSON.stringify(values));
              if (rows.length && (bytes + size > 64 * 1024 || rows.length >= 128)) {
                await send({ ...m, action: 'rows', batch: batches++, table, rows });
                rows = [];
                bytes = 0;
              }
              rows.push(values);
              bytes += size;
            }
            if (rows.length) await send({ ...m, action: 'rows', batch: batches++, table, rows });
          }
        } finally {
          db.close();
        }
        database(file, (db) =>
          db
            .prepare("UPDATE project_home SET phase='committing', batches=? WHERE operation=?")
            .run(batches, m.operation),
        );
      } catch (error) {
        database(file, (db) =>
          db
            .prepare(
              "UPDATE project_home SET phase='active', operation=NULL,target=NULL WHERE operation=? AND phase='copying'",
            )
            .run(m.operation),
        );
        // Staging is invisible. A retry can replace a partial copy even if the peer just went offline.
        void send({ ...m, action: 'discard' }).catch(() => {});
        throw error;
      }
    }
    try {
      await send({ ...m, action: 'commit', batches });
    } catch (error) {
      if (error instanceof DestinationRefused) {
        // A confirmed discard prevents any delayed commit for this operation from activating.
        // If the receipt exists or either reply is lost, the original stays fenced.
        await send({ ...m, action: 'discard' });
        database(file, (db) =>
          db
            .prepare(
              "UPDATE project_home SET phase='active',operation=NULL,target=NULL WHERE operation=? AND phase='committing'",
            )
            .run(m.operation),
        );
      }
      throw error;
    }
    database(file, (db) => {
      transaction(db, () => {
        db.exec('PRAGMA defer_foreign_keys=ON');
        for (const table of [...tables].reverse()) if (table !== 'project') db.exec('DELETE FROM ' + table);
        db.exec('UPDATE project SET deleted=1');
        db.prepare("UPDATE project_home SET phase='moved',revision=? WHERE operation=?").run(
          m.revision,
          m.operation,
        );
      });
      // Retirement is already durable. Compaction can need additional free space.
      try {
        db.exec('VACUUM');
      } catch {
        console.warn('Could not compact retired project storage', projectId);
      }
    });
    const project = { id: projectId, name, bridgeId: target, homeRevision: m.revision };
    // Once committed, a discovery-cache write failure is recoverable on refresh.
    await this.rememberMove?.(project).catch(() => console.error('Could not cache new project home', projectId));
    return project;
  }

  // Called on the project maintenance interval. A lost final acknowledgement can be recovered
  // without an operator choosing a winner. Copying was never allowed to activate a destination.
  recover(projectId: string): void {
    if (this.sending.has(projectId)) return;
    const file = this.file(projectId);
    const state = database(
      file,
      (db) => (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='project_home'").get() ? home(db) : undefined),
      true,
    );
    if (state?.phase === 'copying') {
      database(file, (db) =>
        db.exec("UPDATE project_home SET phase='active',operation=NULL,target=NULL WHERE phase='copying'"),
      );
    } else if (state?.phase === 'committing' && state.target) {
      void Promise.resolve()
        .then(() => this.move(projectId, state.target!))
        .catch(() => {});
    }
  }

  receive(origin: string, value: unknown): { operation: string } {
    const m = schema.parse(value);
    const file = this.file(m.projectId);
    const stage = this.stage(m.projectId, m.operation);
    const accepted = { operation: m.operation };
    if (existsSync(file)) {
      const previous = database(
        file,
        (db) => {
          if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='project_home'").get()) return null;
          if (receipt(db, origin, this.local, m)) return 'received';
          const state = home(db);
          return state.phase === 'moved' && state.revision < m.revision ? 'available' : null;
        },
        true,
      );
      if (previous === 'received' && m.action === 'commit') {
        syncPublication(file);
        return accepted;
      }
      // A concurrent local create can occupy the ID between begin and commit.
      // Discard still closes our unpublished staging operation in that case.
      if (previous !== 'available' && (m.action !== 'discard' || previous === 'received'))
        throw new Error('Destination already has this project');
    }
    if (m.action === 'begin') {
      if (this.store.list().some((project) => project.name === m.name))
        throw new Error('Destination already has a project with this name');
      mkdirSync(dirname(dirname(stage)), { recursive: true, mode: 0o700 });
      for (const entry of readdirSync(dirname(dirname(stage)), { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === m.operation) continue;
        const dir = join(dirname(dirname(stage)), entry.name);
        const previous = join(dir, 'board.sqlite');
        if (!existsSync(previous) || database(previous, (db) => home(db).target === origin, true))
          rmSync(dir, { recursive: true, force: true });
      }
      mkdirSync(dirname(stage), { recursive: true, mode: 0o700 });
      if (existsSync(stage)) {
        const owner = database(stage, (db) => home(db).target, true);
        if (owner !== origin) throw new Error('Another bridge is transferring this project');
      }
      const fresh = stage + '.new';
      rmSync(fresh, { force: true });
      database(fresh, (db) => {
        initializeProjectDatabase(db, m.name);
        db.exec('PRAGMA foreign_keys=OFF');
        for (const table of tables) db.exec('DELETE FROM ' + table);
        db.prepare("UPDATE project_home SET revision=?, phase='receiving', operation=?, target=?").run(
          m.revision,
          m.operation,
          origin,
        );
      });
      renameSync(fresh, stage);
      return accepted;
    }
    if (!existsSync(stage)) {
      if (m.action === 'discard') return accepted;
      throw new Error('Transfer staging is unavailable');
    }
    const commit = database(stage, (db) => {
      const state = home(db);
      if (state.operation !== m.operation || state.target !== origin || state.revision !== m.revision)
        throw new Error('Different storage move in progress');
      if (m.action === 'discard') return false;
      if (m.action === 'rows') {
        if (m.batch !== state.batches || state.phase !== 'receiving') throw new Error('Unexpected storage batch');
        db.exec('PRAGMA foreign_keys=OFF');
        transaction(db, () => {
          const columns = columnsFor(db, m.table);
          const placeholders = columns.map(() => '?').join(',');
          const insert = db.prepare(`INSERT INTO ${m.table} (${columns.join(',')}) VALUES (${placeholders})`);
          // Recreate high-water marks even when the last row was deleted.
          if (m.table === 'sqlite_sequence') db.exec('DELETE FROM sqlite_sequence');
          for (const row of m.rows) insert.run(...(row as SQLInputValue[]));
          db.exec('UPDATE project_home SET batches=batches+1');
        });
        return false;
      }
      if (m.batches !== state.batches) throw new Error('Incomplete project copy');
      const projects = db.prepare('SELECT name,deleted FROM project').all();
      if (
        projects.length !== 1 ||
        projects[0].deleted !== 0 ||
        typeof projects[0].name !== 'string' ||
        db.prepare('PRAGMA foreign_key_check').get()
      )
        throw new Error('Invalid project copy');
      if (this.store.list().some((p) => p.id !== m.projectId && p.name === projects[0].name))
        throw new Error('Destination project name is already in use');
      transaction(db, () => {
        if (existsSync(file))
          database(
            file,
            (old) => {
              for (const r of old.prepare('SELECT * FROM project_move_receipts').all())
                db.prepare('INSERT OR IGNORE INTO project_move_receipts VALUES(?,?,?,?)').run(
                  r.operation,
                  r.origin,
                  r.destination,
                  r.revision,
                );
            },
            true,
          );
        db.prepare('INSERT OR IGNORE INTO project_move_receipts VALUES(?,?,?,?)').run(
          m.operation,
          origin,
          this.local,
          m.revision,
        );
        db.exec("UPDATE project_home SET phase='active'");
      });
      return true;
    });
    if (commit) {
      if (existsSync(dirname(file))) {
        renameSync(stage, file);
        rmSync(dirname(stage), { recursive: true, force: true });
      } else renameSync(dirname(stage), dirname(file));
      syncPublication(file);
    } else if (m.action === 'discard') rmSync(dirname(stage), { recursive: true, force: true });
    return accepted;
  }
}
