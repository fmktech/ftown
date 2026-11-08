import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import fsp from 'node:fs/promises';
import nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ANCHOR_BYTES, JsonlFoldCache, type JsonlFold } from './jsonl-fold-cache.js';

interface CountState {
  n: number;
  values: unknown[];
}

function countFold(hooks: { onStep?: (value: unknown) => void } = {}): JsonlFold<CountState> {
  return {
    kind: 'count',
    init: () => ({ n: 0, values: [] }),
    step(state, value) {
      hooks.onStep?.(value);
      state.n += 1;
      state.values.push(structuredClone(value));
    },
  };
}

const snapshot = (state: Readonly<CountState>): CountState => ({ n: state.n, values: [...state.values] });

let root: string;
let seq = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jsonl-fold-cache-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const newPath = (name = 'f'): string => join(root, `${name}-${seq++}.jsonl`);
const line = (id: number | string, extra = ''): string => `${JSON.stringify({ id, extra })}\n`;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function foldCount(cache: JsonlFoldCache, path: string, timeoutMs = 10_000): Promise<CountState | null> {
  return cache.fold(path, countFold(), timeoutMs, snapshot);
}

describe('JsonlFoldCache', () => {
  it('incremental result equals a fresh-cache result across random appends, including mid-multibyte splits', async () => {
    const rand = mulberry32(42);
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) {
      const pad = 'é日本😀'.repeat(Math.floor(rand() * 6));
      lines.push(line(i, `${pad}-${'x'.repeat(Math.floor(rand() * 30))}`));
    }
    const all = Buffer.from(lines.join(''), 'utf8');
    const emojiMid = all.indexOf(Buffer.from('😀', 'utf8')) + 2;
    const cutSet = new Set<number>([emojiMid]);
    while (cutSet.size < 4) cutSet.add(1 + Math.floor(rand() * (all.length - 2)));
    const cuts = [...cutSet].sort((a, b) => a - b);
    cuts.push(all.length);

    const path = newPath();
    await writeFile(path, '');
    const cache = new JsonlFoldCache({ chunkBytes: 7 });
    let prev = 0;
    for (const cut of cuts) {
      await appendFile(path, all.subarray(prev, cut));
      prev = cut;
      const incremental = await foldCount(cache, path);
      const fresh = await foldCount(new JsonlFoldCache({ chunkBytes: 7 }), path);
      assert.deepEqual(incremental, fresh);
    }
    const final = await foldCount(cache, path);
    assert.equal(final?.n, 40);
    assert.deepEqual(final?.values.map((v) => (v as { id: number }).id), [...Array(40).keys()]);
  });

  it('reads only appended bytes on later calls', async () => {
    const path = newPath();
    await writeFile(path, Array.from({ length: 50 }, (_, i) => line(i, 'p'.repeat(40))).join(''));
    const cache = new JsonlFoldCache({ chunkBytes: 128 });
    await foldCount(cache, path);

    const before1 = cache.stats().bytesRead;
    const idle = await foldCount(cache, path);
    assert.equal(idle?.n, 50);
    assert.ok(cache.stats().bytesRead - before1 <= ANCHOR_BYTES, 'no-change call reads at most the anchor');

    const appended = Array.from({ length: 5 }, (_, i) => line(100 + i, 'q'.repeat(40))).join('');
    await appendFile(path, appended);
    const before2 = cache.stats().bytesRead;
    const after2 = await foldCount(cache, path);
    assert.equal(after2?.n, 55);
    assert.ok(cache.stats().bytesRead - before2 <= Buffer.byteLength(appended) + ANCHOR_BYTES);
  });

  describe('unterminated tail', () => {
    it('counts a valid unterminated line once and does not double count after its newline arrives', async () => {
      const path = newPath();
      await writeFile(path, '{"id":1}\n{"id":2}');
      const cache = new JsonlFoldCache({ chunkBytes: 5 });
      assert.equal((await foldCount(cache, path))?.n, 2);
      assert.equal((await foldCount(cache, path))?.n, 2);
      await appendFile(path, '\n{"id":3}\n');
      const result = await foldCount(cache, path);
      assert.deepEqual(result, { n: 3, values: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    });

    it('counts an invalid half line as 0 until completed, then exactly once', async () => {
      const path = newPath();
      await writeFile(path, '{"id":1}\n{"id":');
      const cache = new JsonlFoldCache({ chunkBytes: 5 });
      assert.equal((await foldCount(cache, path))?.n, 1);
      assert.equal((await foldCount(cache, path))?.n, 1);
      await appendFile(path, '2}\n');
      const result = await foldCount(cache, path);
      assert.deepEqual(result, { n: 2, values: [{ id: 1 }, { id: 2 }] });
      assert.deepEqual(await foldCount(cache, path), result);
    });
  });

  it('refolds from scratch when the file is truncated', async () => {
    const path = newPath();
    await writeFile(path, Array.from({ length: 20 }, (_, i) => line(i, 'old')).join(''));
    const cache = new JsonlFoldCache({ chunkBytes: 16 });
    assert.equal((await foldCount(cache, path))?.n, 20);
    await writeFile(path, line('a') + line('b'));
    const result = await foldCount(cache, path);
    assert.deepEqual(result, await foldCount(new JsonlFoldCache(), path));
    assert.equal(result?.n, 2);
  });

  it('refolds when the file is replaced via rename (new inode) even if size and tail bytes match', async () => {
    const tail = line('tail', 'z'.repeat(120));
    const path = newPath();
    await writeFile(path, line('a1') + line('a2') + tail);
    const cache = new JsonlFoldCache({ chunkBytes: 16 });
    assert.equal((await foldCount(cache, path))?.n, 3);

    const replacement = newPath('replacement');
    await writeFile(replacement, line('b1') + line('b2') + tail);
    await rename(replacement, path);

    const result = await foldCount(cache, path);
    assert.deepEqual(result, await foldCount(new JsonlFoldCache(), path));
    assert.deepEqual(
      result?.values.map((v) => (v as { id: string }).id),
      ['b1', 'b2', 'tail'],
    );
  });

  for (const grow of [false, true]) {
    it(`refolds on an in-place rewrite changing bytes before the offset (${grow ? 'larger' : 'same'} size)`, async () => {
      const path = newPath();
      const original = Array.from({ length: 10 }, (_, i) => line(`o${i}`, 'k'.repeat(30))).join('');
      await writeFile(path, original);
      const cache = new JsonlFoldCache({ chunkBytes: 16 });
      assert.equal((await foldCount(cache, path))?.n, 10);

      let rewritten = Array.from({ length: 10 }, (_, i) => line(`n${i}`, 'k'.repeat(30))).join('');
      assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(original));
      if (grow) rewritten += line('extra', 'k'.repeat(30));
      await writeFile(path, rewritten);

      const result = await foldCount(cache, path);
      assert.deepEqual(result, await foldCount(new JsonlFoldCache(), path));
      assert.equal(result?.n, grow ? 11 : 10);
      assert.ok(result?.values.every((v) => !String((v as { id: string }).id).startsWith('o')));
    });
  }

  it('skips CRLF terminators, blank lines and garbage, and parses a line longer than chunkBytes x 10', async () => {
    const chunkBytes = 8;
    const longValue = 'L'.repeat(chunkBytes * 10 + 37);
    const path = newPath();
    await writeFile(
      path,
      [
        '{"id":1}\r\n',
        '\r\n',
        '\n',
        'not json at all\n',
        '{"id":\n',
        `{"id":2,"long":"${longValue}"}\r\n`,
        '   \n',
        '{"id":3}\n',
      ].join(''),
    );
    const result = await foldCount(new JsonlFoldCache({ chunkBytes }), path);
    assert.deepEqual(result, {
      n: 3,
      values: [{ id: 1 }, { id: 2, long: longValue }, { id: 3 }],
    });
  });

  it('serializes concurrent calls on the same key without double counting', async () => {
    const path = newPath();
    await writeFile(path, '');
    const cache = new JsonlFoldCache({ chunkBytes: 32 });
    const calls: Promise<CountState | null>[] = [];
    let lines = 0;
    for (let i = 0; i < 10; i++) {
      calls.push(foldCount(cache, path));
      await appendFile(path, line(lines++) + line(lines++));
    }
    const results = await Promise.all(calls);
    let last = -1;
    for (const r of results) {
      assert.ok(r, 'every call resolves with a result');
      assert.ok(r.n >= last, 'FIFO order: counts never go backwards');
      assert.ok(r.n <= lines);
      assert.equal(new Set(r.values.map((v) => (v as { id: number }).id)).size, r.n, 'no duplicates');
      last = r.n;
    }
    const final = await foldCount(cache, path);
    assert.equal(final?.n, 20);
    assert.deepEqual(final?.values.map((v) => (v as { id: number }).id), [...Array(20).keys()]);
  });

  it('bounds simultaneously open handles by concurrency while still reading in parallel', async () => {
    const realOpen = fsp.open;
    let openNow = 0;
    let openPeak = 0;
    fsp.open = (async (...args: Parameters<typeof realOpen>) => {
      const fh = await realOpen(...args);
      openNow += 1;
      openPeak = Math.max(openPeak, openNow);
      const realClose = fh.close.bind(fh);
      let closed = false;
      fh.close = async () => {
        if (!closed) {
          closed = true;
          openNow -= 1;
        }
        return realClose();
      };
      return fh;
    }) as typeof realOpen;
    nodeModule.syncBuiltinESMExports();
    try {
      const cache = new JsonlFoldCache({ concurrency: 2, chunkBytes: 16 });
      const paths: string[] = [];
      for (let f = 0; f < 8; f++) {
        const path = newPath('lim');
        await writeFile(path, Array.from({ length: 60 }, (_, i) => line(i, 'w'.repeat(20))).join(''));
        paths.push(path);
      }
      openNow = 0;
      openPeak = 0;
      const results = await Promise.all(paths.map((p) => foldCount(cache, p)));
      assert.ok(results.every((r) => r?.n === 60));
      assert.ok(openPeak <= 2, `real open handles peaked at ${openPeak}`);
      assert.ok(openPeak > 1, 'reads on different keys run in parallel');
      assert.ok(cache.stats().peakActiveReads <= 2);
    } finally {
      fsp.open = realOpen;
      nodeModule.syncBuiltinESMExports();
    }
  });

  it('returns a partial result past the deadline and converges on later calls', async () => {
    const total = 50_000;
    const path = newPath();
    await writeFile(path, Array.from({ length: total }, (_, i) => line(i, 'd'.repeat(10))).join(''));
    const cache = new JsonlFoldCache();
    const partial = await foldCount(cache, path, 0);
    assert.ok(partial, 'a deadline hit still returns a result');
    assert.ok(partial.n < total, `expected a partial fold, got ${partial.n}`);
    const ids = partial.values.map((v) => (v as { id: number }).id);
    assert.deepEqual(ids, [...Array(partial.n).keys()], 'partial result is a clean prefix');

    const full = await foldCount(cache, path, 60_000);
    assert.equal(full?.n, total);
    assert.deepEqual(full, await foldCount(new JsonlFoldCache(), path, 60_000));
  });

  describe('deadline stop mid-chunk (fake clock)', () => {
    async function foldTicks(cache: JsonlFoldCache, path: string, timeoutMs: number): Promise<CountState | null> {
      const realNow = Date.now;
      let t = 1_000_000;
      Date.now = () => (t += 1);
      try {
        return await cache.fold(path, countFold(), timeoutMs, snapshot);
      } finally {
        Date.now = realNow;
      }
    }

    it('neither loses nor double counts lines when the next call has a full budget', async () => {
      const total = 20_000;
      const path = newPath();
      await writeFile(path, '{"a":1}\n'.repeat(total));
      const cache = new JsonlFoldCache({ chunkBytes: 4096 });
      const partial = await foldTicks(cache, path, 100);
      assert.ok(partial && partial.n > 0 && partial.n % 512 !== 0, `stop must land mid-chunk, got ${partial?.n}`);
      assert.equal((await foldCount(cache, path))?.n, total);
    });

    it('converges under repeated small budgets', async () => {
      const total = 5_000;
      const path = newPath();
      await writeFile(path, Array.from({ length: total }, (_, i) => `{"id":${i}}\n`).join(''));
      const cache = new JsonlFoldCache({ chunkBytes: 4096 });
      let r: CountState | null = null;
      for (let i = 0; i < 400 && (r?.n ?? 0) < total; i++) r = await foldTicks(cache, path, 50);
      assert.equal(r?.n, total);
    });
  });

  it('returns null for a missing file and drops its entry; a directory also gives null', async () => {
    const cache = new JsonlFoldCache();
    assert.equal(await foldCount(cache, join(root, 'does-not-exist.jsonl')), null);

    const path = newPath();
    await writeFile(path, line(1));
    assert.equal((await foldCount(cache, path))?.n, 1);
    assert.equal(cache.stats().entries, 1);
    await unlink(path);
    assert.equal(await foldCount(cache, path), null);
    assert.equal(cache.stats().entries, 0);

    const dir = join(root, `dir-${seq++}`);
    await mkdir(dir);
    assert.equal(await foldCount(cache, dir), null);
    assert.equal(cache.stats().entries, 0);
  });

  it('evicts least recently used entries beyond maxEntries', async () => {
    const cache = new JsonlFoldCache({ maxEntries: 3 });
    const paths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const path = newPath('lru');
      await writeFile(path, Array.from({ length: 30 }, (_, j) => line(j, 'e'.repeat(30))).join(''));
      paths.push(path);
    }
    for (const p of paths.slice(0, 3)) await foldCount(cache, p);
    await foldCount(cache, paths[0]); // refresh recency of the oldest
    for (const p of paths.slice(3)) await foldCount(cache, p);
    assert.equal(cache.stats().entries, 3);

    const size = Buffer.byteLength(Array.from({ length: 30 }, (_, j) => line(j, 'e'.repeat(30))).join(''));
    const b0 = cache.stats().bytesRead;
    await foldCount(cache, paths[0]);
    assert.ok(cache.stats().bytesRead - b0 <= ANCHOR_BYTES, 'recently used entry survived eviction');
    const b1 = cache.stats().bytesRead;
    await foldCount(cache, paths[1]);
    assert.ok(cache.stats().bytesRead - b1 >= size, 'least recently used entry was evicted and refolded');
  });

  it('returns null when step throws on a cached entry, drops it, and refolds from scratch', async () => {
    const path = newPath();
    await writeFile(path, Array.from({ length: 5 }, (_, i) => line(i)).join(''));
    const cache = new JsonlFoldCache({ chunkBytes: 16 });
    let armed = false;
    const fold = countFold({
      onStep(value) {
        if (armed && (value as { id: number }).id === 7) throw new Error('boom');
      },
    });
    assert.equal((await cache.fold(path, fold, 10_000, snapshot))?.n, 5);
    assert.equal(cache.stats().entries, 1);

    armed = true;
    await appendFile(path, Array.from({ length: 4 }, (_, i) => line(5 + i)).join(''));
    assert.equal(await cache.fold(path, fold, 10_000, snapshot), null);
    assert.equal(cache.stats().entries, 0);

    armed = false;
    await appendFile(path, line(9));
    const result = await cache.fold(path, fold, 10_000, snapshot);
    assert.equal(result?.n, 10);
    assert.deepEqual(result?.values.map((v) => (v as { id: number }).id), [...Array(10).keys()]);
  });

  it('does not step a scalar unterminated segment that may still be growing, but counts an object once', async () => {
    const path = newPath();
    await writeFile(path, '12');
    const cache = new JsonlFoldCache({ chunkBytes: 1 });
    assert.equal((await foldCount(cache, path))?.n, 0);
    await appendFile(path, '3\n');
    const result = await foldCount(cache, path);
    const fresh = await foldCount(new JsonlFoldCache(), path);
    assert.deepEqual(result, fresh);
    assert.deepEqual(result, { n: 1, values: [123] });

    const objPath = newPath();
    await writeFile(objPath, '{"a":1}');
    assert.equal((await foldCount(cache, objPath))?.n, 1);
    assert.equal((await foldCount(cache, objPath))?.n, 1);
    await appendFile(objPath, '\n');
    assert.equal((await foldCount(cache, objPath))?.n, 1);
    const arrPath = newPath();
    await writeFile(arrPath, '[1]');
    assert.equal((await foldCount(cache, arrPath))?.n, 1);
  });

  it('rejects when finish throws, keeps the entry, and continues without double counting', async () => {
    const path = newPath();
    await writeFile(path, line(1) + line(2));
    const cache = new JsonlFoldCache({ chunkBytes: 16 });
    const fold = countFold();
    await assert.rejects(
      cache.fold(path, fold, 10_000, () => {
        throw new Error('finish failed');
      }),
      /finish failed/,
    );
    assert.equal(cache.stats().entries, 1);

    await appendFile(path, line(3));
    const before = cache.stats().bytesRead;
    const result = await cache.fold(path, fold, 10_000, snapshot);
    assert.deepEqual(result, { n: 3, values: [{ id: 1, extra: '' }, { id: 2, extra: '' }, { id: 3, extra: '' }] });
    assert.ok(cache.stats().bytesRead - before <= Buffer.byteLength(line(3)) + ANCHOR_BYTES, 'entry was kept, not refolded');
  });
});
