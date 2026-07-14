import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRpcCore } from "./useBridgeRpc";
import type { Command, CommandResponse } from "@/types";

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
      const promise = core.sendCommandCollect(cmd("r1", "list_loops"));
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
      const promise = core.sendCommandCollect(cmd("r1", "list_loops"), 500);
      vi.advanceTimersByTime(500);
      await expect(promise).resolves.toEqual([]);
    });

    it("stops collecting after the window closes", async () => {
      const promise = core.sendCommandCollect(cmd("r1", "list_loops"));
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
