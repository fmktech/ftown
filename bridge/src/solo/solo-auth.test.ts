import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HUB_JWT_AUDIENCE, HUB_JWT_TTL_SECONDS, SOLO_USER_ID } from './contract.js';
import {
  generateAccessKey,
  mintHubJwt,
  sha256Hex,
  verifyAccessKey,
  verifyHubJwt,
} from './solo-auth.js';

import type { HubJwtVerification } from './solo-auth.js';

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const _failureReasonsMatchContract: Equals<
  HubJwtVerification['reason'],
  'malformed' | 'bad-signature' | 'expired' | 'bad-algorithm' | 'bad-audience' | 'wrong-subject'
> = true;
void _failureReasonsMatchContract;

const SECRET = 'test-hub-secret';

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Builds an arbitrary (possibly spec-violating) token signed with HS256. */
function signToken(header: object, payload: object, secret: string): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;
  return `${signingInput}.${createHmac('sha256', secret).update(signingInput, 'utf8').digest('base64url')}`;
}

describe('generateAccessKey', () => {
  it('raw is ACCESS_KEY_BYTES*2 lowercase hex chars', () => {
    const { raw } = generateAccessKey();
    assert.equal(raw.length, 64);
    assert.match(raw, /^[0-9a-f]{64}$/);
  });

  it('raw keys are unique across generations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const { raw } = generateAccessKey();
      assert.ok(!seen.has(raw));
      seen.add(raw);
    }
    assert.equal(seen.size, 100);
  });

  it('hash is the stable sha256 hex of the raw key', () => {
    const { raw, hash } = generateAccessKey();
    assert.equal(hash, sha256Hex(raw));
    assert.equal(sha256Hex(raw), sha256Hex(raw));
    assert.match(hash, /^[0-9a-f]{64}$/);
  });
});

