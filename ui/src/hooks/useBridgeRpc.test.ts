import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRpcCore } from "./useBridgeRpc";
import type { Command, CommandResponse } from "@/types";
import type { MessagePublishOptions } from "@/lib/message-client";

const cmd = (requestId: string, type: Command["type"] = "list_sessions"): Command => ({
  type,
  payload: {},
  requestId,
});

const resp = (requestId: string, overrides: Partial<CommandResponse> = {}): CommandResponse => ({
  requestId,
  success: true,
  ...overrides,
});

describe("createRpcCore", () => {
  let published: Command[];
  let core: ReturnType<typeof createRpcCore>;

  beforeEach(() => {
    vi.useFakeTimers();
    published = [];
    core = createRpcCore((command) => published.push(command));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("sendCommand", () => {
    it("passes its absolute deadline and aborts queued transport work when the caller times out", async () => {
      let admission: MessagePublishOptions | undefined;
      const timed = createRpcCore((_command, options) => { admission = options; }, 100);
      const start = Date.now(); const pending = timed.sendCommand(cmd("late"));
      expect(admission?.deadline).toBe(start + 100); expect(admission?.signal?.aborted).toBe(false);
      const rejected = expect(pending).rejects.toThrow('timed out'); await vi.advanceTimersByTimeAsync(100); await rejected;
      expect(admission?.signal?.aborted).toBe(true);
    });
    it("rejects asynchronous encryption/approval failures immediately and clears pending timeouts", async () => {
      const unavailable = createRpcCore(() => Promise.reject(new Error("approval_required")));
      await expect(unavailable.sendCommand(cmd("blocked"))).rejects.toThrow("approval_required");
      expect(vi.getTimerCount()).toBe(0);
      unavailable.handleResponse(resp("blocked"));
    });

    it("captures synchronous publisher failures without leaving a timeout", async () => {
      const unavailable = createRpcCore(() => { throw new Error("closed"); });
      await expect(unavailable.sendCommand(cmd("blocked"))).rejects.toThrow("closed");
      expect(vi.getTimerCount()).toBe(0);
    });
    it("publishes the command and resolves with the first matching response", async () => {
      const promise = core.sendCommand(cmd("r1"));
      expect(published).toEqual([cmd("r1")]);

      core.handleResponse(resp("r1", { data: { ok: true } }));
      await expect(promise).resolves.toEqual(resp("r1", { data: { ok: true } }));
    });

    it("resolves failure responses too (caller inspects success)", async () => {
      const promise = core.sendCommand(cmd("r1", "create_session"));
      core.handleResponse(resp("r1", { success: false, error: "boom" }));
      await expect(promise).resolves.toMatchObject({ success: false, error: "boom" });
    });

    it("accepts a legitimate create_session response without retrying", async () => {
      const pending = core.sendCommand(cmd("create-ok", "create_session"));
      core.handleResponse(resp("create-ok", { data: { sessionId: "session-1" } }));
      await expect(pending).resolves.toMatchObject({ success: true, data: { sessionId: "session-1" } });
      expect(published).toHaveLength(1);
    });

    it("retries bridge_starting with bounded backoff, then resolves the next response", async () => {
      const pending = core.sendCommand(cmd("starting", "create_session"));
      for (const [index, delay] of [250, 500, 1000, 2000].entries()) {
        core.handleResponse(resp(published.at(-1)!.requestId, { success: false, error: "Bridge is starting", data: { code: "bridge_starting", retryable: true } }));
        await vi.advanceTimersByTimeAsync(delay);
        expect(published).toHaveLength(index + 2);
        expect(published.at(-1)).toMatchObject({ type: published[0].type, payload: published[0].payload });
        expect(published.at(-1)?.requestId).not.toBe(published.at(-2)?.requestId);
      }
      core.handleResponse(resp(published.at(-1)!.requestId, { data: { ready: true } }));
      await expect(pending).resolves.toMatchObject({ requestId: "starting", success: true, data: { ready: true } });
    });

    it("returns bridge_starting after the bounded retry window", async () => {
      const pending = core.sendCommand(cmd("exhausted"));
      for (const delay of [250, 500, 1000, 2000]) {
        core.handleResponse(resp(published.at(-1)!.requestId, { success: false, error: "Bridge is starting", data: { code: "bridge_starting", retryable: true } }));
        await vi.advanceTimersByTimeAsync(delay);
      }
      core.handleResponse(resp(published.at(-1)!.requestId, { success: false, error: "Bridge is starting", data: { code: "bridge_starting", retryable: true } }));
      await expect(pending).resolves.toMatchObject({ success: false, data: { code: "bridge_starting" } });
      expect(published).toHaveLength(5);
    });

    it("can disable shared retries for callers with their own retry policy", async () => {
      const pending = core.sendCommand(cmd("starting"), { retryBridgeStarting: false });
      core.handleResponse(resp("starting", { success: false, error: "Bridge is starting", data: { code: "bridge_starting", retryable: true } }));
      await expect(pending).resolves.toMatchObject({ success: false, data: { code: "bridge_starting" } });
      await vi.advanceTimersByTimeAsync(5000);
      expect(published).toHaveLength(1);
    });

    it("does not retry other typed command failures", async () => {
      const pending = core.sendCommand(cmd("denied"));
      core.handleResponse(resp("denied", { success: false, data: { code: "permission_denied" } }));
      await expect(pending).resolves.toMatchObject({ success: false, data: { code: "permission_denied" } });
      await vi.advanceTimersByTimeAsync(1000);
      expect(published).toHaveLength(1);
    });

    it("does not retry refusal-shaped codes without the exact not-ready response", async () => {
      const pending = core.sendCommand(cmd("refused"));
      core.handleResponse(resp("refused", { success: false, error: "Encrypted request rejected", data: { code: "permission_denied" } }));
      await expect(pending).resolves.toMatchObject({ success: false, error: "Encrypted request rejected", data: { code: "permission_denied" } });
      await vi.advanceTimersByTimeAsync(5000);
      expect(published).toHaveLength(1);
    });

    it("ignores responses for other requestIds", async () => {
      const promise = core.sendCommand(cmd("r1"));
      core.handleResponse(resp("other"));
      core.handleResponse(resp("r1"));
      await expect(promise).resolves.toMatchObject({ requestId: "r1" });
    });

    it("rejects with '<type> timed out' after 30s and stops listening", async () => {
      const promise = core.sendCommand(cmd("r1", "create_session"));
      const assertion = expect(promise).rejects.toThrow("create_session timed out");
      vi.advanceTimersByTime(30_000);
      await assertion;
      // A late response must not throw or resolve anything.
      core.handleResponse(resp("r1"));
    });

    it("does not time out once resolved", async () => {
      const promise = core.sendCommand(cmd("r1"));
      core.handleResponse(resp("r1"));
      vi.advanceTimersByTime(60_000);
      await expect(promise).resolves.toMatchObject({ requestId: "r1" });
    });
  });

  describe("sendCommandCollect", () => {
    it("collects every response within the window and resolves when it closes", async () => {
      const promise = core.sendCommandCollect(cmd("r1", "list_sessions"));
      expect(published).toHaveLength(1);

      core.handleResponse(resp("r1", { data: { bridge: "a" } }));
      core.handleResponse(resp("r1", { success: false, error: "b down" }));
      core.handleResponse(resp("other"));

      vi.advanceTimersByTime(1500);
      const responses = await promise;
      expect(responses).toHaveLength(2);
      expect(responses[0]).toMatchObject({ data: { bridge: "a" } });
      expect(responses[1]).toMatchObject({ success: false, error: "b down" });
    });

    it("resolves with an empty array when nothing responds", async () => {
      const promise = core.sendCommandCollect(cmd("r1", "list_sessions"), 500);
      vi.advanceTimersByTime(500);
      await expect(promise).resolves.toEqual([]);
    });

    it("stops collecting after the window closes", async () => {
      const promise = core.sendCommandCollect(cmd("r1", "list_sessions"));
      core.handleResponse(resp("r1"));
      vi.advanceTimersByTime(1500);
      core.handleResponse(resp("r1"));
      await expect(promise).resolves.toHaveLength(1);
    });
  });

  describe("bridgeExec", () => {
    it("publishes a bridge_exec command and resolves the response data on success", async () => {
      const promise = core.bridgeExec("ls", "/tmp", "bridge-1");
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        type: "bridge_exec",
        payload: { command: "ls", workingDir: "/tmp", bridgeId: "bridge-1" },
      });

      core.handleResponse(resp(published[0].requestId, { data: { stdout: "ok", exitCode: 0 } }));
      await expect(promise).resolves.toEqual({ stdout: "ok", exitCode: 0 });
    });

    it("rejects with the response error on failure", async () => {
      const promise = core.bridgeExec("ls", "/tmp", "bridge-1");
      core.handleResponse(resp(published[0].requestId, { success: false, error: "no such dir" }));
      await expect(promise).rejects.toThrow("no such dir");
    });

    it("rejects with 'bridge_exec failed' when the failure carries no error", async () => {
      const promise = core.bridgeExec("ls", "/tmp", "bridge-1");
      core.handleResponse(resp(published[0].requestId, { success: false }));
      await expect(promise).rejects.toThrow("bridge_exec failed");
    });

    it("rejects with 'bridge_exec timed out' after 30s", async () => {
      const promise = core.bridgeExec("ls", "/tmp", "bridge-1");
      const assertion = expect(promise).rejects.toThrow("bridge_exec timed out");
      vi.advanceTimersByTime(30_000);
      await assertion;
    });
  });
});
