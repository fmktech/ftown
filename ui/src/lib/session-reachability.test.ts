import { describe, expect, it } from 'vitest';
import { deriveSessionReachabilityStatus } from './session-reachability';

describe('deriveSessionReachabilityStatus', () => {
  it('keeps a running session live when its bridge is directly reachable without cloud presence', () => {
    expect(
      deriveSessionReachabilityStatus(
        'running',
        'local-bridge',
        new Set(['cloud-bridge']),
        new Set(['local-bridge']),
      ),
    ).toBe('running');
  });

  it('retains the Centrifugo presence fallback when there is no direct path', () => {
    expect(
      deriveSessionReachabilityStatus(
        'running',
        'missing-bridge',
        new Set(['cloud-bridge']),
        new Set(),
      ),
    ).toBe('disconnected');
  });

  it('does not rewrite terminal session states', () => {
    expect(
      deriveSessionReachabilityStatus(
        'completed',
        'missing-bridge',
        new Set(['cloud-bridge']),
        new Set(),
      ),
    ).toBe('completed');
  });
});
