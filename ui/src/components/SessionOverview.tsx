"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { Session, SessionCard, SessionStatus } from "@/types";
import { markdownPreviewDocument } from "@/lib/session-preview";
import { relativeTime } from "@/lib/relative-time";
import type { SessionActivity } from "@/hooks/useAllSessionEvents";
import { SessionCardChip, cardStateLabel, cardStateStyle } from "./SessionCardChip";
import { PullRequestLink } from "./PullRequestLink";

export interface OpenAttentionCount { open: number; withParent: number }

// ───────────────── Snapshot shapes (mirror bridge/src/coordination/contract-c.ts) ─────────────────

export type PlanItem = NonNullable<Session["plan"]>["items"][number];
export interface PlanView { items: PlanItem[]; ready: string[] }

export interface SnapshotCard {
  archived?: boolean;
  sessionId: string;
  name: string;
  parentSessionId?: string;
  declared: SessionCard | null;
  derived: {
    status: SessionStatus;
    activity: "thinking" | "tool_use" | "idle" | "unknown";
    idleSince?: string;
    openAttention: number;
    unreadMail: number;
    pr?: { url: string; state: string; stale: boolean; checkedAt: string | null };
    previews: string[];
    shellType?: string;
    model?: string;
  };
  stale: boolean;
}

export interface SnapshotEvent {
  seq: number;
  ts: string;
  sessionId: string;
  sessionName: string;
  kind: string;
  summary: string;
  ref?: string;
}

export interface SnapshotAttentionEvent {
  id: string;
  title: string;
  message?: string;
  resolvedAt?: string;
  route?: string;
  escalatedAt?: string;
  escalationNote?: string;
  prompt?: { questions: ReadonlyArray<{ options: ReadonlyArray<{ label: string }> }> };
}

export interface OverviewSnapshot {
  board: { rootId: string; cards: ReadonlyArray<SnapshotCard>; plan?: PlanView };
  events: ReadonlyArray<SnapshotEvent>;
  attention: ReadonlyArray<{ sessionId: string; event: SnapshotAttentionEvent }>;
}

export interface SessionOverviewProps {
  /** The selected manager session whose children are summarised. */
  session: Session;
  /** All known sessions; children are derived (parentSessionId === session.id). */
  sessions: ReadonlyArray<Session>;
  /** Live activity per session id, when the caller has the dashboard map. */
  activityBySession?: ReadonlyMap<string, Pick<SessionActivity, "activity" | "attention" | "toolName">>;
  /** Open attention items per session id; withParent counts items still waiting with the parent. */
  openAttentionBySession?: ReadonlyMap<string, OpenAttentionCount>;
  /** Board snapshot (get_session_board). Without it the Overview falls back to the session list. */
  snapshot?: OverviewSnapshot;
  /** ISO timestamp at which each session's activity became idle (recorded from hook events). */
  idleSince?: Readonly<Record<string, string>>;
  /** Plan in precedence order; defaults to the snapshot's plan, then the manager session's own plan. */
  plan?: PlanView;
  /** Clock for deterministic card-age rendering in tests. */
  now?: number;
}

