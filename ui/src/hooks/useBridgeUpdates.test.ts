import { describe, expect, it, vi } from "vitest";
import { BridgeUpdatesController, parseBridgeUpdateStatus } from "./useBridgeUpdates";
import type { Command, CommandResponse } from "@/types";
import type { BridgeUpdateStatus } from "../../../bridge/src/update-protocol";

const status = (bridgeId: string, overrides: Partial<BridgeUpdateStatus> = {}): BridgeUpdateStatus => ({
  schema: 1, bridgeId, currentVersion: "1.0.0", latestVersion: "1.1.0", checkedAt: "2026-10-28T00:00:00Z",
  availability: "available", canUpdate: true, blockedReason: null, operation: null, manualCommand: "npx ftown@1.1.0 setup", ...overrides,
});
const success = (data: unknown): CommandResponse => ({ requestId: "r", success: true, data });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

describe("authenticated bridge update controller", () => {
  it("coalesces reads and isolates two bridges", async () => {
    const waiting = deferred<CommandResponse>();
    const send = vi.fn((c: Command) => "bridgeId" in c.payload && c.payload.bridgeId === "a" ? waiting.promise : Promise.resolve(success(status("b", { currentVersion: "2.0.0" }))));
    const c = new BridgeUpdatesController(send, () => {}, () => "request"); c.setActive(["a", "b"]);
    const a = c.check("a"); const a2 = c.check("a"); await c.check("b");
    expect(send).toHaveBeenCalledTimes(2); expect(c.get("b").status?.currentVersion).toBe("2.0.0");
    waiting.resolve(success(status("a"))); await Promise.all([a, a2]); expect(c.get("a").status?.bridgeId).toBe("a");
  });
  it("drops stale replies and capabilities across disconnects", async () => {
    const waiting = deferred<CommandResponse>(); const c = new BridgeUpdatesController(() => waiting.promise, () => {}, () => "r");
    c.setActive(["a"]); const pending = c.check("a"); c.setActive([]); c.setActive(["a"]);
    waiting.resolve(success(status("a"))); await pending; expect(c.get("a").status).toBeNull();
  });
  it("never mutates for busy, read-only or unsupported statuses", async () => {
    for (const blockedReason of ["busy", "permission_denied", "unsupported_launch", "node_incompatible"] as const) {
      const send = vi.fn(async () => success(status("a", { canUpdate: false, blockedReason })));
      const c = new BridgeUpdatesController(send, () => {}, () => "r"); c.setActive(["a"]); await c.check("a"); await c.update("a");
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
  it("sends once on double action and retains uncertain operation until matching authenticated result", async () => {
    const mutation = deferred<CommandResponse>(); let latest = status("a");
    const send = vi.fn((command: Command) => command.type === "update_bridge" ? mutation.promise : Promise.resolve(success(latest)));
    let n = 0; const c = new BridgeUpdatesController(send, () => {}, () => `id-${++n}`); c.setActive(["a"]); await c.check("a");
    const first = c.update("a"); await c.update("a");
    expect(send.mock.calls.filter(([command]) => command.type === "update_bridge")).toHaveLength(1);
    const op = c.get("a").operation!; mutation.resolve({ requestId: "r", success: true, data: {} }); await first;
    expect(c.get("a").operation?.id).toBe(op.id);
    c.setActive([]); expect(c.get("a").status).toBeNull(); c.setActive(["a"]);
    latest = status("a", { currentVersion: op.target, availability: "current", canUpdate: false }); await c.check("a");
    expect(c.get("a").complete).toBe(false);
    latest = status("a", { currentVersion: op.target, availability: "current", canUpdate: false, operation: { id: op.id, targetVersion: op.target, phase: "succeeded", startedAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:01Z", error: null } });
    await c.check("a"); expect(c.get("a").complete).toBe(true); expect(c.get("a").operation).toBeNull();
  });
  it("rejects mismatched identity and malformed status", () => {
    expect(parseBridgeUpdateStatus(status("b"), "a")).toBeNull();
    expect(parseBridgeUpdateStatus({ ...status("a"), canUpdate: "yes" }, "a")).toBeNull();
    expect(parseBridgeUpdateStatus({ ...status("a"), currentNodeVersion: 24 }, "a")).toBeNull();
    expect(parseBridgeUpdateStatus({ ...status("a"), requiredNodeEngine: "a".repeat(257) }, "a")).toBeNull();
    expect(parseBridgeUpdateStatus({ ...status("a"), requiredNodeEngine: "\n>=24.0.0" }, "a")).toBeNull();
    expect(parseBridgeUpdateStatus({ ...status("a"), requiredNodeEngine: ">=24.0.0\u0085" }, "a")).toBeNull();
    expect(parseBridgeUpdateStatus(status("a", { canUpdate: false, blockedReason: "node_incompatible", currentNodeVersion: "24.12.0", requiredNodeEngine: "^24.22.1" }), "a")?.requiredNodeEngine).toBe("^24.22.1");
  });
  it("accepts an installed version ahead of stable as current", () => {
    expect(parseBridgeUpdateStatus(status("a", { currentVersion: "2.0.0", latestVersion: "1.9.9", availability: "current", canUpdate: false }), "a")?.currentVersion).toBe("2.0.0");
    expect(parseBridgeUpdateStatus(status("a", { currentVersion: "1.0.0", latestVersion: "1.1.0", availability: "current", canUpdate: false }), "a")).toBeNull();
  });
  it("keeps a transport-uncertain operation and does not repeat the mutation", async () => {
    const send = vi.fn(async (command: Command): Promise<CommandResponse> => command.type === "update_bridge"
      ? { requestId: command.requestId, success: false, error: "Delivery may be uncertain" }
      : success(status("a")));
    let n = 0; const c = new BridgeUpdatesController(send, () => {}, () => `id-${++n}`); c.setActive(["a"]); await c.check("a"); await c.update("a"); await c.update("a");
    expect(c.get("a").operation).not.toBeNull();
    expect(send.mock.calls.filter(([command]) => command.type === "update_bridge")).toHaveLength(1);
  });
  it("surfaces an explicit control denial without exposing server error text", async () => {
    const send = vi.fn(async (command: Command): Promise<CommandResponse> => command.type === "update_bridge"
      ? { requestId: command.requestId, success: false, error: "private detail", data: { code: "permission_denied" } }
      : success(status("a")));
    let n = 0; const c = new BridgeUpdatesController(send, () => {}, () => `id-${++n}`); c.setActive(["a"]); await c.check("a"); await c.update("a");
    expect(c.get("a").message).toContain("control permission"); expect(c.get("a").message).not.toContain("private detail");
  });
});
