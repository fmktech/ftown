import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateEndpoint, importEndpoint, open, seal, PUBLIC_KEY_CACHE_LIMIT } from './crypto.js';
import type { EndpointIdentity, EndpointPublic, EnvelopeHeader, OpenContext } from './protocol.js';

const ownerId = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
const encoder = new TextEncoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const OPS = ['digest', 'importKey', 'exportKey', 'generateKey', 'deriveBits', 'deriveKey', 'encrypt', 'decrypt', 'sign', 'verify',
  'wrapKey', 'unwrapKey'] as const;
type Op = typeof OPS[number];
type Spied = Record<Op, (...args: unknown[]) => Promise<unknown>>;

/** Counts every WebCrypto job started on the one SubtleCrypto that both crypto.ts and @hpke/core use. */
export function spySubtle(t: TestContext) {
  const target = crypto.subtle as unknown as Spied;
  const mocks = OPS.map(op => [op, t.mock.method(target, op)] as const);
  return {
    reset: () => { for (const [, mock] of mocks) mock.mock.resetCalls(); },
    counts: () => Object.fromEntries(mocks.map(([op, mock]) => [op, mock.mock.callCount()]).filter(([, count]) => count !== 0)) as Partial<Record<Op, number>>,
    total: () => mocks.reduce((sum, [, mock]) => sum + mock.mock.callCount(), 0),
    /** Raw ECDH public key imports of exactly these bytes (HPKE's own HMAC imports are not counted). */
    publicImports: (publicKey: string) => mocks.find(([op]) => op === 'importKey')![1].mock.calls.filter(call => {
      const [format, data, algorithm] = call.arguments;
      return format === 'raw' && data instanceof Uint8Array && Buffer.from(data).toString('base64url') === publicKey
        && typeof algorithm === 'object' && algorithm !== null && 'name' in algorithm && algorithm.name === 'ECDH';
    }).length,
    restore: () => { for (const [, mock] of mocks) mock.mock.restore(); },
  };
}
function headerFor(sender: EndpointIdentity, recipient: EndpointPublic, messageId: string = crypto.randomUUID()): EnvelopeHeader {
  return { type: 'ftown_encrypted', version: 1, senderId: sender.endpoint.id, recipientId: recipient.id, ownerId, bridgeId: 'bridge-a',
    channel: 'sessions:updates#owner@example.test', purpose: 'application', messageId, createdAt: 1000, expiresAt: 121000, receiverEpoch: null };
}
const contextOf = (header: EnvelopeHeader): OpenContext => ({ ownerId: header.ownerId, bridgeId: header.bridgeId, channel: header.channel,
  recipientId: header.recipientId, purpose: header.purpose });