/** Children of `session`, oldest first (the order the tree was built in). */
export function childSessionsOf(session: Session, sessions: ReadonlyArray<Session>): Session[] {
  return sessions
    .filter(candidate => candidate.parentSessionId === session.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

// ───────────────── Plan ordering (identical to bridge/src/coordination/plan.ts orderPlan) ─────────────────

const byTime = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** ready>waiting>started>done>dropped; within ready/waiting: priority asc, createdAt asc. */
export function orderPlan(items: ReadonlyArray<PlanItem>): PlanView {
  const settled = new Set(items.filter(item => item.state === "done" || item.state === "dropped").map(item => item.id));
  const isReady = (item: PlanItem) => item.state === "todo" && item.after.every(id => settled.has(id));
  const queue = (a: PlanItem, b: PlanItem) => a.priority - b.priority || byTime(a.createdAt, b.createdAt);
  const ready = items.filter(isReady).sort(queue);
  const waiting = items.filter(item => item.state === "todo" && !isReady(item)).sort(queue);
  const started = items.filter(item => item.state === "started").sort((a, b) => byTime(a.updatedAt, b.updatedAt));
  const done = items.filter(item => item.state === "done").sort((a, b) => byTime(b.updatedAt, a.updatedAt));
  const dropped = items.filter(item => item.state === "dropped").sort((a, b) => byTime(b.updatedAt, a.updatedAt));
  return { items: [...ready, ...waiting, ...started, ...done, ...dropped], ready: ready.map(item => item.id) };
}

// ───────────────── Rows model ─────────────────

export type AttentionOwner = "you" | "manager";

export interface OverviewEntry {
  id: string;
  name: string;
  archived: boolean;
  status?: SessionStatus;
  createdAt: string;
  card?: SessionCard;
  stale: boolean;
  activity?: "thinking" | "tool_use" | "idle" | "unknown";
  toolName?: string;
  idleSince?: string;
  /** open attention items waiting on the human (not parent-routed). */
  humanQuestions: number;
  openAttention: number;
  unreadMail: number;
  prUrl?: string;
  prState?: string;
  worktree?: Session["worktree"];
  previews: string[];
  agent: string;
}

export interface PartitionedChildren<T> { attention: T[]; active: T[]; done: T[] }

const CARD_STALE_MS = 10 * 60_000;

function isDone(entry: OverviewEntry): boolean {
  return entry.archived || entry.card?.state === "done" || (!entry.card && entry.status === "completed");
}

/**
 * Splits children into needs-attention (failed | blocked | escalated question; `attention` maps id → owner),
 * active and done (done/archived). `you` rows sort first in attention; active is waiting review → working
 * (newest first) → no card; done keeps the input order.
 */
export function partitionChildren<T extends OverviewEntry>(children: ReadonlyArray<T>, attention: ReadonlyMap<string, AttentionOwner>): PartitionedChildren<T> {
  const needs: T[] = [];
  const active: T[] = [];
  const done: T[] = [];
  for (const child of children) {
    if (attention.has(child.id) && !child.archived) needs.push(child);
    else if (isDone(child)) done.push(child);
    else active.push(child);
  }
  const owner = (child: T) => (attention.get(child.id) === "you" ? 0 : 1);
  const rank = (child: T) => (child.card?.state === "waiting_review" ? 0 : child.card ? 1 : 2);
  const updated = (child: T) => child.card?.updatedAt ?? "";
  needs.sort((a, b) => owner(a) - owner(b));
  active.sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? byTime(updated(b), updated(a)) : 0));
  return { attention: needs, active, done };
}

function agentLabel(shellType?: string, model?: string): string {
  return [shellType, model].filter(Boolean).join(" · ");
}

function buildEntries(children: ReadonlyArray<Session>, props: SessionOverviewProps): OverviewEntry[] {
  const { snapshot, activityBySession, openAttentionBySession, idleSince, now = Date.now() } = props;
  const byId = new Map(children.map(child => [child.id, child]));
  const humanItems = (id: string) => snapshot?.attention.filter(item => item.sessionId === id && !item.event.resolvedAt && item.event.route !== "parent") ?? [];
  const shared = (id: string, card: SessionCard | undefined, derivedActivity: OverviewEntry["activity"], derivedIdle: string | undefined, openFallback: number) => {
    const live = activityBySession?.get(id);
    const counts = openAttentionBySession?.get(id);
    const open = counts?.open ?? openFallback;
    return {
      activity: live?.activity ?? derivedActivity,
      toolName: live?.toolName,
      idleSince: idleSince?.[id] ?? derivedIdle,
      openAttention: open,
      humanQuestions: snapshot ? humanItems(id).length : Math.max(0, open - (counts?.withParent ?? 0)),
      stale: card?.state === "working" && now - Date.parse(card.updatedAt) > CARD_STALE_MS,
    };
  };

  const entries: OverviewEntry[] = [];
  const seen = new Set<string>();
  for (const card of snapshot?.board.cards ?? []) {
    seen.add(card.sessionId);
    const session = byId.get(card.sessionId);
    const base = shared(card.sessionId, card.declared ?? undefined, card.derived.activity, card.derived.idleSince, card.derived.openAttention);
    entries.push({
      id: card.sessionId,
      name: card.name || session?.name || card.sessionId,
      archived: !!card.archived,
      status: card.derived.status,
      createdAt: session?.createdAt ?? "",
      card: card.declared ?? undefined,
      ...base,
      stale: card.declared ? card.stale : false,
      unreadMail: card.derived.unreadMail,
      prUrl: card.derived.pr?.url ?? session?.pullRequestUrl,
      prState: card.derived.pr?.state,
      worktree: session?.worktree,
      previews: card.derived.previews,
      agent: agentLabel(card.derived.shellType ?? session?.shellType, card.derived.model ?? session?.model),
    });
  }
  for (const child of children) {
    if (seen.has(child.id)) continue;
    entries.push({
      id: child.id,
      name: child.name || child.prompt?.slice(0, 48) || child.id,
      archived: false,
      status: child.status,
      createdAt: child.createdAt,
      card: child.card,
      ...shared(child.id, child.card, undefined, undefined, 0),
      unreadMail: 0,
      prUrl: child.pullRequestUrl,
      worktree: child.worktree,
      previews: child.preview?.files.map(file => file.fileName) ?? [],
      agent: agentLabel(child.shellType, child.model),
    });
  }
  return entries;
}

