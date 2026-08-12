import { describe, expect, it } from "vitest";

import {
  factoryInitPrompt,
  listTicketArtifactsCmd,
  parseTicketArtifactFiles,
  readTicketArtifactCmd,
} from "./types";

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

describe("ticket artifact commands", () => {
  it("lists only regular files beneath the ticket folder", () => {
    expect(
      listTicketArtifactsCmd(".ffactory/tickets/42-carry-transfer-value"),
    ).toBe(
      "test -d '.ffactory/tickets/42-carry-transfer-value' || { echo 'ticket artifact folder not found' >&2; exit 2; }; find '.ffactory/tickets/42-carry-transfer-value' -type f -print | LC_ALL=C sort",
    );
    expect(() =>
      listTicketArtifactsCmd(".ffactory/tickets/42/../../secrets"),
    ).toThrow("invalid ticket artifact folder");
  });

  it("reads a file only when it belongs to the selected ticket", () => {
    const folder = ".ffactory/tickets/42-carry-transfer-value";
    expect(readTicketArtifactCmd(folder, `${folder}/request.md`)).toBe(
      "cat '.ffactory/tickets/42-carry-transfer-value/request.md'",
    );
    expect(() =>
      readTicketArtifactCmd(
        folder,
        ".ffactory/tickets/41-other-ticket/request.md",
      ),
    ).toThrow("invalid ticket artifact path");
  });

  it("turns bridge output into display paths and drops files outside the ticket", () => {
    const folder = ".ffactory/tickets/42-carry-transfer-value";
    expect(
      parseTicketArtifactFiles(
        folder,
        `${folder}/request.md\n${folder}/evidence/screenshot.txt\n.ffactory/tickets/41-other/request.md\n`,
      ),
    ).toEqual([
      { name: "request.md", relPath: `${folder}/request.md` },
      {
        name: "evidence/screenshot.txt",
        relPath: `${folder}/evidence/screenshot.txt`,
      },
    ]);
  });
});
