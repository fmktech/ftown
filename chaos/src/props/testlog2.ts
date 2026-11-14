// Small log builders for the attention, tree and session property tests.
import type { AgentEvent, AttentionObs, FaultKind, Rec, Role, SessionObs, Snapshot, TreeEventObs } from '../contract.ts';

export function sess(role: Role, over: Partial<SessionObs> = {}): SessionObs {
  return {
    role, status: 'running', tmuxAlive: true, procAlive: true,
    inbox: [], inboxParses: true, attention: [], attentionParses: true, untaggedWakingMail: 0, ...over,
  };
}

export function att(askTag: string, over: Partial<AttentionObs> = {}): AttentionObs {
  return { askTag, route: 'parent', resolved: false, resolution: null, escalated: false, ...over };
}

export function ev(seq: number, kind = 'k', role: Role | null = 'child1'): TreeEventObs {
  return { seq, kind, role };
}

export function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    bridgeAlive: true, bridgeResponsive: true,
    sessions: [sess('root'), sess('child1')],
    treeEvents: [], treeEventsCorruptLines: 0, ...over,
  };
}

export function cp(t: number, s: Snapshot, final = false): Rec {
  return { k: 'checkpoint', t, name: final ? 'final' : `cp${t}`, final, snap: s };
}

export function agent(t: number, role: Role, e: AgentEvent): Rec {
  return { k: 'agent', t, role, e };
}

export function askSent(t: number, role: Role, askTag: string, accepted = true): Rec {
  return agent(t, role, { ev: 'ask_sent', askTag, accepted, error: accepted ? null : 'refused' });
}

export function answered(t: number, role: Role, askTag: string): Rec {
  return agent(t, role, { ev: 'answer_received', askTag, answer: 'yes', via: 'waiter' });
}

export function faultStart(t: number, kind: FaultKind, target = 'root', doneT = t): Rec {
  return { k: 'fault', t, doneT, id: 'f1', phase: 'start', kind, target, ok: true };
}