function attentionOwners(entries: ReadonlyArray<OverviewEntry>): Map<string, AttentionOwner> {
  const owners = new Map<string, AttentionOwner>();
  for (const entry of entries) {
    const state = entry.card?.state;
    if (entry.humanQuestions > 0 || (state === "blocked" && entry.card?.blockedOn?.kind === "human")) owners.set(entry.id, "you");
    else if (state === "failed" || state === "blocked") owners.set(entry.id, "manager");
  }
  return owners;
}

// ───────────────── Formatting ─────────────────

/** `10:05` in the viewer's local time; "" when the timestamp is unparseable. */
function clock(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function idleLabel(idleSince: string | undefined, now: number): string {
  const minutes = idleSince ? Math.max(0, Math.floor((now - Date.parse(idleSince)) / 60_000)) : null;
  return minutes === null || Number.isNaN(minutes) ? "idle" : `idle ${minutes}m`;
}

function activityText(entry: OverviewEntry, now: number): string | null {
  if (entry.status === "completed" || entry.status === "error") return "■ session exited";
  if (entry.activity === "tool_use") return `⚙ using ${entry.toolName ?? "a tool"}`;
  if (entry.activity === "thinking") return "◌ thinking…";
  if (entry.activity === "idle") return `◦ ${idleLabel(entry.idleSince, now)}`;
  return null;
}

interface EventLine { key: string; time: string; name: string; summary: string; full: string; count: number }

function firstSegment(summary: string): string {
  return summary.includes(" | ") ? summary.split(" | ")[0]! : summary;
}

/** Newest first; identical consecutive events collapse to ×n; the time is printed once per minute. */
function eventLines(events: ReadonlyArray<SnapshotEvent>): EventLine[] {
  const lines: EventLine[] = [];
  let previousMinute = "";
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const last = lines[lines.length - 1];
    if (last && last.name === event.sessionName && last.full === event.summary) { last.count += 1; continue; }
    const minute = clock(event.ts);
    lines.push({ key: String(event.seq), time: minute === previousMinute ? "" : minute, name: event.sessionName, summary: firstSegment(event.summary), full: event.summary, count: 1 });
    previousMinute = minute;
  }
  return lines;
}

// ───────────────── Styles ─────────────────

const MONO: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 11 };
const resetButton: CSSProperties = { background: "none", border: "none", padding: 0, margin: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer" };
const STYLE_SHEET = `
.ov-row{border-radius:4px}
.ov-row:hover,.ov-row:focus-within{background:var(--bg-hover)}
.ov-age{opacity:0}
.ov-row:hover .ov-age,.ov-row:focus-within .ov-age,.ov-row[data-open="true"] .ov-age{opacity:1}
`;

function GroupLabel({ children, accent = false }: { children: ReactNode; accent?: boolean }) {
  return <h3 style={{ ...MONO, margin: 0, fontWeight: 500, color: accent ? "var(--status-pending)" : "var(--text-faint)" }}>{children}</h3>;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, minWidth: 0 }}>
      <dt style={{ color: "var(--text-faint)", width: 64, flexShrink: 0 }}>{label}</dt>
      <dd style={{ margin: 0, color: "var(--text-secondary)", minWidth: 0, overflowWrap: "anywhere" }}>{children}</dd>
    </div>
  );
}

