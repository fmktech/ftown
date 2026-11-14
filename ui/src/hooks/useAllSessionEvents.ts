"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { MessageClient, MessageSubscription } from "@/lib/message-client";
import { sessionChannel } from "@security/ledger/channels";
import { Session } from "@/types";
import { clearsManualInputNotice, isAskUserQuestionTool, parseLenientPrompt, hookEventToActivity, extractManualInputNotice, extractToolLabel, isDurableNotice, isWithParentNotice, type ManualInputNotice } from "@/lib/hook-events";
import type { AnswerSessionAttentionPayload, AttentionAnswerDelivery, AttentionAnswerEntry, AttentionPrompt } from "../../../bridge/src/attention-prompt-protocol";
import { TokenUsage } from "./useSessionEvents";
import type { BridgeRpc } from "./useBridgeRpc";
import type { PersistedSessionAttention, SessionAttentionResponse } from "@/types";
import { v4 as uuidv4 } from "uuid";

const ANSWER_DELIVERIES: ReadonlySet<string> = new Set<AttentionAnswerDelivery>(["waiter", "mail", "mail_failed"]);

/** Global cap on concurrent get_session_attention reads. */
const READ_LIMIT = 4;

/** Re-parse a persisted prompt; the channel must match the item type (request: mail, question: hook). */
function persistedPrompt(value: unknown, type: string): AttentionPrompt | undefined {
  return parseLenientPrompt(value, type === "ask_user" ? "hook" : "mail");
}

/** Explicit allowlist of the PersistedSessionAttention fields the dashboard renders; anything else the bridge sent is dropped. */
function allowlistedAttention(item: Record<string, unknown>, prompt: AttentionPrompt | undefined): PersistedSessionAttention {
  const cleanString = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;
  const answeredBy = (() => {
    if (typeof item.answeredBy !== "object" || item.answeredBy === null) return undefined;
    const raw = item.answeredBy as Record<string, unknown>;
    if (raw.kind !== "human" && raw.kind !== "session") return undefined;
    const kind: "human" | "session" = raw.kind === "human" ? "human" : "session";
    return {
      kind,
      ...(cleanString(raw.sessionId) ? { sessionId: raw.sessionId as string } : {}),
      ...(cleanString(raw.name) ? { name: raw.name as string } : {}),
    };
  })();
  return {
    id: item.id as string,
    sequence: item.sequence as number,
    type: item.type === "ask_user" ? "ask_user" : "agent_needs_input",
    title: item.title as string,
    message: item.message as string,
    createdAt: item.createdAt as string,
    ...(prompt ? { prompt } : {}),
    ...(item.route === "parent" || item.route === "human" ? { route: item.route } : {}),
    ...(cleanString(item.routedTo) ? { routedTo: item.routedTo as string } : {}),
    ...(cleanString(item.escalatedAt) ? { escalatedAt: item.escalatedAt as string } : {}),
    ...(cleanString(item.escalationNote) ? { escalationNote: item.escalationNote as string } : {}),
    ...(answeredBy ? { answeredBy } : {}),
  };
}

function snapshotResponse(value: unknown, sessionId: string): SessionAttentionResponse | null {
  if (!value || typeof value !== "object") return null;
  const response = value as Record<string, unknown>;
  if (response.sessionId !== sessionId || typeof response.sequence !== "number" || !Number.isSafeInteger(response.sequence) || response.sequence < 0) return null;
  if (response.attention === null) return { sessionId, attention: null, sequence: response.sequence };
  if (!response.attention || typeof response.attention !== "object") return null;
  const item = response.attention as Record<string, unknown>;
  if ((item.type !== "agent_needs_input" && item.type !== "ask_user") || typeof item.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(item.id)
    || typeof item.sequence !== "number" || !Number.isSafeInteger(item.sequence) || item.sequence < 1
    || typeof item.title !== "string" || typeof item.message !== "string" || typeof item.createdAt !== "string"
    || !Number.isFinite(Date.parse(item.createdAt))) return null;
  if (item.sequence > response.sequence) return null;
  const prompt = item.prompt === undefined ? undefined : persistedPrompt(item.prompt, item.type);
  // A question the dashboard cannot answer has no place in the inbox. Keep the watermark.
  // An invalid prompt on a plain request is dropped; the request itself stays readable.
  if (item.type === "ask_user" && !prompt) return { sessionId, attention: null, sequence: response.sequence };
  return { sessionId, attention: allowlistedAttention(item, prompt), sequence: response.sequence };
}

