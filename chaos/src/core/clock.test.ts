import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeClock, readT0, realClock, writeT0 } from './clock.ts';

test('realClock with an explicit t0 uses the shared epoch', () => {
  const t0 = process.hrtime.bigint() - 5_000_000_000n;
  const c = realClock({ t0Ns: t0 });
  const n = c.now();
  assert.ok(Number.isInteger(n));
  assert.ok(n >= 5000 && n < 5000 + 1000, `now=${n}`);
});

test('realClock default epoch starts near 0 and is monotonic', async () => {
  const c = realClock();
  const a = c.now();
  assert.ok(a >= 0 && a < 500);
  await c.sleep(15);
  assert.ok(c.now() >= a + 10);
});

test('two clocks sharing t0 agree', () => {
  const t0 = process.hrtime.bigint();
  const a = realClock({ t0Ns: t0 });
  const b = realClock({ t0Ns: t0 });
  assert.ok(Math.abs(a.now() - b.now()) <= 1);
});

test('writeT0 / readT0 round trip as a decimal string', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-t0-'));
  try {
    const p = join(dir, 'sub', 't0');
    const w = writeT0(p);
    assert.equal(readFileSync(p, 'utf8'), w.toString(10));
    assert.equal(readT0(p), w);
    writeT0(p, 123456789012345678901n);
    assert.equal(readT0(p), 123456789012345678901n);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readT0 fails loudly when missing or malformed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-t0-'));
  try {
    assert.throws(() => readT0(join(dir, 'missing')));
    const p = join(dir, 'bad');
    writeFileSync(p, 'abc');
    assert.throws(() => readT0(p), /decimal/);
    writeFileSync(p, '');
    assert.throws(() => readT0(p), /decimal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fakeClock wakes sleepers in deadline order, ties in call order', async () => {
  const c = fakeClock();
  const order: string[] = [];
  const mk = (name: string, ms: number) => c.sleep(ms).then(() => order.push(`${name}@${c.now()}`));
  const all = Promise.all([mk('a', 50), mk('b', 10), mk('c', 50), mk('d', 30)]);
  await c.advance(9);
  assert.deepEqual(order, []);
  await c.advance(100);
  await all;
  assert.deepEqual(order, ['b@10', 'd@30', 'a@50', 'c@50']);
  assert.equal(c.now(), 109);
});

test('fakeClock: sleeps scheduled by woken sleepers inside the window fire in the same advance', async () => {
  const c = fakeClock();
  const hits: number[] = [];
  const loop = (async () => {
    for (let i = 0; i < 3; i++) {
      await c.sleep(10);
      hits.push(c.now());
    }
  })();
  await c.advance(25);
  assert.deepEqual(hits, [10, 20]);
  await c.advance(5);
  await loop;
  assert.deepEqual(hits, [10, 20, 30]);
});

test('fakeClock: sleep(0) resolves immediately; negative advance throws', async () => {
  const c = fakeClock();
  await c.sleep(0);
  await assert.rejects(c.advance(-1));
});
