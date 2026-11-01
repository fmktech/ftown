import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  answerLabels,
  formatAttentionAnswerMail,
  formatAttentionAnswerText,
  parseAttentionPrompt,
  promptFromAskUserQuestionInput,
  validateAttentionAnswer,
} from './attention-prompt.js';
import type {
  AttentionAnswerEntry,
  AttentionParseResult,
  AttentionPrompt,
  AttentionPromptQuestion,
} from './attention-prompt-protocol.js';

function okValue<T>(result: AttentionParseResult<T>): T {
  if (!result.ok) throw new Error(`expected ok result, got error: ${result.error}`);
  return result.value;
}

function errorOf<T>(result: AttentionParseResult<T>): string {
  if (result.ok) throw new Error(`expected error result, got value: ${JSON.stringify(result.value)}`);
  return result.error;
}

function mailPrompt(questions: unknown): AttentionPrompt {
  return okValue(parseAttentionPrompt(questions, 'mail'));
}

function parseError(questions: unknown): string {
  return errorOf(parseAttentionPrompt(questions, 'mail'));
}

const questionText = (text: string): string => mailPrompt([{ question: text }]).questions[0].question;
const labelText = (text: string): string => mailPrompt([{ question: 'Q', options: [text] }]).questions[0].options[0].label;

const choicePrompt = (): AttentionPrompt => mailPrompt([
  { question: 'Q1', options: ['a', 'b', 'c'] },
  { question: 'Q2', options: ['x', 'y'], multiSelect: true },
]);

const answerError = (answers: unknown, prompt: AttentionPrompt = choicePrompt()): string =>
  errorOf(validateAttentionAnswer(prompt, answers));

