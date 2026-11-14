import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRng } from '../core/rng.ts';
import { PROFILE, ROLES, RUN_PROFILES } from '../contract.ts';
import type { AgentScript, Role, RunProfile } from '../contract.ts';
import {
  buildScripts,
  BUSY_TURN_LIMIT_MS,
  estimatedDuration,
  IDLE_MARGIN_MS,
  IDLE_SLEEP_MIN_MS,
  MAX_START_OFFSET_MS,
  stepCostMs,
} from './scripts.ts';

function validateTurns(script: AgentScript): number {
  assert.deepEqual(script.steps.at(-1), { do: 'hook', event: 'Stop' }, `${script.role}: last step must be Stop`);
  let inTurn = false;
  let actionsInTurn = 0;
  let busy = 0;
  let maxBusy = 0;
  for (const st of script.steps) {
    const cost = stepCostMs(st);
    if (st.do === 'hook' && st.event === 'UserPromptSubmit') {
      assert.ok(!inTurn, `${script.role}: UserPromptSubmit while already in a turn`);
      inTurn = true;
      actionsInTurn = 0;
      busy = cost;
    } else if (st.do === 'hook' && st.event === 'Stop') {
      assert.ok(inTurn, `${script.role}: Stop without UserPromptSubmit`);
      assert.ok(actionsInTurn >= 1, `${script.role}: empty turn (no actions between UserPromptSubmit and Stop)`);
      busy += cost;
      if (busy > maxBusy) maxBusy = busy;
      inTurn = false;
      busy = 0;
    } else if (inTurn) {
      actionsInTurn++;
      busy += cost;
    } else {
      assert.equal(st.do, 'sleep', `${script.role}: non-sleep step '${st.do}' outside a turn`);
    }
  }
  assert.ok(!inTurn, `${script.role}: unclosed turn`);
  return maxBusy;
}

function hasFaultWindowIdleSleep(
  script: AgentScript,
  role: Role,
  profile: RunProfile,
  startOffsetMs: number,
  zeroCliCost = false,
): boolean {
  const { faultWindowStartMs, faultWindowEndMs } = PROFILE[profile];
  const minIdle = IDLE_SLEEP_MIN_MS[profile];
  let inTurn = false;
  let t = startOffsetMs;
  for (const st of script.steps) {
    if (st.do === 'hook' && st.event === 'UserPromptSubmit') inTurn = true;
    else if (st.do === 'hook' && st.event === 'Stop') inTurn = false;
    else if (!inTurn && st.do === 'sleep') {
      const overlap = Math.min(t + st.ms, faultWindowEndMs) - Math.max(t, faultWindowStartMs);
      if (overlap >= minIdle) return true;
    }
    t += st.do === 'sleep' ? st.ms : (zeroCliCost ? 0 : stepCostMs(st));
  }
  return false;
}

test('scripts are a pure function of the seed and profile', () => {
  for (const profile of RUN_PROFILES) {
    assert.deepEqual(buildScripts(7, profile, deriveRng), buildScripts(7, profile, deriveRng));
    assert.notDeepEqual(buildScripts(7, profile, deriveRng), buildScripts(8, profile, deriveRng));
  }
  assert.notDeepEqual(buildScripts(7, 'short', deriveRng), buildScripts(7, 'soak', deriveRng));
});

