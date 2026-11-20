// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionList } from "./SessionList";
import type { Session } from "@/types";

afterEach(() => { cleanup(); });
beforeEach(() => localStorage.clear());

const stamp = "2026-01-01T00:00:00.000Z";

function session(partial: Partial<Session> & Pick<Session, "id" | "name">): Session {
  return {
    status: "running",
    bridgeId: "bridge",
    createdAt: stamp,
    updatedAt: stamp,
    shellType: "shell",
    ...partial,
  };
}

function renderList(sessions: Session[]) {
  return render(
    <SessionList
      sessions={sessions}
      bridges={[{ bridgeId: "bridge", clientId: "client", hostname: "workstation", connectedAt: stamp }]}
      selectedSessionId={null}
      onSelectSession={vi.fn()}
    />,
  );
}

it("keeps an ordinary child folded under its parent", async () => {
  renderList([
    session({ id: "parent", projectName: "Platform", name: "Handoff parent" }),
    session({ id: "child", bridgeId: "remote", name: "Handoff child", parentSessionId: "parent", shellType: "muse" }),
  ]);
  expect(await screen.findByRole("button", { name: "Expand children" })).toBeTruthy();
  expect(screen.queryByText("Handoff child")).toBeNull();
});

it("shows a blocked child on the board by expanding its parent once", async () => {
  renderList([
    session({ id: "parent", projectName: "Platform", name: "Handoff parent" }),
    session({
      id: "child",
      bridgeId: "remote",
      name: "Handoff child",
      parentSessionId: "parent",
      shellType: "muse",
      block: {
        reason: "usage_limit",
        screenTail: "Usage limit reached",
        detectedAt: stamp,
        transitionKey: "usage_limit||running",
      },
    }),
  ]);
  expect(await screen.findByText("Handoff child")).toBeTruthy();
  expect(screen.getByLabelText("Blocked: usage limit")).toBeTruthy();
});
