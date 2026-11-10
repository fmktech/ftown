import { test } from "@playwright/test";
import { appendFileSync, readFileSync } from "node:fs";

/**
 * Diagnostics for the post-enrolment readiness race (a computer refuses a just-added browser's, or a just-paired
 * computer's, first encrypted requests for a few seconds). A probe polls, every 100 ms from its start:
 *  - the bridge's output (new lines are stamped with the time they were first seen; bridge lines carry no timestamps);
 *  - the bridge's ledger replica <dataDir>/security/ledger.json: its checkpoint revision and whether it lists the browser.
 * Callers add marks ("browser added", "create clicked", "refused", "accepted"). When the probe saw a refusal, its timeline is
 * appended to the file named by E2E_READINESS_LOG (opt-in; nothing is written otherwise) and summarized as an annotation.
 */
export interface ReadinessProbe {
  mark(event: string): void;
  /** ms since the mark `event` (or since the probe started when absent). */
  since(event: string): number;
  /** Set (or change) the browser endpoint id the replica is checked for. */
  watchEndpoint(endpointId: string): void;
  stop(): void;
}

interface Entry { at: number; text: string }

export function startReadinessProbe(label: string, sources: { log: () => string; replicaFile: string; endpointId?: string }): ReadinessProbe {
  const start = Date.now();
  const entries: Entry[] = [];
  const marks = new Map<string, number>();
  let endpointId = sources.endpointId ?? null;
  let offset = sources.log().length;
  let replica = "";
  let refused = 0;
  let stopped = false;
  const sample = () => {
    const log = sources.log();
    if (log.length > offset) {
      for (const line of log.slice(offset).split("\n").filter(Boolean)) entries.push({ at: Date.now(), text: `bridge| ${line.slice(0, 220)}` });
      offset = log.length;
    }
    let state = "replica: absent";
    try {
      const file = JSON.parse(readFileSync(sources.replicaFile, "utf8")) as { checkpoint?: { revision?: number; devices?: { endpoint?: { id?: string } }[] } };
      const lists = endpointId ? (file.checkpoint?.devices ?? []).some(device => device.endpoint?.id === endpointId) : null;
      state = `replica: revision ${file.checkpoint?.revision ?? "?"}${lists === null ? "" : lists ? ", lists the browser" : ", does NOT list the browser"}`;
    } catch { /* absent or being replaced */ }
    if (state !== replica) { entries.push({ at: Date.now(), text: state }); replica = state; }
  };
  sample();
  const timer = setInterval(() => { if (!stopped) sample(); }, 100);
  return {
    mark(event) {
      sample();
      marks.set(event, Date.now());
      entries.push({ at: Date.now(), text: `MARK  ${event}` });
      if (event.startsWith("refused")) refused += 1;
    },
    since(event) { return Date.now() - (marks.get(event) ?? start); },
    watchEndpoint(id) { endpointId = id; replica = ""; sample(); },
    stop() {
      if (stopped) return;
      sample();
      stopped = true;
      clearInterval(timer);
      if (!refused) return;
      const lines = entries.map(entry => `+${String(entry.at - start).padStart(6)} ms  ${entry.text}`);
      const text = `=== ${label} (started ${new Date(start).toISOString()}, ${refused} refusal(s))\n${lines.join("\n")}\n`;
      if (process.env.E2E_READINESS_LOG) appendFileSync(process.env.E2E_READINESS_LOG, text);
      try { test.info().annotations.push({ type: "readiness timeline", description: `${label}: ${refused} refusal(s)` }); } catch { /* outside a test */ }
    },
  };
}
