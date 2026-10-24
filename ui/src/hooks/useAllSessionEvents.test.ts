// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageClient, MessageEvents, MessageSubscription } from "@/lib/message-client";
import type { Session } from "@/types";
import { useAllSessionEvents } from "./useAllSessionEvents";

const sessions: Session[] = [{ id: "agent", name: "Agent", bridgeId: "bridge", status: "running", createdAt: "2026-10-23", updatedAt: "2026-10-23" }];
const request = { notification_type: "agent_needs_input", title: "Work complete", message: "Review the result and checks." };

function setup() {
  const listeners = new Map<string, (event: MessageEvents["publication"]) => void>();
  const client: MessageClient = {
    getSubscription: () => null,
    newSubscription: (channel) => {
      const sub: MessageSubscription = {
        state: "subscribed",
        subscribe: () => {}, unsubscribe: () => {},
        publish: async () => {}, presence: async () => ({ clients: {} }),
        on: <K extends keyof MessageEvents>(event: K, listener: (value: MessageEvents[K]) => void) => {
          if (event === "publication") listeners.set(channel, listener as (event: MessageEvents["publication"]) => void);
          return sub;
        },
        off: () => sub,
        removeAllListeners: () => { listeners.delete(channel); },
      };
      return sub;
    },
    removeSubscription: () => {},
  };
  const hook = renderHook(() => useAllSessionEvents(client, sessions, "user"));
  // Deliberately leave act to the test: two synchronous publications must share
  // one React batch, rather than hiding a stale-notice bug behind separate renders.
  const publish = (eventName: string, data: Record<string, unknown> = {}) => {
    const listener = listeners.get("events:agent#user");
    expect(listener).toBeDefined();
    listener!({ data: { type: "hook_event", eventName, data } });
  };
  const current = () => hook.result.current.sessionActivity.get("agent");
  return { ...hook, publish, current };
}

afterEach(cleanup);

describe("explicit agent attention through actual hook subscriptions", () => {
  it.each([
    { event: "PostToolUse", data: { tool_name: "Bash" }, activity: "thinking" },
    { event: "postToolUse", data: { toolName: "Shell" }, activity: "thinking" },
    { event: "postToolUseFailure", data: { toolName: "Shell" }, activity: "idle" },
    { event: "Notification", data: { notification_type: "elicitation_complete" }, activity: "idle" },
    { event: "Notification", data: { notification_type: "elicitation_response" }, activity: "idle" },
  ])("retains a same-batch request followed by $event ($activity)", ({ event, data, activity }) => {
    const h = setup();
    act(() => {
      h.publish("Notification", request);
      h.publish(event, data);
    });
    expect(h.current()).toMatchObject({ activity, attention: { type: "agent_needs_input", title: "Work complete", message: request.message } });
  });

  it("keeps attention while tool start, completion and failure still update activity", () => {
    const h = setup();
    act(() => h.publish("Notification", request));
    const notice = h.current()?.attention;
    act(() => h.publish("PreToolUse", { tool_name: "Bash" }));
    expect(h.current()).toEqual({ activity: "tool_use", toolName: "Bash", attention: notice });
    act(() => h.publish("PostToolUse", { tool_name: "Bash" }));
    expect(h.current()).toEqual({ activity: "thinking", toolName: undefined, attention: notice });
    act(() => h.publish("postToolUseFailure", { toolName: "Bash" }));
    expect(h.current()).toEqual({ activity: "idle", toolName: undefined, attention: notice });
  });

  it.each(["UserPromptSubmit", "beforeSubmitPrompt"])("clears explicit attention on %s, including same-batch events", (event) => {
    const h = setup();
    act(() => { h.publish("Notification", request); h.publish(event); });
    expect(h.current()?.attention).toBeUndefined();
    expect(h.current()?.activity).toBe("thinking");
  });

  it("retains explicit manual dismissal and optimistic idle behavior", () => {
    const h = setup();
    act(() => { h.publish("Notification", request); h.publish("PreToolUse", { tool_name: "Bash" }); });
    act(() => h.result.current.markSessionIdle("agent"));
    expect(h.current()).toMatchObject({ activity: "idle", attention: { type: "agent_needs_input" } });
    act(() => h.result.current.clearSessionAttention("agent"));
    expect(h.current()?.attention).toBeUndefined();
    expect(h.current()?.activity).toBe("idle");
  });

  it.each(["permission_prompt", "elicitation_dialog", "ask_user"])("preserves completed-tool clearing for legacy %s", (type) => {
    const h = setup();
    act(() => {
      if (type === "ask_user") h.publish("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { question: "Which branch?" } });
      else h.publish("Notification", { notification_type: type, message: "Choose an option" });
    });
    expect(h.current()?.attention?.type).toBe(type);
    act(() => h.publish("PostToolUse", { tool_name: "Bash" }));
    expect(h.current()?.attention).toBeUndefined();
    expect(h.current()?.activity).toBe("thinking");
  });

  it("clears elicitation on its completion notification without changing existing activity", () => {
    const h = setup();
    act(() => { h.publish("PreToolUse", { tool_name: "Bash" }); h.publish("Notification", { notification_type: "elicitation_dialog" }); });
    expect(h.current()?.attention?.type).toBe("elicitation_dialog");
    act(() => h.publish("Notification", { notification_type: "elicitation_complete" }));
    expect(h.current()).toEqual({ activity: "tool_use", toolName: "Bash", attention: undefined });
  });
});
