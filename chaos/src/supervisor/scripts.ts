// Seed-derived fake-agent scripts, one per role. Pure: same seed => same scripts.
import { PROFILE, ROLES } from '../contract.ts';
import type { AgentScript, AgentStep, DeriveRng, MailType, Rng, Role, RunProfile } from '../contract.ts';

export type Scripts = Record<Role, AgentScript>;

/** Root's first sleep: the ids file must list every role before root's first mail (main.ts enforces it). */
/** Delay of the early ask after its child starts: covers creating the remaining children (~16 s in QEMU). */
export const EARLY_ASK_DELAY_MS = 25_000;

export const ROOT_FIRST_SLEEP_MS: readonly [number, number] = [45_000, 50_000];

/**
 * Conservative guest-time cost (ms) per step kind, measured from seed 1 short run1
 * (side-agents.jsonl): max observed, rounded up to the next second, plus 25%.
 * Re-measure and lower these once CLI call cost is optimised.
 * `status` has no isolated log event in side-agents.jsonl, so it uses the `mail_send`
 * figure until measured separately.
 */
export const STEP_COST_MS: Readonly<Record<AgentStep['do'], number>> = {
  hook: 3_750,
  mail_send: 26_250,
  status: 26_250,
  ask: 8_750,
  mail_read: 5_000,
  answer_routed: 26_250,
  sleep: 0,
  exit: 0,
};

/** Maximum estimated busy time (UserPromptSubmit .. Stop) allowed for a single turn. */
export const BUSY_TURN_LIMIT_MS = 45_000;

/** Per-profile turn/action counts, sized to the current STEP_COST_MS. */
export const ROOT_ORDINARY_MAILS: Record<RunProfile, readonly [number, number]> = {
  short: [1, 1],
  soak: [2, 4],
};

/** Per-profile in-loop action turn count for children (excludes bring-up and final result turn), sized to STEP_COST_MS. */
export const CHILD_ACTION_TURNS: Record<RunProfile, readonly [number, number]> = {
  short: [1, 1],
  soak: [1, 2],
};

/** Minimum required idle sleep inside the fault window, by profile. */
export const IDLE_SLEEP_MIN_MS: Record<RunProfile, number> = {
  short: 8_000,
  soak: 20_000,
};

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

export function stepCostMs(step: AgentStep): number {
  return step.do === 'sleep' ? step.ms : STEP_COST_MS[step.do];
}

function stepsSleepTotal(steps: readonly AgentStep[]): number {
  return steps.reduce((n, s) => n + (s.do === 'sleep' ? s.ms : 0), 0);
}

function stepsEstimatedMs(steps: readonly AgentStep[]): number {
  return steps.reduce((n, s) => n + stepCostMs(s), 0);
}

/** Sum of the script's sleeps: a lower bound on when its last step runs, relative to its start. */
export function sleepTotal(script: AgentScript): number {
  return stepsSleepTotal(script.steps);
}

/** Estimated guest duration (ms) of the script from start to final Stop, using STEP_COST_MS. */
export function estimatedDuration(script: AgentScript): number {
  return stepsEstimatedMs(script.steps);
}

/** Children start after root (they are created later), so this margin covers creation skew plus CLI time. */
export const IDLE_MARGIN_MS = 30_000;
/** Last tag of root's range (root's ordinary mails use 1000–1003). */
export const ROOT_IDLE_NUDGE_TAG = 1999;

/** Conservative upper bound on each role's start offset in guest ms since t0 (bring-up is ~45 s total). */
export const MAX_START_OFFSET_MS: Readonly<Record<Role, number>> = {
  root: 20_000,
  child1: 45_000,
  child2: 45_000,
  child3: 45_000,
};

/** Per-action sleep range for children, by profile (spreads actions across fault window within workloadEndMs). */
export const CHILD_ACTION_SLEEP_MS: Record<RunProfile, readonly [number, number]> = {
  short: [500, 1_200],
  soak: [3_000, 6_000],
};

