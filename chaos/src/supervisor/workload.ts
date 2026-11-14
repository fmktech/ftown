// External mail workload: every 5–15 s until the fault window ends, one tagged mail from
// 'external' to a random role, sent through the real CLI on the unfaulted control path.
import { FAULT_WINDOW_END_MS, ROLES } from '../contract.ts';
import type { Clock, DeriveRng, MailType, Rec, Role } from '../contract.ts';
import { normaliseCliError } from '../fake-agent/parse.ts';

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

/** Fixed guest time of the first possible workload slot (the plan adds 5–15 s to it). */
export const WORKLOAD_START_MS = 15_000;

/**
 * Normalise a failed CLI call from its exit code and the fake agent's fixed reason tokens
 * (normaliseCliError): bridge_down | timeout | rejected:<token>. Never raw text.
 */
export function normaliseError(code: number, stderr: string, stdout = ''): OpError {
  const token = normaliseCliError(code, stdout, stderr);
  if (token === 'timeout') return 'timeout';
  if (token === 'bridge_offline' || token === 'bridge_unreachable') return 'bridge_down';
  return `rejected:${token.replace(/ /g, '_')}`;
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
  /** Checked before each send; true ends the loop (another loop failed). */
  stopped?: () => boolean;
}

export async function runWorkload(deps: WorkloadDeps): Promise<void> {
  for (const m of deps.plan) {
    const wait = m.atMs - deps.clock.now();
    if (wait > 0) await deps.clock.sleep(wait);
    if (deps.stopped?.()) return;
    const op = { op: 'mail_send' as const, tag: m.tag, to: m.to, type: m.type };
    // t is the instant the call starts, so cause precedes effect in the canonical order.
    const t = deps.clock.now();
    const id = deps.idOf(m.to);
    if (id === null) {
      deps.log({ k: 'op', t, op, ok: false, error: 'rejected:no_session' });
      continue;
    }
    const r = await deps.send(id, m.type, `${m.tag} from=external to=${m.to}`);
    const ok = r.code === 0;
    deps.log({ k: 'op', t, op, ok, error: ok ? null : normaliseError(r.code, r.stderr, r.stdout) });
  }
}
