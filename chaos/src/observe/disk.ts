// Disk observers: read the bridge's on-disk state under <dataDir> and map it to the contract's
// observation types. Read-only; never throws. Formats are derived from the bridge source:
//   session.json      bridge/src/session-store.ts:98-114 (<dataDir>/sessions/<id>/session.json),
//                     status enum bridge/src/types.ts:82
//   inbox.jsonl       bridge/src/mail-store.ts:78-103 (parse), :152-165 (append), types.ts:90-102
//   attention.json    bridge/src/attention-store.ts:36-58 (ledger schema, items in `events`), :222-230 (load)
//   tree-events.jsonl bridge/src/coordination/tree-events.ts:30-41 (parseEvent), contract.ts:110,116
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ASK_TAG_RE, MAIL_TAG_RE, ROLES } from '../contract.ts';
import type { AttentionObs, MailObs, MailType, Role, SessionObs, TreeEventObs } from '../contract.ts';

/** role -> session id; null = the session has not been created yet. */
export type Ids = Record<Role, string | null>;

export interface SessionDisk {
  status: SessionObs['status'];
  inbox: MailObs[];
  inboxParses: boolean;
  attention: AttentionObs[];
  attentionParses: boolean;
}

export interface TreeDisk {
  treeEvents: TreeEventObs[];
  treeEventsCorruptLines: number;
}

const STATUSES: readonly string[] = ['pending', 'running', 'completed', 'error'];
const MAIL_TYPES: readonly string[] = ['message', 'task', 'result', 'escalation', 'fyi'];
const DELIVERED_VIA: readonly string[] = ['poll', 'drain', 'nudge', 'cli'];

type Read = { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'error' };

