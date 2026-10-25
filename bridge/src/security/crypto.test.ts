import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import {
  generateEndpoint, importEndpoint, exportPublicKey, importPublicKey, seal, open,
  parseSecureEnvelope, parseSecurePublication, SecurityError, MAX_ENVELOPE_BYTES,
} from './crypto.js';
import type { EndpointIdentity, EnvelopeHeader, OpenContext, SecureEnvelope } from './protocol.js';

const ownerId = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
const otherOwner = '619f68a6-77c1-49f6-ae2d-c5fa169d284b';
const encode = new TextEncoder();
const decode = new TextDecoder();
const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64url');
const raw = (data: string) => Uint8Array.from(Buffer.from(data, 'base64url'));
const hex = (data: string) => Uint8Array.from(Buffer.from(data, 'hex'));
const makeSuite = () => new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
function makeHeader(sender: EndpointIdentity, recipient: EndpointIdentity): EnvelopeHeader {
  return {
    type: 'ftown_encrypted', version: 1, senderId: sender.endpoint.id, recipientId: recipient.endpoint.id,
    ownerId, bridgeId: 'bridge-a', channel: 'cloud:commands:rpc#owner@example.test',
    purpose: 'application', messageId: crypto.randomUUID(), createdAt: 1000, expiresAt: 2000,
    receiverEpoch: 'random-receiver-boot-epoch',
  };
}
const context = (header: EnvelopeHeader): OpenContext => ({
  ownerId: header.ownerId, bridgeId: header.bridgeId, channel: header.channel,
  recipientId: header.recipientId, purpose: header.purpose,
});
const safeError = (error: unknown) => error instanceof SecurityError && typeof error.code === 'string' && !error.message.includes('sensitive');
async function fixture() {
  const sender = await generateEndpoint(ownerId, 'browser');
  const recipient = await generateEndpoint(ownerId, 'bridge');
  const header = makeHeader(sender, recipient);
  const envelope = await seal(sender, recipient.endpoint, header, encode.encode('sensitive content 🔐'));
  return { sender, recipient, header, envelope };
}

test('HPKE Auth decrypts the published RFC9180 P-256/HKDF-SHA256/AES-256-GCM vector', async () => {
  // https://github.com/cfrg/draft-irtf-cfrg-hpke/blob/master/test-vectors.json
  // mode=2, kem_id=16, kdf_id=1, aead_id=2; first encryption (Count-0).
  const suite = makeSuite();
  const recipientKey = {
    privateKey: await suite.kem.deserializePrivateKey(hex('d9f10996a02cd6c9dbda1d1f225f18f781ea3c893b8c2a6cb2e266e59f3cd9a9')),
    publicKey: await suite.kem.deserializePublicKey(hex('04cd38ef80923e26f157e06c9887f80177c97e1005a41104127271237f946df22eda13d40801bce6184f1a631c44b0807a1a5e8d039975ed0f6079fcbd2dfe6652')),
  };
  const senderPublicKey = await suite.kem.deserializePublicKey(hex('04ece9b48cc98ee03ba742fe1218a3fbec960cc34b6e1defdcd3285276f39028e95b90f9526607565888766a1101f429dc3ec87364b5c8c613f0a081881950427f'));
  const receiver = await suite.createRecipientContext({
    recipientKey, senderPublicKey,
    info: hex('4f6465206f6e2061204772656369616e2055726e'),
    enc: hex('04a7aeac79fda402674ef247c12d6f5fdfd21498d896b67ff04ec181382d4516b7662be32b4a2ae817c2d57104ecb6fcaa527438939810612d1b3d0af36ffc66ce'),
  });
  const plaintext = await receiver.open(hex('59b9890aabf94c1d502c39d8d356989ab0880ed43e984255db7b32a8d7b0ad5beba799a4ec326a0ddca3dd5e5d'), hex('436f756e742d30'));
  assert.equal(Buffer.from(plaintext).toString('hex'), '4265617574792069732074727574682c20747275746820626561757479');
});

