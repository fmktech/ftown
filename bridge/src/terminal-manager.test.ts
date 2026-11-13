import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalManager } from './terminal-manager.js';

describe('TerminalManager.whenParsed', () => {
  it('runs once the emulator holds exactly the bytes written before the call', async () => {
    const manager = new TerminalManager();
    try {
      manager.write('s1', 'OLD ');
      manager.write('s1', 'SAMETICK');
      // Same turn as the write: the emulator has not parsed it yet.
      assert.equal(manager.serialize('s1', 0).includes('SAMETICK'), false);
      const seen = await new Promise<string>((resolve) => {
        manager.whenParsed('s1', () => resolve(manager.serialize('s1', 0)));
        manager.write('s1', ' LATER');
      });
      assert.equal(seen.includes('OLD SAMETICK'), true);
      assert.equal(seen.includes('LATER'), false);
    } finally { manager.destroy('s1'); }
  });

  it('runs immediately for a session without an emulator', () => {
    const manager = new TerminalManager();
    let ran = false;
    manager.whenParsed('missing', () => { ran = true; });
    assert.equal(ran, true);
    assert.equal(manager.has('missing'), false);
  });

  it('settles exactly once when the emulator is destroyed while waiting', async () => {
    const manager = new TerminalManager();
    manager.write('s1', 'pending');
    let runs = 0;
    manager.whenParsed('s1', () => { runs++; });
    manager.destroy('s1');
    assert.equal(runs, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runs, 1);
  });
});

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
