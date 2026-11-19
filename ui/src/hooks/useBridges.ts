"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import type { MessageClient, MessageSubscription } from "@/lib/message-client";
import { accountChannel } from "@security/ledger/channels";
import type { TerminalTransportApi } from "@/lib/direct-transport/contract";

/** The names bridges were last seen under, so a bridge reached without the relay still shows its name. Not trusted for anything. */
export const BRIDGE_NAMES_STORAGE_KEY = "ftown.bridgeNames.v1";
const MAX_REMEMBERED_NAMES = 32;

function readNames(): Map<string, string> {
  const names = new Map<string, string>();
  try {
    if (typeof localStorage === "undefined") return names;
    const stored: unknown = JSON.parse(localStorage.getItem(BRIDGE_NAMES_STORAGE_KEY) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return names;
    for (const [bridgeId, name] of Object.entries(stored)) {
      if (names.size >= MAX_REMEMBERED_NAMES) break;
      if (/^[A-Za-z0-9_-]{1,200}$/.test(bridgeId) && typeof name === "string" && name.length > 0 && name.length <= 200) names.set(bridgeId, name);
    }
  } catch { /* nothing remembered */ }
  return names;
}

function rememberNames(names: Map<string, string>, bridges: readonly BridgeInfo[]): void {
  let changed = false;
  for (const bridge of bridges) {
    if (!bridge.hostname || bridge.hostname === "unknown" || bridge.hostname.length > 200 || names.get(bridge.bridgeId) === bridge.hostname) continue;
    names.delete(bridge.bridgeId); names.set(bridge.bridgeId, bridge.hostname); changed = true;
  }
  if (!changed) return;
  while (names.size > MAX_REMEMBERED_NAMES) names.delete(names.keys().next().value!);
  try { if (typeof localStorage !== "undefined") localStorage.setItem(BRIDGE_NAMES_STORAGE_KEY, JSON.stringify(Object.fromEntries(names))); } catch { /* this page only */ }
}

/**
 * The bridges to show: those the relay reports, plus any reached directly that the relay does not report (the relay is down, or has
 * not answered yet). A directly reached bridge has completed the encrypted handshake, so it is at least as real as a presence entry.
 */
export function withDirectBridges(relay: BridgeInfo[], direct: readonly string[], names: ReadonlyMap<string, string>): BridgeInfo[] {
  const seen = new Set(relay.map(bridge => bridge.bridgeId));
  const extra = direct.filter(bridgeId => !seen.has(bridgeId))
    .map(bridgeId => ({ clientId: `direct:${bridgeId}`, bridgeId, hostname: names.get(bridgeId) ?? "unknown", connectedAt: "" }));
  return extra.length ? [...relay, ...extra] : relay;
}

export interface BridgeInfo {
  clientId: string;
  bridgeId: string;
  hostname: string;
  connectedAt: string;
}

interface UseBridgesResult {
  bridges: BridgeInfo[];
  hasBridges: boolean;
  prepareLocalAccess: () => Promise<void>;
}

/**
 * True when `candidate` should win over `current` for the same bridgeId:
 * a strictly newer connectedAt wins outright, and a tie (equal or both
 * missing/unparseable) falls back to "most recently seen" — i.e. whichever
 * entry is being applied later, which is what callers pass as `candidate`.
 * ISO 8601 timestamps compare correctly as strings, so no Date parsing is
 * needed for the common case; anything else falls through to the tie rule.
 */
function winsOver(candidate: BridgeInfo, current: BridgeInfo): boolean {
  const a = candidate.connectedAt || "";
  const b = current.connectedAt || "";
  return a >= b;
}

/**
 * Collapses the full set of KNOWN clients (every clientId currently present
 * for every bridgeId, including stale duplicates from a reconnect whose old
 * connection hasn't expired yet) down to at most one exposed entry per
 * bridgeId — the winner per `winsOver`. This is a pure read-side projection:
 * the underlying client set is never mutated by it, only the value shown to
 * consumers (e.g. the dashboard header count) is.
 *
 * Pure and exported so it can be unit-tested without a Centrifuge client.
 */
export function dedupeBridges(entries: BridgeInfo[]): BridgeInfo[] {
  const byBridgeId = new Map<string, BridgeInfo>();
  for (const entry of entries) {
    const existing = byBridgeId.get(entry.bridgeId);
    if (!existing || winsOver(entry, existing)) {
      byBridgeId.set(entry.bridgeId, entry);
    }
  }
  return Array.from(byBridgeId.values()).sort((a, b) => a.bridgeId.localeCompare(b.bridgeId));
}

/**
 * Pure reducer for a Centrifugo "join" event over the full known-client set:
 * upserts `bridge` by clientId (adds it if new, updates it in place if the
 * same clientId rejoins/re-announces). Deliberately does NOT dedupe by
 * bridgeId here — a reconnecting bridge's stale duplicate must stay in the
 * known-client set until its own "leave" arrives, so the bridge doesn't
 * disappear from the exposed list (see `dedupeBridges`) if the winning
 * client leaves first. Callers derive the exposed list by running the
 * result through `dedupeBridges`.
 */
export function applyBridgeJoin(allClients: BridgeInfo[], bridge: BridgeInfo): BridgeInfo[] {
  const existingIndex = allClients.findIndex((b) => b.clientId === bridge.clientId);
  if (existingIndex === -1) {
    return [...allClients, bridge];
  }
  const next = [...allClients];
  next[existingIndex] = bridge;
  return next;
}

/**
 * Pure reducer for a Centrifugo "leave" event over the full known-client
 * set: removes only the entry whose clientId matches `clientId`. Other
 * clients for the same bridgeId (e.g. a still-live duplicate connection)
 * are left untouched, so the bridge keeps appearing in the exposed
 * (`dedupeBridges`) list until its LAST known client leaves.
 */
export function applyBridgeLeave(allClients: BridgeInfo[], clientId: string): BridgeInfo[] {
  return allClients.filter((b) => b.clientId !== clientId);
}

export function useBridges(client: MessageClient | null, userId: string | null,
  transport: Pick<TerminalTransportApi, "getDirectlyReachableBridgeIds" | "onBridgeReachabilityChange"> | null = null): UseBridgesResult {
  const [relayBridges, setBridges] = useState<BridgeInfo[]>([]);
  const [direct, setDirect] = useState<string[]>([]);
  const namesRef = useRef<Map<string, string> | null>(null);
  if (!namesRef.current) namesRef.current = readNames();
  useEffect(() => {
    if (!transport) { setDirect([]); return; }
    const read = () => setDirect(transport.getDirectlyReachableBridgeIds());
    read();
    return transport.onBridgeReachabilityChange(read);
  }, [transport]);
  useEffect(() => { rememberNames(namesRef.current!, relayBridges); }, [relayBridges]);
  const bridges = useMemo(() => withDirectBridges(relayBridges, direct, namesRef.current!), [relayBridges, direct]);
  const subRef = useRef<MessageSubscription | null>(null);
  const localAdvertsRef = useRef<unknown[]>([]);
  // Every known client per bridgeId (not deduped) — the source of truth fed
  // to dedupeBridges to produce the exposed `bridges` list. Kept in a ref
  // (not state) since it's an internal accumulator; only the derived,
  // deduped projection needs to trigger a re-render.
  const allClientsRef = useRef<BridgeInfo[]>([]);

  const fetchPresence = useCallback(async (sub: MessageSubscription) => {
    try {
      const result = await sub.presence();
      localAdvertsRef.current = Object.values(result.clients).map(info => info.connInfo);
      const bridgeList: BridgeInfo[] = Object.entries(result.clients)
        .filter(([, info]) => info.connInfo && typeof info.connInfo === "object" && "bridgeId" in (info.connInfo as Record<string, unknown>))
        .map(([clientId, info]) => {
          const data = info.connInfo as { bridgeId: string; hostname?: string; connectedAt?: string };
          return {
            clientId,
            bridgeId: data.bridgeId,
            hostname: data.hostname ?? "unknown",
            connectedAt: data.connectedAt ?? "",
          };
        });
      // The presence snapshot is authoritative: replace the full known-client set.
      allClientsRef.current = bridgeList;
      setBridges(dedupeBridges(bridgeList));
    } catch {
      allClientsRef.current = [];
      setBridges([]);
    }
  }, []);

  useEffect(() => {
    if (!client || !userId) {
      allClientsRef.current = [];
      setBridges([]);
      return;
    }

    const abort = new AbortController();
    const channel = accountChannel("bridges:presence", userId);

    const existing = client.getSubscription(channel);
    if (existing) {
      existing.removeAllListeners();
      existing.unsubscribe();
      client.removeSubscription(existing);
    }

    const sub = client.newSubscription(channel);

    sub.on("subscribed", () => {
      fetchPresence(sub);
    });

    sub.on("join", (ctx) => {
      const data = ctx.info.connInfo as { bridgeId?: string; hostname?: string; connectedAt?: string } | undefined;
      if (!data?.bridgeId) return;
      localAdvertsRef.current.push(ctx.info.connInfo);
      const bridge: BridgeInfo = {
        clientId: ctx.info.client,
        bridgeId: data.bridgeId,
        hostname: data.hostname ?? "unknown",
        connectedAt: data.connectedAt ?? "",
      };
      allClientsRef.current = applyBridgeJoin(allClientsRef.current, bridge);
      setBridges(dedupeBridges(allClientsRef.current));
    });

    sub.on("leave", (ctx) => {
      allClientsRef.current = applyBridgeLeave(allClientsRef.current, ctx.info.client);
      setBridges(dedupeBridges(allClientsRef.current));
    });

    sub.subscribe();
    subRef.current = sub;

    const presenceInterval = setInterval(() => {
      fetchPresence(sub);
    }, 10_000);

    return () => {
      abort.abort();
      localAdvertsRef.current = [];
      clearInterval(presenceInterval);
      sub.removeAllListeners();
      sub.unsubscribe();
      client.removeSubscription(sub);
      subRef.current = null;
      allClientsRef.current = [];
      setBridges([]);
    };
  }, [client, userId, fetchPresence]);

  const prepareLocalAccess = useCallback(async () => {
    // A click can precede the first presence snapshot. Give it a bounded chance
    // to discover this computer without trapping navigation during an outage.
    if (!localAdvertsRef.current.length && subRef.current) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([fetchPresence(subRef.current), new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); })]);
      } finally { if (timer) clearTimeout(timer); }
    }
    // Local discovery grants no authority: Solo/--local bridges need an explicit invitation, account bridges trust only the ledger.
  }, [fetchPresence]);

  return {
    prepareLocalAccess,
    bridges,
    hasBridges: bridges.length > 0,
  };
}
