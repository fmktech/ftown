"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import type { SessionCard } from "@/types";
import { parseSessionBlock } from "@/types";
import { accountChannel } from "@security/ledger/channels";
import type { MessageClient, MessageSubscription } from "@/lib/message-client";
import type { BridgeRpc } from "@/hooks/useBridgeRpc";
import type { OverviewSnapshot, PlanItem, PlanView, SnapshotAttentionEvent, SnapshotCard, SnapshotEvent } from "@/components/SessionOverview";
import { SESSION_BOARD_CHUNK_BYTES, SESSION_BOARD_INLINE_BYTES, SESSION_BOARD_MAX_BYTES, type SessionBoardManifest } from "../../../bridge/src/session-board-protocol";

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
  const block = parseSessionBlock(value.block);
  if (block) derived.block = block;
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

/** Full AttentionPrompt as the bridge sends it; null when the shape cannot be answered from the dashboard. */
function parsePrompt(value: unknown): SnapshotAttentionEvent["prompt"] | null {
  if (!isRecord(value) || (value.channel !== "mail" && value.channel !== "hook") || !Array.isArray(value.questions)) return null;
  const questions: NonNullable<SnapshotAttentionEvent["prompt"]>["questions"] = [];
  for (const entry of value.questions) {
    if (!isRecord(entry) || typeof entry.question !== "string" || !Array.isArray(entry.options)
      || typeof entry.multiSelect !== "boolean" || typeof entry.allowText !== "boolean") return null;
    const options: Array<{ label: string; description?: string }> = [];
    for (const option of entry.options) {
      if (!isRecord(option) || typeof option.label !== "string") return null;
      const description = asString(option.description);
      options.push({ label: option.label, ...(description ? { description } : {}) });
    }
    const header = asString(entry.header);
    questions.push({ question: entry.question, options, multiSelect: entry.multiSelect, allowText: entry.allowText, ...(header ? { header } : {}) });
  }
  return { channel: value.channel, questions };
}

function parseAttentionItem(value: unknown): SnapshotAttentionEvent | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const title = asString(value.title);
  if (!id || !title) return null;
  const item: SnapshotAttentionEvent = { id, title };
  const type = asString(value.type);
  if (type) item.type = type;
  const message = asString(value.message);
  if (message) item.message = message;
  const createdAt = asString(value.createdAt);
  if (createdAt) item.createdAt = createdAt;
  const sequence = asNumber(value.sequence);
  if (sequence !== undefined) item.sequence = sequence;
  const resolvedAt = asString(value.resolvedAt);
  if (resolvedAt) item.resolvedAt = resolvedAt;
  const route = asString(value.route);
  if (route) item.route = route;
  const routedTo = asString(value.routedTo);
  if (routedTo) item.routedTo = routedTo;
  const escalatedAt = asString(value.escalatedAt);
  if (escalatedAt) item.escalatedAt = escalatedAt;
  const escalationNote = asString(value.escalationNote);
  if (escalationNote) item.escalationNote = escalationNote;
  if (isRecord(value.answeredBy) && (value.answeredBy.kind === "human" || value.answeredBy.kind === "session")) {
    const sessionId = asString(value.answeredBy.sessionId);
    const name = asString(value.answeredBy.name);
    item.answeredBy = { kind: value.answeredBy.kind, ...(sessionId ? { sessionId } : {}), ...(name ? { name } : {}) };
  }
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

type BoardPublication =
  | { type: "session_board_snapshot"; bridgeId: string; rootId: string; snapshot: SessionBoardSnapshot }
  | { type: "session_board_changed"; bridgeId: string; rootId: string };

