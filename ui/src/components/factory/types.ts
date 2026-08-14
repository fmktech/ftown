// Frozen contract for the Factory view. Implementers import from this file and
// from "@/types"; they must not modify it. All data access goes through
// bridgeExec (shell on the bridge host, cwd = FactoryInfo.repoRoot).

import type { Session, ShellType } from "@/types";
import type { BridgeExecResponse } from "@/hooks/useSessions";
import { imageMimeType } from "./artifact-formats";

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

export interface TicketArtifactFile {
  /** Path displayed inside the ticket artifact folder. */
  name: string;
  /** Repo-root-relative path used by the bridge reader. */
  relPath: string;
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

/** NOT mode=ro: a read-only handle cannot create the WAL -shm sidecar, so it
 *  fails with SQLITE_CANTOPEN(14) whenever the factory is idle (last writer
 *  deletes the sidecars on clean close). We open normally — the commands are
 *  SELECT-only — and guard existence first so a missing db is a clear error
 *  instead of an accidentally created empty file. */
function sqliteRead(sql: string): string {
  return `test -f ${FACTORY_DB} || { echo "no factory db at ${FACTORY_DB}" >&2; exit 2; }; sqlite3 -cmd ".timeout ${SQLITE_BUSY_TIMEOUT_MS}" ${FACTORY_DB} -json "${sql}"`;
}

export const STAGES_CMD = sqliteRead("SELECT name, ord FROM stages ORDER BY ord");

/** Board scope: all live tickets + 48h of terminal history (bounds the 5s poll). */
export const TICKETS_CMD = sqliteRead(
  "SELECT id,kind,title,stage,status,priority,bounce_count,orphaned,blocked_on,dead_letter_reason,created_at_ms,updated_at_ms FROM tickets WHERE status IN ('queued','claimed','in_progress','blocked') OR updated_at_ms >= (CAST(strftime('%s','now') AS INTEGER)*1000 - 172800000) ORDER BY priority DESC, id",
);

/** Matches transient SQLite contention errors that a later poll will clear. */
export const SQLITE_TRANSIENT_RE = /database is locked|database table is locked|SQLITE_BUSY/i;

export function showTicketCmd(id: number): string {
  return `${FTS_BIN} show --db ${FACTORY_DB} ${Math.floor(id)} --json`;
}

/** Stop active work using FTS's audited operator escape hatch. */
export function deadLetterTicketCmd(id: number): string {
  return (
    `${FTS_BIN} dead-letter --db ${FACTORY_DB}` +
    ` --ticket ${Math.floor(id)} --actor ${shellQuote("ftown-ui")}` +
    ` --reason ${shellQuote("stopped by user from ftown dashboard")}`
  );
}

/** Reset a terminal ticket to queued at a selected stage, preserving history. */
export function reviveTicketCmd(id: number, stage: string): string {
  return (
    `${FTS_BIN} revive --db ${FACTORY_DB}` +
    ` --ticket ${Math.floor(id)} --actor ${shellQuote("ftown-ui")}` +
    ` --to-stage ${shellQuote(stage)}`
  );
}

function hasSafePathSegments(path: string): boolean {
  return (
    !/[\0\r\n]/.test(path) &&
    path
      .split("/")
      .every(
        (segment) => segment !== "" && segment !== "." && segment !== "..",
      )
  );
}

/** Ticket file access is confined to fticket's runtime artifact tree. */
export function isTicketFolderPath(folderPath: string): boolean {
  return (
    folderPath.startsWith(".ffactory/tickets/") &&
    hasSafePathSegments(folderPath)
  );
}

export function listTicketArtifactsCmd(folderPath: string): string {
  if (!isTicketFolderPath(folderPath)) {
    throw new Error("invalid ticket artifact folder");
  }
  const folder = shellQuote(folderPath);
  return `test -d ${folder} || { echo 'ticket artifact folder not found' >&2; exit 2; }; find ${folder} -type f -print | LC_ALL=C sort`;
}

export function isTicketArtifactPath(
  folderPath: string,
  relPath: string,
): boolean {
  if (!isTicketFolderPath(folderPath)) return false;
  const prefix = `${folderPath}/`;
  if (!relPath.startsWith(prefix)) return false;
  return hasSafePathSegments(relPath.slice(prefix.length));
}

export function readTicketArtifactCmd(
  folderPath: string,
  relPath: string,
): string {
  if (!isTicketArtifactPath(folderPath, relPath)) {
    throw new Error("invalid ticket artifact path");
  }
  const quotedPath = shellQuote(relPath);
  if (imageMimeType(relPath) !== undefined) {
    return `base64 < ${quotedPath} | tr -d '\\n'`;
  }
  return `cat ${quotedPath}`;
}

export function parseTicketArtifactFiles(
  folderPath: string,
  stdout: string,
): TicketArtifactFile[] {
  const prefix = `${folderPath}/`;
  return stdout
    .split("\n")
    .filter(
      (relPath) =>
        relPath.length > 0 && isTicketArtifactPath(folderPath, relPath),
    )
    .map((relPath) => ({
      relPath,
      name: relPath.slice(prefix.length),
    }));
}

export const LIST_SKILLS_CMD = `ls factory/skills/*.md 2>/dev/null`;

export function readSkillCmd(relPath: string): string {
  return `cat ${shellQuote(relPath)}`;
}

/** Atomic write: decode to a temp file, rename over the target only on success
 *  — a failed decode or killed exec never truncates the existing skill, and
 *  concurrent readers (factory workers) never see a partial file. */
export function writeSkillCmd(relPath: string, content: string): string {
  const target = shellQuote(relPath);
  const tmp = shellQuote(`${relPath}.tmp-write`);
  return `{ printf '%s' ${shellQuote(toBase64(content))} | base64 --decode > ${tmp} && mv ${tmp} ${target}; } || { rm -f ${tmp}; exit 1; }`;
}

// ---------------------------------------------------------------------------
// Ticket creation
// ---------------------------------------------------------------------------

export interface NewTicketInput {
  title: string;
  /** Becomes the ticket's request.md — the groom stage's required input. */
  description: string;
  stage: string; // must be one of snapshot.stages
  priority: number;
  kind: "task" | "epic";
}

/** Folder slug for a new ticket: lowercase alnum-dash, capped, never empty. */
export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "ticket";
}

