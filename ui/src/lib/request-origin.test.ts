import { afterEach, expect, it, vi } from 'vitest';
import { isTrustedBrowserOrigin } from './request-origin';

const internal = 'https://localhost:3000/api/mcp/consent';
const publicOrigin = 'https://localhost:8444';
const request = (origin: string | null, forwarded: Record<string, string> = {}) => new Request(internal, {
  headers: { ...(origin === null ? {} : { origin }), ...forwarded },
});
afterEach(() => vi.unstubAllEnvs());

it('accepts only the existing request origin and the exact configured public origin', () => {
  expect(isTrustedBrowserOrigin(request('https://localhost:3000'), publicOrigin)).toBe(true);
  expect(isTrustedBrowserOrigin(request(publicOrigin), publicOrigin)).toBe(true);
  expect(isTrustedBrowserOrigin(new Request('http://localhost:3000/api/security/endpoints', { headers: { origin: 'http://localhost:3000' } }), publicOrigin)).toBe(true);
  for (const origin of [null, 'null', 'https://evil.test', 'https://localhost:8443', 'http://localhost:8444', 'https://localhost.evil.test:8444']) {
    expect(isTrustedBrowserOrigin(request(origin), publicOrigin)).toBe(false);
  }
});
it('validates present configuration before either accepted-origin comparison', () => {
  for (const configured of ['', ' https://localhost:8444', 'https://localhost:8444 ', 'https:example.com', 'https://EXAMPLE.com',
    'https://example.com/', 'https://example.com/path', 'https://user:secret@example.com', 'https://example.com?x=1',
    'https://example.com#fragment', 'https://example.com,https://evil.test', 'null', 'http://example.com', 'file:///tmp/page']) {
    expect(isTrustedBrowserOrigin(request('https://localhost:3000'), configured)).toBe(false);
  }
  for (const configured of ['https://example.com', 'http://localhost:8444', 'http://127.0.0.1:8444', 'http://[::1]:8444']) {
    expect(isTrustedBrowserOrigin(request(configured), configured)).toBe(true);
  }
});
it('rejects noncanonical or multiple Origin values without URL normalization', () => {
  for (const origin of ['https:localhost:3000', 'https://localhost:3000/', 'https://user:secret@localhost:3000',
    'https://localhost:3000?x=1', 'https://localhost:3000#fragment', 'https://localhost:3000 https://evil.test',
    'https://localhost:3000, https://evil.test', ' https://localhost:3000', 'https://localhost:3000 ']) {
    // Preserve raw header syntax here; the Request constructor trims HTTP whitespace.
    const raw = { url: internal, headers: { get: () => origin } } as unknown as Request;
    expect(isTrustedBrowserOrigin(raw, publicOrigin)).toBe(false);
  }
});
it('never derives trusted origins from Host or forwarding headers', () => {
  expect(isTrustedBrowserOrigin(request('https://evil.test', {
    host: 'evil.test', 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https', forwarded: 'host=evil.test;proto=https',
  }), publicOrigin)).toBe(false);
  expect(isTrustedBrowserOrigin(request(null, { 'x-forwarded-host': 'localhost:8444', 'x-forwarded-proto': 'https' }), publicOrigin)).toBe(false);
});
it('uses the configured environment origin and preserves same-origin development when absent', () => {
  vi.stubEnv('FTOWN_PUBLIC_URL', publicOrigin);
  expect(isTrustedBrowserOrigin(request(publicOrigin))).toBe(true);
  vi.stubEnv('FTOWN_PUBLIC_URL', undefined);
  expect(isTrustedBrowserOrigin(request('https://localhost:3000'))).toBe(true);
  expect(isTrustedBrowserOrigin(request(publicOrigin))).toBe(false);
});
