import { describe, expect, it } from "vitest";

import { clearsManualInputNotice, extractManualInputNotice, hookEventToActivity, type ManualInputNotice } from "./hook-events";

describe("extractManualInputNotice", () => {
  it("uses committed ledger identity and creation time rather than a harness notification id", () => {
    const notice = extractManualInputNotice("Notification", { notification_type: "agent_needs_input", notification_id: "harness-id",
      attentionId: "ledger-id", attentionSequence: 2, attentionCreatedAt: "2026-10-24T10:00:00Z", message: "Review" }, 999);
    expect(notice).toMatchObject({ attentionId: "ledger-id", attentionSequence: 2, receivedAt: Date.parse("2026-10-24T10:00:00Z") });
    expect(extractManualInputNotice("Notification", { notification_type: "agent_needs_input", notification_id: "harness-id" }, 999)).not.toHaveProperty("attentionId");
  });
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

  it.each([
    {
      harness: "Codex",
      eventName: "PreToolUse",
      data: {
        tool_name: "request_user_input",
        tool_input: { questions: [{ question: "Which branch should I use?" }] },
      },
      question: "Which branch should I use?",
    },
    {
      harness: "Cursor",
      eventName: "preToolUse",
      data: {
        toolName: "AskQuestion",
        toolInput: { prompt: "Approve this migration?" },
      },
      question: "Approve this migration?",
    },
    {
      harness: "Pi",
      eventName: "PreToolUse",
      data: {
        tool_name: "ftown_ask_user",
        tool_input: { question: "Which environment should I deploy?" },
      },
      question: "Which environment should I deploy?",
    },
  ])("recognizes $harness ask tools and their native input shapes", ({ eventName, data, question }) => {
    expect(extractManualInputNotice(eventName, data, 900)).toMatchObject({
      type: "ask_user",
      message: question,
      receivedAt: 900,
    });
  });

  it("does not treat ordinary tools as manual input", () => {
    expect(extractManualInputNotice("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    })).toBeNull();
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

describe("current attention lifecycle", () => {
  const notice = (type: ManualInputNotice["type"]): ManualInputNotice => ({ type, title: "Input", message: "Review this", receivedAt: 1 });

  it.each(["PostToolUse", "postToolUse", "postToolUseFailure"])("keeps explicit agent attention after %s", (event) => {
    expect(clearsManualInputNotice(event, { tool_name: "Bash" }, notice("agent_needs_input"))).toBe(false);
  });

  it.each(["elicitation_complete", "elicitation_response"])("keeps explicit agent attention after unrelated %s", (notification_type) => {
    expect(clearsManualInputNotice("Notification", { notification_type }, notice("agent_needs_input"))).toBe(false);
  });

  it.each(["UserPromptSubmit", "beforeSubmitPrompt"])("lets %s clear every existing notice type", (event) => {
    for (const type of ["agent_needs_input", "permission_prompt", "elicitation_dialog", "ask_user"] as const) {
      expect(clearsManualInputNotice(event, {}, notice(type))).toBe(true);
    }
  });

  it.each(["permission_prompt", "elicitation_dialog", "ask_user"] as const)("preserves the legacy %s tool-completion lifecycle", (type) => {
    for (const event of ["PostToolUse", "postToolUse", "postToolUseFailure"]) {
      expect(clearsManualInputNotice(event, {}, notice(type))).toBe(true);
    }
    expect(clearsManualInputNotice("Notification", { notification_type: "elicitation_complete" }, notice(type))).toBe(true);
  });
});

describe("hookEventToActivity", () => {
  it("keeps the existing activity mapping intact", () => {
    expect(hookEventToActivity("UserPromptSubmit")).toBe("thinking");
    expect(hookEventToActivity("PreToolUse")).toBe("tool_use");
    expect(hookEventToActivity("Stop")).toBe("idle");
  });
});

describe("structured prompts", () => {
  const question = { question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] };
  const mailPrompt = { channel: "mail", questions: [{ question: "Which?", options: [{ label: "A" }], multiSelect: false, allowText: false }] };

  it("takes a valid mail attentionPrompt from an explicit request", () => {
    const notice = extractManualInputNotice("Notification", { notification_type: "agent_needs_input", message: "m", attentionPrompt: mailPrompt }, 1);
    expect(notice?.prompt).toMatchObject({ channel: "mail", questions: [{ question: "Which?" }] });
  });

  it("ignores an invalid or non-request attentionPrompt", () => {
    const base = { notification_type: "agent_needs_input", message: "m" };
    expect(extractManualInputNotice("Notification", { ...base, attentionPrompt: { channel: "mail", questions: [] } }, 1)).not.toHaveProperty("prompt");
    expect(extractManualInputNotice("Notification", { ...base, attentionPrompt: "x" }, 1)).not.toHaveProperty("prompt");
    expect(extractManualInputNotice("Notification", { notification_type: "permission_prompt", attentionPrompt: mailPrompt }, 1)).not.toHaveProperty("prompt");
  });

  it("derives a hook prompt and stamp from AskUserQuestion", () => {
    const notice = extractManualInputNotice("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { questions: [question] },
      attentionId: "a1", attentionSequence: 3, attentionCreatedAt: "2026-10-24T10:00:00Z" }, 9);
    expect(notice).toMatchObject({ type: "ask_user", message: "Which?", attentionId: "a1", attentionSequence: 3,
      receivedAt: Date.parse("2026-10-24T10:00:00Z"), prompt: { channel: "hook" } });
  });

  it("keeps the legacy notice when the question has no parseable prompt or no stamp", () => {
    const legacy = extractManualInputNotice("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { question: "Hi?" } }, 9);
    expect(legacy).toEqual({ type: "ask_user", title: "Session is asking a question", message: "Hi?", receivedAt: 9 });
    const unstamped = extractManualInputNotice("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { questions: [question] } }, 9);
    expect(unstamped).toMatchObject({ prompt: { channel: "hook" }, receivedAt: 9 });
    expect(unstamped).not.toHaveProperty("attentionId");
  });

  it("never clears a stamped question locally; the bridge resolves it", () => {
    const notice: ManualInputNotice = { type: "ask_user", title: "t", message: "m", receivedAt: 1, attentionId: "a1", attentionSequence: 1,
      prompt: { channel: "hook", questions: [{ question: "Q", options: [{ label: "A" }], multiSelect: false, allowText: false }] } };
    expect(clearsManualInputNotice("PostToolUse", { tool_name: "Bash" }, notice)).toBe(false);
    expect(clearsManualInputNotice("PostToolUse", { tool_name: "AskUserQuestion" }, notice)).toBe(false);
    expect(clearsManualInputNotice("UserPromptSubmit", {}, notice)).toBe(false);
    expect(clearsManualInputNotice("PostToolUse", { tool_name: "Bash" }, { ...notice, prompt: undefined })).toBe(true);
  });

  it("accepts a mail attentionPrompt with unknown extra keys and rejects a hook-channel one", () => {
    const extra = { channel: "mail", future: 1, questions: [{ question: "Q", future: true, options: [{ label: "A", future: 1 }], multiSelect: false, allowText: false }] };
    const base = { notification_type: "agent_needs_input", message: "m" };
    expect(extractManualInputNotice("Notification", { ...base, attentionPrompt: extra }, 1)?.prompt?.questions[0].options).toEqual([{ label: "A" }]);
    expect(extractManualInputNotice("Notification", { ...base, attentionPrompt: { ...extra, channel: "hook" } }, 1)).not.toHaveProperty("prompt");
  });
});
