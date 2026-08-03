import { describe, expect, it } from "vitest";

import { clearsManualInputNotice, extractManualInputNotice, hookEventToActivity } from "./hook-events";

describe("extractManualInputNotice", () => {
  it.each(["permission_prompt", "elicitation_dialog", "agent_needs_input"])(
    "recognizes %s as requiring human input",
    (notificationType) => {
      expect(extractManualInputNotice("Notification", {
        notification_type: notificationType,
        title: "Input needed",
        message: "Choose an option",
      }, 123)).toEqual({
        type: notificationType,
        title: "Input needed",
        message: "Choose an option",
        receivedAt: 123,
      });
    },
  );

  it("ignores notifications that do not block on a user response", () => {
    expect(extractManualInputNotice("Notification", {
      notification_type: "auth_success",
      message: "Signed in",
    })).toBeNull();
    expect(extractManualInputNotice("Stop", {
      notification_type: "permission_prompt",
    })).toBeNull();
  });

  it("provides readable fallback copy", () => {
    expect(extractManualInputNotice("Notification", {
      notification_type: "agent_needs_input",
    }, 456)).toMatchObject({
      title: "Session needs your input",
      message: "Open the session to respond.",
      receivedAt: 456,
    });
  });

  it("recognizes an AskUserQuestion tool call and exposes its first question", () => {
    expect(extractManualInputNotice("PreToolUse", {
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which deployment should I use?" }] },
    }, 789)).toEqual({
      type: "ask_user",
      title: "Session is asking a question",
      message: "Which deployment should I use?",
      receivedAt: 789,
    });
  });
});

describe("clearsManualInputNotice", () => {
  it("clears after a submitted prompt, completed tool, or elicitation resolution", () => {
    expect(clearsManualInputNotice("UserPromptSubmit", {})).toBe(true);
    expect(clearsManualInputNotice("PostToolUse", { tool_name: "AskUserQuestion" })).toBe(true);
    expect(clearsManualInputNotice("PostToolUse", { tool_name: "Bash" })).toBe(true);
    expect(clearsManualInputNotice("postToolUseFailure", { toolName: "Bash" })).toBe(true);
    expect(clearsManualInputNotice("Notification", { notification_type: "elicitation_complete" })).toBe(true);
  });
});

describe("hookEventToActivity", () => {
  it("keeps the existing activity mapping intact", () => {
    expect(hookEventToActivity("UserPromptSubmit")).toBe("thinking");
    expect(hookEventToActivity("PreToolUse")).toBe("tool_use");
    expect(hookEventToActivity("Stop")).toBe("idle");
  });
});
