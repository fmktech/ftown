import { describe, it, expect } from "vitest";
import { mergeSessionSnapshot } from "./useSessions";
import type { Session } from "@/types";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    name: "session",
    status: "running",
    bridgeId: "bridge-1",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("mergeSessionSnapshot", () => {
  it("keeps the existing bridgeId when the incoming row omits it", () => {
    const current = makeSession({ id: "s1", bridgeId: "bridge-1" });
    const incoming = makeSession({
      id: "s1",
      bridgeId: undefined,
    } as unknown as Partial<Session>) as Session;

    const result = mergeSessionSnapshot(current, incoming);
    expect(result.bridgeId).toBe("bridge-1");
  });

  it("replaces bridgeId when the incoming row provides a new one", () => {
    const current = makeSession({ id: "s1", bridgeId: "bridge-1" });
    const incoming = makeSession({ id: "s1", bridgeId: "bridge-2" });

    const result = mergeSessionSnapshot(current, incoming);
    expect(result.bridgeId).toBe("bridge-2");
  });

  it("leaves a brand-new session without a bridgeId when there is no existing row to merge against", () => {
    const incoming = makeSession({
      id: "s1",
      bridgeId: undefined,
    } as unknown as Partial<Session>) as Session;

    const result = mergeSessionSnapshot(undefined, incoming);
    expect(result.bridgeId).toBeFalsy();
  });

  it("preserves bridgeId across a full-list snapshot merge", () => {
    const prev = [makeSession({ id: "s1", bridgeId: "bridge-1" })];
    const incomingList = [
      makeSession({
        id: "s1",
        bridgeId: undefined,
      } as unknown as Partial<Session>) as Session,
    ];

    const merged = new Map(prev.map((s) => [s.id, s]));
    for (const s of incomingList) {
      merged.set(s.id, mergeSessionSnapshot(merged.get(s.id), s));
    }

    expect(merged.get("s1")!.bridgeId).toBe("bridge-1");
  });

  it("returns the incoming session unchanged when current is undefined", () => {
    const incoming = makeSession({
      id: "s2",
      name: "new-session",
      bridgeId: "bridge-new",
    });

    const result = mergeSessionSnapshot(undefined, incoming);
    expect(result).toEqual(incoming);
  });
});
