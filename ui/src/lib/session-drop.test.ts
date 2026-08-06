import { describe, expect, it } from "vitest";

import { getSessionDropZone, resolveSessionDrop } from "./session-drop";

describe("resolveSessionDrop", () => {
  it("moves a session under another session when dropped in its center", () => {
    expect(
      resolveSessionDrop(
        { id: "child-a", bridgeId: "bridge-1" },
        {
          kind: "session",
          id: "parent-b",
          bridgeId: "bridge-1",
          zone: "inside",
        },
      ),
    ).toEqual({
      type: "set-parent",
      sessionId: "child-a",
      parentSessionId: "parent-b",
    });
  });

  it("moves a child to the bridge root when dropped on its bridge", () => {
    expect(
      resolveSessionDrop(
        { id: "child-a", bridgeId: "bridge-1" },
        { kind: "bridge", bridgeId: "bridge-1" },
      ),
    ).toEqual({
      type: "set-parent",
      sessionId: "child-a",
      parentSessionId: null,
    });
  });

  it("keeps edge drops as ordering operations", () => {
    expect(
      resolveSessionDrop(
        { id: "session-a", bridgeId: "bridge-1" },
        {
          kind: "session",
          id: "session-b",
          bridgeId: "bridge-1",
          zone: "above",
        },
      ),
    ).toEqual({
      type: "reorder",
      sessionId: "session-a",
      targetSessionId: "session-b",
      zone: "above",
      parentSessionId: null,
    });
  });

  it("moves a root into a subgroup when dropped between its children", () => {
    expect(
      resolveSessionDrop(
        { id: "root-a", bridgeId: "bridge-1" },
        {
          kind: "session",
          id: "child-b",
          bridgeId: "bridge-1",
          parentSessionId: "parent-b",
          zone: "above",
        },
      ),
    ).toEqual({
      type: "reorder",
      sessionId: "root-a",
      targetSessionId: "child-b",
      zone: "above",
      parentSessionId: "parent-b",
    });
  });

  it("does not create grandchildren by reparenting a session with children", () => {
    const dragged = { id: "parent-a", bridgeId: "bridge-1", hasChildren: true };

    expect(
      resolveSessionDrop(dragged, {
        kind: "session",
        id: "parent-b",
        bridgeId: "bridge-1",
        zone: "inside",
      }),
    ).toBeNull();

    expect(
      resolveSessionDrop(dragged, {
        kind: "session",
        id: "child-b",
        bridgeId: "bridge-1",
        parentSessionId: "parent-b",
        zone: "above",
      }),
    ).toBeNull();
  });

  it("rejects self-drops and cross-bridge moves", () => {
    const dragged = { id: "session-a", bridgeId: "bridge-1" };

    expect(
      resolveSessionDrop(dragged, {
        kind: "session",
        id: "session-a",
        bridgeId: "bridge-1",
        zone: "inside",
      }),
    ).toBeNull();
    expect(
      resolveSessionDrop(dragged, {
        kind: "session",
        id: "session-b",
        bridgeId: "bridge-2",
        zone: "inside",
      }),
    ).toBeNull();
  });

  it("does not highlight a child row as a parent when the server would normalize it", () => {
    const target = {
      kind: "session" as const,
      id: "child-b",
      bridgeId: "bridge-1",
      parentSessionId: "parent-b",
      zone: "inside" as const,
    };

    expect(resolveSessionDrop({ id: "child-a", bridgeId: "bridge-1" }, target)).toBeNull();
  });
});

describe("getSessionDropZone", () => {
  it("reserves the middle third for reparenting and the edges for ordering", () => {
    expect(getSessionDropZone(10, 90)).toBe("above");
    expect(getSessionDropZone(45, 90)).toBe("inside");
    expect(getSessionDropZone(80, 90)).toBe("below");
  });
});
