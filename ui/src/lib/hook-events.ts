export type HookActivity = "thinking" | "tool_use" | "idle";

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
