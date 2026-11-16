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
type CheckpointState = 'good' | 'exempt' | 'dead' | 'unresponsive';

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
  title: 'bridge dead, or unresponsive at two consecutive checkpoints, while no bridge fault is active',
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
      const states: CheckpointState[] = evaluatedCheckpoints.map((c) => {
        if (c.snap.bridgeAlive && c.snap.bridgeResponsive) return 'good';
        // A checkpoint's t is stamped before its responsiveness probe runs (up to PROBE_WINDOW_MS).
        // When alive=true and responsive=false, exempt if [c.t, c.t + PROBE_WINDOW_MS] overlaps a granted
        // fault interval; when alive=false, use c.t alone.
        const inside = c.snap.bridgeAlive
          ? intervals.some((inv) => c.t <= inv.endT && inv.startT <= c.t + PROBE_WINDOW_MS)
          : intervals.some((inv) => c.t >= inv.startT && c.t <= inv.endT);
        if (inside) return 'exempt';
        return c.snap.bridgeAlive ? 'unresponsive' : 'dead';
      });

      const lastHealAt = (t: number): BridgeHeal | null => {
        let lastHeal: BridgeHeal | null = null;
        for (const h of heals) {
          if (h.doneT <= t && (lastHeal === null || h.doneT >= lastHeal.doneT)) lastHeal = h;
        }
        return lastHeal;
      };
      const healTailAt = (t: number): string => {
        const lastHeal = lastHealAt(t);
        return `last bridge fault ${lastHeal ? lastHeal.id : 'none'} healed doneT=${lastHeal ? lastHeal.doneT : 'none'}`;
      };

      for (let i = 0; i < evaluatedCheckpoints.length; i += 1) {
        const c = evaluatedCheckpoints[i];
        const state = states[i];
        if (state === 'dead') {
          evidence.push(`bridge dead at ${c.name} t=${c.t} ${healTailAt(c.t)}`);
          continue;
        }
        const next = evaluatedCheckpoints[i + 1];
        if (state === 'unresponsive' && next !== undefined &&
          (states[i + 1] === 'dead' || states[i + 1] === 'unresponsive')) {
          evidence.push(
            `bridge alive but unresponsive at ${c.name} t=${c.t} and ${next.name} t=${next.t} ${healTailAt(c.t)}`,
          );
        }
      }
    }

    evidence.sort();
    return evidence.length > 0 ? { status: 'violated', evidence } : { status: 'pass', evidence: [] };
  },
};

export const restartProperties: Property[] = [r2];
