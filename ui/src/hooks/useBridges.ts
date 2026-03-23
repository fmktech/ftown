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

export function useBridges(client: Centrifuge | null, userId: string | null): UseBridgesResult {
  const [bridges, setBridges] = useState<BridgeInfo[]>([]);
  const subRef = useRef<Subscription | null>(null);

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
      setBridges(bridgeList);
    } catch {
      setBridges([]);
    }
  }, []);

  useEffect(() => {
    if (!client || !userId) {
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
      setBridges((prev) => {
        if (prev.some((b) => b.clientId === bridge.clientId)) return prev;
        return [...prev, bridge];
      });
    });

    sub.on("leave", (ctx) => {
      setBridges((prev) => prev.filter((b) => b.clientId !== ctx.info.client));
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
      setBridges([]);
    };
  }, [client, userId, fetchPresence]);

  return {
    bridges,
    hasBridges: bridges.length > 0,
  };
}
