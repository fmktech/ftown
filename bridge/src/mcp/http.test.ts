import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { LocalApiServer } from "../local-api-server.js";
import { SessionStore } from "../session-store.js";
import { AttentionStore } from "../attention-store.js";
import type { AttentionItem } from "../attention-events.js";
import type { ProcessRunner } from "../claude-runner.js";
import type { CentrifugoClient } from "../centrifugo-client.js";
import jwt from "jsonwebtoken";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGateway, gatewayConfigSchema } from "./http.js";
import { FtownOAuthProvider } from "./oauth.js";
import type { OAuthStore, OAuthTransaction } from "./oauth-store.js";
import { createRelayHandler } from "./relay-handler.js";
import { TestIdentityStore, TestAuditStore, approvalAssertion } from "./test-support.js";
import { BridgeSecurityService, applicationJson } from "../security/bridge/security.js";
import { generateEndpoint } from "../security/crypto.js";
import { LOCAL_RECOVERY_AUTHORITY } from "../security/bridge/policy.js";

class MemoryStore implements OAuthStore {
  data = new Map<string, { value: any; expires: number }>();
  owners = new Map([
    ["349f8d2e-38e4-4d59-888d-687dcfa19e39", ["machine-a"]],
    ["619f68a6-77c1-49f6-ae2d-c5fa169d284b", ["machine-b"]],
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
      { subject: "349f8d2e-38e4-4d59-888d-687dcfa19e39", machines: ["machine-a", "machine-b"] },
      { subject: "619f68a6-77c1-49f6-ae2d-c5fa169d284b", machines: ["machine-b"] },
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
  const keys = new TestIdentityStore();
  const audit = new TestAuditStore();
  const provider = new FtownOAuthProvider(store, {
    ...config,
    approvalSecret: secret,
  }, keys);
  server.on("request", createGateway(config, provider, undefined, audit));
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
  const signedApprovals = new Map<string, Promise<string>>();
  const sign = (
    id: string,
    purpose: string,
    machines?: string[],
    subject = "349f8d2e-38e4-4d59-888d-687dcfa19e39",
  ) => {
    if (purpose === 'approve') {
      const cacheKey = JSON.stringify([id, subject, machines]);
      const existing = signedApprovals.get(cacheKey);
      if (existing) return existing;
      const result = approvalAssertion(provider, keys, id, subject, machines ?? [], secret);
      signedApprovals.set(cacheKey, result); return result;
    }
    return jwt.sign({ request: id, purpose, machines }, secret, {
      issuer: config.loginUrl,
      audience: config.publicUrl,
      subject,
      expiresIn: 60,
    });
  };
  const consent = async (action: string, assertion: string | Promise<string>) =>
    request(`/consent/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assertion: await assertion }),
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
  const otherResource = new FtownOAuthProvider(store, { ...config, publicUrl: "https://another-gateway.example", approvalSecret: secret }, keys);
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
  await mcp.callTool({ name: 'submitted_sensitive_unknown_name', arguments: { prompt: 'never-log-arguments' } }).catch(() => undefined);
  await mcp.callTool({ name: 'sessions_create', arguments: { machine: 'machine-a', prompt: 'never-log-mutation' } }).catch(() => undefined);
  assert.ok(audit.events.some(event => event.tool === 'unknown_tool' && event.status === 'rejected'));
  assert.ok(audit.events.some(event => event.tool === 'sessions_create' && event.status === 'rejected' && event.errorCode === 'permission_denied'));
  assert.ok(!JSON.stringify(audit.events).includes('submitted_sensitive'));
  assert.ok(!JSON.stringify(audit.events).includes('never-log'));
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
  store.owners.set("349f8d2e-38e4-4d59-888d-687dcfa19e39", []);
  await assert.rejects(provider.verifyAccessToken(tokens2.access_token));
  store.owners.set("349f8d2e-38e4-4d59-888d-687dcfa19e39", ["machine-a"]);
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

test("legacy native relay adapter rejects every plaintext request before HTTP", async () => {
  const handle = createRelayHandler(1, 'must-not-be-used');
  for (const request of [
    { method: 'GET', path: '/api/sessions', timeoutMs: 1000 },
    { method: 'POST', path: '/api/sessions', body: { prompt: 'sensitive' }, timeoutMs: 1000 },
    { method: 'POST', path: '/api/loops', timeoutMs: 1000 },
  ]) await assert.rejects(handle('legacy', { expiresAt: Date.now() + 1000, request }), { code: 'upgrade_required', outcomeUnknown: false });
});

test("real hook ledger through OAuth MCP: SSE, shared ack, source restart and revocation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ftown-attention-http-"));
  const sessions = new SessionStore(join(dir, "data"));
  const sample = { id: "attention-worker", name: "Attention worker", command: "test", status: "running" as const, bridgeId: "machine-a", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await sessions.saveSession(sample);
  const keys = new TestIdentityStore();
  const bridgeIdentity = await keys.bridge("349f8d2e-38e4-4d59-888d-687dcfa19e39", "machine-a");
  const security = new BridgeSecurityService(bridgeIdentity, "machine-a", join(dir, "security"), { relayUserId: "owner@example.test" });
  const browser = await generateEndpoint("349f8d2e-38e4-4d59-888d-687dcfa19e39", "browser");
  const invitation = await security.policy.createInvitation(LOCAL_RECOVERY_AUTHORITY, { label: "Test admin" });
  await security.policy.consumeInvitation({ type: 'enroll', candidate: browser.endpoint, invitationId: invitation.invitationId, invitationSecret: invitation.secret, label: 'Test admin' });
  const api = new LocalApiServer();
  api.setAuthToken("local-attention-token");
  api.setSecurity(security, { protocolVersion: 1, ownerId: bridgeIdentity.endpoint.ownerId, bridgeId: 'machine-a', endpoint: bridgeIdentity.endpoint, relayUserId: 'owner@example.test' }, async message => {
    if (message.application.route.kind === 'command' && message.application.route.command === 'security_activate_mcp') {
      const result = await security.activateMcp(message.principal, message.principal.grantId!);
      return applicationJson({ type: 'command_response', response: { requestId: message.application.route.requestId, success: true, data: result } });
    }
    return applicationJson({ error: 'unsupported test command' });
  });
  api.setDependencies(sessions, {} as ProcessRunner, {} as CentrifugoClient, "349f8d2e-38e4-4d59-888d-687dcfa19e39");
  api.setAttentionStore(new AttentionStore((id) => sessions.sessionDir(id)));
  let apiPort = await api.start();
  const bridgeFile = join(dir, "bridge.json");
  await writeFile(bridgeFile, JSON.stringify({ port: apiPort, token: "local-attention-token" }));
  const oauthStore = new MemoryStore();
  const gateway = createServer();
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const config = gatewayConfigSchema.parse({ publicUrl: base.replace("http:", "https:"), loginUrl: "https://ftown.example.test", fleet: { machines: [{ id: "machine-a", transport: "local", bridgeFile }] }, access: [{ subject: "349f8d2e-38e4-4d59-888d-687dcfa19e39", machines: ["machine-a"] }] });
  const secret = "test-only-attention-approval-secret-123456789";
  const provider = new FtownOAuthProvider(oauthStore, { ...config, approvalSecret: secret }, keys);
  gateway.on("request", createGateway(config, provider, undefined, new TestAuditStore()));
  const clients: Client[] = [];
  t.after(async () => {
    try { for (const client of clients) await client.close(); }
    finally {
      await security.close();
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      api.getHttpServer()?.closeAllConnections(); api.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
  const headers = { "X-Forwarded-Proto": "https" };
  const request = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, redirect: "manual", headers: { ...headers, ...init.headers } });
  const issue = async (scope: string) => {
    const registration = await request("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Attention E2E", redirect_uris: ["https://client.example.test/callback"], token_endpoint_auth_method: "none" }) });
    const client = await registration.json();
    const verifier = randomBytes(32).toString("base64url");
    const auth = await request("/authorize?" + new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: provider.resource, scope }));
    const id = new URL(auth.headers.get("location")!).searchParams.get("request")!;
    const assertion = await approvalAssertion(provider, keys, id, "349f8d2e-38e4-4d59-888d-687dcfa19e39", ['machine-a'], secret, async metadata => security.approveMcp(await security.policy.principal(browser.endpoint.id), { requestId: metadata.requestId, grantId: metadata.grantId, endpoint: metadata.endpoint, permissions: metadata.permissions, expiresAt: metadata.expiresAt, activeExpiresAt: metadata.activeExpiresAt }));
    const consent = await request("/consent/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assertion }) });
    const redirect = new URL((await consent.json()).redirect);
    const exchange = await request("/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: client.client_id, grant_type: "authorization_code", code: redirect.searchParams.get("code")!, code_verifier: verifier, redirect_uri: client.redirect_uris[0], resource: provider.resource }) });
    assert.equal(exchange.status, 200);
    return (await exchange.json()).access_token as string;
  };
  const token = await issue("mcp:read mcp:control");
  const frames: Promise<{ type: string | null; text: string; error?: unknown }>[] = [];
  const connect = async (accessToken: string) => {
    const client = new Client({ name: "attention-live-test", version: "1" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { ...headers, Authorization: `Bearer ${accessToken}` } },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (typeof init?.body === "string" && init.body.includes('"attention_wait"')) {
          // Own both branches immediately: closing a transport may abort a cloned
          // body even after the SDK has received its final JSON-RPC result.
          frames.push(response.clone().text().then(
            (text) => ({ type: response.headers.get("content-type"), text }),
            (error: unknown) => ({ type: response.headers.get("content-type"), text: "", error }),
          ));
        }
        return response;
      },
    }));
    return client;
  };
  const client = await connect(token);
  const target = { machine: "machine-a", sessionId: sample.id };
  const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const identity = await call("whoami", target);
  const who = identity.structuredContent as { account: { subject: string }; self: null; target: { sessionId: string } };
  assert.equal(who.account.subject, "349f8d2e-38e4-4d59-888d-687dcfa19e39"); assert.equal(who.self, null); assert.equal(who.target.sessionId, sample.id);
  const inbox = await call("attention_inbox", target);
  const cursor = (inbox.structuredContent as { cursor: string }).cursor;
  const hook = async (message: string) => {
    const result = await fetch(`http://127.0.0.1:${apiPort}/hook`, { method: "POST", headers: { Authorization: "Bearer local-attention-token", "Content-Type": "application/json" }, body: JSON.stringify({ ftown_session_id: sample.id, ftown_session_source: "env", hook_event_name: "PreToolUse", tool_name: "functions.request_user_input", tool_input: { questions: [{ question: message }] }, raw_secret: "never-copy-this" }) });
    assert.equal(result.status, 200);
  };
  const progress: number[] = [];
  const waiting = client.callTool({ name: "attention_wait", arguments: { targets: [{ ...target, cursor }], timeoutSeconds: 3 } }, undefined, { onprogress: (value) => progress.push(value.progress) });
  await delay(30); await hook("Which branch should I use?");
  const waited = await waiting;
  const data = waited.structuredContent as { matched: boolean; results: { events: AttentionItem[]; cursor: string }[] };
  assert.equal(data.matched, true); assert.equal(data.results[0].events[0].type, "ask_user");
  assert.deepEqual(progress, [1]);
  assert.ok(!JSON.stringify(data).includes("never-copy-this"));
  const streamed = await frames[0];
  assert.match(streamed.type!, /text\/event-stream/); assert.match(streamed.text, /notifications\/progress/);
  const eventId = data.results[0].events[0].id;
  assert.equal((await call("attention_ack", { ...target, eventIds: [eventId] })).isError, undefined);
  const acked = await call("attention_inbox", target);
  assert.ok((acked.structuredContent as { events: AttentionItem[] }).events[0].acknowledgedAt);
  const noToken = await call("attention_wait", { targets: [{ ...target, cursor: data.results[0].cursor }], timeoutSeconds: 1 });
  assert.equal((noToken.structuredContent as { timedOut: boolean }).timedOut, true);
  assert.ok(!(await frames[1]).text.includes("notifications/progress"));
  api.getHttpServer()?.closeAllConnections(); api.stop();
  api.setAttentionStore(new AttentionStore((id) => sessions.sessionDir(id)));
  apiPort = await api.start();
  await writeFile(bridgeFile, JSON.stringify({ port: apiPort, token: "local-attention-token" }));
  const afterRestart = await call("attention_inbox", target);
  assert.equal((afterRestart.structuredContent as { events: AttentionItem[] }).events[0].id, eventId);
  const reconnected = await connect(token);
  assert.equal((await reconnected.callTool({ name: "attention_inbox", arguments: target })).isError, undefined);
  const readOnly = await connect(await issue("mcp:read"));
  assert.ok(!(await readOnly.listTools()).tools.some((tool) => tool.name === "attention_ack" || tool.name === "attention_resolve"));
  assert.equal((await readOnly.callTool({ name: "attention_ack", arguments: { ...target, eventIds: [eventId] } })).isError, true);
  const foreign = await call("attention_inbox", { machine: "machine-b", sessionId: sample.id });
  assert.equal(foreign.isError, true);
  assert.equal((foreign.structuredContent as { error: { code: string } }).error.code, "forbidden");
  assert.equal((await call("attention_resolve", { ...target, eventIds: [eventId] })).isError, undefined);
  const beforeRevocation = await call("attention_inbox", target);
  const revokeCursor = (beforeRevocation.structuredContent as { cursor: string }).cursor;
  const revokeProgress: number[] = [];
  const revokingWait = client.callTool({ name: "attention_wait", arguments: { targets: [{ ...target, cursor: revokeCursor }], timeoutSeconds: 3 } }, undefined, { onprogress: (value) => revokeProgress.push(value.progress) });
  await delay(30); oauthStore.owners.set("349f8d2e-38e4-4d59-888d-687dcfa19e39", []); await hook("A new question after revocation");
  const revoked = await revokingWait;
  assert.equal(revoked.isError, true); assert.deepEqual(revokeProgress, []);
  assert.equal((revoked.structuredContent as { error: { code: string } }).error.code, "forbidden");
  oauthStore.owners.set("349f8d2e-38e4-4d59-888d-687dcfa19e39", ["machine-a"]);
  // Drain every observed response (including the revocation wait) before client
  // close aborts the transport. Failed body reads remain test failures.
  const completedFrames = await Promise.all(frames);
  assert.equal(completedFrames.length, 3);
  for (const frame of completedFrames) assert.equal(frame.error, undefined);
  assert.ok(!completedFrames[2].text.includes("notifications/progress"));
  assert.match(completedFrames[2].text, /forbidden/);
});
