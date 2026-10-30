// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageClient, MessageEvents, MessageSubscription } from "@/lib/message-client";
import type { Command, CommandResponse, Session } from "@/types";
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
    act(() => { void h.result.current.clearSessionAttention("agent").catch(() => {}); });
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

// These tests begin from durable RPC state, with no live event required. They
// discriminate reload restoration from a cache or a delivery-only projection.
const saved = { id: "saved-request", sequence: 1, type: "agent_needs_input" as const,
  title: "Saved request", message: "Review the persisted result.", createdAt: "2026-10-24T10:00:00.000Z" };
const newer = { ...saved, id: "newer-request", sequence: 2, title: "Newer request" };
function reply(attention: typeof saved | null, sequence = attention?.sequence ?? 1): CommandResponse {
  return { requestId: "response", success: true, data: { sessionId: "agent", attention, sequence } };
}
function deferred() {
  let resolve!: (value: CommandResponse) => void;
  const promise = new Promise<CommandResponse>(done => { resolve = done; });
  return { promise, resolve };
}
function durableClient() {
  const publications: Array<(event: MessageEvents["publication"]) => void> = [];
  const subscribed: Array<() => void> = [];
  const client: MessageClient = {
    getSubscription: () => null, removeSubscription: () => {},
    newSubscription: () => {
      const sub: MessageSubscription = {
        state: "subscribed", subscribe: () => {}, unsubscribe: () => {},
        publish: async () => {}, presence: async () => ({ clients: {} }),
        on: <K extends keyof MessageEvents>(event: K, listener: (value: MessageEvents[K]) => void) => {
          if (event === "publication") publications.push(listener as (event: MessageEvents["publication"]) => void);
          if (event === "subscribed") subscribed.push(listener as () => void);
          return sub;
        },
        off: () => sub, removeAllListeners: () => {},
      };
      return sub;
    },
  };
  return { client, publications, subscribed };
}
function durableSetup(handle: (command: Command) => Promise<CommandResponse> = async () => reply(saved)) {
  const transport = durableClient();
  const reconnects = new Set<() => void>();
  const rpc = { sendCommand: vi.fn(handle), onSubscribed: (callback: () => void) => {
    reconnects.add(callback); return () => { reconnects.delete(callback); };
  } };
  const hook = renderHook(({ client, user, rows }) => useAllSessionEvents(client, rows, user, rpc), {
    initialProps: { client: transport.client, user: "user", rows: sessions },
  });
  const publish = (eventName: string, data: Record<string, unknown> = {}) => {
    transport.publications.at(-1)!({ data: { type: "hook_event", eventName, data } });
  };
  const publishSaved = (item = saved) => publish("Notification", { notification_type: item.type, title: item.title,
    message: item.message, attentionId: item.id, attentionSequence: item.sequence, attentionCreatedAt: item.createdAt });
  return { ...hook, ...transport, rpc, publish, publishSaved,
    current: () => hook.result.current.sessionActivity.get("agent"),
    reconnect: () => { for (const callback of reconnects) callback(); } };
}
async function settle() { await act(async () => { await Promise.resolve(); }); }

