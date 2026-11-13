import { parseAttentionPrompt, promptFromAskUserQuestionInput } from "../../../bridge/src/attention-prompt";
import type { AttentionAnswerChannel, AttentionPrompt } from "../../../bridge/src/attention-prompt-protocol";

export type HookActivity = "thinking" | "tool_use" | "idle";

export interface ManualInputNotice {
  type: "permission_prompt" | "elicitation_dialog" | "agent_needs_input" | "ask_user";
  title: string;
  message: string;
  receivedAt: number;
  attentionId?: string;
  attentionSequence?: number;
  /** Structured question the human can answer from the dashboard. */
  prompt?: AttentionPrompt;
}

/** Notices the bridge tracks durably: stamped explicit requests and stamped questions that carry a prompt. */
export function isDurableNotice(notice: ManualInputNotice | undefined): boolean {
  return !!notice && !!notice.attentionId
    && (notice.type === "agent_needs_input" || (notice.type === "ask_user" && !!notice.prompt));
}

function validAttentionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}

function validAttentionSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isAskUserQuestionTool(toolName: string | undefined): boolean {
  return toolName?.replace(/[^a-z0-9]/gi, "").toLowerCase() === "askuserquestion";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in source) out[key] = source[key];
  return out;
}

/**
 * Validate a prompt received from the bridge. A newer bridge may add fields
 * the strict parser rejects, so unknown keys are stripped first. The RAW
 * channel must equal `expectedChannel`; anything else is invalid.
 */
export function parseLenientPrompt(raw: unknown, expectedChannel: AttentionAnswerChannel): AttentionPrompt | undefined {
  if (!isRecord(raw) || raw.channel !== expectedChannel || !Array.isArray(raw.questions)) return undefined;
  const questions = raw.questions.map((question) => {
    if (!isRecord(question)) return question;
    const stripped = pick(question, ["question", "header", "options", "multiSelect", "allowText"]);
    if (Array.isArray(stripped.options)) {
      stripped.options = stripped.options.map((option) => (isRecord(option) ? pick(option, ["label", "description"]) : option));
    }
    return stripped;
  });
  const parsed = parseAttentionPrompt(questions, expectedChannel);
  return parsed.ok ? parsed.value : undefined;
}

function extractNotificationPrompt(data: Record<string, unknown>): AttentionPrompt | undefined {
  return parseLenientPrompt(data.attentionPrompt, "mail");
}

const MANUAL_INPUT_NOTIFICATION_TYPES = new Set<ManualInputNotice["type"]>([
  "permission_prompt",
  "elicitation_dialog",
  "agent_needs_input",
]);

const MANUAL_INPUT_TOOL_NAMES = new Set([
  "askuserquestion",
  "askquestion",
  "askuser",
  "requestuserinput",
  "ftownaskuser",
]);

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function extractQuestion(data: Record<string, unknown>): string | undefined {
  const rawInput = data.tool_input ?? data.toolInput ?? data.input;
  if (typeof rawInput !== "object" || rawInput === null) return undefined;
  const input = rawInput as Record<string, unknown>;
  const direct = nonEmptyString(input.question)
    ?? nonEmptyString(input.prompt)
    ?? nonEmptyString(input.message);
  if (direct) return direct;

  const first = Array.isArray(input.questions) ? input.questions[0] : undefined;
  if (typeof first !== "object" || first === null) return undefined;
  const question = first as Record<string, unknown>;
  return nonEmptyString(question.question)
    ?? nonEmptyString(question.prompt)
    ?? nonEmptyString(question.message);
}

/** Turn a Claude Notification hook into a user-attention signal when the
 * session cannot continue without a human response. */
