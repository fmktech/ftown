import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { derToRawSignature, verifyPasskeyAssertion } from './webauthn.js';
import { createSoftPasskey, rawToDerSignature } from './testing.js';
import type { PasskeySignature } from './protocol.js';

type VerifyInput = Parameters<typeof verifyPasskeyAssertion>[0];

const rpId = 'ftown.example';
const origin = 'https://ftown.example';
const origins = [origin, 'https://app.ftown.example'];
const encoder = new TextEncoder();
const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64url');
const unb64 = (data: string): Uint8Array => new Uint8Array(Buffer.from(data, 'base64url'));
const hex = (data: Uint8Array): string => Buffer.from(data).toString('hex');
const fromHex = (data: string): Uint8Array => new Uint8Array(Buffer.from(data, 'hex'));
const sha256 = (data: Uint8Array | string): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest());
const newChallenge = (length = 32): Uint8Array => new Uint8Array(randomBytes(length));
function concat(...parts: ArrayLike<number>[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function check(publicKey: string, signature: PasskeySignature, challenge: Uint8Array, overrides: { rpId?: string; origins?: readonly string[] } = {}): Promise<boolean> {
  return verifyPasskeyAssertion({ publicKey, rpId: overrides.rpId ?? rpId, origins: overrides.origins ?? origins, challenge, signature });
}
function pointKey(point: string): KeyObject {
  const bytes = unb64(point);
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(bytes.subarray(1, 33)), y: b64(bytes.subarray(33, 65)) }, format: 'jwk' });
}
const clientData = (challenge: Uint8Array): Record<string, unknown> => ({ type: 'webauthn.get', challenge: b64(challenge), origin, crossOrigin: false });
const authData = (flags = 0x05, rp = rpId, counter: number[] = [0, 0, 0, 0]): Uint8Array => concat(sha256(rp), [flags], counter);

/** OpenSSL-backed signer, independent of testing.ts, for hand-built WebAuthn structures. */
interface NodeKey { privateKey: KeyObject; publicKey: KeyObject; point: string }
function nodeKey(): NodeKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }));
  return { privateKey, publicKey, point: b64(spki.subarray(spki.length - 65)) };
}
function craft(key: NodeKey, challenge: Uint8Array, parts: { authenticatorData?: Uint8Array; clientDataJSON?: Uint8Array; clientData?: Record<string, unknown> } = {}) {
  const authenticatorData = parts.authenticatorData ?? authData();
  const clientDataJSON = parts.clientDataJSON ?? encoder.encode(JSON.stringify(parts.clientData ?? clientData(challenge)));
  const signed = concat(authenticatorData, sha256(clientDataJSON));
  const raw = new Uint8Array(nodeSign('sha256', signed, { key: key.privateKey, dsaEncoding: 'ieee-p1363' }));
  const der = new Uint8Array(nodeSign('sha256', signed, { key: key.privateKey, dsaEncoding: 'der' }));
  const signature: PasskeySignature = { authenticatorData: b64(authenticatorData), clientDataJSON: b64(clientDataJSON), signature: b64(der) };
  return { signature, raw, signed };
}
function withSignature(signature: PasskeySignature, der: ArrayLike<number>): PasskeySignature {
  return { ...signature, signature: b64(Uint8Array.from(der)) };
}

/*
 * Fixed vectors. NOT captured from a real authenticator: built offline with one fixed P-256 key, following the
 * WebAuthn byte layout (authenticatorData = rpIdHash | flags | signCount, browser clientDataJSON serialization)
 * and signed by OpenSSL with DER output. A: platform-passkey flags (UP|UV|BE|BS), r carries a sign pad.
 * B: security-key flags (UP|UV), signCount 42, Chrome's extra clientData key, 31-byte s. C: UP only (no UV).
 */
