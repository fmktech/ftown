import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { epochClock, idsFromFile } from './cli.ts';

const dir = mkdtempSync(join(tmpdir(), 'chaos-cli-'));

test('epochClock: now() is ms since the epoch in the file', () => {
  const f = join(dir, 't0');
  writeFileSync(f, `${process.hrtime.bigint() - 5_000_000_000n}\n`);
  const t = epochClock(f).now();
  assert.ok(t >= 5000 && t < 5000 + 2000, String(t));
});

test('epochClock: missing or malformed file fails loudly', () => {
  assert.throws(() => epochClock(join(dir, 'nope')));
  const f = join(dir, 'bad');
  writeFileSync(f, 'abc');
  assert.throws(() => epochClock(f), /decimal/);
});

test('idsFromFile: role lookup, unknown and unreadable give null', () => {
  const f = join(dir, 'ids.json');
  writeFileSync(f, JSON.stringify({ child1: 'sid-1' }));
  assert.equal(idsFromFile(f)('child1'), 'sid-1');
  assert.equal(idsFromFile(f)('child2'), null);
  assert.equal(idsFromFile(join(dir, 'missing'))('child1'), null);
});