function pushTurn(steps: AgentStep[], actions: readonly AgentStep[]): void {
  steps.push({ do: 'hook', event: 'UserPromptSubmit' }, ...actions, { do: 'hook', event: 'Stop' });
}

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

function rootScript(rng: Rng, profile: RunProfile): AgentScript {
  const nextMail = counter('root');
  // Children are created after root; under QEMU four creates take ~16 s, so root waits far longer.
  const bringUp: AgentStep[] = profile === 'soak' ? [{ do: 'status', state: 'working', headline: 'root working' }] : [];
  const steps: AgentStep[] = [sleep(rng, ROOT_FIRST_SLEEP_MS[0], ROOT_FIRST_SLEEP_MS[1])];
  pushTurn(steps, bringUp);

  // Hold until faultWindowStartMs (assuming half of MAX_START_OFFSET_MS.root), then idle inside fault window.
  const hold = Math.max(0, PROFILE[profile].faultWindowStartMs - MAX_START_OFFSET_MS.root / 2 - stepsEstimatedMs(steps));
  const idle = rng.int(IDLE_SLEEP_MIN_MS[profile], IDLE_SLEEP_MIN_MS[profile] + (profile === 'short' ? 500 : 5_000));
  steps.push({ do: 'sleep', ms: hold + idle });

  const [minMails, maxMails] = ROOT_ORDINARY_MAILS[profile];
  const mails = rng.int(minMails, maxMails);
  const mailSleep: readonly [number, number] = profile === 'short' ? [500, 1_000] : [3_000, 6_000];
  for (let i = 0; i < mails; i++) {
    const to = rng.pick(CHILDREN);
    pushTurn(steps, [{ do: 'mail_send', to, type: rng.pick(ROOT_MAIL_TYPES), body: mailBody(nextMail(), 'root', to) }]);
    if (i < mails - 1) steps.push(sleep(rng, mailSleep[0], mailSleep[1]));
  }
  return { role: 'root', steps, readMailOnNudge: true, answerRoutedQuestions: true };
}