const FIXED = {
  rpId: 'example.com',
  origin: 'https://example.com',
  publicKey: 'BJ1wLQ9lxcErtbpdPM7dorvGQ_gFGxIBCkRBwb41sBxTYmw-eYWBvAujg9DaClQ-RHFdBTgxm6hDaruFgeiGouM',
  vectors: [
    {
      name: 'A', valid: true,
      challenge: '6c98f0ab3f5cce13cf45f84af33f9e28ed19227ac2745cfbacf18b46905faff5',
      authenticatorData: 'o3mm9u6vuaVeN4wRgDTidR5oL6ufLTCrE9ISVYbOGUcdAAAAAA',
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiYkpqd3F6OWN6aFBQUmZoSzh6LWVLTzBaSW5yQ2RGejdyUEdMUnBCZnJfVSIsIm9yaWdpbiI6Imh0dHBzOi8vZXhhbXBsZS5jb20iLCJjcm9zc09yaWdpbiI6ZmFsc2V9',
      signature: 'MEUCIQDLOyd9e0Dz7-aF_23e7C_Iqw5kQ8GlgggQ0ho49VYmdQIgTR1LEy4yY2IiM2nR3ADKpSgiUNdoWiOUKUkgCoi4T90',
      raw: 'cb3b277d7b40f3efe685ff6ddeec2fc8ab0e6443c1a5820810d21a38f55626754d1d4b132e326362223369d1dc00caa5282250d7685a23942949200a88b84fdd',
    },
    {
      name: 'B', valid: true,
      challenge: '6d432bdbf24bc4a4fe8f5ea7abeacce6f1eb386cee69651eab8fc5a0b59b5f20',
      authenticatorData: 'o3mm9u6vuaVeN4wRgDTidR5oL6ufLTCrE9ISVYbOGUcFAAAAKg', // gitleaks:allow (public WebAuthn test vector)
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiYlVNcjJfSkx4S1QtajE2bnEtck01dkhyT0d6dWFXVWVxNF9Gb0xXYlh5QSIsIm9yaWdpbiI6Imh0dHBzOi8vZXhhbXBsZS5jb20iLCJjcm9zc09yaWdpbiI6ZmFsc2UsIm90aGVyX2tleXNfY2FuX2JlX2FkZGVkX2hlcmUiOiJkbyBub3QgY29tcGFyZSBjbGllbnREYXRhSlNPTiBhZ2FpbnN0IGEgdGVtcGxhdGUuIFNlZSBodHRwczovL2dvby5nbC95YWJQZXgifQ',
      signature: 'MEMCIH8DcWbdtXNj4QOMo1KhPasWAoUiHoK0lw9Bl-BlbJymAh8MFFh-U7Y61GMfksenKUqXeu6gdg8MexsxKg-rk7Zp',
      raw: '7f037166ddb57363e1038ca352a13dab160285221e82b4970f4197e0656c9ca6000c14587e53b63ad4631f92c7a7294a977aeea0760f0c7b1b312a0fab93b669',
    },
    {
      name: 'C', valid: false,
      challenge: '41111c3c70398c02b81fa2d9016e74c8419f8115836793932e4e897278578a25',
      authenticatorData: 'o3mm9u6vuaVeN4wRgDTidR5oL6ufLTCrE9ISVYbOGUcBAAAABw', // gitleaks:allow (public WebAuthn test vector)
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiUVJFY1BIQTVqQUs0SDZMWkFXNTB5RUdmZ1JXRFo1T1RMazZKY25oWGlpVSIsIm9yaWdpbiI6Imh0dHBzOi8vZXhhbXBsZS5jb20ifQ',
      signature: 'MEQCIBH0S-hRo-Sdgba51asIUPwnkrm6QeeA3Z_FCqUk5L_xAiADXz08bNvfjyuxc_uZ04g1-I2l9LMY3k2W5k_AWr_QGw',
      raw: '11f44be851a3e49d81b6b9d5ab0850fc2792b9ba41e780dd9fc50aa524e4bff1035f3d3c6cdbdf8f2bb173fb99d38835f88da5f4b318de4d96e64fc05abfd01b',
    },
  ],
};

test('a soft-passkey assertion verifies for every listed origin and has the WebAuthn byte layout', async () => {
  const passkey = await createSoftPasskey({ rpId, origin });
  const challenge = newChallenge();
  const signature = await passkey.sign(challenge);
  assert.equal(await check(passkey.publicKey, signature, challenge), true);
  assert.equal(await check(passkey.publicKey, await passkey.sign(challenge, { origin: origins[1] }), challenge), true);
  assert.equal(await check(passkey.publicKey, signature, Buffer.from(challenge)), true);
  const data = unb64(signature.authenticatorData);
  assert.equal(data.length, 37);
  assert.deepEqual(data.subarray(0, 32), sha256(rpId));
  assert.equal(data[32], 0x1d);
  assert.deepEqual(Array.from(data.subarray(33)), [0, 0, 0, 0]);
  assert.equal(Buffer.from(unb64(signature.clientDataJSON)).toString('utf8'),
    `{"type":"webauthn.get","challenge":"${b64(challenge)}","origin":"${origin}","crossOrigin":false}`);
  assert.equal(unb64(passkey.credentialId).length, 32);
  assert.equal(unb64(passkey.publicKey).length, 65);
  assert.equal(nodeVerify('sha256', concat(data, sha256(unb64(signature.clientDataJSON))),
    { key: pointKey(passkey.publicKey), dsaEncoding: 'der' }, unb64(signature.signature)), true);
});