interface RowContext {
  now: number;
  managerName: string;
  events: ReadonlyArray<SnapshotEvent>;
  items: SnapshotOverviewItems;
}
type SnapshotOverviewItems = OverviewSnapshot["attention"];

function OverviewRow({ entry, owner, open, onToggle, context, faint = false }: {
  entry: OverviewEntry;
  owner?: AttentionOwner;
  open: boolean;
  onToggle: () => void;
  context: RowContext;
  faint?: boolean;
}) {
  const { now, managerName } = context;
  const card = entry.card;
  const retired = entry.archived;
  const glyph = retired ? { icon: "⌀", color: "var(--text-faint)" } : card ? cardStateStyle(card.state) : { icon: "○", color: "var(--text-faint)" };
  const glyphColor = retired || entry.stale || (faint && card?.state === "done") ? "var(--text-faint)" : glyph.color;
  const headline = card?.headline || card?.blockedOn?.text || "";
  const loud = owner !== undefined;
  const activity = activityText(entry, now);
  const questions = context.items.filter(item => item.sessionId === entry.id && !item.event.resolvedAt);
  const recent = context.events.filter(event => event.sessionId === entry.id).slice(-3).reverse();
  const stateLabel = retired
    ? "retired"
    : card
      ? `${card.state === "blocked" && card.blockedOn ? `blocked on ${card.blockedOn.kind}` : cardStateLabel(card.state)}${card.progress && card.progress.total > 0 && card.state !== "done" ? ` ${card.progress.done}/${card.progress.total}` : ""} · updated ${relativeTime(card.updatedAt, now)}${entry.stale ? " · stale" : ""}`
      : null;

  return (
    <li className="ov-row" data-open={open} style={{ listStyle: "none" }}>
      <button
        type="button"
        data-overview-row=""
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); onToggle(); } }}
        style={{ ...resetButton, display: "flex", alignItems: "baseline", gap: 8, width: "100%", padding: "5px 4px", fontSize: 13, lineHeight: 1.4 }}
      >
        <span aria-hidden style={{ color: glyphColor, width: 12, flexShrink: 0 }}>{glyph.icon}</span>
        {retired && <span style={{ ...MONO, color: "var(--text-faint)", flexShrink: 0 }}>retired</span>}
        <span style={{ color: faint ? "var(--text-faint)" : "var(--text-primary)", fontWeight: loud ? 600 : 500, flexShrink: 0 }}>{entry.name}</span>
        <span title={headline} style={{ color: faint ? "var(--text-faint)" : loud ? "var(--text-primary)" : "var(--text-muted)", flex: 1, minWidth: 0, ...(open ? { overflowWrap: "anywhere" } : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }) }}>{headline}</span>
        {card && <span className="ov-age" style={{ ...MONO, color: "var(--text-faint)", flexShrink: 0 }}>{relativeTime(card.updatedAt, now)}</span>}
        {owner && <span style={{ ...MONO, color: owner === "you" ? "var(--status-pending)" : "var(--text-faint)", flexShrink: 0 }}>{owner === "you" ? "you" : managerName}</span>}
      </button>
      {open && (
        <dl style={{ ...MONO, margin: "2px 0 8px 24px", display: "flex", flexDirection: "column", gap: 2 }}>
          {stateLabel && <Detail label="state">{stateLabel}</Detail>}
          {card?.state === "blocked" && card.blockedOn && <Detail label="blocked">{card.blockedOn.text}</Detail>}
          {questions.length > 0
            ? questions.map(({ event }) => (
                <Detail key={event.id} label="question">
                  {event.title}
                  {" · "}{event.route === "parent" && !event.escalatedAt ? `with ${managerName}` : "you"}
                  {event.escalationNote ? ` · ${event.escalationNote}` : ""}
                  {event.prompt?.questions[0]?.options.length ? ` · ${event.prompt.questions[0].options.map(option => option.label).join(" / ")}` : ""}
                </Detail>
              ))
            : entry.openAttention > 0 && <Detail label="question">{entry.openAttention} open</Detail>}
          {card?.next && <Detail label="next">{card.next}</Detail>}
          {activity && <Detail label="activity">{activity}</Detail>}
          {entry.prUrl && <Detail label="pr"><PullRequestLink url={entry.prUrl} badge />{entry.prState ? ` ${entry.prState.replaceAll("_", " ")}` : ""}</Detail>}
          {entry.worktree && <Detail label="worktree"><span title={entry.worktree.path}>{entry.worktree.branch}</span>{entry.worktree.retained ? ` · retained: ${entry.worktree.retained.reason}` : ""}</Detail>}
          {entry.unreadMail > 0 && <Detail label="mail">{entry.unreadMail} unread</Detail>}
          {entry.previews.length > 0 && <Detail label="preview">{entry.previews.join(", ")}</Detail>}
          {entry.agent && <Detail label="agent">{entry.agent}</Detail>}
          {recent.length > 0 && (
            <Detail label="events">
              {recent.map(event => <div key={event.seq}>{clock(event.ts)} {firstSegment(event.summary)}</div>)}
            </Detail>
          )}
        </dl>
      )}
    </li>
  );
}

