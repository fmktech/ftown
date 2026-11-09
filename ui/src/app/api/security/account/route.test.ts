import { beforeEach, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { generateEndpoint } from '@security/crypto';
import { createAccountGenesis, generateAccountSigningIdentity, signAccountTransition, verifyAccountHistory } from '@security/account-crypto';
import type { AccountOperation } from '@security/account-protocol';
const { auth, query, storageQuery, rateQuery, events } = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn(), storageQuery: vi.fn(), rateQuery: vi.fn(), events: [] as string[] }));
vi.mock('@/lib/auth', () => ({ auth }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ query }) }));
vi.mock('@/lib/server-security-nudge', () => ({
  afterResponse: (work: () => Promise<void>) => { events.push('nudge'); void work().catch(() => undefined); },
  nudgeOwnerById: vi.fn(async () => undefined),
  nudgePendingChange: vi.fn(),
}));
import { GET, POST } from './route';
import { POST as enrollmentCreate } from './enrollments/route';
import { GET as enrollmentGet } from './enrollments/[id]/route';
const owner = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
const key = crypto.randomUUID().repeat(2);
beforeEach(() => {
  vi.resetAllMocks();
  events.length = 0;
  process.env.FTOWN_PUBLIC_URL = 'https://public.test';
  process.env.CENTRIFUGO_TOKEN_SECRET = key;
  auth.mockResolvedValue({ user: { id: owner, email: 'owner@example.test' } });
  rateQuery.mockResolvedValue([{ failed_count: 1, retry_after: 60 }]);
  query.mockImplementation((text: string, params: unknown[]) => text.startsWith('INSERT INTO rate_limit_attempts') ? rateQuery(text, params) : storageQuery(text, params));
});
function request(body: unknown, origin = 'https://public.test') {
  return new Request('https://localhost:3000/api/security/account', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
it('GET uses session owner, accepts absent Origin and returns public null without creating authority', async () => {
  storageQuery.mockResolvedValueOnce([]);
  const response = await GET(new Request('https://public.test/api/security/account'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ history: null });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(storageQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE owner_id=$1'), [owner]);
});
it('public proxy Origin reaches authentication; hostile or malformed-config Origin fails closed', async () => {
  auth.mockResolvedValue(null);
  expect((await POST(request({}))).status).toBe(401);
  expect((await POST(request({}, 'https://evil.test'))).status).toBe(403);
  process.env.FTOWN_PUBLIC_URL = 'https://public.test/path';
  expect((await POST(request({}, 'https://localhost:3000'))).status).toBe(403);
  expect(storageQuery).not.toHaveBeenCalled();
});
it('bridge GET requires the current owner-bound bridge registration and never authorizes a browser mutation', async () => {
  auth.mockResolvedValue(null);
  const bearer = jwt.sign({ sub: 'owner@example.test', info: { ownerId: owner, bridgeId: 'bridge-a' } }, key, { audience: 'ftown:centrifugo', expiresIn: 60 });
  storageQuery.mockResolvedValueOnce([{ owner_id: owner }]).mockResolvedValueOnce([]);
  const response = await GET(new Request('https://public.test/api/security/account', { headers: { authorization: `Bearer ${bearer}` } }));
  expect(response.status).toBe(200);
  expect(storageQuery.mock.calls[0][0]).toContain("current_jti<>'revoked'");
  expect(storageQuery.mock.calls[0][1]).toEqual(['bridge-a', 'owner@example.test']);
  const mutation = request({}); mutation.headers.set('authorization', `Bearer ${bearer}`);
  expect((await POST(mutation)).status).toBe(401);
  storageQuery.mockResolvedValueOnce([]);
  expect((await GET(new Request('https://public.test/api/security/account', { headers: { authorization: `Bearer ${bearer}` } }))).status).toBe(403);
});
it('signed genesis POST stores only authenticated owner material with CAS and returns no private key', async () => {
  const identity = await generateEndpoint(owner, 'browser');
  const signing = await generateAccountSigningIdentity();
  const genesis = await createAccountGenesis(owner, identity.endpoint, signing, 'Browser');
  storageQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ owner_id: owner }]);
  const response = await POST(request({ expectedHead: null, record: genesis }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.history.genesis).toEqual(genesis);
  expect(JSON.stringify(body)).not.toContain('privateKey');
  expect(storageQuery.mock.calls[1][0]).toContain('ON CONFLICT(owner_id) DO NOTHING');
  expect(storageQuery.mock.calls[1][1][0]).toBe(owner);
});
it('rate denial and streamed oversized mutations return bounded errors before storage', async () => {
  rateQuery.mockResolvedValueOnce([{ failed_count: 61, retry_after: 12.1 }]);
  const limited = await POST(request({}));
  expect(limited.status).toBe(429);
  expect(limited.headers.get('retry-after')).toBe('13');
  const response = await POST(request({ data: 'x'.repeat(2106000) }));
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: { code: 'account_capacity_exceeded', retryable: false } });
  expect(storageQuery).not.toHaveBeenCalled();
});
it('enrollment creation rejects uploaded fragment secrets; foreign/missing lookups reveal no request', async () => {
  expect((await enrollmentCreate(request({ request: {}, secret: 'never-upload-fragments' }))).status).toBe(400);
  storageQuery.mockResolvedValueOnce([]);
  const response = await enrollmentGet(new Request('https://public.test/api/security/account/enrollments/id'), { params: Promise.resolve({ id: 'A'.repeat(43) }) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'account_enrollment_invalid' } });
  expect(storageQuery.mock.calls[0][1]).toEqual([owner, 'A'.repeat(43)]);
});