describe('parseAttentionPrompt', () => {
  it('accepts string options and normalizes them to labels', () => {
    const prompt = mailPrompt([{ question: 'Pick', options: ['Red', 'Blue'] }]);
    assert.equal(prompt.channel, 'mail');
    assert.equal(prompt.questions.length, 1);
    assert.deepEqual(prompt.questions[0].options, [{ label: 'Red' }, { label: 'Blue' }]);
  });

  it('accepts object options with a description and drops blank descriptions', () => {
    const prompt = mailPrompt([{
      question: 'Pick',
      options: [
        { label: 'Fast', description: 'Ships today' },
        { label: 'Safe', description: '   ' },
      ],
    }]);
    const [fast, safe] = prompt.questions[0].options;
    assert.deepEqual(fast, { label: 'Fast', description: 'Ships today' });
    assert.deepEqual(safe, { label: 'Safe' });
    assert.equal('description' in safe, false);
  });

  it('applies defaults: options [], multiSelect false, allowText true', () => {
    const prompt = mailPrompt([{ question: 'Why?' }]);
    const q: AttentionPromptQuestion = prompt.questions[0];
    assert.deepEqual(q.options, []);
    assert.equal(q.multiSelect, false);
    assert.equal(q.allowText, true);
  });

  it('omits header when it is blank after cleaning and keeps it otherwise', () => {
    const blank = mailPrompt([{ question: 'Q', header: '   ' }]);
    assert.equal('header' in blank.questions[0], false);
    const kept = mailPrompt([{ question: 'Q', header: 'Deploy' }]);
    assert.equal(kept.questions[0].header, 'Deploy');
  });

  it('echoes the channel it was given', () => {
    const hook = okValue(parseAttentionPrompt([{ question: 'Q' }], 'hook'));
    assert.equal(hook.channel, 'hook');
  });

  describe('exact error messages', () => {
    it('rejects an unknown question key by name', () => {
      assert.equal(parseError([{ question: 'Q', bogus: true }]), 'questions[0].bogus is not a supported field');
    });

    it('rejects zero questions and five questions with the same message', () => {
      assert.equal(parseError([]), 'questions must have 1-4 entries');
      const q = (n: number) => ({ question: `Q${n}`, options: ['a'] });
      assert.equal(parseError([q(1), q(2), q(3), q(4), q(5)]), 'questions must have 1-4 entries');
    });

    it('rejects nine options with the option-count message', () => {
      const nine = Array.from({ length: 9 }, (_, i) => `opt${i}`);
      assert.equal(parseError([{ question: 'Q', options: nine }]), 'questions[0].options must have at most 8 entries');
    });

    it('rejects a case-insensitive duplicate label at the later index', () => {
      assert.equal(
        parseError([{ question: 'Q', options: ['Yes', 'yes'] }]),
        'questions[0].options[1].label duplicates another option label',
      );
    });

    it('rejects zero options with allowText false', () => {
      assert.equal(parseError([{ question: 'Q', allowText: false }]), 'questions[0] has no options, so allowText must be true');
    });

    it('rejects zero options with multiSelect true', () => {
      assert.equal(parseError([{ question: 'Q', multiSelect: true }]), 'questions[0] has no options, so multiSelect must be false');
    });

    it('rejects an 81-character label with the label-length message', () => {
      assert.equal(
        parseError([{ question: 'Q', options: ['x'.repeat(81)] }]),
        'questions[0].options[0].label must be 1-80 characters',
      );
    });

    it('rejects a question that is empty after cleaning', () => {
      assert.equal(parseError([{ question: '\u001b[0m' }]), 'questions[0].question must be 1-500 characters');
    });

    it('rejects a label that is blank after ANSI stripping', () => {
      assert.equal(
        parseError([{ question: 'Q', options: ['\u001b[31m\u001b[0m'] }]),
        'questions[0].options[0].label must be 1-80 characters',
      );
    });

    it('rejects labels that collide only after cleaning', () => {
      assert.equal(
        parseError([{ question: 'Q', options: ['\u001b[1mYes\u001b[0m', 'Yes'] }]),
        'questions[0].options[1].label duplicates another option label',
      );
    });
  });

  describe('boundaries', () => {
    it('accepts a 500-character question and rejects 501', () => {
      assert.equal(questionText('x'.repeat(500)), 'x'.repeat(500));
      assert.equal(parseError([{ question: 'x'.repeat(501) }]), 'questions[0].question must be 1-500 characters');
    });

    it('accepts a 40-character header and rejects 41', () => {
      assert.equal(mailPrompt([{ question: 'Q', header: 'h'.repeat(40) }]).questions[0].header, 'h'.repeat(40));
      assert.equal(parseError([{ question: 'Q', header: 'h'.repeat(41) }]), 'questions[0].header must be at most 40 characters');
    });

    it('accepts a 200-character option description and rejects 201', () => {
      const ok = mailPrompt([{ question: 'Q', options: [{ label: 'a', description: 'd'.repeat(200) }] }]);
      assert.equal(ok.questions[0].options[0].description, 'd'.repeat(200));
      assert.equal(
        parseError([{ question: 'Q', options: [{ label: 'a', description: 'd'.repeat(201) }] }]),
        'questions[0].options[0].description must be at most 200 characters',
      );
    });
  });

  describe('wrong types', () => {
    it('rejects a string multiSelect and a string allowText', () => {
      assert.equal(parseError([{ question: 'Q', options: ['a'], multiSelect: 'true' }]), 'questions[0].multiSelect must be a boolean');
      assert.equal(parseError([{ question: 'Q', allowText: 'no' }]), 'questions[0].allowText must be a boolean');
    });

    it('rejects questions that are not an array', () => {
      assert.equal(parseError('x'), 'questions must be an array');
      assert.equal(parseError({}), 'questions must be an array');
    });

    it('rejects a non-object or array question', () => {
      assert.equal(parseError(['Q']), 'questions[0] must be an object');
      assert.equal(parseError([['Q']]), 'questions[0] must be an object');
    });

    it('rejects an option that is neither a string nor an object', () => {
      assert.equal(parseError([{ question: 'Q', options: [5] }]), 'questions[0].options[0] must be a string or an object with a label');
      assert.equal(parseError([{ question: 'Q', options: [['a']] }]), 'questions[0].options[0] must be a string or an object with a label');
    });

    it('rejects options that are not an array', () => {
      assert.equal(parseError([{ question: 'Q', options: 'a' }]), 'questions[0].options must be an array');
    });

    it('rejects a non-string question, header, description and label', () => {
      assert.equal(parseError([{ question: 5 }]), 'questions[0].question must be 1-500 characters');
      assert.equal(parseError([{ question: 'Q', header: 5 }]), 'questions[0].header must be a string');
      assert.equal(
        parseError([{ question: 'Q', options: [{ label: 'a', description: 5 }] }]),
        'questions[0].options[0].description must be a string',
      );
      assert.equal(parseError([{ question: 'Q', options: [{ label: 5 }] }]), 'questions[0].options[0].label must be 1-80 characters');
    });

    it('rejects own __proto__ and constructor keys (created with JSON.parse)', () => {
      const proto = JSON.parse('[{"question":"Q","__proto__":1}]');
      assert.equal(parseError(proto), 'questions[0].__proto__ is not a supported field');
      const ctor = JSON.parse('[{"question":"Q","constructor":1}]');
      assert.equal(parseError(ctor), 'questions[0].constructor is not a supported field');
      const optionCtor = JSON.parse('[{"question":"Q","options":[{"label":"a","constructor":1}]}]');
      assert.equal(parseError(optionCtor), 'questions[0].options[0].constructor is not a supported field');
    });
  });

  describe('cleaning rules', () => {
    it('keeps a newline that follows an ESC in question text', () => {
      assert.equal(questionText('c\u001b\nd'), 'c\nd');
    });

    it('leaves an emoji after an ESC intact', () => {
      assert.equal(questionText('a\u001b😀b'), 'a😀b');
    });

    it('strips OSC sequences terminated by BEL and by ST', () => {
      assert.equal(questionText('a\u001b]0;title\u0007b'), 'ab');
      assert.equal(questionText('a\u001b]0;title\u001b\\b'), 'ab');
    });

    it('strips a DCS sequence together with its payload', () => {
      assert.equal(questionText('a\u001bPpayload\u001b\\b'), 'ab');
    });

    it('strips an 8-bit CSI sequence fully', () => {
      assert.equal(questionText('a\u009b31mb'), 'ab');
    });

    it('strips bidi override and isolate controls', () => {
      assert.equal(questionText('a‮b⁦c'), 'abc');
      assert.equal(labelText('a‮b⁦c'), 'abc');
    });

    it('turns U+2028 into a newline in question text and a space in a label', () => {
      assert.equal(questionText('a b'), 'a\nb');
      assert.equal(labelText('a b'), 'a b');
    });

    it('keeps a tab in question text and turns it into a space in a label', () => {
      assert.equal(questionText('a\tb'), 'a\tb');
      assert.equal(labelText('a\tb'), 'a b');
    });
  });
});

