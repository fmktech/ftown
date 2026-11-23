import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { DiscussionAuthor, DiscussionThread, DiscussionPost } from './project-discussion-protocol.js';

const id = z.uuid().refine(value => value === value.toLowerCase());
const channelId = z.union([id, z.literal('general')]);
const name = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Invalid channel name');
const title = z.string().trim().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/);
const text = z.string().regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f]*$/).refine(value => value.trim().length > 0 && Buffer.byteLength(value) <= 8192);
const after = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional();
const session = z.object({ bridgeId: z.string().min(1).max(256), sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) }).strict();
const message = { postId: id, text, mentions: z.array(session).max(64).optional() };
const query = z.discriminatedUnion('action', [
  z.object({ action: z.literal('channels'), after }).strict(),
  z.object({ action: z.literal('threads'), channelId: channelId.optional(), ticketId: id.optional(), after }).strict(),
  z.object({ action: z.literal('thread'), threadId: id }).strict(),
  z.object({ action: z.literal('posts'), channelId: channelId.optional(), threadId: id.optional(), after }).strict(),
]);
const mutation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create_channel'), channelId: id, name }).strict(),
  z.object({ action: z.literal('rename_channel'), channelId, name }).strict(),
  z.object({ action: z.literal('archive_channel'), channelId }).strict(),
  z.object({ action: z.literal('create_thread'), channelId, threadId: id, title, ...message }).strict(),
  z.object({ action: z.literal('reply'), threadId: id, ...message }).strict(),
  z.object({ action: z.enum(['follow', 'unfollow']), threadId: id }).strict(),
  z.object({ action: z.literal('link_ticket'), threadId: id, ticketId: id }).strict(),
  z.object({ action: z.literal('create_ticket'), threadId: id, ticketId: id, title }).strict(),
]);

export interface DiscussionMail {
  seq: number; id: string; sessionId: string; bridgeId: string; threadId: string; postId: string; body: string;
}

