// Small builders for hand-written canonical logs used by property tests.
import type {
  AgentEvent, FaultKind, MailObs, MailType, Rec, Role, SessionObs, Snapshot,
} from '../contract.ts';

export function opSend(t: number, tag: string, to: Role, type: MailType = 'message', ok = true): Rec {
  return { k: 'op', t, op: { op: 'mail_send', tag, to, type }, ok, error: ok ? null : 'refused' };
}

export function agent(t: number, role: Role, e: AgentEvent): Rec {
  return { k: 'agent', t, role, e };
}

export function agentSent(t: number, role: Role, tag: string, to: Role, type: MailType = 'message', accepted = true): Rec {
  return agent(t, role, { ev: 'mail_sent', tag, to, type, accepted, error: accepted ? null : 'refused' });
}

export function received(t: number, role: Role, tag: string, type: MailType = 'message'): Rec {
  return agent(t, role, { ev: 'mail_received', tag, type, fromRole: 'root' });
}

export function nudge(t: number, role: Role, n: number): Rec {
  return agent(t, role, { ev: 'nudge', n });
}

export function mail(tag: string, o: Partial<MailObs> = {}): MailObs {
  return { tag, type: 'message', fromRole: 'root', delivered: true, deliveredVia: 'poll', nudged: false, ...o };
}

export function session(role: Role, inbox: MailObs[] = [], o: Partial<SessionObs> = {}): SessionObs {
  return {
    role, status: 'running', tmuxAlive: true, procAlive: true, inbox, inboxParses: true,
    attention: [], attentionParses: true, untaggedWakingMail: 0, ...o,
  };
}

export function snapshot(sessions: SessionObs[]): Snapshot {
  return { bridgeAlive: true, bridgeResponsive: true, sessions, treeEvents: [], treeEventsCorruptLines: 0 };
}

export function checkpoint(t: number, sessions: SessionObs[], final = false, name = final ? 'final' : `cp${t}`): Rec {
  return { k: 'checkpoint', t, name, final, snap: snapshot(sessions) };
}

export function faultStart(t: number, kind: FaultKind, id = 'f1', doneT = t): Rec {
  return { k: 'fault', t, doneT, id, phase: 'start', kind, target: 'bridge', ok: true };
}
