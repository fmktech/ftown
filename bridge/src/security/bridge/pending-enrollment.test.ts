import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareBridgeEnrollment, preparePendingBridgeEnrollment, pendingPairingLink, savePairingVerificationUrl, bindPendingBridgeIdentity } from './pending-enrollment.js';
import { createPendingOffer, createPendingHello } from '../pending-approval-crypto.js';
import { createAccountGenesis, generateAccountSigningIdentity, signAccountTransition, verifyAccountHistory, sealAccountApproval, openAccountApproval } from '../account-crypto.js';
import { generateEndpoint } from '../crypto.js';
import { readBoundBridgeIdentity } from './identity.js';
import { runSecurity } from '../../security-cli.js';

const ownerId = '7bac2a7f-c58e-4845-856f-8283fb07ad96';
test('first-ever inbox enrollment starts in an empty directory and keeps its private point across fresh attempts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ftown-virgin-pending-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await preparePendingBridgeEnrollment(directory, 'virgin-bridge', 'Computer');
  assert.equal(first.previous, null);
  assert.equal(first.request.kind, 'bridge'); assert.equal(first.request.bridgeId, 'virgin-bridge');
  assert.equal(first.request.candidate.id, first.identity.endpoint.id);
  assert.equal(first.identity.endpoint.ownerId, 'pending:virgin-bridge');
  assert.equal(first.identity.keyPair.privateKey.extractable, false);
  const file = join(directory, 'security', 'account-enrollment.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.version, 2); assert.equal(saved.request.requestId, first.request.requestId);
  assert.equal(saved.candidateToken, first.candidateToken); assert.ok(saved.privateKey.d);
  assert.equal(saved.endpoint.publicKey, first.identity.endpoint.publicKey);
  assert.equal(saved.offer, null); assert.equal(saved.hello, null); assert.equal(saved.link, undefined);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const restarted = await preparePendingBridgeEnrollment(directory, 'virgin-bridge', 'Computer');
  assert.equal(restarted.identity.endpoint.publicKey, first.identity.endpoint.publicKey);
  assert.equal(restarted.identity.keyPair.privateKey.extractable, false);
  assert.notEqual(restarted.request.requestId, first.request.requestId);
  assert.notEqual(restarted.candidateToken, first.candidateToken);
  assert.deepEqual(restarted.previous, { requestId: first.request.requestId, candidateToken: first.candidateToken });
  await assert.rejects(pendingPairingLink(directory), { code: 'account_enrollment_invalid' });
});
test('automatic process restart rotates request/credential, keeps the same point, and durable pins reject replacements', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ftown-pending-auto-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = await prepareBridgeEnrollment(directory, 'bridge', 'Computer');
  const first = await preparePendingBridgeEnrollment(directory, 'bridge', 'Computer');
  assert.equal(first.identity.endpoint.publicKey, legacy.identity.endpoint.publicKey);
  await assert.rejects(pendingPairingLink(directory), { code: 'account_enrollment_invalid' });
  const browser = await generateEndpoint(ownerId, 'browser'); const signing = await generateAccountSigningIdentity();
  const history = { genesis: await createAccountGenesis(ownerId, browser.endpoint, signing, 'Admin'), transitions: [] };
  const offer = await createPendingOffer(first.request, browser, signing, history);
  await first.pinOffer(offer.offer); await first.pinOffer(offer.offer);
  const replacement = await createPendingOffer(first.request, browser, signing, history);
  await assert.rejects(first.pinOffer(replacement.offer), { code: 'account_trust_conflict' });
  const hello = await createPendingHello(first.identity, offer.offer); await first.pinHello(hello.hello);
  await first.pinHello(hello.hello);
  await assert.rejects(first.pinHello((await createPendingHello(first.identity, offer.offer)).hello), { code: 'account_trust_conflict' });
  const file = join(directory, 'security', 'account-enrollment.json'); const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.version, 2); assert.equal(saved.request.requestId, first.request.requestId); assert.equal(saved.candidateToken, first.candidateToken);
  assert.ok(saved.offer); assert.ok(saved.hello); assert.equal(saved.link, undefined); assert.equal(saved.secret, undefined);
  assert.equal(first.identity.keyPair.privateKey.extractable, false); assert.equal((await stat(file)).mode & 0o777, 0o600);
  const next = await preparePendingBridgeEnrollment(directory, 'bridge', 'Computer');
  assert.equal(next.identity.endpoint.publicKey, first.identity.endpoint.publicKey);
  assert.notEqual(next.request.requestId, first.request.requestId); assert.notEqual(next.candidateToken, first.candidateToken);
  assert.deepEqual(next.previous, { requestId: first.request.requestId, candidateToken: first.candidateToken });
  await assert.rejects(first.pinHello(hello.hello), { code: 'account_trust_conflict' });
  const bootstrap = await prepareBridgeEnrollment(directory, 'bridge', 'Computer', Date.now(), true);
  assert.equal(bootstrap.identity.endpoint.publicKey, first.identity.endpoint.publicKey);
  assert.notEqual(bootstrap.link.request.requestId, next.request.requestId);
});
test('pending secret/key survive restart privately; request expiry rotates only the request, never the bridge point', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ftown-pending-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const now = Date.now();
  const first = await prepareBridgeEnrollment(directory, 'bridge', 'Computer', now);
  const restored = await prepareBridgeEnrollment(directory, 'bridge', 'Computer', now + 1);
  assert.deepEqual(restored.identity.endpoint, first.identity.endpoint);
  assert.deepEqual(restored.link, first.link); assert.equal(restored.identity.keyPair.privateKey.extractable, false);
  assert.equal((await stat(join(directory, 'security', 'account-enrollment.json'))).mode & 0o777, 0o600);
  await savePairingVerificationUrl(directory, 'https://account.example', 'ABCD-1234');
  const url = new URL(await pendingPairingLink(directory, now + 1));
  assert.equal(url.pathname, '/pair'); assert.equal(url.searchParams.get('code'), 'ABCD-1234');
  assert.ok(url.hash.startsWith('#account=')); assert.ok(!url.search.includes(first.link.secret));
  await assert.rejects(pendingPairingLink(directory, now + 300000), { code: 'account_enrollment_expired' });
  const renewed = await prepareBridgeEnrollment(directory, 'bridge', 'Computer', now + 300001);
  assert.equal(renewed.identity.endpoint.id, first.identity.endpoint.id);
  assert.notEqual(renewed.link.secret, first.link.secret); assert.notEqual(renewed.link.request.requestId, first.link.request.requestId);
  await assert.rejects(prepareBridgeEnrollment(directory, 'different-bridge', 'Computer'), { code: 'wrong_context' });
});

