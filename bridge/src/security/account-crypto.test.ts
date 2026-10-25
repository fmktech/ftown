import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as account from './account-crypto.js';
import { generateEndpoint, importEndpoint, MAX_ENVELOPE_BYTES, open, seal } from './crypto.js';
import type { AccountBridge, AccountCheckpoint, AccountCrypto, AccountDevice, AccountHistory, AccountOperation, AccountSigningIdentity, AccountTransition, SignedAccountTransition } from './account-protocol.js';
import type { EndpointIdentity } from './protocol.js';

const api: AccountCrypto = account;
const ownerId = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
const otherOwner = '619f68a6-77c1-49f6-ae2d-c5fa169d284b';
const encode = new TextEncoder();
const raw = (value: string) => Uint8Array.from(Buffer.from(value, 'base64url'));
const b64 = (value: Uint8Array) => Buffer.from(value).toString('base64url');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const trustBytes = (value: unknown) => encode.encode('ftown-account-trust-v1\n' + canonical(value));
const independentHash = async (value: unknown) => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', trustBytes(value))));
function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)]));
  return value;
}
async function independentRecord(payload: AccountTransition, signing: AccountSigningIdentity): Promise<SignedAccountTransition> {
  return { payload, signature: b64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signing.keyPair.privateKey, trustBytes(payload)))) };
}
async function fixture() {
  const now = Date.now();
  const first = await generateEndpoint(ownerId, 'browser');
  const firstSigning = await api.generateAccountSigningIdentity();
  const second = await generateEndpoint(ownerId, 'browser');
  const secondSigning = await api.generateAccountSigningIdentity();
  let history: AccountHistory = { genesis: await api.createAccountGenesis(ownerId, first.endpoint, firstSigning, 'First browser', now), transitions: [] };
  let state = await api.verifyAccountHistory(history, null, now);
  const secondDevice: AccountDevice = { endpoint: second.endpoint, signingPublicKey: secondSigning.publicKey, label: 'Second browser', approvedAt: new Date(now).toISOString() };
  async function append(op: AccountOperation, actor = first, signing = firstSigning) {
    const record = await api.signAccountTransition(state, actor.endpoint.id, signing, op, now + history.transitions.length + 1);
    history = { ...history, transitions: [...history.transitions, record] };
    state = await api.verifyAccountHistory(history, state, now + history.transitions.length + 1);
    return state;
  }
  return { now, first, firstSigning, second, secondSigning, secondDevice, append, history: () => history, state: () => state };
}
async function enrolledBrowser() {
  const f = await fixture();
  const link = await api.createAccountEnrollment(f.second, 'Second browser', f.secondSigning, null, f.now);
  await f.append({ type: 'add_device', device: f.secondDevice });
  const bundle = await api.sealAccountApproval(f.first, link, f.history(), f.now + 5);
  return { ...f, link, bundle };
}

test('ECDSA identity is separate/nonextractable and external P1363 verification uses canonical payload bytes', async () => {
  const f = await fixture();
  assert.equal(f.firstSigning.keyPair.privateKey.algorithm.name, 'ECDSA');
  assert.equal(f.firstSigning.keyPair.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('jwk', f.firstSigning.keyPair.privateKey));
  assert.notEqual(f.firstSigning.publicKey, f.first.endpoint.publicKey);
  const record = f.history().genesis;
  assert.equal(raw(record.signature).length, 64);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, f.firstSigning.keyPair.publicKey, raw(record.signature), trustBytes(reorder(record.payload))), true);
  assert.equal(f.state().head, await independentHash(record.payload));
  assert.deepEqual(await api.verifyAccountHistory(reorder(f.history()) as AccountHistory, null, f.now), f.state());
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, f.firstSigning.keyPair.publicKey, raw(record.signature), encode.encode(canonical(record.payload))), false);
});