async function readText(path: string): Promise<Read> {
  try {
    return { kind: 'ok', text: await readFile(path, 'utf8') };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'error' };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

function sessionDir(dataDir: string, id: string): string {
  return join(dataDir, 'sessions', id);
}

export async function readStatus(dataDir: string, id: string | null): Promise<SessionObs['status']> {
  if (id === null) return 'missing';
  const read = await readText(join(sessionDir(dataDir, id), 'session.json'));
  if (read.kind === 'missing') return 'missing';
  if (read.kind === 'error') return 'unparseable';
  try {
    const value: unknown = JSON.parse(read.text);
    if (isObject(value) && typeof value.status === 'string' && STATUSES.includes(value.status)) {
      return value.status as SessionObs['status'];
    }
  } catch {
    // fall through
  }
  return 'unparseable';
}

/** `from=<role|external>` in a mail body; anything else is 'unknown'. */
function fromRoleOf(body: string): MailObs['fromRole'] {
  const m = /(?:^|\s)from=(\S+)/.exec(body);
  if (!m) return 'unknown';
  if (m[1] === 'external') return 'external';
  return isRole(m[1]) ? m[1] : 'unknown';
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Lines that are valid JSON objects but not messages (the PR checkpoint line, `_ftown`) are skipped,
 * as the bridge does. Mail without a CHAOS tag is not workload mail and is left out of inbox[].
 */
export async function readInbox(dataDir: string, id: string | null): Promise<{ inbox: MailObs[]; inboxParses: boolean }> {
  if (id === null) return { inbox: [], inboxParses: true };
  const read = await readText(join(sessionDir(dataDir, id), 'inbox.jsonl'));
  if (read.kind === 'missing') return { inbox: [], inboxParses: true };
  if (read.kind === 'error') return { inbox: [], inboxParses: false };
  const inbox: MailObs[] = [];
  let parses = true;
  for (const line of read.text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      parses = false;
      continue;
    }
    if (!isObject(value)) {
      parses = false;
      continue;
    }
    if (typeof value._ftown === 'string') continue;
    if (typeof value.id !== 'string' || typeof value.body !== 'string') continue;
    const tag = MAIL_TAG_RE.exec(value.body);
    if (!tag) continue;
    if (typeof value.type !== 'string' || !MAIL_TYPES.includes(value.type)) continue;
    const via = typeof value.deliveredVia === 'string' && DELIVERED_VIA.includes(value.deliveredVia)
      ? (value.deliveredVia as MailObs['deliveredVia'])
      : null;
    inbox.push({
      tag: tag[0],
      type: value.type as MailType,
      fromRole: fromRoleOf(value.body),
      delivered: nonEmpty(value.deliveredAt),
      deliveredVia: via,
      nudged: nonEmpty(value.nudgedAt),
    });
  }
  return { inbox, inboxParses: parses };
}

function askTagOf(item: Record<string, unknown>): string | null {
  const candidates: unknown[] = [item.title, item.message];
  const prompt = item.prompt;
  if (isObject(prompt) && Array.isArray(prompt.questions) && isObject(prompt.questions[0])) {
    candidates.push(prompt.questions[0].question);
  }
  for (const text of candidates) {
    if (typeof text !== 'string') continue;
    const m = ASK_TAG_RE.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** Items live in the ledger's `events` array. Untagged items are ignored. Sorted by tag number. */
export async function readAttention(dataDir: string, id: string | null): Promise<{ attention: AttentionObs[]; attentionParses: boolean }> {
  if (id === null) return { attention: [], attentionParses: true };
  const read = await readText(join(sessionDir(dataDir, id), 'attention.json'));
  if (read.kind === 'missing') return { attention: [], attentionParses: true };
  if (read.kind === 'error') return { attention: [], attentionParses: false };
  let ledger: unknown;
  try {
    ledger = JSON.parse(read.text);
  } catch {
    return { attention: [], attentionParses: false };
  }
  if (!isObject(ledger) || !Array.isArray(ledger.events)) return { attention: [], attentionParses: false };
  const found: { n: number; obs: AttentionObs }[] = [];
  for (const item of ledger.events) {
    if (!isObject(item)) continue;
    const askTag = askTagOf(item);
    if (askTag === null) continue;
    found.push({
      n: Number(/\d+/.exec(askTag)![0]),
      obs: {
        askTag,
        route: item.route === 'parent' || item.route === 'human' ? item.route : null,
        resolved: nonEmpty(item.resolvedAt),
        resolution: typeof item.resolution === 'string' ? item.resolution : null,
        escalated: nonEmpty(item.escalatedAt),
      },
    });
  }
  found.sort((a, b) => a.n - b.n);
  return { attention: found.map((f) => f.obs), attentionParses: true };
}

export async function readSessionDisk(dataDir: string, id: string | null): Promise<SessionDisk> {
  const [status, inbox, attention] = await Promise.all([
    readStatus(dataDir, id),
    readInbox(dataDir, id),
    readAttention(dataDir, id),
  ]);
  return { status, ...inbox, ...attention };
}

/** Events of the root's tree-events.jsonl in file order. A line the bridge would skip is corrupt. */
export async function readTree(dataDir: string, ids: Ids): Promise<TreeDisk> {
  if (ids.root === null) return { treeEvents: [], treeEventsCorruptLines: 0 };
  const read = await readText(join(sessionDir(dataDir, ids.root), 'tree-events.jsonl'));
  if (read.kind === 'missing') return { treeEvents: [], treeEventsCorruptLines: 0 };
  if (read.kind === 'error') return { treeEvents: [], treeEventsCorruptLines: 1 };
  const roleOf = new Map<string, Role>();
  for (const role of ROLES) {
    const id = ids[role];
    if (id !== null) roleOf.set(id, role);
  }
  const treeEvents: TreeEventObs[] = [];
  let corrupt = 0;
  for (const line of read.text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      corrupt++;
      continue;
    }
    if (
      !isObject(value) ||
      typeof value.seq !== 'number' || !Number.isInteger(value.seq) || value.seq < 1 ||
      typeof value.kind !== 'string' ||
      typeof value.sessionId !== 'string'
    ) {
      corrupt++;
      continue;
    }
    treeEvents.push({ seq: value.seq, kind: value.kind, role: roleOf.get(value.sessionId) ?? null });
  }
  return { treeEvents, treeEventsCorruptLines: corrupt };
}
