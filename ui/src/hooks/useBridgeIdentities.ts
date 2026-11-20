import { useEffect, useMemo, useState } from "react";
import type { BridgeIdentity } from "@/components/BridgeBadge";

export function useBridgeIdentities(account: string, known: readonly { bridgeId: string; label: string }[], sessions: readonly { bridgeId: string }[]) {
  const key = `ftown:computerNumbers:${account}`;
  const [registry, setRegistry] = useState<{ key: string; entries: [string, string][] }>();
  useEffect(() => {
    let entries: [string, string][] = [];
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(key) || "[]");
      if (Array.isArray(stored)) entries = stored.filter((row): row is [string, string] =>
        Array.isArray(row) && row.length === 2 && row.every(value => typeof value === "string"));
    } catch { /* Storage can be unavailable in private browsing. */ }
    setRegistry(previous => {
      const initial = previous?.key === key ? previous.entries : entries;
      const names = new Map(initial);
      const discovered = new Map(sessions.map(s => [s.bridgeId, s.bridgeId]));
      for (const b of known) discovered.set(b.bridgeId, b.label);
      for (const id of [...discovered.keys()].sort()) {
        const label = discovered.get(id);
        names.set(id, label && label !== id && label !== "unknown" ? label : names.get(id) || id);
      }
      const next = Array.from(names);
      if (previous?.key === key && next.length === initial.length && next.every(([id, name], i) => initial[i][0] === id && initial[i][1] === name)) return previous;
      return { key, entries: next };
    });
  }, [key, known, sessions]);
  useEffect(() => {
    if (registry?.key === key) try { localStorage.setItem(key, JSON.stringify(registry.entries)); } catch { /* Keep in memory. */ }
  }, [key, registry]);
  return useMemo(() => new Map<string, BridgeIdentity>((registry?.key === key ? registry.entries : [])
    .map(([id, name], index) => [id, { number: index + 1, name }])), [registry, key]);
}
