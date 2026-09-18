// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCloudLocalAccess } from './cloud-local-access';
import { readDevice, rememberDevice } from './local-browser-client';

const advert = { bridgeId: 'bridge-a', localPort: 43127, localNonce: 'a'.repeat(32) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());

it('cloud proof establishes remembered access without pairing and coalesces click/presence requests', async () => {
  let credential = '';
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(url.startsWith('http://127.0.0.1:43127/api/browser/')).toBe(true);
    expect(init.credentials).toBe('omit'); expect(init.redirect).toBe('error');
    if (url.endsWith('/cloud-devices')) {
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${advert.localNonce}` });
      const body = JSON.parse(init.body as string);
      expect(body.bridgeId).toBe(advert.bridgeId); credential = body.credential;
      expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
      return json({ credential });
    }
    expect(url.endsWith('/bootstrap')).toBe(true);
    return json({ version: 1, bridgeId: advert.bridgeId, userId: 'owner', hostname: 'laptop', localPort: advert.localPort, localNonce: credential });
  });
  vi.stubGlobal('fetch', fetcher);
  const prepare = createCloudLocalAccess(new AbortController().signal);
  await Promise.all([prepare(advert), prepare(advert)]);
  await prepare(advert);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(readDevice()).toEqual({ port: advert.localPort, bridgeId: advert.bridgeId, credential });
});

it('reuses remembered authorization and never silently replaces a revoked saved credential', async () => {
  rememberDevice({ port: advert.localPort, bridgeId: advert.bridgeId, credential: 'b'.repeat(43) }, true);
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => json({ error: 'revoked' }, 401)); vi.stubGlobal('fetch', fetcher);
  await createCloudLocalAccess(new AbortController().signal)(advert);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toContain('/bootstrap');
});

it('ignores untrusted/missing adverts and does not save access for a different bridge on the same port', async () => {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => url.endsWith('/cloud-devices')
    ? json({ credential: JSON.parse(init.body as string).credential })
    : json({ version: 1, bridgeId: 'foreign', userId: 'owner', hostname: 'x', localPort: advert.localPort, localNonce: 'wrong' }));
  vi.stubGlobal('fetch', fetcher);
  const prepare = createCloudLocalAccess(new AbortController().signal);
  for (const bad of [null, {}, { ...advert, localPort: 65536 }, { ...advert, localNonce: '' }]) await prepare(bad);
  expect(fetcher).not.toHaveBeenCalled();
  await prepare(advert);
  expect(readDevice()).toBeNull();
});

it('retries a failed exchange with the same proposed credential without affecting cloud use', async () => {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => { throw new Error('remote bridge is not on this computer'); });
  vi.stubGlobal('fetch', fetcher);
  const prepare = createCloudLocalAccess(new AbortController().signal);
  await prepare(advert); await prepare(advert);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect((fetcher.mock.calls[0]?.[1] as RequestInit).body).toBe((fetcher.mock.calls[1]?.[1] as RequestInit).body);
  expect(readDevice()).toBeNull();
});
