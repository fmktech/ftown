// Attention properties A1, A2, C2 over the canonical log. Pure functions, no I/O.
import { PARENT_OF } from '../contract.ts';
import type { AttentionObs, PropResult, Property, Rec, Role, SessionObs, Snapshot } from '../contract.ts';

type Checkpoint = Extract<Rec, { k: 'checkpoint' }>;

function checkpoints(log: readonly Rec[]): Checkpoint[] {
  return log.filter((r): r is Checkpoint => r.k === 'checkpoint');
}

function finalCheckpoint(log: readonly Rec[]): Checkpoint | undefined {
  return checkpoints(log).find((c) => c.final);
}

function sortedUnique(lines: string[]): string[] {
  return [...new Set(lines)].sort();
}

function openParentAsks(snap: Snapshot): { role: Role; item: AttentionObs }[] {
  const out: { role: Role; item: AttentionObs }[] = [];
  for (const s of snap.sessions) {
    for (const item of s.attention) {
      if (!item.resolved && item.route === 'parent') out.push({ role: s.role, item });
    }
  }
  return out;
}

function parentAlive(snap: Snapshot, role: Role): boolean {
  const parent = PARENT_OF[role];
  if (parent === null) return true;
  const p: SessionObs | undefined = snap.sessions.find((s) => s.role === parent);
  return p !== undefined && p.status === 'running' && p.procAlive;
}

function anyParentRoute(log: readonly Rec[]): boolean {
  return checkpoints(log).some((c) => c.snap.sessions.some((s) => s.attention.some((a) => a.route === 'parent')));
}

const a1: Property = {
  id: 'A1',
  kind: 'always',
  source: 'bridge/src/attention-store.ts:423,455-462',
  title: 'an ask is answered at most once',
  check(log): PropResult {
    let exercised = false;
    const counts = new Map<string, number>();
    for (const r of log) {
      if (r.k !== 'agent') continue;
      if (r.e.ev === 'ask_sent' && r.e.accepted) exercised = true;
      if (r.e.ev === 'answer_received') counts.set(r.e.askTag, (counts.get(r.e.askTag) ?? 0) + 1);
    }
    if (!exercised) return { status: 'unexercised', evidence: [] };
    const evidence: string[] = [];
    for (const [tag, n] of counts) if (n > 1) evidence.push(`${tag} answered ${n} times`);
    return evidence.length > 0 ? { status: 'violated', evidence: sortedUnique(evidence) } : { status: 'pass', evidence: [] };
  },
};

const a2: Property = {
  id: 'A2',
  kind: 'always',
  source: 'bridge/src/coordination/contract-b.ts:26-28',
  title: 'parent-routed ask escalates when the parent dies',
  check(log): PropResult {
    if (!anyParentRoute(log)) return { status: 'unexercised', evidence: [] };
    const fin = finalCheckpoint(log);
    if (fin === undefined) return { status: 'unexercised', evidence: [] };
    const evidence: string[] = [];
    for (const { role, item } of openParentAsks(fin.snap)) {
      if (!parentAlive(fin.snap, role)) {
        evidence.push(`${role} ${item.askTag} route=parent unresolved, ${PARENT_OF[role]} not alive`);
      }
    }
    return evidence.length > 0 ? { status: 'violated', evidence: sortedUnique(evidence) } : { status: 'pass', evidence: [] };
  },
};

const c2: Property = {
  id: 'C2',
  kind: 'sometimes',
  source: 'bridge/src/coordination/wiring.ts:165',
  title: 'parent died with an open child ask',
  check(log): PropResult {
    const cps = checkpoints(log);
    const evidence: string[] = [];
    for (const r of log) {
      if (r.k !== 'fault' || r.phase !== 'start' || r.kind !== 'parent_kill9') continue;
      let latest: Checkpoint | undefined;
      for (const c of cps) if (c.t < r.t && (latest === undefined || c.t >= latest.t)) latest = c;
      if (latest === undefined) continue;
      for (const { role, item } of openParentAsks(latest.snap)) evidence.push(`parent_kill9 with open ${item.askTag} from ${role}`);
    }
    return evidence.length > 0 ? { status: 'hit', evidence: sortedUnique(evidence) } : { status: 'not_hit', evidence: [] };
  },
};

export const attentionProperties: Property[] = [a1, a2, c2];
