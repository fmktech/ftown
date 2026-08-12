import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TicketDetailsModal } from "./TicketDetailsModal";

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
            name: "qa.md",
            relPath: ".ffactory/tickets/42-carry-transfer-value/qa.md",
          },
        ],
        filesLoading: false,
        filesError: null,
        selectedRelPath:
          ".ffactory/tickets/42-carry-transfer-value/request.md",
        content: "# Requested behavior\n\nKeep the transfer value.",
        contentLoading: false,
        contentError: null,
        onSelectFile: vi.fn(),
        onRetryFiles: vi.fn(),
        onRetryContent: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("Carry transfer value");
    expect(html).toContain("request.md");
    expect(html).toContain("qa.md");
    expect(html).toContain("# Requested behavior");
    expect(html.indexOf("request.md")).toBeLessThan(
      html.indexOf("# Requested behavior"),
    );
  });
});
