import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { bridgeApiFetch } from "../helpers/bridge-api";
import {
  BRIDGE_HOME,
  claudeProjectSlug,
  seedClaudeTranscript,
  seedCodexRollout,
} from "../helpers/bridge-fixtures";

/**
 * Per-session token-usage extraction e2e (bridge/src/usage-collector.ts).
 *
 * This is the first end-to-end coverage of the usage feature. It exercises the
 * REAL running bridge over its loopback HTTP API (bridge-api.ts), not a unit
 * harness: it creates a session, seeds a harness-native transcript the collector
 * reads, then asserts `GET /api/sessions/:id/usage` returns the v2 SessionUsage
 * shape with correct sums, per-model math, model ordering, harness tag, and NO
 * costUsd field.
 *
 * BINDING THE NATIVE SESSION ID — no real claude/codex is run in e2e (shell
 * sessions only), so the transcript is keyed by a NATIVE id we choose. The clean,
 * source-honest path is that the bridge's create route accepts and persists
 * `claudeSessionId` / `codexSessionId` verbatim from the POST body
 * (bridge/src/create-ftown-session.ts) — the collector then keys off whichever id
 * is present on the stored Session, independent of shellType
 * (bridge/src/usage-collector.ts). So we create a plain `shell` session carrying a
 * chosen native id + a known workingDir, seed a matching transcript under the
 * bridge's scratch HOME (its $HOME is e2e/.bridge-home, which the collector reads
 * as ~/.claude/projects and ~/.codex/sessions), and GET the usage. usage() collects
 * on demand synchronously for a live session, so a single GET after seeding is
 * deterministic — no polling, no hook POST needed.
 */

interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  models: string[];
  perModel?: ModelUsage[];
  harness: string;
  collectedAt: string;
}

interface CreatedSession {
  id: string;
  claudeSessionId?: string;
  codexSessionId?: string;
  workingDir?: string;
}

/**
 * Create a session directly on the bridge loopback API (bypassing the browser).
 * `createMissingWorkingDir` lets us hand it a fresh scratch workingDir under the
 * bridge HOME whose slug we control for transcript seeding.
 */
async function createSession(body: Record<string, unknown>): Promise<CreatedSession> {
  const res = await bridgeApiFetch("POST", "/api/sessions", { body });
  expect(res.status, `create session: ${JSON.stringify(res.body)}`).toBe(201);
  const session = (res.body as { session: CreatedSession }).session;
  expect(session.id).toBeTruthy();
  return session;
}

/** GET the session's usage snapshot (200 always; body.usage is SessionUsage | null). */
async function getUsage(sessionId: string): Promise<SessionUsage | null> {
  const res = await bridgeApiFetch("GET", `/api/sessions/${sessionId}/usage`);
  expect(res.status, `usage fetch: ${JSON.stringify(res.body)}`).toBe(200);
  return (res.body as { usage: SessionUsage | null }).usage;
}

/** Best-effort teardown — remove the live session we spawned. */
async function removeSession(sessionId: string): Promise<void> {
  await bridgeApiFetch("DELETE", `/api/sessions/${sessionId}`).catch(() => undefined);
}

/** A unique scratch working directory under the bridge HOME (created on demand). */
function scratchWorkingDir(): string {
  return join(BRIDGE_HOME, "usage-e2e", randomUUID());
}