test('OpenSSL-signed assertions verify across browser clientData and authenticatorData variants', async () => {
  const key = nodeKey();
  const challenge = newChallenge();
  const variants: Record<string, unknown>[] = [
    { type: 'webauthn.get', challenge: b64(challenge), origin },
    { ...clientData(challenge), other_keys_can_be_added_here: 'do not compare clientDataJSON against a template. See https://goo.gl/yabPex' },
    { origin, challenge: b64(challenge), type: 'webauthn.get', crossOrigin: false },
  ];
  for (const variant of variants) assert.equal(await check(key.point, craft(key, challenge, { clientData: variant }).signature, challenge), true);
  assert.equal(await check(key.point, craft(key, challenge, { authenticatorData: authData(0x1d, rpId, [0, 0, 1, 0]) }).signature, challenge), true);
  assert.equal(await check(key.point, craft(key, challenge, { authenticatorData: concat(authData(0x85), [0xa1, 0x61, 0x78, 0xf5]) }).signature, challenge), true);
  const short = newChallenge(16);
  assert.equal(await check(key.point, craft(key, short).signature, short), true);
});

test('flag variants verify: 0x05 security key, 0x1D synced passkey, a signCount, and ED extension data', async () => {
  const passkey = await createSoftPasskey({ rpId, origin });
  const challenge = newChallenge();
  for (const flags of [0x05, 0x1d]) {
    const signature = await passkey.sign(challenge, { flags, signCount: 42 });
    const data = unb64(signature.authenticatorData);
    assert.equal(data[32], flags);
    assert.deepEqual(Array.from(data.subarray(33)), [0, 0, 0, 42]);
    assert.equal(await check(passkey.publicKey, signature, challenge), true, `${flags}`);
  }
  const flagsOf = async (options: Parameters<typeof passkey.sign>[1]): Promise<number> => unb64((await passkey.sign(challenge, options)).authenticatorData)[32];
  assert.equal(await flagsOf({ uv: false }), 0x19);
  assert.equal(await flagsOf({ up: false }), 0x1c);
  assert.equal(await flagsOf({ flags: 0x05, up: false }), 0x04);
  assert.equal(await flagsOf({ flags: 0x01, uv: true }), 0x05);
  const counter = unb64((await passkey.sign(challenge, { signCount: 0xfffffffe })).authenticatorData).subarray(33);
  assert.deepEqual(Array.from(counter), [0xff, 0xff, 0xff, 0xfe]);
  await assert.rejects(passkey.sign(challenge, { flags: 0x100 }));
  await assert.rejects(passkey.sign(challenge, { signCount: -1 }));
  const key = nodeKey();
  const credProtect = concat([0xa1, 0x6b], encoder.encode('credProtect'), [0x02]);
  for (const flags of [0x85, 0x9d]) {
    const authenticatorData = concat(authData(flags, rpId, [0, 0, 0, 7]), credProtect);
    assert.equal(await check(key.point, craft(key, challenge, { authenticatorData }).signature, challenge), true, `${flags}`);
  }
});

test('rejects base64url whose unused trailing bits are set', async () => {
  const vector = FIXED.vectors[0];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const tweak = (value: string): string => value.slice(0, -1) + alphabet[alphabet.indexOf(value[value.length - 1]) | 1];
  const signature: PasskeySignature = { authenticatorData: vector.authenticatorData, clientDataJSON: vector.clientDataJSON, signature: vector.signature };
  const options = { rpId: FIXED.rpId, origins: [FIXED.origin] };
  const challenge = fromHex(vector.challenge);
  assert.equal(await check(FIXED.publicKey, signature, challenge, options), true);
  const authenticatorData = tweak(vector.authenticatorData);
  const publicKey = tweak(FIXED.publicKey);
  for (const [original, tweaked] of [[vector.authenticatorData, authenticatorData], [FIXED.publicKey, publicKey]]) {
    assert.notEqual(tweaked, original);
    assert.deepEqual(unb64(tweaked), unb64(original));
  }
  assert.equal(await check(FIXED.publicKey, { ...signature, authenticatorData }, challenge, options), false);
  assert.equal(await check(publicKey, signature, challenge, options), false);
});

