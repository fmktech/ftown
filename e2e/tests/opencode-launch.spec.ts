import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "@playwright/test";

import { bridgeApiFetch } from "../helpers/bridge-api";
import { test } from "../helpers/fixtures";

const MODEL = "opencode-go/kimi-k3.1-pro";
const PROMPT = "say pong";

interface SessionEnvelope {
  session?: { id?: string; status?: string; command?: string; errorReason?: string | null };
}

interface AttentionEnvelope {
  activity?: { state?: string };
}

function writeFakeOpencode(dir: string): void {
  const poster = join(dir, "post-stop.js");
  writeFileSync(poster, `const http = require("node:http");
const body = JSON.stringify({
  ftown_session_id: process.env.FTOWN_SESSION_ID,
  hook_event_name: "Stop",
});
const req = http.request({
  host: "127.0.0.1",
  port: process.env.FTOWN_HOOK_PORT,
  method: "POST",
  path: "/hook",
  headers: {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    authorization: "Bearer " + (process.env.FTOWN_HOOK_TOKEN || ""),
  },
}, (res) => {
  res.resume();
  res.on("end", () => {
    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
      console.error("hook status " + res.statusCode);
      process.exitCode = 1;
    }
  });
});
req.on("error", (err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
req.end(body);
`);
  writeFileSync(join(dir, "opencode"), `#!/bin/sh
receipt="$OPENCODE_LAUNCH_RECEIPT"
{
  printf 'argv:'
  printf ' %s' "$@"
  printf '\\nconfig:%s\\n' "\${OPENCODE_CONFIG_CONTENT-}"
} > "$receipt"
if [ "\${OPENCODE_FAKE_EXIT-}" != "" ]; then
  echo "fake opencode failed" >&2
  exit "$OPENCODE_FAKE_EXIT"
fi
node ${JSON.stringify(poster)} >> "$receipt" 2>&1 || printf 'hook_error\\n' >> "$receipt"
printf 'hook_posted\\n' >> "$receipt"
while true; do sleep 30; done
`, { mode: 0o755 });
}

test("opencode child reaches idle with its prompt and a failed launch records a reason", async () => {
  test.setTimeout(120_000);
  const root = mkdtempSync(join(tmpdir(), "oc-launch-e2e-"));
  const fakeDir = join(root, "bin");
  const workDir = join(root, "work");
  mkdirSync(fakeDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  writeFakeOpencode(fakeDir);
  const liveReceipt = join(root, "live.txt");
  const deadReceipt = join(root, "dead.txt");
  const ids: string[] = [];
  const pathEnv = `${fakeDir}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`;
  try {
    const created = await bridgeApiFetch("POST", "/api/sessions", {
      body: {
        projectName: "E2E",
        shellType: "opencode",
        model: MODEL,
        prompt: PROMPT,
        name: `opencode-launch-${Date.now()}`,
        workingDir: workDir,
        env: { PATH: pathEnv, OPENCODE_LAUNCH_RECEIPT: liveReceipt },
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const live = (created.body as SessionEnvelope).session;
    expect(live?.id).toBeTruthy();
    ids.push(live!.id!);
    expect(live?.command).toBe("opencode --standalone --auto");
    expect(live?.command ?? "").not.toContain(" -m ");

    await expect.poll(() => {
      try {
        return readFileSync(liveReceipt, "utf8");
      } catch {
        return "";
      }
    }, { timeout: 20_000 }).toContain("hook_posted");
    const receipt = readFileSync(liveReceipt, "utf8");
    expect(receipt).toContain("argv: --standalone --auto --prompt say pong");
    expect(receipt).toContain(`config:{"model":"${MODEL}"}`);
    expect(receipt).not.toContain("hook_error");
    expect(receipt).not.toContain(" -m ");

    await expect.poll(async () => {
      const listed = await bridgeApiFetch("GET", `/api/sessions/${live!.id}/attention`);
      return (listed.body as AttentionEnvelope).activity?.state;
    }, { timeout: 20_000 }).toBe("idle");
    const running = await bridgeApiFetch("GET", `/api/sessions/${live!.id}`);
    expect(running.status).toBe(200);
    expect((running.body as SessionEnvelope).session?.status).toBe("running");
    expect((running.body as SessionEnvelope).session?.errorReason ?? null).toBeNull();

    const failedCreate = await bridgeApiFetch("POST", "/api/sessions", {
      body: {
        projectName: "E2E",
        shellType: "opencode",
        model: MODEL,
        prompt: PROMPT,
        name: `opencode-launch-fail-${Date.now()}`,
        workingDir: workDir,
        env: { PATH: pathEnv, OPENCODE_LAUNCH_RECEIPT: deadReceipt, OPENCODE_FAKE_EXIT: "1" },
      },
    });
    expect(failedCreate.status, JSON.stringify(failedCreate.body)).toBe(201);
    const dead = (failedCreate.body as SessionEnvelope).session;
    expect(dead?.id).toBeTruthy();
    ids.push(dead!.id!);
    await expect.poll(async () => {
      const current = await bridgeApiFetch("GET", `/api/sessions/${dead!.id}`);
      const session = (current.body as SessionEnvelope).session;
      return session?.status === "error" ? session.errorReason ?? "" : session?.status ?? "missing";
    }, { timeout: 20_000 }).toContain("Process exited with code 1");
  } finally {
    for (const id of ids) {
      await bridgeApiFetch("DELETE", `/api/sessions/${id}`).catch(() => undefined);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
