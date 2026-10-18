import { describe, expect, it } from 'vitest';
import { buildBridgeCommand } from './bridge-command';

describe('canonical bridge command', () => {
  it('explicitly sets up and starts the latest canonical package at the current origin', () => {
    expect(buildBridgeCommand({ apiUrl: 'https://ftown.example:8443' })).toBe(
      "npx -y ftown@latest setup && npx -y ftown@latest --api-url 'https://ftown.example:8443'",
    );
  });
  it('quotes shell metacharacters and embedded single quotes as one literal argument', () => {
    expect(buildBridgeCommand({ apiUrl: "https://example/'$(touch /tmp/never); space" })).toBe(
      "npx -y ftown@latest setup && npx -y ftown@latest --api-url 'https://example/'\\''$(touch /tmp/never); space'",
    );
  });
  it('uses the same explicit setup and default-start convention for Solo', () => {
    expect(buildBridgeCommand({ solo: true })).toBe('npx -y ftown@latest setup && npx -y ftown@latest --solo');
  });
});