test('fixed spec-layout vectors verify, convert to the expected r||s and agree with OpenSSL', async () => {
  for (const vector of FIXED.vectors) {
    const signature: PasskeySignature = { authenticatorData: vector.authenticatorData, clientDataJSON: vector.clientDataJSON, signature: vector.signature };
    const options = { rpId: FIXED.rpId, origins: [FIXED.origin] };
    assert.equal(await check(FIXED.publicKey, signature, fromHex(vector.challenge), options), vector.valid, vector.name);
    assert.equal(await check(FIXED.publicKey, signature, sha256(vector.challenge), options), false, vector.name);
    assert.equal(hex(derToRawSignature(unb64(vector.signature))), vector.raw, vector.name);
    const signed = concat(unb64(vector.authenticatorData), sha256(unb64(vector.clientDataJSON)));
    assert.equal(nodeVerify('sha256', signed, { key: pointKey(FIXED.publicKey), dsaEncoding: 'der' }, unb64(vector.signature)), true, vector.name);
    assert.equal(nodeVerify('sha256', signed, { key: pointKey(FIXED.publicKey), dsaEncoding: 'ieee-p1363' }, fromHex(vector.raw)), true, vector.name);
  }
});

test('rejects a wrong challenge', async () => {
  const passkey = await createSoftPasskey({ rpId, origin });
  const challenge = newChallenge();
  const signature = await passkey.sign(challenge);
  assert.equal(await check(passkey.publicKey, signature, newChallenge()), false);
  assert.equal(await check(passkey.publicKey, signature, challenge.subarray(0, 31)), false);
  assert.equal(await check(passkey.publicKey, signature, concat(challenge, [0])), false);
});

test('rejects a wrong origin, including near misses', async () => {
  const passkey = await createSoftPasskey({ rpId, origin });
  const challenge = newChallenge();
  const wrong = ['https://evil.example', 'https://ftown.example/', 'https://ftown.example:443', 'http://ftown.example',
    'https://FTOWN.example', 'https://ftown.example.evil.test', 'https://evil.ftown.example', 'null', ''];
  for (const value of wrong) assert.equal(await check(passkey.publicKey, await passkey.sign(challenge, { origin: value }), challenge), false, value);
});

test('rejects an origin missing from the list', async () => {
  const passkey = await createSoftPasskey({ rpId, origin });
  const challenge = newChallenge();
  const signature = await passkey.sign(challenge);
  assert.equal(await check(passkey.publicKey, signature, challenge, { origins: ['https://app.ftown.example'] }), false);
  assert.equal(await check(passkey.publicKey, signature, challenge, { origins: [] }), false);
  assert.equal(await verifyPasskeyAssertion({ publicKey: passkey.publicKey, rpId, origins: origin as unknown as string[], challenge, signature }), false);
});

test('rejects a wrong rpId', async () => {
  const passkey = await createSoftPasskey({ rpId, origin });
  const challenge = newChallenge();
  assert.equal(await check(passkey.publicKey, await passkey.sign(challenge, { rpId: 'evil.example' }), challenge), false);
  assert.equal(await check(passkey.publicKey, await passkey.sign(challenge, { rpId: 'app.ftown.example' }), challenge), false);
  assert.equal(await check(passkey.publicKey, await passkey.sign(challenge), challenge, { rpId: 'example' }), false);
  assert.equal(await check(passkey.publicKey, await passkey.sign(challenge), challenge, { rpId: '' }), false);
});

test('rejects an assertion without user verification', async () => {
  const passkey = await createSoftPasskey({ rpId, origin });
  const challenge = newChallenge();
  assert.equal(await check(passkey.publicKey, await passkey.sign(challenge, { uv: false }), challenge), false);
  const key = nodeKey();
  assert.equal(await check(key.point, craft(key, challenge, { authenticatorData: authData(0x19) }).signature, challenge), false);
});

test('rejects an assertion without user presence', async () => {
  const passkey = await createSoftPasskey({ rpId, origin });
  const challenge = newChallenge();
  assert.equal(await check(passkey.publicKey, await passkey.sign(challenge, { up: false }), challenge), false);
  assert.equal(await check(passkey.publicKey, await passkey.sign(challenge, { up: false, uv: false }), challenge), false);
});

