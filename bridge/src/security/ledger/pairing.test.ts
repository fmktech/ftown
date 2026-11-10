import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { generateEndpoint, seal } from '../crypto.js';
import type { EndpointIdentity, EndpointPublic } from '../protocol.js';
import { accountIdOf, ledgerChallenge, ledgerHead, ledgerLastIssuedAt, nextTransition, verifyLedger } from './ledger.js';
import {
  PAIR_FRAGMENT_PREFIX, PAIR_LIFETIME_MS, bridgeFromPairRequest, confirmPairedLedger, createBridgePairRequest, encodePairLink,
  openPairApproval, pairComparisonCode, parsePairLink, sealPairApproval,
} from './pairing.js';
import type { BridgePairLink, BridgePairRequest, PairApproval } from './pairing.js';
import { generateAuthKey } from './proof.js';
import type { Ledger, LedgerBridge, LedgerGenesis, LedgerOperation, LedgerTransition, Signed } from './protocol.js';
import { createSoftPasskey } from './testing.js';
import type { SoftPasskey } from './testing.js';

const rpId = 'ftown.example';
const origin = 'https://ftown.example';
const T0 = 1_750_000_000_000;
const NOW = T0 + 3_600_000;
const SEAL_AT = NOW + 1_000;
const OPEN_AT = NOW + 2_000;
const CONFIRM_AT = NOW + 5_000;
const LINK_ERROR = { message: 'invalid_pair_link' };
const APPROVAL_ERROR = { message: 'invalid_pair_approval' };
const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64url');
const sha256 = (data: Uint8Array | string): Buffer => createHash('sha256').update(data).digest();
const randomB64 = (length: number): string => b64(crypto.getRandomValues(new Uint8Array(length)));
/** Special characters are built from code points so no tool can rewrite an escape into an invisible literal. */
const ch = (code: number): string => String.fromCharCode(code);
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** A 43-character (32-byte) base64url value with a padding bit set in its last character: same bytes, non-canonical text. */
function nonCanonical(text: string): string {
  const variant = text.slice(0, -1) + ALPHABET[ALPHABET.indexOf(text[text.length - 1]) | 1];
  assert.notEqual(variant, text);
  assert.deepEqual(Buffer.from(variant, 'base64url'), Buffer.from(text, 'base64url'));
  return variant;
}

interface Chain { ledger: Ledger; accountId: string; issuedAt: number }

async function signed<T extends LedgerGenesis | LedgerTransition>(passkey: SoftPasskey, payload: T): Promise<Signed<T>> {
  return { payload, signature: await passkey.sign(await ledgerChallenge(payload)) };
}
async function account(): Promise<{ passkey: SoftPasskey; chain: Chain }> {
  const passkey = await createSoftPasskey({ rpId, origin });
  const genesis = await signed(passkey, {
    type: 'ftown_account_genesis', version: 2, rpId, origins: [origin], handle: randomB64(32), createdAt: T0,
    authority: { credentialId: passkey.credentialId, publicKey: passkey.publicKey, label: 'iCloud Keychain', addedAt: T0 },
  });
  return { passkey, chain: { ledger: { genesis, transitions: [] }, accountId: await accountIdOf(genesis.payload), issuedAt: T0 } };
}
/** The signer's real path: verify, nextTransition, sign with the passkey. */
async function append(chain: Chain, passkey: SoftPasskey, operation: LedgerOperation, at = NOW): Promise<Chain> {
  const payload = nextTransition(await verifyLedger(chain.ledger, NOW), passkey.credentialId, operation, at, ledgerLastIssuedAt(chain.ledger));
  const record = await signed(passkey, payload);
  return { ledger: { genesis: chain.ledger.genesis, transitions: [...chain.ledger.transitions, record] }, accountId: chain.accountId, issuedAt: payload.issuedAt };
}
async function lastHead(ledger: Ledger): Promise<string> {
  const last = ledger.transitions[ledger.transitions.length - 1];
  return last === undefined ? accountIdOf(ledger.genesis.payload) : ledgerHead(last.payload);
}
async function approvalOf(chain: Chain): Promise<PairApproval> {
  return { accountId: chain.accountId, head: await lastHead(chain.ledger) };
}
async function ecdhKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return b64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
}
async function browserOf(accountId: string): Promise<EndpointIdentity> {
  return generateEndpoint(accountId, 'browser');
}
async function deviceOp(accountId: string): Promise<LedgerOperation> {
  const endpoint = (await browserOf(accountId)).endpoint;
  return { type: 'add_device', device: { endpoint, authPublicKey: (await generateAuthKey(false)).publicKey, label: 'Phone', approvedAt: T0 } };
}

/** The bridge before pairing: its endpoint identity (pre-account owner), its auth key, and the printed link. */
async function newBridge(bridgeId = 'studio', label = 'Studio Mac') {
  const identity = await generateEndpoint(`solo:${bridgeId}`, 'bridge');
  const auth = await generateAuthKey(false);
  const link = createBridgePairRequest({ bridgeId, endpointPublicKey: identity.endpoint.publicKey, authPublicKey: auth.publicKey, label, now: NOW });
  return { identity, auth, link };
}
/** Account with the bridge approved by the passkey, exactly as the /pair page does it. */
async function approved() {
  const { passkey, chain: start } = await account();
  const bridge = await newBridge();
  const received = parsePairLink(PAIR_FRAGMENT_PREFIX + encodePairLink(bridge.link));
  const entry = await bridgeFromPairRequest(received.request, start.accountId, NOW);
  const chain = await append(start, passkey, { type: 'add_bridge', bridge: entry });
  const sender = await browserOf(chain.accountId);
  return { passkey, start, chain, bridge, received, entry, sender };
}

