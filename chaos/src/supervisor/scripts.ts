// Seed-derived fake-agent scripts, one per role. Pure: same seed => same scripts.
import { ROLES } from '../contract.ts';
import type { AgentScript, AgentStep, DeriveRng, MailType, Rng, Role } from '../contract.ts';

export type Scripts = Record<Role, AgentScript>;

const CHILDREN: readonly Role[] = ['child1', 'child2', 'child3'];
const CHILD_MAIL_TYPES: readonly MailType[] = ['task', 'result', 'message', 'fyi'];
const ROOT_MAIL_TYPES: readonly MailType[] = ['task', 'message', 'fyi'];

/** Tag counters: role allocates from 1000 * (index of role in ROLES + 1). */
function counter(role: Role): () => number {
  let n = 1000 * (ROLES.indexOf(role) + 1);
  return () => n++;
}

const mailBody = (n: number, from: Role, to: Role): string => `CHAOS-M-${n} from=${from} to=${to}`;
const sleep = (rng: Rng, lo: number, hi: number): AgentStep => ({ do: 'sleep', ms: rng.int(lo, hi) });

/**
 * Ask plan, drawn from the root's stream: one child asks first thing (before the fault window
 * opens, so a fault can never remove every ask) plus 1–2 later asks by seed-chosen children.
 */
function chooseAsks(rng: Rng): { early: Role; later: Record<Role, number> } {
  const early = rng.pick(CHILDREN);
  const later: Record<Role, number> = { root: 0, child1: 0, child2: 0, child3: 0 };
  const count = rng.int(1, 2);
  for (let i = 0; i < count; i++) later[rng.pick(CHILDREN)] += 1;
  return { early, later };
}

function rootScript(rng: Rng): AgentScript {
  const nextMail = counter('root');
  // Children are created after root; the ids file is complete well within 15 s.
  const steps: AgentStep[] = [sleep(rng, 15_000, 20_000), { do: 'hook', event: 'UserPromptSubmit' }, { do: 'status', state: 'working', headline: 'root working' }];
  const mails = rng.int(2, 4);
  for (let i = 0; i < mails; i++) {
    const to = rng.pick(CHILDREN);
    steps.push({ do: 'mail_send', to, type: rng.pick(ROOT_MAIL_TYPES), body: mailBody(nextMail(), 'root', to) });
    steps.push(sleep(rng, 1_000, 10_000));
  }
  steps.push({ do: 'hook', event: 'Stop' });
  return { role: 'root', steps, readMailOnNudge: true, answerRoutedQuestions: true };
}

function childScript(role: Role, rng: Rng, early: boolean, asks: number): AgentScript {
  const nextMail = counter(role);
  const nextAsk = counter(role);
  const ask = (): AgentStep => {
    const title = `CHAOS-Q-${nextAsk()} from=${role}`;
    return { do: 'ask', title, message: title, options: ['yes', 'no'] };
  };
  const steps: AgentStep[] = [];
  if (early) steps.push(ask());
  steps.push(sleep(rng, 2_000, 6_000), { do: 'hook', event: 'UserPromptSubmit' }, { do: 'status', state: 'working', headline: `${role} working` });
  const actions = rng.int(3, 6);
  const askAt = new Set<number>();
  while (askAt.size < asks) askAt.add(rng.int(0, actions - 1));
  for (let i = 0; i < actions; i++) {
    if (askAt.has(i)) steps.push(ask());
    switch (rng.int(0, 3)) {
      case 0:
        steps.push({ do: 'hook', event: 'PreToolUse' }, { do: 'hook', event: 'PostToolUse' });
        break;
      case 1:
        steps.push({ do: 'mail_send', to: 'parent', type: rng.pick(CHILD_MAIL_TYPES), body: mailBody(nextMail(), role, 'root') });
        break;
      case 2:
        steps.push({ do: 'status', state: rng.pick(['working', 'blocked'] as const), headline: `${role} step ${i + 1}` });
        break;
      default:
        break;
    }
    steps.push(sleep(rng, 1_000, 20_000));
  }
  // Always at least one child -> parent mail, then go idle so mail to this child nudges it.
  steps.push({ do: 'mail_send', to: 'parent', type: 'result', body: mailBody(nextMail(), role, 'root') });
  steps.push({ do: 'hook', event: 'Stop' });
  return { role, steps, readMailOnNudge: true, answerRoutedQuestions: false };
}

export function buildScripts(seed: number, deriveRng: DeriveRng): Scripts {
  const rootRng = deriveRng(seed, 'agent.root');
  const root = rootScript(rootRng);
  const asks = chooseAsks(rootRng);
  const out = { root } as Scripts;
  for (const role of CHILDREN) out[role] = childScript(role, deriveRng(seed, `agent.${role}`), asks.early === role, asks.later[role]);
  return out;
}