test('two browsers sign ordered history and checkpoints are independent of object insertion order', async () => {
  const f = await fixture();
  const pinned = f.state();
  await f.append({ type: 'add_device', device: f.secondDevice });
  const computer = await generateEndpoint(ownerId, 'bridge');
  await f.append({ type: 'add_bridge', bridge: { bridgeId: 'bridge-a', endpoint: computer.endpoint, label: 'Computer', approvedAt: new Date(f.now).toISOString() } }, f.second, f.secondSigning);
  const result = await api.verifyAccountHistory(f.history(), pinned, f.now + 5);
  assert.equal(result.revision, 2);
  assert.deepEqual(result.devices.map(device => device.endpoint.id), [f.first.endpoint.id, f.second.endpoint.id].sort());
  assert.equal(result.bridges[0].bridgeId, 'bridge-a');
  const changedSignature = structuredClone(f.history());
  const signature = raw(changedSignature.transitions[0].signature); signature[0] ^= 1;
  changedSignature.transitions[0].signature = b64(signature);
  await assert.rejects(api.verifyAccountHistory(changedSignature, null, f.now + 5), { code: 'invalid_account_trust' });
});

test('removed devices cannot sign or return, and removing the last administrator is rejected', async () => {
  const f = await fixture();
  await assert.rejects(f.append({ type: 'revoke_device', endpointId: f.first.endpoint.id }), { code: 'account_last_admin' });
  await f.append({ type: 'add_device', device: f.secondDevice });
  await f.append({ type: 'revoke_device', endpointId: f.second.endpoint.id });
  assert.deepEqual(f.state().revokedDeviceIds, [f.second.endpoint.id]);
  await assert.rejects(api.signAccountTransition(f.state(), f.second.endpoint.id, f.secondSigning, { type: 'revoke_device', endpointId: f.first.endpoint.id }, f.now + 5), { code: 'account_device_revoked' });
  await assert.rejects(f.append({ type: 'add_device', device: f.secondDevice }), { code: 'invalid_account_trust' });
  const payload: AccountTransition = { type: 'ftown_account_transition', version: 1, ownerId, rootId: f.state().rootId, revision: 3, previousHead: f.state().head,
    issuedAt: new Date(f.now + 5).toISOString(), signerId: f.second.endpoint.id, operation: { type: 'revoke_device', endpointId: f.first.endpoint.id } };
  const forbidden = await independentRecord(payload, f.secondSigning);
  await assert.rejects(api.verifyAccountHistory({ ...f.history(), transitions: [...f.history().transitions, forbidden] }, null, f.now + 5), { code: 'account_device_revoked' });
});

test('bridge IDs are permanent tombstones, additions are owner/key bound and duplicate identities fail', async () => {
  const f = await fixture();
  const machine = await generateEndpoint(ownerId, 'bridge');
  const item: AccountBridge = { bridgeId: 'bridge-a', endpoint: machine.endpoint, label: 'Machine', approvedAt: new Date(f.now).toISOString() };
  await f.append({ type: 'add_bridge', bridge: item });
  await assert.rejects(f.append({ type: 'add_bridge', bridge: item }), { code: 'invalid_account_trust' });
  await assert.rejects(f.append({ type: 'add_bridge', bridge: { ...item, bridgeId: 'other-id' } }), { code: 'invalid_account_trust' });
  await f.append({ type: 'revoke_bridge', bridgeId: item.bridgeId });
  await assert.rejects(f.append({ type: 'add_bridge', bridge: item }), { code: 'invalid_account_trust' });
  await assert.rejects(f.append({ type: 'add_bridge', bridge: { ...item, bridgeId: 'new-id', endpoint: { ...item.endpoint, ownerId: otherOwner } } }), { code: 'invalid_account_trust' });
});

test('pins reject older, empty, replaced-root, conflicting-head and tampered-derived histories', async () => {
  const f = await fixture();
  const initial = f.history();
  await f.append({ type: 'add_device', device: f.secondDevice });
  const pinned = f.state();
  await assert.rejects(api.verifyAccountHistory(initial, pinned, f.now + 5), { code: 'account_trust_rollback' });
  await assert.rejects(api.verifyAccountHistory(null as unknown as AccountHistory, pinned, f.now + 5), { code: 'account_trust_rollback' });
  const replacement = { genesis: await api.createAccountGenesis(ownerId, f.first.endpoint, f.firstSigning, 'First browser', f.now), transitions: [] };
  await assert.rejects(api.verifyAccountHistory(replacement, pinned, f.now + 5), { code: 'account_trust_rollback' });
  const fork = { ...initial, transitions: [await api.signAccountTransition(await api.verifyAccountHistory(initial, null, f.now), f.first.endpoint.id, f.firstSigning,
    { type: 'add_device', device: { ...f.secondDevice, label: 'Conflicting approval' } }, f.now + 1)] };
  await assert.rejects(api.verifyAccountHistory(fork, pinned, f.now + 5), { code: 'account_trust_rollback' });
  await assert.rejects(api.verifyAccountHistory(f.history(), { ...pinned, devices: [pinned.devices[0]] }, f.now + 5), { code: 'account_trust_rollback' });
});

