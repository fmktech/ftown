import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth,
  sidebarWidthFromDrag,
} from "./sidebar-width";

describe("sidebar width", () => {
  it("tracks horizontal drag distance", () => {
    expect(sidebarWidthFromDrag(260, 400, 470)).toBe(330);
    expect(sidebarWidthFromDrag(330, 470, 420)).toBe(280);
  });

  it("clamps dragging and malformed persisted values", () => {
    expect(sidebarWidthFromDrag(260, 400, -1000)).toBe(MIN_SIDEBAR_WIDTH);
    expect(sidebarWidthFromDrag(260, 400, 2000)).toBe(MAX_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });
});
