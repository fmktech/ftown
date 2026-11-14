// Canonical order of the log: 'run', 'schedule', then everything else by
// (t, kind fault<op<agent<checkpoint, role in ROLES order, original sequence).
import { ROLES } from '../contract.ts';
import type { Rec } from '../contract.ts';

export interface Seq {
  rec: Rec;
  seq: number;
}

const KIND: Readonly<Record<string, number>> = { run: -2, schedule: -1, fault: 0, op: 1, agent: 2, checkpoint: 3, verdict: 4 };

function tOf(r: Rec): number {
  return 't' in r ? r.t : -1;
}

function roleIndex(r: Rec): number {
  let role: string | undefined;
  if (r.k === 'agent') role = r.role;
  else if (r.k === 'op') role = 'role' in r.op ? r.op.role : r.op.to;
  else if (r.k === 'fault') role = r.target;
  const i = role === undefined ? -1 : ROLES.indexOf(role as (typeof ROLES)[number]);
  return i;
}

export function compareRecs(a: Seq, b: Seq): number {
  const ka = KIND[a.rec.k];
  const kb = KIND[b.rec.k];
  if (ka < 0 || kb < 0) return ka - kb || a.seq - b.seq;
  return tOf(a.rec) - tOf(b.rec) || ka - kb || roleIndex(a.rec) - roleIndex(b.rec) || a.seq - b.seq;
}

export function canonicalOrder(items: readonly Seq[]): Rec[] {
  return [...items].sort(compareRecs).map((s) => s.rec);
}
