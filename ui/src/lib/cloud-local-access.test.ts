// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCloudLocalAccess } from './cloud-local-access';
import { readDevice, rememberDevice } from './local-browser-client';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());
it('never exchanges a cloud-visible capability for browser authorization', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const prepare = createCloudLocalAccess(new AbortController().signal);
  await expect(prepare({ bridgeId: 'bridge-a', localPort: 43127, localNonce: 'a'.repeat(32) })).rejects.toMatchObject({ code: 'approval_required' });
  expect(fetcher).not.toHaveBeenCalled(); expect(readDevice()).toBeNull();
});
it('remembers only discovery metadata and strips legacy bearer credentials', () => {
  rememberDevice({ port: 43127, bridgeId: 'bridge-a', credential: 'must-not-persist' }, true);
  expect(readDevice()).toEqual({ port: 43127, bridgeId: 'bridge-a' });
  expect(JSON.stringify(localStorage)).not.toContain('must-not-persist');
});