test('every seed and profile: turns, busy cap, idle sleep, asks, overlap, and workloadEndMs', () => {
  for (const profile of RUN_PROFILES) {
    const { faultWindowStartMs, faultWindowEndMs, workloadEndMs } = PROFILE[profile];
    for (let seed = 1; seed <= 200; seed++) {
      const s = buildScripts(seed, profile, deriveRng);
      assert.equal(s.root.readMailOnNudge, true);
      assert.equal(s.root.answerRoutedQuestions, true);
      assert.ok(s.root.steps.some((x) => x.do === 'mail_send' && x.to !== 'root'));
      let asks = 0;
      let early = 0;
      for (const role of ROLES) {
        assert.equal(s[role].role, role);
        assert.ok(!s[role].steps.some((x) => x.do === 'exit'));

        if (profile === 'short') {
          assert.ok(!s[role].steps.some((x) => x.do === 'status'), `short ${role} must not have status steps`);
        }

        const maxBusy = validateTurns(s[role]);
        assert.ok(maxBusy <= BUSY_TURN_LIMIT_MS, `${profile} seed ${seed} ${role} busy=${maxBusy} > ${BUSY_TURN_LIMIT_MS}`);

        if (profile === 'soak') {
          assert.ok(
            hasFaultWindowIdleSleep(s[role], role, profile, 0, true),
            `soak seed ${seed} ${role} missing >=${IDLE_SLEEP_MIN_MS[profile]} ms idle sleep at (0, 0)`,
          );
          assert.ok(
            hasFaultWindowIdleSleep(s[role], role, profile, MAX_START_OFFSET_MS[role], false),
            `soak seed ${seed} ${role} missing >=${IDLE_SLEEP_MIN_MS[profile]} ms idle sleep at (MAX, STEP_COST_MS)`,
          );
        } else {
          // Short keeps the 170_000 end bound, so idle sleep is checked at MAX/2 with STEP_COST_MS.
          assert.ok(
            hasFaultWindowIdleSleep(s[role], role, profile, MAX_START_OFFSET_MS[role] / 2, false),
            `short seed ${seed} ${role} missing >=${IDLE_SLEEP_MIN_MS[profile]} ms idle sleep at MAX/2`,
          );
        }

        const endAt = MAX_START_OFFSET_MS[role] + estimatedDuration(s[role]);
        assert.ok(endAt <= workloadEndMs, `${profile} seed ${seed} ${role} endAt=${endAt} > ${workloadEndMs}`);

        const midOffset = MAX_START_OFFSET_MS[role] / 2;
        let cum = 0;
        const beginTimes: Array<{ do: string; t: number }> = [];
        for (const st of s[role].steps) {
          beginTimes.push({ do: st.do, t: midOffset + cum });
          cum += stepCostMs(st);
        }
        const inFaultWin = (t: number) => t >= faultWindowStartMs && t <= faultWindowEndMs;
        const inWorkloadWin = (t: number) => t >= faultWindowStartMs && t <= workloadEndMs;
        if (role === 'root') {
          const rootMails = beginTimes.filter((x) => x.do === 'mail_send');
          const inFW = rootMails.filter((x) => inFaultWin(x.t)).length;
          const req = profile === 'short' ? 1 : 2;
          assert.ok(inFW >= req, `${profile} seed ${seed} root mails in fault window: ${inFW} < ${req}`);
        } else {
          const ma = beginTimes.filter((x) => x.do === 'mail_send' || x.do === 'ask');
          const inFW = ma.filter((x) => inFaultWin(x.t)).length;
          const inWW = ma.filter((x) => inWorkloadWin(x.t)).length;
          if (profile === 'short') {
            assert.ok(inWW >= 2 && inFW >= 1, `${profile} seed ${seed} ${role}: inWW=${inWW} inFW=${inFW}`);
          } else {
            assert.ok(inFW >= 2 && inFW * 2 >= ma.length, `${profile} seed ${seed} ${role}: ${inFW}/${ma.length} in fault window`);
          }
          assert.equal(s[role].answerRoutedQuestions, false);
          assert.ok(s[role].steps.some((x) => x.do === 'mail_send' && x.to === 'parent'));
          asks += s[role].steps.filter((x) => x.do === 'ask').length;
          if (beginTimes.some((x) => x.do === 'ask' && x.t < faultWindowStartMs)) early += 1;
        }
      }
      assert.equal(early, 1, `${profile} seed ${seed}: early asks`);
      assert.ok(asks >= 2 && asks <= 3, `${profile} seed ${seed}: ${asks} asks`);
    }
  }
});