function OverviewFold({ label, peek, open, onToggle, children }: { label: string; peek?: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section aria-label={label.split(" ")[0]}>
      <button type="button" data-overview-row="" aria-expanded={open} onClick={onToggle} style={{ ...resetButton, ...MONO, color: "var(--text-faint)", display: "flex", gap: 8, width: "100%", padding: "3px 4px" }}>
        <span aria-hidden>{open ? "▾" : "▸"}</span>
        <span>{label}</span>
        {peek && !open && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{peek}</span>}
      </button>
      {open && <div style={{ marginTop: 4 }}>{children}</div>}
    </section>
  );
}

const PLAN_MARKS = { ready: "→", waiting: "·", started: "▸", done: "✓", dropped: "✗" } as const;
const EVENTS_PAGE = 12;

const ROW_SELECTOR = "[data-overview-row]";
/** Elements that consume keys themselves: text entry plus the terminal's xterm region. */
const KEY_SINK_SELECTOR = "input,textarea,select,iframe,[contenteditable=''],[contenteditable='true'],.xterm,[role='textbox'],[role='listbox'],[role='grid'],[role='slider'],[role='combobox']";
/** While an overlay with its own keys is open the Overview stays out of the way. */
const OPEN_OVERLAY_SELECTOR = "[role='dialog'],[role='alertdialog'],[role='menu'],[aria-modal='true'],dialog[open]";

/** False when the element or an ancestor is removed from the DOM or display:none (mounted but hidden). */
function isDisplayed(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden || node.ownerDocument.defaultView?.getComputedStyle(node).display === "none") return false;
  }
  return true;
}

/** j/ArrowDown focuses the next row (the first when none is focused yet); k/ArrowUp the previous. */
function moveRowFocus(rows: ReadonlyArray<HTMLElement>, target: HTMLElement | null, key: string): void {
  const index = target ? rows.indexOf(target) : -1;
  if (key === "j" || key === "ArrowDown") rows[Math.min(rows.length - 1, index + 1)]?.focus();
  else rows[Math.max(0, index - 1)]?.focus();
}