test('rejects a clientData type other than webauthn.get', async () => {
  const passkey = await createSoftPasskey({ rpId, origin });
  const challenge = newChallenge();
  for (const type of ['webauthn.create', 'webauthn.get ', 'WEBAUTHN.GET', 'payment.get', '']) {
    assert.equal(await check(passkey.publicKey, await passkey.sign(challenge, { type }), challenge), false, type);
  }
  const key = nodeKey();
  const { type: _type, ...missing } = clientData(challenge);
  assert.equal(await check(key.point, craft(key, challenge, { clientData: missing }).signature, challenge), false);
});

test('rejects a cross-origin assertion', async () => {
  const passkey = await createSoftPasskey({ rpId, origin });
  const challenge = newChallenge();
  assert.equal(await check(passkey.publicKey, await passkey.sign(challenge, { crossOrigin: true }), challenge), false);
  const key = nodeKey();
  for (const crossOrigin of ['true', 1, null, 'false']) {
    assert.equal(await check(key.point, craft(key, challenge, { clientData: { ...clientData(challenge), crossOrigin } }).signature, challenge), false, String(crossOrigin));
  }
});

test('rejects a tampered authenticatorData byte', async () => {
  const passkey = await createSoftPasskey({ rpId, origin });
  const challenge = newChallenge();
  const signature = await passkey.sign(challenge);
  for (const [index, mask] of [[36, 0x01], [33, 0x80], [32, 0x40], [32, 0x08]]) {
    const data = unb64(signature.authenticatorData);
    data[index] ^= mask;
    assert.equal(await check(passkey.publicKey, { ...signature, authenticatorData: b64(data) }, challenge), false, `${index}`);
  }
  assert.equal(await check(passkey.publicKey, { ...signature, authenticatorData: b64(concat(unb64(signature.authenticatorData), [0])) }, challenge), false);
});

test('rejects tampered clientDataJSON', async () => {
  const passkey = await createSoftPasskey({ rpId, origin });
  const challenge = newChallenge();
  const signature = await passkey.sign(challenge);
  const parsed: unknown = JSON.parse(Buffer.from(unb64(signature.clientDataJSON)).toString('utf8'));
  const tampered = [JSON.stringify(parsed, null, 1), JSON.stringify({ ...clientData(challenge), extra: 1 }), `${JSON.stringify(parsed)} `];
  for (const text of tampered) assert.equal(await check(passkey.publicKey, { ...signature, clientDataJSON: b64(encoder.encode(text)) }, challenge), false, text);
});

test('rejects a signature from another key', async () => {
  const passkey = await createSoftPasskey({ rpId, origin });
  const other = await createSoftPasskey({ rpId, origin });
  const challenge = newChallenge();
  const signature = await passkey.sign(challenge);
  assert.equal(await check(other.publicKey, signature, challenge), false);
  const foreign = await other.sign(challenge);
  assert.equal(await check(passkey.publicKey, { ...signature, signature: foreign.signature }, challenge), false);
});

test('rejects truncated authenticatorData even when the signature covers it', async () => {
  const key = nodeKey();
  const challenge = newChallenge();
  for (const length of [36, 33, 32, 1]) {
    const crafted = craft(key, challenge, { authenticatorData: authData().subarray(0, length) });
    assert.equal(await check(key.point, crafted.signature, challenge), false, `${length}`);
  }
  const empty = craft(key, challenge);
  assert.equal(await check(key.point, { ...empty.signature, authenticatorData: '' }, challenge), false);
});

test('rejects a malformed public key', async () => {
  const passkey = await createSoftPasskey({ rpId, origin });
  const challenge = newChallenge();
  const signature = await passkey.sign(challenge);
  const point = unb64(passkey.publicKey);
  const parity = point[64] & 1;
  const cases = [
    b64(point.subarray(1)),
    b64(concat([0x02 | parity], point.subarray(1, 33))),
    b64(concat([0x02 | parity], point.subarray(1))),
    b64(concat([0x06 | parity], point.subarray(1))),
    b64(concat(point, [0])),
    b64(concat([0x04], point.subarray(1, 33), sha256('not on the curve'))),
    b64(concat([0x04], new Uint8Array(64))),
    `${passkey.publicKey}=`,
    Buffer.from(point).toString('base64'),
    '',
  ];
  for (const publicKey of cases) assert.equal(await check(publicKey, signature, challenge), false, publicKey);
});

