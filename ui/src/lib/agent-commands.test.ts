import { describe, expect, it } from "vitest";

import { buildMuseCommand, buildOpencodeCommand, buildPiCommand } from "./agent-commands";

describe("buildPiCommand", () => {
  it("builds the interactive Pi command with an optional model", () => {
    expect(buildPiCommand({})).toBe('pi --extension "$HOME/.ftown/pi/ftown.js"');
    expect(buildPiCommand({ model: "openai/gpt-5" })).toBe(
      'pi --extension "$HOME/.ftown/pi/ftown.js" --model \'openai/gpt-5\'',
    );
  });
});

// The bridge (bridge/src/harness-registry.ts) and the UI must produce
// byte-identical opencode commands for the same inputs.
describe("buildOpencodeCommand", () => {
  it("mirrors the bridge builder byte-for-byte", () => {
    const cases: Parameters<typeof buildOpencodeCommand>[0][] = [
      {},
      { model: "anthropic/claude-sonnet-4-5" },
      { initialPrompt: "do the thing" },
      { model: "openai/gpt-5.2", initialPrompt: "hello world" },
      { opencodeSessionId: "ses_abc" },
      { initialPrompt: "it's here" },
    ];
    for (const input of cases) {
      expect(buildOpencodeCommand(input)).toMatchSnapshot();
    }
    // Spot-check the exact frozen shapes rather than only snapshot equality.
    expect(buildOpencodeCommand({})).toBe("opencode --auto");
    expect(buildOpencodeCommand({ model: "m" })).toBe("opencode --auto -m 'm'");
    expect(buildOpencodeCommand({ initialPrompt: "p" })).toBe(
      "opencode --auto --prompt 'p'",
    );
    expect(buildOpencodeCommand({ opencodeSessionId: "s" })).toBe(
      "opencode --auto --session 's'",
    );
  });
});

// The bridge (bridge/src/harness-registry.ts) and the UI must produce
// byte-identical muse commands for the same inputs.
describe("buildMuseCommand", () => {
  it("mirrors the bridge builder byte-for-byte", () => {
    const cases: Parameters<typeof buildMuseCommand>[0][] = [
      {},
      { workingDir: "/tmp/work" },
      { model: "muse-large" },
      { workingDir: "/tmp/work", model: "muse-large" },
      { workingDir: "/tmp/work", initialPrompt: "do the thing" },
      {
        workingDir: "/tmp/work",
        model: "muse-large",
        initialPrompt: "hello world",
      },
      { museSessionId: "ses_abc" },
      { workingDir: "/tmp/work", museSessionId: "ses_abc" },
      {
        workingDir: "/tmp/work",
        model: "muse-large",
        initialPrompt: "ignored",
        museSessionId: "ses_abc",
      },
      { initialPrompt: "it's here" },
    ];
    for (const input of cases) {
      expect(buildMuseCommand(input)).toMatchSnapshot();
    }
    // Spot-check the exact frozen shapes rather than only snapshot equality.
    expect(buildMuseCommand({})).toBe("muse --yolo");
    expect(buildMuseCommand({ workingDir: "/w" })).toBe(
      "muse --yolo --workspace '/w'",
    );
    expect(buildMuseCommand({ workingDir: "/w", model: "m" })).toBe(
      "muse --yolo --workspace '/w' --model 'm'",
    );
    expect(
      buildMuseCommand({ workingDir: "/w", model: "m", initialPrompt: "p" }),
    ).toBe("muse --yolo --workspace '/w' --model 'm' 'p'");
    expect(buildMuseCommand({ museSessionId: "s" })).toBe(
      "muse --yolo resume 's'",
    );
    expect(
      buildMuseCommand({ workingDir: "/w", museSessionId: "s" }),
    ).toBe("muse --yolo --workspace '/w' resume 's'");
    // Resume drops model and prompt (codex/opencode early-return precedent).
    expect(
      buildMuseCommand({
        workingDir: "/w",
        model: "m",
        initialPrompt: "p",
        museSessionId: "s",
      }),
    ).toBe("muse --yolo --workspace '/w' resume 's'");
  });
});
