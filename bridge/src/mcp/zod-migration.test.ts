import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { z as v3 } from 'zod/v3';
import { createMcpServer } from './server.js';

test('bounded collections reject oversized input before visiting elements', () => {
  let visited = 0;
  const schema = z.array(z.unknown().transform(value => { visited++; return value; })).max(2);
  assert.equal(schema.safeParse([1, 2, 3]).success, false);
  assert.equal(visited, 0);
  assert.deepEqual(schema.parse([1, 2]), [1, 2]);
  assert.equal(visited, 2);
});

test('v4 GUID validation matches v3 UUID acceptance and unsafe integers fail closed', () => {
  for (const value of ['12345678-1234-1234-1234-123456789abc', '00000000-0000-0000-0000-000000000000', '12345678-1234-1234-1234-123456789abg', '{12345678-1234-1234-1234-123456789abc}']) {
    assert.equal(z.string().guid().safeParse(value).success, v3.string().uuid().safeParse(value).success);
  }
  assert.equal(z.number().int().safeParse(Number.MAX_SAFE_INTEGER).success, true);
  assert.equal(z.number().int().safeParse(Number.MAX_SAFE_INTEGER + 1).success, false);
  assert.deepEqual(z.object({ value: z.unknown().optional() }).parse({}), v3.object({ value: v3.unknown() }).parse({}));
});

test('MCP SDK emits bounded schemas and rejects oversized tool input', async t => {
  let calls = 0;
  const server = createMcpServer({ config: { concurrency: 1, timeoutMs: 1000, machines: [] }, request: async () => { calls++; throw new Error('unexpected request'); } });
  const client = new Client({ name: 'schema-regression', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = await client.listTools();
  const batch = tools.tools.find(tool => tool.name === 'fleet_batch');
  assert.ok(batch);
  assert.equal(batch.inputSchema.type, 'object');
  const operations = batch.inputSchema.properties?.operations;
  assert.ok(operations && typeof operations === 'object');
  assert.equal(operations.maxItems, 50);
  const result = await client.callTool({ name: 'fleet_batch', arguments: { operations: Array.from({ length: 51 }, () => ({ operation: 'bogus', args: {} })) } });
  assert.equal(result.isError, true);
  assert.ok(Array.isArray(result.content));
  assert.match(JSON.stringify(result.content), /MCP error -32602: Input validation error/);
  assert.match(JSON.stringify(result.content), /operations/);
  const secret = 'private-sentinel-should-not-appear';
  const invalid = await client.callTool({ name: 'fleet_batch', arguments: { operations: [{ operation: 'bogus', args: { value: secret } }] } });
  assert.equal(invalid.isError, true);
  assert.match(JSON.stringify(invalid.content), /MCP error -32602: Input validation error/);
  assert.match(JSON.stringify(invalid.content), /operations/);
  assert.doesNotMatch(JSON.stringify(invalid), new RegExp(secret));
  assert.equal(calls, 0);
});
