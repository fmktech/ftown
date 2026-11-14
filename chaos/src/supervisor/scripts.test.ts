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
  sleepTotal,
  stepCostMs,
} from './scripts.ts';

function maxTurnBusyMs(script: AgentScript): number {
  let inTurn = false;
  let busy = 0;
  let maxBusy = 0;
  for (const st of script.steps) {
    const cost = stepCostMs(st);
    if (st.do === 'hook' && st.event === 'UserPromptSubmit') {
      inTurn = true;
      busy = cost;
    } else if (st.do === 'hook' && st.event === 'Stop') {
      assert.ok(inTurn, `${script.role}: Stop without UserPromptSubmit`);
      busy += cost;
      if (busy > maxBusy) maxBusy = busy;
      inTurn = false;
      busy = 0;
    } else if (inTurn) {
      busy += cost;
    }
  }
  assert.ok(!inTurn, `${script.role}: unclosed turn`);
  return maxBusy;
}

function hasFaultWindowIdleSleep(script: AgentScript, role: Role, profile: RunProfile): boolean {
  const { faultWindowStartMs, faultWindowEndMs } = PROFILE[profile];
  const minIdle = IDLE_SLEEP_MIN_MS[profile];
  let inTurn = false;
  let t = MAX_START_OFFSET_MS[role] / 2;
  for (const st of script.steps) {
    if (st.do === 'hook' && st.event === 'UserPromptSubmit') inTurn = true;
    else if (st.do === 'hook' && st.event === 'Stop') inTurn = false;
    else if (!inTurn && st.do === 'sleep') {
      const overlap = Math.min(t + st.ms, faultWindowEndMs) - Math.max(t, faultWindowStartMs);
      if (overlap >= minIdle) return true;
    }
    t += stepCostMs(st);
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
        assert.deepEqual(s[role].steps.at(-1), { do: 'hook', event: 'Stop' });

        if (profile === 'short') {
          assert.ok(!s[role].steps.some((x) => x.do === 'status'), `short ${role} must not have status steps`);
        }

        const maxBusy = maxTurnBusyMs(s[role]);
        assert.ok(maxBusy <= BUSY_TURN_LIMIT_MS, `${profile} seed ${seed} ${role} busy=${maxBusy} > ${BUSY_TURN_LIMIT_MS}`);
        assert.ok(
          hasFaultWindowIdleSleep(s[role], role, profile),
          `${profile} seed ${seed} ${role} missing >=${IDLE_SLEEP_MIN_MS[profile]} ms idle sleep in fault window`,
        );

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
          if (s[role].steps[1]?.do === 'ask') early += 1;
        }
      }
      assert.equal(early, 1, `${profile} seed ${seed}: early asks`);
      assert.ok(asks >= 2 && asks <= 3, `${profile} seed ${seed}: ${asks} asks`);
    }
  }
});

test('bounds helpers reject violating scripts and accept valid ones', () => {
  const valid = buildScripts(1, 'soak', deriveRng).child1;
  assert.ok(maxTurnBusyMs(valid) <= BUSY_TURN_LIMIT_MS);
  assert.ok(hasFaultWindowIdleSleep(valid, 'child1', 'soak'));
  assert.ok(MAX_START_OFFSET_MS.child1 + estimatedDuration(valid) <= PROFILE.soak.workloadEndMs);

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
  assert.ok(maxTurnBusyMs(overBusy) > BUSY_TURN_LIMIT_MS);

  const noIdle: AgentScript = {
    role: 'child1',
    readMailOnNudge: true,
    answerRoutedQuestions: false,
    steps: [
      { do: 'hook', event: 'UserPromptSubmit' },
      { do: 'hook', event: 'Stop' },
      { do: 'sleep', ms: 1_000 },
    ],
  };
  assert.equal(hasFaultWindowIdleSleep(noIdle, 'child1', 'short'), false);

  const overEnd: AgentScript = {
    role: 'root',
    readMailOnNudge: true,
    answerRoutedQuestions: true,
    steps: [
      { do: 'sleep', ms: PROFILE.short.workloadEndMs },
      { do: 'hook', event: 'UserPromptSubmit' },
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
      assert.ok(sleepTotal(s.root) > 0);
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
