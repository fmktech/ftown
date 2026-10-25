import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pending from './pending-approval-crypto.js';
import * as account from './account-crypto.js';
import { generateEndpoint, open, seal } from './crypto.js';
import type { AccountCheckpoint, AccountHistory, AccountOperation, AccountSigningIdentity } from './account-protocol.js';
import type { EndpointIdentity } from './protocol.js';
import type { PendingApprovalCrypto, PendingOffer, PendingResult, PendingReviewerPayload } from './pending-approval-protocol.js';

const api: PendingApprovalCrypto = pending;
const ownerId = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
const otherOwner = '619f68a6-77c1-49f6-ae2d-c5fa169d284b';
const encoder = new TextEncoder();
const encode = (value: string) => encoder.encode(value);
const raw = (value: string) => Uint8Array.from(Buffer.from(value, 'base64url'));
const b64 = (value: Uint8Array) => Buffer.from(value).toString('base64url');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
const input = (domain: string, value: unknown) => encode(domain + '\n' + canonical(value));
const digest = async (domain: string, value: unknown) => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', input(domain, value))));
const head = (state: AccountCheckpoint) => ({ rootId: state.rootId, revision: state.revision, head: state.head });
function reorder<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reorder) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) as T;
  return value;
}
function tamper(value: string): string { const bytes = raw(value); bytes[0] ^= 1; return b64(bytes); }
async function fixture(kind: 'browser' | 'bridge' = 'browser', existing = false) {
  const now = Date.now();
  const admin = await generateEndpoint(ownerId, 'browser');
  const signing = await account.generateAccountSigningIdentity();
  const candidate = existing ? admin : kind === 'bridge'
    ? await account.generateAccountBridgeCandidate('computer-a') : await generateEndpoint(ownerId, 'browser');
  const candidateSigning = existing ? signing : kind === 'browser' ? await account.generateAccountSigningIdentity() : null;
  const name = existing ? 'Administrator' : kind === 'browser' ? 'New phone' : 'New computer';
  const history: AccountHistory = { genesis: await account.createAccountGenesis(ownerId, admin.endpoint, signing, 'Administrator', now), transitions: [] };
  const checkpoint = await account.verifyAccountHistory(history, null, now);
  const oldLink = await account.createAccountEnrollment(candidate, name, candidateSigning, kind === 'bridge' ? 'computer-a' : null, now);
  const local = await api.createPendingOffer(oldLink.request, admin, signing, history, now);
  const packet = await api.createPendingHello(candidate, local.offer, now + 1);
  const reviewerSecret = await api.openPendingHello(admin, local, packet.hello, now + 2);
  const offerHash = await api.pendingOfferHash(local.offer);
  const reveal = { offerHash, contribution: local.contribution };
  const confirmation = await api.createPendingConfirmation(local.offer, packet.secret, reveal, offerHash);
  const operation: AccountOperation = oldLink.request.kind === 'browser' ? {
    type: 'add_device', device: { endpoint: candidate.endpoint, signingPublicKey: oldLink.request.signingPublicKey, label: name, approvedAt: new Date(now + 3).toISOString() },
  } : {
    type: 'add_bridge', bridge: { bridgeId: 'computer-a', endpoint: { ...candidate.endpoint, ownerId }, label: name, approvedAt: new Date(now + 3).toISOString() },
  };
  const addition = existing ? null : await account.signAccountTransition(checkpoint, admin.endpoint.id, signing, operation, now + 3);
  const approvalHistory = addition ? { ...history, transitions: [addition] } : history;
  const result = await api.createPendingResult(admin, local, reviewerSecret, confirmation, offerHash, approvalHistory, now + 4);
  return { now, admin, signing, candidate, candidateSigning, oldLink, history, checkpoint, local, packet, reviewerSecret, offerHash, reveal, confirmation, addition, approvalHistory, result };
}
async function append(history: AccountHistory, actor: EndpointIdentity, signing: AccountSigningIdentity, operation: AccountOperation, now: number): Promise<AccountHistory> {
  const current = await account.verifyAccountHistory(history, null, now);
  const transition = await account.signAccountTransition(current, actor.endpoint.id, signing, operation, now);
  return { ...history, transitions: [...history.transitions, transition] };
}
async function independentSecret(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const req = f.oldLink.request;
  const normalized = { ...req.candidate, ownerId };
  const plaintext = await open(f.admin, normalized, f.packet.hello.envelope, {
    ownerId, bridgeId: req.kind === 'bridge' ? req.bridgeId : 'account_' + ownerId,
    channel: 'pending-approval:' + req.requestId, purpose: 'enroll', recipientId: f.admin.endpoint.id,
  });
  return JSON.parse(new TextDecoder().decode(plaintext)).secret as string;
}
async function independentDerived(f: Awaited<ReturnType<typeof fixture>>, label: string, length = 32): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey('raw', raw(await independentSecret(f)), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256',
    salt: raw(await digest('ftown-pending-salt-v1', { offerHash: f.offerHash, contribution: f.local.contribution })),
    info: encode('ftown-pending-v1/' + label) }, imported, length * 8));
}
async function resultMac(f: Awaited<ReturnType<typeof fixture>>, result: PendingResult): Promise<string> {
  const key = await crypto.subtle.importKey('raw', await independentDerived(f, 'approver-result'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, input('ftown-pending-result-v1', {
    role: 'approver', requestId: f.oldLink.request.requestId, offerHash: result.offerHash, head: result.head,
    bundleHash: await digest('ftown-pending-bundle-v1', result.bundle),
  }))));
}

