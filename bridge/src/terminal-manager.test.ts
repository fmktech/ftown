import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalManager } from './terminal-manager.js';

describe('TerminalManager.getSize', () => {
  it('does not allocate for an absent terminal and returns undefined after destroy', () => {
    const manager = new TerminalManager();
    assert.equal(manager.getSize('missing'), undefined);
    assert.equal(manager.has('missing'), false);
    manager.write('missing', '');
    manager.destroy('missing');
    assert.equal(manager.getSize('missing'), undefined);
    assert.equal(manager.has('missing'), false);
  });

  it('returns current dimensions as an independent copy', () => {
    const manager = new TerminalManager();
    manager.write('sized', '');
    try {
      manager.resize('sized', 80, 37);
      const size = manager.getSize('sized');
      assert.deepEqual(size, { cols: 80, rows: 37 });
      assert.ok(size);
      size.cols = 1;
      size.rows = 1;
      assert.deepEqual(manager.getSize('sized'), { cols: 80, rows: 37 });
    } finally { manager.destroy('sized'); }
  });
});
