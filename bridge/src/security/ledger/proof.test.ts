import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateAuthKey, parseAuthProof, signAuthProof, verifyAuthProof, type AuthProof } from './proof.js';
import type { LedgerCheckpoint } from './protocol.js';

const ACCOUNT = 'acct-1';
const DEVICE_ID = 'device-1';
const BRIDGE_ID = 'bridge-1';
const AUD = 'https://ftown.example';
const check = (cp: LedgerCheckpoint, proof: AuthProof, purpose: 'session' | 'relay' = proof.purpose, audience = AUD) =>
  verifyAuthProof(cp, proof, { audience, purpose });
const NONCE = 'AAECAwQFBgcICQoLDA0ODw';

async function setup() {
  const device = await generateAuthKey(false);
  const bridge = await generateAuthKey(false);
  const other = await generateAuthKey(false);
  const endpoint = (id: string, kind: 'browser' | 'bridge') => ({ id, kind, ownerId: ACCOUNT, publicKey: 'x' }) as never;
  const checkpoint: LedgerCheckpoint = {
    version: 2, accountId: ACCOUNT, revision: 3, head: 'h', authorities: [],
    devices: [{ endpoint: endpoint(DEVICE_ID, 'browser'), authPublicKey: device.publicKey, label: 'd', approvedAt: 1 }],
    bridges: [{ bridgeId: BRIDGE_ID, endpoint: endpoint('be', 'bridge'), authPublicKey: bridge.publicKey, label: 'b', approvedAt: 1 }],
    revokedDeviceIds: [], revokedBridgeIds: [],
  };
  const fields = { accountId: ACCOUNT, kind: 'device' as const, keyId: DEVICE_ID, nonce: NONCE, purpose: 'session' as const, audience: AUD };
  return { device, bridge, other, checkpoint, fields };
}

test('valid device proof verifies', async () => {
  const { device, checkpoint, fields } = await setup();
  assert.equal(await check(checkpoint, await signAuthProof(device.privateKey, fields)), true);
});

test('valid bridge proof verifies', async () => {
  const { bridge, checkpoint, fields } = await setup();
  const proof = await signAuthProof(bridge.privateKey, { ...fields, kind: 'bridge', keyId: BRIDGE_ID, purpose: 'relay' });
  assert.equal(await check(checkpoint, proof), true);
});

test('wrong accountId fails', async () => {
  const { device, checkpoint, fields } = await setup();
  const proof = await signAuthProof(device.privateKey, { ...fields, accountId: 'acct-2' });
  assert.equal(await check(checkpoint, proof), false);
});

test('unknown keyId fails', async () => {
  const { device, checkpoint, fields } = await setup();
  assert.equal(await check(checkpoint, await signAuthProof(device.privateKey, { ...fields, keyId: 'nope' })), false);
});

test('revoked keyId fails even when still listed', async () => {
  const { device, bridge, checkpoint, fields } = await setup();
  const dp = await signAuthProof(device.privateKey, fields);
  const bp = await signAuthProof(bridge.privateKey, { ...fields, kind: 'bridge', keyId: BRIDGE_ID, purpose: 'relay' });
  assert.equal(await check(checkpoint, dp), true);
  assert.equal(await check(checkpoint, bp), true);
  const revoked = { ...checkpoint, revokedDeviceIds: [DEVICE_ID], revokedBridgeIds: [BRIDGE_ID] };
  assert.equal(await check(revoked, dp), false);
  assert.equal(await check(revoked, bp), false);
});

test('kind mismatch fails', async () => {
  const { device, checkpoint, fields } = await setup();
  const proof = await signAuthProof(device.privateKey, { ...fields, kind: 'bridge', purpose: 'relay' });
  assert.equal(await check(checkpoint, proof), false);
  const asBridgeId = await signAuthProof(device.privateKey, { ...fields, kind: 'bridge', keyId: BRIDGE_ID, purpose: 'relay' });
  assert.equal(await check(checkpoint, asBridgeId), false);
});

test('purpose changed after signing fails', async () => {
  const { device, checkpoint, fields } = await setup();
  const proof = await signAuthProof(device.privateKey, fields);
  assert.equal(await check(checkpoint, { ...proof, purpose: 'relay' }, 'session'), false);
});

test('nonce changed after signing fails', async () => {
  const { device, checkpoint, fields } = await setup();
  const proof = await signAuthProof(device.privateKey, fields);
  assert.equal(await check(checkpoint, { ...proof, nonce: 'AAECAwQFBgcICQoLDA0ODA' }), false);
});

