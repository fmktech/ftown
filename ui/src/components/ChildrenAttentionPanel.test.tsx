// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/types";
import type { ManualInputNotice } from "@/lib/hook-events";
import type { InboxEntry } from "./SessionInbox";
import {
  attentionLinkTarget,
  childAttentionState,
  childAttentionStateLabel,
  ChildrenAttentionPanel,
  mergeChildAttentionItems,
  parseAttentionDeepLink,
  resolveAttentionTarget,
  type ChildAttentionItem,
} from "./ChildrenAttentionPanel";

afterEach(cleanup);

const prompt = {
  channel: "mail" as const,
  questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }], multiSelect: false, allowText: true }],
};

function session(id: string, extra: Partial<Session> = {}): Session {
  return { id, bridgeId: "bridge", name: id, status: "running", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...extra };
}

function notice(extra: Partial<ManualInputNotice> = {}): ManualInputNotice {
  return { type: "agent_needs_input", title: "Question", message: "Which?", receivedAt: 1_000, attentionId: "evt", attentionSequence: 1, prompt, ...extra };
}

function entry(id: string, extra: Partial<ManualInputNotice> = {}, sessionExtra: Partial<Session> = {}): InboxEntry {
  return { session: session(id, sessionExtra), notice: notice({ attentionId: `evt-${id}`, ...extra }), bridgeName: "bridge" };
}

describe("child attention state", () => {
  it("labels parent-routed, escalated, and answered items", () => {
    expect(childAttentionState({ route: "parent" })).toBe("coordinator");
    expect(childAttentionStateLabel("coordinator")).toBe("Waiting on coordinator");
    expect(childAttentionState({ route: "parent", escalatedAt: "2026-01-01T00:00:00.000Z" })).toBe("escalated");
    expect(childAttentionState({ route: "human" })).toBe("escalated");
    expect(childAttentionStateLabel("escalated")).toBe("Escalated to you");
    expect(childAttentionState({ route: "parent", answeredBy: { kind: "human" } })).toBe("answered");
    expect(childAttentionStateLabel("answered")).toBe("Answered");
  });
});

describe("mergeChildAttentionItems", () => {
  const child = session("child", { name: "Child", parentSessionId: "boss" });
  const other = session("other", { name: "Other" });
  const boss = session("boss", { name: "Boss" });
  const sessionsById = new Map([[child.id, child], [other.id, other], [boss.id, boss]]);

  it("keeps live child items, adds other open snapshot items, and drops resolved or foreign ones", () => {
    const live = entry("child", { receivedAt: Date.parse("2026-01-02T00:00:00.000Z"), route: "parent", routedTo: "boss" }, { name: "Child", parentSessionId: "boss" });
    const items = mergeChildAttentionItems({
      childIds: new Set(["child"]),
      liveEntries: [live, entry("other", { receivedAt: 9_000 })],
      sessionsById,
      excludeIds: new Set(["gone"]),
      snapshotAttention: [
        { sessionId: "child", event: { id: live.notice.attentionId!, title: "dup", resolvedAt: undefined } },
        { sessionId: "child", event: { id: "older", title: "Older", message: "still open", createdAt: "2026-01-01T00:00:00.000Z", route: "human", type: "agent_needs_input" } },
        { sessionId: "child", event: { id: "routed", title: "Routed", createdAt: "2025-12-01T00:00:00.000Z", route: "parent", routedTo: "boss", type: "agent_needs_input" } },
        { sessionId: "child", event: { id: "done", title: "Done", resolvedAt: "2026-01-01T00:01:00.000Z" } },
        { sessionId: "child", event: { id: "gone", title: "Hidden", createdAt: "2026-01-01T00:02:00.000Z" } },
        { sessionId: "other", event: { id: "foreign", title: "Nope" } },
        { sessionId: "child", event: { id: "noise", title: "Noise", type: "status" } },
      ],
    });
    expect(items.map(item => item.eventId)).toEqual([live.notice.attentionId, "older", "routed"]);
    expect(items[0].live).toBe(true);
    expect(items[1].live).toBe(false);
    expect(items[1].entry.notice.route).toBe("human");
    expect(items[1].entry.session.name).toBe("Child");
    expect(items[2].entry.parentName).toBe("Boss");
  });
});

