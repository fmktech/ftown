// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FactoryBoard } from "./FactoryBoard";
import type { FactoryTicket } from "./types";

afterEach(cleanup);

function ticket(
  id: number,
  stage: string,
  overrides: Partial<FactoryTicket> = {},
): FactoryTicket {
  return {
    id,
    kind: "task",
    title: `Investigate ticket ${id}`,
    stage,
    status: "queued",
    priority: 0,
    bounce_count: 0,
    orphaned: 0,
    blocked_on: null,
    dead_letter_reason: null,
    created_at_ms: Date.now() - 60_000,
    updated_at_ms: Date.now() - 60_000,
    ...overrides,
  };
}

describe("FactoryBoard activity list", () => {
  it("renders tickets in collapsible pipeline groups", () => {
    render(
      createElement(FactoryBoard, {
        factoryIdentity: "bridge-1:/repo",
        snapshot: {
          stages: ["rca", "fix", "verify"],
          tickets: [ticket(1, "rca"), ticket(2, "verify")],
          fetchedAt: Date.now(),
        },
        error: null,
        loading: false,
        onRefresh: vi.fn(),
        showTicket: vi.fn(),
        listTicketArtifacts: vi.fn(),
        readTicketArtifact: vi.fn(),
        stopTicket: vi.fn(),
        requeueTicket: vi.fn(),
      }),
    );

    expect(screen.getByRole("heading", { name: "Activity" })).toBeTruthy();
    const rca = screen.getByRole("button", { name: "RCA, 1 ticket" });
    expect(rca.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByRole("button", { name: "Open ticket #1: Investigate ticket 1" }),
    ).toBeTruthy();

    fireEvent.click(rca);

    expect(rca.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("button", { name: "Open ticket #1: Investigate ticket 1" }),
    ).toBeNull();
  });

  it("surfaces blocked work as needing attention", () => {
    render(
      createElement(FactoryBoard, {
        factoryIdentity: "bridge-1:/repo",
        snapshot: {
          stages: ["verify"],
          tickets: [
            ticket(3, "verify", {
              status: "blocked",
              blocked_on: "manual approval",
            }),
          ],
          fetchedAt: Date.now(),
        },
        error: null,
        loading: false,
        onRefresh: vi.fn(),
        showTicket: vi.fn(),
        listTicketArtifacts: vi.fn(),
        readTicketArtifact: vi.fn(),
        stopTicket: vi.fn(),
        requeueTicket: vi.fn(),
      }),
    );

    expect(screen.getByText("Needs attention").getAttribute("title")).toBe(
      "manual approval",
    );
  });
});
