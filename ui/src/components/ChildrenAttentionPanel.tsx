"use client";

import { useEffect, useState } from "react";
import type { Session } from "@/types";
import type { ManualInputNotice } from "@/lib/hook-events";
import { isWithParentNotice } from "@/lib/hook-events";
import { relativeTime } from "@/lib/relative-time";
import type { AttentionAnswerEntry } from "../../../bridge/src/attention-prompt-protocol";
import type { AttentionAnswerSubmitResult } from "./AttentionAnswerForm";
import { InboxItemBody, type InboxEntry } from "./SessionInbox";
import type { OverviewSnapshot } from "./SessionOverview";

export type ChildAttentionState = "coordinator" | "escalated" | "answered";

/** One open child attention item in the coordinator panel; `live` when it is the session's inbox slot item. */
export interface ChildAttentionItem { entry: InboxEntry; eventId: string; live: boolean }

/** Waiting on the coordinator while parent-routed; escalated (or direct) human items wait on you; answered keeps its provenance. */
export function childAttentionState(notice: Pick<ManualInputNotice, "route" | "escalatedAt" | "answeredBy">): ChildAttentionState {
  if (notice.answeredBy) return "answered";
  if (isWithParentNotice(notice)) return "coordinator";
  return "escalated";
}

export function childAttentionStateLabel(state: ChildAttentionState): string {
  if (state === "coordinator") return "Waiting on coordinator";
  if (state === "answered") return "Answered";
  return "Escalated to you";
}

const DURABLE_TYPES = new Set(["agent_needs_input", "ask_user"]);

/**
 * Panel items for one coordinator: the live inbox entries of its children first
 * (they answer through the slot-guarded inbox path), then any other open items
 * from the board snapshot. Resolved items and other sessions' items are dropped.
 * Newest first; event id breaks ties so the order is deterministic.
 */
export function mergeChildAttentionItems(input: {
  childIds: ReadonlySet<string>;
  liveEntries: ReadonlyArray<InboxEntry>;
  snapshotAttention?: OverviewSnapshot["attention"];
  sessionsById: ReadonlyMap<string, Session>;
  /** Items resolved through the panel whose board snapshot has not caught up yet. */
  excludeIds?: ReadonlySet<string>;
}): ChildAttentionItem[] {
  const items: ChildAttentionItem[] = [];
  const seen = new Set<string>();
  for (const entry of input.liveEntries) {
    const eventId = entry.notice.attentionId;
    if (!eventId || !input.childIds.has(entry.session.id) || seen.has(eventId) || input.excludeIds?.has(eventId)) continue;
    seen.add(eventId);
    items.push({ entry, eventId, live: true });
  }
  for (const { sessionId, event } of input.snapshotAttention ?? []) {
    if (!input.childIds.has(sessionId) || event.resolvedAt || seen.has(event.id) || input.excludeIds?.has(event.id)) continue;
    if (event.type !== undefined && !DURABLE_TYPES.has(event.type)) continue;
    const session = input.sessionsById.get(sessionId);
    if (!session) continue;
    seen.add(event.id);
    const routedParent = event.route === "parent" && event.routedTo ? input.sessionsById.get(event.routedTo) : undefined;
    const parentName = event.route === "parent" && event.routedTo
      ? routedParent?.name || routedParent?.prompt?.slice(0, 36) || event.routedTo
      : undefined;
    const receivedAt = event.createdAt ? Date.parse(event.createdAt) : 0;
    const notice: ManualInputNotice = {
      type: event.type === "ask_user" ? "ask_user" : "agent_needs_input",
      title: event.title,
      message: event.message ?? "",
      receivedAt: Number.isFinite(receivedAt) ? receivedAt : 0,
      attentionId: event.id,
      ...(event.sequence !== undefined ? { attentionSequence: event.sequence } : {}),
      ...(event.prompt ? { prompt: event.prompt } : {}),
      ...(event.route === "parent" || event.route === "human" ? { route: event.route } : {}),
      ...(event.routedTo ? { routedTo: event.routedTo } : {}),
      ...(event.escalatedAt ? { escalatedAt: event.escalatedAt } : {}),
      ...(event.escalationNote ? { escalationNote: event.escalationNote } : {}),
      ...(event.answeredBy ? { answeredBy: event.answeredBy } : {}),
    };
    items.push({
      entry: {
        session,
        notice,
        bridgeName: session.bridgeId,
        ...(parentName ? { parentName } : {}),
        ...(session.status !== "running" ? { replyDisabledReason: "This session is not running." } : {}),
      },
      eventId: event.id,
      live: false,
    });
  }
  return items.sort((a, b) => b.entry.notice.receivedAt - a.entry.notice.receivedAt || a.eventId.localeCompare(b.eventId));
}

/** URL state for a deep link: `?session=<session>&attention=<eventId>`; either part may be absent. */
export function parseAttentionDeepLink(search: string): { sessionId: string | null; attentionId: string | null } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const clean = (value: string | null): string | null => (value && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : null);
  return { sessionId: clean(params.get("session")), attentionId: clean(params.get("attention")) };
}

/**
 * Where a deep-linked item opens: in its parent's coordinator view when it has
 * one (the Overview panel), otherwise in its own session's waiting pane.
 */