/** Reject partial payloads and mismatched snapshot roots before applying any state. */
export function parseBoardPublication(value: unknown): BoardPublication | null {
  if (!isRecord(value) || typeof value.bridgeId !== "string" || !value.bridgeId
    || typeof value.rootId !== "string" || !value.rootId) return null;
  if (value.type === "session_board_changed" && Object.keys(value).length === 3) {
    return { type: value.type, bridgeId: value.bridgeId, rootId: value.rootId };
  }
  if (value.type !== "session_board_snapshot" || Object.keys(value).length !== 4) return null;
  const snapshot = parseSnapshot(value.snapshot);
  if (!snapshot || snapshot.board.rootId !== value.rootId) return null;
  return { type: value.type, bridgeId: value.bridgeId, rootId: value.rootId, snapshot };
}

type Position = { offset: number; epoch: string };
function position(value: { offset?: number; epoch?: string }): Position | null {
  return Number.isSafeInteger(value.offset) && value.offset! >= 0 && typeof value.epoch === "string" && value.epoch.length > 0
    ? { offset: value.offset!, epoch: value.epoch } : null;
}

function parseManifest(value: unknown, rootId: string): SessionBoardManifest | null {
  if (!isRecord(value) || Object.keys(value).length !== 5 || value.type !== "session_board_chunks"
    || typeof value.snapshotId !== "string" || !/^[a-f0-9]{64}$/.test(value.snapshotId) || value.rootId !== rootId
    || !Number.isSafeInteger(value.totalBytes) || (value.totalBytes as number) <= SESSION_BOARD_INLINE_BYTES
    || (value.totalBytes as number) > SESSION_BOARD_MAX_BYTES || value.chunkBytes !== SESSION_BOARD_CHUNK_BYTES) return null;
  return value as unknown as SessionBoardManifest;
}

