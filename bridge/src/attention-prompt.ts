import {
  ATTENTION_PROMPT_LIMITS,
  type AttentionAnswerChannel,
  type AttentionAnswerEntry,
  type AttentionParseResult,
  type AttentionPrompt,
  type AttentionPromptOption,
  type AttentionPromptQuestion,
} from './attention-prompt-protocol.js';

// DCS/SOS/PM/APC payloads run to ST (ESC \ or U+009C) or the end of the string.
const STRING_ESCAPE_PATTERN = /\u001b[PX^_][\s\S]*?(?:\u001b\\|\u009c|$)/g;
// OSC (7-bit or U+009D) ends at BEL, ST or the end of the string.
const OSC_PATTERN = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u009c|\u001b\\|$)/g;
// CSI (7-bit or U+009B).
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/g;
// Any other ESC consumes at most one printable ASCII char; otherwise only the ESC goes.
const LONE_ESC_PATTERN = /\u001b[ -~]?/g;
// C0 and C1 control characters except \t (\u0009) and \n (\u000a), plus bidi/format controls.
const CONTROL_PATTERN =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function stripControl(value: string): string {
  return value
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(STRING_ESCAPE_PATTERN, '')
    .replace(OSC_PATTERN, '')
    .replace(CSI_PATTERN, '')
    .replace(LONE_ESC_PATTERN, '')
    .replace(CONTROL_PATTERN, '');
}

/** Multi-line text (question text, answer text): keeps \n and \t. */
function cleanBlock(value: string): string {
  return stripControl(value).trim();
}

/** Single-line text (header, label, description): \n and \t become spaces. */
function cleanLine(value: string): string {
  return stripControl(value).replace(/[\n\t]/g, ' ').trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ok<T>(value: T): AttentionParseResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): AttentionParseResult<T> {
  return { ok: false, error };
}

function unknownKey(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key));
}

const QUESTION_KEYS = ['question', 'header', 'options', 'multiSelect', 'allowText'] as const;
const OPTION_KEYS = ['label', 'description'] as const;

function parseOption(raw: unknown, path: string): AttentionParseResult<AttentionPromptOption> {
  const limits = ATTENTION_PROMPT_LIMITS;
  let labelRaw: unknown;
  let descriptionRaw: unknown;
  if (typeof raw === 'string') {
    labelRaw = raw;
  } else if (isPlainObject(raw)) {
    const extra = unknownKey(raw, OPTION_KEYS);
    if (extra !== undefined) return fail(`${path}.${extra} is not a supported field`);
    labelRaw = raw.label;
    descriptionRaw = raw.description;
  } else {
    return fail(`${path} must be a string or an object with a label`);
  }
  if (typeof labelRaw !== 'string') return fail(`${path}.label must be 1-${limits.optionLabelChars} characters`);
  const label = cleanLine(labelRaw);
  if (label.length < 1 || label.length > limits.optionLabelChars) {
    return fail(`${path}.label must be 1-${limits.optionLabelChars} characters`);
  }
  const option: AttentionPromptOption = { label };
  if (descriptionRaw !== undefined) {
    if (typeof descriptionRaw !== 'string') return fail(`${path}.description must be a string`);
    const description = cleanLine(descriptionRaw);
    if (description.length > limits.optionDescriptionChars) {
      return fail(`${path}.description must be at most ${limits.optionDescriptionChars} characters`);
    }
    if (description) option.description = description;
  }
  return ok(option);
}

