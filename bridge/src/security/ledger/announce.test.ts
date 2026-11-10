import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  HEAD_ANNOUNCE_DOMAIN, HEAD_ANNOUNCE_MAX_AGE_MS, parseHeadAnnouncement, signHeadAnnouncement, verifyHeadAnnouncement, type HeadAnnouncement,
} from './announce.js';
import { generateAuthKey, signAuthProof, signDomain, verifyAuthProof, verifyDomain, type AuthProof } from './proof.js';
import type { LedgerCheckpoint } from './protocol.js';

const id = (): string => randomBytes(32).toString('base64url');
const ACCOUNT = id();
const DEVICE = id();
const BRIDGE = 'studio';
const HEAD = id();
const NOW = 1_750_000_000_000;
const N = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
const toBytes = (v: bigint) => Uint8Array.from(Buffer.from(v.toString(16).padStart(64, '0'), 'hex'));

async function setup() {
  const device = await generateAuthKey(false);
  const bridge = await generateAuthKey(false);
  const other = await generateAuthKey(false);
  const endpoint = (endpointId: string) => ({ id: endpointId }) as never;
  const checkpoint: LedgerCheckpoint = {
    version: 2, accountId: ACCOUNT, revision: 3, head: HEAD, authorities: [],
    devices: [{ endpoint: endpoint(DEVICE), authPublicKey: device.publicKey, label: 'Laptop', approvedAt: 1 }],
    bridges: [{ bridgeId: BRIDGE, endpoint: endpoint(id()), authPublicKey: bridge.publicKey, label: 'Studio', approvedAt: 1 }],
    revokedDeviceIds: [], revokedBridgeIds: [],
  };
  const deviceFields = { accountId: ACCOUNT, kind: 'device' as const, keyId: DEVICE, head: HEAD, revision: 3, at: NOW };
  const bridgeFields = { ...deviceFields, kind: 'bridge' as const, keyId: BRIDGE };
  return { device, bridge, other, checkpoint, deviceFields, bridgeFields };
}

test('constants are the wire contract', () => {
  assert.equal(HEAD_ANNOUNCE_DOMAIN, 'ftown-head-announce-v1\n');
  assert.equal(HEAD_ANNOUNCE_MAX_AGE_MS, 120_000);
});

test('device and bridge announcements round trip, with exactly the nine keys', async () => {
  const { device, bridge, checkpoint, deviceFields, bridgeFields } = await setup();
  for (const [key, fields] of [[device, deviceFields], [bridge, bridgeFields]] as const) {
    const announcement = await signHeadAnnouncement(key.privateKey, fields);
    assert.deepEqual(Object.keys(announcement).sort(), ['accountId', 'at', 'head', 'keyId', 'kind', 'revision', 'signature', 'type', 'version']);
    assert.equal(announcement.type, 'ledger_head');
    assert.equal(announcement.version, 1);
    assert.deepEqual(parseHeadAnnouncement(JSON.parse(JSON.stringify(announcement))), announcement);
    assert.equal(await verifyHeadAnnouncement(checkpoint, announcement, NOW), true);
  }
});

test('the signature covers exactly HEAD_ANNOUNCE_DOMAIN + JSON of the six fields in key order', async () => {
  const { device, deviceFields } = await setup();
  const announcement = await signHeadAnnouncement(device.privateKey, deviceFields);
  const { accountId, at, head, keyId, kind, revision } = announcement;
  const exact = new TextEncoder().encode(HEAD_ANNOUNCE_DOMAIN + JSON.stringify({ accountId, at, head, keyId, kind, revision }));
  assert.equal(await verifyDomain(device.publicKey, announcement.signature, exact), true);
  // The domain is part of the signed bytes: the same JSON without it, or reordered keys, is not what was signed.
  assert.equal(await verifyDomain(device.publicKey, announcement.signature, new TextEncoder().encode(JSON.stringify({ accountId, at, head, keyId, kind, revision }))), false);
  assert.equal(await verifyDomain(device.publicKey, announcement.signature, new TextEncoder().encode(HEAD_ANNOUNCE_DOMAIN + JSON.stringify({ kind, keyId, accountId, at, head, revision }))), false);
});

