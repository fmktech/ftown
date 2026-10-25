import { test } from "node:test";
import assert from "node:assert/strict";
import { legacyRelayCommand } from "./legacy-relay.js";
import { localRequest } from "./fleet.js";

test("legacy helper never produces a plaintext shell command, even for valid reads", () => {
  for (const method of ["GET", "POST"] as const) assert.throws(() => legacyRelayCommand("worker", { method, path: "/api/sessions", timeoutMs: 1000, body: { prompt: "sensitive" } }, Date.now() + 1000), { code: "upgrade_required", outcomeUnknown: false });
});
test("private SSH proxy rejects missing endpoint approval before reading local credentials", async () => {
  await assert.rejects(localRequest({ method: "GET", path: "/api/sessions", timeoutMs: 1000 }, "/must-not-be-read"), { code: "upgrade_required", outcomeUnknown: false });
});
