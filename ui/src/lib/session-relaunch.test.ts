import { describe, expect, it } from 'vitest';
import { getSessionRelaunchLabel } from './session-relaunch';

describe('getSessionRelaunchLabel', () => {
  it('offers Rerun when a CLI exits successfully', () => {
    expect(getSessionRelaunchLabel('completed')).toBe('Rerun');
  });

  it('preserves Retry for failed sessions', () => {
    expect(getSessionRelaunchLabel('error')).toBe('Retry');
  });

  it('does not offer relaunch for live or indeterminate sessions', () => {
    expect(getSessionRelaunchLabel('running')).toBeNull();
    expect(getSessionRelaunchLabel('pending')).toBeNull();
    expect(getSessionRelaunchLabel('disconnected')).toBeNull();
  });
});