function answerResponse(value: unknown, sessionId: string): { snapshot: SessionAttentionResponse; delivery: AttentionAnswerDelivery } | null {
  const snapshot = snapshotResponse(value, sessionId);
  const delivery = (value as Record<string, unknown> | null)?.delivery;
  if (!snapshot || typeof delivery !== "string" || !ANSWER_DELIVERIES.has(delivery)) return null;
  return { snapshot, delivery: delivery as AttentionAnswerDelivery };
}

/** Routing fields are part of the item's identity: an escalate/answer keeps the id and sequence but changes these. */
function sameRouting(a: ManualInputNotice, b: ManualInputNotice): boolean {
  return a.route === b.route && a.routedTo === b.routedTo && a.escalatedAt === b.escalatedAt
    && a.escalationNote === b.escalationNote
    && a.answeredBy?.kind === b.answeredBy?.kind && a.answeredBy?.sessionId === b.answeredBy?.sessionId
    && a.answeredBy?.name === b.answeredBy?.name;
}

function sameNotice(a: ManualInputNotice | undefined, b: ManualInputNotice | undefined): boolean {
  if (!a || !b || a.type !== b.type) return false;
  if (a.attentionId || b.attentionId) {
    if (!(a.attentionId && a.attentionId === b.attentionId && a.attentionSequence === b.attentionSequence)) return false;
  } else if (a.receivedAt !== b.receivedAt || a.title !== b.title || a.message !== b.message) return false;
  return sameRouting(a, b);
}

function restoredNotice(item: PersistedSessionAttention): ManualInputNotice {
  return { type: item.type, title: item.title, message: item.message, receivedAt: Date.parse(item.createdAt),
    attentionId: item.id, attentionSequence: item.sequence, ...(item.prompt ? { prompt: item.prompt } : {}),
    ...(item.route ? { route: item.route } : {}),
    ...(item.routedTo ? { routedTo: item.routedTo } : {}),
    ...(item.escalatedAt ? { escalatedAt: item.escalatedAt } : {}),
    ...(item.escalationNote ? { escalationNote: item.escalationNote } : {}),
    ...(item.answeredBy ? { answeredBy: item.answeredBy } : {}) };
}

export interface SessionActivity {
  activity: "thinking" | "tool_use" | "idle";
  toolName?: string;
  usage?: TokenUsage;
  attention?: ManualInputNotice;
}

