import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { decodeApplicationBytes, encodeApplicationBytes } from './application-compression.js';
import { MAX_ENVELOPE_BYTES } from './crypto.js';

const encoder = new TextEncoder();

test('returns plain application bytes for legacy peers and for gzip that would expand the message', async () => {
  const compressible = encoder.encode(JSON.stringify({ text: 'hello'.repeat(500) }));
  assert.deepEqual(await encodeApplicationBytes(compressible, false), compressible);
  const short = encoder.encode('{"request":"get_session_board"}');
  assert.deepEqual(await encodeApplicationBytes(short, true), short);
  assert.deepEqual(await decodeApplicationBytes(short), short);
});

test('rejects malformed gzip and limits expanded application bytes to the pre-compression transport capacity', async () => {
  await assert.rejects(decodeApplicationBytes(Uint8Array.of(0x1f, 0x8b, 0)), { code: 'invalid_envelope' });
  const oversized = new Uint8Array(Math.floor(MAX_ENVELOPE_BYTES * 3 / 4) - 16 + 1).fill(97);
  await assert.rejects(encodeApplicationBytes(oversized, true), { code: 'capacity_exceeded' });
  await assert.rejects(decodeApplicationBytes(gzipSync(oversized)), { code: 'capacity_exceeded' });
});