type Op = AccountOperation;
/** Real signed history: genesis (+ optional add_bridge), then the record under test, with the head the client would send. */
async function scenario(finalOp: (bridgeId: string) => Op, withBridge: boolean) {
  const browser = await generateEndpoint(owner, 'browser');
  const signing = await generateAccountSigningIdentity();
  const bridge = await generateEndpoint(owner, 'bridge');
  const t0 = Date.now() - 10_000;
  let history = { genesis: await createAccountGenesis(owner, browser.endpoint, signing, 'Browser', t0), transitions: [] as Awaited<ReturnType<typeof signAccountTransition>>[] };
  let state = await verifyAccountHistory(history, null, t0 + 1);
  const sign = async (operation: Op) => {
    const record = await signAccountTransition(state, browser.endpoint.id, signing, operation, t0 + 2 + history.transitions.length);
    const next = { ...history, transitions: [...history.transitions, record] };
    return { record, next, nextState: await verifyAccountHistory(next, state, t0 + 3 + history.transitions.length) };
  };
  if (withBridge) {
    const added = await sign({ type: 'add_bridge', bridge: { bridgeId: 'bridge-a', endpoint: bridge.endpoint, label: 'Laptop', approvedAt: new Date(t0).toISOString() } });
    history = added.next; state = added.nextState;
  }
  const { record } = await sign(finalOp('bridge-a'));
  return { record, previous: { history, state }, row: [{ root_id: state.rootId, revision: state.revision, head: state.head, history }],
    expectedHead: { rootId: state.rootId, revision: state.revision, head: state.head } };
}
function wireStorage(previousRow: unknown[], update: (text: string, params: unknown[]) => Promise<unknown>, replaySame = false) {
  storageQuery.mockImplementation((text: string, params: unknown[]) => {
    if (text.startsWith('SELECT root_id')) return Promise.resolve(previousRow);
    if (text.includes('UPDATE bridge_refresh')) { events.push('tombstone'); return update(text, params); }
    return Promise.resolve(replaySame ? [] : [{ owner_id: owner }]);
  });
}

it('signed revoke_bridge append tombstones the bridge refresh token before the nudge is scheduled', async () => {
  const s = await scenario(bridgeId => ({ type: 'revoke_bridge', bridgeId }), true);
  const update = vi.fn().mockResolvedValue([{ bridge_id: 'bridge-a' }]);
  wireStorage(s.row, update);
  const response = await POST(request({ expectedHead: s.expectedHead, record: s.record }));
  expect(response.status).toBe(200);
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0][1]).toEqual(['revoked', 'bridge-a', owner]);
  expect(events).toEqual(['tombstone', 'nudge']);
});

