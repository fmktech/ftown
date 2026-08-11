import { describe, expect, it } from "vitest";

import { factoryInitPrompt } from "./types";

describe("factoryInitPrompt", () => {
  it("makes the initiating agent and model the default factory routing", () => {
    const prompt = factoryInitPrompt({
      bridgeId: "bridge-1",
      repoPath: "/work/project",
      project: "project",
      harness: "codex",
      model: "gpt-5.4",
    });

    expect(prompt).toContain('initiating agent is "codex" with model "gpt-5.4"');
    expect(prompt).toContain("every stage, triage, and digest");
    expect(prompt).toContain("Explicit user routing choices override this default");
  });

  it("inherits the harness default model when the initiator has no explicit model", () => {
    const prompt = factoryInitPrompt({
      bridgeId: "bridge-1",
      repoPath: "/work/project",
      project: "project",
      harness: "deepseek",
    });

    expect(prompt).toContain('initiating agent is "deepseek" using its default model');
  });
});
