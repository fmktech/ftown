import type { Session } from "@/types";

/** Immediate session first. Legacy links without a bridge ID resolve by their session UUID. */
export function sessionLineage(session: Session, byId: ReadonlyMap<string, Session>) {
  const chain: Session[] = [];
  const seen = new Set<string>();
  let current = session;
  while (true) {
    if (seen.has(current.id)) return { chain, problem: "cycle" as const };
    seen.add(current.id);
    chain.push(current);
    if (!current.parentSessionId) return { chain };
    const parent: Session | undefined = byId.get(current.parentSessionId);
    if (!parent) return { chain, problem: "missing" as const };
    if (current.parentBridgeId && current.parentBridgeId !== parent.bridgeId) return { chain, problem: "owner" as const };
    current = parent;
  }
}
