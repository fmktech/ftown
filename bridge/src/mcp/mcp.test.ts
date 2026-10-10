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
import { SessionController } from "../session-controller.js";
import type { ProcessRunner } from "../claude-runner.js";
import type { CentrifugoClient } from "../centrifugo-client.js";
import type { Session } from "../types.js";

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
    ),
  );
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
    api.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (name: string, args: any = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { ...result, data: result.structuredContent as any };
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
  assert.equal(discovery.data.machines[1].available, false);
  const listed = await call("sessions_list");
  assert.equal(listed.data.sessions[0].machine, "one");
  assert.equal(listed.data.errors.length, 1);
  assert.equal(listed.data.sessions[0].command, undefined);
  const target = { machine: "one", sessionId: "s1" };
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
    (await call("sessions_wait", { targets: [target], timeoutSeconds: 1 })).data
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

test("global concurrency, cancellation, redirects and ambiguous mutation failures", async (t) => {
  let active = 0,
    peak = 0,
    hits = 0;
  const api = createServer((req, res) => {
    hits++;
    active++;
    peak = Math.max(peak, active);
    assert.equal(req.headers.authorization, "Bearer secret");
    if (req.url === "/api/archive") {
      active--;
      res.writeHead(302, { Location: "/api/sessions" });
      res.end();
      return;
    }
    if (req.method === "POST") {
      active--;
      req.socket.destroy();
      return;
    }
    setTimeout(() => {
      active--;
      res.end(JSON.stringify({ sessions: [] }));
    }, 30);
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  process.env.FTOWN_TEST_TOKEN = "secret";
  t.after(() => {
    api.close();
    delete process.env.FTOWN_TEST_TOKEN;
  });
  const fleet = new Fleet(
    configSchema.parse({
      concurrency: 2,
      machines: [
        {
          id: "a",
          transport: "http",
          url: `http://127.0.0.1:${(api.address() as any).port}`,
          tokenEnv: "FTOWN_TEST_TOKEN",
        },
      ],
    }),
  );
  await Promise.all(
    Array.from({ length: 8 }, () => fleet.request("a", "GET", "/api/sessions")),
  );
  assert.equal(peak, 2);
  await assert.rejects(
    fleet.request("a", "GET", "/api/archive"),
    (e: FleetError) => e.code === "connection_error",
  );
  const before = hits;
  await assert.rejects(
    fleet.request("a", "POST", "/api/sessions", {}),
    (e: FleetError) => e.outcomeUnknown,
  );
  assert.equal(hits, before + 1);
  await assert.rejects(
    fleet.request("a", "GET", "/api/sessions", undefined, AbortSignal.abort()),
    (e: FleetError) => e.code === "cancelled",
  );
  assert.equal(hits, before + 1);
});

test(
  "SSH framing keeps arguments on stdin and credentials on the remote host",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "ftown-mcp-ssh-"));
    const { mkdir, chmod } = await import("node:fs/promises");
    await mkdir(join(dir, ".ftown"));
    let body = "";
    const api = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, "Bearer remote-secret");
      for await (const chunk of req) body += chunk;
      res.end(JSON.stringify({ session: { id: "remote-session" } }));
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    await writeFile(
      join(dir, ".ftown", "bridge.json"),
      JSON.stringify({
        port: (api.address() as any).port,
        token: "remote-secret",
      }),
    );
    const argsFile = join(dir, "ssh-args.json");
    // A process-level SSH test double executes the remote command through a POSIX shell.
    const fakeSsh = join(dir, "ssh");
    await writeFile(
      fakeSsh,
      `#!${process.execPath}\nconst fs=require('node:fs'); const cp=require('node:child_process');fs.writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2)));const child=cp.spawn('/bin/sh',['-c',process.argv.at(-1)],{stdio:'inherit',env:{...process.env,HOME:${JSON.stringify(dir)}}});child.on('exit',c=>process.exit(c??1));`,
    );
    await chmod(fakeSsh, 0o755);
    const executable = join(dir, "remote mcp");
    await writeFile(
      executable,
      `#!${process.execPath}\nimport(${JSON.stringify("file://" + resolve("dist/mcp-cli.js"))});`,
    );
    await chmod(executable, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    t.after(async () => {
      process.env.PATH = oldPath;
      api.close();
      await rm(dir, { recursive: true, force: true });
    });
    const fleet = new Fleet(
      configSchema.parse({
        machines: [
          { id: "remote", transport: "ssh", host: "worker-host", executable },
        ],
      }),
    );
    const prompt = 'Quotes " and $(never-execute) and `never`\nsecond line';
    const result = await fleet.request("remote", "POST", "/api/sessions", {
      prompt,
    });
    assert.equal(result.session.id, "remote-session");
    assert.equal(JSON.parse(body).prompt, prompt);
    const { readFile } = await import("node:fs/promises");
    const args = JSON.parse(await readFile(argsFile, "utf8"));
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    assert.ok(!JSON.stringify(args).includes(prompt));
    assert.ok(!JSON.stringify(args).includes("remote-secret"));
  },
);
