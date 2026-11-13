/**
 * FROZEN CONTRACT — coordination phase B: parent-first attention, manager brief +
 * dashboard overview, optional bridge-owned worktrees. Types/constants/interfaces only.
 * Implementers must not modify this file.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AttentionAnswer, AttentionPrompt } from '../attention-prompt-protocol.js';
import type { AttentionItem } from '../attention-events.js';
import type { Session } from '../types.js';

// ───────────────────────── B: parent-first attention ─────────────────────────

/**
 * Routing rules (single hop; the tree is one level deep):
 * - An attention item created by a session S (POST /api/sessions/:id/attention or /ask) gets
 *   route 'parent' iff S.parentSessionId is set, the parent session exists, status 'running',
 *   shellType !== 'shell', runner reports it running, AND the request did not ask `to: 'human'`.
 *   Otherwise route 'human' (today's behaviour).
 * - route 'parent': NO dashboard notice publish and NO push for this item. The parent receives ONE
 *   waking mail, type 'escalation', from S, body = PARENT_QUESTION_MAIL(...) below. A tree event
 *   kind 'attention' is emitted (phase A already emits it). S's card is untouched (the agent may set it).
 *   The item IS visible in the human's inbox (greyed "with parent"), and the human may still answer it.
 * - The parent answers → item answered exactly as a human answer (same delivery: live waiter or
 *   mail from "You"; for parent answers the mail sender is the parent session), plus answeredBy.
 * - The parent escalates (or the parent exits/stops/errors while the item is open and route==='parent')
 *   → route flips to 'human', escalatedAt set, escalationNote set (parent note, or PARENT_UNAVAILABLE_NOTE),
 *   and the normal dashboard notice + push flow fires NOW, as if the item had just been created.
 * - No timers. Only the parent (or parent unavailability) moves an item to the human.
 * - Repeating an identical open request keeps its current route (occurrence count only).
 */
export type AttentionRoute = 'parent' | 'human';

export interface AttentionAnsweredBy { kind: 'human' | 'session'; sessionId?: string; name?: string }

/** Fields added to AttentionItem (declared optional on AttentionItem in attention-events.ts). */
export interface AttentionRoutingFields {
  route?: AttentionRoute;          // absent = 'human' (legacy items)
  routedTo?: string;               // parent session id when route was 'parent' at creation
  escalatedAt?: string;            // ISO, set when parent → human
  escalationNote?: string;         // ≤ 500 chars
  answeredBy?: AttentionAnsweredBy;
}

export const ESCALATION_NOTE_MAX = 500;
export const PARENT_UNAVAILABLE_NOTE = 'Parent session is not running; routed to you.';

/**
 * Exact mail body to the parent (type 'escalation', threadId = item id):
 *   `[ftown question id=<eventId> from=<childName> (<childId>)] <title>\n<message>\n` +
 *   (options ? `Options: 1) <label> 2) <label> ...\n` : '') +
 *   `Answer: ftown attention answer <childId> <eventId> --option <n> | --text "<reply>"\n` +
 *   `Escalate to the human: ftown attention escalate <childId> <eventId> --note "<context>"`
 * For multi-question prompts list each question as `Q<i>: <question>` with its options.
 */
export const PARENT_QUESTION_PREFIX = '[ftown question';

/** AttentionStore additions (bridge/src/attention-store.ts). */
export interface AttentionRoutingStoreApi {
  /** set route fields on an existing open item; returns updated item or undefined if missing/resolved */
  setRoute(sessionId: string, eventId: string, fields: AttentionRoutingFields): Promise<AttentionItem | undefined>;
  /** open items (not resolved) of childId with route==='parent' */
  listRouted(childId: string): Promise<AttentionItem[]>;
}

