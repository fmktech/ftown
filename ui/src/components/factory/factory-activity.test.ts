import { describe, expect, it } from "vitest";

import type { FactoryTicket } from "./types";
import {
  formatActivityLabel,
  groupFactoryActivity,
} from "./factory-activity";

function ticket(id: number, stage: string): FactoryTicket {
  return {
    id,
    kind: "task",
    title: `Ticket ${id}`,
    stage,
    status: "queued",
    priority: 0,
    bounce_count: 0,
    orphaned: 0,
    blocked_on: null,
    dead_letter_reason: null,
    created_at_ms: 1_700_000_000_000,
    updated_at_ms: 1_700_000_000_000,
  };
}

describe("groupFactoryActivity", () => {
  it("keeps pipeline order, empty stages, and unknown ticket stages", () => {
    expect(
      groupFactoryActivity(
        ["rca", "fix", "verify"],
        [ticket(3, "verify"), ticket(1, "rca"), ticket(9, "custom_stage")],
      ),
    ).toEqual([
      { stage: "rca", tickets: [ticket(1, "rca")] },
      { stage: "fix", tickets: [] },
      { stage: "verify", tickets: [ticket(3, "verify")] },
      { stage: "unknown", tickets: [ticket(9, "custom_stage")] },
    ]);
  });
});

describe("formatActivityLabel", () => {
  it("turns machine stage and status names into readable labels", () => {
    expect(formatActivityLabel("in_progress")).toBe("In progress");
    expect(formatActivityLabel("dead-letter")).toBe("Dead letter");
    expect(formatActivityLabel("rca")).toBe("RCA");
  });
});
