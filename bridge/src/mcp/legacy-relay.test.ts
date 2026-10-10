import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { legacyRelayCommand } from "./legacy-relay.js";

async function runHelper(options: { machine?: string; deadline?: number; fetch?: typeof fetch; method?: "GET" | "POST"; body?: unknown } = {}) {
  const command = legacyRelayCommand("worker", {
    method: options.method ?? "GET", path: "/api/sessions", timeoutMs: 3000,
    body: options.body,
  }, options.deadline ?? Date.now() + 3000);
  assert.match(command, /^node -e "eval\(Buffer.from\('[A-Za-z0-9+/=]+','base64'\).toString\(\)\)"$/);
  const source = Buffer.from(command.split("'")[1], "base64").toString();
  let output = "";
  await runInNewContext(source, {
    require: (name: string) => {
      if (name === "node:fs") return { readFileSync: () => JSON.stringify({ bridgeId: options.machine ?? "worker", port: 43123, token: "local-only-secret" }) };
      if (name === "node:os") return { homedir: () => "/test-home" };
      if (name === "node:path") return { join: (...parts: string[]) => parts.join("/") };
      throw new Error("Unexpected module");
    },
    Buffer, URL, AbortSignal,
    fetch: options.fetch ?? (async () => new Response(JSON.stringify({ sessions: [] }))),
    process: { stdout: { write: (value: string) => { output += value; } } },
  });
  assert.ok(!output.includes("local-only-secret"));
  return JSON.parse(output);
}

test("legacy helper keeps shell metacharacters as JSON data and credentials local", async () => {
  const body = { prompt: "quotes ' \" ` $(touch nope) & %PATH%\nnew line" };
  const result = await runHelper({ method: "POST", body, fetch: async (url, init) => {
    assert.equal(String(url), "http://127.0.0.1:43123/api/sessions");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer local-only-secret");
    assert.deepEqual(JSON.parse(init?.body as string), body);
    return new Response(JSON.stringify({ session: { id: "created" } }));
  } });
  assert.deepEqual(result, { data: { session: { id: "created" } } });
});

test("legacy helper refuses wrong machine identity and expired requests before HTTP", async () => {
  const noFetch = async () => { assert.fail("must not send HTTP"); };
  assert.equal((await runHelper({ machine: "another", fetch: noFetch })).error.code, "configuration_error");
  assert.equal((await runHelper({ deadline: Date.now() - 1, fetch: noFetch })).error.code, "timeout");
});

test("legacy helper bounds responses and preserves ambiguous mutation failures", async () => {
  const large = await runHelper({ fetch: async () => new Response("x".repeat(400001)) });
  assert.equal(large.error.code, "response_too_large");
  const failed = await runHelper({ method: "POST", fetch: async () => { throw new Error("local-only-secret"); } });
  assert.equal(failed.error.outcomeUnknown, true);
});

test("legacy helper rejects unsupported paths before producing a remote command", () => {
  assert.throws(() => legacyRelayCommand("worker", { method: "POST", path: "/api/loops", timeoutMs: 1000 }, Date.now() + 1000));
});
