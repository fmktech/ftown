import { afterEach, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { generateEndpoint } from '@security/crypto';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ query: mocks.query }) }));
import { PUT, GET } from './route';
const owner = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
const other = '619f68a6-77c1-49f6-ae2d-c5fa169d284b';
const secret = 'isolated-test-signing-key-not-production-12345';
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
it('browser directory write derives its owner from session and requires same origin', async () => {
  const identity = await generateEndpoint(owner, 'browser');
  mocks.auth.mockResolvedValue({ user: { id: owner } }); mocks.query.mockResolvedValue([{ endpoint_id: identity.endpoint.id }]);
  const body = { endpoint: identity.endpoint, bridgeId: null, label: 'Browser', protocolVersion: 1 };
  const req = (origin: string, entry = body) => new Request('https://app.test/api/security/endpoints', { method: 'PUT', headers: { 'Content-Type': 'application/json', origin }, body: JSON.stringify(entry) });
  expect((await PUT(req('https://evil.test'))).status).toBe(403);
  expect(mocks.query).not.toHaveBeenCalled();
  expect((await PUT(req('https://app.test', { ...body, endpoint: { ...body.endpoint, ownerId: other } }))).status).toBe(403);
  expect((await PUT(req('https://app.test'))).status).toBe(200);
  expect(mocks.query.mock.calls.at(-1)?.[1][0]).toBe(owner);
});
it('bridge directory write requires signed exact bridge/account proof and active ownership', async () => {
  vi.stubEnv('CENTRIFUGO_TOKEN_SECRET', secret);
  const identity = await generateEndpoint(owner, 'bridge');
  const body = { endpoint: identity.endpoint, bridgeId: 'bridge-a', label: 'Bridge', protocolVersion: 1 };
  const req = (bridgeId: string) => new Request('https://app.test/api/security/endpoints', { method: 'PUT', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${jwt.sign({ sub: 'owner@example.test', info: { bridgeId, ownerId: owner } }, secret, { audience: 'ftown:centrifugo', expiresIn: 60 })}` }, body: JSON.stringify(body) });
  expect((await PUT(req('other-bridge'))).status).toBe(403);
  mocks.query.mockResolvedValueOnce([]);
  expect((await PUT(req('bridge-a'))).status).toBe(403);
  mocks.query.mockResolvedValueOnce([{ owner_id: owner }]).mockResolvedValueOnce([{ endpoint_id: identity.endpoint.id }]);
  expect((await PUT(req('bridge-a'))).status).toBe(200);
  expect(mocks.auth).not.toHaveBeenCalled();
});
it('anonymous directory reads never expose endpoint metadata', async () => {
  mocks.auth.mockResolvedValue(null);
  expect((await GET()).status).toBe(401); expect(mocks.query).not.toHaveBeenCalled();
});
it('configured public origin reaches browser authentication without granting endpoint registration', async () => {
  vi.stubEnv('FTOWN_PUBLIC_URL', 'https://localhost:8444');
  const identity = await generateEndpoint(owner, 'browser');
  mocks.auth.mockResolvedValue(null);
  const body = { endpoint: identity.endpoint, bridgeId: null, label: 'Browser', protocolVersion: 1 };
  const req = (origin: string) => new Request('https://localhost:3000/api/security/endpoints', { method: 'PUT',
    headers: { 'Content-Type': 'application/json', origin }, body: JSON.stringify(body) });
  const accepted = await PUT(req('https://localhost:8444'));
  expect(accepted.status).toBe(401); expect(await accepted.json()).toEqual({ error: 'unauthorized' });
  const rejected = await PUT(req('https://evil.test'));
  expect(rejected.status).toBe(403); expect(await rejected.json()).toEqual({ error: 'forbidden_origin' });
  expect(mocks.auth).toHaveBeenCalledTimes(1); expect(mocks.query).not.toHaveBeenCalled();
});