interface HookEventMessage {
  type: "hook_event";
  eventName: string;
  data: Record<string, unknown>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface AllSessionEvents {
  sessionActivity: Map<string, SessionActivity>;
  /** Optimistically clear a session's activity (e.g. on a local ESC interrupt). */
  markSessionIdle: (sessionId: string) => void;
  clearSessionAttention: (sessionId: string, expected?: ManualInputNotice) => Promise<void>;
  answerSessionAttention: (sessionId: string, expected: ManualInputNotice, answers: AttentionAnswerEntry[]) => Promise<AnswerSessionAttentionResult>;
  /** Re-read a session's durable attention snapshot (after a reply resolved it). */
  refreshSessionAttention: (sessionId: string) => Promise<void>;
}

export type AnswerSessionAttentionResult =
  | { ok: true; delivery: AttentionAnswerDelivery }
  | { ok: false; code: string; message: string };

export function useAllSessionEvents(
  client: MessageClient | null,
  sessions: Session[],
  userId: string,
  rpc?: Pick<BridgeRpc, "sendCommand" | "onSubscribed">,
): AllSessionEvents {
  const [activityMap, setActivityMap] = useState<Map<string, SessionActivity>>(new Map());
  const subsRef = useRef<Map<string, { client: MessageClient; user: string; sub: MessageSubscription; queued: boolean; inFlight: boolean; dirty: boolean; dirtyResolving: boolean; pendingResolving: boolean }>>(new Map());
  const clientRef = useRef(client);
  const userIdRef = useRef(userId);
  const rpcRef = useRef(rpc);
  const sessionsRef = useRef(sessions);
  const activityRef = useRef(activityMap);
  const activityOwner = useRef({ client, user: userId });
  const observations = useRef(new Map<string, number>());
  const reads = useRef(new Map<string, number>());
  const dismissedThrough = useRef(new Map<string, number>());
  const retries = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const retried = useRef(new Set<string>());
  const canonical = useRef(new Map<string, { sequence: number; activeId: string | null }>());
  /** With-parent snapshot items yielded to a displayed item that needs the human (per session). */
  const yieldedItems = useRef(new Map<string, Set<string>>());
  /** Forget a yielded item only on proof from a snapshot: the slot now shows it
   * (it is the open item), or the snapshot reports no open items at all. */
  const pruneYielded = (sessionId: string, snapshotItem: { id: string } | null, appliedId: string | undefined): void => {
    const yielded = yieldedItems.current.get(sessionId);
    if (!yielded) return;
    if (!snapshotItem) { yieldedItems.current.delete(sessionId); return; }
    if (appliedId !== undefined && yielded.delete(appliedId) && !yielded.size) yieldedItems.current.delete(sessionId);
  };
  /** Trailing debounce for reconciliation reads a stamped publication asked for. */
  const stampedDebounce = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const readsInFlight = useRef(0);
  const readWaiters = useRef<Array<() => void>>([]);
  const releaseRead = (): void => {
    const next = readWaiters.current.shift();
    if (next) next(); else readsInFlight.current -= 1;
  };
  const acquireRead = (): Promise<() => void> => {
    if (readsInFlight.current < READ_LIMIT) { readsInFlight.current += 1; return Promise.resolve(releaseRead); }
    return new Promise(resolve => readWaiters.current.push(() => resolve(releaseRead)));
  };
  clientRef.current = client;
  userIdRef.current = userId;
  rpcRef.current = rpc;
  sessionsRef.current = sessions;
  activityRef.current = activityMap;

  const readSnapshot = useCallback(async (sessionId: string, resolving: boolean) => {
    const owner = subsRef.current.get(sessionId);
    const user = owner?.user;
    const session = sessionsRef.current.find(row => row.id === sessionId && row.status === "running");
    if (!owner || owner.client !== clientRef.current || owner.user !== userIdRef.current || !session || !rpcRef.current) return;
    const observation = observations.current.get(sessionId) ?? 0;
    const read = (reads.current.get(sessionId) ?? 0) + 1;
    reads.current.set(sessionId, read);
    // A failed read while a durable question is on screen is retried once, so the
    // inbox does not keep a question the bridge has already resolved.
    const retryOnce = () => {
      const shown = activityRef.current.get(sessionId)?.attention;
      if (shown?.type !== "ask_user" || !isDurableNotice(shown) || retried.current.has(sessionId)) return;
      retried.current.add(sessionId);
      retries.current.set(sessionId, setTimeout(() => { retries.current.delete(sessionId); hydrate(sessionId, true); }, 2000));
    };
    try {
      const release = await acquireRead();
      try {
        const response = await rpcRef.current.sendCommand({ type: "get_session_attention", requestId: uuidv4(),
          payload: { bridgeId: session.bridgeId, sessionId } });
        if (!response.success) { retryOnce(); return; }
        retried.current.delete(sessionId);
        if (userIdRef.current !== user || clientRef.current !== owner.client
          || subsRef.current.get(sessionId) !== owner || reads.current.get(sessionId) !== read
          || (observations.current.get(sessionId) ?? 0) !== observation
          || !sessionsRef.current.some(row => row.id === sessionId && row.bridgeId === session.bridgeId && row.status === "running")) return;
        const snapshot = snapshotResponse(response.data, sessionId);
        if (!snapshot) return;
        const known = canonical.current.get(sessionId);
        if (known && known.sequence > snapshot.sequence) return;
        const incoming = snapshot.attention && snapshot.attention.sequence > (dismissedThrough.current.get(sessionId) ?? 0)
          ? restoredNotice(snapshot.attention) : undefined;
        canonical.current.set(sessionId, { sequence: snapshot.sequence, activeId: snapshot.attention?.id ?? null });
        setActivityMap(prev => {
          if (userIdRef.current !== user || clientRef.current !== owner.client || subsRef.current.get(sessionId) !== owner
            || (observations.current.get(sessionId) ?? 0) !== observation || reads.current.get(sessionId) !== read) return prev;
          const current = prev.get(sessionId) ?? { activity: "idle" as const };
          if (current.attention && !isDurableNotice(current.attention)) return prev;
          if ((current.attention?.attentionSequence ?? 0) > snapshot.sequence) return prev;
          let attention = incoming;
          let kept = false;
          // A with-parent item never takes the slot from a displayed item that
          // needs the human; the snapshot supplies it again once nothing does.
          // Resolving reads apply the truth: they follow a resolution the display
          // cannot see (cross-tab commands, the ask tool finishing).
          if (!resolving && incoming?.attentionId && current.attention && isDurableNotice(current.attention)
            && incoming.attentionId !== current.attention.attentionId
            && !isWithParentNotice(current.attention) && isWithParentNotice(incoming)) {
            attention = current.attention; kept = true;
            const yielded = yieldedItems.current.get(sessionId) ?? new Set<string>();
            yielded.add(incoming.attentionId);
            yieldedItems.current.set(sessionId, yielded);
          }
          pruneYielded(sessionId, snapshot.attention, kept ? undefined : incoming?.attentionId);
          return new Map(prev).set(sessionId, { ...current, attention });
        });
      } finally { release(); }
    } catch { retryOnce(); /* Older/offline bridges retain the existing live-only dashboard. */ }
  }, []);

  const hydrate: (sessionId: string, resolving?: boolean) => void = useCallback((sessionId: string, resolving = false) => {
    const pendingStamp = stampedDebounce.current.get(sessionId);
    if (pendingStamp) { clearTimeout(pendingStamp); stampedDebounce.current.delete(sessionId); }
    const owner = subsRef.current.get(sessionId);
    if (!owner || owner.client !== clientRef.current || owner.user !== userIdRef.current) return;
    if (owner.inFlight) {
      // A later trigger requires a new snapshot; fence the old response now.
      reads.current.set(sessionId, (reads.current.get(sessionId) ?? 0) + 1);
      owner.dirty = true;
      owner.dirtyResolving = owner.dirtyResolving || resolving;
      return;
    }
    if (owner.queued) {
      owner.pendingResolving = owner.pendingResolving || resolving;
      return;
    }
    owner.queued = true;
    owner.pendingResolving = resolving;
    queueMicrotask(() => {
      if (subsRef.current.get(sessionId) !== owner || owner.client !== clientRef.current || owner.user !== userIdRef.current) return;
      owner.queued = false;
      owner.inFlight = true;
      const read = owner.pendingResolving;
      owner.pendingResolving = false;
      void readSnapshot(sessionId, read).finally(() => {
        if (subsRef.current.get(sessionId) !== owner || owner.client !== clientRef.current || owner.user !== userIdRef.current) return;
        owner.inFlight = false;
        if (owner.dirty) {
          owner.dirty = false;
          const dirtyResolving = owner.dirtyResolving;
          owner.dirtyResolving = false;
          hydrate(sessionId, dirtyResolving);
        }
      });
    });
  }, [readSnapshot]);

  const subscribe = useCallback((sessionId: string) => {
    const c = clientRef.current;
    const u = userIdRef.current;
    if (!c || !u) return;
    if (subsRef.current.has(sessionId)) return;

    let channel: string;
    // A session id that cannot name a channel is never subscribed.
    try { channel = sessionChannel("events", sessionId, u); } catch { return; }

    const onPublication = (ctx: { data: unknown }): void => {
      if (clientRef.current !== c || userIdRef.current !== u || subsRef.current.get(sessionId)?.sub !== sub) return;
      const msg = ctx.data as HookEventMessage;
      if (msg.type !== "hook_event") return;

      const attention = extractManualInputNotice(msg.eventName, msg.data);
      const activity = hookEventToActivity(msg.eventName);
      if ((attention && !attention.attentionId) || msg.eventName === "UserPromptSubmit" || msg.eventName === "beforeSubmitPrompt") {
        observations.current.set(sessionId, (observations.current.get(sessionId) ?? 0) + 1);
      }
      setActivityMap((prev) => {
        if (clientRef.current !== c || userIdRef.current !== u || subsRef.current.get(sessionId)?.sub !== sub) return prev;
        const current = prev.get(sessionId) ?? { activity: "idle" as const };
        // C1: prompts never clear explicit notices (clearsManualInputNotice
        // returns false for them), so no local guard is needed here; only the
        // committed snapshot may clear them.
        const clearsAttention = clearsManualInputNotice(msg.eventName, msg.data, current.attention);
        if (!activity && !attention && !clearsAttention) return prev;
        const toolName =
          activity === "tool_use"
            ? extractToolLabel(msg.eventName, msg.data)
            : undefined;

        if (clearsAttention && current.attention?.attentionSequence) dismissedThrough.current.set(sessionId,
          Math.max(dismissedThrough.current.get(sessionId) ?? 0, current.attention.attentionSequence));
        const incomingSequence = attention?.attentionSequence;
        const known = canonical.current.get(sessionId);
        const olderExplicit = incomingSequence !== undefined && (incomingSequence <= (dismissedThrough.current.get(sessionId) ?? 0)
          || (known !== undefined && incomingSequence <= known.sequence && attention?.attentionId !== known.activeId)
          || (isDurableNotice(current.attention) && incomingSequence < (current.attention?.attentionSequence ?? 0)));
        // A yielded with-parent item waits with the parent: its unstamped replays
        // must not steal the slot from the displayed item that needs the human.
        const yieldFenced = !olderExplicit && !!attention?.attentionId
          && current.attention?.attentionId !== attention.attentionId
          && yieldedItems.current.get(sessionId)?.has(attention.attentionId) === true;
        // The republished stamped payload never carries routing fields; keep the
        // displayed routing (greyed/escalated) until the snapshot reconciles it.
        const dropsRouting = !!attention?.attentionId && !!current.attention && isDurableNotice(current.attention)
          && attention.attentionId === current.attention.attentionId
          && (current.attention.route !== undefined || current.attention.escalatedAt !== undefined
            || current.attention.escalationNote !== undefined || current.attention.answeredBy !== undefined)
          && attention.route === undefined && attention.escalatedAt === undefined
          && attention.escalationNote === undefined && attention.answeredBy === undefined;
        const updated: SessionActivity = {
          ...current,
          ...(activity
            ? {
                activity,
                toolName: activity === "tool_use" ? toolName : undefined,
              }
            : {}),
          ...(attention && !olderExplicit && !yieldFenced && !dropsRouting ? { attention } : {}),
          ...(clearsAttention ? { attention: undefined } : {}),
          ...(activity === "idle" && msg.usage
            ? {
                usage: {
                  inputTokens: msg.usage.inputTokens,
                  outputTokens: msg.usage.outputTokens,
                },
              }
            : {}),
        };

        const next = new Map(prev);
        next.set(sessionId, updated);
        return next;
      });
      // A local clear emptied the slot: a yielded with-parent item may be the
      // open item now, so surface it immediately instead of waiting for the
      // next scheduled read.
      if (clearsManualInputNotice(msg.eventName, msg.data, activityRef.current.get(sessionId)?.attention)
        && yieldedItems.current.get(sessionId)?.size) void hydrate(sessionId, true);
      // Prompt hooks have already resolved the ledger. Learn its watermark
      // even if the first read was pending and no displayed ID was known yet.
      // A finished AskUserQuestion was resolved by the bridge; learn that from a snapshot.
      // AttentionSnapshot is the cross-tab signal for command resolutions
      // (dismiss/reply); it only triggers a re-read, with no activity/clear.
      // Resolving reads follow an event that may have resolved the displayed
      // item; every other read keeps an item that needs the human in the slot.
      const shown = activityRef.current.get(sessionId)?.attention;
      if (msg.eventName === "AttentionSnapshot") void hydrate(sessionId, true);
      else if ((msg.eventName === "PostToolUse" || msg.eventName === "postToolUse" || msg.eventName === "postToolUseFailure")
        && isAskUserQuestionTool(extractToolLabel(msg.eventName, msg.data))
        && shown !== undefined && isDurableNotice(shown) && shown.type === "ask_user") void hydrate(sessionId, true);
      else if (msg.eventName === "UserPromptSubmit" || msg.eventName === "beforeSubmitPrompt") void hydrate(sessionId, false);
      // A stamped publication the bridge re-issued (creation, repeat, parent
      // escalation) carries no routing fields; reconcile route, escalatedAt and
      // escalationNote from the durable snapshot so escalation applies live.
      // An identical republish of the displayed item carries nothing new, and
      // the reads are debounced and globally capped.
      if (attention?.attentionId && !(shown !== undefined && sameNotice(attention, shown))) {
        const stampedSequence = attention.attentionSequence ?? 0;
        const knownStamp = canonical.current.get(sessionId);
        const replay = stampedSequence <= (dismissedThrough.current.get(sessionId) ?? 0)
          || (knownStamp !== undefined && stampedSequence <= knownStamp.sequence && attention.attentionId !== knownStamp.activeId)
          || (isDurableNotice(shown) && stampedSequence < (shown?.attentionSequence ?? 0));
        if (!replay) {
          const pending = stampedDebounce.current.get(sessionId);
          if (pending) clearTimeout(pending);
          stampedDebounce.current.set(sessionId, setTimeout(() => {
            stampedDebounce.current.delete(sessionId);
            hydrate(sessionId, false);
          }, 200));
        }
      }
    };

    const existing = c.getSubscription(channel);
    if (existing) {
      existing.removeAllListeners();
      existing.unsubscribe();
      c.removeSubscription(existing);
    }

    const sub = c.newSubscription(channel, {
      since: { offset: 0, epoch: "" },
    });

    sub.on("publication", onPublication);
    sub.on("subscribed", () => {
      if (clientRef.current === c && userIdRef.current === u && subsRef.current.get(sessionId)?.sub === sub) void hydrate(sessionId);
    });
    subsRef.current.set(sessionId, { client: c, user: u, sub, queued: false, inFlight: false, dirty: false, dirtyResolving: false, pendingResolving: false });
    sub.subscribe();
    if (sub.state === "subscribed") void hydrate(sessionId);
  }, [hydrate]);

  const unsubscribe = useCallback((sessionId: string) => {
    const owned = subsRef.current.get(sessionId);
    if (owned) {
      const { client: owner, sub } = owned;
      sub.removeAllListeners();
      sub.unsubscribe();
      owner.removeSubscription(sub);
    }
    subsRef.current.delete(sessionId);
  }, []);

  // A subscription belongs to the Centrifuge client and user that created it.
  // Drop all old ownership before the session effect binds to a replacement.
  useEffect(() => {
    for (const sessionId of Array.from(subsRef.current.keys())) {
      unsubscribe(sessionId);
    }
    for (const timer of retries.current.values()) clearTimeout(timer);
    retries.current.clear(); retried.current.clear();
    for (const timer of stampedDebounce.current.values()) clearTimeout(timer);
    stampedDebounce.current.clear();
    observations.current.clear(); reads.current.clear(); dismissedThrough.current.clear(); canonical.current.clear(); yieldedItems.current.clear();
    activityOwner.current = { client, user: userId };
    setActivityMap(new Map());
  }, [client, userId, unsubscribe]);

  useEffect(() => rpc?.onSubscribed(() => {
    if (clientRef.current !== client || userIdRef.current !== userId) return;
    for (const id of subsRef.current.keys()) void hydrate(id);
  }), [rpc?.onSubscribed, client, userId, hydrate]);

  useEffect(() => {
    if (!client || !userId) return;

    const runningIds = new Set(
      sessions.filter((s) => s.status === "running").map((s) => s.id)
    );

    for (const sessionId of subsRef.current.keys()) {
      if (!runningIds.has(sessionId)) {
        unsubscribe(sessionId);
      }
    }

    setActivityMap((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const sessionId of next.keys()) {
        if (!runningIds.has(sessionId)) {
          next.delete(sessionId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    for (const id of runningIds) {
      subscribe(id);
    }
  }, [client, userId, sessions, subscribe, unsubscribe]);

  useEffect(() => {
    return () => {
      for (const sessionId of subsRef.current.keys()) {
        unsubscribe(sessionId);
      }
      for (const timer of stampedDebounce.current.values()) clearTimeout(timer);
      stampedDebounce.current.clear();
      setActivityMap(new Map());
    };
  }, [unsubscribe]);

  const markSessionIdle = useCallback((sessionId: string) => {
    setActivityMap((prev) => {
      const current = prev.get(sessionId);
      if (!current || current.activity === "idle") return prev;
      const next = new Map(prev);
      next.set(sessionId, { ...current, activity: "idle", toolName: undefined });
      return next;
    });
  }, []);

  const clearSessionAttention = useCallback(async (sessionId: string, expected?: ManualInputNotice) => {
    const currentNotice = activityRef.current.get(sessionId)?.attention;
    if (expected && !sameNotice(currentNotice, expected)) throw new Error("This message has changed. Review the latest notice.");
    const captured = expected ?? currentNotice;
    if (!captured) return;
    const session = sessionsRef.current.find(row => row.id === sessionId);
    const owner = subsRef.current.get(sessionId);
    const user = userIdRef.current;
    const activeClient = clientRef.current;
    if (activityOwner.current.client !== activeClient || activityOwner.current.user !== user
      || owner && (owner.client !== activeClient || owner.user !== user)) throw new Error("The session changed before dismissal could start.");
    if (isDurableNotice(captured)) {
      if (!session || !owner || !rpcRef.current) throw new Error("The session is unavailable. Reconnect and try again.");
      observations.current.set(sessionId, (observations.current.get(sessionId) ?? 0) + 1);
      const observation = observations.current.get(sessionId);
      let response;
      try { response = await rpcRef.current.sendCommand({ type: "resolve_session_attention", requestId: uuidv4(),
        payload: { bridgeId: session.bridgeId, sessionId, eventId: captured.attentionId } }); }
      catch { throw new Error("Could not dismiss this message. Reconnect and try again."); }
      if (!response.success) throw new Error("Could not dismiss this message. Try again.");
      if (userIdRef.current !== user || clientRef.current !== owner.client || subsRef.current.get(sessionId) !== owner
        || !sessionsRef.current.some(row => row.id === sessionId && row.bridgeId === session.bridgeId)) throw new Error("The session changed before dismissal completed.");
      const snapshot = snapshotResponse(response.data, sessionId);
      if (!snapshot) throw new Error("Could not confirm dismissal. Try again.");
      dismissedThrough.current.set(sessionId, Math.max(dismissedThrough.current.get(sessionId) ?? 0, captured.attentionSequence ?? 0));
      if (observations.current.get(sessionId) !== observation) return;
      const known = canonical.current.get(sessionId);
      if (!known || snapshot.sequence >= known.sequence) canonical.current.set(sessionId, { sequence: snapshot.sequence, activeId: snapshot.attention?.id ?? null });
      observations.current.set(sessionId, (observations.current.get(sessionId) ?? 0) + 1);
      setActivityMap(prev => {
        if (userIdRef.current !== user || clientRef.current !== owner.client || subsRef.current.get(sessionId) !== owner) return prev;
        const current = prev.get(sessionId);
        if (!current || !sameNotice(current.attention, captured)) return prev;
        const attention = snapshot.attention ? restoredNotice(snapshot.attention) : undefined;
        pruneYielded(sessionId, snapshot.attention, attention?.attentionId);
        return new Map(prev).set(sessionId, { ...current, attention });
      });
      return;
    }
    observations.current.set(sessionId, (observations.current.get(sessionId) ?? 0) + 1);
    setActivityMap(prev => {
      if (userIdRef.current !== user || clientRef.current !== activeClient || activityOwner.current.user !== user || activityOwner.current.client !== activeClient
        || subsRef.current.get(sessionId) !== owner) return prev;
      const current = prev.get(sessionId);
      if (!current || !sameNotice(current.attention, captured)) return prev;
      return new Map(prev).set(sessionId, { ...current, attention: undefined });
    });
  }, []);

  const answerSessionAttention = useCallback(async (
    sessionId: string, expected: ManualInputNotice, answers: AttentionAnswerEntry[],
  ): Promise<AnswerSessionAttentionResult> => {
    const fail = (code: string, message: string): AnswerSessionAttentionResult => ({ ok: false, code, message });
    if (!expected.attentionId || !expected.prompt) return fail("attention_not_answerable", "This question cannot be answered here.");
    const currentNotice = activityRef.current.get(sessionId)?.attention;
    if (!sameNotice(currentNotice, expected)) return fail("attention_changed", "This message has changed. Review the latest notice.");
    const session = sessionsRef.current.find(row => row.id === sessionId);
    const owner = subsRef.current.get(sessionId);
    const user = userIdRef.current;
    const activeClient = clientRef.current;
    if (!session || !owner || !rpcRef.current || owner.client !== activeClient || owner.user !== user
      || activityOwner.current.client !== activeClient || activityOwner.current.user !== user) {
      return fail("session_unavailable", "The session is unavailable. Reconnect and try again.");
    }
    const eventId = expected.attentionId;
    const sequence = expected.attentionSequence ?? 0;
    observations.current.set(sessionId, (observations.current.get(sessionId) ?? 0) + 1);
    const observation = observations.current.get(sessionId);
    const payload: AnswerSessionAttentionPayload = { bridgeId: session.bridgeId, sessionId, eventId, answers };
    let response;
    try { response = await rpcRef.current.sendCommand({ type: "answer_session_attention", requestId: uuidv4(), payload }); }
    catch { hydrate(sessionId, true); return fail("rpc_failed", "Could not send the answer. Reconnect and try again."); }
    if (response.success && (userIdRef.current !== user || clientRef.current !== owner.client || subsRef.current.get(sessionId) !== owner
      || !sessionsRef.current.some(row => row.id === sessionId && row.bridgeId === session.bridgeId))) {
      // The answer was delivered; only the local view moved on. Remember it so a replay stays hidden,
      // but only for the user and client the request was sent for.
      if (userIdRef.current === user && clientRef.current === owner.client) {
        dismissedThrough.current.set(sessionId, Math.max(dismissedThrough.current.get(sessionId) ?? 0, sequence));
      }
      const delivered = answerResponse(response.data, sessionId);
      return delivered ? { ok: true, delivery: delivered.delivery } : fail("invalid_response", "Could not confirm the answer. Try again.");
    }
    if (!response.success) {
      const data = response.data && typeof response.data === "object" ? response.data as Record<string, unknown> : {};
      const code = typeof data.code === "string" ? data.code : "command_failed";
      const bridgeMessage = response.error || "Could not send the answer. Try again.";
      if (code === "unknown_command" || code === "unsupported_command" || response.error === "Unknown command type: answer_session_attention") {
        hydrate(sessionId, true);
        return fail(code === "command_failed" ? "unsupported_command" : code, "Update this computer's ftown bridge to answer questions.");
      }
      if (code === "attention_already_resolved" || code === "attention_not_found") {
        dismissedThrough.current.set(sessionId, Math.max(dismissedThrough.current.get(sessionId) ?? 0, sequence));
      }
      // The observation bump fenced any in-flight snapshot; read a fresh one.
      hydrate(sessionId, true);
      return fail(code, bridgeMessage);
    }
    const parsed = answerResponse(response.data, sessionId);
    if (!parsed) { hydrate(sessionId, true); return fail("invalid_response", "Could not confirm the answer. Try again."); }
    const { snapshot, delivery } = parsed;
    dismissedThrough.current.set(sessionId, Math.max(dismissedThrough.current.get(sessionId) ?? 0, sequence));
    if (observations.current.get(sessionId) !== observation) return { ok: true, delivery };
    const known = canonical.current.get(sessionId);
    if (!known || snapshot.sequence >= known.sequence) canonical.current.set(sessionId, { sequence: snapshot.sequence, activeId: snapshot.attention?.id ?? null });
    observations.current.set(sessionId, (observations.current.get(sessionId) ?? 0) + 1);
    setActivityMap(prev => {
      if (userIdRef.current !== user || clientRef.current !== owner.client || subsRef.current.get(sessionId) !== owner) return prev;
      const current = prev.get(sessionId);
      if (!current || !sameNotice(current.attention, expected)) return prev;
      const attention = snapshot.attention ? restoredNotice(snapshot.attention) : undefined;
      pruneYielded(sessionId, snapshot.attention, attention?.attentionId);
      return new Map(prev).set(sessionId, { ...current, attention });
    });
    return { ok: true, delivery };
  }, [hydrate]);

  // Status guard at the source: activity is only meaningful for live sessions.
  // A session that completed/errored/stopped keeps its last hook activity in
  // activityMap, but that state is stale — drop it so every consumer reads
  // idle/absent for anything that is not running/pending.
  const sessionActivity = useMemo(() => {
    const liveStatus = new Map(sessions.map((s) => [s.id, s.status]));
    const effective = new Map<string, SessionActivity>();
    for (const [sessionId, activity] of activityMap) {
      const status = liveStatus.get(sessionId);
      if (status === "running" || status === "pending") {
        effective.set(sessionId, activity);
      }
    }
    return effective;
  }, [activityMap, sessions]);

  const refreshSessionAttention = useCallback(async (sessionId: string) => {
    await readSnapshot(sessionId, true);
  }, [readSnapshot]);

  return { sessionActivity, markSessionIdle, clearSessionAttention, answerSessionAttention, refreshSessionAttention };
}
