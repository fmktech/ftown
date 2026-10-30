// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session } from "@/types";
import { SessionList } from "./SessionList";
import { inboxEntries } from "./SessionInbox";
const session = (id: string, extra: Partial<Session> = {}): Session => ({ id, bridgeId: "a", name: id, status: "running", createdAt: "2026-01-01", updatedAt: "2026-01-01", ...extra });
const notice = { type: "agent_needs_input" as const, title: "Approval", message: "Full approval request", receivedAt: 1 };
const activity = new Map([["child", { activity: "idle" as const, attention: notice }], ["peer", { activity: "thinking" as const, attention: notice }], ["hidden", { activity: "idle" as const, attention: notice }], ["other", { activity: "tool_use" as const, attention: notice }]]);
beforeEach(() => localStorage.clear()); afterEach(cleanup);
it("preserves ordinary session attention indicators without duplicate shortcut rows", () => {
  const rows = [session("child")]; const select = vi.fn();
  const view = render(createElement(SessionList, { sessions: rows, bridges: [], bridgeOrder: ["a"], selectedSessionId: null, onSelectSession: select, sessionActivity: activity }));
  const row = view.container.querySelector<HTMLButtonElement>('button[draggable="true"]')!;
  expect(within(row).getByRole("img", { name: "Input needed" })).toBeTruthy(); expect(within(row).queryByText(notice.message)).toBeNull();
  expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull(); fireEvent.click(row); expect(select).toHaveBeenCalledWith("child");
});
it("retains inbox notices through collapsed parent/bridge while excluding hidden sessions and bridges", () => {
  const rows = [session("parent"), session("child", { parentSessionId: "parent" }), session("peer"), session("hidden"), session("other", { bridgeId: "b" })];
  render(createElement(SessionList, { sessions: rows, bridges: [{ clientId: "ca", bridgeId: "a", hostname: "alpha", connectedAt: "2026-01-01" }], bridgeOrder: ["a", "b"], selectedSessionId: null, onSelectSession: vi.fn(), sessionActivity: activity, hiddenSessionIds: new Set(["hidden"]), hiddenBridgeIds: new Set(["b"]) }));
  expect(screen.queryByText("child")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Collapse alpha" }));
  const entries = inboxEntries(rows, activity, [], new Set(["hidden"]), new Set(["b"]), new Set(["a"]), () => true);
  expect(entries.map(item => item.session.id)).toEqual(["child", "peer"]); expect(entries.map(item => item.notice.message)).toEqual([notice.message, notice.message]);
});