function childScript(role: Role, rng: Rng, early: boolean, asks: number, profile: RunProfile): AgentScript {
  const nextMail = counter(role);
  const nextAsk = counter(role);
  const ask = (): AgentStep => {
    const title = `CHAOS-Q-${nextAsk()} from=${role}`;
    return { do: 'ask', title, message: title, options: ['yes', 'no'] };
  };
  const steps: AgentStep[] = [];
  // The early ask goes out once every session exists (ids.json complete) and well before the
  // fault window opens at faultWindowStartMs, so root can answer it unfaulted.
  if (early) steps.push({ do: 'sleep', ms: EARLY_ASK_DELAY_MS }, ask());
  steps.push(sleep(rng, 2_000, 6_000));
  const bringUp: AgentStep[] = profile === 'soak' ? [{ do: 'status', state: 'working', headline: `${role} working` }] : [];
  pushTurn(steps, bringUp);

  if (profile === 'short') {
    // Hold so Turn 1's mail_send/ask begins at >= faultWindowStartMs under MAX/2 start offset.
    const hold = Math.max(
      0,
      PROFILE.short.faultWindowStartMs - STEP_COST_MS.hook - MAX_START_OFFSET_MS[role] / 2 - stepsEstimatedMs(steps),
    );
    if (hold > 0) steps.push({ do: 'sleep', ms: hold });
    // Turn 1: one ask (if assigned a later ask) or one mail_send; no status in short.
    const turn1Action: AgentStep = asks > 0
      ? ask()
      : { do: 'mail_send', to: 'parent', type: rng.pick(CHILD_MAIL_TYPES), body: mailBody(nextMail(), role, 'root') };
    pushTurn(steps, [turn1Action]);
    // Idle sleep >= 8 s inside the fault window before Turn 2 (final result mail).
    steps.push({ do: 'sleep', ms: IDLE_SLEEP_MIN_MS.short });
    pushTurn(steps, [{ do: 'mail_send', to: 'parent', type: 'result', body: mailBody(nextMail(), role, 'root') }]);
    return { role, steps, readMailOnNudge: true, answerRoutedQuestions: false };
  }

  // Soak profile: hold until faultWindowStartMs (at MAX/2), then >= 20 s idle sleep inside fault window.
  const hold = Math.max(0, PROFILE.soak.faultWindowStartMs - MAX_START_OFFSET_MS[role] / 2 - stepsEstimatedMs(steps));
  const idle = rng.int(IDLE_SLEEP_MIN_MS.soak, IDLE_SLEEP_MIN_MS.soak + 2_000);
  steps.push({ do: 'sleep', ms: hold + idle });

  const turns = rng.int(...CHILD_ACTION_TURNS.soak);
  const askAt = new Set<number>();
  while (askAt.size < Math.min(asks, turns)) askAt.add(rng.int(0, turns - 1));
  let sentInLoop = 0;
  for (let i = 0; i < turns; i++) {
    const turnActions: AgentStep[] = [];
    if (askAt.has(i)) turnActions.push(ask());
    switch (rng.int(0, 2)) {
      case 0:
        if (turnActions.length === 0) {
          turnActions.push({ do: 'hook', event: 'PreToolUse' }, { do: 'hook', event: 'PostToolUse' });
        } else {
          // Pair ask (8.75s) with PreToolUse+PostToolUse (7.5s) -> <= 23.75s busy.
          turnActions.push({ do: 'hook', event: 'PreToolUse' }, { do: 'hook', event: 'PostToolUse' });
        }
        break;
      case 1:
        turnActions.push({ do: 'mail_send', to: 'parent', type: rng.pick(CHILD_MAIL_TYPES), body: mailBody(nextMail(), role, 'root') });
        sentInLoop++;
        break;
      case 2:
        if (turnActions.length === 0 || STEP_COST_MS.hook * 2 + STEP_COST_MS.ask + STEP_COST_MS.status <= BUSY_TURN_LIMIT_MS) {
          turnActions.push({ do: 'status', state: rng.pick(['working', 'blocked'] as const), headline: `${role} step ${i + 1}` });
        }
        break;
    }
    pushTurn(steps, turnActions);
    steps.push(sleep(rng, ...CHILD_ACTION_SLEEP_MS.soak));
  }
  if (sentInLoop === 0 && asks === 0) {
    pushTurn(steps, [{ do: 'mail_send', to: 'parent', type: 'message', body: mailBody(nextMail(), role, 'root') }]);
    steps.push(sleep(rng, ...CHILD_ACTION_SLEEP_MS.soak));
  }
  pushTurn(steps, [{ do: 'mail_send', to: 'parent', type: 'result', body: mailBody(nextMail(), role, 'root') }]);
  return { role, steps, readMailOnNudge: true, answerRoutedQuestions: false };
}

export function buildScripts(seed: number, profile: RunProfile, deriveRng: DeriveRng): Scripts {
  const rootRng = deriveRng(seed, 'agent.root');
  const root = rootScript(rootRng, profile);
  const asks = chooseAsks(rootRng);
  const out = { root } as Scripts;
  for (const role of CHILDREN) out[role] = childScript(role, deriveRng(seed, `agent.${role}`), asks.early === role, asks.later[role], profile);
  // Guaranteed nudge: once every child has finished its script (and sent Stop, so it is idle),
  // root sends one waking 'task' mail to a child, then goes idle itself.
  const childEnd = Math.max(...CHILDREN.map((r) => estimatedDuration(out[r])));
  const to = rootRng.pick(CHILDREN);
  root.steps.push({ do: 'sleep', ms: Math.max(1_000, childEnd + IDLE_MARGIN_MS - estimatedDuration(root)) });
  pushTurn(root.steps, [{ do: 'mail_send', to, type: 'task', body: mailBody(ROOT_IDLE_NUDGE_TAG, 'root', to) }]);
  return out;
}