describe("durable explicit attention restoration", () => {
  it("does not dispatch a queued old-owner read during replacement render before passive cleanup", async () => {
    const queued: Array<() => void> = [];
    const microtask = vi.spyOn(globalThis, "queueMicrotask").mockImplementation(callback => { queued.push(callback); });
    try {
      const old = durableClient(); const replacement = durableClient();
      const oldRpc = { sendCommand: vi.fn(async () => reply(saved)), onSubscribed: () => () => {} };
      const newRpc = { sendCommand: vi.fn(async () => reply(newer)), onSubscribed: () => () => {} };
      const hook = renderHook(({ client, user, rpc }) => {
        const result = useAllSessionEvents(client, sessions, user, rpc);
        useLayoutEffect(() => { if (user === "other-user") queued.splice(0).forEach(callback => callback()); }, [user]);
        return result;
      }, { initialProps: { client: old.client, user: "user", rpc: oldRpc } });
      expect(queued).toHaveLength(1);
      hook.rerender({ client: replacement.client, user: "other-user", rpc: newRpc });
      expect(oldRpc.sendCommand).not.toHaveBeenCalled();
      expect(newRpc.sendCommand).not.toHaveBeenCalled();
      await act(async () => { queued.splice(0).forEach(callback => callback()); await Promise.resolve(); });
      expect(newRpc.sendCommand).toHaveBeenCalledTimes(1);
      expect(hook.result.current.sessionActivity.get("agent")?.attention?.attentionId).toBe(newer.id);
      hook.unmount();
    } finally { microtask.mockRestore(); }
  });

  it("bounds eighty overlapping prompts to one pending and one trailing snapshot", async () => {
    const first = deferred(); const trailing = deferred();
    let reads = 0;
    const h = durableSetup(() => ++reads === 1 ? first.promise : trailing.promise);
    await settle();
    act(() => { for (let i = 0; i < 80; i++) h.publish("UserPromptSubmit"); });
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(reply(saved)));
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(2);
    expect(h.current()?.attention).toBeUndefined();
    await act(async () => trailing.resolve(reply(null)));
    expect(h.current()?.attention).toBeUndefined();
  });

  it("coalesces startup subscription notifications and a burst of pending prompts", async () => {
    const first = deferred(); const trailing = deferred();
    let reads = 0;
    const h = durableSetup(() => ++reads === 1 ? first.promise : trailing.promise);
    act(() => h.subscribed[0]());
    await settle();
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(1);
    act(() => { for (let i = 0; i < 80; i++) h.publish(i % 2 ? "UserPromptSubmit" : "beforeSubmitPrompt"); });
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(reply(saved)));
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(2);
    expect(h.current()?.attention).toBeUndefined();
    await act(async () => trailing.resolve(reply(null)));
    expect(h.current()?.attention).toBeUndefined();
    act(() => h.publish("UserPromptSubmit"));
    await settle();
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(3);
  });

  it("fences a pending snapshot on reconnect and runs a fresh trailing read after failure", async () => {
    const first = deferred(); const trailing = deferred();
    let reads = 0;
    const h = durableSetup(() => ++reads === 1 ? first.promise : trailing.promise);
    await settle();
    act(() => h.reconnect());
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(reply(saved)));
    expect(h.current()?.attention).toBeUndefined();
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(2);
    await act(async () => trailing.resolve(reply(null)));
    expect(h.current()?.attention).toBeUndefined();
    h.unmount();

    let reject!: (error: Error) => void;
    const failed = new Promise<CommandResponse>((_, fail) => { reject = fail; });
    let attempts = 0;
    const next = durableSetup(() => ++attempts === 1 ? failed : Promise.resolve(reply(saved)));
    await settle();
    act(() => next.publish("UserPromptSubmit"));
    await act(async () => reject(new Error("offline")));
    expect(next.rpc.sendCommand).toHaveBeenCalledTimes(2);
    expect(next.current()?.attention?.attentionId).toBe(saved.id);
  });

  it("does not send a dirty trailing read after unmount", async () => {
    const read = deferred();
    const h = durableSetup(() => read.promise);
    await settle();
    act(() => h.publish("UserPromptSubmit"));
    h.unmount();
    await act(async () => read.resolve(reply(saved)));
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(1);
  });

  it("keeps an old owner's completion from affecting a replacement session subscription", async () => {
    const old = deferred(); const fresh = deferred();
    let reads = 0;
    const h = durableSetup(() => ++reads === 1 ? old.promise : fresh.promise);
    await settle();
    act(() => h.publish("UserPromptSubmit"));
    h.rerender({ client: h.client, user: "user", rows: [] });
    h.rerender({ client: h.client, user: "user", rows: sessions });
    await settle();
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve(reply(saved)));
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(2);
    expect(h.current()?.attention).toBeUndefined();
    await act(async () => fresh.resolve(reply(newer)));
    expect(h.current()?.attention?.attentionId).toBe(newer.id);
  });

  it("restores a persisted explicit request on a fresh mount without a live publication", async () => {
    const first = durableSetup();
    await settle();
    expect(first.current()?.attention).toMatchObject({ attentionId: saved.id, attentionSequence: 1,
      receivedAt: Date.parse(saved.createdAt), message: saved.message });
    expect(first.rpc.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "get_session_attention",
      payload: { bridgeId: "bridge", sessionId: "agent" } }));
    first.unmount();
    const reopened = durableSetup();
    await settle();
    expect(reopened.current()?.attention).toMatchObject({ attentionId: saved.id, receivedAt: Date.parse(saved.createdAt) });
  });

  it.each(["PostToolUse", "Stop"])("restores a pending snapshot despite ordinary %s activity", async event => {
    const read = deferred();
    const h = durableSetup(() => read.promise);
    act(() => h.publish(event, { tool_name: "exec_command" }));
    await act(async () => read.resolve(reply(saved)));
    expect(h.current()).toMatchObject({ activity: event === "Stop" ? "idle" : "thinking", attention: { attentionId: saved.id } });
  });

  it.each(["UserPromptSubmit", "beforeSubmitPrompt"])("a %s fences a delayed saved request", async event => {
    const read = deferred();
    let reads = 0;
    const h = durableSetup(() => ++reads === 1 ? read.promise : Promise.resolve(reply(null)));
    await settle(); // Dispatch the snapshot before delivering the prompt.
    act(() => { h.publish(event); h.publishSaved(); });
    await act(async () => read.resolve(reply(saved)));
    expect(h.current()?.attention).toBeUndefined();
  });

  it("canonical null rejects an old recovered publication after restoration", async () => {
    const h = durableSetup(async () => reply(null));
    await settle();
    act(() => h.publishSaved());
    expect(h.current()?.attention).toBeUndefined();
  });

  it("canonical null removes a replay delivered while the first snapshot is pending", async () => {
    const read = deferred();
    const h = durableSetup(() => read.promise);
    act(() => h.publishSaved());
    expect(h.current()?.attention?.attentionId).toBe(saved.id);
    await act(async () => read.resolve(reply(null)));
    expect(h.current()?.attention).toBeUndefined();
  });

  it("does not replace a fresh legacy notice with a delayed explicit snapshot", async () => {
    const read = deferred();
    const h = durableSetup(() => read.promise);
    act(() => h.publish("Notification", { notification_type: "permission_prompt", message: "Approve tool access" }));
    await act(async () => read.resolve(reply(saved)));
    expect(h.current()?.attention).toMatchObject({ type: "permission_prompt", message: "Approve tool access" });
  });

  it("preserves a newer live request over a delayed snapshot and older duplicate", async () => {
    const read = deferred();
    const h = durableSetup(() => read.promise);
    act(() => h.publishSaved(newer));
    await act(async () => read.resolve(reply(saved)));
    act(() => h.publishSaved());
    expect(h.current()?.attention?.attentionId).toBe(newer.id);
  });

  it("reconnect reconciles resolved state and a prompt retires the canonical replay exception", async () => {
    let response = reply(saved);
    const h = durableSetup(async () => response);
    await settle();
    response = reply(null);
    act(() => h.publish("UserPromptSubmit"));
    await settle();
    act(() => h.publishSaved());
    expect(h.current()?.attention).toBeUndefined();
    act(() => h.reconnect());
    await settle();
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(3);
    expect(h.current()?.attention).toBeUndefined();
  });

  it.each(["UserPromptSubmit", "beforeSubmitPrompt"])("preserves a newer restored request when an older %s publication arrives later", async event => {
    const reread = deferred();
    let reads = 0;
    const h = durableSetup(() => ++reads === 1 ? Promise.resolve(reply(newer)) : reread.promise);
    await settle();
    expect(h.current()?.attention?.attentionId).toBe(newer.id);
    act(() => h.publish(event));
    expect(h.current()?.attention?.attentionId).toBe(newer.id);
    await act(async () => reread.resolve(reply(newer)));
    expect(h.current()?.attention?.attentionId).toBe(newer.id);
    act(() => h.publishSaved(newer));
    expect(h.current()?.attention?.attentionId).toBe(newer.id);
  });

  it("retains a failed dismissal and persists successful dismissal across remount", async () => {
    let current: typeof saved | null = saved;
    let fail = true;
    const handle = async (command: Command) => {
      if (command.type === "resolve_session_attention") {
        if (fail) return { requestId: command.requestId, success: false, error: "disk unavailable" };
        current = null;
      }
      return reply(current);
    };
    const h = durableSetup(handle);
    await settle();
    act(() => { void h.result.current.clearSessionAttention("agent").catch(() => {}); });
    await settle();
    expect(h.current()?.attention?.attentionId).toBe(saved.id);
    act(() => h.publishSaved());
    expect(h.current()?.attention?.attentionId).toBe(saved.id);
    fail = false;
    act(() => { void h.result.current.clearSessionAttention("agent").catch(() => {}); });
    await settle();
    expect(h.rpc.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "resolve_session_attention",
      payload: { bridgeId: "bridge", sessionId: "agent", eventId: saved.id } }));
    act(() => h.publishSaved());
    expect(h.current()?.attention).toBeUndefined();
    h.unmount();
    const reopened = durableSetup(handle);
    await settle();
    expect(reopened.current()?.attention).toBeUndefined();
  });

  it("does not clear a newer request when an earlier dismissal finishes", async () => {
    const write = deferred();
    const h = durableSetup(command => command.type === "resolve_session_attention" ? write.promise : Promise.resolve(reply(saved)));
    await settle();
    act(() => { void h.result.current.clearSessionAttention("agent").catch(() => {}); });
    act(() => h.publishSaved(newer));
    await act(async () => write.resolve(reply(null)));
    expect(h.current()?.attention?.attentionId).toBe(newer.id);
  });

  it("drops stale reads and retained publication/subscribed callbacks after an account and client switch", async () => {
    const read = deferred();
    const h = durableSetup(() => read.promise);
    const oldPublication = h.publications[0];
    const oldSubscribed = h.subscribed[0];
    const replacement = durableClient();
    h.rerender({ client: replacement.client, user: "other-user", rows: sessions });
    const count = h.rpc.sendCommand.mock.calls.length;
    act(() => {
      oldPublication({ data: { type: "hook_event", eventName: "Notification", data: request } });
      oldSubscribed();
    });
    expect(h.rpc.sendCommand).toHaveBeenCalledTimes(count);
    expect(h.current()?.attention).toBeUndefined();
    h.rerender({ client: replacement.client, user: "other-user", rows: [] });
    await act(async () => read.resolve(reply(saved)));
    expect(h.current()).toBeUndefined();
  });

  it("degrades to live-only with an older bridge and preserves legacy lifecycles", async () => {
    const h = durableSetup(async () => { throw new Error("unknown command"); });
    await settle();
    act(() => h.publish("Notification", request));
    expect(h.current()?.attention?.type).toBe("agent_needs_input");
    act(() => { void h.result.current.clearSessionAttention("agent").catch(() => {}); });
    expect(h.current()?.attention).toBeUndefined();
    act(() => h.publish("Notification", { notification_type: "permission_prompt", message: "Permission needed" }));
    act(() => h.publish("PostToolUse"));
    expect(h.current()?.attention).toBeUndefined();
  });
});