describe('promptFromAskUserQuestionInput', () => {
  it('parses a valid AskUserQuestion input, ignoring extra keys', () => {
    const prompt = promptFromAskUserQuestionInput({
      questions: [{
        question: 'Pick',
        header: 'H',
        options: [
          { label: 'A', description: 'd', preview: 'ignored' },
          { label: 'B' },
        ],
        multiSelect: true,
        extraQuestionKey: 1,
      }],
      unrelated: 'ignored',
    });
    assert.ok(prompt);
    assert.equal(prompt.channel, 'hook');
    assert.equal(prompt.questions.length, 1);
    const q = prompt.questions[0];
    assert.equal(q.question, 'Pick');
    assert.equal(q.header, 'H');
    assert.equal(q.multiSelect, true);
    assert.equal(q.allowText, true);
    assert.deepEqual(q.options, [{ label: 'A', description: 'd' }, { label: 'B' }]);
  });

  it('defaults multiSelect to false', () => {
    const prompt = promptFromAskUserQuestionInput({
      questions: [{ question: 'Pick', options: [{ label: 'A' }] }],
    });
    assert.ok(prompt);
    assert.equal(prompt.questions[0].multiSelect, false);
  });

  it('returns undefined when a question has no options', () => {
    assert.equal(promptFromAskUserQuestionInput({ questions: [{ question: 'Pick', options: [] }] }), undefined);
    assert.equal(promptFromAskUserQuestionInput({ questions: [{ question: 'Pick' }] }), undefined);
  });

  it('returns undefined when over a limit instead of truncating', () => {
    const fiveQuestions = {
      questions: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}`, options: [{ label: 'a' }] })),
    };
    assert.equal(promptFromAskUserQuestionInput(fiveQuestions), undefined);
    const nineOptions = {
      questions: [{ question: 'Q', options: Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` })) }],
    };
    assert.equal(promptFromAskUserQuestionInput(nineOptions), undefined);
  });

  it('returns undefined for missing or wrongly typed input', () => {
    assert.equal(promptFromAskUserQuestionInput(undefined), undefined);
    assert.equal(promptFromAskUserQuestionInput(null), undefined);
    assert.equal(promptFromAskUserQuestionInput('questions'), undefined);
    assert.equal(promptFromAskUserQuestionInput([]), undefined);
    assert.equal(promptFromAskUserQuestionInput({}), undefined);
    assert.equal(promptFromAskUserQuestionInput({ questions: 'nope' }), undefined);
    assert.equal(promptFromAskUserQuestionInput({ questions: [] }), undefined);
  });

  it('returns undefined for a non-string question or header', () => {
    assert.equal(promptFromAskUserQuestionInput({ questions: [{ question: 5, options: [{ label: 'a' }] }] }), undefined);
    assert.equal(
      promptFromAskUserQuestionInput({ questions: [{ question: 'Q', header: 5, options: [{ label: 'a' }] }] }),
      undefined,
    );
  });

  it('returns undefined for a non-object option', () => {
    assert.equal(promptFromAskUserQuestionInput({ questions: [{ question: 'Q', options: ['a'] }] }), undefined);
    assert.equal(promptFromAskUserQuestionInput({ questions: [{ question: 'Q', options: [null] }] }), undefined);
  });

  it('returns undefined when labels differ only by case', () => {
    const prompt = promptFromAskUserQuestionInput({
      questions: [{ question: 'Q', options: [{ label: 'Yes' }, { label: 'yes' }] }],
    });
    assert.equal(prompt, undefined);
  });

  it('returns undefined when cleaning makes two labels collide', () => {
    const prompt = promptFromAskUserQuestionInput({
      questions: [{ question: 'Q', options: [{ label: '\u001b[1mYes\u001b[0m' }, { label: 'Yes' }] }],
    });
    assert.equal(prompt, undefined);
  });
});

