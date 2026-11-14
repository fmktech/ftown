/**
 * FROZEN CONTRACT — coordination phase A (session cards, board, tree events,
 * nudge-once mail, digest). Types, constants and interfaces only; no logic.
 * Implementers must not modify this file. Changes go through the orchestrator.
 */
import type { Activity } from '../attention-events.js';
import type { PullRequestState } from '../pull-request-status-protocol.js';
import type { PlanView } from './contract-c.js';
import type { MailMessage, Session, SessionStatus } from '../types.js';

// ───────────────────────── Session card (declared by the agent) ─────────────────────────

export const CARD_STATES = ['working', 'blocked', 'waiting_review', 'done', 'failed'] as const;
export type CardState = typeof CARD_STATES[number];

export const BLOCKED_ON_KINDS = ['human', 'parent', 'session', 'external'] as const;
export type BlockedOnKind = typeof BLOCKED_ON_KINDS[number];

export const CARD_LIMITS = {
  headline: 140,
  next: 280,
  blockedText: 280,
  /** progress.total upper bound; done must be 0..total. */
  progressTotal: 10_000,
} as const;

export interface CardProgress { done: number; total: number }
export interface CardBlockedOn { kind: BlockedOnKind; /** session id when kind==='session' */ ref?: string; text: string }

/** Stored on Session.card (session.json) so it flows to the dashboard via toWireSession. */
export interface SessionCardDeclared {
  state: CardState;
  headline: string;
  progress?: CardProgress;
  blockedOn?: CardBlockedOn;
  next?: string;
  updatedAt: string; // ISO, set by the bridge
}

/**
 * Partial update. Omitted field = unchanged; null = remove.
 * The first write to a session with no card must include state and headline.
 * Setting state to anything other than 'blocked' clears blockedOn unless blockedOn is also given.
 */
export interface CardPatch {
  state?: CardState;
  headline?: string;
  progress?: CardProgress | null;
  blockedOn?: CardBlockedOn | null;
  next?: string | null;
}

export class CardValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'CardValidationError'; }
}

// ───────────────────────── Derived card (joined at read time, never stored) ─────────────────────────

export interface CardPr { url: string; state: PullRequestState; stale: boolean; checkedAt: string | null }

export interface CardDerived {
  status: SessionStatus;
  activity: Activity['state'];
  /** activity.lastActivityAt when activity === 'idle'. */
  idleSince?: string;
  openAttention: number;
  /** inbox messages without deliveredAt */
  unreadMail: number;
  pr?: CardPr;
  previews: string[]; // preview file basenames
  shellType?: string;
  model?: string;
}

export interface SessionCard {
  /** phase C: true for retired (archived) children included by board(all) */
  archived?: boolean;
  sessionId: string;
  name: string;
  parentSessionId?: string;
  declared: SessionCardDeclared | null;
  derived: CardDerived;
  /** declared exists and activity.lastActivityAt is more than CARD_STALE_MS after declared.updatedAt */
  stale: boolean;
}

export const CARD_STALE_MS = 10 * 60_000;

// ───────────────────────── Card store ─────────────────────────

export interface CardStoreDeps {
  loadSession(id: string): Promise<Session | null>;
  saveSession(session: Session): Promise<void>;
  /** called after a successful set/clear with the saved session (publish to dashboard + emit tree event) */
  onChange?(session: Session, previous: SessionCardDeclared | null): void | Promise<void>;
  now(): number;
}

/** Implementation: bridge/src/coordination/card-store.ts → `export class CardStore implements CardStoreApi { constructor(deps: CardStoreDeps) }` */
export interface CardStoreApi {
  get(sessionId: string): Promise<SessionCardDeclared | null>;
  /** validates (CardValidationError), merges, stamps updatedAt, saves. Throws Error('Session not found') if missing. */
  set(sessionId: string, patch: CardPatch): Promise<SessionCardDeclared>;
  clear(sessionId: string): Promise<void>;
}

// ───────────────────────── Tree event log ─────────────────────────

