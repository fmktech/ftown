// External mail workload: every 5–15 s until the fault window ends, one tagged mail from
// 'external' to a random role, sent through the real CLI on the unfaulted control path.
import { FAULT_WINDOW_END_MS, ROLES } from '../contract.ts';
import type { Clock, DeriveRng, MailType, Rec, Role } from '../contract.ts';

export interface PlannedMail {
  atMs: number;
  tag: string;
  to: Role;
  type: MailType;
}

const TYPES: readonly MailType[] = ['message', 'task', 'result', 'fyi'];

/** Pure plan from stream 'workload.mail'. First send at startMs + 5–15 s, last before endMs. */
export function planWorkload(seed: number, deriveRng: DeriveRng, startMs: number, endMs: number = FAULT_WINDOW_END_MS): PlannedMail[] {
  const rng = deriveRng(seed, 'workload.mail');
  const out: PlannedMail[] = [];
  let at = startMs;
  for (let n = 1; ; n++) {
    at += rng.int(5_000, 15_000);
    if (at > endMs) break;
    out.push({ atMs: at, tag: `CHAOS-M-${n}`, to: rng.pick(ROLES), type: rng.pick(TYPES) });
  }
  return out;
}

export type OpError = 'bridge_down' | 'timeout' | `rejected:${string}`;

/** Normalise a failed CLI call to bridge_down | timeout | rejected:<code> (never raw text). */
export function normaliseError(code: number, stderr: string, stdout = ''): OpError {
  if (code === 124) return 'timeout';
  const text = `${stderr}\n${stdout}`;
  if (/ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|bridge\.json|not running|bridge (?:is )?(?:not|un)|no bridge|fetch failed|connect/i.test(text)) return 'bridge_down';
  if (/timed? ?out|ETIMEDOUT/i.test(text)) return 'timeout';
  return `rejected:${code}`;
}

export interface SendResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WorkloadDeps {
  clock: Clock;
  plan: readonly PlannedMail[];
  /** Session id of a role (null when unknown). */
  idOf: (role: Role) => string | null;
  /** `ftown harness mail send <id> --type <t> <body>` as the bridge user. */
  send: (id: string, type: MailType, body: string) => Promise<SendResult>;
  log: (rec: Rec) => void;
}

export async function runWorkload(deps: WorkloadDeps): Promise<void> {
  for (const m of deps.plan) {
    const wait = m.atMs - deps.clock.now();
    if (wait > 0) await deps.clock.sleep(wait);
    const op = { op: 'mail_send' as const, tag: m.tag, to: m.to, type: m.type };
    const id = deps.idOf(m.to);
    if (id === null) {
      deps.log({ k: 'op', t: deps.clock.now(), op, ok: false, error: 'rejected:no_session' });
      continue;
    }
    const r = await deps.send(id, m.type, `${m.tag} from=external to=${m.to}`);
    const ok = r.code === 0;
    deps.log({ k: 'op', t: deps.clock.now(), op, ok, error: ok ? null : normaliseError(r.code, r.stderr, r.stdout) });
  }
}
