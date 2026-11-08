import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, renameSync, statSync, utimesSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';
import { BridgeSecurityError } from './errors.js';
import { AtomicSnapshot } from './snapshot.js';

interface State { n: number; items: string[] }

describe('AtomicSnapshot identity cache', () => {
  let dir: string;
  let file: string;
  let parses: number;

  const schema = z.object({ n: z.number().min(0), items: z.array(z.string()) }).transform((v): State => { parses++; return v; });
  const make = () => new AtomicSnapshot<State>(file, schema, () => ({ n: 0, items: [] }));
  const sync = (value: State) => writeFileSync(file, JSON.stringify(value));
  // Longer than the 50 ms racy-timestamp window, so a following read may be cached.
  const settle = () => sleep(120);
  const PINNED = new Date('2020-01-01T00:00:00.000Z');
  const pin = (path: string) => utimesSync(path, PINNED, PINNED);

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'snapshot-test-')); file = join(dir, 'state.json'); parses = 0; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('parses an unchanged file once across two reads', async () => {
    sync({ n: 1, items: ['a'] });
    await settle();
    const snap = make();
    assert.equal(await snap.read((s) => s.n), 1);
    assert.equal(await snap.read((s) => s.n), 1);
    assert.equal(parses, 1);
  });

  it('sees a replacement written by another instance', async () => {
    const a = make();
    const b = make();
    await a.transact((s) => { s.n = 1; });
    await settle();
    assert.equal(await a.read((s) => s.n), 1);
    const warmParses = parses;
    assert.equal(await a.read((s) => s.n), 1);
    assert.equal(parses, warmParses);
    await b.transact((s) => { s.n = 2; });
    assert.equal(await a.read((s) => s.n), 2);
  });

  it('sees an external in-place rewrite of the same size with a distinct mtime', async () => {
    sync({ n: 1, items: [] });
    const snap = make();
    await settle();
    assert.equal(await snap.read((s) => s.n), 1);
    const warmParses = parses;
    assert.equal(await snap.read((s) => s.n), 1);
    assert.equal(parses, warmParses);
    const before = statSync(file);
    sync({ n: 2, items: [] });
    assert.equal(statSync(file).size, before.size);
    const later = new Date(before.mtimeMs + 5000);
    utimesSync(file, later, later);
    assert.equal(await snap.read((s) => s.n), 2);
  });

  it('sees an external write via rename', async () => {
    sync({ n: 1, items: [] });
    const snap = make();
    await settle();
    assert.equal(await snap.read((s) => s.n), 1);
    const warmParses = parses;
    assert.equal(await snap.read((s) => s.n), 1);
    assert.equal(parses, warmParses);
    const temporary = join(dir, 'other.tmp');
    writeFileSync(temporary, JSON.stringify({ n: 7, items: ['x'] }));
    renameSync(temporary, file);
    assert.deepEqual(await snap.read((s) => s), { n: 7, items: ['x'] });
  });

  it('does not publish state when save fails', async () => {
    sync({ n: 3, items: [] });
    const snap = make();
    await settle();
    assert.equal(await snap.read((s) => s.n), 3);
    const warmParses = parses;
    assert.equal(await snap.read((s) => s.n), 3);
    assert.equal(parses, warmParses);
    await assert.rejects(
      snap.transact((s) => { s.n = -1; }),
      (e: unknown) => e instanceof BridgeSecurityError && e.code === 'storage_unavailable',
    );
    assert.equal(await snap.read((s) => s.n), 3);
  });

  it('does not leak mutations into later reads', async () => {
    sync({ n: 1, items: ['a'] });
    const snap = make();
    await settle();
    await snap.read((s) => { s.items.push('leak'); s.n = 99; return null; });
    assert.deepEqual(await snap.read((s) => s), { n: 1, items: ['a'] });
    await snap.read((s) => { s.items.push('leak2'); s.n = 98; return null; });
    assert.deepEqual(await snap.read((s) => s), { n: 1, items: ['a'] });
    const returned = await snap.read((s) => s);
    returned.items.push('leak');
    returned.n = 99;
    assert.deepEqual(await snap.read((s) => s), { n: 1, items: ['a'] });

    await assert.rejects(snap.transact((s) => { s.items.push('leak'); s.n = 50; throw new Error('abort'); }), /abort/);
    assert.deepEqual(await snap.read((s) => s), { n: 1, items: ['a'] });

    await snap.read((s) => { s.items.push('leak'); s.n = 77; return null; });
    assert.deepEqual(await snap.read((s) => s), { n: 1, items: ['a'] });
  });

  it('returns initial() for a missing file and sees a file created externally', async () => {
    const snap = make();
    assert.deepEqual(await snap.read((s) => s), { n: 0, items: [] });
    sync({ n: 5, items: ['z'] });
    assert.deepEqual(await snap.read((s) => s), { n: 5, items: ['z'] });
  });

  it('orders a read after an un-awaited transact', async () => {
    const snap = make();
    const pending = snap.transact((s) => { s.n = 4; });
    const value = await snap.read((s) => s.n);
    await pending;
    assert.equal(value, 4);
  });

  it('re-parses once after a successful transact, then serves from cache', async () => {
    const snap = make();
    await snap.transact((s) => { s.n = 1; });
    await settle();
    const afterTransact = parses;
    assert.equal(await snap.read((s) => s.n), 1);
    assert.equal(parses, afterTransact + 1);
    assert.equal(await snap.read((s) => s.n), 1);
    assert.equal(parses, afterTransact + 1);
  });

  it('does not leak a mutation made by a throwing first transact on a fresh instance', async () => {
    sync({ n: 1, items: ['a'] });
    await settle();
    const snap = make();
    await assert.rejects(snap.transact((s) => { s.n = 9; s.items.push('leak'); throw new Error('abort'); }), /abort/);
    assert.deepEqual(await snap.read((s) => s), { n: 1, items: ['a'] });
  });

  it('sees an in-place same-size rewrite whose mtime is restored (ctime differs)', async () => {
    sync({ n: 1, items: [] });
    pin(file);
    await settle();
    const snap = make();
    assert.equal(await snap.read((s) => s.n), 1);
    sync({ n: 2, items: [] });
    pin(file);
    assert.equal(await snap.read((s) => s.n), 2);
  });

  it('sees a same-size rename replacement whose mtime equals the cached one', async () => {
    sync({ n: 1, items: [] });
    pin(file);
    await settle();
    const snap = make();
    assert.equal(await snap.read((s) => s.n), 1);
    const temporary = join(dir, 'other.tmp');
    writeFileSync(temporary, JSON.stringify({ n: 2, items: [] }));
    pin(temporary);
    renameSync(temporary, file);
    assert.equal(await snap.read((s) => s.n), 2);
  });

  it('serves a warm cache hit without waiting a macrotask', async () => {
    sync({ n: 1, items: [] });
    await settle();
    const snap = make();
    await snap.read((s) => s.n);
    assert.equal(await snap.read((s) => s.n), 1);
    assert.equal(parses, 1);
    const order: string[] = [];
    setImmediate(() => order.push('immediate'));
    await snap.read((s) => s.n);
    order.push('hit');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ['hit', 'immediate']);
  });

  it('maps ENOTDIR on a path under a regular file to storage_unavailable', async () => {
    writeFileSync(join(dir, 'notadir'), 'x');
    const snap = new AtomicSnapshot<State>(join(dir, 'notadir', 'state.json'), schema, () => ({ n: 0, items: [] }));
    await assert.rejects(
      snap.read((s) => s),
      (e: unknown) => e instanceof BridgeSecurityError && e.code === 'storage_unavailable',
    );
  });

  it('does not cache reads taken right after a write (racy window)', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      sync({ n: 1, items: [] });
      const wrote = Date.now();
      parses = 0;
      const snap = make();
      await snap.read((s) => s.n);
      await snap.read((s) => s.n);
      if (Date.now() - wrote >= 40) continue;
      assert.equal(parses, 2);
      sync({ n: 2, items: [] });
      assert.equal(await snap.read((s) => s.n), 2);
      return;
    }
    assert.fail('could not complete two reads within 40 ms of a write');
  });

  it('maps a corrupt file to storage_unavailable', async () => {
    writeFileSync(file, 'not json {');
    const snap = make();
    await assert.rejects(
      snap.read((s) => s),
      (e: unknown) => e instanceof BridgeSecurityError && e.code === 'storage_unavailable',
    );
  });
});
