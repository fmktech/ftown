import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encodeExit, encodeFile } from '../guest/emit.ts';
import { FrameError, parseFrames } from './frames.ts';

test('round trip of several files and exit code', () => {
  const big = randomBytes(10_000);
  const text = encodeFile('canon.jsonl', '{"k":"run"}\n') + encodeFile('side-x.bin', big) + encodeFile('empty', '') + encodeExit(1);
  const p = parseFrames(text);
  assert.equal(p.exitCode, 1);
  assert.equal(p.files.get('canon.jsonl')!.toString(), '{"k":"run"}\n');
  assert.deepEqual(p.files.get('side-x.bin'), big);
  assert.equal(p.files.get('empty')!.length, 0);
});

test('tolerates CRLF line endings', () => {
  const p = parseFrames((encodeFile('a', 'hello') + encodeExit(0)).replace(/\n/g, '\r\n'));
  assert.equal(p.files.get('a')!.toString(), 'hello');
});

test('base64 lines are at most 76 columns', () => {
  for (const l of encodeFile('a', randomBytes(500)).split('\n')) assert.ok(l.length <= 76 || l.startsWith('CHAOS-'));
});

test('truncated input is an infra error', () => {
  const full = encodeFile('a', randomBytes(300)) + encodeExit(0);
  assert.throws(() => parseFrames(full.slice(0, 120)), FrameError);
  assert.throws(() => parseFrames(encodeFile('a', 'x')), FrameError); // no exit
  assert.throws(() => parseFrames(''), FrameError);
});

test('size mismatch, garbage, duplicates and trailing data are infra errors', () => {
  assert.throws(() => parseFrames('CHAOS-FILE a 9\naGVsbG8=\nCHAOS-END a\nCHAOS-EXIT 0\n'), FrameError);
  assert.throws(() => parseFrames('noise\nCHAOS-EXIT 0\n'), FrameError);
  assert.throws(() => parseFrames(encodeFile('a', 'x') + encodeFile('a', 'x') + encodeExit(0)), FrameError);
  assert.throws(() => parseFrames(encodeExit(0) + encodeFile('a', 'x')), FrameError);
});

test('rejects unsafe names', () => {
  assert.throws(() => encodeFile('../x', 'y'));
  assert.throws(() => encodeFile('a b', 'y'));
});