test('turn and bound helpers reject violating scripts and accept valid ones', () => {
  const valid = buildScripts(1, 'soak', deriveRng).child1;
  assert.ok(validateTurns(valid) <= BUSY_TURN_LIMIT_MS);
  assert.ok(hasFaultWindowIdleSleep(valid, 'child1', 'soak', 0, true));
  assert.ok(hasFaultWindowIdleSleep(valid, 'child1', 'soak', MAX_START_OFFSET_MS.child1, false));
  assert.ok(MAX_START_OFFSET_MS.child1 + estimatedDuration(valid) <= PROFILE.soak.workloadEndMs);

  // Out-of-turn action
  assert.throws(() => validateTurns({
    role: 'child1',
    readMailOnNudge: true,
    answerRoutedQuestions: false,
    steps: [
      { do: 'mail_send', to: 'parent', type: 'message', body: 'CHAOS-M-2000 from=child1 to=root' },
      { do: 'hook', event: 'UserPromptSubmit' },
      { do: 'hook', event: 'Stop' },
    ],
  }), /outside a turn/);

  // Double UserPromptSubmit
  assert.throws(() => validateTurns({
    role: 'child1',
    readMailOnNudge: true,
    answerRoutedQuestions: false,
    steps: [
      { do: 'hook', event: 'UserPromptSubmit' },
      { do: 'hook', event: 'UserPromptSubmit' },
      { do: 'hook', event: 'Stop' },
    ],
  }), /already in a turn/);

  // Empty turn
  assert.throws(() => validateTurns({
    role: 'child1',
    readMailOnNudge: true,
    answerRoutedQuestions: false,
    steps: [
      { do: 'hook', event: 'UserPromptSubmit' },
      { do: 'hook', event: 'Stop' },
    ],
  }), /empty turn/);

  const overBusy: AgentScript = {
    role: 'child1',
    readMailOnNudge: true,
    answerRoutedQuestions: false,
    steps: [
      { do: 'hook', event: 'UserPromptSubmit' },
      { do: 'mail_send', to: 'parent', type: 'message', body: 'CHAOS-M-2000 from=child1 to=root' },
      { do: 'mail_send', to: 'parent', type: 'result', body: 'CHAOS-M-2001 from=child1 to=root' },
      { do: 'hook', event: 'Stop' },
    ],
  };
  assert.ok(validateTurns(overBusy) > BUSY_TURN_LIMIT_MS);

  const noIdle: AgentScript = {
    role: 'child1',
    readMailOnNudge: true,
    answerRoutedQuestions: false,
    steps: [
      { do: 'hook', event: 'UserPromptSubmit' },
      { do: 'mail_send', to: 'parent', type: 'result', body: 'CHAOS-M-2000 from=child1 to=root' },
      { do: 'hook', event: 'Stop' },
      { do: 'sleep', ms: 1_000 },
    ],
  };
  assert.equal(hasFaultWindowIdleSleep(noIdle, 'child1', 'short', 0, true), false);
  assert.equal(hasFaultWindowIdleSleep(noIdle, 'child1', 'short', MAX_START_OFFSET_MS.child1, false), false);

  const overEnd: AgentScript = {
    role: 'root',
    readMailOnNudge: true,
    answerRoutedQuestions: true,
    steps: [
      { do: 'sleep', ms: PROFILE.short.workloadEndMs },
      { do: 'hook', event: 'UserPromptSubmit' },
      { do: 'mail_send', to: 'child1', type: 'task', body: 'CHAOS-M-1999 from=root to=child1' },
      { do: 'hook', event: 'Stop' },
    ],
  };
  assert.ok(MAX_START_OFFSET_MS.root + estimatedDuration(overEnd) > PROFILE.short.workloadEndMs);
});

test('every profile satisfies the contract quiesce sizing rule', () => {
  for (const profile of RUN_PROFILES) {
    const { faultWindowEndMs, quiesceMs, workloadEndMs } = PROFILE[profile];
    assert.ok(
      faultWindowEndMs + quiesceMs >= Math.max(workloadEndMs, faultWindowEndMs) + 80_000,
      `${profile}: ${faultWindowEndMs + quiesceMs} < ${Math.max(workloadEndMs, faultWindowEndMs) + 80_000}`,
    );
  }
});

test('every seed: root sends a waking mail (after >=8s idle in short, after all children idle in soak)', () => {
  for (const profile of RUN_PROFILES) {
    for (let seed = 1; seed <= 200; seed++) {
      const s = buildScripts(seed, profile, deriveRng);
      const steps = s.root.steps;
      const i = steps.length - 2;
      const last = steps[i];
      assert.ok(last.do === 'mail_send' && last.type === 'task' && last.to !== 'root' && last.to !== 'parent');
      assert.deepEqual(steps.at(-1), { do: 'hook', event: 'Stop' });
      const sentAt = steps.slice(0, i).reduce((n, x) => n + stepCostMs(x), 0);
      if (profile === 'short') {
        // Short decouples tag-1999 from childEnd: turn-structured children are idle between turns
        // and the contract's 80 s tail + 60 s nudge re-check cover a busy recipient.
        const idleBefore = steps[i - 2];
        assert.ok(idleBefore?.do === 'sleep' && idleBefore.ms >= IDLE_SLEEP_MIN_MS.short);
      } else {
        // Soak keeps the strict childEnd + IDLE_MARGIN_MS coupling.
        const childEnd = Math.max(estimatedDuration(s.child1), estimatedDuration(s.child2), estimatedDuration(s.child3));
        assert.ok(sentAt >= childEnd + IDLE_MARGIN_MS, `${profile} seed ${seed}: sentAt=${sentAt} < ${childEnd + IDLE_MARGIN_MS}`);
      }
    }
  }
});

test('tags are allocated per role from 1000 * (index + 1) and are unique', () => {
  const s = buildScripts(3, 'short', deriveRng);
  const tags: string[] = [];
  ROLES.forEach((role, i) => {
    for (const st of s[role].steps) {
      if (st.do === 'mail_send') {
        const n = Number(/^CHAOS-M-(\d+) from=(\w+) to=(\w+)$/.exec(st.body)?.[1]);
        assert.ok(n >= 1000 * (i + 1) && n < 1000 * (i + 2));
        tags.push(st.body.split(' ')[0]);
      }
      if (st.do === 'ask') {
        assert.match(st.title, new RegExp(`^CHAOS-Q-\\d+ from=${role}$`));
        assert.equal(st.message, st.title);
        assert.deepEqual(st.options, ['yes', 'no']);
      }
    }
  });
  assert.equal(new Set(tags).size, tags.length);
});