describe('validateAttentionAnswer', () => {
  it('rejects answers that are not an array', () => {
    assert.equal(answerError({}), 'answers must be an array');
  });

  it('rejects an answers array with the wrong length', () => {
    assert.equal(answerError([{ selected: [0] }]), 'answers must have exactly 2 entries, one per question');
    assert.equal(
      answerError([{ selected: [0] }, { selected: [0] }, { selected: [0] }]),
      'answers must have exactly 2 entries, one per question',
    );
  });

  it('rejects an answer entry that is not an object', () => {
    assert.equal(answerError([[0], { selected: [0] }]), 'answers[0] must be an object');
  });

  it('rejects an out-of-range option index', () => {
    assert.equal(answerError([{ selected: [3] }, { selected: [0] }]), 'answers[0].selected has an out-of-range index 3');
    assert.equal(answerError([{ selected: [-1] }, { selected: [0] }]), 'answers[0].selected has an out-of-range index -1');
  });

  it('rejects duplicate indexes', () => {
    assert.equal(answerError([{ selected: [0, 0] }, { selected: [0] }]), 'answers[0].selected has a duplicate index 0');
  });

  it('rejects non-integer indexes including NaN, Infinity and strings', () => {
    const message = 'answers[0].selected must contain only integers';
    assert.equal(answerError([{ selected: [0.5] }, { selected: [0] }]), message);
    assert.equal(answerError([{ selected: ['0'] }, { selected: [0] }]), message);
    assert.equal(answerError([{ selected: [Number.NaN] }, { selected: [0] }]), message);
    assert.equal(answerError([{ selected: [Number.POSITIVE_INFINITY] }, { selected: [0] }]), message);
  });

  it('rejects selected values that are not an array', () => {
    assert.equal(answerError([{ selected: 0 }, { selected: [0] }]), 'answers[0].selected must be an array of option indexes');
  });

  it('normalizes -0 to 0 and 1.0 to 1', () => {
    const answers = okValue(validateAttentionAnswer(choicePrompt(), [{ selected: [-0] }, { selected: [1.0, 0] }]));
    assert.equal(JSON.stringify(answers[0].selected), '[0]');
    assert.equal(JSON.stringify(answers[1].selected), '[0,1]');
  });

  it('rejects two selections on a single-select question', () => {
    assert.equal(
      answerError([{ selected: [0, 1] }, { selected: [0] }]),
      'answers[0].selected must have at most 1 entry for a single-select question',
    );
  });

  it('accepts several selections on a multi-select question and sorts them', () => {
    const answers = okValue(validateAttentionAnswer(choicePrompt(), [{ selected: [0] }, { selected: [1, 0] }]));
    assert.deepEqual(answers[1].selected, [0, 1]);
  });

  it('rejects text when the question has allowText false', () => {
    const prompt = mailPrompt([{ question: 'Q', options: ['a'], allowText: false }]);
    assert.equal(answerError([{ selected: [0], text: 'extra' }], prompt), 'answers[0].text is not allowed for this question');
  });

  it('accepts text-only answers and omits selected when it is absent', () => {
    const answers = okValue(validateAttentionAnswer(choicePrompt(), [{ text: 'hi' }, { selected: [0] }]));
    assert.deepEqual(answers[0], { selected: [], text: 'hi' });
  });

  it('rejects an empty entry and an entry whose text is blank', () => {
    const message = 'answers[0] needs at least one selected option or some text';
    assert.equal(answerError([{ selected: [] }, { selected: [0] }]), message);
    assert.equal(answerError([{ selected: [], text: '   ' }, { selected: [0] }]), message);
  });

  it('trims text, omits it when empty after cleaning, and keeps tabs', () => {
    const answers = okValue(validateAttentionAnswer(choicePrompt(), [
      { selected: [0], text: '  hello  ' },
      { selected: [0], text: '   ' },
    ]));
    assert.equal(answers[0].text, 'hello');
    assert.equal('text' in answers[1], false);
    const tabbed = okValue(validateAttentionAnswer(choicePrompt(), [{ selected: [0], text: 'a\tb' }, { selected: [0] }]));
    assert.equal(tabbed[0].text, 'a\tb');
  });

  it('accepts text of exactly 4000 characters and rejects 4001', () => {
    const exact = okValue(validateAttentionAnswer(choicePrompt(), [{ selected: [0], text: 'x'.repeat(4000) }, { selected: [0] }]));
    assert.equal(exact[0].text?.length, 4000);
    assert.equal(
      answerError([{ selected: [0], text: 'x'.repeat(4001) }, { selected: [0] }]),
      'answers[0].text must be at most 4000 characters',
    );
  });

  it('rejects non-string text', () => {
    assert.equal(answerError([{ selected: [0], text: 5 }, { selected: [0] }]), 'answers[0].text must be a string');
  });

  it('rejects unknown keys on an answer entry, including own __proto__ and constructor', () => {
    assert.equal(answerError([{ selected: [0], extra: 1 }, { selected: [0] }]), 'answers[0].extra is not a supported field');
    const ctor = JSON.parse('[{"selected":[0],"constructor":1},{"selected":[0]}]');
    assert.equal(answerError(ctor), 'answers[0].constructor is not a supported field');
    const proto = JSON.parse('[{"selected":[0],"__proto__":1},{"selected":[0]}]');
    assert.equal(answerError(proto), 'answers[0].__proto__ is not a supported field');
  });
});

