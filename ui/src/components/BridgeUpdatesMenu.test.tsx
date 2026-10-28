// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionList } from "./SessionList";

afterEach(() => { cleanup(); localStorage.clear(); });
it("opens computer updates from a visible action control and restores focus on Escape", () => {
  const open = vi.fn();
  render(<SessionList sessions={[]} bridges={[{ bridgeId: "bridge-a", clientId: "client", hostname: "Workstation", connectedAt: "" }]}
    bridgeOrder={["bridge-a"]} selectedSessionId={null} onSelectSession={() => {}} onOpenUpdates={open} />);
  const actions = screen.getByRole("button", { name: "Actions for Workstation" });
  fireEvent.click(actions); expect(actions.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(document, { key: "Escape" }); expect(document.activeElement).toBe(actions);
  fireEvent.click(actions); fireEvent.click(screen.getByRole("menuitem", { name: "Updates…" }));
  expect(open).toHaveBeenCalledWith("bridge-a");
});
