import { afterEach, describe, expect, it } from 'vitest';
import { clientIp } from './client-ip';

const request = (headers: Record<string, string>): Request =>
  new Request('https://app.test/api/auth/register', { headers });

describe('clientIp trust model', () => {
  afterEach(() => { delete process.env.FTOWN_TRUSTED_PROXY; });

  it('always trusts the platform-injected fly-client-ip', () => {
    expect(clientIp(request({ 'fly-client-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('ignores spoofable proxy headers unless the operator opts in', () => {
    expect(clientIp(request({ 'x-real-ip': '1.2.3.4' }))).toBe('unknown');
    expect(clientIp(request({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('unknown');
    expect(clientIp(request({}))).toBe('unknown');
  });

  it('trusts x-real-ip and the rightmost forwarded hop when FTOWN_TRUSTED_PROXY=1', () => {
    process.env.FTOWN_TRUSTED_PROXY = '1';
    expect(clientIp(request({ 'x-real-ip': '1.2.3.4' }))).toBe('1.2.3.4');
    expect(clientIp(request({ 'x-forwarded-for': 'attacker, 5.6.7.8' }))).toBe('5.6.7.8');
    expect(clientIp(request({ 'fly-client-ip': '203.0.113.7', 'x-real-ip': '1.2.3.4' }))).toBe('203.0.113.7');
  });

  it('still trusts fly-client-ip even with other proxy headers present and no opt-in', () => {
    expect(clientIp(request({ 'fly-client-ip': '203.0.113.9', 'x-real-ip': '1.2.3.4' }))).toBe('203.0.113.9');
  });
});