test.describe("per-session usage collection", () => {
  test("claude: extracts totals, per-model breakdown, model order, and no costUsd", async () => {
    const claudeSessionId = randomUUID();
    const workingDir = scratchWorkingDir();
    const modelA = "claude-sonnet-4-5";
    const modelB = "claude-opus-4-1";

    // Two assistant messages, two distinct models, distinct cache read/write.
    // seedClaudeTranscript gives each line a UNIQUE message.id, so both count.
    await seedClaudeTranscript(BRIDGE_HOME, claudeSessionId, workingDir, [
      { model: modelA, input: 100, output: 20, cacheRead: 5, cacheWrite: 3 },
      { model: modelB, input: 200, output: 40, cacheRead: 10, cacheWrite: 6 },
    ]);

    const session = await createSession({
      shellType: "shell",
      workingDir,
      createMissingWorkingDir: true,
      claudeSessionId,
    });

    try {
      const usage = await getUsage(session.id);
      expect(usage).not.toBeNull();
      if (!usage) throw new Error("unreachable");

      // Totals are element-wise sums over the two messages.
      expect(usage.inputTokens).toBe(300);
      expect(usage.outputTokens).toBe(60);
      expect(usage.cacheReadTokens).toBe(15);
      expect(usage.cacheWriteTokens).toBe(9);
      // totalTokens = sum of the four buckets (300 + 60 + 15 + 9).
      expect(usage.totalTokens).toBe(384);

      // Distinct models in first-appearance order (A seeded before B).
      expect(usage.models).toEqual([modelA, modelB]);

      // Exact per-model breakdown, same order.
      expect(usage.perModel).toEqual([
        { model: modelA, inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 3 },
        { model: modelB, inputTokens: 200, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 6 },
      ]);

      expect(usage.harness).toBe("claude");
      expect(typeof usage.collectedAt).toBe("string");
      // v2 shape carries NO cost — assert the field was dropped, not just falsy.
      expect(usage).not.toHaveProperty("costUsd");
    } finally {
      await removeSession(session.id);
    }
  });

  test("claude: dedups repeated message.id (multi-content-block lines count once)", async () => {
    const claudeSessionId = randomUUID();
    const workingDir = scratchWorkingDir();
    const model = "claude-sonnet-4-5";

    // A single assistant turn spans multiple jsonl lines that repeat the same
    // message.id with identical usage — the collector must count it once. Write
    // the transcript directly (the shared seeder only emits unique ids) at the
    // exact path collectClaudeUsage reads: $HOME/.claude/projects/<slug>/<sid>.jsonl.
    const dir = join(BRIDGE_HOME, ".claude", "projects", claudeProjectSlug(workingDir));
    await mkdir(dir, { recursive: true });
    const line = (id: string, input: number, output: number, cr: number, cw: number): string =>
      JSON.stringify({
        type: "assistant",
        message: {
          id,
          model,
          usage: {
            input_tokens: input,
            output_tokens: output,
            cache_read_input_tokens: cr,
            cache_creation_input_tokens: cw,
          },
        },
      });
    await writeFile(
      join(dir, `${claudeSessionId}.jsonl`),
      [
        line("dup-msg", 100, 20, 5, 3),
        line("dup-msg", 100, 20, 5, 3), // duplicate id — must be ignored
        line("solo-msg", 50, 10, 0, 0),
      ].join("\n") + "\n",
      "utf8",
    );

    const session = await createSession({
      shellType: "shell",
      workingDir,
      createMissingWorkingDir: true,
      claudeSessionId,
    });

    try {
      const usage = await getUsage(session.id);
      expect(usage).not.toBeNull();
      if (!usage) throw new Error("unreachable");

      // dup-msg counted ONCE (100/20/5/3) + solo-msg (50/10/0/0).
      expect(usage.inputTokens).toBe(150);
      expect(usage.outputTokens).toBe(30);
      expect(usage.cacheReadTokens).toBe(5);
      expect(usage.cacheWriteTokens).toBe(3);
      expect(usage.totalTokens).toBe(188);
      expect(usage.models).toEqual([model]);
      expect(usage.perModel).toEqual([
        { model, inputTokens: 150, outputTokens: 30, cacheReadTokens: 5, cacheWriteTokens: 3 },
      ]);
      expect(usage.harness).toBe("claude");
    } finally {
      await removeSession(session.id);
    }
  });

  test("codex: decomposes cached out of input and omits perModel", async () => {
    const codexSessionId = randomUUID();
    const workingDir = scratchWorkingDir();
    const model = "gpt-5-codex";

    // Codex reports cumulative totals with cached counted INSIDE input.
    await seedCodexRollout(BRIDGE_HOME, codexSessionId, {
      model,
      totals: { input: 11276, cached: 9088, output: 100 },
    });

    // A plain shell session carrying only a codexSessionId — the collector keys
    // off the present native id, so it uses the codex extractor regardless of shellType.
    const session = await createSession({
      shellType: "shell",
      workingDir,
      createMissingWorkingDir: true,
      codexSessionId,
    });

    try {
      const usage = await getUsage(session.id);
      expect(usage).not.toBeNull();
      if (!usage) throw new Error("unreachable");

      // cacheRead = min(cached, input) = 9088; input = 11276 - 9088 = 2188.
      expect(usage.cacheReadTokens).toBe(9088);
      expect(usage.inputTokens).toBe(2188);
      expect(usage.outputTokens).toBe(100);
      // Codex reports no cache writes.
      expect(usage.cacheWriteTokens).toBe(0);
      // total = 2188 + 100 + 9088 + 0 — matches codex's own total.
      expect(usage.totalTokens).toBe(11376);
      expect(usage.models).toEqual([model]);
      // Codex rollouts carry no per-model attribution — perModel is absent.
      expect(usage).not.toHaveProperty("perModel");
      expect(usage.harness).toBe("codex");
    } finally {
      await removeSession(session.id);
    }
  });

  test("no-usage harness: a plain shell session yields null, not fabricated numbers", async () => {
    const workingDir = scratchWorkingDir();

    // No native id and no transcript — the collector has no structured source.
    const session = await createSession({
      shellType: "shell",
      workingDir,
      createMissingWorkingDir: true,
    });

    try {
      const usage = await getUsage(session.id);
      // Explicit null (a clean "no data" signal), NOT an error and NOT zeros.
      expect(usage).toBeNull();
    } finally {
      await removeSession(session.id);
    }
  });
});
