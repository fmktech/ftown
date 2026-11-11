// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Session } from "@/types";
import type { InboxEntry } from "./SessionInbox";
import { SessionInboxPopup } from "./SessionInboxPopup";
import type { AttentionAnswerEntry } from "../../../bridge/src/attention-prompt-protocol";
import type { AttentionAnswerSubmitResult } from "./AttentionAnswerForm";

const session = (id: string): Session => ({ id, bridgeId: "b", name: id, status: "running", createdAt: "2026-01-01", updatedAt: "2026-01-01" });
const entry = (id: string, timestamp = 1): InboxEntry => ({ session: session(id), bridgeName: "Laptop", notice: { type: "agent_needs_input", title: "Review", message: "Full message", receivedAt: timestamp, attentionId: `att-${id}-${timestamp}`, attentionSequence: 1 } });
const base = { onOpenSession: vi.fn(), onDismiss: vi.fn(async () => {}), onReply: vi.fn(async () => {}), onAnswer: vi.fn(async (_entry: InboxEntry, _answers: AttentionAnswerEntry[]): Promise<AttentionAnswerSubmitResult> => ({ ok: true, message: "Answer sent." })), onReturnFocus: vi.fn() };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function Harness({ current }: { current: InboxEntry | null }) {
  const [value, setValue] = useState<InboxEntry | null>(current);
  return <div>
    <div tabIndex={-1} data-testid="terminal">terminal</div>
    <input data-testid="terminal-input" />
    <SessionInboxPopup entry={value} {...base} onReturnFocus={() => { base.onReturnFocus(); (document.querySelector('[data-testid="terminal"]') as HTMLElement)?.focus(); }} />
    <button type="button" data-testid="switch" onClick={() => setValue((prev) => (prev ? null : current))}>switch</button>
    <button type="button" data-testid="new" onClick={() => setValue(entry("first", 2))}>new</button>
  </div>;
}

it("appears for the selected session with an item and reuses the Inbox body", () => {
  render(<Harness current={entry("first")} />);
  const region = screen.getByRole("region", { name: "Waiting for you" });
  expect(region.textContent).toContain("Review");
  expect(region.textContent).toContain("Full message");
  expect(screen.getByLabelText("Reply to first")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open session" })).toBeNull();
  expect(document.activeElement).not.toBe(region);
});

it("shows nothing when there is no entry for the selected session", () => {
  render(<Harness current={null} />);
  expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull();
  expect(screen.queryByText("1 waiting")).toBeNull();
});

it("Hide collapses to a pill, pill expands, Escape collapses and returns focus", async () => {
  render(<Harness current={entry("first")} />);
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull();
  expect(screen.getByText("1 waiting")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Waiting for you" }));
  expect(screen.getByRole("region", { name: "Waiting for you" })).toBeTruthy();
  const hide = screen.getByRole("button", { name: "Hide" });
  hide.focus();
  await act(async () => { fireEvent.keyDown(hide, { key: "Escape" }); });
  expect(screen.getByText("1 waiting")).toBeTruthy();
  expect(base.onReturnFocus).toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByTestId("terminal"));
});

it("does not take focus when it appears", () => {
  const PropsHarness = ({ value }: { value: InboxEntry | null }) => <div>
    <input data-testid="terminal-input" />
    <SessionInboxPopup entry={value} {...base} onReturnFocus={base.onReturnFocus} />
  </div>;
  const view = render(<PropsHarness value={null} />);
  const input = screen.getByTestId("terminal-input");
  input.focus();
  expect(document.activeElement).toBe(input);
  view.rerender(<PropsHarness value={entry("first")} />);
  expect(screen.getByRole("region", { name: "Waiting for you" })).toBeTruthy();
  expect(document.activeElement).toBe(input);
});

it("stays collapsed for the same item after hiding, re-opens for a new item", () => {
  render(<Harness current={entry("first", 1)} />);
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  expect(screen.getByText("1 waiting")).toBeTruthy();
  // Switch away (entry null) and back to the same item: still collapsed.
  fireEvent.click(screen.getByTestId("switch"));
  expect(screen.queryByText("1 waiting")).toBeNull();
  fireEvent.click(screen.getByTestId("switch"));
  expect(screen.getByText("1 waiting")).toBeTruthy();
  // A new item (different receivedAt / attentionId) re-opens.
  fireEvent.click(screen.getByTestId("new"));
  expect(screen.getByRole("region", { name: "Waiting for you" })).toBeTruthy();
  expect(screen.queryByText("1 waiting")).toBeNull();
});

it("reply, answer and dismiss call the shared handlers", async () => {
  const item = entry("first");
  render(<Harness current={item} />);
  const input = screen.getByLabelText("Reply to first") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
  await screen.findByText("Reply queued.");
  expect(base.onReply).toHaveBeenCalledWith(item, "hello");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(base.onDismiss).toHaveBeenCalledWith(item);
});

it("shows the answer form for a prompted item instead of the reply box", async () => {
  const item = entry("first");
  item.notice = { ...item.notice, type: "agent_needs_input", prompt: { channel: "mail", questions: [{ question: "Which path?", options: [{ label: "Fast" }, { label: "Safe" }], multiSelect: false, allowText: false }] } };
  render(<Harness current={item} />);
  expect(screen.queryByLabelText("Reply to first")).toBeNull();
  fireEvent.click(screen.getByLabelText("Safe"));
  fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
  expect(base.onAnswer).toHaveBeenCalledWith(item, [{ selected: [1] }]);
});

it("hides Dismiss for hook prompts", () => {
  const item = entry("first");
  item.notice = { ...item.notice, type: "ask_user", prompt: { channel: "hook", questions: [{ question: "Which?", options: [{ label: "A" }], multiSelect: false, allowText: false }] } };
  render(<Harness current={item} />);
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
});
