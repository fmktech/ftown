// Frozen contract for the Factory view. Implementers import from this file and
// from "@/types"; they must not modify it. All data access goes through
// bridgeExec (shell on the bridge host, cwd = FactoryInfo.repoRoot).

import type { Session } from "@/types";
import type { BridgeExecResponse } from "@/hooks/useSessions";

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Loops created by `factory up` carry group "Factory: <project>". */
export const FACTORY_GROUP_PREFIX = "Factory: ";

/** A factory detected on a bridge — derived from its ftown loops. */
export interface FactoryInfo {
  project: string; // group label minus FACTORY_GROUP_PREFIX, e.g. "legbi-small"
  repoRoot: string; // loop workdir — absolute path on the bridge host
  bridgeId: string;
}

export type BridgeExecFn = (
  command: string,
  workingDir: string,
  bridgeId: string,
) => Promise<BridgeExecResponse>;

// ---------------------------------------------------------------------------
// Ticket data (mirrors fticket's SQLite schema / `fts show --json`)
// ---------------------------------------------------------------------------

export type TicketStatus =
  | "queued"
  | "claimed"
  | "in_progress"
  | "done"
  | "rejected"
  | "blocked"
  | "dead_letter";

export interface FactoryTicket {
  id: number;
  kind: "task" | "epic";
  title: string;
  stage: string;
  status: TicketStatus;
  priority: number;
  bounce_count: number;
  orphaned: 0 | 1;
  blocked_on: string | null;
  dead_letter_reason: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface FactorySnapshot {
  stages: string[]; // pipeline order (stages.ord ascending)
  tickets: FactoryTicket[]; // ordered by priority DESC, id ASC
  fetchedAt: number; // epoch ms at parse time
}

export interface TicketClaim {
  ticket_id: number;
  worker_id: string;
  epoch: number;
  granted_at_ms: number;
  expires_at_ms: number;
  renew_count: number;
  last_renew_ms: number;
}

export interface TicketHistoryEntry {
  id: number;
  ticket_id: number;
  seq: number;
  kind: string; // "transition" | "claim" | "renew" | ...
  from_status: string | null;
  to_status: string | null;
  from_stage: string | null;
  to_stage: string | null;
  actor: string | null;
  worker_id: string | null;
  note: string | null;
  event_cursor: number | null;
  at_ms: number;
}

/** Shape of `fts show <id> --json`. `ticket` carries extra fields we ignore. */
export interface TicketDetail {
  ticket: FactoryTicket & { folder_path: string; epic_id: number | null };
  claim: TicketClaim | null;
  history: TicketHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface SkillFile {
  name: string; // "design.md"
  relPath: string; // "factory/skills/design.md" (relative to repoRoot)
}

/** writeSkill/readSkill accept only paths matching this (defense in depth). */
export const SKILL_PATH_RE = /^factory\/skills\/[A-Za-z0-9._-]+\.md$/;

// ---------------------------------------------------------------------------
// Shell command builders — quoting/encoding decided once, here.
// NOTE: `sqlite3 -json` prints NOTHING (empty stdout) for zero rows; parsers
// must treat blank stdout as [].
// ---------------------------------------------------------------------------

export const FACTORY_DB = ".ffactory/factory.db";
export const FTS_BIN = '"$HOME/.local/bin/fts"';

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** UTF-8-safe base64 for shell transport. */
export function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Readers wait for the write lock instead of failing instantly (SQLITE_BUSY). */
export const SQLITE_BUSY_TIMEOUT_MS = 3000;

export const STAGES_CMD = `sqlite3 -cmd ".timeout ${SQLITE_BUSY_TIMEOUT_MS}" "file:${FACTORY_DB}?mode=ro" -json "SELECT name, ord FROM stages ORDER BY ord"`;

export const TICKETS_CMD = `sqlite3 -cmd ".timeout ${SQLITE_BUSY_TIMEOUT_MS}" "file:${FACTORY_DB}?mode=ro" -json "SELECT id,kind,title,stage,status,priority,bounce_count,orphaned,blocked_on,dead_letter_reason,created_at_ms,updated_at_ms FROM tickets ORDER BY priority DESC, id"`;

/** Matches transient SQLite contention errors that a later poll will clear. */
export const SQLITE_TRANSIENT_RE = /database is locked|database table is locked|SQLITE_BUSY/i;

export function showTicketCmd(id: number): string {
  return `${FTS_BIN} show --db ${FACTORY_DB} ${Math.floor(id)} --json`;
}

export const LIST_SKILLS_CMD = `ls factory/skills/*.md 2>/dev/null`;

export function readSkillCmd(relPath: string): string {
  return `cat ${shellQuote(relPath)}`;
}

export function writeSkillCmd(relPath: string, content: string): string {
  return `printf '%s' ${shellQuote(toBase64(content))} | base64 --decode > ${shellQuote(relPath)}`;
}

// ---------------------------------------------------------------------------
// Worker sessions — the dispatcher names workers "<project>-t<ticketId>-<stage>"
// ---------------------------------------------------------------------------

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function workerSessionRe(project: string): RegExp {
  return new RegExp(`^${escapeRegExp(project)}-t(\\d+)-([A-Za-z0-9_-]+)$`);
}

/** A factory worker run: an ftown Session matched by workerSessionRe. */
export interface WorkerRun {
  session: Session;
  ticketId: number;
  stage: string;
}

// ---------------------------------------------------------------------------
// Hook contract (implemented in useFactory.ts)
// ---------------------------------------------------------------------------

export interface UseFactoryResult {
  snapshot: FactorySnapshot | null; // last good snapshot (kept on poll errors)
  error: string | null; // last poll error, null after a good poll
  loading: boolean; // true only until the first poll settles
  refresh: () => void; // force an immediate re-poll
  showTicket: (id: number) => Promise<TicketDetail>;
  listSkills: () => Promise<SkillFile[]>;
  readSkill: (relPath: string) => Promise<string>;
  writeSkill: (relPath: string, content: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Component prop contracts
// ---------------------------------------------------------------------------

export interface FactoryListProps {
  factories: FactoryInfo[];
  selectedProject: string | null;
  onSelect: (factory: FactoryInfo) => void;
  collapsed: boolean;
}

export interface FactoryPaneProps {
  factory: FactoryInfo;
  bridgeExec: BridgeExecFn;
  sessions: Session[];
  onOpenSession: (sessionId: string) => void;
}

export interface FactoryBoardProps {
  snapshot: FactorySnapshot | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
  showTicket: (id: number) => Promise<TicketDetail>;
}

export interface SkillEditorProps {
  listSkills: () => Promise<SkillFile[]>;
  readSkill: (relPath: string) => Promise<string>;
  writeSkill: (relPath: string, content: string) => Promise<void>;
}

export interface FactoryRunsProps {
  factory: FactoryInfo;
  sessions: Session[];
  onOpenSession: (sessionId: string) => void;
}