test('strict bounded history parsing rejects unknown fields, noncanonical encoding and invalid times before crypto', async () => {
  const f = await fixture();
  for (const invalid of [null, { ...f.history(), extra: true }, { ...f.history(), transitions: Array(1025).fill(null) },
    { ...f.history(), genesis: { ...f.history().genesis, signature: f.history().genesis.signature + '=' } },
    { ...f.history(), genesis: { ...f.history().genesis, payload: { ...f.history().genesis.payload, createdAt: 'not-a-date' } } },
    { ...f.history(), genesis: { ...f.history().genesis, payload: { ...f.history().genesis.payload, device: { ...f.history().genesis.payload.device, label: 'x'.repeat(201) } } } },
    { ...f.history(), genesis: { ...f.history().genesis, payload: { ...f.history().genesis.payload, device: { ...f.history().genesis.payload.device, label: '\ud800' } } } },
  ]) assert.throws(() => api.parseAccountHistory(invalid), account.AccountTrustError);
  const invalidRevision = { ...f.state(), revision: NaN };
  await assert.rejects(api.signAccountTransition(invalidRevision, f.first.endpoint.id, f.firstSigning, { type: 'add_device', device: f.secondDevice }, f.now), account.AccountTrustError);
  await assert.rejects(api.signAccountTransition({ ...f.state(), devices: Array(129).fill(f.state().devices[0]) }, f.first.endpoint.id, f.firstSigning,
    { type: 'add_device', device: f.secondDevice }, f.now), { code: 'account_capacity_exceeded' });
  await assert.rejects(api.signAccountTransition({ ...f.state(), bridges: Array(129).fill(null) }, f.first.endpoint.id, f.firstSigning,
    { type: 'add_device', device: f.secondDevice }, f.now), { code: 'account_capacity_exceeded' });
  const future = { genesis: await api.createAccountGenesis(ownerId, f.first.endpoint, f.firstSigning, 'Future', f.now + 30001), transitions: [] };
  await assert.rejects(api.verifyAccountHistory(future, null, f.now), { code: 'invalid_account_trust' });
  await assert.rejects(api.createAccountGenesis(ownerId, f.first.endpoint, f.firstSigning, 'bad', Number.MAX_SAFE_INTEGER), account.AccountTrustError);
});

test('invalid points, HPKE fingerprints, ownership, key reuse and mismatched signing key pairs are rejected', async () => {
  const f = await fixture();
  await assert.rejects(api.createAccountGenesis(otherOwner, f.first.endpoint, f.firstSigning, 'Wrong owner', f.now), account.AccountTrustError);
  await assert.rejects(api.createAccountGenesis(ownerId, { ...f.first.endpoint, id: f.second.endpoint.id }, f.firstSigning, 'Wrong fingerprint', f.now), account.AccountTrustError);
  const invalid = Uint8Array.from({ length: 65 }, (_, i) => i === 0 ? 4 : 0);
  await assert.rejects(api.createAccountGenesis(ownerId, { ...f.first.endpoint, publicKey: b64(invalid), id: b64(new Uint8Array(await crypto.subtle.digest('SHA-256', invalid))) }, f.firstSigning, 'Invalid point', f.now), account.AccountTrustError);
  await assert.rejects(api.createAccountGenesis(ownerId, f.first.endpoint, { ...f.firstSigning, publicKey: f.secondSigning.publicKey }, 'Wrong signer', f.now), account.AccountTrustError);
  await assert.rejects(api.createAccountGenesis(ownerId, f.first.endpoint, { ...f.firstSigning, publicKey: f.first.endpoint.publicKey }, 'Reused key', f.now), account.AccountTrustError);
});

