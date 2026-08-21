import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Session } from "@/types";
import { FactoryList } from "./FactoryList";

describe("FactoryList", () => {
  it("lets the user stop and archive a nested worker", () => {
    const worker: Session = {
      id: "worker-session-1",
      name: "aurea-retail-t6-rca",
      command: "codex",
      status: "running",
      bridgeId: "bridge-1",
      createdAt: "2026-08-11T08:00:00.000Z",
      updatedAt: "2026-08-11T08:00:00.000Z",
      shellType: "codex",
      runtime: "tmux",
    };

    const html = renderToStaticMarkup(
      createElement(FactoryList, {
        factories: [
          {
            project: "aurea-retail",
            repoRoot: "/work/aurea-retail",
            bridgeId: "bridge-1",
          },
        ],
        selectedKey: "bridge-1:aurea-retail",
        onSelect: vi.fn(),
        collapsed: false,
        sessions: [worker],
        onOpenSession: vi.fn(),
        onRemoveSession: vi.fn(),
        selectedSessionId: null,
      }),
    );

    expect(html).toContain(
      'aria-label="Stop and archive aurea-retail-t6-rca"',
    );
    expect(html).toContain(">Projects<");
    expect(html).toContain("1 agent");
    expect(html).toContain("aurea-retail");
  });
});
