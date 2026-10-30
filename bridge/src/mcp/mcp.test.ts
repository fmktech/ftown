import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Fleet, configSchema, requestSchema, FleetError } from "./fleet.js";
import { createMcpServer } from "./server.js";
import { LocalApiServer } from "../local-api-server.js";
import { SessionStore } from "../session-store.js";
import { MailStore } from "../mail-store.js";
import { AttentionStore } from "../attention-store.js";
import { SessionController } from "../session-controller.js";
import type { ProcessRunner } from "../claude-runner.js";
import type { CentrifugoClient } from "../centrifugo-client.js";
import type { Session } from "../types.js";
import { attachTestSecurity, testRequestContext } from "./test-support.js";

test("config rejects duplicate IDs, insecure origins and request escapes", () => {
  assert.throws(() =>
    configSchema.parse({
      machines: [
        { id: "a", transport: "local" },
        { id: "a", transport: "local" },
      ],
    }),
  );
  for (const url of [
    "http://remote.example",
    "https://secret@example.org",
    "https://example.org/api",
    "file:///tmp/a",
  ])
    assert.throws(() =>
      configSchema.parse({
        machines: [{ id: "a", transport: "http", url, tokenEnv: "TOKEN" }],
      }),
    );
  assert.throws(() =>
    configSchema.parse({
      machines: [{ id: "a", transport: "ssh", host: "-oProxyCommand=oops" }],
    }),
  );
  for (const path of [
    "/api/loops",
    "/api/factory",
    "/api/sessions/../loops",
    "//evil/api/sessions",
  ])
    assert.throws(() =>
      requestSchema.parse({ method: "GET", path, timeoutMs: 1000 }),
    );
});

