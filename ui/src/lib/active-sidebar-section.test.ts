import { describe, expect, it } from "vitest";

import { collapseToActiveSection } from "./active-sidebar-section";

describe("collapseToActiveSection", () => {
  it("expands only the active section while preserving unrelated fold state", () => {
    expect(
      collapseToActiveSection(
        new Set(["bridge-a", "unrelated"]),
        ["bridge-a", "bridge-b", "bridge-c"],
        "bridge-b",
      ),
    ).toEqual(new Set(["bridge-a", "bridge-c", "unrelated"]));
  });

  it("collapses all controlled sections when nothing is active", () => {
    expect(
      collapseToActiveSection(
        new Set(["unrelated"]),
        ["group-a", "group-b"],
        null,
      ),
    ).toEqual(new Set(["group-a", "group-b", "unrelated"]));
  });
});