test('a signature over the fields without the domain is not an announcement', async () => {
  const { device, checkpoint, deviceFields } = await setup();
  const announcement = await signHeadAnnouncement(device.privateKey, deviceFields);
  const { accountId, at, head, keyId, kind, revision } = deviceFields;
  const undomained = await signDomain(device.privateKey, new TextEncoder().encode(JSON.stringify({ accountId, at, head, keyId, kind, revision })));
  assert.equal(await verifyHeadAnnouncement(checkpoint, { ...announcement, signature: undomained }, NOW), false);
});

test('every field changed after signing fails', async () => {
  const { device, bridge, checkpoint, deviceFields } = await setup();
  const announcement = await signHeadAnnouncement(device.privateKey, deviceFields);
  const otherSignature = (await signHeadAnnouncement(device.privateKey, { ...deviceFields, revision: 4 })).signature;
  const tampered: HeadAnnouncement[] = [
    { ...announcement, accountId: id() }, { ...announcement, head: id() }, { ...announcement, revision: 4 }, { ...announcement, revision: 2 },
    { ...announcement, at: NOW + 1 }, { ...announcement, keyId: id() }, { ...announcement, signature: otherSignature },
    // Same key listed as a bridge too would still not match: kind is signed.
    { ...announcement, kind: 'bridge', keyId: BRIDGE },
    { ...announcement, type: 'ledger' as never }, { ...announcement, version: 2 as never },
  ];
  const sameKey: LedgerCheckpoint = { ...checkpoint, bridges: [{ ...checkpoint.bridges[0], authPublicKey: device.publicKey }] };
  for (const bad of tampered) {
    assert.equal(await verifyHeadAnnouncement(checkpoint, bad, NOW), false, JSON.stringify(bad));
    assert.equal(await verifyHeadAnnouncement(sameKey, bad, NOW), false, JSON.stringify(bad));
  }
  assert.equal(await verifyHeadAnnouncement(sameKey, announcement, NOW), true);
  // A bridge's announcement signed with a device's key, and vice versa.
  const wrongKey = await signHeadAnnouncement(bridge.privateKey, deviceFields);
  assert.equal(await verifyHeadAnnouncement(checkpoint, wrongKey, NOW), false);
});

test('unknown member, revoked member and another account fail', async () => {
  const { device, bridge, other, checkpoint, deviceFields, bridgeFields } = await setup();
  const fromDevice = await signHeadAnnouncement(device.privateKey, deviceFields);
  const fromBridge = await signHeadAnnouncement(bridge.privateKey, bridgeFields);
  assert.equal(await verifyHeadAnnouncement(checkpoint, await signHeadAnnouncement(other.privateKey, { ...deviceFields, keyId: id() }), NOW), false);
  assert.equal(await verifyHeadAnnouncement(checkpoint, await signHeadAnnouncement(other.privateKey, { ...bridgeFields, keyId: 'laptop-bridge' }), NOW), false);
  // Revoked while still listed (sticky revocations keep the entry): refused.
  assert.equal(await verifyHeadAnnouncement({ ...checkpoint, revokedDeviceIds: [DEVICE] }, fromDevice, NOW), false);
  assert.equal(await verifyHeadAnnouncement({ ...checkpoint, revokedBridgeIds: [BRIDGE] }, fromBridge, NOW), false);
  // Removed from the roster.
  assert.equal(await verifyHeadAnnouncement({ ...checkpoint, devices: [] }, fromDevice, NOW), false);
  assert.equal(await verifyHeadAnnouncement({ ...checkpoint, bridges: [] }, fromBridge, NOW), false);
  // A revocation of the other kind's id does not matter.
  assert.equal(await verifyHeadAnnouncement({ ...checkpoint, revokedBridgeIds: [DEVICE] }, fromDevice, NOW), true);
  // Another account's checkpoint listing the same keys.
  const foreign = { ...checkpoint, accountId: id() };
  assert.equal(await verifyHeadAnnouncement(foreign, fromDevice, NOW), false);
  assert.equal(await verifyHeadAnnouncement(foreign, await signHeadAnnouncement(device.privateKey, { ...deviceFields, accountId: foreign.accountId }), NOW), true);
});

