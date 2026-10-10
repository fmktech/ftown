import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { Centrifuge } from "centrifuge";
import WebSocket from "ws";
import jwt from "jsonwebtoken";
import { FleetRelay } from "./relay.js";

// Optional real-broker integration: supply a local Centrifugo v5 binary. Never uses live credentials.
test(
  "real relay routes correlated requests and ignores a foreign publisher",
  { skip: !process.env.FTOWN_TEST_CENTRIFUGO, timeout: 15000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "ftown-relay-"));
    const reserve = createServer();
    reserve.listen(0, "127.0.0.1");
    await new Promise<void>((r) => reserve.once("listening", r));
    const port = (reserve.address() as any).port;
    await new Promise<void>((r) => reserve.close(() => r()));
    const secret = "isolated-test-key-not-a-real-token-secret";
    const file = join(dir, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        token_hmac_secret_key: secret,
        token_audience: "ftown:centrifugo",
        address: "127.0.0.1",
        port,
        api_disable: true,
        allowed_origins: [],
        namespaces: [
          {
            name: "commands",
            allow_subscribe_for_client: true,
            allow_user_limited_channels: true,
            allow_publish_for_client: true,
            allow_publish_for_subscriber: true,
          },
        ],
      }),
    );
    const child = spawn(
      process.env.FTOWN_TEST_CENTRIFUGO!,
      ["--config", file],
      { stdio: "ignore" },
    );
    let childError: Error | undefined;
    child.on("error", (e) => {
      childError = e;
    });
    t.after(async () => {
      child.kill();
      await rm(dir, { recursive: true, force: true });
    });
    const url = `ws://127.0.0.1:${port}/connection/websocket`;
    const owner = "owner@example.test";
    const token = (sub: string) =>
      jwt.sign({}, secret, {
        subject: sub,
        audience: "ftown:centrifugo",
        expiresIn: "1m",
      });
    const worker = new Centrifuge(url, {
      websocket: WebSocket,
      token: token(owner),
    });
    const intruder = new Centrifuge(url, {
      websocket: WebSocket,
      token: token("intruder@example.test"),
    });
    const channel = `commands:rpc#${owner}`;
    const sub = worker.newSubscription(channel);
    const received: { type: string; machine: string }[] = [];
    sub.on("publication", async (ctx) => {
      if (ctx.info?.user !== owner || ctx.data.type === "command_response") return;
      const machine = ctx.data.payload.bridgeId;
      received.push({ type: ctx.data.type, machine });
      if (machine === "legacy") {
        const response = ctx.data.type === "mcp_request"
          ? { requestId: ctx.data.requestId, success: false, error: "Unknown command type: mcp_request" }
          : { requestId: ctx.data.requestId, success: true, data: ctx.data.type === "stop_session"
            ? { stopped: true }
            : { stdout: JSON.stringify({ data: { sessions: [{ id: "existing-agent" }] } }), exitCode: 0 } };
        await sub.publish({ type: "command_response", response });
        return;
      }
      if (machine === "rejected") {
        await sub.publish({ type: "command_response", response: { requestId: ctx.data.requestId, success: false, error: "Request failed after execution" } });
        return;
      }
      if (machine === "silent") return;
      if (ctx.data.type !== "mcp_request") return;
      const response = {
        requestId: ctx.data.requestId,
        success: true,
        data: { data: { bridge: ctx.data.payload.bridgeId } },
      };
      // Foreign publishing is permitted by this broker's namespace policy; gateway must reject its identity.
      await intruder.publish(channel, {
        type: "command_response",
        response: { ...response, data: { data: { bridge: "forged" } } },
      });
      await sub.publish({ type: "command_response", response });
    });
    worker.connect();
    intruder.connect();
    sub.subscribe();
    t.after(() => {
      worker.disconnect();
      intruder.disconnect();
    });
    await Promise.all([sub.ready(10000), intruder.ready(10000)]);
    assert.equal(childError, undefined);
    const relay = new FleetRelay(url, secret);
    t.after(() => relay.close());
    const result = await relay.request(owner, "bridge-1", {
      method: "GET",
      path: "/api/sessions",
      timeoutMs: 3000,
    });
    assert.deepEqual(result, { bridge: "bridge-1" });
    assert.deepEqual(await relay.request(owner, "legacy", {
      method: "GET", path: "/api/sessions", timeoutMs: 3000,
    }), { sessions: [{ id: "existing-agent" }] });
    assert.deepEqual(await relay.request(owner, "legacy", {
      method: "POST", path: "/api/sessions/existing-agent/stop", body: {}, timeoutMs: 3000,
    }), { stopped: true });
    assert.deepEqual(received.filter(r => r.machine === "legacy").map(r => r.type),
      ["mcp_request", "bridge_exec", "mcp_request", "stop_session"]);
    for (const machine of ["rejected", "silent"]) {
      await assert.rejects(relay.request(owner, machine, {
        method: "POST", path: "/api/sessions", body: {}, timeoutMs: 1000,
      }));
      assert.deepEqual(received.filter(r => r.machine === machine).map(r => r.type), ["mcp_request"]);
    }
  },
);
