// Session and restart properties S1, R1 over the canonical log. Pure functions, no I/O.
import type { PropResult, Property, Rec } from '../contract.ts';

type Checkpoint = Extract<Rec, { k: 'checkpoint' }>;

function finalCheckpoint(log: readonly Rec[]): Checkpoint | undefined {
  return log.find((r): r is Checkpoint => r.k === 'checkpoint' && r.final);
}

const s1: Property = {
  id: 'S1',
  kind: 'unreachable',
  source: 'bridge/src/claude-runner.ts:344-390',
  title: 'dead session shown live',
  check(log): PropResult {
    const fin = finalCheckpoint(log);
    if (fin === undefined) return { status: 'pass', evidence: [] };
    const evidence = fin.snap.sessions
      .filter((s) => (s.status === 'running' || s.status === 'pending') && !s.tmuxAlive && !s.procAlive)
      .map((s) => `${s.role} status=${s.status} tmux and process gone`)
      .sort();
    return evidence.length > 0 ? { status: 'violated', evidence } : { status: 'pass', evidence: [] };
  },
};

const r1: Property = {
  id: 'R1',
  kind: 'always',
  source: 'bridge/src/index.ts:1057-1074',
  title: 'bridge is back after heal',
  check(log): PropResult {
    const fin = finalCheckpoint(log);
    if (fin === undefined) return { status: 'violated', evidence: ['no final checkpoint'] };
    const evidence: string[] = [];
    if (!fin.snap.bridgeAlive) evidence.push('bridge not alive');
    if (!fin.snap.bridgeResponsive) evidence.push('bridge not responsive');
    for (const s of fin.snap.sessions) if (s.status === 'unparseable') evidence.push(`${s.role} session.json unparseable`);
    evidence.sort();
    return evidence.length > 0 ? { status: 'violated', evidence } : { status: 'pass', evidence: [] };
  },
};

export const sessionProperties: Property[] = [s1, r1];