test('stale and future announcements fail exactly past HEAD_ANNOUNCE_MAX_AGE_MS', async () => {
  const { device, checkpoint, deviceFields } = await setup();
  const announcement = await signHeadAnnouncement(device.privateKey, deviceFields);
  assert.equal(await verifyHeadAnnouncement(checkpoint, announcement, NOW + HEAD_ANNOUNCE_MAX_AGE_MS), true);
  assert.equal(await verifyHeadAnnouncement(checkpoint, announcement, NOW + HEAD_ANNOUNCE_MAX_AGE_MS + 1), false);
  assert.equal(await verifyHeadAnnouncement(checkpoint, announcement, NOW - HEAD_ANNOUNCE_MAX_AGE_MS), true);
  assert.equal(await verifyHeadAnnouncement(checkpoint, announcement, NOW - HEAD_ANNOUNCE_MAX_AGE_MS - 1), false);
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1750000000000' as never]) {
    assert.equal(await verifyHeadAnnouncement(checkpoint, announcement, now), false);
  }
});

test('the high-S twin of a valid signature fails; signHeadAnnouncement emits low S', async () => {
  const { device, checkpoint, deviceFields } = await setup();
  for (let i = 0; i < 16; i++) {
    const announcement = await signHeadAnnouncement(device.privateKey, { ...deviceFields, revision: i });
    const raw = Buffer.from(announcement.signature, 'base64url');
    const s = BigInt('0x' + raw.subarray(32).toString('hex'));
    assert.ok(s <= N / BigInt(2));
    const high = Buffer.concat([raw.subarray(0, 32), toBytes(N - s)]).toString('base64url');
    assert.equal(await verifyHeadAnnouncement(checkpoint, announcement, NOW), true);
    assert.equal(await verifyHeadAnnouncement(checkpoint, { ...announcement, signature: high }, NOW), false);
  }
});

test('domain separation: an auth proof is never an announcement, and an announcement never an auth proof', async () => {
  const { device, bridge, checkpoint, deviceFields, bridgeFields } = await setup();
  const audience = 'https://ftown.example';
  // Auth proof → announcement: same signer, same accountId/kind/keyId; its signature does not verify as an announcement.
  for (const [key, fields, purpose] of [[device, deviceFields, 'session'], [bridge, bridgeFields, 'relay']] as const) {
    const proof = await signAuthProof(key.privateKey, { accountId: ACCOUNT, kind: fields.kind, keyId: fields.keyId, nonce: HEAD, purpose, audience });
    assert.equal(await verifyAuthProof(checkpoint, proof, { audience, purpose }), true);
    const announcement = await signHeadAnnouncement(key.privateKey, fields);
    assert.equal(await verifyHeadAnnouncement(checkpoint, { ...announcement, signature: proof.signature }, NOW), false);
    // Announcement → auth proof: its signature in an auth proof with the same identity (any nonce/purpose/audience) is refused.
    for (const nonce of [HEAD, 'AAECAwQFBgcICQoLDA0ODw']) {
      for (const proofPurpose of ['session', 'relay'] as const) {
        const forged: AuthProof = { accountId: ACCOUNT, kind: fields.kind, keyId: fields.keyId, nonce, purpose: proofPurpose, audience, signature: announcement.signature };
        assert.equal(await verifyAuthProof(checkpoint, forged, { audience, purpose: proofPurpose }), false);
      }
    }
    // An announcement object itself is not an auth proof shape.
    assert.equal(await verifyAuthProof(checkpoint, announcement as unknown as AuthProof, { audience, purpose }), false);
  }
});

