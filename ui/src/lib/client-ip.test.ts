import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientIp } from './client-ip';

const request = (headers: Record<string, string>): Request =>
  new Request('https://app.test/api/auth/register', { headers });

const ENV_KEYS = ['FTOWN_TRUSTED_PROXY', 'VERCEL', 'FLY_APP_NAME', 'FLY_MACHINE_ID'] as const;
// The CI e2e job exports FTOWN_TRUSTED_PROXY=1 into this process. Reset the trust
// inputs before each case so the model is tested from a known state, then restore
// the ambient values so any other file sharing the worker is unaffected.
const ambient = new Map<string, string | undefined>(ENV_KEYS.map(key => [key, process.env[key]]));
beforeEach(() => { for (const key of ENV_KEYS) delete process.env[key]; });
afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ambient.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('clientIp trust model', () => {
  it('fails closed on a bare self-hosted deployment', () => {
    expect(clientIp(request({ 'x-real-ip': '1.2.3.4' }))).toBe('unknown');
    expect(clientIp(request({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('unknown');
    expect(clientIp(request({}))).toBe('unknown');
  });

  it('ignores a spoofed fly-client-ip when not running on Fly', () => {
    expect(clientIp(request({ 'fly-client-ip': 'attacker-key-1' }))).toBe('unknown');
  });

  it('trusts fly-client-ip only when running on Fly', () => {
    process.env.FLY_APP_NAME = 'ftown';
    expect(clientIp(request({ 'fly-client-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('trusts the Vercel ingress headers', () => {
    process.env.VERCEL = '1';
    expect(clientIp(request({ 'x-real-ip': '198.51.100.1' }))).toBe('198.51.100.1');
    expect(clientIp(request({ 'x-forwarded-for': 'attacker, 203.0.113.2' }))).toBe('203.0.113.2');
  });

  it('trusts proxy headers only when the operator opts in', () => {
    process.env.FTOWN_TRUSTED_PROXY = '1';
    expect(clientIp(request({ 'x-real-ip': '1.2.3.4' }))).toBe('1.2.3.4');
    expect(clientIp(request({ 'x-forwarded-for': 'attacker, 5.6.7.8' }))).toBe('5.6.7.8');
  });

  it('does not let a bare self-hosted deployment opt in via a Fly header name', () => {
    // FLY_APP_NAME unset => fly-client-ip is untrusted even with the proxy opt-in.
    process.env.FTOWN_TRUSTED_PROXY = '1';
    expect(clientIp(request({ 'fly-client-ip': 'spoofed' }))).toBe('unknown');
  });
});