/** mkdir the folder, seed request.md (groom's required input — a ticket
 *  without it can never leave the first stage), then create; stdout is the
 *  new id. request.md travels base64 to survive any content. */
export function createTicketCmd(input: NewTicketInput, folder: string): string {
  const requestMd = `# ${input.title.trim()}\n\n${input.description.trim()}\n`;
  return (
    `mkdir -p ${shellQuote(folder)}` +
    ` && printf '%s' ${shellQuote(toBase64(requestMd))} | base64 --decode > ${shellQuote(`${folder}/request.md`)}` +
    ` && ${FTS_BIN} create --db ${FACTORY_DB}` +
    ` --title ${shellQuote(input.title)} --stage ${shellQuote(input.stage)}` +
    ` --folder ${shellQuote(folder)} --priority ${Math.floor(input.priority)}` +
    ` --kind ${input.kind}`
  );
}

// ---------------------------------------------------------------------------
// Factory creation — spawn a claude agent session that runs the /factory skill
// ---------------------------------------------------------------------------

/** Agent harnesses that can run the factory-init deployment session. */
export const FACTORY_INIT_HARNESSES = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "zai",
  "kimi",
  "deepseek",
  "fireworks",
] as const satisfies readonly ShellType[];

export type FactoryInitHarness = (typeof FACTORY_INIT_HARNESSES)[number];

export interface NewFactoryInput {
  bridgeId: string;
  repoPath: string; // absolute path on the bridge host
  project: string;
  harness: FactoryInitHarness; // default "claude"
  model?: string; // harness default when absent
}

/** The bridge installs its bundled factory skill here at startup (>=0.19.0). */
export const FACTORY_SKILL_PATH = "~/.ftown/skills/factory/SKILL.md";

export function factoryInitPrompt(input: NewFactoryInput): string {
  const initiatorRoute = input.model?.trim()
    ? `The initiating agent is "${input.harness}" with model "${input.model.trim()}".`
    : `The initiating agent is "${input.harness}" using its default model.`;

  return (
    `Deploy a software factory for project "${input.project}" in ${input.repoPath}.\n\n` +
    `${initiatorRoute} Use that same agent routing for every stage, triage, and digest. ` +
    `If no model is named, remove the template's per-role model values so the harness ` +
    `default is used. Explicit user routing choices override this default; otherwise do ` +
    `not preserve the template's mixed harness/model routing.\n\n` +
    `Read ${FACTORY_SKILL_PATH} (installed by the ftown bridge; the project template ` +
    `lives next to it at ~/.ftown/skills/factory/factory-template) and follow its ` +
    `"init" procedure exactly for this repo with project name "${input.project}", then ` +
    `follow its "up" procedure to register the grouped ftown loops. Report the loop ` +
    `names and group when done.\n\n` +
    `If ${FACTORY_SKILL_PATH} does not exist, STOP and report that the ftown bridge on ` +
    `this host must be upgraded to >=0.19.0 (which bundles the factory skill) — do not ` +
    `improvise a factory from memory.`
  );
}

