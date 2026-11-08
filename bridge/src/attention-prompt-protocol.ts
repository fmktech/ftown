/**
 * Structured questions an attention request can carry, and the human's answer.
 * Shared by the bridge, the ftown CLI, the harness hook and the UI, so it
 * must stay free of Node built-ins and runtime dependencies.
 */

export const ATTENTION_PROMPT_LIMITS = {
  questions: 4,
  questionChars: 500,
  headerChars: 40,
  options: 8,
  optionLabelChars: 80,
  optionDescriptionChars: 200,
  answerTextChars: 4000,
} as const;

/**
 * A waiter counts as live while a long-poll is active and this long after its
 * latest long-poll ended normally (an aborted poll ends liveness at once). Kept
 * short: a waiter that died between polls must not swallow an answer that
 * should have fallen back to mail.
 */
export const ATTENTION_WAITER_TTL_MS = 10_000;
/** Longest single long-poll on one attention item, in seconds. */
export const ATTENTION_ITEM_WAIT_MAX_SECONDS = 25;
/** Claude Code `timeout` for the AskUserQuestion hook, in seconds. */
export const ASK_HOOK_TIMEOUT_SECONDS = 3600;
/** The hook gives up before Claude Code kills it, so the terminal picker can take over. */
export const ASK_HOOK_DEADLINE_MS = 3_540_000;

export interface AttentionPromptOption {
  label: string;
  description?: string;
}

export interface AttentionPromptQuestion {
  question: string;
  header?: string;
  /** May be empty only when `allowText` is true (a free-text question). */
  options: AttentionPromptOption[];
  multiSelect: boolean;
  /** The human may type their own answer or note ("manual input"). */
  allowText: boolean;
}

/**
 * `mail`: an agent asked through ftown; a live waiter receives the answer,
 * otherwise it is mailed to the session.
 * `hook`: a blocking harness hook (Claude Code AskUserQuestion) receives it;
 * there is no mail fallback.
 */
export type AttentionAnswerChannel = 'mail' | 'hook';

export interface AttentionPrompt {
  channel: AttentionAnswerChannel;
  questions: AttentionPromptQuestion[];
}

/** Answer to `prompt.questions[i]` is `answers[i]`. */
export interface AttentionAnswerEntry {
  /** Indexes into the question's `options`, unique, ascending. */
  selected: number[];
  text?: string;
}

export interface AttentionAnswer {
  answers: AttentionAnswerEntry[];
  answeredAt: string;
}

/** What callers send as `questions` (local API, CLI --questions-json). */
export interface AttentionPromptQuestionInput {
  question: string;
  header?: string;
  options?: Array<string | AttentionPromptOption>;
  multiSelect?: boolean;
  allowText?: boolean;
}

/** Body of POST /api/sessions/:id/attention/ask (harness hook only). */
export interface AttentionAskRequest {
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
}

/** Browser -> bridge E2EE command `answer_session_attention` (control permission). */
export interface AnswerSessionAttentionPayload {
  bridgeId: string;
  sessionId: string;
  eventId: string;
  answers: AttentionAnswerEntry[];
}

/** `waiter`: a live long-poll took the answer. `mail`: mailed to the session. */
export type AttentionAnswerDelivery = 'waiter' | 'mail' | 'mail_failed';

export type AttentionAnswerErrorCode =
  | 'attention_not_found'
  | 'attention_not_answerable'
  | 'attention_already_resolved'
  | 'invalid_answer'
  | 'answer_waiter_gone';

export type AttentionParseResult<T> = { ok: true; value: T } | { ok: false; error: string };
