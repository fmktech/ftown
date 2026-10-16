export type AttentionType = 'permission_prompt' | 'elicitation_dialog' | 'agent_needs_input' | 'ask_user';
export type Resolution = 'manual' | 'user_prompt' | 'elicitation_complete' | 'session_end';
export interface Activity {
  state: 'thinking' | 'tool_use' | 'idle' | 'unknown';
  lastActivityAt?: string;
}
export interface AttentionItem {
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
}
export interface AttentionObservation {
  activity?: Activity['state'];
  attention?: { type: AttentionType; title: string; message: string; sourceId?: string };
  resolve?: Exclude<Resolution, 'manual'>;
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
  }
  return observation;
}
