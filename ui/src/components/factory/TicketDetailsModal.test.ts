// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TicketDetailsModal } from "./TicketDetailsModal";

afterEach(cleanup);

describe("TicketDetailsModal", () => {
  it("shows ticket files beside the selected file contents", () => {
    const html = renderToStaticMarkup(
      createElement(TicketDetailsModal, {
        ticketId: 42,
        detail: {
          ticket: {
            id: 42,
            kind: "task",
            title: "Carry transfer value",
            stage: "acceptance",
            status: "in_progress",
            priority: 3,
            bounce_count: 0,
            orphaned: 0,
            blocked_on: null,
            dead_letter_reason: null,
            created_at_ms: 1_700_000_000_000,
            updated_at_ms: 1_700_000_010_000,
            folder_path: ".ffactory/tickets/42-carry-transfer-value",
            epic_id: null,
          },
          claim: null,
          history: [],
        },
        detailLoading: false,
        detailError: null,
        files: [
          {
            name: "request.md",
            relPath: ".ffactory/tickets/42-carry-transfer-value/request.md",
          },
          {
            name: "evidence/qa.json",
            relPath:
              ".ffactory/tickets/42-carry-transfer-value/evidence/qa.json",
          },
          {
            name: "evidence/screenshot.png",
            relPath:
              ".ffactory/tickets/42-carry-transfer-value/evidence/screenshot.png",
          },
          {
            name: "report.pdf",
            relPath: ".ffactory/tickets/42-carry-transfer-value/report.pdf",
          },
          {
            name: "preview/index.html",
            relPath:
              ".ffactory/tickets/42-carry-transfer-value/preview/index.html",
          },
          {
            name: "src/fix.ts",
            relPath: ".ffactory/tickets/42-carry-transfer-value/src/fix.ts",
          },
          {
            name: "logs/worker.log",
            relPath:
              ".ffactory/tickets/42-carry-transfer-value/logs/worker.log",
          },
          {
            name: "bundle.zip",
            relPath: ".ffactory/tickets/42-carry-transfer-value/bundle.zip",
          },
        ],
        filesLoading: false,
        filesError: null,
        selectedRelPath:
          ".ffactory/tickets/42-carry-transfer-value/request.md",
        content:
          "# Requested behavior\n\nKeep the **transfer value**.\n\n- Preserve cents",
        contentLoading: false,
        contentError: null,
        stages: ["acceptance"],
        onSelectFile: vi.fn(),
        onRetryFiles: vi.fn(),
        onRetryContent: vi.fn(),
        onStopTicket: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("Carry transfer value");
    expect(html).toContain("request.md");
    expect(html).toContain('role="tree"');
    expect(html).toContain('aria-label="Expand folder evidence"');
    expect(html).not.toContain("qa.json");
    expect(html).not.toContain("screenshot.png");
    expect(html).not.toContain(">evidence/qa.json<");
    expect(html).toContain('aria-label="Markdown file"');
    expect(html).toContain('aria-label="PDF file"');
    expect(html).toContain('aria-label="Archive file"');
    expect(html).toContain("Stop ticket");
    expect(html).not.toContain("Remove from board");
    expect(html).toMatch(/<h1[^>]*>Requested behavior<\/h1>/);
    expect(html).toContain("<strong>transfer value</strong>");
    expect(html).toContain("<li>Preserve cents</li>");
    expect(html.indexOf("request.md")).toBeLessThan(
      html.indexOf("Requested behavior"),
    );
  });

  it("offers terminal tickets a non-destructive board removal", () => {
    const html = renderToStaticMarkup(
      createElement(TicketDetailsModal, {
        ticketId: 43,
        detail: {
          ticket: {
            id: 43,
            kind: "task",
            title: "Finished ticket",
            stage: "verify",
            status: "dead_letter",
            priority: 0,
            bounce_count: 1,
            orphaned: 0,
            blocked_on: null,
            dead_letter_reason: "stopped",
            created_at_ms: 1_700_000_000_000,
            updated_at_ms: 1_700_000_010_000,
            folder_path: ".ffactory/tickets/43-finished",
            epic_id: null,
          },
          claim: null,
          history: [],
        },
        detailLoading: false,
        detailError: null,
        files: [],
        filesLoading: false,
        filesError: null,
        selectedRelPath: null,
        content: null,
        contentLoading: false,
        contentError: null,
        stages: ["verify"],
        onSelectFile: vi.fn(),
        onRetryFiles: vi.fn(),
        onRetryContent: vi.fn(),
        onHideTicket: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect(html).toContain("Remove from board");
    expect(html).not.toContain("Stop ticket");
  });

  it("requeues a dead-letter ticket at the selected pipeline stage", async () => {
    const onRequeueTicket = vi.fn().mockResolvedValue(undefined);
    render(
      createElement(TicketDetailsModal, {
        ticketId: 45,
        detail: {
          ticket: {
            id: 45,
            kind: "task",
            title: "Recover failed verification",
            stage: "verify",
            status: "dead_letter",
            priority: 0,
            bounce_count: 2,
            orphaned: 0,
            blocked_on: null,
            dead_letter_reason: "bounce_limit",
            created_at_ms: 1_700_000_000_000,
            updated_at_ms: 1_700_000_010_000,
            folder_path: ".ffactory/tickets/45-recover-failed-verification",
            epic_id: null,
          },
          claim: null,
          history: [],
        },
        detailLoading: false,
        detailError: null,
        files: [],
        filesLoading: false,
        filesError: null,
        selectedRelPath: null,
        content: null,
        contentLoading: false,
        contentError: null,
        stages: ["rca", "fix", "verify"],
        onSelectFile: vi.fn(),
        onRetryFiles: vi.fn(),
        onRetryContent: vi.fn(),
        onRequeueTicket,
        onClose: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Requeue ticket" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Queue stage" }), {
      target: { value: "fix" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm requeue" }));

    await waitFor(() => expect(onRequeueTicket).toHaveBeenCalledWith("fix"));
  });

  it("expands the reader to full screen and restores it with Escape", () => {
    const onClose = vi.fn();
    render(
      createElement(TicketDetailsModal, {
        ticketId: 44,
        detail: {
          ticket: {
            id: 44,
            kind: "task",
            title: "Heavy RCA document",
            stage: "rca",
            status: "queued",
            priority: 0,
            bounce_count: 0,
            orphaned: 0,
            blocked_on: null,
            dead_letter_reason: null,
            created_at_ms: 1_700_000_000_000,
            updated_at_ms: 1_700_000_010_000,
            folder_path: ".ffactory/tickets/44-heavy-rca-document",
            epic_id: null,
          },
          claim: null,
          history: [],
        },
        detailLoading: false,
        detailError: null,
        files: [],
        filesLoading: false,
        filesError: null,
        selectedRelPath: null,
        content: null,
        contentLoading: false,
        contentError: null,
        stages: ["rca"],
        onSelectFile: vi.fn(),
        onRetryFiles: vi.fn(),
        onRetryContent: vi.fn(),
        onClose,
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Expand full screen" }),
    );

    expect(
      screen.getByRole("button", { name: "Exit full screen" }),
    ).toBeTruthy();
    expect(screen.getByRole("dialog").className).toContain("max-w-none");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.getByRole("button", { name: "Expand full screen" }),
    ).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
