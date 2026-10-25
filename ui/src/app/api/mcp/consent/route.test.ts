import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), devices: vi.fn(), consent: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/bridge-refresh', () => ({ getDevicesForSub: mocks.devices }));
vi.mock('@/lib/mcp-consent', () => ({ mcpConsentRequest: mocks.consent }));
import { POST } from './route';

afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
const request = (origin: string) => new Request('https://localhost:3000/api/mcp/consent', {
  method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: '{}',
});
it('a configured TLS proxy origin reaches session authentication; foreign origins never do', async () => {
  vi.stubEnv('FTOWN_PUBLIC_URL', 'https://localhost:8444');
  mocks.auth.mockResolvedValue(null);
  const accepted = await POST(request('https://localhost:8444'));
  expect(accepted.status).toBe(401); expect(await accepted.json()).toEqual({ error: 'unauthorized' });
  expect(mocks.auth).toHaveBeenCalledTimes(1);
  const rejected = await POST(request('https://evil.test'));
  expect(rejected.status).toBe(403); expect(await rejected.json()).toEqual({ error: 'forbidden_origin' });
  expect(mocks.auth).toHaveBeenCalledTimes(1);
  expect(mocks.devices).not.toHaveBeenCalled(); expect(mocks.consent).not.toHaveBeenCalled();
});
it('invalid public-origin configuration fails closed before authentication', async () => {
  vi.stubEnv('FTOWN_PUBLIC_URL', 'https://user:secret@localhost:8444');
  const result = await POST(request('https://localhost:3000'));
  expect(result.status).toBe(403); expect(await result.json()).toEqual({ error: 'forbidden_origin' });
  expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.consent).not.toHaveBeenCalled();
});
