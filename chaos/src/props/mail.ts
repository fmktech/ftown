// Mail properties: pure functions over the canonical log. No I/O.
import type { MailType, PropResult, Property, Rec, Role, SessionObs, Snapshot } from '../contract.ts';

interface Send {
  tag: string;
  to: Role;
  type: MailType;
}

function sorted(lines: Iterable<string>): string[] {
  return [...new Set(lines)].sort();
}

function acceptedSends(log: readonly Rec[]): Send[] {
  const out: Send[] = [];
  for (const r of log) {
    if (r.k === 'op' && r.op.op === 'mail_send' && r.ok) {
      out.push({ tag: r.op.tag, to: r.op.to, type: r.op.type });
    } else if (r.k === 'agent' && r.e.ev === 'mail_sent' && r.e.accepted) {
      out.push({ tag: r.e.tag, to: r.e.to, type: r.e.type });
    }
  }
  return out;
}

function finalSnapshot(log: readonly Rec[]): Snapshot | null {
  let snap: Snapshot | null = null;
  for (const r of log) {
    if (r.k === 'checkpoint' && r.final) snap = r.snap;
  }
  return snap;
}

function sessionOf(snap: Snapshot, role: Role): SessionObs | undefined {
  return snap.sessions.find((s) => s.role === role);
}

const M1: Property = {
  id: 'M1',
  kind: 'always',
  source: 'bridge/src/mail-delivery.ts:506-519',
  title: 'accepted mail is durable',
  check(log): PropResult {
    const sends = acceptedSends(log);
    if (sends.length === 0) return { status: 'unexercised', evidence: [] };
    const snap = finalSnapshot(log);
    if (snap === null) return { status: 'violated', evidence: ['no final checkpoint'] };
    const received = new Set<string>();
    for (const r of log) {
      if (r.k === 'agent' && r.e.ev === 'mail_received') received.add(`${r.role}\u0000${r.e.tag}`);
    }
    const evidence: string[] = [];
    const recipients = new Set(sends.map((s) => s.to));
    for (const role of recipients) {
      const s = sessionOf(snap, role);
      if (s !== undefined && !s.inboxParses) evidence.push(`inbox unparseable ${role}`);
    }
    for (const send of sends) {
      const s = sessionOf(snap, send.to);
      const inInbox = s !== undefined && s.inbox.some((m) => m.tag === send.tag);
      if (!inInbox && !received.has(`${send.to}\u0000${send.tag}`)) {
        evidence.push(`lost ${send.tag} to=${send.to}`);
      }
    }
    return evidence.length === 0
      ? { status: 'pass', evidence: [] }
      : { status: 'violated', evidence: sorted(evidence) };
  },
};

const M2: Property = {
  id: 'M2',
  kind: 'always',
  source: 'bridge/src/mail-delivery.ts:589-595,619-629',
  title: 'mail consumed at most once',
  check(log): PropResult {
    const counts = new Map<string, number>();
    for (const r of log) {
      if (r.k === 'agent' && r.e.ev === 'mail_received') {
        const key = `${r.e.tag} to=${r.role}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    if (counts.size === 0) return { status: 'unexercised', evidence: [] };
    const evidence: string[] = [];
    for (const [key, n] of counts) {
      if (n > 1) evidence.push(`duplicate ${key}`);
    }
    return evidence.length === 0
      ? { status: 'pass', evidence: [] }
      : { status: 'violated', evidence: sorted(evidence) };
  },
};

const M4: Property = {
  id: 'M4',
  kind: 'always',
  source: 'bridge/src/coordination/contract.ts:216-220',
  title: 'nudge-once',
  check(log): PropResult {
    const sends = acceptedSends(log);
    const waking = new Map<Role, Set<string>>();
    for (const s of sends) {
      if (s.type === 'fyi') continue;
      let set = waking.get(s.to);
      if (set === undefined) waking.set(s.to, (set = new Set()));
      set.add(s.tag);
    }
    const nudged = new Map<Role, number>();
    for (const r of log) {
      if (r.k === 'agent' && r.e.ev === 'nudge') nudged.set(r.role, (nudged.get(r.role) ?? 0) + r.e.n);
    }
    const untagged = new Map<Role, number>();
    for (const r of log) {
      if (r.k !== 'checkpoint') continue;
      for (const s of r.snap.sessions) {
        untagged.set(s.role, Math.max(untagged.get(s.role) ?? 0, s.untaggedWakingMail));
      }
    }
    const roles = new Set<Role>([...waking.keys(), ...untagged.keys()]);
    if (![...roles].some((r) => (waking.get(r)?.size ?? 0) + (untagged.get(r) ?? 0) > 0)) {
      return { status: 'unexercised', evidence: [] };
    }
    const evidence: string[] = [];
    for (const [role, n] of nudged) {
      const w = waking.get(role)?.size ?? 0;
      const u = untagged.get(role) ?? 0;
      if (n > w + u) evidence.push(`nudge excess to=${role} nudged=${n} waking=${w} untagged=${u}`);
    }
    return evidence.length === 0
      ? { status: 'pass', evidence: [] }
      : { status: 'violated', evidence: sorted(evidence) };
  },
};

const M5: Property = {
  id: 'M5',
  kind: 'always',
  source: 'bridge/src/mail-delivery.ts:253-270',
  title: 'pending mail is recovered after heal',
  check(log): PropResult {
    const snap = finalSnapshot(log);
    if (snap === null) return { status: 'unexercised', evidence: [] };
    const live = snap.sessions.filter((s) => s.status === 'running' && s.tmuxAlive && s.procAlive);
    if (live.length === 0) return { status: 'unexercised', evidence: [] };
    const evidence: string[] = [];
    for (const s of live) {
      for (const m of s.inbox) {
        if (!m.delivered && !m.nudged && m.type !== 'fyi') evidence.push(`pending ${m.tag} to=${s.role}`);
      }
    }
    return evidence.length === 0
      ? { status: 'pass', evidence: [] }
      : { status: 'violated', evidence: sorted(evidence) };
  },
};

const C1: Property = {
  id: 'C1',
  kind: 'sometimes',
  source: 'bridge/src/mail-delivery.ts:186-205',
  title: 'bridge restarted with mail pending',
  check(log): PropResult {
    let latest: Snapshot | null = null;
    for (const r of log) {
      if (r.k === 'checkpoint') {
        latest = r.snap;
      } else if (
        r.k === 'fault' &&
        r.phase === 'start' &&
        (r.kind === 'bridge_kill9' || r.kind === 'bridge_sigterm') &&
        latest !== null &&
        latest.sessions.some((s) => s.inbox.some((m) => !m.delivered))
      ) {
        return { status: 'hit', evidence: [] };
      }
    }
    return { status: 'not_hit', evidence: [] };
  },
};

export const mailProperties: Property[] = [M1, M2, M4, M5, C1];