it("rejects a stale captured notice before sending a durable dismissal", async () => {
  const h = durableSetup(async () => reply(saved)); await settle();
  const previous = h.current()!.attention!; act(() => h.publishSaved(newer));
  const before = h.rpc.sendCommand.mock.calls.length;
  await expect(h.result.current.clearSessionAttention("agent", previous)).rejects.toThrow("changed");
  expect(h.rpc.sendCommand).toHaveBeenCalledTimes(before); expect(h.current()?.attention?.attentionId).toBe(newer.id);
});
it("rejects a failed stamped dismissal and retains the captured notice", async () => {
  const h = durableSetup(command => command.type === "resolve_session_attention" ? Promise.resolve({ requestId: command.requestId, success: false }) : Promise.resolve(reply(saved)));
  await settle(); const captured = h.current()!.attention!;
  await expect(h.result.current.clearSessionAttention("agent", captured)).rejects.toThrow("Could not dismiss");
  expect(h.current()?.attention?.attentionId).toBe(saved.id);
});

it("rejects a durable dismissal in the client/user switch window before any RPC", async () => {
  const old = durableClient(), replacement = durableClient(); const rpc = { sendCommand: vi.fn(async (_command: Command) => reply(saved)), onSubscribed: () => () => {} };
  let captured: ReturnType<typeof restoredForTest> | undefined; let attempt: Promise<unknown> | undefined;
  function restoredForTest() { return { type: "agent_needs_input" as const, title: saved.title, message: saved.message, receivedAt: Date.parse(saved.createdAt), attentionId: saved.id, attentionSequence: saved.sequence }; }
  const hook = renderHook(({ client, user }) => {
    const result = useAllSessionEvents(client, sessions, user, rpc);
    useLayoutEffect(() => { if (user === "other" && captured) attempt = result.clearSessionAttention("agent", captured).catch(error => error); }, [user, result.clearSessionAttention]);
    return result;
  }, { initialProps: { client: old.client, user: "user" } });
  await settle(); captured = restoredForTest(); expect(hook.result.current.sessionActivity.get("agent")?.attention).toEqual(captured);
  hook.rerender({ client: replacement.client, user: "other" });
  expect(attempt).toBeDefined(); expect((await attempt) as Error).toMatchObject({ message: expect.stringContaining("changed") });
  expect(rpc.sendCommand.mock.calls.filter(([command]) => command.type === "resolve_session_attention")).toHaveLength(0);
});
it("rejects an old ephemeral dismissal during account change and preserves the new account's matching notice", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1234);
  try {
    const transport = durableClient(); const rpc = { sendCommand: vi.fn(async () => reply(null)), onSubscribed: () => () => {} };
    let captured: import("@/lib/hook-events").ManualInputNotice | undefined; let attempt: Promise<unknown> | undefined;
    const hook = renderHook(({ user }) => {
      const result = useAllSessionEvents(transport.client, sessions, user, rpc);
      useLayoutEffect(() => { if (user === "other" && captured) attempt = result.clearSessionAttention("agent", captured).catch(error => error); }, [user, result.clearSessionAttention]);
      return result;
    }, { initialProps: { user: "user" } });
    await settle(); act(() => transport.publications.at(-1)!({ data: { type: "hook_event", eventName: "Notification", data: request } }));
    captured = hook.result.current.sessionActivity.get("agent")?.attention; expect(captured).toBeDefined();
    hook.rerender({ user: "other" }); expect((await attempt) as Error).toMatchObject({ message: expect.stringContaining("changed") });
    await settle(); act(() => transport.publications.at(-1)!({ data: { type: "hook_event", eventName: "Notification", data: request } }));
    expect(hook.result.current.sessionActivity.get("agent")?.attention).toEqual(captured);
  } finally { now.mockRestore(); }
});