describe('answerLabels', () => {
  it('returns labels for the selected indexes in index order', () => {
    const prompt = mailPrompt([{ question: 'Q', options: ['a', 'b', 'c'], multiSelect: true }]);
    const entry: AttentionAnswerEntry = { selected: [0, 2] };
    assert.deepEqual(answerLabels(prompt.questions[0], entry), ['a', 'c']);
  });

  it('returns an empty list when nothing is selected', () => {
    const prompt = mailPrompt([{ question: 'Q' }]);
    assert.deepEqual(answerLabels(prompt.questions[0], { selected: [], text: 'hi' }), []);
  });
});

describe('formatAttentionAnswerText', () => {
  it('formats labels plus a note, and a text-only answer, one blank line between questions', () => {
    const prompt = mailPrompt([
      { question: 'Pick color', options: ['red', 'blue'] },
      { question: 'Why?' },
    ]);
    const text = formatAttentionAnswerText(prompt, [
      { selected: [1], text: 'maybe' },
      { selected: [], text: 'because' },
    ]);
    assert.equal(text, 'Q: Pick color\nA: blue\nNote: maybe\n\nQ: Why?\nA: because');
  });

  it('formats multiple selected labels joined with ", "', () => {
    const prompt = mailPrompt([{ question: 'Pick', options: ['red', 'blue'], multiSelect: true }]);
    assert.equal(formatAttentionAnswerText(prompt, [{ selected: [0, 1] }]), 'Q: Pick\nA: red, blue');
  });

  it('prints only the Q line for a question whose answer entry is missing', () => {
    const text = formatAttentionAnswerText(choicePrompt(), [{ selected: [0] }]);
    assert.equal(text, 'Q: Q1\nA: a\n\nQ: Q2');
  });
});

