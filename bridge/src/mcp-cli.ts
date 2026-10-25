#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { localRequest, requestSchema, errorResult } from "./mcp/fleet.js";
import { FleetRelay } from "./mcp/relay.js";
import { createGateway, gatewayConfigSchema } from "./mcp/http.js";
import { FtownOAuthProvider } from "./mcp/oauth.js";
import { PostgresOAuthStore } from "./mcp/oauth-store.js";
import { McpKeyStore } from './mcp/mcp-key-store.js';
import { SecurityEventStore } from './mcp/security-events.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--proxy") {
    // Private SSH bridge helper only. This is not an MCP stdio transport.
    try {
      let input = "";
      for await (const chunk of process.stdin) {
        input += chunk.toString();
        if (Buffer.byteLength(input) > 1024 * 1024)
          throw new Error("Request too large");
      }
      process.stdout.write(
        JSON.stringify({
          data: await localRequest(requestSchema.parse(JSON.parse(input))),
        }),
      );
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: errorResult(e) }));
    }
    return;
  }
  if (args[0] === "--help") {
    console.log(
      "Usage: ftown-mcp --config /absolute/path/gateway.json\nHTTPS Streamable HTTP MCP gateway (TLS terminated by Fly/reverse proxy).\nRequires DATABASE_URL, FTOWN_MCP_APPROVAL_SECRET and separately provisioned FTOWN_MCP_KEY_ENCRYPTION_SECRET / FTOWN_MCP_KEY_ENCRYPTION_KEY_ID. No MCP stdio mode.",
    );
    return;
  }
  if (args.length && !(args.length === 2 && args[0] === "--config"))
    throw new Error("Use --help");
  const file = args[1] ?? process.env.FTOWN_MCP_CONFIG;
  const raw = file
    ? await readFile(file, "utf8")
    : process.env.FTOWN_MCP_CONFIG_JSON;
  if (!raw) throw new Error("Gateway config is required");
  const config = gatewayConfigSchema.parse(JSON.parse(raw));
  const secret = process.env.FTOWN_MCP_APPROVAL_SECRET;
  if (!secret || secret.length < 32 || !process.env.DATABASE_URL)
    throw new Error("Database and approval secret are required");
  const wrapping = process.env.FTOWN_MCP_KEY_ENCRYPTION_SECRET;
  const keyId = process.env.FTOWN_MCP_KEY_ENCRYPTION_KEY_ID;
  if (!wrapping || !/^[A-Za-z0-9_-]{43}$/.test(wrapping) || !keyId || !/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) throw new Error('Provision MCP key encryption secret and key ID before startup');
  const wrappingKey = Uint8Array.from(Buffer.from(wrapping, 'base64url'));
  if (wrappingKey.length !== 32 || Buffer.from(wrappingKey).toString('base64url') !== wrapping) throw new Error('Invalid MCP key encryption configuration');
  const store = new PostgresOAuthStore(process.env.DATABASE_URL);
  const keys = new McpKeyStore(store.pool, { keyId, key: wrappingKey });
  const audit = new SecurityEventStore(store.pool);
  try {
  // Fail startup if the migration or database is unavailable.
  await store.pool.query("SELECT 1 FROM mcp_oauth_records LIMIT 1");
  await keys.checkSchema();
  await audit.start();
  const provider = new FtownOAuthProvider(store, {
    ...config,
    approvalSecret: secret,
  }, keys);
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  let relay: FleetRelay | undefined;
  if (config.fleet.machines.some((m) => m.transport === "relay")) {
    const url = process.env.CENTRIFUGO_URL,
      key = process.env.CENTRIFUGO_TOKEN_SECRET;
    if (!url || new URL(url).protocol !== "wss:" || !key || key.length < 32)
      throw new Error("Secure relay config is required");
    relay = new FleetRelay(url, key);
  }
  const server = createGateway(config, provider, relay, audit).listen(
    port,
    process.env.HOST ?? "127.0.0.1",
    () =>
      console.error(
        `ftown-mcp: listening behind HTTPS ingress on port ${port}`,
      ),
  );
  server.requestTimeout = 65000;
  server.headersTimeout = 10000;
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      server.close(() => {
        relay?.close();
        void audit.close().finally(() => store.pool.end());
      });
      setTimeout(() => {
        server.closeAllConnections();
        relay?.close();
        void audit.close().finally(() => store.pool.end());
      }, 30000).unref();
    });
  } catch (error) {
    await audit.close().catch(() => {});
    await store.pool.end();
    throw error;
  }
}
main().catch(() => {
  console.error(
    "ftown-mcp: startup failed; check gateway config, database migration and separately provisioned secrets",
  );
  process.exitCode = 1;
});