export function initializeDiscussion(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE discussion_channels (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL UNIQUE, archived INTEGER NOT NULL DEFAULT 0);
    INSERT INTO discussion_channels(id,name) VALUES ('general','general');
    CREATE TABLE discussion_threads (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL REFERENCES discussion_channels(id) ON DELETE CASCADE,
      title TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL, ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL);
    CREATE INDEX discussion_threads_channel ON discussion_threads(channel_id,seq);
    CREATE INDEX discussion_threads_ticket ON discussion_threads(ticket_id,seq);
    CREATE TABLE discussion_posts (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL REFERENCES discussion_threads(id) ON DELETE CASCADE,
      text TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX discussion_posts_thread ON discussion_posts(thread_id,seq);
    CREATE TABLE discussion_followers (
      thread_id TEXT NOT NULL REFERENCES discussion_threads(id) ON DELETE CASCADE,
      bridge_id TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(thread_id,bridge_id,session_id));
    CREATE TABLE discussion_mail (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL, post_id TEXT NOT NULL REFERENCES discussion_posts(id) ON DELETE CASCADE,
      bridge_id TEXT NOT NULL, session_id TEXT NOT NULL, body TEXT NOT NULL);
  `);
}

type Row = Record<string, unknown>;
function asThread(row: Row): DiscussionThread {
  return { seq: Number(row.seq), id: String(row.id), channelId: String(row.channel_id), title: String(row.title),
    author: JSON.parse(String(row.author)), createdAt: String(row.created_at), ticketId: row.ticket_id === null ? null : String(row.ticket_id) };
}
function asPost(row: Row): DiscussionPost {
  return { seq: Number(row.seq), id: String(row.id), threadId: String(row.thread_id), text: String(row.text),
    author: JSON.parse(String(row.author)), createdAt: String(row.created_at) };
}
function page<T>(rows: Row[], limit: number, field: string, convert: (row: Row) => T): Record<string, unknown> {
  return { [field]: rows.slice(0, limit).map(convert), ...(rows.length > limit ? { nextAfter: Number(rows[limit - 1].seq) } : {}) };
}

export function readDiscussion(db: DatabaseSync, payload: unknown): Record<string, unknown> {
  const q = query.parse(payload);
  if (q.action === 'thread') {
    const row = db.prepare('SELECT * FROM discussion_threads WHERE id=?').get(q.threadId);
    if (!row) throw new Error('Thread not found');
    return { thread: asThread(row) };
  }
  const cursor = q.after ?? 0;
  if (q.action === 'channels') {
    return page(db.prepare('SELECT * FROM discussion_channels WHERE seq>? ORDER BY seq LIMIT 251').all(cursor), 250, 'channels',
      row => ({ id: String(row.id), name: String(row.name), archived: Boolean(row.archived) }));
  }
  if (q.action === 'threads') {
    if (!!q.channelId === !!q.ticketId) throw new Error('Choose one channel or ticket');
    const key = q.channelId ? 'channel_id' : 'ticket_id';
    return page(db.prepare(`SELECT * FROM discussion_threads WHERE ${key}=? AND seq>? ORDER BY seq LIMIT 51`)
      .all(q.channelId ?? q.ticketId!, cursor), 50, 'threads', asThread);
  }
  if (!!q.channelId === !!q.threadId) throw new Error('Choose one channel or thread');
  const where = q.threadId ? 'thread_id=?' : 'thread_id IN (SELECT id FROM discussion_threads WHERE channel_id=?)';
  // Ten 8 KiB posts fit in a sealed command reply even with JSON escaping.
  return page(db.prepare(`SELECT * FROM discussion_posts WHERE ${where} AND seq>? ORDER BY seq LIMIT 11`)
    .all(q.threadId ?? q.channelId!, cursor), 10, 'posts', asPost);
}

function savePost(db: DatabaseSync, projectName: string, threadId: string, title: string, channelName: string,
  m: { postId: string; text: string; mentions?: z.infer<typeof session>[] }, author: DiscussionAuthor) {
  const saved = db.prepare('SELECT thread_id,text,author FROM discussion_posts WHERE id=?').get(m.postId);
  const authorJson = JSON.stringify(author);
  if (saved) {
    if (saved.thread_id !== threadId || saved.text !== m.text || !sameActor(String(saved.author), author)) {
      throw new Error('Post ID already in use');
    }
    return;
  }
  db.prepare('INSERT INTO discussion_posts(id,thread_id,text,author,created_at) VALUES(?,?,?,?,?)')
    .run(m.postId, threadId, m.text, authorJson, new Date().toISOString());
  const recipients = new Map<string, {sessionId: string; bridgeId: string}>();
  const add = (recipient: {sessionId: string; bridgeId: string}) => {
    if (author.sessionId === recipient.sessionId && author.bridgeId === recipient.bridgeId) return;
    recipients.set(JSON.stringify([recipient.bridgeId, recipient.sessionId]), recipient);
  };
  for (const row of db.prepare('SELECT session_id,bridge_id FROM discussion_followers WHERE thread_id=?').all(threadId)) {
    add({ sessionId: String(row.session_id), bridgeId: String(row.bridge_id) });
  }
  for (const recipient of m.mentions ?? []) add(recipient);
  const insert = db.prepare('INSERT INTO discussion_mail(id,thread_id,post_id,bridge_id,session_id,body) VALUES(?,?,?,?,?,?)');
  const body = `[${projectName} #${channelName}] ${author.name} on “${title}” (thread ${threadId}):\n${m.text}`;
  for (const recipient of recipients.values()) insert.run(randomUUID(), threadId, m.postId, recipient.bridgeId, recipient.sessionId, body);
}

function sameActor(stored: string, author: DiscussionAuthor) {
  const previous: DiscussionAuthor = JSON.parse(stored);
  return previous.bridgeId === author.bridgeId && previous.sessionId === author.sessionId;
}

export function writeDiscussion(db: DatabaseSync, projectName: string, payload: unknown, author: DiscussionAuthor): {id: string} {
  const m = mutation.parse(payload);
  if (m.action === 'create_channel') {
    const prior = db.prepare('SELECT name FROM discussion_channels WHERE id=?').get(m.channelId);
    if (!prior) {
      if (db.prepare('SELECT 1 FROM discussion_channels WHERE name=?').get(m.name)) throw new Error('Channel name already in use');
      db.prepare('INSERT INTO discussion_channels(id,name) VALUES(?,?)').run(m.channelId,m.name);
    }
    return { id: m.channelId };
  }
  const thread = 'threadId' in m ? db.prepare('SELECT * FROM discussion_threads WHERE id=?').get(m.threadId) : undefined;
  if ('threadId' in m && m.action !== 'create_thread' && !thread) throw new Error('Thread not found');
  const channel = db.prepare('SELECT * FROM discussion_channels WHERE id=?').get('channelId' in m ? m.channelId : String(thread!.channel_id));
  if (!channel) throw new Error('Channel not found');
  if (m.action === 'archive_channel') {
    db.prepare('UPDATE discussion_channels SET archived=1 WHERE id=?').run(m.channelId);
    return { id: m.channelId };
  }
  if (channel.archived && m.action !== 'unfollow') throw new Error('Channel is archived');
  if (m.action === 'rename_channel') {
    if (db.prepare('SELECT 1 FROM discussion_channels WHERE name=? AND id<>?').get(m.name,m.channelId)) throw new Error('Channel name already in use');
    db.prepare('UPDATE discussion_channels SET name=? WHERE id=?').run(m.name,m.channelId);
    return { id: m.channelId };
  }
  if (m.action === 'create_thread') {
    if (thread && (thread.channel_id !== m.channelId || thread.title !== m.title || !sameActor(String(thread.author), author) ||
        !db.prepare('SELECT 1 FROM discussion_posts WHERE thread_id=? AND id=?').get(m.threadId,m.postId))) throw new Error('Thread ID already in use');
    if (!thread) db.prepare('INSERT INTO discussion_threads(id,channel_id,title,author,created_at) VALUES(?,?,?,?,?)')
      .run(m.threadId,m.channelId,m.title,JSON.stringify(author),new Date().toISOString());
    savePost(db, projectName, m.threadId, m.title, String(channel.name), m, author);
    return { id: m.threadId };
  }
  if (m.action === 'reply') {
    savePost(db, projectName, m.threadId, String(thread!.title), String(channel.name), m, author);
    return { id: m.postId };
  }
  if (m.action === 'follow' || m.action === 'unfollow') {
    if (!author.bridgeId || !author.sessionId) throw new Error('Following a thread requires a session');
    const sql = m.action === 'follow' ? 'INSERT OR IGNORE INTO discussion_followers(thread_id,bridge_id,session_id) VALUES(?,?,?)'
      : 'DELETE FROM discussion_followers WHERE thread_id=? AND bridge_id=? AND session_id=?';
    db.prepare(sql).run(m.threadId, author.bridgeId, author.sessionId);
    return { id: m.threadId };
  }
  if (m.action === 'link_ticket' || m.action === 'create_ticket') {
    if (thread!.ticket_id && thread!.ticket_id !== m.ticketId) throw new Error('Thread already links another ticket');
    const existing = db.prepare('SELECT 1 FROM tickets WHERE id=?').get(m.ticketId);
    if (m.action === 'create_ticket' && !thread!.ticket_id) {
      if (existing || db.prepare('SELECT 1 FROM deleted_tickets WHERE id=?').get(m.ticketId)) throw new Error('Ticket ID already in use');
      const first = db.prepare('SELECT id FROM board_columns ORDER BY position LIMIT 1').get();
      if (!first) throw new Error('Create a project board first');
      db.prepare('INSERT INTO tickets(id,title,stage) VALUES(?,?,?)').run(m.ticketId,m.title,first.id);
    } else if (!existing) throw new Error('Ticket not found');
    db.prepare('UPDATE discussion_threads SET ticket_id=? WHERE id=?').run(m.ticketId,m.threadId);
    return { id: m.ticketId };
  }
  throw new Error('Unknown discussion action');
}
