import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRng } from '../core/rng.ts';
import { PROFILE, ROLES, RUN_PROFILES } from '../contract.ts';
import { buildScripts, IDLE_MARGIN_MS, sleepTotal } from './scripts.ts';

test('scripts are a pure function of the seed and profile', () => {
  for (const profile of RUN_PROFILES) {
    assert.deepEqual(buildScripts(7, profile, deriveRng), buildScripts(7, profile, deriveRng));
    assert.notDeepEqual(buildScripts(7, profile, deriveRng), buildScripts(8, profile, deriveRng));
  }
  assert.notDeepEqual(buildScripts(7, 'short', deriveRng), buildScripts(7, 'soak', deriveRng));
});

test('every seed and profile: early ask, 1–2 later asks, root answers, both mail directions, within workloadEndMs and overlapping fault window', () => {
  for (const profile of RUN_PROFILES) {
    const { faultWindowStartMs, workloadEndMs } = PROFILE[profile];
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
        assert.ok(sleepTotal(s[role]) <= workloadEndMs, `${profile} seed ${seed} ${role} sleepTotal=${sleepTotal(s[role])} > ${workloadEndMs}`);
        if (role !== 'root') for (const st of s[role].steps.slice(2)) if (st.do === 'sleep') assert.ok(st.ms >= 1_000 && st.ms <= 20_000);
        if (role === 'root') continue;
        assert.equal(s[role].answerRoutedQuestions, false);
        assert.ok(s[role].steps.some((x) => x.do === 'mail_send' && x.to === 'parent'));
        assert.deepEqual(s[role].steps.at(-1), { do: 'hook', event: 'Stop' });
        asks += s[role].steps.filter((x) => x.do === 'ask').length;
        if (s[role].steps[1]?.do === 'ask') early += 1;
      }
      assert.equal(early, 1, `${profile} seed ${seed}: early asks`);
      assert.ok(asks >= 2 && asks <= 3, `${profile} seed ${seed}: ${asks} asks`);
      if (profile === 'short') assert.ok(sleepTotal(s.root) >= faultWindowStartMs, `${profile} seed ${seed}: root ends before fault window`);
    }
  }
});

test('every seed: root sends a waking mail to a child after all children have gone idle', () => {
  for (const profile of RUN_PROFILES) {
    for (let seed = 1; seed <= 200; seed++) {
      const s = buildScripts(seed, profile, deriveRng);
      const steps = s.root.steps;
      const i = steps.length - 2;
      const last = steps[i];
      assert.ok(last.do === 'mail_send' && last.type === 'task' && last.to !== 'root' && last.to !== 'parent');
      assert.deepEqual(steps.at(-1), { do: 'hook', event: 'Stop' });
      const sentAt = steps.slice(0, i).reduce((n, x) => n + (x.do === 'sleep' ? x.ms : 0), 0);
      const childEnd = Math.max(sleepTotal(s.child1), sleepTotal(s.child2), sleepTotal(s.child3));
      assert.ok(sentAt >= childEnd + IDLE_MARGIN_MS, `${profile} seed ${seed}`);
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