test("real bridge through MCP: discovery, literal history search, partial batches and lifecycle", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ftown-mcp-test-"));
  const store = new SessionStore(join(dir, "data"));
  const sample: Session = {
    id: "s1",
    name: "Worker",
    command: "echo test",
    status: "running",
    bridgeId: "bridge",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await store.saveSession(sample);
  await store.appendTerminalData(
    "s1",
    "hello world\nprice $1.00 [done]\nother output\n",
  );
  let stops = 0;
  const launched: string[] = [];
  const runner = {
    getPreferredRuntime: () => "direct",
    run: (_id: string, command: string) => launched.push(command),
    write: () => true,
    stop: () => {
      stops++;
      return true;
    },
    isRunning: () => true,
  } as unknown as ProcessRunner;
  const api = new LocalApiServer();
  api.setAuthToken("test-secret");
  api.setDependencies(
    store,
    runner,
    { publishSessionUpdate: async () => {} } as unknown as CentrifugoClient,
    "test-user",
  );
  const mail = new MailStore((id) => join(dir, "mail", id));
  api.setMailStore(mail);
  const attention = new AttentionStore((id) => store.sessionDir(id));
  api.setAttentionStore(attention);
  const sessionFactory = {
    store,
    runner,
    centrifugo: {
      publishSessionUpdate: async () => {},
    } as unknown as CentrifugoClient,
    userId: "test-user",
    bridgeId: "bridge",
    hookPort: 1,
    hookToken: "fake",
    notifyScriptPath: "/tmp/unused",
    wireTerminalInput: () => {},
  };
  api.setSessionFactory(sessionFactory);
  api.setSessionController(
    new SessionController({
      store,
      runner,
      sessionFactory,
      publishSessionUpdate: async () => {},
      removeSession: async () => null,
      publishSyntheticStop: () => {},
      withSessionWrite: async (_, fn) => fn(),
      unregisterSession: () => {},
    }),
  );
  const { security, context } = await attachTestSecurity(api, join(dir, "security"), "one");
  const port = await api.start();
  const bridgeFile = join(dir, "bridge.json");
  await writeFile(bridgeFile, JSON.stringify({ port, token: "test-secret" }));
  const server = createMcpServer(
    new Fleet(
      configSchema.parse({
        concurrency: 2,
        machines: [
          { id: "one", transport: "local", bridgeFile },
          {
            id: "offline",
            transport: "local",
            bridgeFile: join(dir, "missing.json"),
          },
        ],
      }),
    ).scoped(context),
  );
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
    attention.stopNotifications();
    await security.close();
    api.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (name: string, args: any = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { ...result, isError: 'isError' in result ? result.isError : undefined, data: result.structuredContent as any };
  };
  const tools = await client.listTools();
  assert.ok(tools.tools.length >= 20);
  assert.ok(!tools.tools.some((t) => /cron|factory|loop/.test(t.name)));
  assert.equal(
    tools.tools.find((t) => t.name === "messages_read")?.annotations
      ?.readOnlyHint,
    true,
  );
  const discovery = await call("machines_list");
  assert.equal(discovery.data.machines[0].available, true);
  assert.equal(discovery.data.machines.length, 1);
  assert.equal(discovery.data.omittedOfflineCount, 1);
  assert.equal((await call("machines_list", { includeOffline: true })).data.machines[1].available, false);
  const listed = await call("sessions_list");
  assert.equal(listed.data.sessions[0].machine, "one");
  assert.equal(listed.data.errors.length, 0);
  assert.equal(listed.data.omittedOfflineCount, 1);
  assert.equal((await call("sessions_list", { includeOffline: true })).data.errors.length, 1);
  assert.equal((await call("sessions_list", { machines: ["offline"] })).data.errors.length, 1);
  await store.saveSession({ ...sample, id: "old", status: "completed" });
  await store.saveSession({ ...sample, id: "queued", status: "pending" });
  await store.saveSession({ ...sample, id: "failed", status: "error" });
  assert.deepEqual((await call("sessions_list")).data.sessions.map((s: any) => s.id), ["queued", "s1"]);
  assert.equal((await call("machines_list")).data.machines[0].sessionCount, 2);
  assert.equal((await call("sessions_list", { status: "all" })).data.total, 4);
  assert.deepEqual((await call("sessions_list", { status: "completed" })).data.sessions.map((s: any) => s.id), ["old"]);
  assert.deepEqual((await call("sessions_list", { status: "running" })).data.sessions.map((s: any) => s.id), ["s1"]);
  assert.equal(listed.data.sessions[0].command, undefined);
  const target = { machine: "one", sessionId: "s1" };
  const attentionResult = await call("attention_request", { ...target, message: "Please review API_KEY=secret", title: "Review requested" });
  assert.equal(attentionResult.isError, undefined);
  assert.equal(attentionResult.data.machine, "one");
  assert.equal(attentionResult.data.sessionId, "s1");
  assert.equal(attentionResult.data.event.type, "agent_needs_input");
  assert.equal(attentionResult.data.event.message, "Please review API_KEY=[redacted]");
  const repeated = await call("attention_request", { ...target, message: "Please review API_KEY=secret", title: "Review requested" });
  assert.equal(repeated.data.event.id, attentionResult.data.event.id);
  assert.equal(repeated.data.event.occurrences, 2);
  assert.equal((await attention.list("s1")).events[0].id, attentionResult.data.event.id);
  for (const pullRequestUrl of ["https://github.com/fmktech/ftown/pull/128?view=1", "https://github.com/other/repo/pull/2", null]) {
    const updated = await call("sessions_update", { ...target, pullRequestUrl });
    assert.equal(updated.isError, undefined);
    const expected = pullRequestUrl?.split('?')[0];
    assert.equal(updated.data.session.pullRequestUrl, expected);
    assert.equal((await store.loadSession("s1"))?.pullRequestUrl, expected);
    assert.equal((await call("sessions_get", target)).data.session.pullRequestUrl, expected);
    assert.equal((await call("sessions_list", { machines: ["one"] })).data.sessions.find((session: Session) => session.id === "s1")?.pullRequestUrl, expected);
  }

  assert.equal(
    (await call("chats_read", { ...target, limit: 2 })).data.lines.length,
    2,
  );
  const search = await call("chats_search", {
    ...target,
    query: "$1.00 [done]",
  });
  assert.equal(search.data.totalMatches, 1);
  assert.equal(search.data.matches[0].lineNumber, 2);
  await store.appendTerminalData("s1", "x".repeat(20000) + "\nend\n");
  const long = await call("chats_read", {
    ...target,
    offset: 3,
    maxCharacters: 8000,
  });
  assert.equal(long.data.lines[0].length, 8000);
  assert.equal(long.data.nextOffset, 3);
  assert.equal(long.data.nextColumnOffset, 8000);
  const continuation = await call("chats_read", {
    ...target,
    offset: long.data.nextOffset,
    columnOffset: long.data.nextColumnOffset,
    maxCharacters: 8000,
  });
  assert.equal(continuation.data.nextColumnOffset, 16000);
  const boundedSearch = await call("chats_search", {
    ...target,
    query: "xxx",
    maxCharacters: 8000,
  });
  assert.equal(boundedSearch.data.matches[0].contentTruncated, true);

  const batch = await call("fleet_batch", {
    operations: [
      { operation: "sessions_get", args: target },
      { operation: "sessions_get", args: { ...target, machine: "offline" } },
      { operation: "sessions_get", args: { ...target, sessionId: "missing" } },
    ],
  });
  assert.deepEqual(
    batch.data.results.map((r: any) => r.ok),
    [true, false, false],
  );
  assert.equal(batch.data.results[2].error.status, 404);
  assert.equal(
    (await call("chats_read", { ...target, sessionId: "../loops" })).isError,
    true,
  );
  assert.equal((await call("sessions_stop", target)).data.stopped, true);
  assert.equal(stops, 1);
  assert.equal((await store.loadSession("s1"))?.status, "completed");
  assert.equal(
    (await call("sessions_wait", { targets: [target] })).data
      .matched,
    true,
  );
  const sent = await call("messages_send", {
    ...target,
    body: "please report",
    type: "task",
    threadId: "thread-1",
  });
  assert.ok(sent.data.id);
  const inbox = await call("messages_read", target);
  assert.equal(inbox.data.messages[0].body, "please report");
  assert.equal((await mail.listUndelivered("s1")).length, 1);
  const broadcast = await call("messages_broadcast", {
    targets: [target, target, { ...target, machine: "offline" }],
    body: "status update",
    threadId: "thread-1",
  });
  assert.equal(broadcast.data.results.length, 2);
  assert.deepEqual(
    broadcast.data.results.map((r: any) => r.ok),
    [true, false],
  );
  assert.equal((await mail.listUndelivered("s1")).length, 2);

  const created = await call("sessions_create", {
    machine: "one",
    shellType: "shell",
    command: "echo isolated",
    workingDir: dir,
    name: "new-worker",
  });
  assert.ok(created.data.session.id);
  assert.equal(launched.length, 1);
  const retried = await call("sessions_retry", target);
  assert.equal(retried.data.session.id, "s1");
  assert.equal(launched.length, 2);
  assert.equal(
    (await client.readResource({ uri: "ftown://guide" })).contents.length,
    1,
  );
});