export function extractManualInputNotice(
  eventName: string,
  data: Record<string, unknown>,
  receivedAt: number = Date.now(),
): ManualInputNotice | null {
  const toolName = extractToolLabel(eventName, data);
  const normalizedToolName = toolName?.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (
    (eventName === "PreToolUse" || eventName === "preToolUse")
    && normalizedToolName
    && MANUAL_INPUT_TOOL_NAMES.has(normalizedToolName)
  ) {
    const question = extractQuestion(data);
    const prompt = isAskUserQuestionTool(toolName) ? promptFromAskUserQuestionInput(data.tool_input) : undefined;
    const stamped = prompt && validAttentionId(data.attentionId) && validAttentionSequence(data.attentionSequence);
    return {
      type: "ask_user",
      title: "Session is asking a question",
      message: question ?? "Open the session to respond.",
      receivedAt: stamped && typeof data.attentionCreatedAt === "string" && Number.isFinite(Date.parse(data.attentionCreatedAt))
        ? Date.parse(data.attentionCreatedAt) : receivedAt,
      ...(prompt ? { prompt } : {}),
      ...(stamped ? { attentionId: data.attentionId as string, attentionSequence: data.attentionSequence as number } : {}),
    };
  }
  if (eventName !== "Notification") return null;
  const type = data.notification_type;
  if (typeof type !== "string" || !MANUAL_INPUT_NOTIFICATION_TYPES.has(type as ManualInputNotice["type"])) {
    return null;
  }
  const prompt = type === "agent_needs_input" ? extractNotificationPrompt(data) : undefined;
  return {
    type: type as ManualInputNotice["type"],
    title: typeof data.title === "string" && data.title.trim() ? data.title : "Session needs your input",
    message: typeof data.message === "string" && data.message.trim()
      ? data.message
      : "Open the session to respond.",
    receivedAt: type === "agent_needs_input" && typeof data.attentionCreatedAt === "string" && Number.isFinite(Date.parse(data.attentionCreatedAt))
      ? Date.parse(data.attentionCreatedAt) : receivedAt,
    ...(type === "agent_needs_input" && typeof data.attentionId === "string" && /^[A-Za-z0-9_-]+$/.test(data.attentionId)
      && typeof data.attentionSequence === "number" && Number.isSafeInteger(data.attentionSequence) && data.attentionSequence > 0
      ? { attentionId: data.attentionId, attentionSequence: data.attentionSequence } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

/** Explicit agent requests outlive tool activity; blocking tool notices keep their legacy lifecycle. */
export function clearsManualInputNotice(
  eventName: string,
  data: Record<string, unknown>,
  currentNotice?: ManualInputNotice,
): boolean {
  // An injected prompt (bridge-typed mail pointer) is not a human answering.
  if ((eventName === "UserPromptSubmit" || eventName === "beforeSubmitPrompt") && data.injected === true) return false;
  // Prompts never auto-clear explicit notices (C1): agent_needs_input, or a
  // question that carries a prompt. Only the snapshot may clear them.
  const isExplicit = !!currentNotice && (currentNotice.type === "agent_needs_input"
    || (currentNotice.type === "ask_user" && !!currentNotice.prompt));
  if ((eventName === "UserPromptSubmit" || eventName === "beforeSubmitPrompt") && isExplicit) return false;
  if (currentNotice?.type === "ask_user" && isDurableNotice(currentNotice)) return false;
  if (eventName === "UserPromptSubmit" || eventName === "beforeSubmitPrompt") return true;
  if (currentNotice?.type === "agent_needs_input") return false;
  if (eventName === "Notification") {
    return data.notification_type === "elicitation_complete"
      || data.notification_type === "elicitation_response";
  }
  return eventName === "PostToolUse"
    || eventName === "postToolUse"
    || eventName === "postToolUseFailure";
}

/** Map Claude (PascalCase) and Cursor (camelCase) hook names to dashboard activity. */
export function hookEventToActivity(eventName: string): HookActivity | null {
  switch (eventName) {
    case "UserPromptSubmit":
    case "beforeSubmitPrompt":
    case "sessionStart":
      return "thinking";
    case "PreToolUse":
    case "preToolUse":
    case "beforeShellExecution":
    case "beforeMCPExecution":
      return "tool_use";
    case "PostToolUse":
    case "postToolUse":
    case "afterShellExecution":
    case "afterFileEdit":
    case "afterMCPExecution":
      return "thinking";
    case "Stop":
    case "stop":
    case "SessionEnd":
    case "sessionEnd":
    case "postToolUseFailure":
      // A cancelled/failed tool means nothing is running; the truthful state is
      // idle regardless of data.is_interrupt.
      return "idle";
    default:
      return null;
  }
}

export function extractToolLabel(
  eventName: string,
  data: Record<string, unknown>
): string | undefined {
  if (typeof data.tool_name === "string") return data.tool_name;
  if (typeof data.toolName === "string") return data.toolName;
  if (eventName === "beforeShellExecution" && typeof data.command === "string") {
    const cmd = data.command.trim();
    return cmd.length > 48 ? `${cmd.slice(0, 45)}...` : cmd;
  }
  return undefined;
}