// Test-only key material, generated once for this file. The envelope below was captured from the seal() of origin/main (72aa29b era,
// before any caching) with the HPKE ephemeral key pair pinned to `ephemeral`, so any refactor of seal() must reproduce it exactly.
const fixed = {
  sender: { publicKey: 'BM-RtW3wyla1bkSdet6A0kaMSHFWUazquy0QTuqEIAJ2QGikkkN_ZBVBLwbps0bl6SiOvXYwpt-Xdg04FlQJlWw', id: '23fJGDo-WD-W47iFts2Ub_BQFRO5TGL3LN0pX3EmHzM',
    jwk: { kty: 'EC', crv: 'P-256', x: 'z5G1bfDKVrVuRJ163oDSRoxIcVZRrOq7LRBO6oQgAnY', y: 'QGikkkN_ZBVBLwbps0bl6SiOvXYwpt-Xdg04FlQJlWw', d: 'Uk2MYY4QnSJ1_PkKHxx7ykTwwDgX6NQMNILcO7mWM8g' } },
  recipient: { publicKey: 'BHwkq6E7c1vZ1K83VSd8J4x8RNERuJ-8aFN-pJm8tE6xAOUD4_SSVYzPGaUQ05c-ubDguIDtAB92O-VFY7HBapk', id: 'VtVRVuPWz47XIkcq5N4g8kNwJU405e-Yie3bxZU0csg',
    jwk: { kty: 'EC', crv: 'P-256', x: 'fCSroTtzW9nUrzdVJ3wnjHxE0RG4n7xoU36kmby0TrE', y: 'AOUD4_SSVYzPGaUQ05c-ubDguIDtAB92O-VFY7HBapk', d: 'Ew35eGEDhywqybdcvPWTXQ2dXG7f1wgUZ7PdwKN4UNA' } },
  ephemeral: { publicKey: 'BHCys7lCFlx4dZGqkYvjKxrriehjT4DmeRoRP2rqyj7tv8_GNEyYlqBaHv7Aku795azDE4RgSgsQhLClYJKamLY',
    jwk: { kty: 'EC', crv: 'P-256', x: 'cLKzuUIWXHh1kaqRi-MrGuuJ6GNPgOZ5GhE_aurKPu0', y: 'v8_GNEyYlqBaHv7Aku795azDE4RgSgsQhLClYJKamLY', d: 'Z0T-40J_yB21rF3Kry15yt4KeOvVnZBrdhTGFsm6Lw4' } },
  plaintext: JSON.stringify({ type: 'application', route: { kind: 'publication' }, data: { type: 'hook_event', text: 'byte identity ✓' }, mcp: null }),
  envelope: '{"type":"ftown_encrypted","version":1,"senderId":"23fJGDo-WD-W47iFts2Ub_BQFRO5TGL3LN0pX3EmHzM","recipientId":"VtVRVuPWz47XIkcq5N4g8kNwJU405e-Yie3bxZU0csg","ownerId":"349f8d2e-38e4-4d59-888d-687dcfa19e39","bridgeId":"bridge-a","channel":"sessions:updates#owner@example.test","purpose":"application","messageId":"fixed-message-id-0001","createdAt":1000,"expiresAt":121000,"receiverEpoch":null,"enc":"BHCys7lCFlx4dZGqkYvjKxrriehjT4DmeRoRP2rqyj7tv8_GNEyYlqBaHv7Aku795azDE4RgSgsQhLClYJKamLY","ciphertext":"BlUtlnmtOnZf80UBVTgMFtwV0qKpSO9hzgYuD25uFj-Rt0EpoGiQTvbVp237DcAL7Yq_0w-xTK7Pc2Zyy38gQwNYPCjHjrNX8KJ_WB-8tclwQzxMZX65HRG3h1-u37HVxTZWA7Hw2rFW_8Ytu1t2vsDuQ4vC1LMkUgqJscdGVOFTuAjOlL9njw"}',
};
const publicOf = (key: { publicKey: string; id: string }, kind: EndpointPublic['kind']): EndpointPublic =>
  ({ version: 1, id: key.id, ownerId, kind, publicKey: key.publicKey });

test('seal output is byte-identical to the pre-optimization envelope for fixed keys, header, plaintext and ephemeral key', async t => {
  const sender = await importEndpoint(publicOf(fixed.sender, 'bridge'), fixed.sender.jwk);
  const recipient = await importEndpoint(publicOf(fixed.recipient, 'browser'), fixed.recipient.jwk);
  const ephemeral = {
    privateKey: await crypto.subtle.importKey('jwk', fixed.ephemeral.jwk, ECDH, true, ['deriveBits']),
    publicKey: await crypto.subtle.importKey('raw', Buffer.from(fixed.ephemeral.publicKey, 'base64url'), ECDH, true, []),
  };
  const header = headerFor(sender, recipient.endpoint, 'fixed-message-id-0001');
  // Three seals: cold caches, warm caches, and warm again. All must reproduce the captured bytes.
  for (let round = 0; round < 3; round++) {
    const generate = t.mock.method(crypto.subtle as unknown as Spied, 'generateKey', async () => ephemeral);
    const envelope = await seal(sender, recipient.endpoint, header, encoder.encode(fixed.plaintext));
    assert.equal(generate.mock.callCount(), 1, 'exactly one ephemeral key pair per seal');
    generate.mock.restore();
    assert.equal(JSON.stringify(envelope), fixed.envelope);
    assert.equal(new TextDecoder().decode(await open(recipient, sender.endpoint, envelope, contextOf(header))), fixed.plaintext);
  }
});