describe('formatAttentionAnswerMail', () => {
  const prompt = mailPrompt([{ question: 'Pick', options: ['red'] }]);
  const answers: AttentionAnswerEntry[] = [{ selected: [0] }];
  const body = formatAttentionAnswerText(prompt, answers);

  it('includes the id and the title line when a title is given', () => {
    const mail = formatAttentionAnswerMail({ attentionId: 'att-1', title: 'Deploy?', prompt, answers });
    assert.equal(mail, `[ftown attention answer id=att-1]\nRe: Deploy?\n\n${body}`);
  });

  it('omits the title line when the title is empty', () => {
    const mail = formatAttentionAnswerMail({ attentionId: 'att-1', title: '', prompt, answers });
    assert.equal(mail, `[ftown attention answer id=att-1]\n\n${body}`);
  });

  it('omits the title line when the title is whitespace only', () => {
    const mail = formatAttentionAnswerMail({ attentionId: 'att-1', title: '   ', prompt, answers });
    assert.equal(mail, `[ftown attention answer id=att-1]\n\n${body}`);
    assert.equal(mail.includes('Re:'), false);
  });

  it('omits the title line when no title is given', () => {
    const mail = formatAttentionAnswerMail({ attentionId: 'att-1', prompt, answers });
    assert.equal(mail, `[ftown attention answer id=att-1]\n\n${body}`);
  });
});