interface ForgeInput {
  link: BridgePairLink;
  sender: EndpointIdentity;
  /** Bundle values. */
  accountId: string;
  head: string;
  /** Envelope ownerId (HPKE context). Default: accountId. */
  envelopeOwner?: string;
  secret?: string;
  bundleRequestId?: string;
  proofAccountId?: string;
  proofHead?: string;
  proofRequestId?: string;
  /** Rewrites the base64url proof text after it is computed. */
  proofText?: (proof: string) => string;
  bundleVersion?: number;
  recipient?: EndpointPublic;
}
/**
 * An independent implementation of the sealed wire format that skips every sealer-side check (as a hostile server or attacker
 * could): proof = HMAC-SHA256(secret, 'ftown-pair-proof-v2\n' + accountId + '\n' + head + '\n' + requestId) via node:crypto.
 */
async function forge(input: ForgeInput): Promise<string> {
  const request = input.link.request;
  const owner = input.envelopeOwner ?? input.accountId;
  const requestId = input.bundleRequestId ?? request.requestId;
  const mac = createHmac('sha256', Buffer.from(input.secret ?? input.link.secret, 'base64url'))
    .update(`ftown-pair-proof-v2\n${input.proofAccountId ?? input.accountId}\n${input.proofHead ?? input.head}\n${input.proofRequestId ?? requestId}`)
    .digest('base64url');
  const proof = input.proofText ? input.proofText(mac) : mac;
  const recipient: EndpointPublic = input.recipient ?? {
    version: 1, id: b64(sha256(Buffer.from(request.endpointPublicKey, 'base64url'))), ownerId: owner, kind: 'bridge', publicKey: request.endpointPublicKey,
  };
  const from: EndpointIdentity = { endpoint: { ...input.sender.endpoint, ownerId: owner }, keyPair: input.sender.keyPair };
  const envelope = await seal(from, recipient, {
    type: 'ftown_encrypted', version: 1, senderId: from.endpoint.id, recipientId: recipient.id, ownerId: owner,
    bridgeId: request.bridgeId, channel: `ftown-pair:${request.requestId}`, purpose: 'enrolled', messageId: request.requestId,
    createdAt: SEAL_AT, expiresAt: request.expiresAt, receiverEpoch: null,
  }, new TextEncoder().encode(JSON.stringify({ version: input.bundleVersion ?? 2, requestId, accountId: input.accountId, head: input.head, proof })));
  return JSON.stringify({ version: 2, sender: from.endpoint, envelope });
}

const fixedRequest = (): BridgePairRequest => ({
  version: 2, requestId: b64(new Uint8Array(32).fill(1)), bridgeId: 'studio',
  endpointPublicKey: b64(new Uint8Array([4, ...new Array<number>(64).fill(2)])),
  authPublicKey: b64(new Uint8Array([4, ...new Array<number>(64).fill(3)])), label: 'Studio Mac', expiresAt: NOW + PAIR_LIFETIME_MS,
});

// ---- End to end ----------------------------------------------------------------------------------------------------------------

test('happy path: request, link, comparison code, passkey approval, seal, open, confirm', async () => {
  const { chain, bridge, received, entry, sender } = await approved();
  assert.deepEqual(received, bridge.link);
  assert.equal(await pairComparisonCode(received.request), await pairComparisonCode(bridge.link.request));
  assert.deepEqual(entry.endpoint, { ...bridge.identity.endpoint, ownerId: chain.accountId });
  const sealed = await sealPairApproval(received, chain.ledger, sender, SEAL_AT);
  assert.equal(typeof sealed, 'string');
  assert.equal(sealed.indexOf(bridge.link.secret), -1);
  // The bundle no longer carries the ledger: the whole sealed string is small and independent of the ledger size.
  assert.ok(sealed.length < 2048, String(sealed.length));
  const approval = await openPairApproval(sealed, bridge.link, bridge.identity, OPEN_AT);
  assert.deepEqual(approval, await approvalOf(chain));
  const checkpoint = await confirmPairedLedger(bridge.link, approval, chain.ledger, CONFIRM_AT);
  assert.equal(checkpoint.accountId, chain.accountId);
  assert.equal(checkpoint.head, approval.head);
  assert.deepEqual(checkpoint.bridges, [entry]);
  // Accepted up to and including the expiry instant.
  assert.deepEqual(await openPairApproval(sealed, bridge.link, bridge.identity, bridge.link.request.expiresAt), approval);
});

test('sealing a ledger with records after add_bridge approves its last head', async () => {
  const { passkey, chain, bridge, sender } = await approved();
  const longer = await append(chain, passkey, await deviceOp(chain.accountId));
  const approval = await openPairApproval(await sealPairApproval(bridge.link, longer.ledger, sender, SEAL_AT), bridge.link, bridge.identity, OPEN_AT);
  assert.deepEqual(approval, await approvalOf(longer));
  assert.equal((await confirmPairedLedger(bridge.link, approval, longer.ledger, CONFIRM_AT)).revision, 2);
});

test('the independent forger reproduces the real wire format and proof (so the rejections below test openPairApproval)', async () => {
  const { chain, bridge, sender } = await approved();
  const approval = await approvalOf(chain);
  assert.deepEqual(await openPairApproval(await forge({ link: bridge.link, sender, ...approval }), bridge.link, bridge.identity, OPEN_AT), approval);
});

// ---- Link, request, code ------------------------------------------------------------------------------------------------------