/** Manager view for a session with children: one line per child, folded groups for the rest. */
export function SessionOverview(props: SessionOverviewProps) {
  const { session, sessions, snapshot, now = Date.now() } = props;
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [allOpen, setAllOpen] = useState(false);
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(new Set());
  const [eventLimit, setEventLimit] = useState(EVENTS_PAGE);
  const [unwrapped, setUnwrapped] = useState<ReadonlySet<string>>(new Set());
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // With no row focused yet (the document itself holds focus) the Overview's own handler never
    // fires, so listen globally. Only j/k: from outside the Overview the arrows must keep their
    // native behaviour (page scrolling). Never take keys from text entry, the terminal, or an open
    // dialog/menu, and do nothing while the Overview is mounted but hidden.
    function onDocumentKeyDown(event: globalThis.KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const root = rootRef.current;
      if (event.metaKey || event.ctrlKey || event.altKey || !target || !root || !isDisplayed(root)) return;
      if (target.closest(KEY_SINK_SELECTOR) || root.ownerDocument.querySelector(OPEN_OVERLAY_SELECTOR)) return;
      if (root.contains(target)) return;
      if (event.key !== "j" && event.key !== "k") return;
      const rows = Array.from(root.querySelectorAll<HTMLElement>(ROW_SELECTOR));
      if (rows.length === 0) return;
      event.preventDefault();
      moveRowFocus(rows, target, event.key);
    }
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, []);

  const entries = buildEntries(childSessionsOf(session, sessions), props);
  if (entries.length === 0) return null;

  const owners = attentionOwners(entries);
  const groups = partitionChildren(entries, owners);
  const managerName = session.name || session.id;
  const events = snapshot?.events ?? [];
  const plan = props.plan ?? snapshot?.board.plan ?? (session.plan?.items.length ? orderPlan(session.plan.items) : undefined);
  const context: RowContext = { now, managerName, events, items: snapshot?.attention ?? [] };
  const brief = session.brief;

  const flip = (set: ReadonlySet<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  };
  const isOpen = (id: string) => allOpen !== toggled.has(id);
  const toggleFold = (key: string) => setOpenFolds(current => flip(current, key));
  const rows = (list: OverviewEntry[], faint = false) => (
    <ul style={{ margin: 0, padding: 0 }}>
      {list.map(entry => <OverviewRow key={entry.id} entry={entry} owner={faint ? undefined : owners.get(entry.id)} open={isOpen(entry.id)} onToggle={() => setToggled(current => flip(current, entry.id))} context={context} faint={faint} />)}
    </ul>
  );

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (event.metaKey || event.ctrlKey || event.altKey || target.closest(KEY_SINK_SELECTOR)) return;
    const focusable = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ?? []);
    if (event.key === "j" || event.key === "ArrowDown" || event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      moveRowFocus(focusable, target, event.key);
    } else if (event.key === "d") {
      setAllOpen(current => !current);
      setToggled(new Set());
    } else if (event.key === "e") {
      toggleFold("events");
    } else if (event.key === "Escape") {
      setAllOpen(false);
      setToggled(new Set());
      setOpenFolds(new Set());
    }
  };

  const doneNames = groups.done.slice(0, 3).map(entry => entry.name).join(", ") + (groups.done.length > 3 ? ` +${groups.done.length - 3}` : "");
  const lines = eventLines(events);
  const lastEvent = events[events.length - 1];
  const activePlan = plan?.items.filter(item => item.state === "todo" || item.state === "started").length ?? 0;
  const nextItem = plan?.items.find(item => plan.ready.includes(item.id));
  const childName = (id?: string) => entries.find(entry => entry.id === id)?.name ?? id;

  return (
    <section ref={rootRef} aria-label={`Overview: ${managerName}`} onKeyDown={onKeyDown}
      style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--bg-base)", color: "var(--text-primary)" }}>
      <style>{STYLE_SHEET}</style>
      <div style={{ padding: "16px 16px 32px", maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 28 }}>
        <div data-testid="manager-line" style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0, marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 500, flexShrink: 0 }}>{managerName}</span>
          <SessionCardChip card={session.card} />
        </div>

        {groups.attention.length > 0 && (
          <section aria-label="Needs attention" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <GroupLabel accent>needs attention · {groups.attention.length}</GroupLabel>
            {rows(groups.attention)}
          </section>
        )}

        {groups.active.length > 0 && (
          <section aria-label="Active" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <GroupLabel>active · {groups.active.length}</GroupLabel>
            {rows(groups.active)}
          </section>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {plan && plan.items.length > 0 && (
            <OverviewFold label={`planned · ${activePlan}`} peek={nextItem ? `next: ${nextItem.title}` : undefined} open={openFolds.has("planned")} onToggle={() => toggleFold("planned")}>
              <ol style={{ margin: 0, padding: 0 }}>
                {plan.items.map((item) => {
                  const mark = item.state === "todo" ? (plan.ready.includes(item.id) ? PLAN_MARKS.ready : PLAN_MARKS.waiting) : PLAN_MARKS[item.state];
                  const key = `plan:${item.id}`;
                  const open = allOpen !== toggled.has(key);
                  const dim = item.state === "done" || item.state === "dropped";
                  const after = item.after.map(id => plan.items.find(other => other.id === id)?.title ?? id);
                  return (
                    <li key={item.id} className="ov-row" data-open={open} style={{ listStyle: "none" }}>
                      <button type="button" data-overview-row="" aria-expanded={open} onClick={() => setToggled(current => flip(current, key))}
                        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); setToggled(current => flip(current, key)); } }}
                        style={{ ...resetButton, display: "flex", alignItems: "baseline", gap: 8, width: "100%", padding: "5px 4px", fontSize: 13 }}>
                        <span aria-hidden style={{ ...MONO, color: "var(--text-faint)", width: 12, flexShrink: 0 }}>{mark}</span>
                        <span style={{ ...MONO, color: "var(--text-faint)", flexShrink: 0 }}>{item.id}</span>
                        <span style={{ color: dim ? "var(--text-faint)" : "var(--text-muted)", flex: 1, minWidth: 0, ...(open ? {} : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }) }}>{item.title}</span>
                      </button>
                      {open && (
                        <dl style={{ ...MONO, margin: "2px 0 8px 24px", display: "flex", flexDirection: "column", gap: 2 }}>
                          <Detail label="after">{after.length > 0 ? `after ${after.join(", ")}${plan.ready.includes(item.id) ? " · ready to start" : ""}` : item.state === "todo" ? "ready to start" : item.state}</Detail>
                          {item.sessionId && <Detail label="session">→ {childName(item.sessionId)}</Detail>}
                          {item.note && <Detail label="note">{item.note}</Detail>}
                        </dl>
                      )}
                    </li>
                  );
                })}
              </ol>
            </OverviewFold>
          )}

          {groups.done.length > 0 && (
            <OverviewFold label={`done · ${groups.done.length}`} peek={doneNames} open={openFolds.has("done")} onToggle={() => toggleFold("done")}>
              {rows(groups.done, true)}
            </OverviewFold>
          )}

          {snapshot && (
            <OverviewFold label={`events · ${events.length}`} peek={lastEvent ? `last ${clock(lastEvent.ts)} ${lastEvent.sessionName} ${firstSegment(lastEvent.summary)}` : undefined} open={openFolds.has("events")} onToggle={() => toggleFold("events")}>
              <div style={{ ...MONO, display: "flex", flexDirection: "column", gap: 2 }}>
                {lines.slice(0, eventLimit).map(line => {
                  const wide = unwrapped.has(line.key);
                  return (
                    <button key={line.key} type="button" aria-expanded={wide} onClick={() => setUnwrapped(current => flip(current, line.key))}
                      style={{ ...resetButton, display: "flex", gap: 8, color: "var(--text-secondary)", ...(wide ? { overflowWrap: "anywhere" } : { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }) }}>
                      <span style={{ color: "var(--text-faint)", width: 34, flexShrink: 0 }}>{line.time}</span>
                      <span style={{ flexShrink: 0 }}>{line.name}</span>
                      <span style={{ minWidth: 0 }}>{wide ? line.full : line.summary}{line.count > 1 ? ` ×${line.count}` : ""}</span>
                    </button>
                  );
                })}
                {lines.length > eventLimit && (
                  <button type="button" onClick={() => setEventLimit(limit => limit + EVENTS_PAGE)} style={{ ...resetButton, color: "var(--text-faint)" }}>show {lines.length - eventLimit} older</button>
                )}
              </div>
            </OverviewFold>
          )}

          {brief?.text && (
            <OverviewFold label="brief" peek={`updated ${relativeTime(brief.updatedAt, now)}`} open={openFolds.has("brief")} onToggle={() => toggleFold("brief")}>
              <iframe title={`Brief: ${managerName}`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={markdownPreviewDocument(brief.text, `${managerName} brief`)}
                style={{ width: "100%", height: 360, border: "none", borderRadius: 8, background: "var(--bg-surface)" }} />
            </OverviewFold>
          )}
        </div>
      </div>
    </section>
  );
}