/** Local API (via dispatchSecure). Caller identity = x-ftown-session-id (local-cli principal). */
export const ATTENTION_ROUTES = {
  /** POST body { answers: AttentionAnswerEntry[] } — caller must be the child's parent (403 otherwise); 409 if resolved; 400 invalid answers. → { event: AttentionItem } */
  answer: '/api/sessions/:id/attention/:eventId/answer',
  /** POST body { note?: string } — caller must be the parent; 409 if route already 'human' or resolved. → { event: AttentionItem } */
  escalate: '/api/sessions/:id/attention/:eventId/escalate',
  /** GET → { items: Array<{ sessionId: string; sessionName: string; event: AttentionItem }> } — open parent-routed items of all children of :id */
  routed: '/api/sessions/:id/attention/routed',
} as const;
/** Existing POST /api/sessions/:id/attention and /attention/ask accept a new optional body key `to: 'human'`. */

/**
 * CLI (new group `ftown attention`, bridge/src/attention-cli.ts):
 *   ftown attention list [--json]                                   → routed items for my children (plain: `<child> <eventId> <title>` + options)
 *   ftown attention answer <child-id> <event-id> (--option <n|label>... | --text <t> | --answers-json <json>) [--json]
 *   ftown attention escalate <child-id> <event-id> [--note <t>] [--json]
 * `ftown sessions attention ... --to human` bypasses the parent.
 * Exit codes: 0 ok, 1 error, 2 usage, 4 forbidden (not the parent), 5 conflict (already resolved/escalated).
 */

/** Dashboard wire: AttentionItem fields above flow unchanged through existing attention reads. */
export type AttentionPromptRef = AttentionPrompt; // re-export for UI mirrors
export type AttentionAnswerRef = AttentionAnswer;

// ───────────────────────── C: manager brief + dashboard overview ─────────────────────────

export const BRIEF_LIMITS = { text: 16_384, note: 280, notes: 50 } as const;

export interface BriefNote { ts: string; text: string }
/** Stored on Session.brief (session.json) → flows to dashboard via toWireSession. */
export interface SessionBrief {
  text?: string;        // markdown, ≤ BRIEF_LIMITS.text
  notes: BriefNote[];   // newest last, capped at BRIEF_LIMITS.notes (drop oldest)
  updatedAt: string;
}

export const BRIEF_ROUTES = {
  /** GET → { brief: SessionBrief | null }; PUT body { text: string | null } → { brief }; DELETE → { ok: true } */
  brief: '/api/sessions/:id/brief',
  /** POST body { text: string } → { brief } (appends one note) */
  notes: '/api/sessions/:id/brief/notes',
} as const;

/**
 * CLI (bridge/src/brief-cli.ts, group `ftown brief`):
 *   ftown brief show [--json] [--session-id <id>]
 *   ftown brief set (--file <path.md> | --text <t> | --clear) [--session-id <id>]
 *   ftown brief note <text...> [--session-id <id>]
 * Validation: control chars except \n\t stripped; text over limit → error exit 1 (no truncation).
 * Every successful write publishes the session to the dashboard.
 *
 * Dashboard overview (UI): for a selected session that has ≥1 child, an "Overview" view showing:
 * the brief (markdown, rendered like existing markdown previews, sanitized), the last 10 notes,
 * and a table of children: name, card chip (state/headline/progress/blocked), activity + idle,
 * PR link + check state, open attention count incl. "with parent" items, worktree branch.
 * Rendered client-side from data the dashboard already has (sessions with card/brief/worktree,
 * PR statuses hook, attention). Each card's age is shown ("updated 4m ago").
 */

// ───────────────────────── D: optional bridge-owned worktrees ─────────────────────────

/** Stored on Session.worktree. Only createdByBridge worktrees are ever removed by the bridge. */
export interface SessionWorktree {
  repoRoot: string;   // realpath of the main repository top-level
  path: string;       // absolute worktree path (== session.workingDir)
  branch: string;
  base: string;       // base ref the branch was created from
  createdByBridge: true;
  retained?: { reason: string; at: string }; // set when removal kept it
}