describe("attention deep links", () => {
  const boss = session("boss", { name: "Boss" });
  const child = session("child", { name: "Child", parentSessionId: "boss" });
  const solo = session("solo", { name: "Solo" });
  const sessions = [boss, child, solo];

  it("parses a session and attention id and rejects anything else", () => {
    expect(parseAttentionDeepLink("?session=boss&attention=evt-1")).toEqual({ sessionId: "boss", attentionId: "evt-1" });
    expect(parseAttentionDeepLink("session=ok_1&attention=ab-c")).toEqual({ sessionId: "ok_1", attentionId: "ab-c" });
    expect(parseAttentionDeepLink("?session=../x&attention=has space")).toEqual({ sessionId: null, attentionId: null });
    expect(parseAttentionDeepLink("?attention=")).toEqual({ sessionId: null, attentionId: null });
  });

  it("opens a child's item on its parent and a solo item on itself", () => {
    const childEntry = entry("child", {}, { name: "Child", parentSessionId: "boss" });
    const soloEntry = entry("solo", {}, { name: "Solo" });
    expect(resolveAttentionTarget({ attentionId: childEntry.notice.attentionId!, entries: [childEntry, soloEntry], sessions })).toEqual({
      selectSessionId: "boss", entry: childEntry, viaParent: true,
    });
    expect(resolveAttentionTarget({ attentionId: soloEntry.notice.attentionId!, entries: [childEntry, soloEntry], sessions })).toEqual({
      selectSessionId: "solo", entry: soloEntry, viaParent: false,
    });
    expect(resolveAttentionTarget({ attentionId: "missing", entries: [childEntry], sessions })).toBeNull();
  });

  it("uses the session hint when the item is not in the live inbox", () => {
    expect(attentionLinkTarget({ attentionId: "older", sessionHint: "child", entries: [], sessions })).toEqual({ selectSessionId: "boss", viaParent: true });
    expect(attentionLinkTarget({ attentionId: "older", sessionHint: "boss", entries: [], sessions })).toEqual({ selectSessionId: "boss", viaParent: true });
    expect(attentionLinkTarget({ attentionId: "older", sessionHint: "solo", entries: [], sessions })).toEqual({ selectSessionId: "solo", viaParent: false });
    expect(attentionLinkTarget({ attentionId: "older", sessionHint: null, entries: [], sessions })).toBeNull();
    expect(attentionLinkTarget({ attentionId: "older", sessionHint: "missing", entries: [], sessions })).toBeNull();
  });
});

describe("ChildrenAttentionPanel", () => {
  const now = Date.parse("2026-01-01T00:05:00.000Z");

  function item(state: Partial<ManualInputNotice>, id = "evt-1"): ChildAttentionItem {
    return { entry: entry("child", { attentionId: id, title: "Database", receivedAt: now - 60_000, ...state }, { name: "Child", parentSessionId: "boss" }), eventId: id, live: true };
  }

  it("opens the inbox answer UI and reports the coordinator state", async () => {
    const onAnswer = vi.fn(async () => ({ ok: true as const, message: "Answer delivered to Child." }));
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ChildrenAttentionPanel items={[item({ route: "parent", routedTo: "boss" }), item({ route: "human", title: "Escalated one", attentionId: "evt-2" }, "evt-2")]} openId={null} onOpenChange={onOpenChange} onOpenSession={vi.fn()} onDismiss={vi.fn(async () => {})} onReply={vi.fn(async () => {})} onAnswer={onAnswer} now={now} />,
    );
    const panel = screen.getByRole("region", { name: "Child attention requests" });
    expect(panel.textContent).toContain("child attention · 2");
    expect(panel.textContent).toContain("Waiting on coordinator");
    expect(panel.textContent).toContain("Escalated to you");
    expect(screen.queryByRole("button", { name: "Send answer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Database/ }));
    expect(onOpenChange).toHaveBeenCalledWith("evt-1");
    rerender(
      <ChildrenAttentionPanel items={[item({ route: "parent", routedTo: "boss" })]} openId="evt-1" onOpenChange={onOpenChange} onOpenSession={vi.fn()} onDismiss={vi.fn(async () => {})} onReply={vi.fn(async () => {})} onAnswer={onAnswer} now={now} />,
    );
    fireEvent.click(screen.getByLabelText("B"));
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({ session: expect.objectContaining({ id: "child" }) }), [{ selected: [1] }]);
    expect((await screen.findAllByRole("status")).some(node => node.textContent === "Answer delivered to Child.")).toBe(true);
  });
});
