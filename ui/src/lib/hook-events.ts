export type HookActivity = "thinking" | "tool_use" | "idle";

export interface ManualInputNotice {
  type: "permission_prompt" | "elicitation_dialog" | "agent_needs_input" | "ask_user";
  title: string;
  message: string;
  receivedAt: number;
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
    return {
      type: "ask_user",
      title: "Session is asking a question",
      message: question ?? "Open the session to respond.",
      receivedAt,
    };
  }
  if (eventName !== "Notification") return null;
  const type = data.notification_type;
  if (typeof type !== "string" || !MANUAL_INPUT_NOTIFICATION_TYPES.has(type as ManualInputNotice["type"])) {
    return null;
  }
  return {
    type: type as ManualInputNotice["type"],
    title: typeof data.title === "string" && data.title.trim() ? data.title : "Session needs your input",
    message: typeof data.message === "string" && data.message.trim()
      ? data.message
      : "Open the session to respond.",
    receivedAt,
  };
}

/** Hooks that prove a previously blocking manual-input interaction has moved on. */
export function clearsManualInputNotice(
  eventName: string,
  data: Record<string, unknown>,
): boolean {
  if (eventName === "UserPromptSubmit" || eventName === "beforeSubmitPrompt") return true;
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
