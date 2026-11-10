import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalSticky, checkpointMac, checkpointMacValid, requireCheckpointKey, type CheckpointMacInput } from './checkpoint-mac';

const SECRET = 'checkpoint-mac-test-secret-0123456789abcdef';
beforeEach(() => { vi.stubEnv('AUTH_SECRET', SECRET); });
afterEach(() => { vi.unstubAllEnvs(); });

const input: CheckpointMacInput = {
  accountId: 'A'.repeat(43), revision: 3, head: 'H'.repeat(43),
  sticky: { deviceIds: ['d1', 'd2'], bridgeIds: ['b1'] },
  checkpoint: '{"version":2,"accountId":"AAAA","revision":3}',
};

/** The amendment's formula, written out independently (RFC 5869 HKDF with an empty salt, one output block). */
function reference(value: CheckpointMacInput, secret: string): string {
  const prk = createHmac('sha256', Buffer.alloc(32)).update(secret).digest();
  const key = createHmac('sha256', prk).update(Buffer.concat([Buffer.from('ftown-checkpoint-v1'), Buffer.from([1])])).digest();
  const sticky = createHash('sha256').update(JSON.stringify({ deviceIds: value.sticky.deviceIds, bridgeIds: value.sticky.bridgeIds })).digest('hex');
  return createHmac('sha256', key).update(`ftown-checkpoint-v1\n${value.accountId}\n${value.revision}\n${value.head}\n${sticky}\n${value.checkpoint}`).digest('hex');
}

describe('checkpointMac', () => {
  it('is HMAC-SHA256 under HKDF-SHA256(AUTH_SECRET, info "ftown-checkpoint-v1") of the newline-separated row fields', () => {
    expect(checkpointMac(input)).toBe(reference(input, SECRET));
    expect(checkpointMac(input)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any single input changes', () => {
    const base = checkpointMac(input);
    const variants: Array<[string, CheckpointMacInput]> = [
      ['accountId', { ...input, accountId: 'B'.repeat(43) }],
      ['revision', { ...input, revision: 4 }],
      ['head', { ...input, head: 'G'.repeat(43) }],
      ['sticky device removed', { ...input, sticky: { deviceIds: ['d1'], bridgeIds: ['b1'] } }],
      ['sticky device added', { ...input, sticky: { deviceIds: ['d1', 'd2', 'd3'], bridgeIds: ['b1'] } }],
      ['sticky order', { ...input, sticky: { deviceIds: ['d2', 'd1'], bridgeIds: ['b1'] } }],
      ['sticky bridge removed', { ...input, sticky: { deviceIds: ['d1', 'd2'], bridgeIds: [] } }],
      ['sticky id moved between lists', { ...input, sticky: { deviceIds: ['d1', 'd2', 'b1'], bridgeIds: [] } }],
      ['checkpoint text', { ...input, checkpoint: input.checkpoint.replace('3}', '4}') }],
      ['checkpoint whitespace', { ...input, checkpoint: `${input.checkpoint} ` }],
    ];
    const seen = new Set([base]);
    for (const [name, variant] of variants) {
      const mac = checkpointMac(variant);
      expect(mac, name).not.toBe(base);
      expect(checkpointMacValid(variant, base), name).toBe(false);
      seen.add(mac);
    }
    expect(seen.size).toBe(variants.length + 1);
    const rotated = 'another-auth-secret-0123456789abcdefghijkl';
    vi.stubEnv('AUTH_SECRET', rotated);
    expect(checkpointMac(input)).not.toBe(base);
    expect(checkpointMacValid(input, base)).toBe(false);
    expect(checkpointMac(input)).toBe(reference(input, rotated));
  });

  it('serializes the sticky set one way only, whatever the key order of the object given', () => {
    const reordered = { bridgeIds: ['b1'], deviceIds: ['d1', 'd2'] };
    expect(canonicalSticky(reordered)).toBe('{"deviceIds":["d1","d2"],"bridgeIds":["b1"]}');
    expect(checkpointMac({ ...input, sticky: reordered })).toBe(checkpointMac(input));
  });

  it('refuses inputs that would make the message ambiguous', () => {
    for (const bad of [{ ...input, accountId: 'A\nB' }, { ...input, head: 'H\n1' }, { ...input, revision: -1 }, { ...input, revision: 1.5 }]) {
      expect(() => checkpointMac(bad)).toThrow(TypeError);
      expect(checkpointMacValid(bad, checkpointMac(input))).toBe(false);
    }
  });

  it('refuses to work without a usable AUTH_SECRET, and never puts the secret in the error', () => {
    for (const value of [undefined, 'short', 'change-me-change-me-change-me-change-me']) {
      vi.stubEnv('AUTH_SECRET', value);
      let message = '';
      try { checkpointMac(input); } catch (error) { message = (error as Error).message; }
      expect(message).toMatch(/AUTH_SECRET/);
      if (value) expect(message).not.toContain(value);
    }
  });
});

describe('checkpointMacValid', () => {
  it('accepts exactly the MAC of these inputs', () => {
    const mac = checkpointMac(input);
    expect(checkpointMacValid(input, mac)).toBe(true);
    const flipped = (mac[0] === '0' ? '1' : '0') + mac.slice(1);
    for (const value of [flipped, mac.toUpperCase(), mac.slice(0, 63), `${mac}0`, '', null, undefined, 5, { mac }]) {
      expect(checkpointMacValid(input, value), String(value)).toBe(false);
    }
  });
});

describe('requireCheckpointKey', () => {
  it('passes with a usable AUTH_SECRET and throws (naming the variable only) for a missing, short or placeholder one', () => {
    expect(() => requireCheckpointKey()).not.toThrow();
    for (const value of [undefined, 'short', 'change-me-change-me-change-me-change-me']) {
      vi.stubEnv('AUTH_SECRET', value);
      expect(() => requireCheckpointKey()).toThrow(/AUTH_SECRET/);
    }
  });
});
