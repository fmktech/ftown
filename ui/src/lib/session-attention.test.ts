import { describe, expect, it } from "vitest";

import type { SessionActivity } from "@/hooks/useAllSessionEvents";
import type { Session } from "@/types";
import { latestVisibleSessionAttention } from "./session-attention";

function session(id: string, bridgeId: string): Session {
  return {
    id,
    bridgeId,
    name: id,
    prompt: "",
    status: "running",
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function activity(receivedAt: number): SessionActivity {
  return {
    activity: "tool_use",
    attention: {
      type: "ask_user",
      title: "Session is asking a question",
      message: `Question at ${receivedAt}`,
      receivedAt,
    },
  };
}

describe("latestVisibleSessionAttention", () => {
  it("does not surface attention from a session hidden on this computer", () => {
    const result = latestVisibleSessionAttention({
      sessions: [session("visible", "bridge-a"), session("hidden", "bridge-a")],
      sessionActivity: new Map([
        ["visible", activity(10)],
        ["hidden", activity(20)],
      ]),
      hiddenSessionIds: new Set(["hidden"]),
      hiddenBridgeIds: new Set(),
    });

    expect(result?.sessionId).toBe("visible");
    expect(result?.receivedAt).toBe(10);
  });

  it("does not surface attention from a bridge hidden on this computer", () => {
    const result = latestVisibleSessionAttention({
      sessions: [session("visible", "bridge-a"), session("hidden", "bridge-b")],
      sessionActivity: new Map([
        ["visible", activity(10)],
        ["hidden", activity(20)],
      ]),
      hiddenSessionIds: new Set(),
      hiddenBridgeIds: new Set(["bridge-b"]),
    });

    expect(result?.sessionId).toBe("visible");
  });
});