test('rejects clientData that is not a UTF-8 JSON object', async () => {
  const key = nodeKey();
  const challenge = newChallenge();
  const json = JSON.stringify(clientData(challenge));
  const cases = [
    encoder.encode('not json'),
    encoder.encode('[]'),
    encoder.encode('null'),
    encoder.encode('"webauthn.get"'),
    encoder.encode(json.slice(0, -1)),
    concat(encoder.encode(`${json.slice(0, -1)},"x":"`), [0xff], encoder.encode('"}')),
  ];
  for (const clientDataJSON of cases) assert.equal(await check(key.point, craft(key, challenge, { clientDataJSON }).signature, challenge), false, hex(clientDataJSON));
  assert.equal(await check(key.point, { ...craft(key, challenge).signature, clientDataJSON: '' }, challenge), false);
});

test('rejects a challenge encoded as padded or standard base64', async () => {
  const key = nodeKey();
  const challenge = concat([0xfb, 0xff, 0xbf], newChallenge(29));
  const canonical = b64(challenge);
  const cases = [Buffer.from(challenge).toString('base64'), `${canonical}=`, Buffer.from(challenge).toString('base64').replace(/=+$/, '')];
  for (const encoded of cases) {
    assert.notEqual(encoded, canonical);
    const crafted = craft(key, challenge, { clientData: { ...clientData(challenge), challenge: encoded } });
    assert.equal(await check(key.point, crafted.signature, challenge), false, encoded);
  }
  assert.equal(await check(key.point, craft(key, challenge).signature, challenge), true);
});

test('rejects non-canonical base64url in signature fields', async () => {
  const key = nodeKey();
  const challenge = newChallenge();
  const { signature } = craft(key, challenge);
  for (const field of ['authenticatorData', 'clientDataJSON', 'signature'] as const) {
    const standard = Buffer.from(unb64(signature[field])).toString('base64');
    assert.equal(await check(key.point, { ...signature, [field]: `${signature[field]}=` }, challenge), false, field);
    if (standard !== signature[field]) assert.equal(await check(key.point, { ...signature, [field]: standard }, challenge), false, field);
  }
});

test('rejects challenges shorter than 16 bytes', async () => {
  const key = nodeKey();
  for (const length of [0, 1, 15]) {
    const challenge = newChallenge(length);
    assert.equal(await check(key.point, craft(key, challenge).signature, challenge), false, `${length}`);
  }
});

test('never throws on hostile input', async () => {
  const passkey = await createSoftPasskey({ rpId, origin });
  const challenge = newChallenge();
  const signature = await passkey.sign(challenge);
  const valid: VerifyInput = { publicKey: passkey.publicKey, rpId, origins, challenge, signature };
  const throwing = Object.defineProperty({ ...valid }, 'signature', { get() { throw new Error('boom'); } });
  const hostile: unknown[] = [
    null, undefined, {}, 42, throwing,
    { ...valid, signature: null },
    { ...valid, signature: { ...signature, signature: 42 } },
    { ...valid, signature: { ...signature, clientDataJSON: undefined } },
    { ...valid, challenge: Array.from(challenge) },
    { ...valid, challenge: b64(challenge) },
    { ...valid, challenge: new DataView(challenge.buffer) },
    { ...valid, rpId: 42 },
    { ...valid, publicKey: null },
    { ...valid, origins: null },
    { ...valid, signature: { ...signature, authenticatorData: 'A'.repeat(1000000) } },
    { ...valid, signature: { ...signature, clientDataJSON: b64(new Uint8Array(5000)) } },
  ];
  for (const input of hostile) assert.equal(await verifyPasskeyAssertion(input as VerifyInput), false);
  assert.equal(await verifyPasskeyAssertion(valid), true);
});

test('rawToDerSignature and derToRawSignature round-trip, including sign pads and short values', () => {
  const cases: Uint8Array[] = [];
  for (let index = 0; index < 2000; index += 1) cases.push(newChallenge(64));
  for (let zeros = 1; zeros < 32; zeros += 1) {
    const raw = newChallenge(64);
    raw.fill(0, 0, zeros);
    raw[zeros] = (raw[zeros] & 0x7f) | 0x01;
    raw.fill(0, 32, 32 + zeros);
    raw[32 + zeros] |= 0x80;
    cases.push(raw);
  }
  const one = new Uint8Array(64);
  one[31] = 1;
  one[63] = 1;
  cases.push(one, new Uint8Array(64).fill(0xff), concat([0x80], new Uint8Array(31), [0x7f], new Uint8Array(31).fill(1)));
  let padded = 0;
  let short = 0;
  for (const raw of cases) {
    const der = rawToDerSignature(raw);
    assert.equal(der[0], 0x30);
    assert.equal(der[1], der.length - 2);
    const rLength = der[3];
    if (der[4] === 0) padded += 1;
    if (rLength < 32) short += 1;
    assert.deepEqual(derToRawSignature(der), raw, hex(raw));
  }
  assert.ok(padded > 800, `${padded}`);
  assert.ok(short >= 31, `${short}`);
  assert.equal(hex(rawToDerSignature(one)), '3006020101020101');
  assert.throws(() => rawToDerSignature(new Uint8Array(63)));
});