test('valid signatures cannot bypass owner/root/revision/head or monotonic timestamp constraints', async () => {
  const f = await fixture();
  await f.append({ type: 'add_device', device: f.secondDevice });
  const base: AccountTransition = { type: 'ftown_account_transition', version: 1, ownerId, rootId: f.state().rootId,
    revision: 2, previousHead: f.state().head, signerId: f.first.endpoint.id, issuedAt: new Date(f.now + 2).toISOString(),
    operation: { type: 'revoke_device', endpointId: f.second.endpoint.id } };
  for (const change of [
    { ownerId: otherOwner }, { rootId: b64(crypto.getRandomValues(new Uint8Array(32))) },
    { revision: 1 }, { previousHead: f.history().genesis.payload.rootId },
    { issuedAt: new Date(f.now).toISOString() }, { issuedAt: new Date(f.now + 40000).toISOString() },
  ]) {
    const record = await independentRecord({ ...base, ...change }, f.firstSigning);
    await assert.rejects(api.verifyAccountHistory({ ...f.history(), transitions: [...f.history().transitions, record] }, null, f.now + 2), { code: 'invalid_account_trust' });
  }
});

test('typed enrollment failures never return supplied secrets or raw crypto exceptions', async () => {
  const f = await fixture();
  const link = await api.createAccountEnrollment(f.second, 'Second browser', f.secondSigning, null, f.now);
  for (const value of [link.secret, { ...link, secret: 'private-secret-must-not-be-logged' }, { request: { ...link.request, candidate: { ...link.request.candidate, publicKey: 'sensitive-bad-key' } }, secret: link.secret }]) {
    await assert.rejects(api.parseAccountEnrollmentLink(value, f.now), error => error instanceof account.AccountTrustError
      && error.code === 'account_enrollment_invalid' && !error.message.includes(link.secret) && !/private-secret|sensitive-bad-key|OperationError/.test(error.message));
  }
});

test('browser request proves its signing key; fragment round trip and comparison code match independent bytes', async () => {
  const f = await fixture();
  const link = await api.createAccountEnrollment(f.second, 'Second browser', f.secondSigning, null, f.now);
  assert.equal(link.secret.length, 43);
  assert.equal(link.request.challenge.length, 43);
  const encoded = api.encodeAccountEnrollmentLink(link);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(await api.parseAccountEnrollmentLink(encoded, f.now), link);
  assert.deepEqual(await api.parseAccountEnrollmentLink(link, f.now), link);
  assert.deepEqual(await api.parseAccountEnrollmentRequest(link.request, f.now), link.request);
  const hex = Buffer.from(await crypto.subtle.digest('SHA-256', encode.encode('ftown-account-comparison-v1\n' + canonical(link)))).toString('hex').slice(0, 12).toUpperCase();
  assert.equal(await api.accountComparisonCode(link), hex.match(/.{4}/g)!.join('-'));
  await assert.rejects(api.parseAccountEnrollmentLink(encoded + '=', f.now), { code: 'account_enrollment_invalid' });
  await assert.rejects(api.parseAccountEnrollmentLink({ ...link, serverSecret: link.secret }, f.now), { code: 'account_enrollment_invalid' });
  await assert.rejects(api.parseAccountEnrollmentRequest({ ...link.request, label: 'Substituted label' }, f.now), { code: 'account_enrollment_invalid' });
  assert.equal(link.request.kind, 'browser');
  if (link.request.kind === 'browser') {
    await assert.rejects(api.parseAccountEnrollmentRequest({ ...link.request, signingPublicKey: f.firstSigning.publicKey }, f.now), { code: 'account_enrollment_invalid' });
  }
  await assert.rejects(api.parseAccountEnrollmentRequest(link.request, f.now + 300000), { code: 'account_enrollment_expired' });
  await assert.rejects(api.parseAccountEnrollmentRequest(link.request, f.now - 1), { code: 'account_enrollment_invalid' });
});