test('createBridgePairRequest: random 32-byte requestId and secret, default and maximum lifetime of 10 minutes', async () => {
  const { identity, auth, link } = await newBridge();
  assert.equal(link.request.version, 2);
  assert.equal(Buffer.from(link.request.requestId, 'base64url').length, 32);
  assert.equal(Buffer.from(link.secret, 'base64url').length, 32);
  assert.notEqual(link.request.requestId, link.secret);
  assert.equal(link.request.expiresAt, NOW + 600000);
  assert.equal(link.request.endpointPublicKey, identity.endpoint.publicKey);
  assert.equal(link.request.authPublicKey, auth.publicKey);
  const base = { bridgeId: 'studio', endpointPublicKey: identity.endpoint.publicKey, authPublicKey: auth.publicKey, label: 'Studio Mac' };
  const again = createBridgePairRequest({ ...base, now: NOW });
  assert.notEqual(again.request.requestId, link.request.requestId);
  assert.notEqual(again.secret, link.secret);
  assert.equal(createBridgePairRequest({ ...base, now: NOW, lifetimeMs: 600000 }).request.expiresAt, NOW + 600000);
  assert.equal(createBridgePairRequest({ ...base, now: NOW, lifetimeMs: 1 }).request.expiresAt, NOW + 1);
  const before = Date.now();
  const live = createBridgePairRequest(base).request.expiresAt;
  assert.ok(live >= before + PAIR_LIFETIME_MS && live <= Date.now() + PAIR_LIFETIME_MS);
  assert.equal(createBridgePairRequest({ ...base, label: ch(0xe9).repeat(200) }).request.label.length, 200);
  for (const bad of [
    { lifetimeMs: 600001 }, { lifetimeMs: 0 }, { lifetimeMs: -1 }, { lifetimeMs: 1.5 }, { lifetimeMs: Number.NaN }, { now: -1 }, { now: 1.5 },
    { bridgeId: '' }, { bridgeId: 'has space' }, { bridgeId: 'a'.repeat(201) }, { label: 'x'.repeat(201) }, { label: `a${ch(10)}b` },
    { label: `a${ch(0x85)}b` }, { label: ch(0xd800) }, { label: `a${ch(0x200b)}b` }, { label: `a${ch(0x202e)}b` }, { label: `a${ch(0x2066)}b` },
    { label: `${ch(0xfeff)}a` }, { authPublicKey: identity.endpoint.publicKey }, { endpointPublicKey: randomB64(64) },
    { authPublicKey: b64(new Uint8Array([2, ...crypto.getRandomValues(new Uint8Array(64))])) }, { endpointPublicKey: `${identity.endpoint.publicKey}=` },
  ]) assert.throws(() => createBridgePairRequest({ ...base, now: NOW, ...bad }), LINK_ERROR, JSON.stringify(bad));
});

test('encodePairLink / parsePairLink: compact base64url JSON, with or without #req=', async () => {
  const { link } = await newBridge('studio', `Mesa do caf${ch(0xe9)} ${ch(0x2615)}`);
  const encoded = encodePairLink(link);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')), link);
  assert.deepEqual(parsePairLink(encoded), link);
  assert.deepEqual(parsePairLink(`#req=${encoded}`), link);
  const longest = { ...link, request: { ...link.request, bridgeId: 'b'.repeat(200), label: String.fromCodePoint(0x1f510).repeat(100) } };
  assert.deepEqual(parsePairLink(encodePairLink(longest)), longest);
});

test('malformed links are rejected with invalid_pair_link', async () => {
  const { link } = await newBridge();
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const request = link.request;
  const encoded = encodePairLink(link);
  const variants: unknown[] = [
    { ...link, extra: 1 }, { request }, { ...link, secret: randomB64(31) }, { ...link, secret: randomB64(33) },
    { ...link, request: { ...request, version: 1 } }, { ...link, request: { ...request, extra: true } },
    { ...link, request: { ...request, requestId: randomB64(31) } }, { ...link, request: { ...request, requestId: `${request.requestId}=` } },
    { ...link, request: { ...request, endpointPublicKey: randomB64(64) } },
    { ...link, request: { ...request, endpointPublicKey: b64(new Uint8Array([3, ...crypto.getRandomValues(new Uint8Array(64))])) } },
    { ...link, request: { ...request, authPublicKey: randomB64(66) } }, { ...link, request: { ...request, authPublicKey: request.endpointPublicKey } },
    { ...link, request: { ...request, label: 'y'.repeat(201) } }, { ...link, request: { ...request, label: `tab${ch(9)}here` } },
    { ...link, request: { ...request, label: `del${ch(0x7f)}` } }, { ...link, request: { ...request, label: `lone ${ch(0xdc00)}` } },
    { ...link, request: { ...request, label: `zero${ch(0x200d)}width` } }, { ...link, request: { ...request, label: `bidi${ch(0x202b)}` } },
    { ...link, request: { ...request, label: 7 } }, { ...link, request: { ...request, bridgeId: 'a/b' } },
    { ...link, request: { ...request, expiresAt: '1' } }, { ...link, request: { ...request, expiresAt: -1 } },
    { ...link, request: { ...request, expiresAt: 1.5 } }, [link], null, 'link',
  ];
  for (const value of variants) {
    assert.throws(() => parsePairLink(encode(value)), LINK_ERROR, JSON.stringify(value));
    assert.throws(() => encodePairLink(value as BridgePairLink), LINK_ERROR, JSON.stringify(value));
  }
  const proto = `{"request":${JSON.stringify(request)},"secret":"${link.secret}","__proto__":{}}`;
  for (const fragment of [
    '', '#req=', '#req', '#link=' + encoded, `${encoded}=`, `${encoded}+`, encoded.slice(0, -1) + (encoded.endsWith('A') ? 'B' : 'A'),
    `#req=#req=${encoded}`, ' ' + encoded, Buffer.from('not json').toString('base64url'), Buffer.from(proto).toString('base64url'),
    Buffer.from([0xff, 0xfe]).toString('base64url'), 'A'.repeat(4000),
  ]) assert.throws(() => parsePairLink(fragment), LINK_ERROR, fragment.slice(0, 40));
  assert.throws(() => parsePairLink(42 as unknown as string), LINK_ERROR);
  await assert.rejects(pairComparisonCode({ ...request, version: 1 } as unknown as BridgePairRequest), LINK_ERROR);
  await assert.rejects(bridgeFromPairRequest({ ...request, label: `a${ch(10)}b` }, randomB64(32), NOW), LINK_ERROR);
});

