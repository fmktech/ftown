/**
 * FROZEN CONTRACT — coordination phase C: plan list (todo with precedence), retired
 * history on the board, removed/plan tree events, dashboard board snapshot RPC, board v3
 * Overview. Types/constants/interfaces only. Implementers must not modify this file.
 */
import type { Board, SessionCard, TreeEvent } from './contract.js';
import type { AttentionItem } from '../attention-events.js';

// ───────────────────────── Plan (todo list with precedence) ─────────────────────────

export const PLAN_LIMITS = { items: 200, title: 140, note: 500, after: 20 } as const;
export const PLAN_STATES = ['todo', 'started', 'done', 'dropped'] as const;
export type PlanState = typeof PLAN_STATES[number];
export type PlanPriority = 1 | 2 | 3; // 1 = highest

export interface PlanItem {
  id: string;            // `p<n>`, n = Session.plan.seq at creation (never reused)
  title: string;         // 1..PLAN_LIMITS.title after cleaning (control chars → space, collapse whitespace)
  note?: string;         // ≤ PLAN_LIMITS.note, same cleaning
  after: string[];       // ids of items that must be done (or dropped) first; ≤ PLAN_LIMITS.after; no self, no cycles, must exist
  priority: PlanPriority; // default 2
  state: PlanState;
  sessionId?: string;    // child session doing it (set by start / --plan-item)
  createdAt: string;
  updatedAt: string;
}

/** Stored on the PARENT session: Session.plan (session.json) → flows to dashboard via toWireSession. */
export interface SessionPlan { items: PlanItem[]; seq: number }

/**
 * Derived ordering (pure helper `orderPlan(items)` in bridge/src/coordination/plan.ts, also re-implemented
 * identically in the UI — see PLAN_ORDER_RULE):
 *   ready   = state 'todo' && every `after` item is 'done' or 'dropped'
 *   waiting = state 'todo' && not ready
 * Order: ready (priority asc, createdAt asc), then waiting (same), then started (updatedAt asc),
 * then done (updatedAt desc), then dropped (updatedAt desc).
 */
export const PLAN_ORDER_RULE = 'ready>waiting>started>done>dropped; within ready/waiting: priority asc, createdAt asc' as const;

export interface PlanView { items: PlanItem[] /* ordered */; ready: string[] /* ids, ordered */ }

/** Routes (via dispatchSecure; :id = parent session). Caller: local-cli principal; any session may edit the plan of :id (owner-only enforcement is out of scope). */
export const PLAN_ROUTES = {
  /** GET → PlanView; POST body { title, note?, after?, priority? } → { item } */
  plan: '/api/sessions/:id/plan',
  /** PATCH body { title?, note?: string|null, after?, priority?, state?, sessionId?: string|null } → { item }; DELETE → { ok: true } (removes id from others' `after`) */
  item: '/api/sessions/:id/plan/:itemId',
} as const;

export class PlanValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'PlanValidationError'; }
}

/**
 * Automatic transitions (bridge wiring):
 * - `ftown sessions create --parent --plan-item <id>`: after the child exists, item.state = 'started', item.sessionId = child.id.
 *   Unknown/non-todo item → create fails 400 BEFORE the session is created.
 * - When a child's declared card becomes 'done' and an item of its parent has sessionId === child.id and state 'started' → 'done'.
 *   'failed' card → item back to 'todo' with sessionId cleared? NO: leave 'started' (manager decides).
 * - Every plan change emits ONE tree event kind 'plan' on the parent's log with summary
 *   `<id> <state>: <title>` ; when items become ready because of it, append ` → ready: <id>, <id>`.
 *
 * CLI (bridge/src/plan-cli.ts, group `ftown plan`, default session = FTOWN_SESSION_ID = the manager):
 *   ftown plan [--json] [--session-id <id>]                       list in order: `<mark> <id> [P<prio>] <title>  (after p1,p2 | → <child name>)`
 *                                                                  marks: `→` ready, `·` waiting, `▸` started, `✓` done, `✗` dropped
 *   ftown plan add <title...> [--note <t>] [--after <id,id>] [--priority 1|2|3]
 *   ftown plan start <id> --session <child-id>
 *   ftown plan done <id> | drop <id> | todo <id>
 *   ftown plan edit <id> [--title <t>] [--note <t>|--no-note] [--after <ids>|--no-after] [--priority n]
 *   ftown plan rm <id>
 *   ftown sessions create --parent --plan-item <id> ...  (in sessions-commands.ts)
 * Exit codes: 0 ok, 1 error, 2 usage.
 */

// ───────────────────────── Tree events: new kinds ─────────────────────────

/** Added to TREE_EVENT_KINDS in contract.ts (phase C edit): 'plan' and 'removed'. */
export const PHASE_C_EVENT_KINDS = ['plan', 'removed'] as const;
/** 'removed': emitted when a child session is removed/archived while not already exited; summary `removed`. */

// ───────────────────────── Board: retired history + plan ─────────────────────────

/** SessionCard gains (in contract.ts, phase C edit): `archived?: boolean`. Board gains `plan?: PlanView`. */
export interface BoardPhaseCFields { archived?: boolean }

/**
 * BoardService (phase C):
 * - BoardDeps gains `listArchived(): Promise<Session[]>` (archive store records).
 * - board({ all: true }) includes archived children (archived: true, derived.status as recorded, activity 'unknown'),
 *   ordered after live children by archived time desc, capped at 50 most recent.
 * - Board.plan = the parent's PlanView when the root has a plan (always included).
 * - Plain `ftown board`: after child rows, a `planned` section: up to 5 ready items `→ <id> <title>` then `+N more`.
 *
 * `ftown board --wait --until any-done|any-blocked|any-ready` (phase C fix): the condition must hold for a child
 * whose tree events arrived AFTER the starting cursor (any-done: a changed child is now done, etc.).
 * `all-done` stays global. `any-change` unchanged.
 */

// ───────────────────────── Dashboard snapshot RPC ─────────────────────────

/** command-rpc command `get_session_board`, payload { bridgeId, sessionId } → BoardSnapshot. Read-only. */
export interface BoardSnapshot {
  board: Board;              // board({ sessionId, all: true }) incl. archived + plan
  events: TreeEvent[];       // newest 50 events of the root, oldest first
  attention: Array<{ sessionId: string; event: AttentionItem }>; // open items of all children (any route)
}
export const BOARD_SNAPSHOT_EVENTS = 50;

/**
 * UI (board v3 Overview, see .ftown-previews/board-v3-notes.md in the phase B worktree — copied to
 * docs/design/board-v3.md in this phase):
 * - hook `useSessionBoard(bridgeId, sessionId, enabled)` calls get_session_board on mount, on any session update
 *   for that tree, and every 15 s while the Overview is visible; never while hidden.
 * - SessionOverview renders: manager line; "needs attention · n" (failed | blocked | escalated question; owner
 *   `you` or manager name); "active · n"; folds: planned (PlanView order), done (incl. archived/retired),
 *   events, brief. Row expand shows details (state/progress/age/stale, blocked, question, next, activity +
 *   idle duration, pr, worktree, mail, preview, agent, that session's last 3 events).
 * - Idle duration: the UI records the timestamp when a session's activity becomes 'idle' (from hook events)
 *   and shows `idle <n>m`.
 */
export type OverviewChild = SessionCard;
