import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { shouldResurrectStoredSession } from './session-resurrection.js';
import type { Session } from './types.js';

function session(overrides: Partial<Session>): Session {
  return {
    id: 's1',
    name: 'session',
    command: 'cmd',
    status: 'running',
    bridgeId: 'b1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('shouldResurrectStoredSession', () => {
  it('resurrects only live top-level sessions', () => {
    assert.strictEqual(shouldResurrectStoredSession(session({ status: 'running' })), true);
    assert.strictEqual(shouldResurrectStoredSession(session({ status: 'pending' })), true);
    assert.strictEqual(shouldResurrectStoredSession(session({ status: 'completed' })), false);
    assert.strictEqual(shouldResurrectStoredSession(session({ status: 'error' })), false);
  });

  it('leaves loop-run sessions for the loop scheduler instead of generic resurrection', () => {
    assert.strictEqual(shouldResurrectStoredSession(session({ status: 'running', loopId: 'loop-1' })), false);
    assert.strictEqual(shouldResurrectStoredSession(session({ status: 'pending', loopId: 'loop-1' })), false);
  });
});