test('head-bound browser approval opens only to exact candidate/secret/request and invents no freshness timestamp', async () => {
  const f = await enrolledBrowser();
  const trusted = await api.openAccountApproval(f.second, f.link, f.bundle, f.history(), f.now + 10);
  assert.deepEqual(trusted.checkpoint, f.state());
  assert.deepEqual(Object.keys(trusted).sort(), ['checkpoint', 'history']);
  await assert.rejects(api.openAccountApproval(f.first, f.link, f.bundle, f.history(), f.now + 10), { code: 'account_enrollment_invalid' });
  await assert.rejects(api.openAccountApproval(f.second, { ...f.link, secret: b64(crypto.getRandomValues(new Uint8Array(32))) }, f.bundle, f.history(), f.now + 10), { code: 'account_enrollment_invalid' });
  const otherLink = await api.createAccountEnrollment(f.second, 'Second browser', f.secondSigning, null, f.now);
  await assert.rejects(api.openAccountApproval(f.second, otherLink, f.bundle, f.history(), f.now + 10), { code: 'account_enrollment_invalid' });
  await assert.rejects(api.openAccountApproval(f.second, f.link, { ...f.bundle, ownerId: otherOwner }, f.history(), f.now + 10), { code: 'account_enrollment_invalid' });
  await assert.rejects(api.openAccountApproval(f.second, f.link, { ...f.bundle, approver: f.second.endpoint }, f.history(), f.now + 10), { code: 'account_enrollment_invalid' });
  await assert.rejects(api.openAccountApproval(f.second, f.link, { ...f.bundle, envelope: { ...f.bundle.envelope, channel: 'account-enrollment:other' } }, f.history(), f.now + 10), { code: 'account_enrollment_invalid' });
  const cipher = raw(f.bundle.envelope.ciphertext); cipher[0] ^= 1;
  await assert.rejects(api.openAccountApproval(f.second, f.link, { ...f.bundle, envelope: { ...f.bundle.envelope, ciphertext: b64(cipher) } }, f.history(), f.now + 10), { code: 'account_enrollment_invalid' });
});

test('HMAC authenticates plaintext transcript even if an authenticated approver produces substituted ciphertext', async () => {
  const f = await enrolledBrowser();
  const envelope = f.bundle.envelope;
  const context = { ownerId, bridgeId: envelope.bridgeId, channel: envelope.channel, purpose: envelope.purpose, recipientId: f.second.endpoint.id };
  const plain = JSON.parse(new TextDecoder().decode(await open(f.second, f.first.endpoint, envelope, context)));
  assert.equal('history' in plain, false);
  assert.equal('devices' in plain.head, false);
  const forged = await seal(f.first, f.second.endpoint, envelope, encode.encode(JSON.stringify({ ...plain, approvedAt: new Date(f.now + 1).toISOString() })));
  await assert.rejects(api.openAccountApproval(f.second, f.link, { ...f.bundle, envelope: forged }, f.history(), f.now + 10), { code: 'account_enrollment_invalid' });
});

test('a historical approver may be revoked in a continuation, but the approved candidate must remain active', async () => {
  const f = await enrolledBrowser();
  await f.append({ type: 'revoke_device', endpointId: f.first.endpoint.id }, f.second, f.secondSigning);
  const trusted = await api.openAccountApproval(f.second, f.link, f.bundle, f.history(), f.now + 10);
  assert.deepEqual(trusted.checkpoint.devices.map(item => item.endpoint.id), [f.second.endpoint.id]);
  await assert.rejects(api.sealAccountApproval(f.first, f.link, f.history(), f.now + 10), account.AccountTrustError);
  const g = await enrolledBrowser();
  await g.append({ type: 'revoke_device', endpointId: g.second.endpoint.id });
  await assert.rejects(api.openAccountApproval(g.second, g.link, g.bundle, g.history(), g.now + 10), { code: 'account_device_revoked' });
});

test('response expiry permits same-request resealing while enrollment is valid and rejects expired enrollments', async () => {
  const f = await enrolledBrowser();
  await assert.rejects(api.openAccountApproval(f.second, f.link, f.bundle, f.history(), f.now + 120006), { code: 'account_enrollment_invalid' });
  const resealed = await api.sealAccountApproval(f.first, f.link, f.history(), f.now + 120006);
  assert.notEqual(resealed.envelope.ciphertext, f.bundle.envelope.ciphertext);
  assert.deepEqual((await api.openAccountApproval(f.second, f.link, resealed, f.history(), f.now + 120007)).checkpoint, f.state());
  await assert.rejects(api.sealAccountApproval(f.first, f.link, f.history(), f.now + 300000), { code: 'account_enrollment_expired' });
});