describe('sha256Hex', () => {
  it('matches the FIPS 180-2 vector for "abc"', () => {
    assert.equal(
      sha256Hex('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is deterministic and length-agnostic', () => {
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256Hex('x'.repeat(10000)), sha256Hex('x'.repeat(10000)));
  });
});

describe('verifyAccessKey', () => {
  it('accepts a matching key', () => {
    const { raw, hash } = generateAccessKey();
    assert.equal(verifyAccessKey(raw, hash), true);
  });

  it('rejects a wrong key of equal length', () => {
    const { hash } = generateAccessKey();
    assert.equal(verifyAccessKey(generateAccessKey().raw, hash), false);
    assert.equal(verifyAccessKey('f'.repeat(64), hash), false);
  });

  it('rejects mismatched-length presented input without throwing (work equalized)', () => {
    const { hash } = generateAccessKey();
    assert.equal(verifyAccessKey('', hash), false);
    assert.equal(verifyAccessKey('short', hash), false);
    assert.equal(verifyAccessKey('z'.repeat(4096), hash), false);
  });

  it('rejects malformed expectedHash without throwing', () => {
    const { raw } = generateAccessKey();
    assert.equal(verifyAccessKey(raw, 'nothex'), false);
    assert.equal(verifyAccessKey(raw, ''), false);
  });
});

describe('mintHubJwt / verifyHubJwt roundtrip', () => {
  const NOW_MS = 1_755_000_000_000;

  it('mints a token that verifies valid with no reason', () => {
    const token = mintHubJwt({ secret: SECRET, nowMs: NOW_MS });
    const result = verifyHubJwt(token, { secret: SECRET, nowMs: NOW_MS });
    assert.deepEqual(result, { valid: true });
  });

  it('minting is deterministic under injected nowMs', () => {
    assert.equal(mintHubJwt({ secret: SECRET, nowMs: NOW_MS }), mintHubJwt({ secret: SECRET, nowMs: NOW_MS }));
  });

  it('header is exactly alg HS256 + typ JWT; payload carries contract claims', () => {
    const [headerSeg, payloadSeg] = mintHubJwt({ secret: SECRET, nowMs: NOW_MS }).split('.');
    assert.deepEqual(decodeSegment(headerSeg ?? ''), { alg: 'HS256', typ: 'JWT' });
    const payload = decodeSegment(payloadSeg ?? '');
    assert.deepEqual(payload, {
      sub: SOLO_USER_ID,
      aud: HUB_JWT_AUDIENCE,
      iat: Math.floor(NOW_MS / 1000),
      exp: Math.floor(NOW_MS / 1000) + HUB_JWT_TTL_SECONDS,
    });
  });

  it('no base64 padding anywhere in the compact serialization', () => {
    const token = mintHubJwt({ secret: SECRET, nowMs: NOW_MS });
    for (const segment of token.split('.')) {
      assert.ok(!segment.includes('='));
      assert.match(segment, /^[A-Za-z0-9_-]+$/);
    }
  });

  it('custom ttlSeconds overrides the default TTL', () => {
    const [, payloadSeg] = mintHubJwt({ secret: SECRET, nowMs: NOW_MS, ttlSeconds: 60 }).split('.');
    const payload = decodeSegment(payloadSeg ?? '');
    assert.equal((payload['exp'] as number) - (payload['iat'] as number), 60);
  });

  it('with info: payload carries an `info` claim exactly equal to the given object', () => {
    const info = { bridgeId: 'bridge-1', hostname: 'my-host' };
    const [, payloadSeg] = mintHubJwt({ secret: SECRET, nowMs: NOW_MS, info }).split('.');
    const payload = decodeSegment(payloadSeg ?? '');
    assert.deepEqual(payload['info'], info);
    assert.deepEqual(payload, {
      sub: SOLO_USER_ID,
      aud: HUB_JWT_AUDIENCE,
      iat: Math.floor(NOW_MS / 1000),
      exp: Math.floor(NOW_MS / 1000) + HUB_JWT_TTL_SECONDS,
      info,
    });
  });

  it('with info including optional connectedAt: preserved verbatim', () => {
    const info = { bridgeId: 'bridge-1', hostname: 'my-host', connectedAt: '2026-09-03T00:00:00.000Z' };
    const [, payloadSeg] = mintHubJwt({ secret: SECRET, nowMs: NOW_MS, info }).split('.');
    const payload = decodeSegment(payloadSeg ?? '');
    assert.deepEqual(payload['info'], info);
  });

  it('without info: payload has no `info` key at all', () => {
    const [, payloadSeg] = mintHubJwt({ secret: SECRET, nowMs: NOW_MS }).split('.');
    const payload = decodeSegment(payloadSeg ?? '');
    assert.equal('info' in payload, false);
  });

  it('a token minted with info still verifies OK', () => {
    const info = { bridgeId: 'bridge-1', hostname: 'my-host' };
    const token = mintHubJwt({ secret: SECRET, nowMs: NOW_MS, info });
    assert.deepEqual(verifyHubJwt(token, { secret: SECRET, nowMs: NOW_MS }), { valid: true });
  });
});

describe('verifyHubJwt failure reasons', () => {
  const NOW_MS = 1_755_000_000_000;
  const VALID_PAYLOAD = {
    sub: SOLO_USER_ID,
    aud: HUB_JWT_AUDIENCE,
    iat: Math.floor(NOW_MS / 1000),
    exp: Math.floor(NOW_MS / 1000) + HUB_JWT_TTL_SECONDS,
  };

  function expectReason(token: string, reason: NonNullable<HubJwtVerification['reason']>): void {
    const result = verifyHubJwt(token, { secret: SECRET, nowMs: NOW_MS });
    assert.deepEqual(result, { valid: false, reason });
  }

  it('malformed: wrong segment counts and garbage', () => {
    expectReason('', 'malformed');
    expectReason('not-a-token', 'malformed');
    expectReason('a.b', 'malformed');
    expectReason('a.b.c.d', 'malformed');
  });

  it('bad-algorithm: header parsed FIRST, alg "none" rejected before signature work', () => {
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString('base64url');
    expectReason(`${noneHeader}.${Buffer.from(JSON.stringify(VALID_PAYLOAD), 'utf8').toString('base64url')}.`, 'bad-algorithm');
  });

  it('bad-algorithm: alg "HS512" rejected even with a well-formed HS512 signature', () => {
    expectReason(signToken({ alg: 'HS512', typ: 'JWT' }, VALID_PAYLOAD, SECRET), 'bad-algorithm');
  });

  it('bad-algorithm: missing alg rejected', () => {
    expectReason(signToken({ typ: 'JWT' }, VALID_PAYLOAD, SECRET), 'bad-algorithm');
  });

  it('expired: past exp rejected; still-valid window accepted', () => {
    const shortTtl = 60;
    const token = mintHubJwt({ secret: SECRET, nowMs: NOW_MS, ttlSeconds: shortTtl });
    assert.deepEqual(verifyHubJwt(token, { secret: SECRET, nowMs: NOW_MS + (shortTtl - 1) * 1000 }), { valid: true });
    assert.deepEqual(verifyHubJwt(token, { secret: SECRET, nowMs: NOW_MS + (shortTtl + 1) * 1000 }), {
      valid: false,
      reason: 'expired',
    });
  });

  it('expired takes precedence over claim mismatches', () => {
    expectReason(signToken({ alg: 'HS256', typ: 'JWT' }, { ...VALID_PAYLOAD, sub: 'admin', aud: 'other' }, SECRET), 'wrong-subject');
    const expiredWrongEverything = signToken(
      { alg: 'HS256', typ: 'JWT' },
      { ...VALID_PAYLOAD, exp: Math.floor(NOW_MS / 1000) - 10 },
      SECRET,
    );
    expectReason(expiredWrongEverything, 'expired');
  });

  it('bad-signature: tampered signature segment', () => {
    const [h, p, s] = mintHubJwt({ secret: SECRET, nowMs: NOW_MS }).split('.');
    assert.ok(h && p && s);
    const flipped = s.slice(0, -2) + (s.endsWith('AA') ? 'AB' : 'AA');
    expectReason(`${h}.${p}.${flipped}`, 'bad-signature');
  });

  it('bad-signature: tampered payload segment', () => {
    const token = mintHubJwt({ secret: SECRET, nowMs: NOW_MS });
    const [h, , s] = token.split('.');
    assert.ok(h && s);
    const forgedPayload = Buffer.from(JSON.stringify(VALID_PAYLOAD), 'utf8')
      .toString('base64url')
      .replace(/^ey/, 'ez');
    assert.notEqual(forgedPayload, Buffer.from(JSON.stringify(VALID_PAYLOAD), 'utf8').toString('base64url'));
    expectReason(`${h}.${forgedPayload}.${s}`, 'bad-signature');
  });

  it('bad-signature: signed with the wrong secret', () => {
    expectReason(mintHubJwt({ secret: 'other-secret', nowMs: NOW_MS }), 'bad-signature');
  });

  it('wrong-subject: correctly signed but sub !== SOLO_USER_ID', () => {
    expectReason(signToken({ alg: 'HS256', typ: 'JWT' }, { ...VALID_PAYLOAD, sub: 'admin' }, SECRET), 'wrong-subject');
    expectReason(signToken({ alg: 'HS256', typ: 'JWT' }, { ...VALID_PAYLOAD, sub: undefined }, SECRET), 'wrong-subject');
  });

  it('bad-audience: correctly signed but aud !== HUB_JWT_AUDIENCE', () => {
    expectReason(signToken({ alg: 'HS256', typ: 'JWT' }, { ...VALID_PAYLOAD, aud: 'other:audience' }, SECRET), 'bad-audience');
    expectReason(signToken({ alg: 'HS256', typ: 'JWT' }, { ...VALID_PAYLOAD, aud: undefined }, SECRET), 'bad-audience');
  });

  it('malformed: unparseable header or non-object claims', () => {
    const badHeader = Buffer.from('%%%', 'utf8').toString('base64url');
    const goodPayload = Buffer.from(JSON.stringify(VALID_PAYLOAD), 'utf8').toString('base64url');
    const sig = createHmac('sha256', SECRET).update(`${badHeader}.${goodPayload}`, 'utf8').digest('base64url');
    expectReason(`${badHeader}.${goodPayload}.${sig}`, 'malformed');

    const goodHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString('base64url');
    const arrayPayload = Buffer.from('[1,2]', 'utf8').toString('base64url');
    const sig2 = createHmac('sha256', SECRET).update(`${goodHeader}.${arrayPayload}`, 'utf8').digest('base64url');
    expectReason(`${goodHeader}.${arrayPayload}.${sig2}`, 'malformed');
  });
});
