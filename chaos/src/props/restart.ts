// Bridge restart property R2 over the canonical log. Pure function, no I/O.
import type { FaultKind, Property, PropResult, Rec } from '../contract.ts';

export const GRACE_MS = 30_000;
/** Mirrors CONTROL_TIMEOUT_MS in supervisor/main.ts: max guest time a responsiveness probe can take after c.t. */
export const PROBE_WINDOW_MS = 20_000;

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
  endT: number;
}

interface BridgeHeal {
  id: string;
  doneT: number;
}

const r2: Property = {
  id: 'R2',
  kind: 'unreachable',
  source: 'bridge/src/solo/hub-manager.ts (hub health wait); bridge/src/index.ts solo start',
  title: 'bridge down while no bridge fault is active',
  check(log: readonly Rec[]): PropResult {
    const intervals: BridgeInterval[] = [];
    const openById = new Map<string, BridgeInterval>();
    const heals: BridgeHeal[] = [];
    const evidence: string[] = [];

    for (const r of log) {
      if (r.k !== 'fault') continue;

      if (r.phase === 'heal' && !r.ok && (r.id === 'heal' || BRIDGE_FAULT_KINDS.has(r.kind))) {
        evidence.push(`heal failed: ${r.id} ${r.kind} t=${r.t} doneT=${r.doneT}`);
      }

      if (r.id === 'heal') continue;
      if (!BRIDGE_FAULT_KINDS.has(r.kind)) continue;

      if (r.phase === 'start') {
        if (!r.ok) continue;
        const inv: BridgeInterval = {
          id: r.id,
          kind: r.kind,
          startT: r.t,
          endT: r.doneT + GRACE_MS,
        };
        intervals.push(inv);
        openById.set(r.id, inv);
      } else if (r.phase === 'heal') {
        const inv = openById.get(r.id);
        if (inv !== undefined) {
          heals.push({ id: r.id, doneT: r.doneT });
          inv.endT = r.doneT + GRACE_MS;
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
    if (firstAliveIdx !== -1) {
      const evaluatedCheckpoints = checkpoints.slice(firstAliveIdx);
      for (const c of evaluatedCheckpoints) {
        if (c.snap.bridgeAlive && c.snap.bridgeResponsive) continue;

        // A checkpoint's t is stamped before its responsiveness probe runs (up to PROBE_WINDOW_MS).
        // When alive=true and responsive=false, exempt if [c.t, c.t + PROBE_WINDOW_MS] overlaps a granted
        // fault interval; when alive=false, use c.t alone.
        const inside = c.snap.bridgeAlive
          ? intervals.some((inv) => c.t <= inv.endT && inv.startT <= c.t + PROBE_WINDOW_MS)
          : intervals.some((inv) => c.t >= inv.startT && c.t <= inv.endT);
        if (inside) continue;

        let lastHeal: BridgeHeal | null = null;
        for (const h of heals) {
          if (h.doneT <= c.t && (lastHeal === null || h.doneT >= lastHeal.doneT)) {
            lastHeal = h;
          }
        }
        const lastId = lastHeal ? lastHeal.id : 'none';
        const lastDoneT = lastHeal ? String(lastHeal.doneT) : 'none';
        evidence.push(
          `bridge down at ${c.name} t=${c.t} last bridge fault ${lastId} healed doneT=${lastDoneT}`,
        );
      }
    }

    evidence.sort();
    return evidence.length > 0 ? { status: 'violated', evidence } : { status: 'pass', evidence: [] };
  },
};

export const restartProperties: Property[] = [r2];