/** Root of a tree = session.parentSessionId ?? session.id (tree is one level deep). */
export const TREE_EVENTS_FILE = 'tree-events.jsonl'; // in sessionDir(rootId)
export const TREE_EVENTS_RETAIN = 5_000;   // keep newest N on compaction
export const TREE_EVENTS_COMPACT_AT = 6_000;
export const TREE_EVENTS_MAX_WAIT_MS = 300_000;
export const TREE_EVENT_SUMMARY_MAX = 300;

export const TREE_EVENT_KINDS = ['status', 'attention', 'pr', 'preview', 'exit', 'idle', 'result', 'mail', 'plan', 'removed'] as const;
export type TreeEventKind = typeof TREE_EVENT_KINDS[number];

export interface TreeEvent {
  seq: number;        // strictly increasing per root, starts at 1, survives compaction
  ts: string;         // ISO
  sessionId: string;  // the session the event is about
  sessionName: string;
  kind: TreeEventKind;
  summary: string;    // one line, <= TREE_EVENT_SUMMARY_MAX, control chars stripped
  ref?: string;       // e.g. PR url, attention event id, mail id
}

export type TreeEventInput = Omit<TreeEvent, 'seq' | 'ts'>;

export interface TreeEventPage { events: TreeEvent[]; /** highest seq returned, or `since` if none */ cursor: number; timedOut?: boolean }

export interface TreeEventLogDeps { sessionDir(id: string): string; now(): number }

/** Implementation: bridge/src/coordination/tree-events.ts → `export class TreeEventLog implements TreeEventLogApi { constructor(deps: TreeEventLogDeps) }` */
export interface TreeEventLogApi {
  append(rootId: string, event: TreeEventInput): Promise<TreeEvent>;
  /** events with seq > since (default 0), oldest first, at most limit (default 100, max 500) */
  read(rootId: string, opts?: { since?: number; limit?: number }): Promise<TreeEventPage>;
  /** resolves immediately if events exist after since; otherwise on next append or timeout (clamped to TREE_EVENTS_MAX_WAIT_MS) with timedOut: true */
  wait(rootId: string, since: number, timeoutMs: number, signal?: AbortSignal): Promise<TreeEventPage>;
  /** highest seq for root (0 if none) */
  head(rootId: string): Promise<number>;
}

// ───────────────────────── Board ─────────────────────────

export type BoardRollupKey = CardState | 'unset';

export interface Board {
  /** phase C: the root's plan, ordered */
  plan?: PlanView;
  rootId: string;
  /** tree event head at render time; pass back as `since` */
  cursor: number;
  /** children of rootId (not the root itself), ordered by createdAt ascending; filtered when ready/since */
  cards: SessionCard[];
  rollup: Record<BoardRollupKey, number>;
}

export interface BoardQuery {
  /** any session id; root is resolved */
  sessionId: string;
  /** only children with tree events of seq > since */
  since?: number;
  /** only children whose derived.pr.state === 'passed' and declared.state !== 'done' (approval/mergeable not tracked in phase A) */
  ready?: boolean;
  /** include archived/completed children; default false = status running|pending only plus any with events after since */
  all?: boolean;
}

export interface BoardDeps {
  /** phase C: archived session records */
  listArchived?(): Promise<Session[]>;
  loadSession(id: string): Promise<Session | null>;
  listSessions(): Promise<Session[]>;
  attention(id: string): Promise<{ activity: Activity; openCount: number }>;
  prStatus(url: string): Promise<{ state: PullRequestState; stale: boolean; checkedAt: string | null } | null>;
  unreadMail(id: string): Promise<number>;
  events: TreeEventLogApi;
  now(): number;
}

/** Implementation: bridge/src/coordination/board.ts → `export class BoardService implements BoardServiceApi { constructor(deps: BoardDeps) }` */
export interface BoardServiceApi {
  card(sessionId: string): Promise<SessionCard | null>;
  board(query: BoardQuery): Promise<Board>;
  /** deterministic one-line digest of tree events after sinceSeq for the root of sessionId; null if nothing new */
  digest(sessionId: string, sinceSeq: number): Promise<{ line: string | null; cursor: number }>;
}