test('pairComparisonCode: 6 digits from SHA-256 of the canonical request, stable, and sensitive to every field', async () => {
  const expectedCode = (value: BridgePairRequest): string => {
    const canonical = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${JSON.stringify(value[key as keyof BridgePairRequest])}`).join(',')}}`;
    return String(sha256(`ftown-pair-code-v2\n${canonical}`).readUInt32BE(0) % 1000000).padStart(6, '0');
  };
  const request = fixedRequest();
  const code = await pairComparisonCode(request);
  assert.match(code, /^\d{6}$/);
  assert.equal(code, expectedCode(request));
  assert.equal(await pairComparisonCode(fixedRequest()), code);
  const reordered: BridgePairRequest = {
    expiresAt: request.expiresAt, label: request.label, authPublicKey: request.authPublicKey, endpointPublicKey: request.endpointPublicKey,
    bridgeId: request.bridgeId, requestId: request.requestId, version: 2,
  };
  assert.equal(await pairComparisonCode(reordered), code);
  const changes: Partial<BridgePairRequest>[] = [
    { requestId: b64(new Uint8Array(32).fill(9)) }, { bridgeId: 'studio2' },
    { endpointPublicKey: b64(new Uint8Array([4, ...new Array<number>(64).fill(7)])) },
    { authPublicKey: b64(new Uint8Array([4, ...new Array<number>(64).fill(8)])) }, { label: 'Studio Mac.' }, { expiresAt: request.expiresAt + 1 },
  ];
  assert.equal(changes.length, Object.keys(request).length - 1);
  for (const change of changes) assert.notEqual(await pairComparisonCode({ ...request, ...change }), code, JSON.stringify(change));
  // Leading zeros are kept: deterministic requests, about 1 in 10 hashes below 100000.
  let zeroLed = 0;
  for (let index = 1; index <= 200; index += 1) {
    const candidate = { ...request, expiresAt: request.expiresAt + index };
    const digits = await pairComparisonCode(candidate);
    assert.equal(digits, expectedCode(candidate));
    if (digits[0] === '0') zeroLed += 1;
  }
  assert.ok(zeroLed > 0);
});

test('bridgeFromPairRequest builds the ledger bridge: endpoint id = SHA-256(raw key), owner = accountId, kind bridge', async () => {
  const request = { ...fixedRequest(), endpointPublicKey: await ecdhKey() };
  const accountId = randomB64(32);
  const bridge: LedgerBridge = await bridgeFromPairRequest(request, accountId, NOW);
  assert.deepEqual(bridge, {
    bridgeId: 'studio',
    endpoint: { version: 1, id: b64(sha256(Buffer.from(request.endpointPublicKey, 'base64url'))), ownerId: accountId, kind: 'bridge', publicKey: request.endpointPublicKey },
    authPublicKey: request.authPublicKey, label: 'Studio Mac', approvedAt: NOW,
  });
  for (const bad of ['', randomB64(31), `${accountId}=`, '349f8d2e-38e4-4d59-888d-687dcfa19e39']) {
    await assert.rejects(bridgeFromPairRequest(request, bad, NOW), LINK_ERROR);
  }
  await assert.rejects(bridgeFromPairRequest(request, accountId, -1), LINK_ERROR);
});

// ---- openPairApproval ---------------------------------------------------------------------------------------------------------

test('open rejects an expired request; seal refuses one', async () => {
  const { chain, bridge, sender } = await approved();
  const expiresAt = bridge.link.request.expiresAt;
  const sealed = await sealPairApproval(bridge.link, chain.ledger, sender, SEAL_AT);
  await assert.rejects(openPairApproval(sealed, bridge.link, bridge.identity, expiresAt + 1), APPROVAL_ERROR);
  await assert.rejects(openPairApproval(sealed, bridge.link, bridge.identity, expiresAt + 3_600_000), APPROVAL_ERROR);
  await assert.rejects(sealPairApproval(bridge.link, chain.ledger, sender, expiresAt), LINK_ERROR);
});

test('open rejects a wrong requestId', async () => {
  const { chain, bridge, sender } = await approved();
  const approval = await approvalOf(chain);
  await assert.rejects(openPairApproval(await forge({ link: bridge.link, sender, ...approval, bundleRequestId: randomB64(32) }), bridge.link, bridge.identity, OPEN_AT), APPROVAL_ERROR);
  // A bundle for another request of the same bridge (same keys and bridgeId, new requestId and secret).
  const { bridgeId, endpointPublicKey, authPublicKey, label } = bridge.link.request;
  const other = createBridgePairRequest({ bridgeId, endpointPublicKey, authPublicKey, label, now: NOW });
  const sealed = await sealPairApproval(bridge.link, chain.ledger, sender, SEAL_AT);
  await assert.rejects(openPairApproval(sealed, other, bridge.identity, OPEN_AT), APPROVAL_ERROR);
  await assert.rejects(openPairApproval(sealed, { request: other.request, secret: bridge.link.secret }, bridge.identity, OPEN_AT), APPROVAL_ERROR);
});

