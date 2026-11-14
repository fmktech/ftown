"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import type { Command, Session, SessionCard } from "@/types";
import type { BridgeRpc } from "@/hooks/useBridgeRpc";
import type { OverviewSnapshot, PlanItem, PlanView, SnapshotAttentionEvent, SnapshotCard, SnapshotEvent } from "@/components/SessionOverview";

/** Snapshot refresh interval while the Overview is visible. */
export const BOARD_POLL_MS = 15_000;

/** UI shape of the get_session_board reply: the one OverviewSnapshot mirror (components/SessionOverview). */
export type SessionBoardSnapshot = OverviewSnapshot;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

const asPlanState = (value: unknown): PlanItem["state"] | undefined =>
  value === "todo" || value === "started" || value === "done" || value === "dropped" ? value : undefined;

const asPriority = (value: unknown): PlanItem["priority"] | undefined =>
  value === 1 || value === 2 || value === 3 ? value : undefined;

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(entry => typeof entry === "string") ? value as string[] : undefined;
}

function parsePlanItem(value: unknown): PlanItem | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const title = asString(value.title);
  const state = asPlanState(value.state);
  const after = asStringArray(value.after);
  const priority = asPriority(value.priority);
  const createdAt = asString(value.createdAt);
  const updatedAt = asString(value.updatedAt);
  if (!id || !title || !state || !after || !priority || !createdAt || !updatedAt) return null;
  const note = asString(value.note);
  const sessionId = asString(value.sessionId);
  return {
    id, title, after, priority, state, createdAt, updatedAt,
    ...(note ? { note } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function parsePlanView(value: unknown): PlanView | null {
  if (!isRecord(value) || !Array.isArray(value.items) || !Array.isArray(value.ready)) return null;
  const items: PlanItem[] = [];
  for (const entry of value.items) {
    const item = parsePlanItem(entry);
    if (!item) return null;
    items.push(item);
  }
  const ready = asStringArray(value.ready);
  if (!ready) return null;
  return { items, ready };
}

function parseTreeEvent(value: unknown): SnapshotEvent | null {
  if (!isRecord(value)) return null;
  const seq = asNumber(value.seq);
  const ts = asString(value.ts);
  const sessionId = asString(value.sessionId);
  const sessionName = asString(value.sessionName);
  const kind = asString(value.kind);
  const summary = asString(value.summary);
  if (seq === undefined || !ts || !sessionId || !sessionName || !kind || !summary) return null;
  const ref = asString(value.ref);
  return { seq, ts, sessionId, sessionName, kind, summary, ...(ref ? { ref } : {}) };
}

function parseDeclared(value: unknown): SessionCard | null {
  if (!isRecord(value)) return null;
  const state = asString(value.state);
  const headline = asString(value.headline);
  const updatedAt = asString(value.updatedAt);
  if (!state || !headline || !updatedAt) return null;
  const card: SessionCard = { state: state as SessionCard["state"], headline, updatedAt };
  if (isRecord(value.progress)) {
    const done = asNumber(value.progress.done);
    const total = asNumber(value.progress.total);
    if (done !== undefined && total !== undefined) card.progress = { done, total };
  }
  if (isRecord(value.blockedOn)) {
    const kind = asString(value.blockedOn.kind);
    const text = asString(value.blockedOn.text);
    if (kind && text) {
      const ref = asString(value.blockedOn.ref);
      card.blockedOn = { kind: kind as NonNullable<SessionCard["blockedOn"]>["kind"], text, ...(ref ? { ref } : {}) };
    }
  }
  const next = asString(value.next);
  if (next) card.next = next;
  return card;
}

type SnapshotDerived = SnapshotCard["derived"];

function parseDerived(value: unknown): SnapshotDerived | null {
  if (!isRecord(value)) return null;
  const status = asString(value.status);
  const activity = asString(value.activity);
  const openAttention = asNumber(value.openAttention);
  const unreadMail = asNumber(value.unreadMail);
  if (!status || !activity || openAttention === undefined || unreadMail === undefined) return null;
  const previews = asStringArray(value.previews);
  if (!previews) return null;
  const derived: SnapshotDerived = {
    status: status as SnapshotDerived["status"],
    activity: activity as SnapshotDerived["activity"],
    openAttention,
    unreadMail,
    previews,
  };
  const idleSince = asString(value.idleSince);
  if (idleSince) derived.idleSince = idleSince;
  const shellType = asString(value.shellType);
  if (shellType) derived.shellType = shellType;
  const model = asString(value.model);
  if (model) derived.model = model;
  if (isRecord(value.pr)) {
    const url = asString(value.pr.url);
    const prState = asString(value.pr.state);
    const prStale = value.pr.stale;
    const checkedAt = value.pr.checkedAt;
    if (url && prState && typeof prStale === "boolean" && (checkedAt === null || typeof checkedAt === "string")) {
      derived.pr = { url, state: prState, stale: prStale, checkedAt };
    }
  }
  return derived;
}

function parseCard(value: unknown): SnapshotCard | null {
  if (!isRecord(value)) return null;
  const sessionId = asString(value.sessionId);
  const name = asString(value.name);
  const stale = value.stale;
  const declared = value.declared === null ? null : parseDeclared(value.declared);
  const derived = parseDerived(value.derived);
  if (!sessionId || !name || typeof stale !== "boolean" || !derived) return null;
  if (value.declared !== null && !declared) return null;
  const card: SnapshotCard = { sessionId, name, declared, derived, stale };
  if (value.archived === true) card.archived = true;
  const parentSessionId = asString(value.parentSessionId);
  if (parentSessionId) card.parentSessionId = parentSessionId;
  return card;
}

function parseBoard(value: unknown): OverviewSnapshot["board"] | null {
  if (!isRecord(value)) return null;
  const rootId = asString(value.rootId);
  if (!rootId || !Array.isArray(value.cards)) return null;
  const cards: SnapshotCard[] = [];
  for (const entry of value.cards) {
    const card = parseCard(entry);
    if (!card) return null;
    cards.push(card);
  }
  const board: OverviewSnapshot["board"] = { rootId, cards };
  if (value.plan !== undefined && value.plan !== null) {
    const plan = parsePlanView(value.plan);
    if (!plan) return null;
    board.plan = plan;
  }
  return board;
}

/** AttentionPrompt mirror: only the questions/options the Overview renders. */
function parsePrompt(value: unknown): SnapshotAttentionEvent["prompt"] | null {
  if (!isRecord(value) || !Array.isArray(value.questions)) return null;
  const questions: Array<{ header?: string; question: string; options: Array<{ label: string; description?: string }> }> = [];
  for (const entry of value.questions) {
    if (!isRecord(entry) || typeof entry.question !== "string" || !Array.isArray(entry.options)) return null;
    const options: Array<{ label: string; description?: string }> = [];
    for (const option of entry.options) {
      if (!isRecord(option) || typeof option.label !== "string") return null;
      const description = asString(option.description);
      options.push({ label: option.label, ...(description ? { description } : {}) });
    }
    const header = asString(entry.header);
    questions.push({ question: entry.question, options, ...(header ? { header } : {}) });
  }
  return { questions };
}

function parseAttentionItem(value: unknown): SnapshotAttentionEvent | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const title = asString(value.title);
  if (!id || !title) return null;
  const item: SnapshotAttentionEvent = { id, title };
  const message = asString(value.message);
  if (message) item.message = message;
  const resolvedAt = asString(value.resolvedAt);
  if (resolvedAt) item.resolvedAt = resolvedAt;
  const route = asString(value.route);
  if (route) item.route = route;
  const escalatedAt = asString(value.escalatedAt);
  if (escalatedAt) item.escalatedAt = escalatedAt;
  const escalationNote = asString(value.escalationNote);
  if (escalationNote) item.escalationNote = escalationNote;
  if (value.prompt !== undefined) {
    const prompt = parsePrompt(value.prompt);
    if (prompt) item.prompt = prompt;
  }
  return item;
}

/** Parses and validates a get_session_board reply; null when the shape is not a board snapshot. */
export function parseSnapshot(value: unknown): SessionBoardSnapshot | null {
  if (!isRecord(value)) return null;
  const board = parseBoard(value.board);
  if (!board || !Array.isArray(value.events) || !Array.isArray(value.attention)) return null;
  const events: SnapshotEvent[] = [];
  for (const entry of value.events) {
    const event = parseTreeEvent(entry);
    if (!event) return null;
    events.push(event);
  }
  const attention: Array<{ sessionId: string; event: SnapshotAttentionEvent }> = [];
  for (const entry of value.attention) {
    if (!isRecord(entry)) return null;
    const sessionId = asString(entry.sessionId);
    const event = parseAttentionItem(entry.event);
    if (!sessionId || !event) return null;
    attention.push({ sessionId, event });
  }
  return { board, events, attention };
}

/** Cheap change key over the tree's sessions: changes whenever any row's id, timestamps, status, name or card updates. */
export function treeUpdateKey(sessions: ReadonlyArray<Session>): string {
  return JSON.stringify(sessions.map(session => [session.id, session.updatedAt, session.status, session.name, session.card?.state, session.card?.updatedAt]));
}

/**
 * Dashboard data for the board v3 Overview: one `get_session_board` snapshot of
 * the selected manager's tree. Fetches on mount, whenever a session in that
 * tree updates (cheap key over `treeSessions`), and every 15 s while enabled —
 * never while disabled. A response for a superseded fetch is dropped.
 */
export function useSessionBoard(
  sendCommand: BridgeRpc["sendCommand"],
  bridgeId: string | null,
  sessionId: string | null,
  enabled: boolean,
  treeSessions?: ReadonlyArray<Session>,
): { snapshot: SessionBoardSnapshot | null } {
  const [snapshot, setSnapshot] = useState<SessionBoardSnapshot | null>(null);
  const sendRef = useRef(sendCommand);
  sendRef.current = sendCommand;
  const targetRef = useRef({ bridgeId, sessionId });
  targetRef.current = { bridgeId, sessionId };
  const epochRef = useRef(0);
  /** The epoch of the latest started fetch cycle (an update effect run); a superseded one may not refetch. */
  const activeEpochRef = useRef(0);
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);

  const fetch = useCallback(async () => {
    if (busyRef.current) { dirtyRef.current = true; return; }
    busyRef.current = true;
    const epoch = epochRef.current;
    const target = targetRef.current;
    try {
      const command: Command = {
        type: "get_session_board",
        payload: { bridgeId: target.bridgeId ?? "", sessionId: target.sessionId ?? "" },
        requestId: uuidv4(),
      };
      const response = await sendRef.current(command);
      if (epochRef.current !== epoch) return;
      if (!response.success) return; // keep the previous snapshot; the next poll retries
      const parsed = parseSnapshot(response.data);
      if (parsed) setSnapshot(parsed);
    } catch {
      // Offline or an older bridge without the command: keep the previous snapshot.
    } finally {
      busyRef.current = false;
      // An update that arrived while this fetch was in flight is refetched once,
      // but only while the fetch cycle it belongs to is still the active one.
      if (dirtyRef.current && epochRef.current === activeEpochRef.current) {
        dirtyRef.current = false;
        void fetch();
      }
    }
  }, []);

  // A new tree starts empty: never show the previous manager's snapshot while loading.
  useEffect(() => { setSnapshot(null); }, [bridgeId, sessionId]);

  const updateKey = treeSessions ? treeUpdateKey(treeSessions) : "";
  // Fetch on mount, on identity change, and whenever a session in the tree updates.
  useEffect(() => {
    if (!enabled || !bridgeId || !sessionId) return;
    epochRef.current += 1;
    activeEpochRef.current = epochRef.current;
    void fetch();
  }, [enabled, bridgeId, sessionId, updateKey, fetch]);

  // Independent poll: frequent tree updates must not keep resetting it.
  useEffect(() => {
    if (!enabled || !bridgeId || !sessionId) return;
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void fetch();
    }, BOARD_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, bridgeId, sessionId, fetch]);

  return { snapshot };
}
