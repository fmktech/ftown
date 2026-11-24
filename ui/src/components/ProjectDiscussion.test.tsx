// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Command } from "@/types";
import { ProjectDiscussion } from "./ProjectDiscussion";

afterEach(cleanup);
const props = {
  project: { id: "project", bridgeId: "home", name: "Release" }, boardEnabled: true, sessions: [], tickets: [],
  onThread: vi.fn(), openTicket: vi.fn(), onTicketCreated: vi.fn(),
};
const thread = { id: "thread", channelId: "builds", seq: 1, title: "Build log", ticketId: null, author: { name: "User" }, createdAt: "2026-01-01" };

it("keeps a reply draft when the current channel refreshes or its home bridge disconnects", async () => {
  let channelName = "builds";
  let paused: Promise<void> | undefined;
  const send = async (cmd: Command) => {
    const { action } = cmd.payload as { action: string };
    if (action === "channels") await paused;
    const data = action === "channels" ? { channels: [{ id: "builds", name: channelName, archived: false }] }
      : action === "thread" ? { thread } : { posts: [] };
    return { requestId: cmd.requestId, success: true, data };
  };
  const view = render(<ProjectDiscussion {...props} initialThread={thread} online send={send} />);
  const draft = await screen.findByLabelText<HTMLTextAreaElement>("Your reply");
  fireEvent.change(draft, { target: { value: "Checking the build" } });
  let finish!: () => void;
  paused = new Promise<void>(resolve => { finish = resolve; });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(screen.getByRole("button", { name: "#builds" })).toBeTruthy();
  expect(screen.getByLabelText("Your reply")).toBe(draft);
  channelName = "releases";
  await act(async () => { finish(); });
  expect(screen.getByRole("heading", { name: "#releases" })).toBeTruthy();
  view.rerender(<ProjectDiscussion {...props} initialThread={thread} online={false} send={send} />);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Post reply" }).disabled).toBe(true);
  await act(async () => { view.rerender(<ProjectDiscussion {...props} initialThread={thread} online send={send} />); });
  expect(screen.getByLabelText<HTMLTextAreaElement>("Your reply").value).toBe("Checking the build");
});

it("keeps an empty channel and its controls steady during a slow background read", async () => {
  vi.useFakeTimers();
  try {
    let poll: Promise<void> | undefined;
    const send = async (cmd: Command) => {
      const { action } = cmd.payload as { action: string };
      if (action === "threads") await poll;
      const data = action === "threads" ? { threads: [] } : { channels: [{ id: "general", name: "general", archived: false }] };
      return { requestId: cmd.requestId, success: true, data };
    };
    await act(async () => { render(<ProjectDiscussion {...props} initialThread={null} online send={send} />); });
    const empty = screen.getByText("No threads in this channel.");
    let finish!: () => void;
    poll = new Promise<void>(resolve => { finish = resolve; });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByText("No threads in this channel.")).toBe(empty);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Refresh" }).disabled).toBe(false);
    await act(async () => { finish(); });
  } finally { vi.useRealTimers(); }
});
