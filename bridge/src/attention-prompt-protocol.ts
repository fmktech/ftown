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
 * `mail` identifies a question raised through ftown, and `hook` a native harness question.
 * Both deliver answers to an active waiter or queue a message for the owning session.
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
  /** A resumed native hook can see this answer was delivered to the session inbox. */
  delivery?: 'mail';
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
  | 'answer_waiter_gone'
  | 'attention_delivery_failed'
  /** The request payload itself was malformed (bad shape, unknown event id). */
  | 'invalid_attention_request'
  /** The session the item belongs to is gone or is not served by this bridge. */
  | 'session_unavailable'
  /** The command was addressed to another bridge, so this one cannot answer it. */
  | 'wrong_bridge'
  /** The attention store could not be reached. */
  | 'attention_not_ready';

export type AttentionParseResult<T> = { ok: true; value: T } | { ok: false; error: string };
