import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import jwt from "jsonwebtoken";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGateway, gatewayConfigSchema } from "./http.js";
import { FtownOAuthProvider } from "./oauth.js";
import type { OAuthStore, OAuthTransaction } from "./oauth-store.js";
import { createRelayHandler } from "./relay-handler.js";

class MemoryStore implements OAuthStore {
  data = new Map<string, { value: any; expires: number }>();
  owners = new Map([
    ["user-a", ["machine-a"]],
    ["user-b", ["machine-b"]],
  ]);
  private queue: Promise<unknown> = Promise.resolve();
  transaction<T>(fn: (tx: OAuthTransaction) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const state = structuredClone(this.data);
      const get = async <V>(
        kind: string,
        key: string,
      ): Promise<V | undefined> => {
        const row = state.get(`${kind}:${key}`);
        return row && row.expires > Date.now() / 1000 ? row.value : undefined;
      };
      const result = await fn({
        get,
        put: async (kind, key, value, expires) => {
          state.set(`${kind}:${key}`, { value, expires });
        },
        take: async <V>(kind: string, key: string) => {
          const value = await get<V>(kind, key);
          state.delete(`${kind}:${key}`);
          return value;
        },
        lock: async () => {},
        ownedMachines: async (subject) => this.owners.get(subject) ?? [],
      });
      this.data = state;
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

test("HTTP OAuth flow: PKCE, consent, machine isolation, refresh replay and revocation", async (t) => {
  const config = gatewayConfigSchema.parse({
    publicUrl: "https://mcp.example.test",
    loginUrl: "https://ftown.example.test",
    fleet: {
      machines: [
        { id: "machine-a", transport: "local", bridgeFile: "/missing/test-a" },
        { id: "machine-b", transport: "local", bridgeFile: "/missing/test-b" },
      ],
    },
    access: [
      { subject: "user-a", machines: ["machine-a", "machine-b"] },
      { subject: "user-b", machines: ["machine-b"] },
    ],
  });
  const secret = "test-only-approval-secret-not-production-123456";
  const store = new MemoryStore();
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  config.publicUrl = base.replace("http:", "https:");
  const provider = new FtownOAuthProvider(store, {
    ...config,
    approvalSecret: secret,
  });
  server.on("request", createGateway(config, provider));
  const headers = { "X-Forwarded-Proto": "https" };
  const request = (path: string, init: RequestInit = {}) =>
    fetch(base + path, {
      ...init,
      redirect: "manual",
      headers: { ...headers, ...init.headers },
    });
  const post = (path: string, body: Record<string, string>) =>
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  const unauthorized = await request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthorized.status, 401);
  assert.match(
    unauthorized.headers.get("www-authenticate")!,
    /oauth-protected-resource/,
  );
  const metadata = await request("/.well-known/oauth-protected-resource/mcp");
  assert.equal((await metadata.json()).resource, provider.resource);
  assert.equal(
    (
      await request("/mcp", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.test" },
      })
    ).status,
    403,
  );
  const register = await request("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test agent",
      redirect_uris: ["https://client.example.test/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(register.status, 201);
  const client = await register.json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authParams = {
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: provider.resource,
    scope: "mcp:read",
    state: "state-value",
  };
  const sign = (
    id: string,
    purpose: string,
    machines?: string[],
    subject = "user-a",
  ) =>
    jwt.sign({ request: id, purpose, machines }, secret, {
      issuer: config.loginUrl,
      audience: config.publicUrl,
      subject,
      expiresIn: 60,
    });
  const consent = (action: string, assertion: string) =>
    request(`/consent/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assertion }),
    });
  const authorize = await request(
    "/authorize?" + new URLSearchParams(authParams),
  );
  assert.equal(authorize.status, 302);
  const id = new URL(authorize.headers.get("location")!).searchParams.get(
    "request",
  )!;
  const details = await consent("details", sign(id, "inspect"));
  assert.deepEqual((await details.json()).machines, ["machine-a"]);
  assert.equal(
    (await consent("approve", sign(id, "approve", ["machine-b"]))).status,
    400,
  );
  const approved = await consent("approve", sign(id, "approve", ["machine-a"]));
  const redirect = new URL((await approved.json()).redirect);
  assert.equal(redirect.searchParams.get("state"), "state-value");
  assert.equal(redirect.searchParams.get("iss"), config.publicUrl);
  assert.equal(
    (await consent("approve", sign(id, "approve", ["machine-a"]))).status,
    400,
  );
  const exchange = {
    client_id: client.client_id,
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code")!,
    code_verifier: verifier,
    redirect_uri: client.redirect_uris[0],
    resource: provider.resource,
  };
  assert.equal(
    (await post("/token", { ...exchange, code_verifier: "wrong" })).status,
    400,
  );
  assert.equal(
    (await post("/token", { ...exchange, resource: "https://other.test/mcp" }))
      .status,
    400,
  );
  const concurrent = await Promise.all([
    post("/token", exchange),
    post("/token", exchange),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 400]);
  const tokens = await concurrent.find((r) => r.status === 200)!.json();
  const otherResource = new FtownOAuthProvider(store, { ...config, publicUrl: "https://another-gateway.example", approvalSecret: secret });
  await assert.rejects(otherResource.verifyAccessToken(tokens.access_token));
  await assert.rejects(otherResource.exchangeRefreshToken(client, tokens.refresh_token, undefined, new URL(otherResource.resource)));
  const discovery = await (await request("/.well-known/oauth-authorization-server")).json();
  assert.equal(discovery.issuer, config.publicUrl);
  assert.equal(discovery.authorization_response_iss_parameter_supported, true);

  const mcp = new Client({ name: "remote-test", version: "1" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: {
        headers: { ...headers, Authorization: `Bearer ${tokens.access_token}` },
      },
    }),
  );
  t.after(() => mcp.close());
  const tools = await mcp.listTools();
  assert.ok(tools.tools.some((t) => t.name === "chats_read"));
  assert.ok(
    !tools.tools.some(
      (t) => t.name === "sessions_create" || t.name === "fleet_batch",
    ),
  );
  const hidden = await mcp.callTool({
    name: "sessions_get",
    arguments: { machine: "machine-b", sessionId: "s" },
  });
  assert.equal(hidden.isError, true);
  assert.equal((hidden.structuredContent as any).error.code, "forbidden");
  const refresh = {
    client_id: client.client_id,
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    resource: provider.resource,
  };
  assert.equal(
    (await post("/token", { ...refresh, scope: "mcp:read mcp:control" }))
      .status,
    400,
  );
  const rotatedResponse = await post("/token", refresh);
  assert.equal(rotatedResponse.status, 200);
  const rotated = await rotatedResponse.json();
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  assert.equal((await post("/token", refresh)).status, 400);
  await assert.rejects(provider.verifyAccessToken(rotated.access_token));
  // A separate grant can be revoked explicitly, and account device revocation is checked live.
  const second = await request("/authorize?" + new URLSearchParams(authParams));
  const id2 = new URL(second.headers.get("location")!).searchParams.get(
    "request",
  )!;
  const callback = new URL(
    (
      await (
        await consent("approve", sign(id2, "approve", ["machine-a"]))
      ).json()
    ).redirect,
  );
  const tokens2 = await (
    await post("/token", {
      ...exchange,
      code: callback.searchParams.get("code")!,
    })
  ).json();
  store.owners.set("user-a", []);
  await assert.rejects(provider.verifyAccessToken(tokens2.access_token));
  store.owners.set("user-a", ["machine-a"]);
  assert.equal(
    (
      await post("/revoke", {
        client_id: client.client_id,
        token: tokens2.refresh_token,
      })
    ).status,
    200,
  );
  await assert.rejects(provider.verifyAccessToken(tokens2.access_token));
});

test("bridge relay adapter deduplicates mutations and rejects loops and expired commands", async (t) => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    assert.equal(req.headers.authorization, "Bearer local-token");
    res.end(JSON.stringify({ session: { id: "created" } }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => server.close());
  const handle = createRelayHandler(
    (server.address() as any).port,
    "local-token",
  );
  const payload = {
    expiresAt: Date.now() + 15000,
    request: {
      method: "POST",
      path: "/api/sessions",
      body: { prompt: "hello" },
      timeoutMs: 1000,
    },
  };
  const results = await Promise.all([
    handle("same", payload),
    handle("same", payload),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0], results[1]);
  await assert.rejects(
    handle("same", {
      ...payload,
      request: { ...payload.request, body: { prompt: "changed" } },
    }),
  );
  await assert.rejects(handle("expired", { ...payload, expiresAt: 0 }));
  await assert.rejects(
    handle("loop", {
      ...payload,
      request: { ...payload.request, path: "/api/loops" },
    }),
  );
});
