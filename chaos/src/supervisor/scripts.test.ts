import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRng } from '../core/rng.ts';
import { ROLES } from '../contract.ts';
import { buildScripts } from './scripts.ts';

test('scripts are a pure function of the seed', () => {
  assert.deepEqual(buildScripts(7, deriveRng), buildScripts(7, deriveRng));
  assert.notDeepEqual(buildScripts(7, deriveRng), buildScripts(8, deriveRng));
});

test('every seed: 1–2 asks across children, root answers, both mail directions, children never exit', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const s = buildScripts(seed, deriveRng);
    assert.equal(s.root.readMailOnNudge, true);
    assert.equal(s.root.answerRoutedQuestions, true);
    assert.ok(s.root.steps.some((x) => x.do === 'mail_send' && x.to !== 'root'));
    let asks = 0;
    for (const role of ROLES) {
      assert.equal(s[role].role, role);
      assert.ok(!s[role].steps.some((x) => x.do === 'exit'));
      for (const st of s[role].steps) if (st.do === 'sleep') assert.ok(st.ms >= 1_000 && st.ms <= 20_000);
      if (role === 'root') continue;
      assert.equal(s[role].answerRoutedQuestions, false);
      assert.ok(s[role].steps.some((x) => x.do === 'mail_send' && x.to === 'parent'));
      assert.deepEqual(s[role].steps.at(-1), { do: 'hook', event: 'Stop' });
      asks += s[role].steps.filter((x) => x.do === 'ask').length;
    }
    assert.ok(asks >= 1 && asks <= 2, `seed ${seed}: ${asks} asks`);
  }
});

test('tags are allocated per role from 1000 * (index + 1) and are unique', () => {
  const s = buildScripts(3, deriveRng);
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