/**
 * Digest line format (exact):
 *   `[ftown] since HH:MM: <part> | <part> | ...`
 * Parts, in order, one per child with events (latest event per child wins, max 6 children then `+N more`):
 *   `<name> <state>` + (headline ? ` "<headline ≤60>"` : '') + (pr ? ` (PR <state>)` : '')
 * then, if any: `<n> question(s) waiting`. Total line ≤ 500 chars. HH:MM is local time of the first event.
 */
export const DIGEST_MAX = 500;

/** Plain `ftown board` row (exact column order, single spaces):
 *   `<name> <state|-> <activity>[ idle <Nm>]  <headline>[  PR:<state>][  !<openAttention>][  ✉<unreadMail>][  (stale)]`
 */

// ───────────────────────── Mail: nudge once + fyi ─────────────────────────

/** Replaces MAIL_TYPES in mail-delivery.ts and wire-types.ts. */
export const MAIL_TYPES_V2 = ['message', 'task', 'result', 'escalation', 'fyi'] as const;
export type MailTypeV2 = typeof MAIL_TYPES_V2[number];
/** fyi never schedules a nudge or wake; collected only at the next natural drain/read. */
export const NON_WAKING_MAIL_TYPES: ReadonlySet<MailTypeV2> = new Set(['fyi']);
/** Max native-wake attempts (codex/muse) for one batch before the batch is stamped and left. */
export const MAX_WAKE_ATTEMPTS = 3;

/**
 * Nudge-once rules (MailMessage.nudgedAt):
 * 1. A nudge/wake fires only if ≥1 undelivered, waking message has no nudgedAt.
 * 2. On firing (any path: PTY, codex, muse, plugin), stamp nudgedAt on every undelivered waking message → that is the batch.
 * 3. A stamped message never causes another nudge on any path (new mail, recovery, retry).
 * 4. Recovery (recoverPendingMail) skips stamped mail.
 * 5. Nudge text: NUDGE_TEXT(counts, digest).
 */
export type MailCounts = Partial<Record<MailTypeV2, number>>;

export interface DigestProvider {
  /** one-line digest for the recipient (as tree root), or null. Must not throw; return null on error. */
  digestFor(recipientSessionId: string): Promise<string | null>;
}

/** Event sink so mail-delivery can record child→parent `result` mail on the tree log without importing it. */
export interface MailEventSink {
  onAccepted(message: MailMessage, recipient: Session): void | Promise<void>;
}

// ───────────────────────── Local API (all via dispatchSecure, :id = target session) ─────────────────────────

export const COORDINATION_ROUTES = {
  /** GET → SessionCard; PUT body CardPatch → SessionCard (400 on CardValidationError); DELETE → { ok: true } */
  card: '/api/sessions/:id/card',
  /** GET ?since=<n>&ready=1&all=1 → Board */
  board: '/api/sessions/:id/board',
  /** GET ?since=<n>&limit=<n>&waitSeconds=<0..300> → TreeEventPage (root of :id) */
  events: '/api/sessions/:id/events',
} as const;

// ───────────────────────── CLI (new top-level groups in ftown-cli.ts) ─────────────────────────
/**
 * ftown status [--json] [--session-id <id>]                       → print own card (SessionCard)
 * ftown status set [--state <s>] [--headline <t>] [--progress <d>/<t>|--no-progress]
 *                  [--on human|parent|external|session:<id>] [--text <t>] [--next <t>|--no-next] [--session-id <id>]
 * ftown status clear [--session-id <id>]
 * ftown board [--json] [--since <n>] [--ready] [--all] [--session-id <id>]
 *             [--wait --until any-change|any-done|any-blocked|all-done|any-ready [--timeout <s≤300>]]
 * ftown events [--json] [--since <n>] [--limit <n>] [--wait [--timeout <s≤300>]] [--session-id <id>]
 * Exit codes: 0 ok, 1 error, 2 usage, 3 wait timed out with condition unmet.
 * Default session id: FTOWN_SESSION_ID.
 */
export const BOARD_WAIT_CONDITIONS = ['any-change', 'any-done', 'any-blocked', 'all-done', 'any-ready'] as const;
export type BoardWaitCondition = typeof BOARD_WAIT_CONDITIONS[number];