test('default endpoint keys are non-extractable and HPKE Auth works in both directions', async () => {
  const { sender, recipient, header, envelope } = await fixture();
  assert.equal(sender.keyPair.privateKey.extractable, false);
  assert.equal(recipient.keyPair.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('jwk', sender.keyPair.privateKey));
  assert.equal(sender.endpoint.id.length, 43);
  assert.equal(raw(sender.endpoint.publicKey).length, 65);
  assert.equal(await exportPublicKey(await importPublicKey(sender.endpoint.publicKey)), sender.endpoint.publicKey);
  assert.equal(decode.decode(await open(recipient, sender.endpoint, envelope, context(header))), 'sensitive content 🔐');
  const replyHeader = { ...makeHeader(recipient, sender), purpose: 'welcome' as const, receiverEpoch: null };
  const reply = await seal(recipient, sender.endpoint, replyHeader, new Uint8Array());
  assert.equal((await open(sender, recipient.endpoint, reply, context(replyHeader))).length, 0);
});

test('fresh contexts create distinct encapsulations and a different authenticated sender cannot decrypt', async () => {
  const { sender, recipient, header, envelope } = await fixture();
  const again = await seal(sender, recipient.endpoint, header, encode.encode('sensitive content 🔐'));
  assert.notEqual(again.enc, envelope.enc);
  assert.notEqual(again.ciphertext, envelope.ciphertext);
  const impostor = await generateEndpoint(ownerId, 'browser');
  await assert.rejects(open(recipient, impostor.endpoint, envelope, context(header)), safeError);
  await assert.rejects(open(impostor, sender.endpoint, envelope, context(header)), safeError);
});

test('every ordered header field is authenticated, independently of expected routing checks', async () => {
  const { sender, recipient, header, envelope } = await fixture();
  const another = await generateEndpoint(ownerId, 'browser');
  const changes: Partial<SecureEnvelope>[] = [
    { senderId: another.endpoint.id }, { recipientId: another.endpoint.id },
    { ownerId: otherOwner }, { bridgeId: 'bridge-b' }, { channel: 'local-http:bridge-a' },
    { purpose: 'hello' }, { messageId: 'different-message-id' }, { createdAt: 1001 },
    { expiresAt: 2001 }, { receiverEpoch: null },
  ];
  for (const change of changes) {
    const changed = { ...envelope, ...change };
    await assert.rejects(open(recipient, sender.endpoint, changed, context(changed)), safeError);
  }
  assert.equal(decode.decode(await open(recipient, sender.endpoint, envelope, context(header))), 'sensitive content 🔐');
});

test('tampered encapsulation and ciphertext fail without disclosing input or implementation errors', async () => {
  const { sender, recipient, header, envelope } = await fixture();
  for (const field of ['enc', 'ciphertext'] as const) {
    const value = raw(envelope[field]);
    value[value.length - 1] ^= 1;
    await assert.rejects(open(recipient, sender.endpoint, { ...envelope, [field]: b64(value) }, context(header)), safeError);
  }
});

test('transport-derived owner, bridge, channel, recipient and purpose must match', async () => {
  const { sender, recipient, header, envelope } = await fixture();
  const changes: Partial<OpenContext>[] = [
    { ownerId: otherOwner }, { bridgeId: 'other' }, { channel: 'local-events:bridge-a' },
    { recipientId: sender.endpoint.id }, { purpose: 'enroll' },
  ];
  for (const change of changes) await assert.rejects(open(recipient, sender.endpoint, envelope, { ...context(header), ...change }), { code: 'wrong_context' });
});

test('strict decoding rejects unknown fields, versions, lengths, times and noncanonical encodings', async () => {
  const { envelope } = await fixture();
  const cases: unknown[] = [
    null, [], { ...envelope, extra: true }, { ...envelope, version: 2 },
    { ...envelope, type: 'plaintext' }, { ...envelope, purpose: 'other' },
    { ...envelope, senderId: 'short' }, { ...envelope, ownerId: 'owner@example.test' },
    { ...envelope, bridgeId: '../bridge' }, { ...envelope, channel: 'channel\nsecret' },
    { ...envelope, channel: 'x'.repeat(513) }, { ...envelope, messageId: '' },
    { ...envelope, createdAt: NaN }, { ...envelope, createdAt: -1 },
    { ...envelope, createdAt: 1.1 }, { ...envelope, expiresAt: 999 },
    { ...envelope, expiresAt: Number.MAX_SAFE_INTEGER + 1 }, { ...envelope, receiverEpoch: {} },
    { ...envelope, enc: envelope.enc + '=' }, { ...envelope, ciphertext: '' },
    { ...envelope, ciphertext: 'a'.repeat(MAX_ENVELOPE_BYTES) },
    { ...envelope, ciphertext: b64(new Uint8Array(15)) },
  ];
  for (const value of cases) assert.throws(() => parseSecureEnvelope(value), { code: 'invalid_envelope' });
  const reordered = Object.fromEntries(Object.entries(envelope).reverse());
  assert.deepEqual(parseSecureEnvelope(reordered), envelope);
});