test('open rejects a wrong secret: an attacker with the request but not the secret', async () => {
  const { chain, bridge, sender } = await approved();
  const guessed: BridgePairLink = { request: bridge.link.request, secret: randomB64(32) };
  await assert.rejects(openPairApproval(await sealPairApproval(guessed, chain.ledger, sender, SEAL_AT), bridge.link, bridge.identity, OPEN_AT), APPROVAL_ERROR);
  await assert.rejects(openPairApproval(await forge({ link: guessed, sender, ...await approvalOf(chain) }), bridge.link, bridge.identity, OPEN_AT), APPROVAL_ERROR);
});

test('open rejects a server that swaps in ANOTHER account (valid ledger with the same bridge request) without the secret', async () => {
  const { bridge } = await approved();
  const { passkey: theirPasskey, chain: theirStart } = await account();
  const theirEntry = await bridgeFromPairRequest(bridge.link.request, theirStart.accountId, NOW);
  const theirs = await append(theirStart, theirPasskey, { type: 'add_bridge', bridge: theirEntry });
  const theirSender = await browserOf(theirs.accountId);
  const noSecret: BridgePairLink = { request: bridge.link.request, secret: randomB64(32) };
  await assert.rejects(openPairApproval(await sealPairApproval(noSecret, theirs.ledger, theirSender, SEAL_AT), bridge.link, bridge.identity, OPEN_AT), APPROVAL_ERROR);
  await assert.rejects(openPairApproval(await forge({ link: noSecret, sender: theirSender, ...await approvalOf(theirs) }), bridge.link, bridge.identity, OPEN_AT), APPROVAL_ERROR);
  // The secret is what decides the account: whoever holds it can approve into their own account. This is the guard under test.
  const withSecret = await openPairApproval(await sealPairApproval(bridge.link, theirs.ledger, theirSender, SEAL_AT), bridge.link, bridge.identity, OPEN_AT);
  assert.equal((await confirmPairedLedger(bridge.link, withSecret, theirs.ledger, CONFIRM_AT)).accountId, theirs.accountId);
});

test('open rejects a proof computed for a different head, account or requestId than the bundle carries', async () => {
  const { passkey, chain, bridge, sender } = await approved();
  const approval = await approvalOf(chain);
  const longer = await approvalOf(await append(chain, passkey, await deviceOp(chain.accountId)));
  const cases: Partial<ForgeInput>[] = [
    { proofHead: longer.head }, { proofHead: chain.accountId }, { proofHead: randomB64(32) },
    { head: longer.head, proofHead: approval.head }, { proofAccountId: randomB64(32) }, { proofRequestId: randomB64(32) },
  ];
  for (const change of cases) {
    const sealed = await forge({ link: bridge.link, sender, ...approval, ...change });
    await assert.rejects(openPairApproval(sealed, bridge.link, bridge.identity, OPEN_AT), APPROVAL_ERROR, JSON.stringify(change));
  }
  // The bundle's accountId must equal the envelope's (authenticated) owner, even with a matching proof.
  const otherOwner = randomB64(32);
  await assert.rejects(openPairApproval(await forge({ link: bridge.link, sender, ...approval, envelopeOwner: otherOwner }), bridge.link, bridge.identity, OPEN_AT), APPROVAL_ERROR);
  // Malformed bundle values.
  for (const change of [{ head: 'short' }, { accountId: 'short', envelopeOwner: approval.accountId }]) {
    await assert.rejects(openPairApproval(await forge({ link: bridge.link, sender, ...approval, ...change }), bridge.link, bridge.identity, OPEN_AT), APPROVAL_ERROR);
  }
  assert.deepEqual(await openPairApproval(await forge({ link: bridge.link, sender, ...approval }), bridge.link, bridge.identity, OPEN_AT), approval);
});

test('an approval sealed to a different endpoint cannot be opened, nor opened by a different identity', async () => {
  const { chain, bridge, sender } = await approved();
  const attacker = await generateEndpoint(chain.accountId, 'bridge');
  const toAttacker = await forge({ link: bridge.link, sender, ...await approvalOf(chain), recipient: attacker.endpoint });
  await assert.rejects(openPairApproval(toAttacker, bridge.link, bridge.identity, OPEN_AT), APPROVAL_ERROR);
  const elsewhere = await newBridge();
  const sealed = await sealPairApproval(bridge.link, chain.ledger, sender, SEAL_AT);
  await assert.rejects(openPairApproval(sealed, bridge.link, elsewhere.identity, OPEN_AT), APPROVAL_ERROR);
  await assert.rejects(openPairApproval(sealed, { request: { ...bridge.link.request, endpointPublicKey: elsewhere.identity.endpoint.publicKey }, secret: bridge.link.secret }, elsewhere.identity, OPEN_AT), APPROVAL_ERROR);
  // Same public endpoint but a private key that does not match it.
  const mismatched: EndpointIdentity = { endpoint: bridge.identity.endpoint, keyPair: elsewhere.identity.keyPair };
  await assert.rejects(openPairApproval(sealed, bridge.link, mismatched, OPEN_AT), APPROVAL_ERROR);
});

