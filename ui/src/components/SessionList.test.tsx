// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Session } from "@/types";
import { SessionAccountBadge, SessionList } from "./SessionList";

afterEach(cleanup);

it("only labels non-default accounts", () => {
  const { rerender } = render(<SessionAccountBadge />);
  expect(screen.queryByLabelText(/Account:/)).toBeNull();
  rerender(<SessionAccountBadge account="default" />);
  expect(screen.queryByLabelText(/Account:/)).toBeNull();
  rerender(<SessionAccountBadge account="work" />);
  expect(screen.getByLabelText("Account: work").textContent).toBe("work");
});

it("renders the account badge on the owning session row only", () => {
  const sessions: Session[] = ["default", "work"].map((account, index) => ({ id: `s${index}`, name: `Session ${index}`, account,
    bridgeId: "a", shellType: "claude", status: "running", createdAt: "2026-11-16", updatedAt: "2026-11-16" }));
  render(<SessionList sessions={sessions} bridges={[{ bridgeId: "a", hostname: "Computer", clientId: "client", connectedAt: "2026-11-16" }]}
    bridgeOrder={["a"]} selectedSessionId={null} onSelectSession={() => {}} />);
  const workRow = screen.getByText("Session 1", { exact: true }).closest('[role="button"]') ?? screen.getByText("Session 1", { exact: true }).closest("button");
  expect(workRow).toBeTruthy();
  expect(within(workRow as HTMLElement).getByLabelText("Account: work")).toBeTruthy();
  expect(screen.queryByLabelText("Account: default")).toBeNull();
});
