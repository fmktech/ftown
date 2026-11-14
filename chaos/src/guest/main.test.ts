import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT } from '../contract.ts';
import { parseRunEnv } from './main.ts';

test('parseRunEnv accepts valid seed, level, and profile', () => {
  assert.deepEqual(parseRunEnv({ CHAOS_SEED: '1', CHAOS_LEVEL: 'low', CHAOS_PROFILE: 'short' }), {
    ok: true,
    seed: 1,
    level: 'low',
    profile: 'short',
  });
  assert.deepEqual(parseRunEnv({ CHAOS_SEED: '7', CHAOS_LEVEL: 'high', CHAOS_PROFILE: 'soak' }), {
    ok: true,
    seed: 7,
    level: 'high',
    profile: 'soak',
  });
});

test('parseRunEnv rejects missing, invalid CHAOS_PROFILE, or (short, high) with EXIT.usage (64)', () => {
  for (const profile of [undefined, '', 'fast', 'SHORT']) {
    const r = parseRunEnv({ CHAOS_SEED: '1', CHAOS_LEVEL: 'low', ...(profile === undefined ? {} : { CHAOS_PROFILE: profile }) });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, EXIT.usage);
  }
  const combo = parseRunEnv({ CHAOS_SEED: '1', CHAOS_LEVEL: 'high', CHAOS_PROFILE: 'short' });
  assert.equal(combo.ok, false);
  if (!combo.ok) assert.equal(combo.code, EXIT.usage);
});