test('malformed sealed approvals are rejected', async () => {
  const { chain, bridge, sender } = await approved();
  const sealed = await sealPairApproval(bridge.link, chain.ledger, sender, SEAL_AT);
  const wire = JSON.parse(sealed) as { version: number; sender: EndpointPublic; envelope: Record<string, unknown> };
  const impostor = await browserOf(chain.accountId);
  const flip = (text: string): string => (text[10] === 'A' ? `${text.slice(0, 10)}B${text.slice(11)}` : `${text.slice(0, 10)}A${text.slice(11)}`);
  const variants: unknown[] = [
    '', 'null', '{}', sealed.slice(0, -1), `${sealed} `.repeat(2), JSON.stringify({ ...wire, version: 1 }), JSON.stringify({ ...wire, extra: true }),
    JSON.stringify({ version: 2, envelope: wire.envelope }), JSON.stringify({ ...wire, sender: impostor.endpoint }),
    JSON.stringify({ ...wire, sender: { ...wire.sender, kind: 'server' } }),
    JSON.stringify({ ...wire, envelope: { ...wire.envelope, ciphertext: flip(String(wire.envelope.ciphertext)) } }),
    JSON.stringify({ ...wire, envelope: { ...wire.envelope, receiverEpoch: 'epoch' } }),
    JSON.stringify({ ...wire, envelope: { ...wire.envelope, messageId: randomB64(32) } }),
    JSON.stringify({ ...wire, envelope: { ...wire.envelope, channel: 'ftown-pair:other' } }),
    `"${'x'.repeat(10_000)}"`, 42, null,
  ];
  for (const value of variants) {
    await assert.rejects(openPairApproval(value as string, bridge.link, bridge.identity, OPEN_AT), APPROVAL_ERROR, String(value).slice(0, 60));
  }
  await assert.rejects(openPairApproval(sealed, { ...bridge.link, secret: 'short' }, bridge.identity, OPEN_AT), APPROVAL_ERROR);
  await assert.rejects(sealPairApproval({ ...bridge.link, secret: 'short' }, chain.ledger, sender, SEAL_AT), LINK_ERROR);
  await openPairApproval(sealed, bridge.link, bridge.identity, OPEN_AT);
});

test('seal refuses a ledger that does not verify, lacks this bridge, or revoked it', async () => {
  const { passkey, start, chain, bridge, sender } = await approved();
  const withoutBridge = await append(start, passkey, await deviceOp(start.accountId));
  const otherAuth = await bridgeFromPairRequest({ ...bridge.link.request, authPublicKey: (await generateAuthKey(false)).publicKey }, start.accountId, NOW);
  const wrongKey = await append(start, passkey, { type: 'add_bridge', bridge: otherAuth });
  const revoked = await append(chain, passkey, { type: 'revoke_bridge', bridgeId: 'studio' });
  const tampered = structuredClone(chain.ledger);
  tampered.transitions[0].payload.issuedAt += 1;
  for (const ledger of [start.ledger, withoutBridge.ledger, wrongKey.ledger, revoked.ledger, tampered]) {
    await assert.rejects(sealPairApproval(bridge.link, ledger, sender, SEAL_AT), APPROVAL_ERROR);
  }
});

// ---- confirmPairedLedger ------------------------------------------------------------------------------------------------------

test('confirm accepts a ledger that grew after the approval', async () => {
  const { passkey, chain, bridge } = await approved();
  const approval = await approvalOf(chain);
  const grown = await append(await append(chain, passkey, await deviceOp(chain.accountId)), passkey, await deviceOp(chain.accountId));
  const checkpoint = await confirmPairedLedger(bridge.link, approval, grown.ledger, CONFIRM_AT);
  assert.equal(checkpoint.revision, 3);
  assert.equal(checkpoint.head, await lastHead(grown.ledger));
  // The approval head may also be the add_bridge record itself in a longer chain, or any later record.
  const middle = { accountId: chain.accountId, head: await ledgerHead(grown.ledger.transitions[1].payload) };
  assert.equal((await confirmPairedLedger(bridge.link, middle, grown.ledger, CONFIRM_AT)).revision, 3);
});

test('confirm rejects a ledger of another account with a matching bridge (accountId mismatch)', async () => {
  const { chain, bridge } = await approved();
  const { passkey: theirPasskey, chain: theirStart } = await account();
  const theirs = await append(theirStart, theirPasskey, { type: 'add_bridge', bridge: await bridgeFromPairRequest(bridge.link.request, theirStart.accountId, NOW) });
  const mine = await approvalOf(chain);
  // What a lying server does after a genuine approval: serve the other account's ledger.
  await assert.rejects(confirmPairedLedger(bridge.link, mine, theirs.ledger, CONFIRM_AT), APPROVAL_ERROR);
  // The accountId match stands on its own, even when the approved head is in that chain.
  await assert.rejects(confirmPairedLedger(bridge.link, { accountId: mine.accountId, head: await lastHead(theirs.ledger) }, theirs.ledger, CONFIRM_AT), APPROVAL_ERROR);
  assert.equal((await confirmPairedLedger(bridge.link, await approvalOf(theirs), theirs.ledger, CONFIRM_AT)).accountId, theirs.accountId);
});

test('confirm rejects a ledger that does not contain approval.head', async () => {
  const { passkey, chain, bridge } = await approved();
  // A fork of the same account after add_bridge: the approval was made on one branch, the server serves the other.
  const branchA = await append(chain, passkey, await deviceOp(chain.accountId));
  const branchB = await append(chain, passkey, await deviceOp(chain.accountId));
  const approval = await approvalOf(branchA);
  await assert.rejects(confirmPairedLedger(bridge.link, approval, branchB.ledger, CONFIRM_AT), APPROVAL_ERROR);
  // A shorter chain (the approval is ahead of it) and an unknown head.
  await assert.rejects(confirmPairedLedger(bridge.link, approval, chain.ledger, CONFIRM_AT), APPROVAL_ERROR);
  await assert.rejects(confirmPairedLedger(bridge.link, { accountId: chain.accountId, head: randomB64(32) }, branchA.ledger, CONFIRM_AT), APPROVAL_ERROR);
  await confirmPairedLedger(bridge.link, approval, branchA.ledger, CONFIRM_AT);
});

