import { describe, expect, it } from "vitest";

import { buildPiCommand } from "./agent-commands";

describe("buildPiCommand", () => {
  it("builds the interactive Pi command with an optional model", () => {
    expect(buildPiCommand({})).toBe('pi --extension "$HOME/.ftown/pi/ftown.js"');
    expect(buildPiCommand({ model: "openai/gpt-5" })).toBe(
      'pi --extension "$HOME/.ftown/pi/ftown.js" --model \'openai/gpt-5\'',
    );
  });
});
