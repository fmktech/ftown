"use client";

import type { LedgerCheckpoint } from "@security/ledger/protocol";
import type { LedgerPeersView } from "@/lib/ledger-client";

/*
 * One informational line: which other replicas confirmed this browser's current head. Nothing in the UI waits on it.
 * Labels come from the signed checkpoint and are rendered as text.
 */

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "X", "X and Y", "X, Y and Z"; more than three become a count ("4 computers"). */
function nameList(names: string[]): string {
  if (names.length > 3) return `${names.length} computers`;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The agreement sentences for the current members, in display order (empty when there is nothing to say). */
export function replicaAgreementLines(peers: LedgerPeersView, checkpoint: LedgerCheckpoint): string[] {
  const devices = new Set(checkpoint.devices.map(item => item.endpoint.id));
  const bridges = new Map(checkpoint.bridges.map(item => [item.bridgeId, item.label || item.bridgeId.slice(0, 8)] as const));
  const computers = peers.confirmed.filter(item => item.kind === "bridge" && bridges.has(item.id)).length;
  const browsers = peers.confirmed.filter(item => item.kind === "device" && devices.has(item.id)).length;
  const parts = [computers > 0 ? plural(computers, "computer", "computers") : null, browsers > 0 ? plural(browsers, "browser", "browsers") : null].filter(Boolean);
  const lines = [parts.length ? `Applied on ${parts.join(" and ")}.` : "Not confirmed by any other replica yet."];
  const online = new Set(peers.online);
  const confirmed = new Set(peers.confirmed.filter(item => item.kind === "bridge").map(item => item.id));
  const diverged = new Set(peers.diverged.filter(item => item.kind === "bridge").map(item => item.id));
  const offline = [...bridges].filter(([id]) => !online.has(id) && !diverged.has(id)).map(([, label]) => label);
  if (offline.length) lines.push(`${nameList(offline)} will apply it when ${offline.length === 1 ? "it connects" : "they connect"}.`);
  const waiting = [...bridges].filter(([id]) => online.has(id) && !confirmed.has(id) && !diverged.has(id)).map(([, label]) => label);
  if (waiting.length) lines.push(`Waiting for ${nameList(waiting)}…`);
  return lines;
}

export function ReplicaAgreement({ peers, checkpoint }: { peers: LedgerPeersView | undefined; checkpoint: LedgerCheckpoint | null }) {
  if (!peers || !peers.head || !checkpoint) return null;
  return <p role="status" aria-live="polite" data-replica-agreement className="text-xs leading-relaxed text-[var(--text-muted)]">{replicaAgreementLines(peers, checkpoint).join(" ")}</p>;
}