test('confirm rejects a bridge revoked after the approval', async () => {
  const { passkey, chain, bridge } = await approved();
  const approval = await approvalOf(chain);
  const revoked = await append(chain, passkey, { type: 'revoke_bridge', bridgeId: 'studio' });
  const later = await append(revoked, passkey, await deviceOp(chain.accountId));
  for (const ledger of [revoked.ledger, later.ledger]) {
    await assert.rejects(confirmPairedLedger(bridge.link, approval, ledger, CONFIRM_AT), APPROVAL_ERROR);
  }
  await assert.rejects(confirmPairedLedger(bridge.link, await approvalOf(later), later.ledger, CONFIRM_AT), APPROVAL_ERROR);
});

test('confirm rejects an add_bridge that appears only after approval.head', async () => {
  const { passkey, start, bridge } = await approved();
  const beforeBridge = await append(start, passkey, await deviceOp(start.accountId));
  const entry = await bridgeFromPairRequest(bridge.link.request, start.accountId, NOW);
  const withBridge = await append(beforeBridge, passkey, { type: 'add_bridge', bridge: entry });
  for (const approval of [await approvalOf(start), await approvalOf(beforeBridge)]) {
    await assert.rejects(confirmPairedLedger(bridge.link, approval, withBridge.ledger, CONFIRM_AT), APPROVAL_ERROR);
  }
  await confirmPairedLedger(bridge.link, await approvalOf(withBridge), withBridge.ledger, CONFIRM_AT);
});

test('confirm rejects a bridge that is not exactly this request\'s', async () => {
  const { passkey, start, bridge } = await approved();
  const changes: Partial<BridgePairRequest>[] = [
    { authPublicKey: (await generateAuthKey(false)).publicKey }, { endpointPublicKey: await ecdhKey() }, { bridgeId: 'studio-2' },
  ];
  for (const change of changes) {
    const entry = await bridgeFromPairRequest({ ...bridge.link.request, ...change }, start.accountId, NOW);
    const chain = await append(start, passkey, { type: 'add_bridge', bridge: entry });
    await assert.rejects(confirmPairedLedger(bridge.link, await approvalOf(chain), chain.ledger, CONFIRM_AT), APPROVAL_ERROR, JSON.stringify(change));
  }
  const noBridge = await append(start, passkey, await deviceOp(start.accountId));
  await assert.rejects(confirmPairedLedger(bridge.link, await approvalOf(noBridge), noBridge.ledger, CONFIRM_AT), APPROVAL_ERROR);
  await assert.rejects(confirmPairedLedger(bridge.link, await approvalOf(start), start.ledger, CONFIRM_AT), APPROVAL_ERROR);
});

test('confirm rejects a tampered ledger and malformed inputs', async () => {
  const { chain, bridge } = await approved();
  const approval = await approvalOf(chain);
  const edits: ((copy: Ledger) => void)[] = [
    copy => { const op = copy.transitions[0].payload.operation; if (op.type === 'add_bridge') op.bridge.label = 'Evil Mac'; },
    copy => { copy.genesis.payload.origins = ['https://evil.example']; },
    copy => { copy.transitions[0].signature.signature = copy.genesis.signature.signature; },
    copy => { copy.transitions[0].payload.issuedAt += 1; },
  ];
  for (const edit of edits) {
    const tampered = structuredClone(chain.ledger);
    edit(tampered);
    await assert.rejects(confirmPairedLedger(bridge.link, approval, tampered, CONFIRM_AT), APPROVAL_ERROR);
  }
  await assert.rejects(confirmPairedLedger(bridge.link, approval, { ...structuredClone(chain.ledger), extra: true } as Ledger, CONFIRM_AT), APPROVAL_ERROR);
  for (const bad of [{ ...approval, head: 'short' }, { ...approval, accountId: `${approval.accountId}=` }, null]) {
    await assert.rejects(confirmPairedLedger(bridge.link, bad as PairApproval, chain.ledger, CONFIRM_AT), APPROVAL_ERROR);
  }
  await assert.rejects(confirmPairedLedger({ ...bridge.link, secret: 'short' }, approval, chain.ledger, CONFIRM_AT), APPROVAL_ERROR);
  await assert.rejects(confirmPairedLedger(bridge.link, approval, chain.ledger, -1), APPROVAL_ERROR);
  await confirmPairedLedger(bridge.link, approval, chain.ledger, CONFIRM_AT);
});

test('confirm requires an approval of exactly {accountId, head}: extra keys are rejected', async () => {
  const { chain, bridge } = await approved();
  const approval = await approvalOf(chain);
  for (const bad of [{ ...approval, extra: 1 }, { ...approval, revision: 1 }, { accountId: approval.accountId }]) {
    await assert.rejects(confirmPairedLedger(bridge.link, bad as PairApproval, chain.ledger, CONFIRM_AT), APPROVAL_ERROR, JSON.stringify(bad));
  }
  await confirmPairedLedger(bridge.link, { head: approval.head, accountId: approval.accountId }, chain.ledger, CONFIRM_AT);
});