test('DER conversion agrees with OpenSSL in both directions', () => {
  const key = nodeKey();
  for (let index = 0; index < 300; index += 1) {
    const data = newChallenge(48);
    const der = new Uint8Array(nodeSign('sha256', data, { key: key.privateKey, dsaEncoding: 'der' }));
    assert.equal(nodeVerify('sha256', data, { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, derToRawSignature(der)), true);
    const raw = new Uint8Array(nodeSign('sha256', data, { key: key.privateKey, dsaEncoding: 'ieee-p1363' }));
    const reencoded = rawToDerSignature(raw);
    assert.equal(nodeVerify('sha256', data, { key: key.publicKey, dsaEncoding: 'der' }, reencoded), true);
    assert.deepEqual(derToRawSignature(reencoded), raw);
  }
});

test('malformed DER throws in derToRawSignature and fails verifyPasskeyAssertion', async () => {
  const key = nodeKey();
  const challenge = newChallenge();
  const crafted = craft(key, challenge);
  const r = crafted.raw.subarray(0, 32);
  const s = crafted.raw.subarray(32, 64);
  const minimal = (value: Uint8Array): number[] => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start += 1;
    const body = Array.from(value.subarray(start));
    return body[0] >= 0x80 ? [0].concat(body) : body;
  };
  const tlv = (tag: number, body: number[], length: number[] = [body.length]): number[] => [tag].concat(length, body);
  const rBody = minimal(r);
  const sBody = minimal(s);
  const content = tlv(0x02, rBody).concat(tlv(0x02, sBody));
  const valid = tlv(0x30, content);
  assert.equal(await check(key.point, withSignature(crafted.signature, valid), challenge), true);
  const negative = Array.from(r);
  negative[0] |= 0x80;
  // Only cases that stay within the 72-byte cap whatever the random r and s; length and pad rules are in the fixed test below.
  const cases: Record<string, number[]> = {
    'empty': [],
    'wrong outer tag': tlv(0x31, content),
    'truncated': valid.slice(0, -1),
    'sequence length too long': [0x30, content.length + 1].concat(content),
    'sequence length too short': [0x30, content.length - 1].concat(content),
    'wrong integer tag': tlv(0x30, tlv(0x03, rBody).concat(tlv(0x02, sBody))),
    'negative r': tlv(0x30, tlv(0x02, negative).concat(tlv(0x02, sBody))),
    'zero-length r': tlv(0x30, [0x02, 0x00].concat(tlv(0x02, sBody))),
    'zero-length s': tlv(0x30, tlv(0x02, rBody).concat([0x02, 0x00])),
    'r is zero': tlv(0x30, tlv(0x02, [0]).concat(tlv(0x02, sBody))),
    'r longer than 32 bytes': tlv(0x30, tlv(0x02, [0x01].concat(Array.from(r))).concat(tlv(0x02, sBody))),
    'missing s': tlv(0x30, tlv(0x02, rBody)),
    'integer overruns the sequence': tlv(0x30, [0x02, content.length].concat(rBody, tlv(0x02, sBody))),
    'over 72 bytes': [0x30, 0x81, 0x80].concat(new Array<number>(128).fill(0x01)),
    'raw r||s instead of DER': Array.from(crafted.raw),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    assert.throws(() => derToRawSignature(Uint8Array.from(bytes)), /Malformed DER signature/, name);
    assert.equal(await check(key.point, withSignature(crafted.signature, bytes), challenge), false, name);
  }
  assert.throws(() => derToRawSignature(valid as unknown as Uint8Array), /Malformed DER signature/);
});

