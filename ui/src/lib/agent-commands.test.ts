import { describe, expect, it } from "vitest";

import { buildOpencodeCommand, buildPiCommand } from "./agent-commands";

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
