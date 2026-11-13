import type { AttentionRoutingFields } from "./coordination/contract-b.js";
import { z } from 'zod';
import { ATTENTION_PROMPT_LIMITS as L, type AttentionAnswer, type AttentionPrompt } from './attention-prompt-protocol.js';
import { promptFromAskUserQuestionInput } from './attention-prompt.js';

export type AttentionType = 'permission_prompt' | 'elicitation_dialog' | 'agent_needs_input' | 'ask_user';
export type Resolution = 'manual' | 'user_prompt' | 'elicitation_complete' | 'session_end' | 'answered' | 'tool_complete' | 'replied';
export interface Activity {
  state: 'thinking' | 'tool_use' | 'idle' | 'unknown';
  lastActivityAt?: string;
}
export interface AttentionItem extends AttentionRoutingFields {
  id: string;
  sequence: number;
  type: AttentionType;
  title: string;
  message: string;
  createdAt: string;
  lastSeenAt: string;
  occurrences: number;
  acknowledgedAt?: string;
  resolvedAt?: string;
  resolution?: Resolution;
  prompt?: AttentionPrompt;
  answer?: AttentionAnswer;
}
export interface AttentionObservation {
  activity?: Activity['state'];
  attention?: { type: AttentionType; title: string; message: string; sourceId?: string; prompt?: AttentionPrompt };
  resolve?: Exclude<Resolution, 'manual' | 'answered' | 'tool_complete'>;
  /** Raw tool_use_id of an ask tool that finished; resolves the matching ask_user item. */
  toolComplete?: string;
}

export const promptSchema = z.object({
  channel: z.enum(['mail', 'hook']),
  questions: z.array(z.object({
    question: z.string().min(1).max(L.questionChars),
    header: z.string().max(L.headerChars).optional(),
    options: z.array(z.object({
      label: z.string().min(1).max(L.optionLabelChars),
      description: z.string().max(L.optionDescriptionChars).optional(),
    }).strict()).max(L.options),
    multiSelect: z.boolean(),
    allowText: z.boolean(),
  }).strict()).min(1).max(L.questions),
}).strict();

/** Secret redaction only (no cleaning, truncation or excerpting). */
export function redactAttentionSecrets(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[redacted]')
    .replace(/\b((?:[A-Z_]*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)[A-Z_]*|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[redacted]');
}

/**
 * Redacts every prompt string, then re-checks limits, unique labels and the free-text rule.
 * Never throws; the error names what to fix.
 */
export function normalizeAttentionPrompt(input: unknown): { ok: true; value: AttentionPrompt } | { ok: false; error: string } {
  const shape = promptSchema.safeParse(input);
  if (!shape.success) {
    const issue = shape.error.issues[0];
    return { ok: false, error: `Invalid prompt${issue ? ` at ${issue.path.join('.') || 'prompt'}: ${issue.message}` : ''}` };
  }
  const prompt = shape.data as AttentionPrompt;
  const redacted: AttentionPrompt = {
    channel: prompt.channel,
    questions: prompt.questions.map((q) => ({
      question: redactAttentionSecrets(q.question),
      ...(q.header !== undefined ? { header: redactAttentionSecrets(q.header) } : {}),
      options: q.options.map((o) => ({
        label: redactAttentionSecrets(o.label),
        ...(o.description !== undefined ? { description: redactAttentionSecrets(o.description) } : {}),
      })),
      multiSelect: q.multiSelect,
      allowText: q.allowText,
    })),
  };
  const parsed = promptSchema.safeParse(redacted);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `Invalid prompt${issue ? ` at ${issue.path.join('.') || 'prompt'}: ${issue.message}` : ''}` };
  }
  for (const [i, q] of parsed.data.questions.entries()) {
    const labels = new Set(q.options.map((o) => o.label.toLowerCase()));
    if (labels.size !== q.options.length) return { ok: false, error: `Invalid prompt at questions.${i}.options: labels must be unique` };
    if (!q.options.length && (!q.allowText || q.multiSelect)) return { ok: false, error: `Invalid prompt at questions.${i}: a question without options must allow text and not be multi-select` };
  }
  return { ok: true, value: parsed.data as AttentionPrompt };
}