test('DER length, minimality and structure rules reject fixed encodings deterministically', async () => {
  const bytesOf = (value: string): Uint8Array => fromHex(value.replace(/ /g, ''));
  const zeros = (count: number): string => '00'.repeat(count);
  assert.equal(hex(derToRawSignature(bytesOf('30 06 02 01 01 02 01 01'))), `${zeros(31)}01${zeros(31)}01`);
  assert.equal(hex(derToRawSignature(bytesOf('30 07 02 02 00 80 02 01 01'))), `${zeros(31)}80${zeros(31)}01`);
  const short: Record<string, string> = {
    'sequence: one-byte long-form length below 0x80': '30 81 06 02 01 01 02 01 01',
    'sequence: two-byte long-form length below 0x100': '30 82 00 06 02 01 01 02 01 01',
    'sequence: four-byte length': '30 84 00 00 00 06 02 01 01 02 01 01',
    'sequence: indefinite length': '30 80 02 01 01 02 01 01 00 00',
    'sequence: wrong tag': '31 06 02 01 01 02 01 01',
    'sequence: length one short': '30 05 02 01 01 02 01 01',
    'sequence: length one long': '30 07 02 01 01 02 01 01',
    'trailing byte after the sequence': '30 06 02 01 01 02 01 01 00',
    'junk after s inside the sequence': '30 07 02 01 01 02 01 01 00',
    'third integer': '30 09 02 01 01 02 01 01 02 01 01',
    'missing s': '30 03 02 01 01',
    'nested sequence in place of r': '30 08 30 03 02 01 01 02 01 01',
    'r: one-byte long-form length': '30 07 02 81 01 01 02 01 01',
    'r: two-byte long-form length': '30 08 02 82 00 01 01 02 01 01',
    's: one-byte long-form length': '30 07 02 01 01 02 81 01 01',
    'r: zero pad before a byte below 0x80': '30 07 02 02 00 01 02 01 01',
    's: zero pad before a byte below 0x80': '30 07 02 01 01 02 02 00 01',
    'r: double sign pad': '30 08 02 03 00 00 80 02 01 01',
    'r: negative': '30 06 02 01 80 02 01 01',
    's: negative': '30 06 02 01 01 02 01 ff',
    'r: zero': '30 06 02 01 00 02 01 01',
    'r: empty': '30 05 02 00 02 01 01',
    'r: length past the sequence': '30 06 02 07 01 02 01 01',
    'r: wrong tag': '30 06 03 01 01 02 01 01',
    'r: 33 significant bytes': `30 26 02 21 01${zeros(32)} 02 01 01`,
    'r: 33 significant bytes behind a sign pad': `30 27 02 22 00 80${zeros(32)} 02 01 01`,
  };
  for (const [name, value] of Object.entries(short)) {
    assert.ok(bytesOf(value).length <= 72, name);
    assert.throws(() => derToRawSignature(bytesOf(value)), /Malformed DER signature/, name);
  }
  // Fixed vector B is a valid signature with no sign pads (r starts 0x7f, s is 31 bytes): its non-minimal
  // re-encodings are numerically valid, fit under the 72-byte cap, and must be rejected by the rules alone.
  const vector = FIXED.vectors[1];
  const der = unb64(vector.signature);
  const r = hex(der.subarray(4, 36));
  const s = hex(der.subarray(38));
  assert.equal(hex(der), `30430220${r}021f${s}`);
  assert.ok(r.startsWith('7f') && s.length === 62 && !s.startsWith('00'));
  const signature: PasskeySignature = { authenticatorData: vector.authenticatorData, clientDataJSON: vector.clientDataJSON, signature: vector.signature };
  const options = { rpId: FIXED.rpId, origins: [FIXED.origin] };
  const challenge = fromHex(vector.challenge);
  assert.equal(await check(FIXED.publicKey, signature, challenge, options), true);
  const reencoded: Record<string, string> = {
    'sequence: one-byte long-form length': `3081430220${r}021f${s}`,
    'sequence: two-byte long-form length': `308200430220${r}021f${s}`,
    'sequence: indefinite length': `30800220${r}021f${s}0000`,
    'r: one-byte long-form length': `3044028120${r}021f${s}`,
    's: one-byte long-form length': `30440220${r}02811f${s}`,
    'r: zero pad before 0x7f': `3044022100${r}021f${s}`,
    's: zero pad before a byte below 0x80': `30440220${r}022000${s}`,
    'trailing byte after the sequence': `30430220${r}021f${s}00`,
    'junk after s inside the sequence': `30440220${r}021f${s}00`,
  };
  for (const [name, value] of Object.entries(reencoded)) {
    const bytes = bytesOf(value);
    assert.ok(bytes.length <= 72, name);
    assert.throws(() => derToRawSignature(bytes), /Malformed DER signature/, name);
    assert.equal(await check(FIXED.publicKey, { ...signature, signature: b64(bytes) }, challenge, options), false, name);
  }
});