test('parseHeadAnnouncement is strict about keys, literals, encodings and integers', async () => {
  const { device, deviceFields } = await setup();
  const good = await signHeadAnnouncement(device.privateKey, deviceFields);
  const { signature: _signature, ...unsigned } = good;
  const stray43 = HEAD.slice(0, 42) + (HEAD[42] === 'B' ? 'C' : 'B');
  const bad: unknown[] = [
    null, undefined, 5, 'x', [], [good], {},
    { ...good, extra: 1 }, unsigned, { ...good, type: 'ledger' }, { ...good, type: undefined }, { ...good, version: '1' }, { ...good, version: 2 },
    { ...good, accountId: ACCOUNT.slice(0, 42) }, { ...good, accountId: ACCOUNT + 'A' }, { ...good, accountId: stray43 }, { ...good, accountId: 5 },
    { ...good, head: stray43 }, { ...good, head: HEAD.slice(0, 42) + '=' }, { ...good, head: HEAD.replace(/./, '+') }, { ...good, head: null },
    { ...good, kind: 'browser' }, { ...good, kind: 'local-cli' }, { ...good, kind: null },
    { ...good, keyId: 'studio' }, { ...good, keyId: DEVICE.slice(1) }, { ...good, kind: 'bridge', keyId: '' }, { ...good, kind: 'bridge', keyId: 'a'.repeat(201) },
    { ...good, kind: 'bridge', keyId: 'stu dio' }, { ...good, kind: 'bridge', keyId: 'studio#x' }, { ...good, keyId: 7 },
    { ...good, revision: -1 }, { ...good, revision: 1025 }, { ...good, revision: 1.5 }, { ...good, revision: '3' }, { ...good, revision: Number.NaN },
    { ...good, at: -1 }, { ...good, at: 1.5 }, { ...good, at: 2 ** 53 }, { ...good, at: String(NOW) }, { ...good, at: null },
    { ...good, signature: good.signature.slice(0, 85) }, { ...good, signature: good.signature + 'A' }, { ...good, signature: `${good.signature.slice(0, 85)}B` },
    { ...good, signature: Buffer.from(good.signature, 'base64url').toString('base64') }, { ...good, signature: 5 },
  ];
  for (const value of bad) assert.equal(parseHeadAnnouncement(value), null, JSON.stringify(value));
  assert.deepEqual(parseHeadAnnouncement({ ...good, kind: 'bridge', keyId: 'a'.repeat(200) }), { ...good, kind: 'bridge', keyId: 'a'.repeat(200) });
  assert.deepEqual(parseHeadAnnouncement({ ...good, revision: 0 }), { ...good, revision: 0 });
  assert.deepEqual(parseHeadAnnouncement({ ...good, revision: 1024 }), { ...good, revision: 1024 });
  // The result is a fresh object with exactly the nine keys.
  const parsed = parseHeadAnnouncement(good);
  assert.notEqual(parsed, good);
  assert.deepEqual(parsed, good);
});

test('hostile inputs never throw', async () => {
  const { device, checkpoint, deviceFields } = await setup();
  const good = await signHeadAnnouncement(device.privateKey, deviceFields);
  const getter = { ...good };
  Object.defineProperty(getter, 'head', { enumerable: true, get() { throw new Error('boom'); } });
  const proxy = new Proxy({}, { ownKeys() { throw new Error('boom'); }, get() { throw new Error('boom'); }, getPrototypeOf() { throw new Error('boom'); } });
  const proto = JSON.parse(JSON.stringify(good).replace('"head"', '"__proto__"'));
  for (const value of [getter, proxy, proto, null, 5, 'x', []]) {
    assert.equal(parseHeadAnnouncement(value), null);
    assert.equal(await verifyHeadAnnouncement(checkpoint, value as HeadAnnouncement, NOW), false);
  }
  const hostileCheckpoint = new Proxy(checkpoint, { get() { throw new Error('boom'); } });
  assert.equal(await verifyHeadAnnouncement(hostileCheckpoint, good, NOW), false);
  assert.equal(await verifyHeadAnnouncement(null as never, good, NOW), false);
  const badKey = { ...checkpoint, devices: [{ ...checkpoint.devices[0], authPublicKey: 'not-a-key' }] };
  assert.equal(await verifyHeadAnnouncement(badKey, good, NOW), false);
});

test('signHeadAnnouncement refuses invalid fields and drops extra properties', async () => {
  const { device, deviceFields } = await setup();
  for (const bad of [{ ...deviceFields, revision: 1025 }, { ...deviceFields, head: 'short' }, { ...deviceFields, at: -5 }, { ...deviceFields, kind: 'browser' as never },
    { ...deviceFields, keyId: 'studio' }, { ...deviceFields, accountId: '' }]) {
    await assert.rejects(signHeadAnnouncement(device.privateKey, bad), /invalid_head_announcement/);
  }
  const withExtra = await signHeadAnnouncement(device.privateKey, { ...deviceFields, signature: 'x', type: 'other', extra: 1 } as never);
  assert.deepEqual(Object.keys(withExtra).sort(), ['accountId', 'at', 'head', 'keyId', 'kind', 'revision', 'signature', 'type', 'version']);
  assert.equal(withExtra.type, 'ledger_head');
});