/** Only the selected human-facing excerpt crosses the API; never the hook payload. */
export function sanitizeAttentionText(value: string, maxLength: number): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[redacted]')
    .replace(/\b((?:[A-Z_]*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)[A-Z_]*|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[redacted]')
    .trim()
    .slice(0, maxLength);
}

const askTools = new Set(['askuserquestion', 'askquestion', 'askuser', 'requestuserinput', 'ftownaskuser']);
const notificationTypes = new Set(['permission_prompt', 'elicitation_dialog', 'agent_needs_input']);
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

function question(data: Record<string, unknown>): string | undefined {
  const raw = data.tool_input ?? data.toolInput ?? data.input;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const input = raw as Record<string, unknown>;
  const direct = text(input.question) ?? text(input.prompt) ?? text(input.message);
  if (direct) return direct;
  const first: unknown = Array.isArray(input.questions) ? input.questions[0] : undefined;
  if (!first || typeof first !== 'object' || Array.isArray(first)) return;
  const item = first as Record<string, unknown>;
  return text(item.question) ?? text(item.prompt) ?? text(item.message);
}

export function classifyAttentionHook(eventName: string, data: Record<string, unknown>): AttentionObservation {
  const observation: AttentionObservation = {};
  if (['UserPromptSubmit', 'beforeSubmitPrompt', 'sessionStart'].includes(eventName)) observation.activity = 'thinking';
  if (['PreToolUse', 'preToolUse', 'beforeShellExecution', 'beforeMCPExecution'].includes(eventName)) observation.activity = 'tool_use';
  if (['PostToolUse', 'postToolUse', 'afterShellExecution', 'afterFileEdit', 'afterMCPExecution'].includes(eventName)) observation.activity = 'thinking';
  if (['Stop', 'stop', 'SessionEnd', 'sessionEnd', 'postToolUseFailure'].includes(eventName)) observation.activity = 'idle';
  if (['UserPromptSubmit', 'beforeSubmitPrompt'].includes(eventName)) observation.resolve = 'user_prompt';
  if (['SessionEnd', 'sessionEnd'].includes(eventName)) observation.resolve = 'session_end';
  if (eventName === 'Notification' && ['elicitation_complete', 'elicitation_response'].includes(String(data.notification_type))) {
    observation.resolve = 'elicitation_complete';
  }
  const sourceId = text(data.notification_id) ?? text(data.tool_use_id) ?? text(data.event_id);
  if (eventName === 'Notification' && notificationTypes.has(String(data.notification_type))) {
    observation.attention = {
      type: data.notification_type as AttentionType,
      title: sanitizeAttentionText(text(data.title) ?? 'Session needs your input', 200),
      message: sanitizeAttentionText(text(data.message) ?? 'Open the session to respond.', 2000),
      ...(sourceId ? { sourceId: sourceId.slice(0, 200) } : {}),
    };
  }
  const tool = (text(data.tool_name) ?? text(data.toolName))?.split(/\.|\/|::|__/).at(-1)?.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (['PreToolUse', 'preToolUse'].includes(eventName) && tool && askTools.has(tool)) {
    observation.attention = {
      type: 'ask_user',
      title: 'Session is asking a question',
      message: sanitizeAttentionText(question(data) ?? 'Open the session to respond.', 2000),
      ...(sourceId ? { sourceId: sourceId.slice(0, 200) } : {}),
    };
    if (tool === 'askuserquestion') {
      const raw = promptFromAskUserQuestionInput(data.tool_input ?? data.toolInput ?? data.input);
      const checked = raw ? normalizeAttentionPrompt(raw) : undefined;
      if (checked?.ok) observation.attention.prompt = checked.value;
    }
  }
  if (['PostToolUse', 'postToolUse'].includes(eventName) && tool && askTools.has(tool) && sourceId) {
    observation.toolComplete = sourceId.slice(0, 200);
  }
  return observation;
}