function parseQuestion(raw: unknown, path: string): AttentionParseResult<AttentionPromptQuestion> {
  const limits = ATTENTION_PROMPT_LIMITS;
  if (!isPlainObject(raw)) return fail(`${path} must be an object`);
  const extra = unknownKey(raw, QUESTION_KEYS);
  if (extra !== undefined) return fail(`${path}.${extra} is not a supported field`);

  if (typeof raw.question !== 'string') return fail(`${path}.question must be 1-${limits.questionChars} characters`);
  const question = cleanBlock(raw.question);
  if (question.length < 1 || question.length > limits.questionChars) {
    return fail(`${path}.question must be 1-${limits.questionChars} characters`);
  }

  let header: string | undefined;
  if (raw.header !== undefined) {
    if (typeof raw.header !== 'string') return fail(`${path}.header must be a string`);
    const cleaned = cleanLine(raw.header);
    if (cleaned.length > limits.headerChars) return fail(`${path}.header must be at most ${limits.headerChars} characters`);
    if (cleaned) header = cleaned;
  }

  const options: AttentionPromptOption[] = [];
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options)) return fail(`${path}.options must be an array`);
    if (raw.options.length > limits.options) return fail(`${path}.options must have at most ${limits.options} entries`);
    const seen = new Set<string>();
    for (let i = 0; i < raw.options.length; i += 1) {
      const parsed = parseOption(raw.options[i], `${path}.options[${i}]`);
      if (!parsed.ok) return parsed;
      const key = parsed.value.label.toLowerCase();
      if (seen.has(key)) return fail(`${path}.options[${i}].label duplicates another option label`);
      seen.add(key);
      options.push(parsed.value);
    }
  }

  let multiSelect = false;
  if (raw.multiSelect !== undefined) {
    if (typeof raw.multiSelect !== 'boolean') return fail(`${path}.multiSelect must be a boolean`);
    multiSelect = raw.multiSelect;
  }
  let allowText = true;
  if (raw.allowText !== undefined) {
    if (typeof raw.allowText !== 'boolean') return fail(`${path}.allowText must be a boolean`);
    allowText = raw.allowText;
  }
  if (options.length === 0) {
    if (!allowText) return fail(`${path} has no options, so allowText must be true`);
    if (multiSelect) return fail(`${path} has no options, so multiSelect must be false`);
  }

  const result: AttentionPromptQuestion = { question, options, multiSelect, allowText };
  if (header !== undefined) result.header = header;
  return ok(result);
}

export function parseAttentionPrompt(
  questions: unknown,
  channel: AttentionAnswerChannel,
): AttentionParseResult<AttentionPrompt> {
  const max = ATTENTION_PROMPT_LIMITS.questions;
  if (!Array.isArray(questions)) return fail('questions must be an array');
  if (questions.length < 1 || questions.length > max) return fail(`questions must have 1-${max} entries`);
  const parsed: AttentionPromptQuestion[] = [];
  for (let i = 0; i < questions.length; i += 1) {
    const q = parseQuestion(questions[i], `questions[${i}]`);
    if (!q.ok) return q;
    parsed.push(q.value);
  }
  return ok({ channel, questions: parsed });
}

/** Lenient parse of one Claude Code AskUserQuestion question; undefined when unusable. */
function questionFromAskInput(raw: unknown): AttentionPromptQuestion | undefined {
  const limits = ATTENTION_PROMPT_LIMITS;
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.question !== 'string') return undefined;
  const question = cleanBlock(raw.question);
  if (question.length < 1 || question.length > limits.questionChars) return undefined;

  let header: string | undefined;
  if (raw.header !== undefined) {
    if (typeof raw.header !== 'string') return undefined;
    const cleaned = cleanLine(raw.header);
    if (cleaned.length > limits.headerChars) return undefined;
    if (cleaned) header = cleaned;
  }

  if (!Array.isArray(raw.options)) return undefined;
  if (raw.options.length < 1 || raw.options.length > limits.options) return undefined;
  const options: AttentionPromptOption[] = [];
  const seen = new Set<string>();
  for (const rawOption of raw.options) {
    if (!isPlainObject(rawOption)) return undefined;
    if (typeof rawOption.label !== 'string') return undefined;
    const label = cleanLine(rawOption.label);
    if (label.length < 1 || label.length > limits.optionLabelChars) return undefined;
    const key = label.toLowerCase();
    if (seen.has(key)) return undefined;
    seen.add(key);
    const option: AttentionPromptOption = { label };
    if (rawOption.description !== undefined) {
      if (typeof rawOption.description !== 'string') return undefined;
      const description = cleanLine(rawOption.description);
      if (description.length > limits.optionDescriptionChars) return undefined;
      if (description) option.description = description;
    }
    options.push(option);
  }

  let multiSelect = false;
  if (raw.multiSelect !== undefined) {
    if (typeof raw.multiSelect !== 'boolean') return undefined;
    multiSelect = raw.multiSelect;
  }

  const result: AttentionPromptQuestion = { question, options, multiSelect, allowText: true };
  if (header !== undefined) result.header = header;
  return result;
}