test('every seal performs a fresh encapsulation: new ephemeral key, new enc and new ciphertext for the same plaintext and recipient', async t => {
  const sender = await generateEndpoint(ownerId, 'bridge');
  const recipient = await generateEndpoint(ownerId, 'browser');
  const header = headerFor(sender, recipient.endpoint);
  const spy = spySubtle(t);
  const plaintext = encoder.encode('same plaintext');
  const first = await seal(sender, recipient.endpoint, header, plaintext);
  const second = await seal(sender, recipient.endpoint, header, plaintext);
  const third = await seal(sender, recipient.endpoint, header, plaintext);
  assert.equal(spy.counts().generateKey, 3);
  spy.restore();
  assert.equal(new Set([first.enc, second.enc, third.enc]).size, 3);
  assert.equal(new Set([first.ciphertext, second.ciphertext, third.ciphertext]).size, 3);
  for (const envelope of [first, second, third]) {
    assert.equal(new TextDecoder().decode(await open(recipient, sender.endpoint, envelope, contextOf(header))), 'same plaintext');
  }
});

/** WebCrypto jobs of one seal to an already seen recipient (the steady state of a bridge publishing to its devices). */
const JOBS_PER_WARM_SEAL: { total: number; counts: Partial<Record<Op, number>> } = {
  // Was 25 (digest 2, importKey 9, exportKey 4) while both endpoint keys were hashed, imported and exported again on every seal.
  // What remains is the HPKE encapsulation itself, all of it per message: nothing below is cached.
  total: 20, counts: { importKey: 7, exportKey: 3, generateKey: 1, deriveBits: 6, encrypt: 1, sign: 2 },
};

test('WebCrypto jobs per seal', async t => {
  const sender = await generateEndpoint(ownerId, 'bridge');
  const recipient = await generateEndpoint(ownerId, 'browser');
  const plaintext = encoder.encode('x'.repeat(200));
  await seal(sender, recipient.endpoint, headerFor(sender, recipient.endpoint), plaintext);
  const spy = spySubtle(t);
  await seal(sender, recipient.endpoint, headerFor(sender, recipient.endpoint), plaintext);
  const measured = { total: spy.total(), counts: spy.counts() };
  spy.restore();
  t.diagnostic(`jobs per warm seal: ${JSON.stringify(measured)}`);
  assert.deepEqual(measured, JOBS_PER_WARM_SEAL);
});

test('a validated public key is imported once; the cache is keyed by key bytes, never by the claimed id', async t => {
  const sender = await generateEndpoint(ownerId, 'bridge');
  const recipient = await generateEndpoint(ownerId, 'browser');
  const other = await generateEndpoint(ownerId, 'browser');
  const plaintext = encoder.encode('cached handle');
  const spy = spySubtle(t);
  await seal(sender, recipient.endpoint, headerFor(sender, recipient.endpoint), plaintext);
  assert.equal(spy.publicImports(recipient.endpoint.publicKey), 1);
  assert.equal(spy.publicImports(sender.endpoint.publicKey), 1);
  assert.equal(spy.counts().digest, 2);
  await seal(sender, recipient.endpoint, headerFor(sender, recipient.endpoint), plaintext);
  await seal(sender, { ...recipient.endpoint }, headerFor(sender, recipient.endpoint), plaintext);
  assert.equal(spy.publicImports(recipient.endpoint.publicKey), 1, 'same bytes: no second import');
  assert.equal(spy.publicImports(sender.endpoint.publicKey), 1);
  assert.equal(spy.counts().digest, 2, 'same bytes: no second fingerprint');

  // A different recipient is validated and imported on its own.
  await seal(sender, other.endpoint, headerFor(sender, other.endpoint), plaintext);
  assert.equal(spy.publicImports(other.endpoint.publicKey), 1);
  assert.equal(spy.counts().digest, 3);

  // A different key under an already cached recipient id is never served the cached handle, in either direction.
  const fresh = await generateEndpoint(ownerId, 'browser');
  const swapped: EndpointPublic = { ...recipient.endpoint, publicKey: fresh.endpoint.publicKey };
  const digestsBefore = spy.counts().digest ?? 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(seal(sender, swapped, headerFor(sender, swapped), plaintext), { code: 'invalid_envelope' });
  }
  assert.equal((spy.counts().digest ?? 0) - digestsBefore, 2, 'unknown bytes are fingerprinted on every attempt');
  assert.equal(spy.publicImports(fresh.endpoint.publicKey), 0, 'a key whose fingerprint is not the claimed id is never imported or cached');
  const relabelled: EndpointPublic = { ...recipient.endpoint, id: other.endpoint.id };
  await assert.rejects(seal(sender, relabelled, headerFor(sender, relabelled), plaintext), { code: 'invalid_envelope' });
  // The rejected attempts left the cache as it was: the real key now validates and imports once.
  await seal(sender, fresh.endpoint, headerFor(sender, fresh.endpoint), plaintext);
  assert.equal(spy.publicImports(fresh.endpoint.publicKey), 1);
  spy.restore();
  const envelope = await seal(sender, recipient.endpoint, headerFor(sender, recipient.endpoint, 'still-opens'), plaintext);
  assert.deepEqual(await open(recipient, sender.endpoint, envelope, contextOf(headerFor(sender, recipient.endpoint, 'still-opens'))), plaintext);
});