test('explicit local pair-link works before bridge pointer/listener and normal help reveals no secret', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ftown-pair-link-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const pending = await prepareBridgeEnrollment(directory, 'bridge', 'Computer');
  await savePairingVerificationUrl(directory, 'https://account.example', 'ABCD-1234');
  const write = process.stdout.write; let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    assert.equal(await runSecurity(['--data-dir', directory, 'pair-link']), 0);
    const url = new URL(output.trim()); assert.equal(url.origin, 'https://account.example'); assert.ok(url.hash.startsWith('#account='));
    assert.ok(!url.search.includes(pending.link.secret));
    output = ''; assert.equal(await runSecurity(['--help']), 0); assert.ok(output.includes('pair-link'));
    assert.ok(!output.includes('#account=')); assert.ok(!output.includes(pending.link.secret));
  } finally { process.stdout.write = write; }
});

test('verified pending approval binds the same key/root durably and never replaces an existing bound identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ftown-bound-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const pending = await prepareBridgeEnrollment(directory, 'bridge', 'Computer');
  const browser = await generateEndpoint(ownerId, 'browser'); const signing = await generateAccountSigningIdentity();
  let history = { genesis: await createAccountGenesis(ownerId, browser.endpoint, signing, 'Browser'), transitions: [] as Awaited<ReturnType<typeof signAccountTransition>>[] };
  const checkpoint = await verifyAccountHistory(history, null);
  history = { ...history, transitions: [await signAccountTransition(checkpoint, browser.endpoint.id, signing,
    { type: 'add_bridge', bridge: { bridgeId: 'bridge', endpoint: { ...pending.identity.endpoint, ownerId }, label: 'Computer', approvedAt: new Date().toISOString() } })] };
  const bundle = await sealAccountApproval(browser, pending.link, history);
  const trust = await openAccountApproval(pending.identity, pending.link, bundle, history);
  const bound = await bindPendingBridgeIdentity(directory, trust);
  assert.equal(bound.endpoint.id, pending.identity.endpoint.id); assert.equal(bound.endpoint.ownerId, ownerId);
  const restarted = await readBoundBridgeIdentity(directory);
  assert.deepEqual(restarted!.identity.endpoint, bound.endpoint); assert.equal(restarted!.bootstrap!.checkpoint.head, trust.checkpoint.head);
  const file = join(directory, 'security', 'bridge-identity.json'); const before = await readFile(file, 'utf8');
  const other = { genesis: await createAccountGenesis(ownerId, browser.endpoint, signing, 'Different root'), transitions: history.transitions };
  await assert.rejects(bindPendingBridgeIdentity(directory, { ...trust, history: other }));
  assert.equal(await readFile(file, 'utf8'), before);
});
