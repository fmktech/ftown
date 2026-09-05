import { describe, it, expect } from "vitest";
import { dedupeBridges, applyBridgeJoin, applyBridgeLeave, type BridgeInfo } from "./useBridges";

const bridge = (overrides: Partial<BridgeInfo> = {}): BridgeInfo => ({
  clientId: "client-1",
  bridgeId: "bridge-1",
  hostname: "host-1",
  connectedAt: "2026-09-05T10:00:00.000Z",
  ...overrides,
});

describe("dedupeBridges", () => {
  it("collapses two clients sharing a bridgeId down to the one with the newest connectedAt", () => {
    const older = bridge({ clientId: "old-client", connectedAt: "2026-09-05T09:00:00.000Z" });
    const newer = bridge({ clientId: "new-client", connectedAt: "2026-09-05T10:00:00.000Z" });

    expect(dedupeBridges([older, newer])).toEqual([newer]);
    // Order in the input shouldn't matter.
    expect(dedupeBridges([newer, older])).toEqual([newer]);
  });

  it("keeps entries for different bridgeIds", () => {
    const a = bridge({ clientId: "a", bridgeId: "bridge-a", connectedAt: "2026-09-05T09:00:00.000Z" });
    const b = bridge({ clientId: "b", bridgeId: "bridge-b", connectedAt: "2026-09-05T09:00:00.000Z" });

    expect(dedupeBridges([b, a])).toEqual([a, b]); // sorted by bridgeId
  });

  it("falls back to the most-recently-seen entry when connectedAt is missing on both", () => {
    const first = bridge({ clientId: "first", connectedAt: "" });
    const second = bridge({ clientId: "second", connectedAt: "" });

    expect(dedupeBridges([first, second])).toEqual([second]);
  });

  it("falls back to the most-recently-seen entry when connectedAt ties exactly", () => {
    const first = bridge({ clientId: "first", connectedAt: "2026-09-05T10:00:00.000Z" });
    const second = bridge({ clientId: "second", connectedAt: "2026-09-05T10:00:00.000Z" });

    expect(dedupeBridges([first, second])).toEqual([second]);
  });

  it("prefers a present connectedAt over a missing one, regardless of order", () => {
    const missing = bridge({ clientId: "missing", connectedAt: "" });
    const present = bridge({ clientId: "present", connectedAt: "2026-09-05T09:00:00.000Z" });

    expect(dedupeBridges([present, missing])).toEqual([present]);
  });
});

describe("applyBridgeJoin", () => {
  it("adds a new client that isn't known yet", () => {
    const prev = [bridge({ bridgeId: "bridge-a", clientId: "a" })];
    const incoming = bridge({ bridgeId: "bridge-b", clientId: "b" });

    expect(applyBridgeJoin(prev, incoming)).toEqual([prev[0], incoming]);
  });

  it("adds a second client for the same bridgeId rather than replacing the first (all known clients are kept)", () => {
    const stale = bridge({ clientId: "old-client", connectedAt: "2026-09-05T09:00:00.000Z" });
    const fresh = bridge({ clientId: "new-client", connectedAt: "2026-09-05T10:00:00.000Z" });

    const result = applyBridgeJoin([stale], fresh);
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([stale, fresh]));
  });

  it("updates the entry in place when the same clientId re-announces", () => {
    const original = bridge({ clientId: "client-1", hostname: "host-1" });
    const updated = bridge({ clientId: "client-1", hostname: "host-1-renamed" });

    const result = applyBridgeJoin([original], updated);
    expect(result).toEqual([updated]);
  });
});

describe("applyBridgeLeave", () => {
  it("removes the entry whose clientId matches the leaving client", () => {
    const entry = bridge({ clientId: "client-1" });
    expect(applyBridgeLeave([entry], "client-1")).toEqual([]);
  });

  it("leaves other known clients (including duplicates of the same bridgeId) untouched", () => {
    const stale = bridge({ clientId: "old-client", connectedAt: "2026-09-05T09:00:00.000Z" });
    const fresh = bridge({ clientId: "new-client", connectedAt: "2026-09-05T10:00:00.000Z" });

    expect(applyBridgeLeave([stale, fresh], "new-client")).toEqual([stale]);
  });

  it("leaves other bridges untouched", () => {
    const a = bridge({ bridgeId: "bridge-a", clientId: "a" });
    const b = bridge({ bridgeId: "bridge-b", clientId: "b" });

    expect(applyBridgeLeave([a, b], "a")).toEqual([b]);
  });
});

describe("presence lifecycle (applyBridgeJoin/applyBridgeLeave over the known-client set, exposed via dedupeBridges)", () => {
  it("winner leaves while a stale duplicate remains: the bridge is still listed, via the remaining client", () => {
    let allClients: BridgeInfo[] = [];
    const stale = bridge({ clientId: "old-client", connectedAt: "2026-09-05T09:00:00.000Z" });
    const fresh = bridge({ clientId: "new-client", connectedAt: "2026-09-05T10:00:00.000Z" });

    allClients = applyBridgeJoin(allClients, stale);
    allClients = applyBridgeJoin(allClients, fresh);
    expect(dedupeBridges(allClients)).toEqual([fresh]); // the winner is exposed

    // The winning connection's own leave arrives before the stale duplicate's
    // presence timeout — the bridge must NOT vanish from the exposed list.
    allClients = applyBridgeLeave(allClients, "new-client");
    expect(dedupeBridges(allClients)).toEqual([stale]);
  });

  it("last known client leaves: the bridge disappears from the exposed list", () => {
    let allClients: BridgeInfo[] = [];
    const stale = bridge({ clientId: "old-client" });

    allClients = applyBridgeJoin(allClients, stale);
    allClients = applyBridgeLeave(allClients, "old-client");

    expect(dedupeBridges(allClients)).toEqual([]);
  });
});