it('a throwing tombstone UPDATE is logged and the success response and nudge are unchanged', async () => {
  const s = await scenario(bridgeId => ({ type: 'revoke_bridge', bridgeId }), true);
  const update = vi.fn().mockRejectedValue(new Error('db down'));
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  wireStorage(s.row, update);
  const response = await POST(request({ expectedHead: s.expectedHead, record: s.record }));
  expect(response.status).toBe(200);
  expect((await response.json()).history.transitions).toHaveLength(s.previous.history.transitions.length + 1);
  expect(events).toEqual(['tombstone', 'nudge']);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('[account]'), expect.any(Error));
  log.mockRestore();
});

it('add_bridge append issues no tombstone UPDATE', async () => {
  const browser = await generateEndpoint(owner, 'browser');
  const signing = await generateAccountSigningIdentity();
  const bridge = await generateEndpoint(owner, 'bridge');
  const t0 = Date.now() - 10_000;
  const genesis = await createAccountGenesis(owner, browser.endpoint, signing, 'Browser', t0);
  const history = { genesis, transitions: [] };
  const state = await verifyAccountHistory(history, null, t0 + 1);
  const record = await signAccountTransition(state, browser.endpoint.id, signing, { type: 'add_bridge', bridge: { bridgeId: 'bridge-a', endpoint: bridge.endpoint, label: 'Laptop', approvedAt: new Date(t0).toISOString() } }, t0 + 2);
  const update = vi.fn();
  wireStorage([{ root_id: state.rootId, revision: state.revision, head: state.head, history }], update);
  const response = await POST(request({ expectedHead: { rootId: state.rootId, revision: state.revision, head: state.head }, record }));
  expect(response.status).toBe(200);
  expect(update).not.toHaveBeenCalled();
  expect(events).toEqual(['nudge']);
});

it('add_device append and a conflicting (non-writing) replay issue no tombstone UPDATE', async () => {
  const browser = await generateEndpoint(owner, 'browser');
  const signing = await generateAccountSigningIdentity();
  const second = await generateEndpoint(owner, 'browser');
  const secondSigning = await generateAccountSigningIdentity();
  const t0 = Date.now() - 10_000;
  const genesis = await createAccountGenesis(owner, browser.endpoint, signing, 'Browser', t0);
  const history = { genesis, transitions: [] };
  const state = await verifyAccountHistory(history, null, t0 + 1);
  const record = await signAccountTransition(state, browser.endpoint.id, signing, { type: 'add_device', device: { endpoint: second.endpoint, signingPublicKey: secondSigning.publicKey, label: 'Second', approvedAt: new Date(t0).toISOString() } }, t0 + 2);
  const update = vi.fn();
  wireStorage([{ root_id: state.rootId, revision: state.revision, head: state.head, history }], update);
  const response = await POST(request({ expectedHead: { rootId: state.rootId, revision: state.revision, head: state.head }, record }));
  expect(response.status).toBe(200);
  expect(update).not.toHaveBeenCalled();
  // Replay of the already-stored genesis: CAS insert conflicts, so store.changed stays false.
  events.length = 0;
  wireStorage([], update, true);
  const replay = await POST(request({ expectedHead: null, record: genesis }));
  expect(replay.status).toBe(409);
  expect(update).not.toHaveBeenCalled();
  expect(events).toEqual([]);
});

it('a malformed append result (no transitions array) still succeeds and schedules the nudge', async () => {
  const { AccountTrustStore } = await import('@/lib/account-trust-store');
  const spy = vi.spyOn(AccountTrustStore.prototype, 'append').mockImplementation(async function (this: { changed: boolean }) { this.changed = true; return {} as never; });
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const response = await POST(request({ expectedHead: null, record: {} }));
  expect(response.status).toBe(200);
  expect(events).toEqual(['nudge']);
  expect(log).toHaveBeenCalled();
  spy.mockRestore(); log.mockRestore();
});
