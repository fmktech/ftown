import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore } from './session-store.js';

const CAP = 100;
const MARKER = `[ftown] terminal.log truncated — retaining last ${CAP} bytes\r\n`;

interface Fixture {
  dir: string;
  store: SessionStore;
  mkdirs: string[];
  stats: string[];
  logPath(id: string): string;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'ftown-store-log-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const mkdirs: string[] = [];
  const stats: string[] = [];
  const mkdir = fs.mkdir;
  const stat = fs.stat;
  t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
    mkdirs.push(String(args[0]));
    return mkdir(...args);
  });
  t.mock.method(fs, 'stat', async (...args: Parameters<typeof fs.stat>) => {
    stats.push(String(args[0]));
    return stat(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return {
    dir,
    store: new SessionStore(dir, { maxTerminalLogBytes: CAP }),
    mkdirs,
    stats,
    logPath: (id) => join(dir, 'sessions', id, 'terminal.log'),
  };
}

test('appends create the session directory once and stat the log once', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i++) await f.store.appendTerminalData('s1', `line ${i}\n`);
  await f.store.appendTerminalData('s2', 'other\n');

  assert.deepStrictEqual(f.mkdirs, [join(f.dir, 'sessions', 's1'), join(f.dir, 'sessions', 's2')]);
  assert.deepStrictEqual(f.stats, [f.logPath('s1'), f.logPath('s2')]);
  assert.equal(await f.store.loadTerminalLog('s1'), 'line 0\nline 1\nline 2\nline 3\nline 4\nline 5\n');
  assert.equal(await f.store.loadTerminalLog('s2'), 'other\n');
});

test('a session directory that vanished is recreated and the append is not lost', async (t) => {
  const f = await fixture(t);
  await f.store.appendTerminalData('s1', 'before\n');
  await fs.rm(join(f.dir, 'sessions', 's1'), { recursive: true });
  await f.store.appendTerminalData('s1', 'after\n');
  await f.store.appendTerminalData('s1', 'more\n');

  assert.equal(await fs.readFile(f.logPath('s1'), 'utf-8'), 'after\nmore\n');
  assert.equal(f.mkdirs.length, 2, 'recreated exactly once after the ENOENT');
  // The size is measured again after the error, then tracked in memory again.
  assert.equal(f.stats.length, 2);
});

test('the log is kept whole at exactly twice the cap and trimmed one byte later', async (t) => {
  const f = await fixture(t);
  const line = `${'x'.repeat(19)}\n`; // 20 bytes
  for (let i = 0; i < 9; i++) await f.store.appendTerminalData('s1', line);
  await f.store.appendTerminalData('s1', `${'y'.repeat(19)}\n`);
  const atBoundary = await fs.readFile(f.logPath('s1'), 'utf-8');
  assert.equal(Buffer.byteLength(atBoundary), CAP * 2);
  assert.equal(atBoundary, line.repeat(9) + `${'y'.repeat(19)}\n`);
  assert.equal(f.stats.length, 1, 'size tracked in memory up to the boundary');

  await f.store.appendTerminalData('s1', 'z');
  const trimmed = await fs.readFile(f.logPath('s1'), 'utf-8');
  // Last CAP bytes of the 201-byte file, minus the partial first line.
  const tail = (atBoundary + 'z').slice(-CAP);
  assert.equal(trimmed, MARKER + tail.slice(tail.indexOf('\n') + 1));
  assert.equal(f.stats.length, 2, 'the trim itself measures the real file');
});

test('multi-byte output is measured in bytes, not characters', async (t) => {
  const f = await fixture(t);
  // 67 characters but 201 bytes: over the 200-byte threshold.
  await f.store.appendTerminalData('s1', 'a\n');
  await f.store.appendTerminalData('s1', '€'.repeat(66) + 'b');
  const content = await fs.readFile(f.logPath('s1'), 'utf-8');
  assert.ok(content.startsWith(MARKER), 'trimmed once the byte size passed twice the cap');
});

test('size tracking stays exact across repeated trims', async (t) => {
  const f = await fixture(t);
  const line = `${'x'.repeat(9)}\n`; // 10 bytes
  let trims = 0;
  let previous = 0;
  for (let i = 0; i < 80; i++) {
    await f.store.appendTerminalData('s1', line);
    const { size } = await fs.lstat(f.logPath('s1'));
    assert.ok(size <= CAP * 2, `log grew to ${size} bytes`);
    // Trimmed exactly when the append took the file past twice the cap.
    if (previous + line.length > CAP * 2) {
      trims++;
      assert.ok(size < previous, `expected a trim at ${previous} + ${line.length} bytes`);
    } else {
      assert.equal(size, previous + line.length);
    }
    previous = size;
  }
  assert.ok(trims >= 3);
});

test('clearing the log resets the tracked size', async (t) => {
  const f = await fixture(t);
  await f.store.appendTerminalData('s1', `${'x'.repeat(189)}\n`);
  await f.store.clearTerminalLog('s1');
  await f.store.appendTerminalData('s1', `${'y'.repeat(19)}\n`);
  assert.equal(await fs.readFile(f.logPath('s1'), 'utf-8'), `${'y'.repeat(19)}\n`);
});

test('reading the log first flushes pending output and waits for it to land', async (t) => {
  const f = await fixture(t);
  await f.store.appendTerminalData('s1', 'on disk\n');
  let pending = 'still buffered\n';
  const flushed: string[] = [];
  f.store.setPendingTerminalFlush((sessionId) => {
    flushed.push(sessionId);
    if (!pending) return;
    const data = pending;
    pending = '';
    void f.store.appendTerminalData(sessionId, data);
  });

  assert.equal(await f.store.loadTerminalLog('s1'), 'on disk\nstill buffered\n');
  assert.deepStrictEqual(flushed, ['s1']);
});

test('clearing the log flushes pending output first so it cannot reappear', async (t) => {
  const f = await fixture(t);
  await f.store.appendTerminalData('s1', 'on disk\n');
  let pending = 'still buffered\n';
  f.store.setPendingTerminalFlush((sessionId) => {
    if (!pending) return;
    const data = pending;
    pending = '';
    void f.store.appendTerminalData(sessionId, data);
  });

  await f.store.clearTerminalLog('s1');
  assert.equal(await f.store.loadTerminalLog('s1'), '');
});
