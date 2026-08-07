import { describe, expect, it } from "vitest";

import type { Session } from "@/types";
import { buildUsagePollBatches } from "./live-usage-polling";

function session(overrides: Partial<Session>): Session {
  return {
    id: "session-1",
    name: "session",
    command: "claude",
    prompt: "",
    status: "running",
    bridgeId: "bridge-a",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildUsagePollBatches", () => {
  it("groups only running sessions with collectable usage into one request per bridge", () => {
    const batches = buildUsagePollBatches([
      session({ id: "claude-b", claudeSessionId: "native-b", workingDir: "/repo", bridgeId: "bridge-a" }),
      session({ id: "shell", shellType: "shell" }),
      session({ id: "completed", status: "completed", claudeSessionId: "native-done", workingDir: "/repo" }),
      session({ id: "claude-pending-id", shellType: "claude", workingDir: "/repo" }),
      session({ id: "codex", shellType: "codex", codexSessionId: "native-codex", bridgeId: "bridge-b" }),
      session({ id: "kimi", shellType: "kimi-code", workingDir: "/repo", bridgeId: "bridge-a" }),
      session({ id: "cursor", shellType: "cursor", cursorSessionId: "native-cursor" }),
      session({ id: "claude-a", claudeSessionId: "native-a", workingDir: "/repo", bridgeId: "bridge-a" }),
    ]);

    expect(batches).toEqual([
      { bridgeId: "bridge-a", sessionIds: ["claude-a", "claude-b", "kimi"] },
      { bridgeId: "bridge-b", sessionIds: ["codex"] },
    ]);
  });

  it("chunks a large bridge group to the RPC batch limit", () => {
    const sessions = Array.from({ length: 201 }, (_, index) => session({
      id: `codex-${String(index).padStart(3, "0")}`,
      shellType: "codex",
      codexSessionId: `native-${index}`,
    }));

    const batches = buildUsagePollBatches(sessions);

    expect(batches).toHaveLength(2);
    expect(batches[0].sessionIds).toHaveLength(200);
    expect(batches[1].sessionIds).toEqual(["codex-200"]);
  });
});