test('an invalid public key is rejected, and re-examined, on every attempt', async t => {
  const sender = await generateEndpoint(ownerId, 'bridge');
  // 65 canonical bytes with the uncompressed-point prefix that are not a point on P-256, under their true fingerprint.
  const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]);
  const bad: EndpointPublic = { version: 1, ownerId, kind: 'browser', publicKey: offCurve.toString('base64url'),
    id: Buffer.from(await crypto.subtle.digest('SHA-256', offCurve)).toString('base64url') };
  const spy = spySubtle(t);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await assert.rejects(seal(sender, bad, headerFor(sender, bad), encoder.encode('never sealed')), { code: 'invalid_envelope' });
    assert.equal(spy.publicImports(bad.publicKey), attempt, 'the failed import is retried, not remembered');
  }
  assert.equal(spy.counts().generateKey, undefined, 'no encapsulation is attempted for an invalid key');
  // An identity whose public handle does not match its endpoint is refused every time as well.
  const stranger = await generateEndpoint(ownerId, 'bridge');
  const mismatched: EndpointIdentity = { endpoint: sender.endpoint, keyPair: { publicKey: stranger.keyPair.publicKey, privateKey: sender.keyPair.privateKey } };
  const recipient = await generateEndpoint(ownerId, 'browser');
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(seal(mismatched, recipient.endpoint, headerFor(sender, recipient.endpoint), encoder.encode('never sealed')), { code: 'invalid_envelope' });
  }
  spy.restore();
});

test('the public key cache is bounded and evicts the least recently used key', async t => {
  const sender = await generateEndpoint(ownerId, 'bridge');
  const first = await generateEndpoint(ownerId, 'browser');
  const plaintext = encoder.encode('bounded');
  const spy = spySubtle(t);
  await seal(sender, first.endpoint, headerFor(sender, first.endpoint), plaintext);
  assert.equal(spy.publicImports(first.endpoint.publicKey), 1);
  // Enough other keys to push `first` out; the sender's own key is used by every seal and therefore stays.
  for (let index = 0; index < PUBLIC_KEY_CACHE_LIMIT; index++) {
    const next = await generateEndpoint(ownerId, 'browser');
    await seal(sender, next.endpoint, headerFor(sender, next.endpoint), plaintext);
  }
  assert.equal(spy.publicImports(sender.endpoint.publicKey), 1, 'a key in constant use is never evicted');
  assert.equal(spy.publicImports(first.endpoint.publicKey), 1);
  await seal(sender, first.endpoint, headerFor(sender, first.endpoint), plaintext);
  assert.equal(spy.publicImports(first.endpoint.publicKey), 2, 'the evicted key is validated and imported again');
  spy.restore();
});