test('public key decoding verifies canonical point format and fingerprint binding', async () => {
  const { sender, recipient, header } = await fixture();
  for (const value of ['', 'not-a-key', sender.endpoint.publicKey + '=', b64(new Uint8Array(65))]) {
    await assert.rejects(importPublicKey(value), safeError);
  }
  await assert.rejects(seal(sender, { ...recipient.endpoint, id: sender.endpoint.id }, header, encode.encode('x')), safeError);
  await assert.rejects(seal(sender, { ...recipient.endpoint, ownerId: otherOwner }, header, encode.encode('x')), safeError);
});

test('imported persistent identities preserve their pinned public identity and become non-extractable', async () => {
  const persistent = await generateEndpoint(ownerId, 'mcp', true);
  const jwk = await crypto.subtle.exportKey('jwk', persistent.keyPair.privateKey);
  const imported = await importEndpoint(persistent.endpoint, jwk);
  assert.deepEqual(imported.endpoint, persistent.endpoint);
  assert.equal(imported.keyPair.privateKey.extractable, false);
  const bridge = await generateEndpoint(ownerId, 'bridge');
  const h = makeHeader(imported, bridge);
  const packet = await seal(imported, bridge.endpoint, h, encode.encode('restored'));
  assert.equal(decode.decode(await open(bridge, imported.endpoint, packet, context(h))), 'restored');
  const other = await generateEndpoint(ownerId, 'mcp', true);
  const otherJwk = await crypto.subtle.exportKey('jwk', other.keyPair.privateKey);
  await assert.rejects(importEndpoint(persistent.endpoint, otherJwk), safeError);
  await assert.rejects(importEndpoint(persistent.endpoint, { ...jwk, d: otherJwk.d }), safeError);
});

test('neutral framing interoperates with a separately constructed standards HPKE recipient', async () => {
  const { sender, recipient, header, envelope } = await fixture();
  const independent = await makeSuite().createRecipientContext({
    recipientKey: recipient.keyPair, senderPublicKey: sender.keyPair.publicKey,
    enc: raw(envelope.enc), info: encode.encode('ftown/e2ee/v1'),
  });
  const aad = encode.encode(JSON.stringify([
    'ftown/e2ee/v1', header.type, header.version, header.senderId, header.recipientId,
    header.ownerId, header.bridgeId, header.channel, header.purpose, header.messageId,
    header.createdAt, header.expiresAt, header.receiverEpoch,
  ]));
  assert.equal(decode.decode(await independent.open(raw(envelope.ciphertext), aad)), 'sensitive content 🔐');
});

test('oversized plaintext and batches reject before transport and ciphertext is never truncated', async () => {
  const { sender, recipient, header, envelope } = await fixture();
  await assert.rejects(seal(sender, recipient.endpoint, header, new Uint8Array(MAX_ENVELOPE_BYTES)), { code: 'capacity_exceeded' });
  const publication = { type: 'ftown_encrypted_batch', version: 1, envelopes: [envelope] };
  assert.deepEqual(parseSecurePublication(publication).envelopes, [envelope]);
  for (const value of [
    { ...publication, extra: true }, { ...publication, version: 2 },
    { ...publication, envelopes: [] }, { ...publication, envelopes: Array(101).fill(envelope) },
    { ...publication, envelopes: [{ ...envelope, ciphertext: 'A'.repeat(MAX_ENVELOPE_BYTES) }] },
  ]) assert.throws(() => parseSecurePublication(value), { code: 'invalid_envelope' });
  const large = await seal(sender, recipient.endpoint, header, new Uint8Array(250_000));
  assert.equal((await open(recipient, sender.endpoint, large, context(header))).length, 250_000);
  assert.throws(() => parseSecurePublication({ ...publication, envelopes: [large, large] }), { code: 'invalid_envelope' });
});

test('core preserves authenticated history timestamps; endpoint adapters own replay, epoch and expiry admission', async () => {
  const { sender, recipient, header, envelope } = await fixture();
  assert.ok(header.expiresAt < Date.now());
  assert.equal(decode.decode(await open(recipient, sender.endpoint, envelope, context(header))), 'sensitive content 🔐');
  // Replaying decode is safe only because this primitive never executes application handlers.
  assert.equal(decode.decode(await open(recipient, sender.endpoint, envelope, context(header))), 'sensitive content 🔐');
});
