import type { FactoryTicket } from "./types";

export interface FactoryActivityGroup {
  stage: string;
  tickets: FactoryTicket[];
}

export function groupFactoryActivity(
  stages: readonly string[],
  tickets: readonly FactoryTicket[],
): FactoryActivityGroup[] {
  const knownStages = new Set(stages);
  const byStage = new Map(stages.map((stage) => [stage, [] as FactoryTicket[]]));
  const unknownTickets: FactoryTicket[] = [];

  for (const ticket of tickets) {
    if (knownStages.has(ticket.stage)) byStage.get(ticket.stage)?.push(ticket);
    else unknownTickets.push(ticket);
  }

  const groups = stages.map((stage) => ({
    stage,
    tickets: byStage.get(stage) ?? [],
  }));
  if (unknownTickets.length > 0) {
    groups.push({ stage: "unknown", tickets: unknownTickets });
  }
  return groups;
}

export function formatActivityLabel(value: string): string {
  if (value.toLowerCase() === "rca") return "RCA";
  const readable = value.replace(/[_-]+/g, " ").trim();
  return readable.length === 0
    ? value
    : `${readable[0].toUpperCase()}${readable.slice(1)}`;
}
