import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './server.js';
import { configSchema, FleetError, requestSchema } from './fleet.js';

test('preview reply tool sends one explicit target and is hidden from read-only clients', async t => {
  const config = configSchema.parse({ machines: [{ id: 'machine', transport: 'local' }] });
  const calls: { method: string; path: string; body: unknown }[] = []; let denied = false;
  const server = createMcpServer({ config, request: async (_machine, method, path, body) => {
    calls.push({ method, path, body }); return { sessionId: 'session', turn: { id: (body as { id: string }).id } };
  } }, { revalidate: async () => { if (denied) throw new FleetError('permission_denied', 'denied'); } });
  const client = new Client({ name: 'test', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b); t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'preview_chat_reply', arguments: { machine: 'machine', sessionId: 'session', text: 'hello\nworld' } });
  assert.equal(result.isError, undefined); assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].path, '/api/sessions/session/preview-chat/reply');
  assert.match((calls[0].body as { id: string }).id, /^[0-9a-f-]{36}$/);
  assert.doesNotThrow(() => requestSchema.parse({ method: 'POST', path: calls[0].path, timeoutMs: 1000 }));
  assert.throws(() => requestSchema.parse({ method: 'POST', path: '/api/sessions/session/preview-chat/send', timeoutMs: 1000 }));
  denied = true; const resultDenied = await client.callTool({ name: 'preview_chat_reply', arguments: { machine: 'machine', sessionId: 'session', text: 'x' } });
  assert.equal(resultDenied.isError, true); assert.equal(calls.length, 1);
  const readonly = createMcpServer({ config, request: async () => ({}) }, { readOnly: true });
  const readonlyClient = new Client({ name: 'readonly', version: '1' }); const [c, d] = InMemoryTransport.createLinkedPair();
  await readonly.connect(c); await readonlyClient.connect(d);
  assert.equal((await readonlyClient.listTools()).tools.some(tool => tool.name === 'preview_chat_reply'), false);
  await readonlyClient.close(); await readonly.close();
});

test('revocation after mutation preserves uncertain outcome and the retry ID', async t => {
  const config = configSchema.parse({ machines: [{ id: 'machine', transport: 'local' }] }); let checks = 0;
  const server = createMcpServer({ config, request: async () => ({ sessionId: 'session' }) }, { revalidate: async () => { if (++checks > 1) throw new FleetError('permission_denied', 'revoked'); } });
  const client = new Client({ name: 'test', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b); t.after(async () => { await client.close(); await server.close(); });
  const id = '12345678-1234-4234-8234-123456789abc';
  const reply = await client.callTool({ name: 'preview_chat_reply', arguments: { machine: 'machine', sessionId: 'session', id, text: 'hello' } });
  assert.equal(reply.isError, true);
  const error = (reply.structuredContent as { error: { message: string; outcomeUnknown: boolean } }).error;
  assert.equal(error.outcomeUnknown, true); assert.ok(error.message.includes(id));
});