test('pending bridge survives export/import, normalizes only owner and completes exact-key bootstrap', async () => {
  const f = await fixture();
  const pending = await api.generateAccountBridgeCandidate('bridge-a', true);
  assert.equal(pending.endpoint.ownerId, 'pending:bridge-a');
  const privateKey = await crypto.subtle.exportKey('jwk', pending.keyPair.privateKey);
  const restored = await api.importAccountBridgeCandidate(pending.endpoint, privateKey);
  assert.deepEqual(restored.endpoint, pending.endpoint);
  assert.equal(restored.keyPair.privateKey.extractable, false);
  await assert.rejects(importEndpoint(pending.endpoint, privateKey));
  const wrong = await api.generateAccountBridgeCandidate('bridge-b', true);
  await assert.rejects(api.importAccountBridgeCandidate(pending.endpoint, await crypto.subtle.exportKey('jwk', wrong.keyPair.privateKey)), { code: 'account_enrollment_invalid' });
  const link = await api.createAccountEnrollment(restored, 'Computer', null, 'bridge-a', f.now);
  await f.append({ type: 'add_bridge', bridge: { bridgeId: 'bridge-a', endpoint: { ...restored.endpoint, ownerId }, label: 'Computer', approvedAt: new Date(f.now).toISOString() } });
  const bundle = await api.sealAccountApproval(f.first, link, f.history(), f.now + 5);
  const verified = await api.openAccountApproval(restored, link, bundle, f.history(), f.now + 10);
  assert.equal(verified.checkpoint.bridges[0].endpoint.ownerId, ownerId);
  assert.equal(verified.checkpoint.bridges[0].endpoint.publicKey, restored.endpoint.publicKey);
  assert.equal(verified.checkpoint.bridges[0].endpoint.id, restored.endpoint.id);
  await assert.rejects(api.createAccountEnrollment(restored, 'Computer', null, 'bridge-b', f.now), { code: 'account_enrollment_invalid' });
  await assert.rejects(api.createAccountEnrollment({ ...restored, endpoint: { ...restored.endpoint, ownerId } }, 'Computer', null, 'bridge-a', f.now), { code: 'account_enrollment_invalid' });
});

test('large independently signed history stays outside the small HPKE approval envelope', async () => {
  const f = await enrolledBrowser();
  const filler = await generateEndpoint(ownerId, 'bridge');
  const transitions = [...f.history().transitions];
  let previousHead = f.state().head;
  for (let i = 0; i < 600; i++) {
    const bridgeId = `history-${Math.floor(i / 2)}-${'x'.repeat(175)}`;
    const op: AccountOperation = i % 2 === 0 ? { type: 'add_bridge', bridge: { bridgeId, endpoint: filler.endpoint, label: '機'.repeat(200), approvedAt: new Date(f.now).toISOString() } }
      : { type: 'revoke_bridge', bridgeId };
    const payload: AccountTransition = { type: 'ftown_account_transition', version: 1, ownerId, rootId: f.state().rootId, revision: transitions.length + 1,
      previousHead, issuedAt: new Date(f.now + 2).toISOString(), signerId: f.first.endpoint.id, operation: op };
    transitions.push(await independentRecord(payload, f.firstSigning));
    previousHead = await independentHash(payload);
  }
  const history = { ...f.history(), transitions };
  assert.ok(Buffer.byteLength(JSON.stringify(history)) > MAX_ENVELOPE_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(history)) < account.ACCOUNT_TRUST_LIMITS.maxHistoryBytes);
  const bundle = await api.sealAccountApproval(f.first, f.link, history, f.now + 5);
  assert.ok(Buffer.byteLength(JSON.stringify(bundle)) < 10000);
  const result = await api.openAccountApproval(f.second, f.link, bundle, history, f.now + 10);
  assert.equal(result.checkpoint.revision, 601);
  assert.equal(result.checkpoint.revokedBridgeIds.length, 300);
  assert.equal(result.checkpoint.head, previousHead);
});