test('signature from another key fails', async () => {
  const { other, checkpoint, fields } = await setup();
  assert.equal(await check(checkpoint, await signAuthProof(other.privateKey, fields)), false);
});

test('malformed signature fails without throwing', async () => {
  const { device, checkpoint, fields } = await setup();
  const proof = await signAuthProof(device.privateKey, fields);
  for (const signature of ['', '!!!', 'AAAA', proof.signature.slice(0, -4), proof.signature + 'AAAA']) {
    assert.equal(await check(checkpoint, { ...proof, signature }), false);
  }
});

test('malformed public key in checkpoint fails without throwing', async () => {
  const { device, checkpoint, fields } = await setup();
  const proof = await signAuthProof(device.privateKey, fields);
  for (const authPublicKey of ['', '***', 'AAAA']) {
    const broken = { ...checkpoint, devices: [{ ...checkpoint.devices[0], authPublicKey }] };
    assert.equal(await check(broken, proof), false);
  }
});

test('extra key on proof fails', async () => {
  const { device, checkpoint, fields } = await setup();
  const proof = await signAuthProof(device.privateKey, fields);
  assert.equal(await check(checkpoint, { ...proof, extra: 1 } as AuthProof), false);
  assert.equal(parseAuthProof({ ...proof, extra: 1 }), null);
});

test('empty nonce fails', async () => {
  const { device, checkpoint, fields } = await setup();
  assert.equal(await check(checkpoint, await signAuthProof(device.privateKey, { ...fields, nonce: '' })), false);
});

test('oversized nonce fails, 128 chars passes', async () => {
  const { device, checkpoint, fields } = await setup();
  const ok = await signAuthProof(device.privateKey, { ...fields, nonce: 'A'.repeat(128) });
  assert.equal(await check(checkpoint, ok), true);
  const big = await signAuthProof(device.privateKey, { ...fields, nonce: 'A'.repeat(129) });
  assert.equal(await check(checkpoint, big), false);
});

test('invalid purpose and non-base64url nonce fail', async () => {
  const { device, checkpoint, fields } = await setup();
  const badPurpose = await signAuthProof(device.privateKey, { ...fields, purpose: 'admin' as never });
  assert.equal(await check(checkpoint, badPurpose), false);
  const badNonce = await signAuthProof(device.privateKey, { ...fields, nonce: 'not base64!' });
  assert.equal(await check(checkpoint, badNonce), false);
});

test('parseAuthProof rejects bad shapes', () => {
  assert.equal(parseAuthProof(null), null);
  assert.equal(parseAuthProof([]), null);
  assert.equal(parseAuthProof({}), null);
  assert.equal(parseAuthProof({ accountId: 'a', kind: 'x', keyId: 'k', nonce: 'AA', purpose: 'session', signature: 'AA' }), null);
});

test('non-extractable key cannot be exported; extractable can', async () => {
  const locked = await generateAuthKey(false);
  assert.equal(locked.privateKey.extractable, false);
  assert.deepEqual(locked.privateKey.usages, ['sign']);
  await assert.rejects(crypto.subtle.exportKey('pkcs8', locked.privateKey));
  const open = await generateAuthKey(true);
  assert.equal(open.privateKey.extractable, true);
  assert.ok((await crypto.subtle.exportKey('pkcs8', open.privateKey)).byteLength > 0);
});

test('public key is a base64url 65-byte point', async () => {
  const { publicKey } = await generateAuthKey(false);
  assert.match(publicKey, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(publicKey, 'base64url').length, 65);
});

const N = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
const toBytes = (v: bigint) => Uint8Array.from(Buffer.from(v.toString(16).padStart(64, '0'), 'hex'));

test('audience mismatch fails', async () => {
  const { device, checkpoint, fields } = await setup();
  const proof = await signAuthProof(device.privateKey, fields);
  assert.equal(await check(checkpoint, proof, 'session', 'https://evil.example'), false);
});

test('audience changed after signing fails', async () => {
  const { device, checkpoint, fields } = await setup();
  const proof = await signAuthProof(device.privateKey, fields);
  assert.equal(await check(checkpoint, { ...proof, audience: 'https://evil.example' }, 'session', 'https://evil.example'), false);
});