// ---------------------------------------------------------------------------
// Worker sessions — the dispatcher names workers "<project>-t<ticketId>-<stage>"
// ---------------------------------------------------------------------------

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Stage names are user-authored and unrestricted (dots etc.) — match greedily
 *  after the ticket id instead of assuming a charset. */
export function workerSessionRe(project: string): RegExp {
  return new RegExp(`^${escapeRegExp(project)}-t(\\d+)-(.+)$`);
}

/** Identity for selection/dedupe — project names may repeat across bridges. */
export function factoryKey(f: FactoryInfo): string {
  return `${f.bridgeId}:${f.project}`;
}

/** A factory worker run: an ftown Session matched by workerSessionRe. */
export interface WorkerRun {
  session: Session;
  ticketId: number;
  stage: string;
}

/** The factory a session belongs to (bridge + name pattern), or null. Used to
 *  move worker sessions out of the Sessions list and under their factory. */
export function factoryWorkerOf(
  session: Session,
  factories: FactoryInfo[],
): FactoryInfo | null {
  for (const f of factories) {
    if (session.bridgeId !== f.bridgeId) continue;
    if (workerSessionRe(f.project).test(session.name)) return f;
  }
  return null;
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
  listTicketArtifacts: (folderPath: string) => Promise<TicketArtifactFile[]>;
  readTicketArtifact: (folderPath: string, relPath: string) => Promise<string>;
  /** Moves the ticket to dead_letter through FTS, preserving its audit trail. */
  stopTicket: (id: number) => Promise<void>;
  /** Resets a terminal ticket to queued at the selected pipeline stage. */
  requeueTicket: (id: number, stage: string) => Promise<void>;
  listSkills: () => Promise<SkillFile[]>;
  readSkill: (relPath: string) => Promise<string>;
  writeSkill: (relPath: string, content: string) => Promise<void>;
  /** mkdir folder + fts create; resolves the new ticket id, then refreshes. */
  createTicket: (input: NewTicketInput) => Promise<number>;
}

// ---------------------------------------------------------------------------
// Component prop contracts
// ---------------------------------------------------------------------------

export interface FactoryListProps {
  factories: FactoryInfo[];
  /** factoryKey() of the selected factory — bridge-aware, unlike project alone. */
  selectedKey: string | null;
  onSelect: (factory: FactoryInfo) => void;
  collapsed: boolean;
  /** Opens the new-factory modal (owned by Dashboard). Hidden when absent. */
  onCreateFactory?: () => void;
  /** All sessions; each factory row nests its workers (factoryWorkerOf). */
  sessions: Session[];
  /** Selecting a nested worker session opens its terminal. */
  onOpenSession: (sessionId: string) => void;
  /** Stops and tombstone-archives a nested worker session. */
  onRemoveSession: (sessionId: string) => void;
  /** Currently open session id — highlights the nested worker row. */
  selectedSessionId: string | null;
  /** factoryKey()s hidden by the user; hidden factories fold into a "hidden"
   *  section like SessionList does for sessions. */
  hiddenFactoryKeys?: Set<string>;
  onHideFactory?: (key: string) => void;
  onUnhideFactory?: (key: string) => void;
}

export interface NewTicketFormProps {
  stages: string[]; // snapshot.stages; disable submit while empty
  onCreate: (input: NewTicketInput) => Promise<number>;
  onClose: () => void;
}

export interface NewFactoryModalProps {
  bridges: Array<{ bridgeId: string; label: string }>;
  onSubmit: (input: NewFactoryInput) => Promise<void>;
  onClose: () => void;
}

export interface FactoryPaneProps {
  factory: FactoryInfo;
  bridgeExec: BridgeExecFn;
  sessions: Session[];
  onOpenSession: (sessionId: string) => void;
}

export interface FactoryBoardProps {
  /** Stable per-factory identity used to scope local board preferences. */
  factoryIdentity: string;
  snapshot: FactorySnapshot | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
  showTicket: (id: number) => Promise<TicketDetail>;
  listTicketArtifacts: (folderPath: string) => Promise<TicketArtifactFile[]>;
  readTicketArtifact: (folderPath: string, relPath: string) => Promise<string>;
  stopTicket: (id: number) => Promise<void>;
  requeueTicket: (id: number, stage: string) => Promise<void>;
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
