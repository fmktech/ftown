import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  askTagOf,
  parseAttentionAnswerMail,
  parseChaosMail,
  parseEscalationMail,
  parseMailRead,
  parseNudge,
  parseWaitAnswer,
  parseWaitEventId,
} from './parse.ts';

test('nudge: format from bridge/src/mail-delivery.ts formatNudgeText', () => {
  assert.deepEqual(parseNudge('[ftown] 1 new mail (1 message) — run: ftown harness mail read'), { n: 1 });
  assert.deepEqual(parseNudge('[ftown] 3 new mail (1 task, 2 message) — run: ftown harness mail read | digest text'), { n: 3 });
  assert.deepEqual(parseNudge('\u001b[200~[ftown] 2 new mail (2 message) — run: ftown harness mail read\u001b[201~\r'), { n: 2 });
});

test('nudge: other lines are not nudges', () => {
  assert.equal(parseNudge('hello'), null);
  assert.equal(parseNudge('[ftown] no new mail'), null);
  assert.equal(parseNudge('x [ftown] 1 new mail ('), null);
});

test('mail read JSON: { sessionId, messages } as printed by harness mail read --json', () => {
  const out = JSON.stringify({
    sessionId: 's1',
    messages: [
      { id: 'a-1', ts: '2026-01-01T00:00:00.000Z', from: 'sid', fromName: 'root', to: 's1', type: 'task', body: 'CHAOS-M-1 from=root to=child1' },
      { id: 'a-2', from: 'external', to: 's1', type: 'bogus', body: 'plain' },
    ],
  }, null, 2);
  const mails = parseMailRead(out);
  assert.equal(mails?.length, 2);
  assert.equal(mails?.[0].type, 'task');
  assert.equal(mails?.[1].type, 'message');
  assert.equal(parseMailRead('(no mail)'), null);
  assert.equal(parseMailRead('{"sessionId":"s"}'), null);
  assert.deepEqual(parseMailRead('{"sessionId":"s","messages":[]}'), []);
});

test('chaos mail tag and sender role', () => {
  assert.deepEqual(parseChaosMail('CHAOS-M-12 from=root to=child1'), { tag: 'CHAOS-M-12', fromRole: 'root' });
  assert.deepEqual(parseChaosMail('CHAOS-M-1000 from=external to=child2 extra'), { tag: 'CHAOS-M-1000', fromRole: 'external' });
  assert.deepEqual(parseChaosMail('CHAOS-M-7 from=nobody to=root'), { tag: 'CHAOS-M-7', fromRole: 'unknown' });
  assert.deepEqual(parseChaosMail('CHAOS-M-7 to=root'), { tag: 'CHAOS-M-7', fromRole: 'unknown' });
  assert.equal(parseChaosMail('hello CHAOS-M-7'), null);
  assert.equal(parseChaosMail('CHAOS-M-x from=root'), null);
});

test('escalation mail: header from bridge/src/coordination/attention-routing.ts formatParentQuestionMail', () => {
  const body =
    '[ftown question id=evt-9 from=child1 (c-abc_1)] CHAOS-Q-2001 from=child1\n' +
    'CHAOS-Q-2001 from=child1\n' +
    'Options: 1) yes 2) no\n' +
    'Answer: ftown attention answer c-abc_1 evt-9 --option <n> | --text "<reply>"\n' +
    'Escalate to the human: ftown attention escalate c-abc_1 evt-9 --note "<context>"';
  assert.deepEqual(parseEscalationMail(body), {
    eventId: 'evt-9',
    childName: 'child1',
    childId: 'c-abc_1',
    title: 'CHAOS-Q-2001 from=child1',
    askTag: 'CHAOS-Q-2001',
  });
  // Pinned by bridge/src/local-api-server.test.ts:1524
  const pinned = parseEscalationMail('[ftown question id=e1 from=Worker A (child-a)] Pick DB\nmsg');
  assert.equal(pinned?.childId, 'child-a');
  assert.equal(pinned?.askTag, null);
  assert.equal(parseEscalationMail('CHAOS-M-1 from=root to=child1'), null);
});

test('attention answer mail: bridge/src/attention-prompt.ts formatAttentionAnswerMail', () => {
  const body = '[ftown attention answer id=evt-3]\nRe: CHAOS-Q-1001 from=root\n\nQ: CHAOS-Q-1001 from=root\nA: yes';
  assert.deepEqual(parseAttentionAnswerMail(body), {
    eventId: 'evt-3',
    title: 'CHAOS-Q-1001 from=root',
    askTag: 'CHAOS-Q-1001',
    answer: 'yes',
  });
  assert.equal(parseAttentionAnswerMail('[ftown question id=e from=a (b)] t'), null);
  assert.equal(parseAttentionAnswerMail('[ftown attention answer id=evt-4]\n\nQ: x\nA: no')?.answer, 'no');
});

test('attention --wait output: stderr event id and stdout answer (bridge/src/sessions-commands.ts)', () => {
  assert.equal(parseWaitEventId('Waiting for an answer (attention evt-1)...\n'), 'evt-1');
  assert.equal(parseWaitEventId('Event id: evt-2. Check later: ftown sessions attention-status evt-2 --wait'), 'evt-2');
  assert.equal(parseWaitEventId('Error: bridge down'), null);
  assert.equal(parseWaitAnswer('Q: Which?\nA: Beta\n'), 'Beta');
  assert.equal(parseWaitAnswer(''), null);
});

test('ask tag', () => {
  assert.equal(askTagOf('CHAOS-Q-5 from=root'), 'CHAOS-Q-5');
  assert.equal(askTagOf('Pick DB'), null);
});

test('nudge: real line with the bridge sender prefix (mail-delivery.ts:455-456)', () => {
  const real = '[ftown msg from ftown-mail] [ftown] 6 new mail (2 task, 1 escalation, 2 result, 1 message) — run: ftown harness mail read';
  assert.deepEqual(parseNudge(real), { n: 6 });
  assert.deepEqual(parseNudge('[ftown msg from chaos-plan] [ftown] 2 new mail (2 message) — run: ftown harness mail read'), { n: 2 });
  assert.deepEqual(parseNudge('[ftown msg from ftown-mail] [ftown] 1 new mail (1 task) — run: ftown harness mail read'), { n: 1 });
  assert.deepEqual(parseNudge('[ftown msg from ftown-mail] [ftown] 1 new mail (1 task) — run: ftown harness mail read | digest: hello'), { n: 1 });
  assert.deepEqual(parseNudge(`\u001b[200~${real}\u001b[201~\r`), { n: 6 });
  assert.deepEqual(parseNudge(`: '${real}'`), { n: 6 });
});

test('nudge: quoted or malformed prefixed text is rejected', () => {
  assert.equal(parseNudge('please check [ftown msg from ftown-mail] [ftown] 1 new mail (1 task)'), null);
  assert.equal(parseNudge('[ftown msg from ftown-mail [ftown] 1 new mail (1 task)'), null);
  assert.equal(parseNudge('[ftown msg from ftown-mail] hello'), null);
});
