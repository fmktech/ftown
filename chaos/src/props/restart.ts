// Bridge restart property R2 over the canonical log. Pure function, no I/O.
import type { FaultKind, Property, PropResult, Rec } from '../contract.ts';

export const GRACE_MS = 30_000;

const BRIDGE_FAULT_KINDS = new Set<FaultKind>([
  'bridge_kill9',
  'bridge_sigterm',
  'bridge_sigstop',
]);

type Checkpoint = Extract<Rec, { k: 'checkpoint' }>;

interface BridgeInterval {
  id: string;
  kind: FaultKind;
  startT: number;
  healT: number | null;
  endT: number;
}

const r2: Property = {
  id: 'R2',
  kind: 'unreachable',
  source: 'bridge/src/solo/hub-manager.ts (hub health wait); bridge/src/index.ts solo start',
  title: 'bridge down while no bridge fault is active',
  check(log: readonly Rec[]): PropResult {
    const intervals: BridgeInterval[] = [];
    const openById = new Map<string, BridgeInterval>();

    for (const r of log) {
      if (r.k !== 'fault') continue;
      if (r.id === 'heal') continue;
      if (!BRIDGE_FAULT_KINDS.has(r.kind)) continue;

      if (r.phase === 'start') {
        const inv: BridgeInterval = {
          id: r.id,
          kind: r.kind,
          startT: r.t,
          healT: null,
          endT: Infinity,
        };
        intervals.push(inv);
        openById.set(r.id, inv);
      } else if (r.phase === 'heal') {
        const inv = openById.get(r.id);
        if (inv !== undefined) {
          inv.healT = r.t;
          inv.endT = r.t + GRACE_MS;
          openById.delete(r.id);
        }
      }
    }

    const checkpoints: Checkpoint[] = [];
    for (const r of log) {
      if (r.k === 'checkpoint') {
        checkpoints.push(r);
      }
    }
    checkpoints.sort((a, b) => a.t - b.t);

    // Checkpoints before the first checkpoint that shows bridgeAlive === true are ignored (bring-up).
    const firstAliveIdx = checkpoints.findIndex((c) => c.snap.bridgeAlive);
    if (firstAliveIdx === -1) {
      return { status: 'pass', evidence: [] };
    }

    const evaluatedCheckpoints = checkpoints.slice(firstAliveIdx);
    const evidence: string[] = [];

    for (const c of evaluatedCheckpoints) {
      if (c.snap.bridgeAlive) continue;

      const inside = intervals.some((inv) => c.t >= inv.startT && c.t <= inv.endT);
      if (inside) continue;

      const priorFaults = intervals.filter(
        (inv): inv is BridgeInterval & { healT: number } => inv.healT !== null && inv.healT < c.t,
      );

      if (priorFaults.length === 0) {
        evidence.push(`bridge dead at checkpoint ${c.name}, no bridge fault before it`);
      } else {
        let latest = priorFaults[0];
        for (let i = 1; i < priorFaults.length; i++) {
          if (priorFaults[i].healT > latest.healT) {
            latest = priorFaults[i];
          }
        }
        const elapsed = c.t - latest.healT;
        const n = Math.floor(elapsed / 10_000) * 10_000;
        evidence.push(
          `bridge dead at checkpoint ${c.name}, ${n} ms after heal of ${latest.id} (${latest.kind})`,
        );
      }
    }

    evidence.sort();
    return evidence.length > 0 ? { status: 'violated', evidence } : { status: 'pass', evidence: [] };
  },
};

export const restartProperties: Property[] = [r2];