test("shared Fleet bounds concurrent encrypted requests and cancels queued work", async () => {
  let active = 0, peak = 0, hits = 0;
  const context = await testRequestContext();
  const fleet = new Fleet(configSchema.parse({ concurrency: 2, machines: [{ id: 'a', transport: 'relay', userId: 'owner@example.test' }] }), async (_user, _machine, request, signal) => {
    if (signal?.aborted) throw new FleetError('cancelled', 'cancelled');
    hits++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    if (request.method === 'POST') throw new FleetError('connection_error', 'dispatched', true);
    return { sessions: [] };
  }).scoped(context);
  await Promise.all(Array.from({ length: 8 }, () => fleet.request('a', 'GET', '/api/sessions')));
  assert.equal(peak, 2);
  const before = hits;
  await assert.rejects(fleet.request('a', 'POST', '/api/sessions', {}), (error: FleetError) => error.outcomeUnknown);
  assert.equal(hits, before + 1);
  await assert.rejects(fleet.request('a', 'GET', '/api/sessions', undefined, AbortSignal.abort()), { code: 'cancelled' });
  assert.equal(hits, before + 1);
});

test('encrypted HTTP transport refuses redirects before sending any plaintext application data', async t => {
  let hits = 0;
  const api = createServer(async (req, res) => {
    hits++; assert.equal(req.headers.authorization, undefined); assert.equal(req.url, '/api/security/envelope');
    let body = ''; for await (const chunk of req) body += chunk;
    const packet = JSON.parse(body);
    assert.equal(packet.type, 'ftown_encrypted'); assert.equal(packet.purpose, 'hello');
    assert.ok(!body.includes('sensitive prompt'));
    res.writeHead(302, { Location: 'https://untrusted.example/' }); res.end();
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve)); t.after(() => api.close());
  const address = api.address(); assert.ok(address && typeof address !== 'string');
  const fleet = new Fleet(configSchema.parse({ machines: [{ id: 'a', transport: 'http', url: `http://127.0.0.1:${address.port}`, tokenEnv: 'NO_SECRET_IS_SENT' }] })).scoped(await testRequestContext());
  await assert.rejects(fleet.request('a', 'POST', '/api/sessions', { prompt: 'sensitive prompt' }), { code: 'connection_error', outcomeUnknown: false });
  assert.equal(hits, 1);
});

