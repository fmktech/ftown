"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Centrifuge, Subscription } from "centrifuge";

export interface BridgeInfo {
  clientId: string;
  bridgeId: string;
  hostname: string;
  connectedAt: string;
}

interface UseBridgesResult {
  bridges: BridgeInfo[];
  hasBridges: boolean;
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

export function useBridges(client: Centrifuge | null, userId: string | null): UseBridgesResult {
  const [bridges, setBridges] = useState<BridgeInfo[]>([]);
  const subRef = useRef<Subscription | null>(null);
  // Every known client per bridgeId (not deduped) — the source of truth fed
  // to dedupeBridges to produce the exposed `bridges` list. Kept in a ref
  // (not state) since it's an internal accumulator; only the derived,
  // deduped projection needs to trigger a re-render.
  const allClientsRef = useRef<BridgeInfo[]>([]);

  const fetchPresence = useCallback(async (sub: Subscription) => {
    try {
      const result = await sub.presence();
      console.log("[bridges] presence result:", JSON.stringify(result.clients, null, 2));
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

    const channel = `bridges:presence#${userId}`;

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
      clearInterval(presenceInterval);
      sub.removeAllListeners();
      sub.unsubscribe();
      client.removeSubscription(sub);
      subRef.current = null;
      allClientsRef.current = [];
      setBridges([]);
    };
  }, [client, userId, fetchPresence]);

  return {
    bridges,
    hasBridges: bridges.length > 0,
  };
}
