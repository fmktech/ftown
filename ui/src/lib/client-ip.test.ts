import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientIp, rateLimitKey, rateLimitKeyIp } from './client-ip';

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

describe('rateLimitKey', () => {
  it('leaves IPv4, "unknown" and unparseable values unchanged', () => {
    for (const value of ['203.0.113.7', '10.0.0.1', 'unknown', 'not-an-ip', '1.2.3', '', '::g', '1:2:3:4:5:6:7:8:9', '1::2::3', ':1', '1:', '[foo]']) {
      expect(rateLimitKey(value), value).toBe(value);
    }
  });

  it('buckets IPv6 by /64, whatever the notation of the interface id', () => {
    const key = '2001:db8:aa:bb::/64';
    for (const value of ['2001:db8:aa:bb:1:2:3:4', '2001:0DB8:00aa:00bb:ffff:ffff:ffff:ffff', '2001:db8:aa:bb::1', '2001:db8:aa:bb::',
      '2001:db8:aa:bb:0:0:0.0.0.1', '2001:db8:aa:bb::1%eth0', '[2001:db8:aa:bb::5]', '[2001:db8:aa:bb::5]:443', ' 2001:db8:aa:bb::7 ']) {
      expect(rateLimitKey(value), value).toBe(key);
    }
    expect(rateLimitKey('2001:db8:aa:bc::1')).toBe('2001:db8:aa:bc::/64');
    expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitKey('fe80::1')).toBe('fe80:0:0:0::/64');
  });

  it('a single /64 yields one key: 1000 random interface ids collapse to it', () => {
    const keys = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      const tail = Array.from(crypto.getRandomValues(new Uint16Array(4)), group => group.toString(16)).join(':');
      keys.add(rateLimitKey(`2001:db8:1:2:${tail}`));
    }
    expect([...keys]).toEqual(['2001:db8:1:2::/64']);
  });

  it('treats an IPv4-mapped IPv6 address as its IPv4 address', () => {
    expect(rateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('::FFFF:cb00:7107')).toBe('203.0.113.7');
    expect(rateLimitKey('0:0:0:0:0:ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('[::ffff:203.0.113.7]:80')).toBe('203.0.113.7');
    expect(rateLimitKey('::ffff:300.1.1.1')).toBe('::ffff:300.1.1.1');
  });
});

describe('rateLimitKeyIp', () => {
  it('applies rateLimitKey to the trusted client address, and clientIp itself is unchanged', () => {
    process.env.FLY_APP_NAME = 'ftown';
    const v6 = request({ 'fly-client-ip': '2001:db8:aa:bb:1:2:3:4' });
    expect(rateLimitKeyIp(v6)).toBe('2001:db8:aa:bb::/64');
    expect(clientIp(v6)).toBe('2001:db8:aa:bb:1:2:3:4');
    expect(rateLimitKeyIp(request({ 'fly-client-ip': '::ffff:198.51.100.4' }))).toBe('198.51.100.4');
    expect(rateLimitKeyIp(request({ 'fly-client-ip': '198.51.100.4' }))).toBe('198.51.100.4');
    delete process.env.FLY_APP_NAME;
    expect(rateLimitKeyIp(v6)).toBe('unknown');
  });
});
