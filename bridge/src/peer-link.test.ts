import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameAssembler, frameMessage } from './peer-link.js';

test('a message survives framing whatever its size', () => {
  for (const size of [0, 1, 31_999, 32_000, 32_001, 250_000]) {
    const message = 'é'.repeat(size);
    const frames = frameMessage(message);
    assert.equal(frames.length, Math.max(1, Math.ceil(size / 32_000)));
    const assembler = new FrameAssembler();
    const out = frames.map(frame => assembler.push(frame));
    assert.equal(out.at(-1), message);
    assert.ok(out.slice(0, -1).every(part => part === null));
  }
});

test('interleaved messages are reassembled independently', () => {
  const a = frameMessage('a'.repeat(70_000), 'a'.repeat(16));
  const b = frameMessage('b'.repeat(70_000), 'b'.repeat(16));
  const assembler = new FrameAssembler();
  const results = [a[0], b[0], a[1], b[1], b[2], a[2]].map(frame => assembler.push(frame));
  assert.equal(results[4], 'b'.repeat(70_000));
  assert.equal(results[5], 'a'.repeat(70_000));
});

test('malformed, out-of-order and oversized frames are refused', () => {
  const frames = frameMessage('x'.repeat(70_000), 'c'.repeat(16));
  assert.throws(() => new FrameAssembler().push('not a frame'));
  assert.throws(() => new FrameAssembler().push(frames[1]), 'a message must start at its first frame');
  const skipping = new FrameAssembler(); skipping.push(frames[0]);
  assert.throws(() => skipping.push(frames[2]));
  assert.throws(() => new FrameAssembler().push(`${'d'.repeat(16)}.0.9999.x`), 'too many frames');
  assert.throws(() => new FrameAssembler().push(`${'d'.repeat(16)}.0.1.${'x'.repeat(32_001)}`), 'frame too long');
  const flooded = new FrameAssembler();
  for (let i = 0; i < 32; i++) flooded.push(`${i.toString(16).padStart(16, '0')}.0.2.x`);
  assert.throws(() => flooded.push(`${'e'.repeat(16)}.0.2.x`), 'too many unfinished messages');
});
