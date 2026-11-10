import { it, expect, vi } from 'vitest';
import { generateEndpoint } from '@security/crypto';
import { SecurityStore, parseDirectoryEntry, boundedSecurityJson } from './security-store';
const owner = 'A'.repeat(43);
const other = 'B'.repeat(43);
it('public discovery rejects wrong fingerprints, unknown fields and role/bridge mismatches', async () => {
  const identity = await generateEndpoint(owner, 'browser');
  const entry = { endpoint: identity.endpoint, bridgeId: null, label: 'Browser', protocolVersion: 1 };
  expect(await parseDirectoryEntry(entry)).toEqual(entry);
  for (const invalid of [
    { ...entry, secret: 'must-not-be-stored' }, { ...entry, bridgeId: 'bridge-a' },
    { ...entry, label: 'bad\nlabel' }, { ...entry, endpoint: { ...identity.endpoint, id: 'a'.repeat(43) } },
  ]) await expect(parseDirectoryEntry(invalid)).rejects.toMatchObject({ code: 'invalid_endpoint' });
});
it('registration uses authenticated account and cannot cross-write or bypass capacity', async () => {
  const identity = await generateEndpoint(owner, 'browser');
  const entry = await parseDirectoryEntry({ endpoint: identity.endpoint, bridgeId: null, label: 'Browser', protocolVersion: 1 });
  const query = vi.fn().mockResolvedValue([]);
  const store = new SecurityStore(query);
  await expect(store.register(other, entry)).rejects.toMatchObject({ status: 403 });
  expect(query).not.toHaveBeenCalled();
  await expect(store.register(owner, entry)).rejects.toMatchObject({ code: 'conflict' });
  expect(String(query.mock.calls[0][0])).toContain('IS NOT DISTINCT FROM EXCLUDED.bridge_id');
  expect(query.mock.calls[0][1][0]).toBe(owner);
  expect(String(query.mock.calls[0][0])).toContain('account_id=$1'); expect(String(query.mock.calls[0][0])).not.toContain('owner_id');
  expect(JSON.stringify(query.mock.calls[0][1])).not.toContain('privateKey');
});
it('directory query is account-scoped and rejects conflicting stored owner metadata', async () => {
  const identity = await generateEndpoint(other, 'browser');
  const query = vi.fn().mockResolvedValue([{ entry: { endpoint: identity.endpoint, bridgeId: null, label: 'Other', protocolVersion: 1 } }]);
  await expect(new SecurityStore(query).directory(owner)).rejects.toMatchObject({ code: 'storage_unavailable' });
  expect(query.mock.calls[0][1]).toEqual([owner]); expect(String(query.mock.calls[0][0])).toContain('WHERE account_id=$1');
});
it('rejects a legacy UUID owner id', async () => {
  const identity = await generateEndpoint(owner, 'browser');
  const entry = { endpoint: { ...identity.endpoint, ownerId: '349f8d2e-38e4-4d59-888d-687dcfa19e39' }, bridgeId: null, label: 'Browser', protocolVersion: 1 };
  await expect(parseDirectoryEntry(entry)).rejects.toMatchObject({ code: 'invalid_endpoint' });
});
it('streamed security JSON rejects oversized and malformed input', async () => {
  const request = (text: string) => new Request('https://app.test/api/security/endpoints', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: text });
  await expect(boundedSecurityJson(request('x'.repeat(100)), 50)).rejects.toMatchObject({ status: 413 });
  await expect(boundedSecurityJson(request('not-json'))).rejects.toMatchObject({ status: 400 });
  expect(await boundedSecurityJson(request('{"version":1}'))).toEqual({ version: 1 });
});

it('distinguishes missing and empty bodies from declared oversized bodies', async () => {
  const headers = { 'Content-Type': 'application/json' };
  const missing = new Request('https://app.test/', { method: 'POST', headers });
  await expect(boundedSecurityJson(missing, 50)).rejects.toMatchObject({ status: 400 });
  const declaredOversize = new Request('https://app.test/', { method: 'POST', headers: { ...headers, 'Content-Length': '51' } });
  await expect(boundedSecurityJson(declaredOversize, 50)).rejects.toMatchObject({ status: 413 });
  const emptyStream = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  const empty = new Request('https://app.test/', { method: 'POST', headers, body: emptyStream, duplex: 'half' } as RequestInit);
  await expect(boundedSecurityJson(empty, 50)).rejects.toMatchObject({ status: 400 });
  const unsupported = new Request('https://app.test/', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'Content-Length': '51' } });
  await expect(boundedSecurityJson(unsupported, 50)).rejects.toMatchObject({ status: 400 });
});
