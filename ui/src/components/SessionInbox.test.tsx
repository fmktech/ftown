// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Command, Session } from "@/types";
import { inboxEntries, queueSessionReply, SessionInboxPage, SessionInboxTrigger, type InboxEntry } from "./SessionInbox";
const session = (id: string, extra: Partial<Session> = {}): Session => ({ id, bridgeId: "b", name: id, status: "running", createdAt: "2026-01-01", updatedAt: "2026-01-01", ...extra });
const entry = (id: string, timestamp = 1): InboxEntry => ({ session: session(id), bridgeName: "Laptop", notice: { type: "agent_needs_input", title: "Review", message: "Full message\n" + "x".repeat(300), receivedAt: timestamp } });
const base = { onOpenSession: vi.fn(), onDismiss: vi.fn(async () => {}), onReply: vi.fn(async () => {}) };
function Fixture({ entries = [entry("first")], collapsed = false, actions = base }: { entries?: InboxEntry[]; collapsed?: boolean; actions?: { onOpenSession: (id: string) => void; onDismiss: (entry: InboxEntry) => Promise<void>; onReply: (entry: InboxEntry, message: string) => Promise<void> } }) {
  const [open, setOpen] = useState(false); const trigger = useRef<HTMLButtonElement>(null); const restore = useRef(false);
  useEffect(() => { if (!open && restore.current) { restore.current = false; trigger.current?.focus(); } }, [open]);
  return <><SessionInboxTrigger count={entries.length} collapsed={collapsed} open={open} onOpen={() => setOpen(true)} buttonRef={trigger}/><SessionInboxPage entries={entries} open={open} onClose={() => { restore.current = true; setOpen(false); }} {...actions}/></>;
}
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);
it("shows full text, sorted outstanding counts, and retains ordinary hidden filters", () => {
  const rows = [session("older"), session("tie-first"), session("newest"), session("tie-second"), session("hidden"), session("hidden-bridge", { bridgeId: "other" })];
  const notices = new Map(rows.map((row, i) => [row.id, { activity: "idle" as const, attention: entry(row.id, [1, 2, 3, 2, 5, 6][i]).notice }]));
  const entries = inboxEntries(rows, notices, [], new Set(["hidden"]), new Set(["other"]), new Set(["b"]), () => true);
  expect(entries.map(item => item.session.id)).toEqual(["newest", "tie-first", "tie-second", "older"]);
  render(<Fixture entries={entries}/>); const trigger = screen.getByRole("button", { name: "Inbox, 4 messages" }); fireEvent.click(trigger);
  const page = screen.getByRole("region", { name: "Inbox" }); const articles = within(page).getAllByRole("article");
  expect(articles.map(item => item.getAttribute("data-inbox-entry"))).toEqual(["newest", "tie-first", "tie-second", "older"]);
  expect(articles[0].querySelector(".whitespace-pre-wrap")?.textContent).toBe(entries[0].notice.message); expect(base.onDismiss).not.toHaveBeenCalled(); expect(base.onOpenSession).not.toHaveBeenCalled();
  fireEvent.click(within(articles[0]).getByRole("button", { name: "Open session" })); expect(base.onOpenSession).toHaveBeenCalledWith("newest");
});
it("works collapsed and empty, focuses the heading and restores focus on back", () => {
  render(<Fixture entries={[]} collapsed/>); const trigger = screen.getByRole("button", { name: "Inbox, 0 messages" }); trigger.focus(); fireEvent.click(trigger);
  expect(screen.getByText("No messages.")).toBeTruthy(); expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Inbox" })); expect(screen.queryByRole("dialog")).toBeNull();
  const back = screen.getByRole("button", { name: "Back to workspace" }); expect(back.textContent).toBe(""); expect(back.getAttribute("title")).toBe("Back to workspace");
  fireEvent.click(back); expect(screen.queryByRole("region", { name: "Inbox" })).toBeNull(); expect(document.activeElement).toBe(trigger);
});
it("keeps the failed draft and sends once, then reports durable enqueue only", async () => {
  let resolve!: () => void; const sent = vi.fn().mockRejectedValueOnce(new Error("Reply may have been queued. Check the session before sending again.")).mockImplementationOnce(() => new Promise<void>(r => { resolve = r; }));
  render(<Fixture actions={{ ...base, onReply: sent }}/>); fireEvent.click(screen.getByRole("button", { name: /Inbox/ }));
  const input = screen.getByLabelText("Reply to first") as HTMLTextAreaElement; fireEvent.change(input, { target: { value: "reply text" } }); fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
  expect((await screen.findByRole("alert")).textContent).toContain("may have been queued"); expect(input.value).toBe("reply text");
  fireEvent.click(screen.getByRole("button", { name: "Send reply" })); fireEvent.click(screen.getByRole("button", { name: "Sending…" })); expect(sent).toHaveBeenCalledTimes(2);
  await act(async () => resolve()); expect(screen.getByRole("status").textContent).toBe("Reply queued."); expect(input.value).toBe(""); expect(base.onDismiss).not.toHaveBeenCalled();
});
it("keeps newer notice separate from an old pending reply and passes captured dismissal identity", async () => {
  let finish!: () => void; const onReply = vi.fn(() => new Promise<void>(resolve => { finish = resolve; })); const onDismiss = vi.fn(async () => {});
  const old = entry("first", 1), next = entry("first", 2); next.notice.message = "New request";
  const view = render(<Fixture entries={[old]} actions={{ ...base, onReply, onDismiss }}/>); fireEvent.click(screen.getByRole("button", { name: /Inbox/ }));
  fireEvent.change(screen.getByLabelText("Reply to first"), { target: { value: "Old draft" } }); fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
  view.rerender(<Fixture entries={[next]} actions={{ ...base, onReply, onDismiss }}/>); await act(async () => finish());
  expect((screen.getByLabelText("Reply to first") as HTMLTextAreaElement).value).toBe(""); expect(screen.queryByText("Reply queued.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" })); expect(onDismiss).toHaveBeenCalledWith(next);
});
it("disables reply for offline and read-only sessions without removing notices", () => {
  const rows = [session("offline"), session("readonly", { bridgeId: "c" })]; const activity = new Map(rows.map(row => [row.id, { activity: "idle" as const, attention: entry(row.id).notice }]));
  const entries = inboxEntries(rows, activity, [], new Set(), new Set(), new Set(["c"]), () => false); render(<Fixture entries={entries}/>); fireEvent.click(screen.getByRole("button", { name: /Inbox/ }));
  expect(screen.getByText(/Reconnect this computer/)).toBeTruthy(); expect(screen.getByText(/does not have control permission/)).toBeTruthy(); expect(screen.getAllByRole("button", { name: "Send reply" }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
});
it("validates queued reply acknowledgements and distinguishes unsupported, denial, and uncertain failure", async () => {
  const item = entry("first"); const call = vi.fn(async (_command: Command) => ({ requestId: "r", success: true, data: { sessionId: "first", messageId: "m", status: "queued" } }));
  await queueSessionReply(call, item, "Hi"); expect(call.mock.calls[0][0]).toMatchObject({ type: "send_message", payload: { bridgeId: "b", sessionId: "first", message: "Hi" } });
  await expect(queueSessionReply(async () => ({ requestId: "r", success: false, error: "Unknown command type: send_message" }), item, "x")).rejects.toThrow("bridge upgrade");
  await expect(queueSessionReply(async () => ({ requestId: "r", success: false, data: { code: "permission_denied" } }), item, "x")).rejects.toThrow("permission");
  await expect(queueSessionReply(async () => ({ requestId: "r", success: false, data: { code: "enqueue_failed" } }), item, "x")).rejects.toThrow("may have been queued");
  await expect(queueSessionReply(async () => ({ requestId: "r", success: true, data: { sessionId: "wrong", messageId: "m", status: "queued" } }), item, "x")).rejects.toThrow("may have been queued");
  await expect(queueSessionReply(async () => { throw new Error("timeout"); }, item, "x")).rejects.toThrow("may have been queued");
});

it("keeps one pending reply and its draft across close and reopen", async () => {
  let finish!: () => void; const onReply = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<Fixture actions={{ ...base, onReply }}/>); fireEvent.click(screen.getByRole("button", { name: /Inbox/ }));
  fireEvent.change(screen.getByLabelText("Reply to first"), { target: { value: "Pending draft" } }); fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to workspace" })); expect(screen.queryByRole("region", { name: "Inbox" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Inbox/ }));
  expect((screen.getByLabelText("Reply to first") as HTMLTextAreaElement).value).toBe("Pending draft");
  expect((screen.getByRole("button", { name: "Sending…" }) as HTMLButtonElement).disabled).toBe(true); fireEvent.click(screen.getByRole("button", { name: "Sending…" })); expect(onReply).toHaveBeenCalledTimes(1);
  await act(async () => finish()); expect(screen.getByRole("status").textContent).toBe("Reply queued.");
});
it("keeps a failed reply and draft after it settles while the inbox is closed", async () => {
  let fail!: (error: Error) => void; const onReply = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  render(<Fixture actions={{ ...base, onReply }}/>); fireEvent.click(screen.getByRole("button", { name: /Inbox/ }));
  fireEvent.change(screen.getByLabelText("Reply to first"), { target: { value: "Uncertain draft" } }); fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to workspace" })); await act(async () => fail(new Error("Reply may have been queued.")));
  fireEvent.click(screen.getByRole("button", { name: /Inbox/ })); expect((screen.getByLabelText("Reply to first") as HTMLTextAreaElement).value).toBe("Uncertain draft");
  expect(screen.getByRole("alert").textContent).toContain("may have been queued"); expect(onReply).toHaveBeenCalledTimes(1);
});