test('legacy SSH MCP endpoint fails closed without launching a helper or exposing arguments', async () => {
  const fleet = new Fleet(configSchema.parse({ machines: [{ id: 'a', transport: 'ssh', host: 'worker-host', executable: '/must-not-execute' }] })).scoped(await testRequestContext());
  await assert.rejects(fleet.request('a', 'POST', '/api/sessions', { prompt: 'sensitive prompt' }), { code: 'upgrade_required', outcomeUnknown: false });
});

test("sessions_update probes PR capability before any mixed mutation and preserves legacy updates", async (t) => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let capability: unknown = {};
  const config = configSchema.parse({ machines: [{ id: 'one', transport: 'local' }] });
  const server = createMcpServer({ config, request: async (_machine, method, path, body) => {
    calls.push({ method, path, body });
    return method === 'GET' ? capability : { session: { id: 's', ...(body as object) } };
  } });
  const client = new Client({ name: 'metadata-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const target = { machine: 'one', sessionId: 's' };
  for (const pullRequestUrl of ['https://github.com/fmktech/ftown/pull/128', null]) {
    const result = await client.callTool({ name: 'sessions_update', arguments: { ...target, name: 'Do not rename', pullRequestUrl } });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'bridge_upgrade_required');
  }
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET'], 'old bridge receives neither PR nor name mutation');
  calls.length = 0;
  const invalid = [
    { pullRequestUrl: '' }, { pullRequestUrl: 'javascript:alert(1)' }, { pullRequestUrl: 'https://github.com/o/r/pull/1/files' },
    { pullRequestUrl: 128 }, { pullRequestUrl: 'https://github.com/o/r/pull/1', extra: true },
  ];
  for (const body of invalid) assert.equal((await client.callTool({ name: 'sessions_update', arguments: { ...target, name: 'No write', ...body } })).isError, true);
  assert.equal(calls.length, 0, 'invalid mixed updates fail before capability reads or writes');
  const legacy = await client.callTool({ name: 'sessions_update', arguments: { ...target, name: 'Rename', parentSessionId: null } });
  assert.equal(legacy.isError, undefined);
  assert.deepEqual(calls, [{ method: 'PATCH', path: '/api/sessions/s', body: { name: 'Rename', parentSessionId: null } }]);
  calls.length = 0;
  capability = { capabilities: { sessionMetadata: { pullRequest: true } } };
  for (const pullRequestUrl of [' https://github.com/fmktech/ftown/pull/128/?x=1#review ', null]) {
    const result = await client.callTool({ name: 'sessions_update', arguments: { ...target, name: 'Rename', pullRequestUrl } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls.at(-1), { method: 'PATCH', path: '/api/sessions/s', body: { name: 'Rename', pullRequestUrl: pullRequestUrl === null ? null : 'https://github.com/fmktech/ftown/pull/128' } });
  }
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'PATCH', 'GET', 'PATCH']);
});