function decodeChunk(value: unknown, manifest: SessionBoardManifest, offset: number): Uint8Array | null {
  const expectedBytes = Math.min(manifest.chunkBytes, manifest.totalBytes - offset);
  if (!isRecord(value) || Object.keys(value).length !== 6 || value.type !== "session_board_chunk"
    || value.snapshotId !== manifest.snapshotId || value.rootId !== manifest.rootId || value.offset !== offset
    || value.totalBytes !== manifest.totalBytes || typeof value.data !== "string"
    || value.data.length !== 4 * Math.ceil(expectedBytes / 3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) return null;
  try {
    const decoded = atob(value.data);
    if (decoded.length !== expectedBytes || btoa(decoded) !== value.data) return null;
    return Uint8Array.from(decoded, character => character.charCodeAt(0));
  } catch { return null; }
}

/** Push-driven Overview. RPC reads are reserved for entry, recovery, visibility and oversized publications. */
export function useSessionBoard(
  sendCommand: BridgeRpc["sendCommand"],
  bridgeId: string | null,
  sessionId: string | null,
  enabled: boolean,
  client: MessageClient | null = null,
  userId = "",
): { snapshot: SessionBoardSnapshot | null; refresh: () => Promise<void> } {
  const [snapshot, setSnapshot] = useState<SessionBoardSnapshot | null>(null);
  const sendRef = useRef(sendCommand);
  sendRef.current = sendCommand;
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  const recovery = useRef<{ key: string; position: Position | null }>({ key: "", position: null });
  const key = JSON.stringify([userId, bridgeId, sessionId]);

  useEffect(() => { setSnapshot(null); }, [key]);
  useEffect(() => {
    if (!enabled || !bridgeId || !sessionId) return;
    if (recovery.current.key !== key) recovery.current = { key, position: null };
    let active = true;
    let busy = false;
    let dirty = false;
    let revision = 0;
    let sub: MessageSubscription | null = null;
    let initialReadRequested = false;
    let authoritativePosition: Position | null = null;
    async function readSnapshot(started: number): Promise<SessionBoardSnapshot | null> {
      const current = () => active && revision === started;
      const response = await sendRef.current({ type: "get_session_board", payload: { bridgeId: bridgeId!, sessionId: sessionId! }, requestId: uuidv4() });
      if (!current() || !response.success) return null;
      const inline = parseSnapshot(response.data);
      if (inline) return inline;
      const manifest = parseManifest(response.data, sessionId!);
      if (!manifest) return null;
      const bytes = new Uint8Array(manifest.totalBytes);
      for (let offset = 0; offset < manifest.totalBytes; offset += manifest.chunkBytes) {
        if (!current()) return null;
        const chunk = await sendRef.current({ type: "get_session_board", payload: {
          bridgeId: bridgeId!, sessionId: sessionId!, snapshotId: manifest.snapshotId, offset,
        }, requestId: uuidv4() });
        if (!current() || !chunk.success) return null;
        const decoded = decodeChunk(chunk.data, manifest, offset);
        if (!decoded) return null;
        bytes.set(decoded, offset);
      }
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      if (!current()) return null;
      const snapshotId = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
      if (snapshotId !== manifest.snapshotId) return null;
      return parseSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    }
    async function fetchSnapshot(): Promise<void> {
      if (!active) return;
      if (busy) { dirty = true; return; }
      initialReadRequested = true;
      busy = true;
      const started = revision;
      const readPosition = sub?.streamPosition?.() ?? recovery.current.position;
      try {
        const parsed = await readSnapshot(started);
        if (!active || revision !== started) return;
        if (parsed?.board.rootId === sessionId) {
          authoritativePosition = readPosition;
          setSnapshot(parsed);
        }
      } catch { /* Offline/older bridge: preserve the last valid snapshot. */ }
      finally {
        busy = false;
        if (active && dirty) { dirty = false; void fetchSnapshot(); }
      }
    }
    refreshRef.current = fetchSnapshot;
    const onVisible = () => {
      if (document.visibilityState !== "hidden") { revision++; void fetchSnapshot(); }
    };
    document.addEventListener("visibilitychange", onVisible);
    if (client && userId) {
      try {
        const channel = accountChannel("session-board:updates", userId);
        sub = client.newSubscription(channel, {
          since: recovery.current.position ?? { offset: 0, epoch: "" },
          recoverable: true, positioned: true,
        });
        sub.on("publication", context => {
          if (!active) return;
          const next = position({ offset: context.offset, epoch: context.epoch ?? recovery.current.position?.epoch });
          const current = recovery.current.position;
          if (next && (!current || next.epoch !== current.epoch || next.offset > current.offset)) recovery.current.position = next;
          if (next && authoritativePosition && next.epoch === authoritativePosition.epoch
            && next.offset <= authoritativePosition.offset) return;
          const publication = parseBoardPublication(context.data);
          if (!publication || publication.bridgeId !== bridgeId || publication.rootId !== sessionId) return;
          revision++;
          if (publication.type === "session_board_snapshot") setSnapshot(publication.snapshot);
          else void fetchSnapshot();
        });
        sub.on("subscribed", (context = {}) => {
          if (!active) return;
          const next = position(context);
          const previous = recovery.current.position;
          const recovered = context.recovered === true && context.positioned !== false && !!next
            && !!previous && previous.epoch === next.epoch && next.offset >= previous.offset;
          recovery.current.position = next;
          if (!recovered) { revision++; void fetchSnapshot(); }
        });
        sub.subscribe();
      } catch {
        // Old relays may not have the namespace yet. Initial/visibility reads still work.
        if (sub) { sub.removeAllListeners(); sub.unsubscribe(); client.removeSubscription(sub); sub = null; }
      }
    }
    // A relay without this namespace rejects asynchronously and never emits
    // `subscribed`. Loading Overview must not depend on that event.
    if (!initialReadRequested) void fetchSnapshot();
    return () => {
      active = false;
      refreshRef.current = async () => {};
      document.removeEventListener("visibilitychange", onVisible);
      if (sub && client) { sub.removeAllListeners(); sub.unsubscribe(); client.removeSubscription(sub); }
    };
  }, [enabled, bridgeId, sessionId, client, userId, key]);

  return { snapshot, refresh };
}