export interface WorktreeCreateRequest {
  /** directory inside a git repo (the requested workdir, or the parent's workingDir when omitted) */
  fromDir: string;
  /** session name → default branch `ftown/<slug(name)>` and path `<repoRoot>/.claude/worktrees/<slug(name)>` */
  name: string;
  branch?: string;   // validated by `git check-ref-format --branch`
  base?: string;     // default: current branch of fromDir (HEAD if detached → error 'detached HEAD; pass --base')
}

export interface WorktreeStatus {
  path: string; branch: string; base: string;
  exists: boolean;
  dirty: boolean;           // uncommitted or untracked (excluding ignored) files
  ahead: number;            // commits on branch not in base
  unpushed: number | null;  // commits not on the branch's upstream; null if no upstream
  mergedIntoBase: boolean;  // branch tip is ancestor of base
}

export type WorktreeRetireDecision =
  | { action: 'remove'; deleteBranch: boolean }   // deleteBranch only when mergedIntoBase
  | { action: 'retain'; reason: string };          // e.g. '2 unpushed commits', 'uncommitted changes'

/** Implementation: bridge/src/worktrees.ts — all git calls via execFile('git', [...]) with cwd, no shell, timeout 30s. */
export interface WorktreeApi {
  create(req: WorktreeCreateRequest): Promise<SessionWorktree>; // throws WorktreeError
  status(wt: SessionWorktree): Promise<WorktreeStatus>;
  /** pure: retire iff exists && !dirty && (mergedIntoBase || (unpushed === 0)); else retain with reason */
  decide(status: WorktreeStatus): WorktreeRetireDecision;
  /** git worktree remove (no --force unless force) + optional `git branch -d` (never -D) */
  remove(wt: SessionWorktree, opts: { force: boolean; deleteBranch: boolean }): Promise<void>;
}

export class WorktreeError extends Error {
  constructor(public readonly code: 'not_a_repo' | 'detached_head' | 'bad_branch' | 'exists' | 'git_failed', message: string) {
    super(message); this.name = 'WorktreeError';
  }
}

/**
 * Create: POST /api/sessions body gains `worktree?: true | { branch?: string; base?: string }`.
 *   CLI: `ftown sessions create --worktree [--branch <b>] [--base <ref>]` (with --workdir optional).
 *   The worktree is created before the session launches; session.workingDir = worktree.path. On WorktreeError → 400 with message, no session created.
 * Remove: DELETE /api/sessions/:id accepts query `worktree=keep|force` (default: auto-decide).
 *   CLI: `ftown sessions remove <id> [--keep-worktree | --force-worktree]`; output states removed/retained + reason.
 *   Auto: status → decide → remove or set worktree.retained. Errors never block archiving the session.
 * List/prune:
 *   GET  /api/worktrees → { worktrees: Array<{ sessionId: string; sessionName: string; archived: boolean; worktree: SessionWorktree; status: WorktreeStatus }> }
 *   POST /api/worktrees/prune → { removed: string[]; retained: Array<{ path: string; reason: string }> }  (archived sessions only, same decide rule)
 *   CLI (bridge/src/worktrees-cli.ts, group `ftown worktrees`): `list [--json]`, `prune [--json]`.
 */
export const WORKTREE_ROUTES = { list: '/api/worktrees', prune: '/api/worktrees/prune' } as const;

// ───────────────────────── Route module plumbing (avoid local-api-server.ts conflicts) ─────────────────────────

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  /** pathname without query */
  path: string;
  query: URLSearchParams;
  /** x-ftown-session-id of a local-cli caller, else undefined */
  callerSessionId?: string;
  parseBody(): Promise<Record<string, unknown>>;
  json(status: number, body: unknown): void;
  loadSession(id: string): Promise<Session | null>;
  saveSession(session: Session): Promise<void>;
  publishSession(session: Session): void;
}

/** Each route module exports `handle(ctx): Promise<boolean>` (true = handled). Throw BadRequestError-like errors as `{ status, message }`. */
export type RouteModule = (ctx: RouteContext) => Promise<boolean>;
export class RouteError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'RouteError'; }
}