test('two browser endpoints complete comparison, both confirmations and verified membership', async () => {
  const f = await fixture();
  const candidateCode = await api.pendingComparisonCode(f.local.offer, f.packet.secret, f.reveal);
  assert.match(candidateCode, /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
  assert.equal(candidateCode, await api.pendingComparisonCode(f.local.offer, f.reviewerSecret, f.reveal));
  await api.verifyPendingConfirmation(f.local.offer, f.reviewerSecret, f.reveal, f.confirmation);
  const opened = await api.openPendingResult(f.candidate, f.local.offer, f.packet.secret, f.reveal, f.offerHash, f.result, f.approvalHistory, f.now + 5);
  assert.equal(opened.status, 'verified');
  if (opened.status === 'verified') assert.equal(opened.trust.checkpoint.devices.some(device => device.endpoint.id === f.candidate.endpoint.id), true);
  assert.equal(f.packet.secret.key.extractable, false);
  assert.deepEqual(f.packet.secret.key.usages, ['deriveBits']);
  await assert.rejects(crypto.subtle.exportKey('raw', f.packet.secret.key));
  assert.equal(await api.pendingComparisonCode(f.local.offer, structuredClone(f.packet.secret), f.reveal), candidateCode);
});
test('pending bridge normalization retains its key while all wire authority is bound to the offered owner', async () => {
  const f = await fixture('bridge');
  const opened = await api.openPendingResult(f.candidate, f.local.offer, f.packet.secret, f.reveal, f.offerHash, f.result, f.approvalHistory, f.now + 5);
  assert.equal(f.candidate.endpoint.ownerId, 'pending:computer-a');
  assert.equal(f.packet.hello.envelope.ownerId, ownerId);
  assert.equal(f.packet.hello.envelope.bridgeId, 'computer-a');
  assert.equal(opened.status, 'verified');
  if (opened.status === 'verified') {
    assert.equal(opened.trust.checkpoint.bridges[0].endpoint.ownerId, ownerId);
    assert.equal(opened.trust.checkpoint.bridges[0].endpoint.publicKey, f.candidate.endpoint.publicKey);
  }
});
test('independent canonical ECDSA, commitment, HKDF and HMAC checks match frozen domains', async () => {
  const f = await fixture();
  const { commitment, ...core } = f.local.offer.payload;
  assert.equal(commitment, await digest('ftown-pending-commit-v1', { core, contribution: f.local.contribution }));
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, f.signing.keyPair.publicKey,
    raw(f.local.offer.signature), input('ftown-pending-offer-v1', reorder(f.local.offer.payload))), true);
  assert.equal(f.offerHash, await digest('ftown-pending-offer-hash-v1', f.local.offer.payload));
  assert.equal(await api.pendingHelloHash(f.packet.hello), await digest('ftown-pending-hello-hash-v1', f.packet.hello));
  const six = await independentDerived(f, 'sas', 6);
  const code = Buffer.from(six).toString('hex').toUpperCase().match(/.{4}/g)!.join('-');
  assert.equal(await api.pendingComparisonCode(f.local.offer, f.packet.secret, f.reveal), code);
  const link = await api.pendingBootstrapLink(f.local.offer, f.packet.secret, f.reveal);
  assert.equal(link.secret, b64(await independentDerived(f, 'bootstrap')));
  assert.notEqual(link.secret, await independentSecret(f));
  assert.equal(f.result.mac, await resultMac(f, f.result));
  const candidateKey = await crypto.subtle.importKey('raw', await independentDerived(f, 'candidate-confirm'), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  assert.equal(await crypto.subtle.verify('HMAC', candidateKey, raw(f.confirmation.mac), input('ftown-pending-candidate-confirm-v1',
    { role: 'candidate', requestId: f.oldLink.request.requestId, offerHash: f.offerHash })), true);
});
test('wire publications contain no candidate secret, reviewer contribution before reveal or old fragment secret', async () => {
  const f = await fixture();
  const published = JSON.stringify({ request: f.oldLink.request, offer: f.local.offer, hello: f.packet.hello });
  assert.equal(published.includes(f.local.contribution), false);
  assert.equal(published.includes(await independentSecret(f)), false);
  assert.equal(published.includes(f.oldLink.secret), false);
  assert.equal(JSON.stringify(f.result).includes((await api.pendingBootstrapLink(f.local.offer, f.packet.secret, f.reveal)).secret), false);
});
test('signature randomness and key insertion order cannot grind the comparison code', async () => {
  const f = await fixture();
  const alternate: PendingOffer = { payload: reorder(f.local.offer.payload),
    signature: b64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, f.signing.keyPair.privateKey,
      input('ftown-pending-offer-v1', f.local.offer.payload)))) };
  assert.notEqual(alternate.signature, f.local.offer.signature);
  assert.equal(await api.pendingOfferHash(alternate), f.offerHash);
  assert.equal(await api.pendingComparisonCode(alternate, f.packet.secret, f.reveal),
    await api.pendingComparisonCode(f.local.offer, f.packet.secret, f.reveal));
});
test('no result without trusted local confirmation and valid candidate confirmation; candidate must locally confirm too', async () => {
  const f = await fixture();
  await assert.rejects(api.createPendingConfirmation(f.local.offer, f.packet.secret, f.reveal, ''), { code: 'account_enrollment_invalid' });
  await assert.rejects(api.createPendingResult(f.admin, f.local, f.reviewerSecret, f.confirmation, '', f.approvalHistory, f.now + 5), { code: 'account_enrollment_invalid' });
  await assert.rejects(api.createPendingResult(f.admin, f.local, f.reviewerSecret, { ...f.confirmation, mac: tamper(f.confirmation.mac) },
    f.offerHash, f.approvalHistory, f.now + 5), { code: 'account_enrollment_invalid' });
  await assert.rejects(api.openPendingResult(f.candidate, f.local.offer, f.packet.secret, f.reveal, '', f.result, f.approvalHistory, f.now + 5), { code: 'account_enrollment_invalid' });
});
test('role reflection, changed reveal, second secret and mixed transcripts fail closed', async () => {
  const f = await fixture();
  await assert.rejects(api.verifyPendingConfirmation(f.local.offer, f.reviewerSecret, f.reveal, { offerHash: f.offerHash, mac: f.result.mac }), { code: 'account_enrollment_invalid' });
  await assert.rejects(api.openPendingResult(f.candidate, f.local.offer, f.packet.secret, f.reveal, f.offerHash,
    { ...f.result, mac: f.confirmation.mac }, f.approvalHistory, f.now + 5), { code: 'account_enrollment_invalid' });
  await assert.rejects(api.pendingComparisonCode(f.local.offer, f.packet.secret, { ...f.reveal, contribution: tamper(f.reveal.contribution) }), { code: 'account_enrollment_invalid' });
  const second = await api.createPendingHello(f.candidate, f.local.offer, f.now + 5);
  await assert.rejects(api.verifyPendingConfirmation(f.local.offer, second.secret, f.reveal, f.confirmation), { code: 'account_enrollment_invalid' });
  const replacement = await api.createPendingOffer(f.oldLink.request, f.admin, f.signing, f.history, f.now + 5);
  await assert.rejects(api.openPendingHello(f.admin, replacement, f.packet.hello, f.now + 6), { code: 'account_enrollment_invalid' });
  await assert.rejects(api.pendingComparisonCode(replacement.offer, f.packet.secret, f.reveal), { code: 'account_enrollment_invalid' });
});
test('request/root/key/signature substitution and malformed offers cannot be approved by their self consistency', async () => {
  const f = await fixture();
  for (const value of [
    { ...f.local.offer, signature: tamper(f.local.offer.signature) },
    { ...f.local.offer, payload: { ...f.local.offer.payload, ownerId: otherOwner } },
    { ...f.local.offer, payload: { ...f.local.offer.payload, anchor: { ...f.local.offer.payload.anchor, head: tamper(f.offerHash) } } },
    { ...f.local.offer, payload: { ...f.local.offer.payload, offerId: f.offerHash + '=' } },
    { ...f.local.offer, payload: { ...f.local.offer.payload, signingPublicKey: f.admin.endpoint.publicKey } },
    { ...f.local.offer, extra: true },
  ]) await assert.rejects(api.parsePendingOffer(value, f.oldLink.request, f.now + 5), account.AccountTrustError);
  const another = await account.createAccountEnrollment(f.candidate, 'Changed name', f.candidateSigning, null, f.now);
  await assert.rejects(api.parsePendingOffer(f.local.offer, another.request, f.now + 5), { code: 'account_enrollment_invalid' });
  const attacker = await generateEndpoint(ownerId, 'browser');
  const attackerSigning = await account.generateAccountSigningIdentity();
  const fakeHistory = { genesis: await account.createAccountGenesis(ownerId, attacker.endpoint, attackerSigning, 'Fake root', f.now), transitions: [] };
  const fake = await api.createPendingOffer(f.oldLink.request, attacker, attackerSigning, fakeHistory, f.now + 5);
  assert.ok(await api.parsePendingOffer(fake.offer, f.oldLink.request, f.now + 6)); // not a trust grant
  await assert.rejects(api.openPendingResult(f.candidate, fake.offer, f.packet.secret, f.reveal, f.offerHash, f.result, fakeHistory, f.now + 7), account.AccountTrustError);
});
test('hello authentication binds sender, recipient, role, epoch, request, ownership and expiry', async () => {
  const f = await fixture();
  for (const envelope of [
    { ...f.packet.hello.envelope, ciphertext: tamper(f.packet.hello.envelope.ciphertext) },
    { ...f.packet.hello.envelope, ownerId: otherOwner },
    { ...f.packet.hello.envelope, purpose: 'application' as const },
    { ...f.packet.hello.envelope, channel: 'other-channel' },
    { ...f.packet.hello.envelope, receiverEpoch: 'invented' },
    { ...f.packet.hello.envelope, senderId: f.admin.endpoint.id },
    { ...f.packet.hello.envelope, recipientId: f.candidate.endpoint.id },
    { ...f.packet.hello.envelope, messageId: 'different' },
  ]) await assert.rejects(api.openPendingHello(f.admin, f.local, { ...f.packet.hello, envelope }, f.now + 5), account.AccountTrustError);
  const stranger = await generateEndpoint(ownerId, 'browser');
  await assert.rejects(api.openPendingHello(stranger, f.local, f.packet.hello, f.now + 5), account.AccountTrustError);
  await assert.rejects(api.createPendingHello(stranger, f.local.offer, f.now + 5), account.AccountTrustError);
  await assert.rejects(api.openPendingHello(f.admin, { ...f.local, contribution: tamper(f.local.contribution) }, f.packet.hello, f.now + 5), account.AccountTrustError);
  await assert.rejects(api.openPendingHello(f.admin, f.local, f.packet.hello, f.now + 120002), { code: 'account_enrollment_expired' });
});
test('valid ciphertext rerandomization does not change SAS but changes pinned hello digest', async () => {
  const f = await fixture();
  const original = f.packet.hello.envelope;
  const { enc: _enc, ciphertext: _ciphertext, ...header } = original;
  const envelope = await seal(f.candidate, f.admin.endpoint, header, encode(JSON.stringify({
    type: 'ftown_pending_secret', version: 1, requestId: f.oldLink.request.requestId, offerHash: f.offerHash, secret: await independentSecret(f),
  })));
  const altered = { ...f.packet.hello, envelope };
  assert.notEqual(await api.pendingHelloHash(altered), await api.pendingHelloHash(f.packet.hello));
  const sameSecret = await api.openPendingHello(f.admin, f.local, altered, f.now + 5);
  assert.equal(await api.pendingComparisonCode(f.local.offer, sameSecret, f.reveal), await api.pendingComparisonCode(f.local.offer, f.packet.secret, f.reveal));
  // Durable one-hello pinning/burning belongs to caller state, never a hidden global core cache.
});
test('only anchor or one exact candidate addition is a valid approval prefix', async () => {
  const f = await fixture();
  const other = await generateEndpoint(ownerId, 'bridge');
  const unrelated = await append(f.history, f.admin, f.signing, { type: 'add_bridge', bridge: {
    bridgeId: 'unrelated', endpoint: other.endpoint, label: 'Other', approvedAt: new Date(f.now + 5).toISOString(),
  } }, f.now + 5);
  await assert.rejects(api.createPendingResult(f.admin, f.local, f.reviewerSecret, f.confirmation, f.offerHash, unrelated, f.now + 6), account.AccountTrustError);
  const later = await append(f.approvalHistory, f.admin, f.signing, { type: 'add_bridge', bridge: {
    bridgeId: 'later', endpoint: other.endpoint, label: 'Later', approvedAt: new Date(f.now + 6).toISOString(),
  } }, f.now + 6);
  await assert.rejects(api.createPendingResult(f.admin, f.local, f.reviewerSecret, f.confirmation, f.offerHash, later, f.now + 7), { code: 'account_trust_conflict' });
  const opened = await api.openPendingResult(f.candidate, f.local.offer, f.packet.secret, f.reveal, f.offerHash, f.result, later, f.now + 7);
  assert.equal(opened.status, 'verified');
  if (opened.status === 'verified') assert.equal(opened.trust.checkpoint.revision, 2);
});
test('exact existing membership uses the unchanged anchor without another addition', async () => {
  const f = await fixture('browser', true);
  assert.equal(f.result.head.revision, 0);
  const opened = await api.openPendingResult(f.candidate, f.local.offer, f.packet.secret, f.reveal, f.offerHash, f.result, f.history, f.now + 5);
  assert.equal(opened.status, 'verified');
});
test('authenticated expired delivery waits; renewal retains code/head and never reopens expired hello', async () => {
  const f = await fixture();
  const later = f.now + 130000;
  assert.deepEqual(await api.openPendingResult(f.candidate, f.local.offer, f.packet.secret, f.reveal, f.offerHash, f.result, f.approvalHistory, later),
    { status: 'awaiting-delivery-renewal' });
  const retained = structuredClone(f.reviewerSecret);
  const renewed = await api.createPendingResult(f.admin, f.local, retained, f.confirmation, f.offerHash, f.approvalHistory, later);
  assert.deepEqual(renewed.head, f.result.head);
  assert.notEqual(renewed.bundle.envelope.ciphertext, f.result.bundle.envelope.ciphertext);
  assert.equal((await api.openPendingResult(f.candidate, f.local.offer, f.packet.secret, f.reveal, f.offerHash, renewed, f.approvalHistory, later + 1)).status, 'verified');
  await assert.rejects(api.openPendingHello(f.admin, f.local, f.packet.hello, later), { code: 'account_enrollment_expired' });
  await assert.rejects(api.createPendingResult(f.admin, f.local, {} as never, f.confirmation, f.offerHash, f.approvalHistory, later), { code: 'account_enrollment_invalid' });
  await assert.rejects(api.openPendingResult(f.candidate, f.local.offer, f.packet.secret, f.reveal, f.offerHash, renewed, f.approvalHistory, f.now + 300000), { code: 'account_enrollment_expired' });
});
test('invalid result MAC/context/history never becomes awaiting-renewal, even with expired ciphertext', async () => {
  const f = await fixture();
  const later = f.now + 130000;
  for (const result of [
    { ...f.result, mac: tamper(f.result.mac) },
    { ...f.result, head: { ...f.result.head, head: tamper(f.result.head.head) } },
    { ...f.result, bundle: { ...f.result.bundle, ownerId: otherOwner } },
    { ...f.result, bundle: { ...f.result.bundle, envelope: { ...f.result.bundle.envelope, ciphertext: tamper(f.result.bundle.envelope.ciphertext) } } },
  ]) await assert.rejects(api.openPendingResult(f.candidate, f.local.offer, f.packet.secret, f.reveal, f.offerHash, result, f.approvalHistory, later), account.AccountTrustError);
  await assert.rejects(api.openPendingResult(f.candidate, f.local.offer, f.packet.secret, f.reveal, f.offerHash, f.result, f.history, later), account.AccountTrustError);
});
test('current candidate revocation blocks both live access and authenticated renewal-waiting', async () => {
  const f = await fixture();
  const revoked = await append(f.approvalHistory, f.admin, f.signing, { type: 'revoke_device', endpointId: f.candidate.endpoint.id }, f.now + 10);
  for (const now of [f.now + 11, f.now + 130000]) await assert.rejects(api.openPendingResult(f.candidate, f.local.offer, f.packet.secret, f.reveal, f.offerHash,
    f.result, revoked, now), { code: 'account_device_revoked' });
  const adminRevoked = await append(f.approvalHistory, f.candidate, f.candidateSigning!, { type: 'revoke_device', endpointId: f.admin.endpoint.id }, f.now + 12);
  assert.equal((await api.openPendingResult(f.candidate, f.local.offer, f.packet.secret, f.reveal, f.offerHash, f.result, adminRevoked, f.now + 13)).status, 'verified');
});
test('result MAC binds exact bundle bytes and encrypted approval head must match the immutable result head', async () => {
  const f = await fixture('browser', true);
  const bridge = await generateEndpoint(ownerId, 'bridge');
  const advanced = await append(f.history, f.admin, f.signing, { type: 'add_bridge', bridge: { bridgeId: 'extra',
    endpoint: bridge.endpoint, label: 'Extra', approvedAt: new Date(f.now + 5).toISOString() } }, f.now + 5);
  const local = await api.createPendingOffer(f.oldLink.request, f.admin, f.signing, advanced, f.now + 6);
  const packet = await api.createPendingHello(f.candidate, local.offer, f.now + 7);
  const key = await api.openPendingHello(f.admin, local, packet.hello, f.now + 8);
  const offerHash = await api.pendingOfferHash(local.offer);
  const reveal = { offerHash, contribution: local.contribution };
  const confirmation = await api.createPendingConfirmation(local.offer, packet.secret, reveal, offerHash);
  const receipt = await api.createPendingResult(f.admin, local, key, confirmation, offerHash, advanced, f.now + 9);
  const wrongBundle = await account.sealAccountApproval(f.admin, await api.pendingBootstrapLink(local.offer, key, reveal), f.history, f.now + 9);
  const changed = { ...receipt, bundle: wrongBundle };
  const impostorFixture = { ...f, local, packet, offerHash, reveal };
  changed.mac = await resultMac(impostorFixture, changed);
  await assert.rejects(api.openPendingResult(f.candidate, local.offer, packet.secret, reveal, offerHash, changed, advanced, f.now + 10), { code: 'account_enrollment_invalid' });
});
function actionPayload(f: Awaited<ReturnType<typeof fixture>>, action: PendingReviewerPayload['action'], anchor = f.checkpoint): PendingReviewerPayload {
  return { type: 'ftown_pending_action', version: 1, requestId: f.oldLink.request.requestId, ownerId,
    signerId: f.admin.endpoint.id, head: head(anchor), expectedRevision: 2, issuedAt: new Date(f.now + 5).toISOString(), action };
}
test('reviewer commands authenticate each action, exact actor, request, head and prospective member', async () => {
  const f = await fixture();
  const commands: PendingReviewerPayload[] = [
    actionPayload(f, { type: 'review', offer: f.local.offer }),
    actionPayload(f, { type: 'reveal', offerHash: f.offerHash, helloHash: await api.pendingHelloHash(f.packet.hello), reveal: f.reveal }),
    actionPayload(f, { type: 'reject' }),
    actionPayload(f, { type: 'finish', offerHash: f.offerHash, transition: f.addition, result: f.result }),
  ];
  for (const payload of commands) {
    const command = await api.signPendingAction(payload, f.signing);
    assert.deepEqual(await api.verifyPendingAction(reorder(command), f.oldLink.request, f.history, f.now + 6), command);
  }
  const approved = await account.verifyAccountHistory(f.approvalHistory, null, f.now + 6);
  const renew = await api.signPendingAction(actionPayload(f, { type: 'renew', offerHash: f.offerHash, result: f.result }, approved), f.signing);
  assert.deepEqual(await api.verifyPendingAction(renew, f.oldLink.request, f.approvalHistory, f.now + 6), renew);
  const reject = await api.signPendingAction(actionPayload(f, { type: 'reject' }), f.signing);
  await assert.rejects(api.verifyPendingAction({ ...reject, signature: f.local.offer.signature }, f.oldLink.request, f.history, f.now + 6), account.AccountTrustError);
  await assert.rejects(api.verifyPendingAction({ payload: reject.payload }, f.oldLink.request, f.history, f.now + 6), account.AccountTrustError);
  await assert.rejects(api.verifyPendingAction(reject, f.oldLink.request, f.approvalHistory, f.now + 6), { code: 'account_trust_conflict' });
  const invalid = await api.signPendingAction({ ...reject.payload, issuedAt: new Date(f.now + 30007).toISOString() }, f.signing);
  await assert.rejects(api.verifyPendingAction(invalid, f.oldLink.request, f.history, f.now + 6), { code: 'account_enrollment_invalid' });
  await assert.rejects(api.verifyPendingAction({ ...reject, payload: { ...reject.payload, expectedRevision: 3 } }, f.oldLink.request, f.history, f.now + 6), account.AccountTrustError);
});
test('unapproved and revoked signers cannot mutate reviewer state; null finish needs exact existing membership', async () => {
  const f = await fixture();
  const command = await api.signPendingAction({ ...actionPayload(f, { type: 'reject' }), signerId: f.candidate.endpoint.id }, f.candidateSigning!);
  await assert.rejects(api.verifyPendingAction(command, f.oldLink.request, f.history, f.now + 6), { code: 'account_device_revoked' });
  const missing = await api.signPendingAction(actionPayload(f, { type: 'finish', offerHash: f.offerHash, transition: null, result: f.result }), f.signing);
  await assert.rejects(api.verifyPendingAction(missing, f.oldLink.request, f.history, f.now + 6), { code: 'account_device_revoked' });
  const revoked = await append(f.approvalHistory, f.candidate, f.candidateSigning!, { type: 'revoke_device', endpointId: f.admin.endpoint.id }, f.now + 7);
  const latest = await account.verifyAccountHistory(revoked, null, f.now + 8);
  const oldSigner = await api.signPendingAction({ ...actionPayload(f, { type: 'reject' }, latest), issuedAt: new Date(f.now + 8).toISOString() }, f.signing);
  await assert.rejects(api.verifyPendingAction(oldSigner, f.oldLink.request, revoked, f.now + 9), { code: 'account_device_revoked' });
});
test('state parser validates every stage, keeps expired delivery readable, and never treats parsing as confirmation', async () => {
  const f = await fixture();
  const base = { request: f.oldLink.request, revision: 1 };
  const stages = [
    { ...base, status: 'pending' },
    { ...base, status: 'offered', offer: f.local.offer },
    { ...base, status: 'submitted', offer: f.local.offer, hello: f.packet.hello },
    { ...base, status: 'comparing', offer: f.local.offer, hello: f.packet.hello, reveal: f.reveal },
    { ...base, status: 'confirmed', offer: f.local.offer, hello: f.packet.hello, reveal: f.reveal, confirmation: f.confirmation },
    { ...base, status: 'approved', offer: f.local.offer, hello: f.packet.hello, reveal: f.reveal, confirmation: f.confirmation, result: f.result },
  ];
  for (const state of stages) assert.deepEqual(await api.parsePendingState(reorder(state), f.now + 6), state);
  assert.equal((await api.parsePendingState(stages[5], f.now + 130000)).status, 'approved');
  for (const status of ['rejected', 'cancelled', 'expired', 'conflict']) assert.equal((await api.parsePendingState({ ...base, status }, f.now + 300001)).status, status);
  for (const state of [ { ...stages[0], extra: true }, { ...stages[3], reveal: { ...f.reveal, contribution: tamper(f.reveal.contribution) } },
    { ...stages[2], hello: undefined }, { ...base, status: 'invented' }, { ...stages[0], revision: NaN },
  ]) await assert.rejects(api.parsePendingState(state, f.now + 6), account.AccountTrustError);
});
test('strict wire bounds, canonical encodings and malformed crypto inputs produce sanitized typed errors', async () => {
  const f = await fixture();
  await assert.rejects(api.parsePendingOffer({ ...f.local.offer, junk: 'x'.repeat(65537) }, f.oldLink.request, f.now + 5), { code: 'account_capacity_exceeded' });
  for (const value of [null, [], { ...f.local.offer, signature: f.local.offer.signature + '=' }]) await assert.rejects(api.parsePendingOffer(value, f.oldLink.request, f.now + 5), account.AccountTrustError);
  await assert.rejects(api.createPendingOffer(f.oldLink.request, f.admin, { ...f.signing, publicKey: f.candidateSigning!.publicKey }, f.history, f.now + 5), account.AccountTrustError);
  await assert.rejects(api.openPendingHello(f.admin, f.local, { ...f.packet.hello, offerHash: f.offerHash + '=' }, f.now + 5), account.AccountTrustError);
  try {
    await api.pendingComparisonCode(f.local.offer, { key: {} as CryptoKey }, f.reveal);
    assert.fail('must reject malformed local key');
  } catch (error) {
    assert.ok(error instanceof account.AccountTrustError);
    assert.equal(error.code, 'account_enrollment_invalid');
    assert.equal(error.message.includes('deriveBits'), false);
  }
  assert.equal(Object.isFrozen(pending.PENDING_APPROVAL_LIMITS), true);
});
test('routing normalization exactly trims/folds ASCII, preserves non-ASCII and rejects ambiguous syntax', () => {
  assert.equal(api.normalizePendingAccountHint('\t\r\n Alice@EXAMPLE.TEST \v\f'), 'alice@example.test');
  assert.equal(api.normalizePendingAccountHint('ÄLICE@ExÄMPLE.test'), 'Älice@exÄmple.test');
  for (const value of [null, '', '@example.test', 'alice@', 'a@@b', 'a b@example.test', '\u00a0alice@example.test', 'alice@example.test\u0085', 'a'.repeat(255) + '@b', '\ud800@example.test']) {
    assert.throws(() => api.normalizePendingAccountHint(value), { code: 'account_enrollment_invalid' });
  }
});