test('malformed audience is rejected', async () => {
  const { device, checkpoint, fields } = await setup();
  for (const audience of ['https://ftown.example/path', 'http://ftown.example', 'https://ftown.example/', 'ftp://x.example', '', 'https://' + 'a'.repeat(260) + '.com']) {
    const proof = await signAuthProof(device.privateKey, { ...fields, audience });
    assert.equal(await check(checkpoint, proof, 'session', audience), false, audience);
    assert.equal(parseAuthProof(proof), null, audience);
  }
  for (const audience of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://[::1]:3000']) {
    const proof = await signAuthProof(device.privateKey, { ...fields, audience });
    assert.equal(await check(checkpoint, proof, 'session', audience), true, audience);
  }
});

test('purpose expectation must match', async () => {
  const { device, checkpoint, fields } = await setup();
  const proof = await signAuthProof(device.privateKey, fields);
  assert.equal(await check(checkpoint, proof, 'relay'), false);
});

test('bridge key never valid for session', async () => {
  const { bridge, checkpoint, fields } = await setup();
  const proof = await signAuthProof(bridge.privateKey, { ...fields, kind: 'bridge', keyId: BRIDGE_ID, purpose: 'session' });
  assert.equal(await check(checkpoint, proof), false);
});

test('keyId swapped to another listed device fails', async () => {
  const { device, checkpoint, fields } = await setup();
  const second = await generateAuthKey(false);
  const cp = { ...checkpoint, devices: [...checkpoint.devices, { ...checkpoint.devices[0], endpoint: { ...checkpoint.devices[0].endpoint, id: 'device-2' }, authPublicKey: second.publicKey }] };
  const proof = await signAuthProof(device.privateKey, fields);
  assert.equal(await check(cp, proof), true);
  assert.equal(await check(cp, { ...proof, keyId: 'device-2' }), false);
});

test('signAuthProof emits low-S; high-S variant fails', async () => {
  const { device, checkpoint, fields } = await setup();
  for (let i = 0; i < 20; i++) {
    const proof = await signAuthProof(device.privateKey, { ...fields, nonce: 'n' + i });
    const raw = Buffer.from(proof.signature, 'base64url');
    const s = BigInt('0x' + raw.subarray(32).toString('hex'));
    assert.ok(s <= N / BigInt(2));
    assert.equal(await check(checkpoint, proof), true);
    const high = Buffer.concat([raw.subarray(0, 32), toBytes(N - s)]).toString('base64url');
    assert.equal(await check(checkpoint, { ...proof, signature: high }), false);
  }
});

test('non-canonical base64url signature fails', async () => {
  const { device, checkpoint, fields } = await setup();
  const proof = await signAuthProof(device.privateKey, fields);
  const last = proof.signature[85];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const idx = alphabet.indexOf(last);
  const alt = alphabet[idx ^ 1];
  assert.equal(await check(checkpoint, { ...proof, signature: proof.signature.slice(0, 85) + alt }), false);
});

test('hostile inputs never throw', async () => {
  const { device, checkpoint, fields } = await setup();
  const proof = await signAuthProof(device.privateKey, fields);
  const getter = { ...proof };
  Object.defineProperty(getter, 'nonce', { enumerable: true, get() { throw new Error('boom'); } });
  const proxy = new Proxy({}, { ownKeys() { throw new Error('boom'); }, get() { throw new Error('boom'); }, getPrototypeOf() { throw new Error('boom'); } });
  const proto = JSON.parse(JSON.stringify(proof).replace('"nonce"', '"__proto__"'));
  for (const bad of [getter, proxy, proto, null, 5, 'x', []]) {
    assert.equal(parseAuthProof(bad), null);
    assert.equal(await check(checkpoint, bad as AuthProof, 'session'), false);
  }
  const hostileCp = new Proxy(checkpoint, { get() { throw new Error('boom'); } });
  assert.equal(await check(hostileCp, proof), false);
});

test('oversized signature is rejected quickly', async () => {
  const { device, checkpoint, fields } = await setup();
  const proof = await signAuthProof(device.privateKey, fields);
  const started = Date.now();
  assert.equal(await check(checkpoint, { ...proof, signature: 'A'.repeat(10_000_000) }), false);
  assert.ok(Date.now() - started < 200);
  assert.equal(await check(checkpoint, { ...proof, accountId: 'a'.repeat(65) }), false);
  assert.equal(await check(checkpoint, { ...proof, keyId: 'k'.repeat(129) }), false);
});
