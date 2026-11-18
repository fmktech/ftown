import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalManager } from './terminal-manager.js';
import xtermHeadless from '@xterm/headless';

// Same full-height alternate-screen redraw as the captured restart failure,
// with fixture prompt text replacing the scratch shell's user/machine names.
function tmuxRedraw(rows: number): string {
  return `\x1b[?1049h\x1b[H\x1b[2J\x1b[1;${rows}r\x1b[H`
    + ['fixture ~ % echo PREMARK', 'PREMARK', 'fixture ~ % ', ...Array<string>(rows - 3).fill('')].map(line => `${line}\x1b[K`).join('\n')
    + '\x1b[3;13H';
}

describe('TerminalManager pre-attachment dimensions', () => {
  it('retains resize before first PTY bytes without eagerly allocating an emulator', async () => {
    const manager = new TerminalManager();
    manager.resize('restored', 126, 35);
    assert.equal(manager.has('restored'), false);
    assert.equal(manager.getSize('restored'), undefined);
    manager.write('restored', tmuxRedraw(35));
    try {
      await new Promise<void>(resolve => manager.whenParsed('restored', resolve));
      assert.deepEqual(manager.getSize('restored'), { cols: 126, rows: 35 });
      assert.ok(manager.getScreen('restored').lines.some(line => line.includes('PREMARK')));
    } finally { manager.destroy('restored'); }
  });

  it('proves the captured redraw loses its prompt only when a 40-row stream reaches a smaller alternate buffer', async () => {
    for (const [viewportRows, redrawRows, containsPrompt] of [[35, 40, false], [40, 40, true], [35, 35, true]] as const) {
      const terminal = new xtermHeadless.Terminal({ cols: 126, rows: viewportRows, allowProposedApi: true });
      try {
        await new Promise<void>(resolve => terminal.write(tmuxRedraw(redrawRows), resolve));
        const lines = Array.from({ length: terminal.buffer.active.length }, (_, n) => terminal.buffer.active.getLine(n)?.translateToString(true) ?? '');
        assert.equal(lines.some(line => line.includes('PREMARK')), containsPrompt, `${redrawRows}-row redraw into ${viewportRows}-row viewport`);
      } finally { terminal.dispose(); }
    }
  });

  it('keeps the latest valid pending size, ignores invalid input and clears intent on destroy', () => {
    const manager = new TerminalManager();
    manager.resize('s1', 90, 30); manager.resize('s1', 126, 35);
    for (const [cols, rows] of [[0, 35], [126, -1], [NaN, 35], [126, Infinity], [80.5, 35], [126, 2.5]]) manager.resize('s1', cols, rows);
    manager.write('s1', '');
    try {
      assert.deepEqual(manager.getSize('s1'), { cols: 126, rows: 35 });
      manager.resize('s1', 0, 0); assert.deepEqual(manager.getSize('s1'), { cols: 126, rows: 35 });
      manager.resize('pending', 126, 35); manager.destroy('pending'); manager.write('pending', '');
      assert.deepEqual(manager.getSize('pending'), { cols: 120, rows: 40 });
      manager.resize('../invalid', 126, 35); manager.write('../invalid', '');
      assert.deepEqual(manager.getSize('../invalid'), { cols: 120, rows: 40 });
    } finally { manager.destroy('s1'); manager.destroy('pending'); manager.destroy('../invalid'); }
  });
});

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
