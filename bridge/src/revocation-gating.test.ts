import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { bridgeMode, canReexecAfterRevocation, updateOperationActive } from './revocation-gating.js';

describe('bridgeMode', () => {
  it('maps the start flags to one mode', () => {
    assert.equal(bridgeMode({}), 'account');
    assert.equal(bridgeMode({ solo: true }), 'solo');
    assert.equal(bridgeMode({ local: true }), 'local');
  });
});

describe('canReexecAfterRevocation', () => {
  it('re-executes only outside an update restart and without an active update operation', () => {
    assert.equal(canReexecAfterRevocation({ updateRestart: false, updatePhase: null }), true);
    assert.equal(canReexecAfterRevocation({ updateRestart: true, updatePhase: null }), false);
    for (const phase of ['staging', 'prepared', 'restarting']) {
      assert.equal(canReexecAfterRevocation({ updateRestart: false, updatePhase: phase }), false, phase);
    }
    for (const phase of ['succeeded', 'failed']) {
      assert.equal(canReexecAfterRevocation({ updateRestart: false, updatePhase: phase }), true, phase);
    }
    assert.equal(canReexecAfterRevocation({ updateRestart: true, updatePhase: 'failed' }), false);
  });

  it('treats exactly the coordinator active phases as active', () => {
    assert.deepEqual(['staging', 'prepared', 'restarting', 'succeeded', 'failed'].filter(updateOperationActive), ['staging', 'prepared', 'restarting']);
    assert.equal(updateOperationActive(null), false);
  });
});