export function resolveAttentionTarget(input: {
  attentionId: string;
  entries: ReadonlyArray<InboxEntry>;
  sessions: ReadonlyArray<Session>;
}): { selectSessionId: string; entry: InboxEntry; viaParent: boolean } | null {
  const entry = input.entries.find(candidate => candidate.notice.attentionId === input.attentionId);
  if (!entry) return null;
  const parentId = entry.session.parentSessionId;
  const viaParent = !!parentId && parentId !== entry.session.id && input.sessions.some(session => session.id === parentId);
  return { selectSessionId: viaParent ? parentId! : entry.session.id, entry, viaParent };
}

/**
 * Session to select for a deep link. Prefers the live inbox entry (its parent
 * when it has one). Otherwise uses the session hint: a child's parent, the
 * hinted coordinator, or the hinted session itself.
 */
export function attentionLinkTarget(input: {
  attentionId: string;
  sessionHint: string | null;
  entries: ReadonlyArray<InboxEntry>;
  sessions: ReadonlyArray<Session>;
}): { selectSessionId: string; viaParent: boolean } | null {
  const resolved = resolveAttentionTarget(input);
  if (resolved) return { selectSessionId: resolved.selectSessionId, viaParent: resolved.viaParent };
  if (!input.sessionHint) return null;
  const hinted = input.sessions.find(session => session.id === input.sessionHint);
  if (!hinted) return null;
  const parentId = hinted.parentSessionId;
  if (parentId && parentId !== hinted.id && input.sessions.some(session => session.id === parentId)) {
    return { selectSessionId: parentId, viaParent: true };
  }
  if (input.sessions.some(session => session.parentSessionId === hinted.id && session.id !== hinted.id)) {
    return { selectSessionId: hinted.id, viaParent: true };
  }
  return { selectSessionId: hinted.id, viaParent: false };
}

export function ChildrenAttentionPanel({ items, openId, onOpenChange, onOpenSession, onDismiss, onReply, onAnswer, now = Date.now() }: {
  items: ReadonlyArray<ChildAttentionItem>;
  openId: string | null;
  onOpenChange: (id: string | null) => void;
  onOpenSession: (id: string) => void;
  onDismiss: (entry: InboxEntry) => Promise<void>;
  onReply: (entry: InboxEntry, message: string) => Promise<void>;
  onAnswer: (entry: InboxEntry, answers: AttentionAnswerEntry[]) => Promise<AttentionAnswerSubmitResult>;
  now?: number;
}) {
  const [answerNotice, setAnswerNotice] = useState<{ message: string; warn: boolean } | null>(null);
  useEffect(() => { if (!answerNotice) return; const timer = setTimeout(() => setAnswerNotice(null), 6000); return () => clearTimeout(timer); }, [answerNotice]);
  if (items.length === 0) return null;
  const answer = async (entry: InboxEntry, answers: AttentionAnswerEntry[]) => {
    const result = await onAnswer(entry, answers);
    if (result.ok) setAnswerNotice({ message: result.message, warn: result.message.startsWith("Answer saved, but") });
    return result;
  };
  return (
    <section aria-label="Child attention requests" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h3 style={{ fontFamily: "var(--font-mono)", fontSize: 11, margin: 0, fontWeight: 500, color: "var(--status-pending)" }}>
        child attention · {items.length}
      </h3>
      {answerNotice && <p role="status" className={`rounded-md border border-[var(--border-muted)] p-2 text-sm ${answerNotice.warn ? "text-[var(--status-pending)]" : "text-[var(--text-primary)]"}`}>{answerNotice.message}</p>}
      <div className="space-y-3">
        {items.map(({ entry, eventId }) => {
          const open = openId === eventId;
          const state = childAttentionState(entry.notice);
          const childName = entry.session.name || entry.session.prompt?.slice(0, 36) || entry.session.id;
          return (
            <article key={eventId} id={`child-attention-${eventId}`} data-child-attention={eventId} className="min-w-0 rounded-md border border-[var(--border-muted)] bg-[var(--bg-base)]">
              <button type="button" aria-expanded={open} aria-controls={`child-attention-body-${eventId}`} className="flex min-h-11 w-full min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 p-3 text-left" onClick={() => onOpenChange(open ? null : eventId)}>
                <span className="max-w-full break-words text-sm font-semibold [overflow-wrap:anywhere]">{childName}</span>
                <span className="max-w-full break-words text-sm [overflow-wrap:anywhere]">{entry.notice.title}</span>
                <span className="text-xs text-[var(--text-muted)]">{relativeTime(entry.notice.receivedAt, now)}</span>
                <span data-attention-state={state} className={`text-xs ${state === "coordinator" ? "text-[var(--text-muted)]" : state === "answered" ? "text-[var(--text-muted)]" : "text-[var(--status-pending)]"}`}>{childAttentionStateLabel(state)}</span>
              </button>
              {open && (
                <div id={`child-attention-body-${eventId}`} className="min-w-0 space-y-2 px-3 pb-3">
                  <InboxItemBody entry={entry} onOpenSession={onOpenSession} onDismiss={onDismiss} onReply={onReply} onAnswer={answer} initiallyExpanded />
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