export function promptFromAskUserQuestionInput(toolInput: unknown): AttentionPrompt | undefined {
  if (!isPlainObject(toolInput)) return undefined;
  const raw = toolInput.questions;
  if (!Array.isArray(raw)) return undefined;
  if (raw.length < 1 || raw.length > ATTENTION_PROMPT_LIMITS.questions) return undefined;
  const questions: AttentionPromptQuestion[] = [];
  for (const entry of raw) {
    const question = questionFromAskInput(entry);
    if (!question) return undefined;
    questions.push(question);
  }
  return { channel: 'hook', questions };
}

const ANSWER_KEYS = ['selected', 'text'] as const;

export function validateAttentionAnswer(
  prompt: AttentionPrompt,
  answers: unknown,
): AttentionParseResult<AttentionAnswerEntry[]> {
  if (!Array.isArray(answers)) return fail('answers must be an array');
  if (answers.length !== prompt.questions.length) {
    return fail(`answers must have exactly ${prompt.questions.length} entries, one per question`);
  }
  const normalized: AttentionAnswerEntry[] = [];
  for (let i = 0; i < answers.length; i += 1) {
    const path = `answers[${i}]`;
    const question = prompt.questions[i];
    const raw: unknown = answers[i];
    if (!isPlainObject(raw)) return fail(`${path} must be an object`);
    const extra = unknownKey(raw, ANSWER_KEYS);
    if (extra !== undefined) return fail(`${path}.${extra} is not a supported field`);

    const rawSelected = raw.selected === undefined ? [] : raw.selected;
    if (!Array.isArray(rawSelected)) return fail(`${path}.selected must be an array of option indexes`);
    const selected: number[] = [];
    for (const index of rawSelected) {
      if (typeof index !== 'number' || !Number.isInteger(index)) {
        return fail(`${path}.selected must contain only integers`);
      }
      if (index < 0 || index >= question.options.length) {
        return fail(`${path}.selected has an out-of-range index ${index}`);
      }
      if (selected.includes(index)) return fail(`${path}.selected has a duplicate index ${index}`);
      selected.push(index);
    }
    selected.sort((a, b) => a - b);
    if (!question.multiSelect && selected.length > 1) {
      return fail(`${path}.selected must have at most 1 entry for a single-select question`);
    }

    let text: string | undefined;
    if (raw.text !== undefined) {
      if (typeof raw.text !== 'string') return fail(`${path}.text must be a string`);
      const cleaned = cleanBlock(raw.text);
      if (cleaned.length > ATTENTION_PROMPT_LIMITS.answerTextChars) {
        return fail(`${path}.text must be at most ${ATTENTION_PROMPT_LIMITS.answerTextChars} characters`);
      }
      if (cleaned) {
        if (!question.allowText) return fail(`${path}.text is not allowed for this question`);
        text = cleaned;
      }
    }
    if (selected.length === 0 && text === undefined) {
      return fail(`${path} needs at least one selected option or some text`);
    }
    const entry: AttentionAnswerEntry = { selected };
    if (text !== undefined) entry.text = text;
    normalized.push(entry);
  }
  return ok(normalized);
}

export function answerLabels(question: AttentionPromptQuestion, entry: AttentionAnswerEntry): string[] {
  const labels: string[] = [];
  for (const index of [...entry.selected].sort((a, b) => a - b)) {
    const option = question.options[index];
    if (option) labels.push(option.label);
  }
  return labels;
}

export function formatAttentionAnswerText(prompt: AttentionPrompt, answers: AttentionAnswerEntry[]): string {
  const blocks: string[] = [];
  prompt.questions.forEach((question, i) => {
    const entry = answers[i] ?? { selected: [] };
    const lines = [`Q: ${question.question}`];
    const labels = answerLabels(question, entry);
    if (labels.length > 0) {
      lines.push(`A: ${labels.join(', ')}`);
      if (entry.text) lines.push(`Note: ${entry.text}`);
    } else if (entry.text) {
      lines.push(`A: ${entry.text}`);
    }
    blocks.push(lines.join('\n'));
  });
  return blocks.join('\n\n');
}

export function formatAttentionAnswerMail(input: {
  attentionId: string;
  title?: string;
  prompt: AttentionPrompt;
  answers: AttentionAnswerEntry[];
}): string {
  const lines = [`[ftown attention answer id=${input.attentionId}]`];
  const title = input.title?.trim();
  if (title) lines.push(`Re: ${title}`);
  return `${lines.join('\n')}\n\n${formatAttentionAnswerText(input.prompt, input.answers)}`;
}