test('confirm applies sticky revocations: a bridge revoked in any chain this replica saw never pairs', async () => {
  const { passkey, chain, bridge } = await approved();
  const approval = await approvalOf(chain);
  const grown = await append(chain, passkey, await deviceOp(chain.accountId));
  // The chain itself does not revoke the bridge; the replica saw a revocation elsewhere (for example on a losing fork).
  for (const ledger of [chain.ledger, grown.ledger]) {
    await assert.rejects(confirmPairedLedger(bridge.link, approval, ledger, CONFIRM_AT, { deviceIds: [], bridgeIds: ['studio'] }), APPROVAL_ERROR);
    await assert.rejects(confirmPairedLedger(bridge.link, approval, ledger, CONFIRM_AT, { deviceIds: [randomB64(32)], bridgeIds: ['other', 'studio'] }), APPROVAL_ERROR);
  }
  // Unrelated sticky ids do not matter, and the RAW chain checkpoint is returned (the bridge is still in it).
  const raw = await verifyLedger(grown.ledger, CONFIRM_AT);
  const unrelated = { deviceIds: [raw.devices[0].endpoint.id], bridgeIds: ['other'] };
  assert.deepEqual(await confirmPairedLedger(bridge.link, approval, grown.ledger, CONFIRM_AT, unrelated), raw);
  assert.deepEqual(await confirmPairedLedger(bridge.link, approval, grown.ledger, CONFIRM_AT, { deviceIds: [], bridgeIds: [] }), raw);
  // A malformed sticky set is a failure, not an empty set.
  for (const bad of [{ deviceIds: [], bridgeIds: ['has space'] }, { deviceIds: ['short'], bridgeIds: [] }, { bridgeIds: [] }]) {
    await assert.rejects(confirmPairedLedger(bridge.link, approval, chain.ledger, CONFIRM_AT, bad as { deviceIds: string[]; bridgeIds: string[] }), APPROVAL_ERROR);
  }
});

test('open rejects a bundle whose requestId or version is wrong even when the proof is over the link requestId', async () => {
  const { chain, bridge, sender } = await approved();
  const approval = await approvalOf(chain);
  const own = bridge.link.request.requestId;
  await assert.rejects(openPairApproval(await forge({ link: bridge.link, sender, ...approval, bundleRequestId: randomB64(32), proofRequestId: own }), bridge.link, bridge.identity, OPEN_AT), APPROVAL_ERROR);
  for (const bundleVersion of [1, 3]) {
    await assert.rejects(openPairApproval(await forge({ link: bridge.link, sender, ...approval, bundleVersion }), bridge.link, bridge.identity, OPEN_AT), APPROVAL_ERROR);
  }
  assert.deepEqual(await openPairApproval(await forge({ link: bridge.link, sender, ...approval, bundleVersion: 2 }), bridge.link, bridge.identity, OPEN_AT), approval);
});

test('base64url is canonical only: padding bits set in the last character are rejected everywhere', async () => {
  const { chain, bridge, sender } = await approved();
  const approval = await approvalOf(chain);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const link = bridge.link;
  assert.throws(() => parsePairLink(encode({ ...link, secret: nonCanonical(link.secret) })), LINK_ERROR);
  assert.throws(() => parsePairLink(encode({ ...link, request: { ...link.request, requestId: nonCanonical(link.request.requestId) } })), LINK_ERROR);
  assert.deepEqual(parsePairLink(encode(link)), link);
  await assert.rejects(openPairApproval(await forge({ link, sender, ...approval, proofText: nonCanonical }), link, bridge.identity, OPEN_AT), APPROVAL_ERROR);
  await assert.rejects(confirmPairedLedger(link, { ...approval, head: nonCanonical(approval.head) }, chain.ledger, CONFIRM_AT), APPROVAL_ERROR);
  await assert.rejects(bridgeFromPairRequest(link.request, nonCanonical(chain.accountId), NOW), LINK_ERROR);
});

test('the sealed string is size-capped before parsing, even when its JSON would be valid', async () => {
  const { chain, bridge, sender } = await approved();
  const sealed = await sealPairApproval(bridge.link, chain.ledger, sender, SEAL_AT);
  assert.deepEqual(await openPairApproval(`${sealed}${' '.repeat(64)}`, bridge.link, bridge.identity, OPEN_AT), await approvalOf(chain));
  await assert.rejects(openPairApproval(`${sealed}${' '.repeat(16384)}`, bridge.link, bridge.identity, OPEN_AT), APPROVAL_ERROR);
});

test('without WebCrypto (insecure context) every crypto entry point throws secure_context_required', async () => {
  const { chain, bridge, sender } = await approved();
  const sealed = await sealPairApproval(bridge.link, chain.ledger, sender, SEAL_AT);
  const approval = await approvalOf(chain);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  assert.ok(descriptor);
  const real = globalThis.crypto;
  const SECURE = { message: 'secure_context_required' };
  const stubs: unknown[] = [{ getRandomValues: real.getRandomValues.bind(real) }, { getRandomValues: real.getRandomValues.bind(real), subtle: undefined }, undefined];
  try {
    for (const stub of stubs) {
      Object.defineProperty(globalThis, 'crypto', { value: stub, configurable: true, writable: true });
      await assert.rejects(pairComparisonCode(bridge.link.request), SECURE);
      await assert.rejects(bridgeFromPairRequest(bridge.link.request, chain.accountId, NOW), SECURE);
      await assert.rejects(sealPairApproval(bridge.link, chain.ledger, sender, SEAL_AT), SECURE);
      await assert.rejects(openPairApproval(sealed, bridge.link, bridge.identity, OPEN_AT), SECURE);
      await assert.rejects(confirmPairedLedger(bridge.link, approval, chain.ledger, CONFIRM_AT), SECURE);
      // Checked first: even malformed input reports the missing secure context.
      await assert.rejects(pairComparisonCode(null as unknown as BridgePairRequest), SECURE);
      await assert.rejects(openPairApproval('', bridge.link, bridge.identity, OPEN_AT), SECURE);
    }
  } finally {
    Object.defineProperty(globalThis, 'crypto', descriptor);
  }
  assert.equal(globalThis.crypto, real);
  assert.deepEqual(await openPairApproval(sealed, bridge.link, bridge.identity, OPEN_AT), approval);
});
