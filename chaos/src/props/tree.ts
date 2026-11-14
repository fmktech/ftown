// Tree-event property T1 over the canonical log. Pure function, no I/O.
import type { PropResult, Property, Rec } from '../contract.ts';

type Checkpoint = Extract<Rec, { k: 'checkpoint' }>;

const t1: Property = {
  id: 'T1',
  kind: 'always',
  source: 'bridge/src/coordination/contract.ts:120',
  title: 'tree-event seq has no gaps',
  check(log): PropResult {
    const cps = log.filter((r): r is Checkpoint => r.k === 'checkpoint');
    if (!cps.some((c) => c.snap.treeEvents.length > 0)) return { status: 'unexercised', evidence: [] };
    const evidence = new Set<string>();
    const seen = new Map<number, string>();
    let prevLast: number | null = null;
    for (const c of cps) {
      const evs = c.snap.treeEvents;
      for (let i = 1; i < evs.length; i++) {
        const a = evs[i - 1].seq;
        const b = evs[i].seq;
        if (b !== a + 1) evidence.add(`seq ${a} followed by ${b}`);
      }
      for (const e of evs) {
        const sig = `${e.kind}/${e.role ?? 'none'}`;
        const old = seen.get(e.seq);
        if (old === undefined) seen.set(e.seq, sig);
        else if (old !== sig) evidence.add(`seq ${e.seq} changed ${old} to ${sig}`);
      }
      if (evs.length > 0) {
        const last = evs[evs.length - 1].seq;
        if (prevLast !== null && last < prevLast) evidence.add(`last seq regressed ${prevLast} to ${last}`);
        prevLast = last;
      }
    }
    const fin = cps.find((c) => c.final);
    if (fin !== undefined && fin.snap.treeEventsCorruptLines > 0) evidence.add(`corrupt lines ${fin.snap.treeEventsCorruptLines}`);
    return evidence.size > 0 ? { status: 'violated', evidence: [...evidence].sort() } : { status: 'pass', evidence: [] };
  },
};

export const treeProperties: Property[] = [t1];
