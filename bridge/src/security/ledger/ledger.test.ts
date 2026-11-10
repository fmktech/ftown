import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { EndpointPublic } from '../protocol.js';
import { AUTHORITY_CONSENT_DOMAIN, LEDGER_DOMAIN, LEDGER_LIMITS, SIGNIN_DOMAIN } from './protocol.js';
import type {
  Ledger, LedgerAuthority, LedgerBridge, LedgerCheckpoint, LedgerDevice, LedgerGenesis, LedgerOperation, LedgerTransition, PasskeySignature, Signed,
} from './protocol.js';
import {
  LedgerError, accountIdOf, applyRevocations, authorityConsentChallenge, chooseLedger, ledgerChallenge, ledgerHead, ledgerLastIssuedAt, ledgerRevocations, nextTransition,
  parseLedger, signInChallenge, verifyLedger,
} from './ledger.js';
import type { LedgerCache, LedgerChoice, LedgerDiscarded, LedgerErrorCode, LedgerRelation } from './ledger.js';
import { createSoftPasskey } from './testing.js';
import type { SoftPasskey } from './testing.js';

const rpId = 'ftown.example';
const origin = 'https://ftown.example';
const T0 = 1_750_000_000_000;
const NOW = T0 + 3_600_000;
const SKEW = LEDGER_LIMITS.maxFutureSkewMs;
const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64url');
const sha256 = (data: Uint8Array | string): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest());
const randomB64 = (length: number): string => b64(crypto.getRandomValues(new Uint8Array(length)));
const offCurvePoint = (): string => b64(new Uint8Array([4, ...crypto.getRandomValues(new Uint8Array(64))]));

type SignOptions = Parameters<SoftPasskey['sign']>[1];
interface Chain { ledger: Ledger; accountId: string; head: string; issuedAt: number }

const newPasskey = (): Promise<SoftPasskey> => createSoftPasskey({ rpId, origin });
async function signed<T extends LedgerGenesis | LedgerTransition>(passkey: SoftPasskey, payload: T, options?: SignOptions): Promise<Signed<T>> {
  return { payload, signature: await passkey.sign(await ledgerChallenge(payload), options) };
}
function authorityOf(passkey: SoftPasskey, label: string, addedAt = T0): LedgerAuthority {
  return { credentialId: passkey.credentialId, publicKey: passkey.publicKey, label, addedAt };
}
type AddAuthority = Extract<LedgerOperation, { type: 'add_authority' }>;
/** `passkey` signs the consent challenge of `authority` (which may carry another credentialId or key, for negative tests). */
async function consentFor(passkey: SoftPasskey, accountId: string, authority: Pick<LedgerAuthority, 'credentialId' | 'publicKey'>, options?: SignOptions): Promise<PasskeySignature> {
  return passkey.sign(await authorityConsentChallenge(accountId, authority), options);
}
const consentOf = (passkey: SoftPasskey, accountId: string, options?: SignOptions): Promise<PasskeySignature> => consentFor(passkey, accountId, passkey, options);
async function addAuthority(passkey: SoftPasskey, accountId: string, label: string, addedAt = T0, overrides: Partial<LedgerAuthority> = {}): Promise<AddAuthority> {
  const authority = { ...authorityOf(passkey, label, addedAt), ...overrides };
  return { type: 'add_authority', authority, consent: await consentFor(passkey, accountId, authority) };
}
function genesisPayload(passkey: SoftPasskey, overrides: Partial<LedgerGenesis> = {}): LedgerGenesis {
  return {
    type: 'ftown_account_genesis', version: 2, rpId, origins: [origin, 'http://localhost:3000'], handle: randomB64(32),
    createdAt: T0, authority: authorityOf(passkey, 'iCloud Keychain'), ...overrides,
  };
}
async function endpointFor(ownerId: string, kind: 'browser' | 'bridge'): Promise<EndpointPublic> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { version: 1, id: b64(sha256(raw)), ownerId, kind, publicKey: b64(raw) };
}
async function authKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return b64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
}
async function newDevice(ownerId: string, label = 'MacBook', approvedAt = T0): Promise<LedgerDevice> {
  return { endpoint: await endpointFor(ownerId, 'browser'), authPublicKey: await authKey(), label, approvedAt };
}
async function newBridge(ownerId: string, bridgeId: string, approvedAt = T0): Promise<LedgerBridge> {
  return { bridgeId, endpoint: await endpointFor(ownerId, 'bridge'), authPublicKey: await authKey(), label: `Bridge ${bridgeId}`, approvedAt };
}
async function start(passkey: SoftPasskey, overrides: Partial<LedgerGenesis> = {}, options?: SignOptions): Promise<Chain> {
  const genesis = await signed(passkey, genesisPayload(passkey, overrides), options);
  const accountId = await accountIdOf(genesis.payload);
  return { ledger: { genesis, transitions: [] }, accountId, head: accountId, issuedAt: genesis.payload.createdAt };
}
/** Hand-built record that bypasses nextTransition, so invalid records can be produced and signed. */
async function raw(chain: Chain, passkey: SoftPasskey, operation: LedgerOperation, overrides: Partial<LedgerTransition> = {}, options?: SignOptions): Promise<Chain> {
  const payload: LedgerTransition = {
    type: 'ftown_account_transition', version: 2, accountId: chain.accountId, revision: chain.ledger.transitions.length + 1,
    previousHead: chain.head, issuedAt: chain.issuedAt + 1000, credentialId: passkey.credentialId, operation, ...overrides,
  };
  const record = await signed(passkey, payload, options);
  return { ledger: { genesis: chain.ledger.genesis, transitions: [...chain.ledger.transitions, record] }, accountId: chain.accountId, head: await ledgerHead(payload), issuedAt: payload.issuedAt };
}
/** The signer's real path: verify, nextTransition, sign. */
async function append(chain: Chain, passkey: SoftPasskey, operation: LedgerOperation, at = chain.issuedAt + 1000): Promise<Chain> {
  const payload = nextTransition(await verifyLedger(chain.ledger, NOW), passkey.credentialId, operation, at, ledgerLastIssuedAt(chain.ledger));
  const record = await signed(passkey, payload);
  return { ledger: { genesis: chain.ledger.genesis, transitions: [...chain.ledger.transitions, record] }, accountId: chain.accountId, head: await ledgerHead(payload), issuedAt: payload.issuedAt };
}
async function fixture() {
  const a = await newPasskey();
  let chain = await start(a);
  const device = await newDevice(chain.accountId);
  const bridge = await newBridge(chain.accountId, 'studio');
  chain = await append(chain, a, { type: 'add_device', device });
  chain = await append(chain, a, { type: 'add_bridge', bridge });
  return { a, chain, device, bridge };
}
/** base (2 records); A, B, R, S each add one record to base (R and S revoke); C extends A and D extends B. */
async function forest() {
  const { a, chain: base, device } = await fixture();
  const add = async (chain: Chain, label: string): Promise<Chain> => append(chain, a, { type: 'add_device', device: await newDevice(base.accountId, label) });
  const A = await add(base, 'A');
  const B = await add(base, 'B');
  const C = await add(A, 'C');
  const D = await add(B, 'D');
  const R = await append(base, a, { type: 'revoke_bridge', bridgeId: 'studio' });
  const S = await append(base, a, { type: 'revoke_device', endpointId: device.endpoint.id });
  return { a, base, A, B, C, D, R, S };
}
const NONE: LedgerDiscarded = { records: [], deviceIds: [], bridgeIds: [] };
/** `ledger` is the chain the caller must store afterwards: local on keep/reject. */
function verdict(decision: LedgerChoice['decision'], relation: LedgerRelation | null, checkpoint: LedgerCheckpoint, ledger: Ledger): LedgerChoice {
  return { decision, relation, checkpoint, discarded: NONE, ledger };
}
/** The append-only reference: a replica adopts only a chain whose records start with exactly its own records (by payload). */
function extendsChain(current: Ledger, candidate: Ledger): boolean {
  const mine = [current.genesis, ...current.transitions].map(record => JSON.stringify(record.payload));
  const theirs = [candidate.genesis, ...candidate.transitions].map(record => JSON.stringify(record.payload));
  return theirs.length > mine.length && mine.every((item, index) => theirs[index] === item);
}
async function cacheFor(ledger: Ledger, now = NOW): Promise<LedgerCache> {
  const checkpoint = await verifyLedger(ledger, now);
  return { head: checkpoint.head, checkpoint };
}
function tamper(ledger: Ledger, edit: (copy: Ledger) => void): Ledger {
  const copy = structuredClone(ledger);
  edit(copy);
  return copy;
}
function edited(value: unknown, from: string, to: string): unknown {
  const text = JSON.stringify(value);
  assert.equal(text.split(from).length, 2, `${from} must occur once`);
  const result: unknown = JSON.parse(text.replace(from, to));
  return result;
}
/** Same bytes, different spelling: sets a padding bit of the last base64url character. */
function nonCanonical(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const index = alphabet.indexOf(value[value.length - 1]);
  return value.slice(0, -1) + alphabet[index ^ 1];
}
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return items.map(sortedKeys);
  }
  if (value === null || typeof value !== 'object') return value;
  const record: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).sort(([left], [right]) => left < right ? -1 : 1)) record[key] = sortedKeys(item);
  return record;
}
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const result: T[][] = [];
  items.forEach((item, index) => {
    for (const rest of permutations([...items.slice(0, index), ...items.slice(index + 1)])) result.push([item, ...rest]);
  });
  return result;
}
/** A replica that starts empty, sees `order` one by one and keeps its cache in step. Returns its final head. */
async function replicate(order: Ledger[], useCache: boolean): Promise<string> {
  let current: Ledger | null = null;
  let cache: LedgerCache | undefined;
  for (const candidate of order) {
    let result: LedgerChoice;
    try {
      result = await chooseLedger(current, candidate, NOW, useCache ? cache : undefined);
    } catch (error) {
      // By contract an empty replica throws on an invalid candidate; it simply stays empty.
      if (current === null && error instanceof LedgerError) continue;
      throw error;
    }
    current = result.ledger;
    cache = { head: result.checkpoint.head, checkpoint: result.checkpoint };
  }
  assert.ok(cache);
  return cache.head;
}
const isCode = (code: LedgerErrorCode) => (error: unknown): boolean => error instanceof LedgerError && error.code === code;
async function rejects(promise: Promise<unknown>, code: LedgerErrorCode, message?: string): Promise<void> {
  await assert.rejects(promise, isCode(code), message);
}
function throws(run: () => unknown, code: LedgerErrorCode, message?: string): void {
  assert.throws(run, isCode(code), message);
}

test('ledgerChallenge is SHA-256 of the domain and key-sorted canonical JSON; heads and accountId are its base64url', async () => {
  const passkey = await newPasskey();
  const payload = genesisPayload(passkey, { authority: authorityOf(passkey, 'Clé de Foad 🔑') });
  const expected = sha256(LEDGER_DOMAIN + JSON.stringify(sortedKeys(payload)));
  assert.deepEqual(await ledgerChallenge(payload), expected);
  const { authority } = payload;
  const reordered: LedgerGenesis = {
    authority: { addedAt: authority.addedAt, label: authority.label, publicKey: authority.publicKey, credentialId: authority.credentialId },
    createdAt: payload.createdAt, handle: payload.handle, origins: payload.origins, rpId, version: 2, type: 'ftown_account_genesis',
  };
  assert.equal(await ledgerHead(reordered), b64(expected));
  assert.equal(await accountIdOf(payload), b64(expected));
  assert.match(b64(expected), /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(ledgerChallenge(Object.assign(structuredClone(payload), { createdAt: Number.NaN })), isCode('invalid_ledger'));
});

test('signInChallenge is SHA-256 of its own domain and can never be a ledger challenge', async () => {
  const nonce = randomB64(32);
  assert.deepEqual(await signInChallenge(nonce), sha256(SIGNIN_DOMAIN + nonce));
  // Neither domain is a prefix of the other, so no nonce and no payload give the same SHA-256 preimage.
  assert.notEqual(SIGNIN_DOMAIN, LEDGER_DOMAIN);
  assert.ok(!SIGNIN_DOMAIN.startsWith(LEDGER_DOMAIN) && !LEDGER_DOMAIN.startsWith(SIGNIN_DOMAIN));
  let differ = 0;
  while (SIGNIN_DOMAIN[differ] === LEDGER_DOMAIN[differ]) differ += 1;
  assert.ok(differ < SIGNIN_DOMAIN.length && differ < LEDGER_DOMAIN.length);
  const passkey = await newPasskey();
  const payload = genesisPayload(passkey);
  const ledger = b64(await ledgerChallenge(payload));
  assert.notEqual(b64(await signInChallenge(nonce)), ledger);
  assert.notEqual(b64(await signInChallenge(ledger)), ledger, 'a ledger head used as the nonce');
  // An assertion over a sign-in challenge does not verify as a ledger record.
  const chain = await start(passkey);
  const signInSignature = await passkey.sign(await signInChallenge(chain.accountId));
  await rejects(verifyLedger({ genesis: { payload: chain.ledger.genesis.payload, signature: signInSignature }, transitions: [] }, NOW), 'invalid_ledger');
  for (const bad of ['', 'short', `${nonce}\n`, 'x'.repeat(129), 'a+b/'.repeat(8)]) await rejects(signInChallenge(bad), 'invalid_ledger', JSON.stringify(bad));
});

test('the trust, sign-in and consent domains are pairwise distinct and never prefixes of each other', async () => {
  const domains = [LEDGER_DOMAIN, SIGNIN_DOMAIN, AUTHORITY_CONSENT_DOMAIN];
  for (const left of domains) {
    for (const right of domains) if (left !== right) assert.ok(!left.startsWith(right), `${JSON.stringify(right)} prefixes ${JSON.stringify(left)}`);
  }
  assert.equal(new Set(domains).size, 3);
  const passkey = await newPasskey();
  const accountId = randomB64(32);
  const expected = sha256(AUTHORITY_CONSENT_DOMAIN + JSON.stringify({ accountId, credentialId: passkey.credentialId, publicKey: passkey.publicKey }));
  assert.deepEqual(await authorityConsentChallenge(accountId, passkey), expected);
  assert.notDeepEqual(await authorityConsentChallenge(randomB64(32), passkey), expected, 'bound to the account');
  assert.notDeepEqual(await authorityConsentChallenge(accountId, { ...passkey, credentialId: randomB64(32) }), expected, 'bound to the credential');
  await rejects(authorityConsentChallenge('not-an-account', passkey), 'invalid_ledger');
  await rejects(authorityConsentChallenge(accountId, { credentialId: passkey.credentialId, publicKey: randomB64(64) }), 'invalid_ledger');
  // A consent assertion never stands in for a record signature.
  const chain = await start(passkey);
  const consent = await consentOf(passkey, chain.accountId);
  await rejects(verifyLedger({ genesis: { payload: chain.ledger.genesis.payload, signature: consent }, transitions: [] }, NOW), 'invalid_ledger');
});

test('add_authority requires the new passkey\'s own consent, bound to this account', async () => {
  const { a, chain } = await fixture();
  const b = await newPasskey();
  const c = await newPasskey();
  const valid = await addAuthority(b, chain.accountId, 'Phone', chain.issuedAt);
  assert.deepEqual((await verifyLedger((await raw(chain, a, valid)).ledger, NOW)).authorities.map(item => item.credentialId), [a.credentialId, b.credentialId]);

  // The attack: a genuine consent that b gave to its own account Y, replayed by account X to claim b.
  const victim = await start(b);
  const genuine = await addAuthority(c, victim.accountId, 'Victim key', victim.issuedAt);
  assert.equal((await verifyLedger((await raw(victim, b, genuine)).ledger, NOW)).authorities.length, 2, 'genuine in its own account');
  const replayed: AddAuthority = { ...genuine, authority: authorityOf(c, 'Victim key', chain.issuedAt) };
  await rejects(verifyLedger((await raw(chain, a, replayed)).ledger, NOW), 'invalid_ledger', 'consent replayed from another account');

  const missing: unknown = { type: 'add_authority', authority: valid.authority };
  const cases: [string, LedgerOperation][] = [
    ['consent missing', missing as LedgerOperation],
    ['consent signed by a different key', { ...valid, consent: await consentFor(c, chain.accountId, valid.authority) }],
    ['consent signed by the adding authority', { ...valid, consent: await consentFor(a, chain.accountId, valid.authority) }],
    ['consent for another credentialId', { ...valid, authority: { ...valid.authority, credentialId: randomB64(32) } }],
    ['consent with a wrong rpId', { ...valid, consent: await consentOf(b, chain.accountId, { rpId: 'evil.example' }) }],
    ['consent from a wrong origin', { ...valid, consent: await consentOf(b, chain.accountId, { origin: 'https://evil.example' }) }],
    ['consent without UV', { ...valid, consent: await consentOf(b, chain.accountId, { uv: false }) }],
    ['consent over a ledger challenge', { ...valid, consent: chain.ledger.transitions[0].signature }],
  ];
  for (const [name, op] of cases) await rejects(verifyLedger((await raw(chain, a, op)).ledger, NOW), 'invalid_ledger', name);
  const extra: unknown = { ...valid, consent: { ...valid.consent, extra: 1 } };
  const accepted = (await raw(chain, a, valid)).ledger;
  throws(() => parseLedger(tamper(accepted, copy => { copy.transitions[2].payload.operation = extra as LedgerOperation; })), 'invalid_ledger', 'consent extra key');
});

test('chooseLedger checks add_authority consent on the extension path, with and without a cache', async () => {
  const { a, chain } = await fixture();
  const b = await newPasskey();
  const reject = verdict('reject', 'ahead', await verifyLedger(chain.ledger, NOW), chain.ledger);
  const valid = await addAuthority(b, chain.accountId, 'Phone', chain.issuedAt);
  assert.equal((await chooseLedger(chain.ledger, (await raw(chain, a, valid)).ledger, NOW, await cacheFor(chain.ledger))).decision, 'adopt', 'control');
  const victim = await start(b);
  const candidates: [string, LedgerOperation][] = [
    ['consent replayed from another account', { ...valid, consent: await consentOf(b, victim.accountId) }],
    ['consent signed by a different key', { ...valid, consent: await consentFor(a, chain.accountId, valid.authority) }],
  ];
  for (const [name, op] of candidates) {
    const candidate = (await raw(chain, a, op)).ledger;
    assert.deepEqual(await chooseLedger(chain.ledger, candidate, NOW), reject, name);
    assert.deepEqual(await chooseLedger(chain.ledger, candidate, NOW, await cacheFor(chain.ledger)), reject, `${name} (cache)`);
    await rejects(verifyLedger(candidate, NOW), 'invalid_ledger', `${name} (full verify)`);
    await rejects(chooseLedger(null, candidate, NOW), 'invalid_ledger', `${name} (empty replica)`);
  }
});

test('a genesis-only ledger verifies to revision 0 with only the genesis authority', async () => {
  const a = await newPasskey();
  const chain = await start(a);
  assert.deepEqual(await verifyLedger(chain.ledger, NOW), {
    version: 2, accountId: chain.accountId, revision: 0, head: chain.accountId, authorities: [authorityOf(a, 'iCloud Keychain')],
    devices: [], bridges: [], revokedDeviceIds: [], revokedBridgeIds: [],
  });
  assert.equal(ledgerLastIssuedAt(chain.ledger), T0);
});

test('a multi-operation chain verifies; accountId is stable, revisions advance, authorities are add-only', async () => {
  const a = await newPasskey();
  const b = await newPasskey();
  let chain = await start(a);
  const { accountId } = chain;
  const laptop = await newDevice(accountId, 'MacBook');
  const phone = await newDevice(accountId, 'iPhone', T0 + 4000);
  const studio = await newBridge(accountId, 'studio');
  chain = await append(chain, a, { type: 'add_device', device: laptop });
  chain = await append(chain, a, { type: 'add_bridge', bridge: studio });
  const yubikey = authorityOf(b, 'YubiKey', chain.issuedAt);
  chain = await append(chain, a, { type: 'add_authority', authority: yubikey, consent: await consentFor(b, accountId, yubikey) });
  chain = await append(chain, b, { type: 'revoke_device', endpointId: laptop.endpoint.id });
  chain = await append(chain, b, { type: 'add_device', device: phone });
  chain = await append(chain, a, { type: 'revoke_bridge', bridgeId: 'studio' });
  const checkpoint = await verifyLedger(chain.ledger, NOW);
  assert.deepEqual(checkpoint, {
    version: 2, accountId, revision: 6, head: chain.head, authorities: [authorityOf(a, 'iCloud Keychain'), yubikey], devices: [phone], bridges: [],
    revokedDeviceIds: [laptop.endpoint.id], revokedBridgeIds: ['studio'],
  });
  for (let length = 0; length <= 6; length += 1) {
    const prefix = await verifyLedger({ genesis: chain.ledger.genesis, transitions: chain.ledger.transitions.slice(0, length) }, NOW);
    assert.equal(prefix.accountId, accountId);
    assert.equal(prefix.revision, length);
  }
  const wire: unknown = JSON.parse(JSON.stringify(chain.ledger));
  const parsed = parseLedger(wire);
  assert.deepEqual(parsed, chain.ledger);
  assert.notEqual(parsed.genesis, chain.ledger.genesis);
  assert.deepEqual(await verifyLedger(parsed, NOW), checkpoint);
  assert.equal(ledgerLastIssuedAt(chain.ledger), chain.issuedAt);
  assert.deepEqual(ledgerRevocations(chain.ledger), { deviceIds: [laptop.endpoint.id], bridgeIds: ['studio'] });
});

test('parseLedger accepts canonical origins, localhost and full-length unicode labels', async () => {
  const a = await newPasskey();
  const chain = await start(a, {
    rpId: 'localhost', origins: ['http://localhost', 'http://localhost:3000', 'https://ftown.example:8443'],
    authority: authorityOf(a, 'é'.repeat(LEDGER_LIMITS.maxLabelLength)),
  });
  assert.deepEqual(parseLedger(chain.ledger), chain.ledger);
  assert.deepEqual(ledgerRevocations(chain.ledger), { deviceIds: [], bridgeIds: [] });
});

test('parseLedger rejects every malformed shape with invalid_ledger', async () => {
  const { chain } = await fixture();
  const labelled = (text: string) => (copy: Ledger) => { copy.genesis.payload.authority.label = text; };
  const cases: [string, (copy: Ledger) => void][] = [
    ['top-level extra key', copy => { Object.assign(copy, { extra: 1 }); }],
    ['genesis extra key', copy => { Object.assign(copy.genesis, { extra: 1 }); }],
    ['genesis payload extra key', copy => { Object.assign(copy.genesis.payload, { extra: 1 }); }],
    ['authority extra key', copy => { Object.assign(copy.genesis.payload.authority, { extra: 1 }); }],
    ['signature extra key', copy => { Object.assign(copy.genesis.signature, { extra: 1 }); }],
    ['transition extra key', copy => { Object.assign(copy.transitions[0].payload, { extra: 1 }); }],
    ['operation extra key', copy => { Object.assign(copy.transitions[0].payload.operation, { extra: 1 }); }],
    ['endpoint extra key', copy => {
      const operation = copy.transitions[0].payload.operation;
      if (operation.type === 'add_device') Object.assign(operation.device.endpoint, { extra: 1 });
    }],
    ['missing handle', copy => { Reflect.deleteProperty(copy.genesis.payload, 'handle'); }],
    ['non-plain object', copy => { Object.setPrototypeOf(copy.genesis.payload.authority, { injected: true }); }],
    ['version 3', copy => { Object.assign(copy.genesis.payload, { version: 3 }); }],
    ['transition type', copy => { Object.assign(copy.transitions[0].payload, { type: 'ftown_account_genesis' }); }],
    ['string time', copy => { Object.assign(copy.genesis.payload, { createdAt: String(T0) }); }],
    ['fractional time', copy => { Object.assign(copy.transitions[0].payload, { issuedAt: T0 + 0.5 }); }],
    ['negative time', copy => { Object.assign(copy.genesis.payload, { createdAt: -1 }); }],
    ['revision 0', copy => { Object.assign(copy.transitions[0].payload, { revision: 0 }); }],
    ['revision as string', copy => { Object.assign(copy.transitions[0].payload, { revision: '1' }); }],
    ['handle of 31 bytes', copy => { copy.genesis.payload.handle = randomB64(31); }],
    ['padded handle', copy => { copy.genesis.payload.handle += '='; }],
    ['standard base64 alphabet', copy => { copy.genesis.payload.handle = `+/${copy.genesis.payload.handle.slice(2)}`; }],
    ['non-canonical base64url', copy => { copy.genesis.payload.handle = nonCanonical(copy.genesis.payload.handle); }],
    ['authority key of 64 bytes', copy => { copy.genesis.payload.authority.publicKey = randomB64(64); }],
    ['authority key without 0x04', copy => { copy.genesis.payload.authority.publicKey = b64(new Uint8Array(65).fill(5)); }],
    ['empty credentialId', copy => { copy.genesis.payload.authority.credentialId = ''; }],
    ['empty rpId', copy => { copy.genesis.payload.rpId = ''; }],
    ['uppercase rpId', copy => { copy.genesis.payload.rpId = 'Ftown.example'; }],
    ['no origins', copy => { copy.genesis.payload.origins = []; }],
    ['origins not an array', copy => { Object.assign(copy.genesis.payload, { origins: origin }); }],
    ['origin with a trailing slash', copy => { copy.genesis.payload.origins = [`${origin}/`]; }],
    ['origin with a path', copy => { copy.genesis.payload.origins = [`${origin}/app`]; }],
    ['uppercase origin', copy => { copy.genesis.payload.origins = ['https://Ftown.example']; }],
    ['default port spelled out', copy => { copy.genesis.payload.origins = ['https://ftown.example:443']; }],
    ['plain http origin', copy => { copy.genesis.payload.origins = ['http://ftown.example']; }],
    ['duplicate origin', copy => { copy.genesis.payload.origins = [origin, origin]; }],
    ['non-string origin', copy => { Object.assign(copy.genesis.payload, { origins: [1] }); }],
    ['label too long', labelled('x'.repeat(LEDGER_LIMITS.maxLabelLength + 1))],
    ['C0 control in label', labelled('a\nb')],
    ['DEL in label', labelled('a\u007fb')],
    ['C1 control NEL in label', labelled('a\u0085b')],
    ['C1 control CSI in label', labelled('a\u009bb')],
    ['zero-width space in label', labelled('a\u200bb')],
    ['right-to-left mark in label', labelled('a\u200fb')],
    ['bidi override in label', labelled('a\u202eb')],
    ['bidi isolate in label', labelled('a\u2066b')],
    ['pop isolate in label', labelled('a\u2069b')],
    ['byte order mark in label', labelled('\ufeffab')],
    ['lone surrogate in label', labelled('a\ud800b')],
    ['transitions not an array', copy => { Object.assign(copy, { transitions: {} }); }],
    ['unknown operation', copy => { Object.assign(copy.transitions[0].payload.operation, { type: 'add_admin' }); }],
    ['revoke_authority no longer exists', copy => {
      const removed: unknown = { type: 'revoke_authority', credentialId: copy.genesis.payload.authority.credentialId };
      copy.transitions[0].payload.operation = removed as LedgerOperation;
    }],
    ['device endpoint of kind bridge', copy => {
      const operation = copy.transitions[0].payload.operation;
      if (operation.type === 'add_device') operation.device.endpoint.kind = 'bridge';
    }],
    ['device auth key equals its endpoint key', copy => {
      const operation = copy.transitions[0].payload.operation;
      if (operation.type === 'add_device') operation.device.authPublicKey = operation.device.endpoint.publicKey;
    }],
    ['bridgeId with a slash', copy => {
      const operation = copy.transitions[1].payload.operation;
      if (operation.type === 'add_bridge') operation.bridge.bridgeId = 'a/b';
    }],
    ['oversized DER signature', copy => { copy.genesis.signature.signature = randomB64(73); }],
    ['short authenticatorData', copy => { copy.genesis.signature.authenticatorData = randomB64(36); }],
  ];
  for (const [name, edit] of cases) throws(() => parseLedger(tamper(chain.ledger, edit)), 'invalid_ledger', name);
  throws(() => parseLedger(edited(chain.ledger, '"handle":', '"__proto__":{},"handle":')), 'invalid_ledger', '__proto__ key from JSON');
  throws(() => parseLedger(null), 'invalid_ledger');
  throws(() => parseLedger([]), 'invalid_ledger');
  assert.deepEqual(parseLedger(tamper(chain.ledger, labelled('Foad’s MacBook é中\u{1f4bb}'))).genesis.payload.authority.label, 'Foad’s MacBook é中\u{1f4bb}');
});

test('parseLedger enforces maxTransitions and maxBytes with ledger_limit', async () => {
  const { chain } = await fixture();
  const record = chain.ledger.transitions[0];
  const repeat = (item: Signed<LedgerTransition>, length: number): Ledger => ({ genesis: chain.ledger.genesis, transitions: Array.from({ length }, () => item) });
  throws(() => parseLedger(repeat(record, LEDGER_LIMITS.maxTransitions + 1)), 'ledger_limit');
  assert.equal(parseLedger(repeat(record, LEDGER_LIMITS.maxTransitions)).transitions.length, LEDGER_LIMITS.maxTransitions);
  const bulky = tamper({ genesis: chain.ledger.genesis, transitions: [record] }, copy => { copy.transitions[0].signature.clientDataJSON = randomB64(4096); }).transitions[0];
  assert.equal(parseLedger(repeat(bulky, 250)).transitions.length, 250);
  throws(() => parseLedger(repeat(bulky, 400)), 'ledger_limit');
});

test('verifyLedger rejects tampered payloads, signatures and reordering', async () => {
  const { chain } = await fixture();
  await verifyLedger(chain.ledger, NOW);
  await rejects(verifyLedger(tamper(chain.ledger, copy => {
    const operation = copy.transitions[1].payload.operation;
    if (operation.type === 'add_bridge') operation.bridge.label = 'Evil';
  }), NOW), 'invalid_ledger', 'tampered last payload');
  await rejects(verifyLedger(tamper(chain.ledger, copy => { copy.genesis.payload.createdAt -= 1; }), NOW), 'invalid_ledger', 'tampered genesis');
  await rejects(verifyLedger(tamper(chain.ledger, copy => { copy.genesis.payload.origins.push('https://evil.example'); }), NOW), 'invalid_ledger', 'widened origins');
  await rejects(verifyLedger(tamper(chain.ledger, copy => { copy.transitions[1].signature = copy.transitions[0].signature; }), NOW), 'invalid_ledger', 'transplanted signature');
  await rejects(verifyLedger(tamper(chain.ledger, copy => { copy.transitions.reverse(); }), NOW), 'invalid_ledger', 'reordered');
  await rejects(verifyLedger(tamper(chain.ledger, copy => { copy.transitions.splice(0, 1); }), NOW), 'invalid_ledger', 'gap');
  const other = await newPasskey();
  const forged = await signed(other, chain.ledger.genesis.payload);
  await rejects(verifyLedger({ genesis: forged, transitions: [] }, NOW), 'invalid_ledger', 'genesis signed by another key');
  await rejects(verifyLedger(edited(chain.ledger, '"rpId":', '"extra":1,"rpId":') as Ledger, NOW), 'invalid_ledger', 'unknown key in JSON');
  await rejects(verifyLedger(chain.ledger, Number.NaN), 'invalid_ledger', 'invalid now');
  assert.equal((await verifyLedger(chain.ledger, NOW)).revision, 2, 'input untouched');
});

test('verifyLedger enforces previousHead, revision order and timestamps', async () => {
  const { a, chain } = await fixture();
  const device = await newDevice(chain.accountId, 'iPad', chain.issuedAt);
  const op: LedgerOperation = { type: 'add_device', device };
  await rejects(verifyLedger((await raw(chain, a, op, { previousHead: chain.accountId })).ledger, NOW), 'invalid_ledger', 'wrong previousHead');
  await rejects(verifyLedger((await raw(chain, a, op, { previousHead: randomB64(32) })).ledger, NOW), 'invalid_ledger', 'random previousHead');
  await rejects(verifyLedger((await raw(chain, a, op, { revision: 4 })).ledger, NOW), 'invalid_ledger', 'skipped revision');
  await rejects(verifyLedger((await raw(chain, a, op, { revision: 2 })).ledger, NOW), 'invalid_ledger', 'repeated revision');
  await rejects(verifyLedger((await raw(chain, a, op, { issuedAt: chain.issuedAt - 1 })).ledger, NOW), 'invalid_ledger', 'issuedAt backwards');
  assert.equal((await verifyLedger((await raw(chain, a, op, { issuedAt: chain.issuedAt })).ledger, NOW)).revision, 3, 'equal issuedAt');
  await rejects(verifyLedger((await raw(chain, a, op, { issuedAt: NOW + SKEW + 1 })).ledger, NOW), 'invalid_ledger', 'issuedAt in the future');
  assert.equal((await verifyLedger((await raw(chain, a, op, { issuedAt: NOW + SKEW })).ledger, NOW)).revision, 3, 'at the skew bound');
  const early = await start(a, { createdAt: NOW });
  const earlyOp: LedgerOperation = { type: 'add_device', device: await newDevice(early.accountId, 'iPad', NOW - 1) };
  await rejects(verifyLedger((await raw(early, a, earlyOp, { issuedAt: NOW - 1 })).ledger, NOW), 'invalid_ledger', 'before genesis createdAt');
  assert.equal((await verifyLedger((await raw(early, a, earlyOp, { issuedAt: NOW })).ledger, NOW)).revision, 1, 'at genesis createdAt');
  await rejects(verifyLedger((await start(a, { createdAt: NOW + SKEW + 1 })).ledger, NOW), 'invalid_ledger', 'genesis in the future');
  const late = await newPasskey();
  await rejects(verifyLedger((await start(late, { authority: authorityOf(late, 'Late', T0 + 1) })).ledger, NOW), 'invalid_ledger', 'addedAt after createdAt');
});

test('approvedAt and addedAt may equal issuedAt but never exceed it', async () => {
  const { a, chain } = await fixture();
  const at = chain.issuedAt + 1000;
  const device = await newDevice(chain.accountId, 'iPad');
  const bridge = await newBridge(chain.accountId, 'garage');
  const b = await newPasskey();
  const checkpoint = await verifyLedger(chain.ledger, NOW);
  const consent = await consentOf(b, chain.accountId);
  const cases: [string, (stamp: number) => LedgerOperation][] = [
    ['device approvedAt', stamp => ({ type: 'add_device', device: { ...device, approvedAt: stamp } })],
    ['bridge approvedAt', stamp => ({ type: 'add_bridge', bridge: { ...bridge, approvedAt: stamp } })],
    ['authority addedAt', stamp => ({ type: 'add_authority', authority: authorityOf(b, 'B', stamp), consent })],
  ];
  for (const [name, op] of cases) {
    assert.equal((await verifyLedger((await raw(chain, a, op(at), { issuedAt: at })).ledger, NOW)).revision, 3, `${name} equal`);
    await rejects(verifyLedger((await raw(chain, a, op(at + 1), { issuedAt: at })).ledger, NOW), 'invalid_ledger', `${name} after issuedAt`);
    assert.equal(nextTransition(checkpoint, a.credentialId, op(at), at).issuedAt, at, `${name} builder equal`);
    throws(() => nextTransition(checkpoint, a.credentialId, op(at + 1), at), 'invalid_ledger', `${name} builder after`);
  }
});

test('verifyLedger requires an authority of the PREVIOUS state and a valid passkey assertion for every record', async () => {
  const { a, chain } = await fixture();
  const stranger = await newPasskey();
  const op: LedgerOperation = { type: 'revoke_bridge', bridgeId: 'studio' };
  assert.equal((await verifyLedger((await raw(chain, a, op)).ledger, NOW)).revision, 3);
  await rejects(verifyLedger((await raw(chain, stranger, op)).ledger, NOW), 'invalid_ledger', 'signer is not an authority');
  const selfAdded = await addAuthority(stranger, chain.accountId, 'Me', chain.issuedAt);
  await rejects(verifyLedger((await raw(chain, stranger, selfAdded)).ledger, NOW), 'invalid_ledger', 'stranger signs its own add_authority');
  assert.equal((await verifyLedger((await raw(chain, a, selfAdded)).ledger, NOW)).authorities.length, 2, 'an authority adds it');
  await rejects(verifyLedger((await raw(chain, stranger, op, { credentialId: a.credentialId })).ledger, NOW), 'invalid_ledger', 'authority id, foreign key');
  await rejects(verifyLedger((await raw(chain, a, op, {}, { origin: 'https://evil.example' })).ledger, NOW), 'invalid_ledger', 'wrong origin');
  assert.equal((await verifyLedger((await raw(chain, a, op, {}, { origin: 'http://localhost:3000' })).ledger, NOW)).revision, 3, 'second origin');
  await rejects(verifyLedger((await raw(chain, a, op, {}, { rpId: 'evil.example' })).ledger, NOW), 'invalid_ledger', 'wrong rpId');
  await rejects(verifyLedger((await raw(chain, a, op, {}, { uv: false })).ledger, NOW), 'invalid_ledger', 'UV unset');
  await rejects(verifyLedger((await raw(chain, a, op, {}, { up: false })).ledger, NOW), 'invalid_ledger', 'UP unset');
  await rejects(verifyLedger((await raw(chain, a, op, {}, { type: 'webauthn.create' })).ledger, NOW), 'invalid_ledger', 'create ceremony');
  await rejects(verifyLedger((await start(a, {}, { origin: 'https://evil.example' })).ledger, NOW), 'invalid_ledger', 'genesis wrong origin');
  await rejects(verifyLedger((await start(a, {}, { rpId: 'evil.example' })).ledger, NOW), 'invalid_ledger', 'genesis wrong rpId');
  await rejects(verifyLedger((await start(a, {}, { uv: false })).ledger, NOW), 'invalid_ledger', 'genesis UV unset');
});

test('verifyLedger keeps device and bridge tombstones', async () => {
  const { a, chain: base, device, bridge } = await fixture();
  let chain = await append(base, a, { type: 'revoke_device', endpointId: device.endpoint.id });
  chain = await append(chain, a, { type: 'revoke_bridge', bridgeId: 'studio' });
  await rejects(verifyLedger((await raw(chain, a, { type: 'add_device', device })).ledger, NOW), 'ledger_revoked', 'device re-added');
  const sameId = await newBridge(chain.accountId, 'studio');
  await rejects(verifyLedger((await raw(chain, a, { type: 'add_bridge', bridge: sameId })).ledger, NOW), 'ledger_revoked', 'bridgeId re-added');
  const asBridge: LedgerBridge = { bridgeId: 'other', endpoint: { ...device.endpoint, kind: 'bridge' }, authPublicKey: await authKey(), label: 'x', approvedAt: T0 };
  await rejects(verifyLedger((await raw(chain, a, { type: 'add_bridge', bridge: asBridge })).ledger, NOW), 'ledger_revoked', 'revoked device endpoint as a bridge');
  await rejects(verifyLedger((await raw(chain, a, { type: 'revoke_device', endpointId: device.endpoint.id })).ledger, NOW), 'ledger_revoked', 'device revoked twice');
  await rejects(verifyLedger((await raw(chain, a, { type: 'revoke_bridge', bridgeId: bridge.bridgeId })).ledger, NOW), 'ledger_revoked', 'bridge revoked twice');
  assert.deepEqual(ledgerRevocations(chain.ledger), { deviceIds: [device.endpoint.id], bridgeIds: ['studio'] });
});

test('verifyLedger refuses duplicate ids and shared keys', async () => {
  const { a, chain, device, bridge } = await fixture();
  const fresh = await newDevice(chain.accountId, 'iPad');
  const b = await newPasskey();
  const cases: [string, LedgerOperation][] = [
    ['same device twice', { type: 'add_device', device }],
    ['device endpoint reused with a new auth key', { type: 'add_device', device: { ...device, authPublicKey: await authKey() } }],
    ['device auth key reused', { type: 'add_device', device: { ...fresh, authPublicKey: device.authPublicKey } }],
    ['device auth key equals a bridge auth key', { type: 'add_device', device: { ...fresh, authPublicKey: bridge.authPublicKey } }],
    ['device auth key equals a bridge endpoint key', { type: 'add_device', device: { ...fresh, authPublicKey: bridge.endpoint.publicKey } }],
    ['device endpoint equals a bridge endpoint', { type: 'add_device', device: { ...fresh, endpoint: { ...bridge.endpoint, kind: 'browser' } } }],
    ['bridgeId present', { type: 'add_bridge', bridge: await newBridge(chain.accountId, 'studio') }],
    ['bridge endpoint present', { type: 'add_bridge', bridge: { ...bridge, bridgeId: 'other', authPublicKey: await authKey() } }],
    // Validly consented, so only the duplicate rule can refuse them.
    ['authority credentialId present', await addAuthority(b, chain.accountId, 'B', chain.issuedAt, { credentialId: a.credentialId })],
    ['authority key present', await addAuthority(a, chain.accountId, 'A', chain.issuedAt, { credentialId: b.credentialId })],
    ['revoke_device naming a bridge member\'s endpoint', { type: 'revoke_device', endpointId: bridge.endpoint.id }],
  ];
  for (const [name, op] of cases) await rejects(verifyLedger((await raw(chain, a, op)).ledger, NOW), 'invalid_ledger', name);
});

test('revoking an id that is not a member tombstones it: it can never be added later, and a second revocation is ledger_revoked', async () => {
  const { a, chain } = await fixture();
  const stranger = await newDevice(chain.accountId, 'Never added');
  const strangerBridge = await newBridge(chain.accountId, 'garage');
  let tombstoned = await append(chain, a, { type: 'revoke_device', endpointId: stranger.endpoint.id });
  tombstoned = await append(tombstoned, a, { type: 'revoke_bridge', bridgeId: 'garage' });
  const before = await verifyLedger(chain.ledger, NOW);
  const after = await verifyLedger(tombstoned.ledger, NOW);
  assert.deepEqual(after, { ...before, revision: 4, head: tombstoned.head, revokedDeviceIds: [stranger.endpoint.id], revokedBridgeIds: ['garage'] }, 'membership unchanged');
  assert.deepEqual(ledgerRevocations(tombstoned.ledger), { deviceIds: [stranger.endpoint.id], bridgeIds: ['garage'] });
  await rejects(verifyLedger((await raw(tombstoned, a, { type: 'add_device', device: stranger })).ledger, NOW), 'ledger_revoked', 'device added later');
  await rejects(verifyLedger((await raw(tombstoned, a, { type: 'add_bridge', bridge: strangerBridge })).ledger, NOW), 'ledger_revoked', 'bridge added later');
  const asBridge: LedgerBridge = { ...strangerBridge, bridgeId: 'other', endpoint: { ...stranger.endpoint, kind: 'bridge' } };
  await rejects(verifyLedger((await raw(tombstoned, a, { type: 'add_bridge', bridge: asBridge })).ledger, NOW), 'ledger_revoked', 'tombstoned endpoint as a bridge');
  throws(() => nextTransition(after, a.credentialId, { type: 'add_device', device: stranger }, NOW), 'ledger_revoked', 'builder');
  await rejects(verifyLedger((await raw(tombstoned, a, { type: 'revoke_device', endpointId: stranger.endpoint.id })).ledger, NOW), 'ledger_revoked', 'device tombstoned twice');
  await rejects(verifyLedger((await raw(tombstoned, a, { type: 'revoke_bridge', bridgeId: 'garage' })).ledger, NOW), 'ledger_revoked', 'bridge tombstoned twice');
});

test('verifyLedger binds endpoints and records to the account', async () => {
  const { a, chain } = await fixture();
  const otherAccount = randomB64(32);
  await rejects(verifyLedger((await raw(chain, a, { type: 'add_device', device: await newDevice(otherAccount) })).ledger, NOW), 'ledger_other_account', 'device owner');
  await rejects(verifyLedger((await raw(chain, a, { type: 'add_bridge', bridge: await newBridge(otherAccount, 'x') })).ledger, NOW), 'ledger_other_account', 'bridge owner');
  const op: LedgerOperation = { type: 'revoke_bridge', bridgeId: 'studio' };
  await rejects(verifyLedger((await raw(chain, a, op, { accountId: otherAccount })).ledger, NOW), 'ledger_other_account', 'transition accountId');
});

test('verifyLedger checks new key material', async () => {
  const { a, chain } = await fixture();
  const device = await newDevice(chain.accountId, 'iPad');
  const b = await newPasskey();
  const offCurve = offCurvePoint();
  const offCurveEndpoint = { ...device.endpoint, publicKey: offCurve, id: b64(sha256(Buffer.from(offCurve, 'base64url'))) };
  assert.equal((await verifyLedger((await raw(chain, a, { type: 'add_device', device })).ledger, NOW)).devices.length, 2);
  const cases: [string, LedgerOperation][] = [
    ['endpoint id is not SHA-256 of its key', { type: 'add_device', device: { ...device, endpoint: { ...device.endpoint, id: randomB64(32) } } }],
    ['endpoint key off the curve', { type: 'add_device', device: { ...device, endpoint: offCurveEndpoint } }],
    ['auth key off the curve', { type: 'add_device', device: { ...device, authPublicKey: offCurvePoint() } }],
    ['authority key off the curve', { type: 'add_authority', authority: { ...authorityOf(b, 'B', chain.issuedAt), publicKey: offCurvePoint() }, consent: await consentOf(b, chain.accountId) }],
  ];
  for (const [name, op] of cases) await rejects(verifyLedger((await raw(chain, a, op)).ledger, NOW), 'invalid_ledger', name);
});

test('verifyLedger enforces maxAuthorities and maxDevices', async () => {
  const a = await newPasskey();
  let chain = await start(a);
  for (let index = 1; index < LEDGER_LIMITS.maxAuthorities; index += 1) {
    chain = await raw(chain, a, await addAuthority(await newPasskey(), chain.accountId, `Key ${index}`, chain.issuedAt));
  }
  assert.equal((await verifyLedger(chain.ledger, NOW)).authorities.length, LEDGER_LIMITS.maxAuthorities);
  await rejects(verifyLedger((await raw(chain, a, await addAuthority(await newPasskey(), chain.accountId, 'Ninth', chain.issuedAt))).ledger, NOW), 'ledger_limit');

  let devices = await start(a);
  for (let index = 0; index < LEDGER_LIMITS.maxDevices; index += 1) {
    devices = await raw(devices, a, { type: 'add_device', device: await newDevice(devices.accountId, `D${index}`) });
  }
  assert.equal((await verifyLedger(devices.ledger, NOW)).devices.length, LEDGER_LIMITS.maxDevices);
  await rejects(verifyLedger((await raw(devices, a, { type: 'add_device', device: await newDevice(devices.accountId, 'One more') })).ledger, NOW), 'ledger_limit');
});

test('chooseLedger: null local adopts a valid candidate and throws for an invalid one', async () => {
  const { chain } = await fixture();
  const result = await chooseLedger(null, chain.ledger, NOW);
  assert.deepEqual(result, verdict('adopt', null, await verifyLedger(chain.ledger, NOW), chain.ledger));
  assert.notEqual(result.ledger, chain.ledger, 'a parsed copy');
  const broken = tamper(chain.ledger, copy => { copy.genesis.payload.createdAt += 1; });
  await rejects(chooseLedger(null, broken, NOW), 'invalid_ledger');
});

test('chooseLedger: same and behind are kept, ahead is adopted, and every verdict carries the relation', async () => {
  const { a, chain: base } = await fixture();
  const longer = await append(base, a, { type: 'revoke_bridge', bridgeId: 'studio' });
  const baseCheckpoint = await verifyLedger(base.ledger, NOW);
  const longerCheckpoint = await verifyLedger(longer.ledger, NOW);
  assert.deepEqual(await chooseLedger(base.ledger, structuredClone(base.ledger), NOW), verdict('keep', 'same', baseCheckpoint, base.ledger));
  const resigned: Ledger = { genesis: await signed(a, base.ledger.genesis.payload), transitions: base.ledger.transitions };
  assert.notDeepEqual(resigned.genesis.signature, base.ledger.genesis.signature);
  assert.deepEqual(await chooseLedger(base.ledger, resigned, NOW), verdict('keep', 'same', baseCheckpoint, base.ledger), 'same payloads, fresh signature bytes');
  // 'behind' is information for the caller (re-offer), never an adoption.
  assert.deepEqual(await chooseLedger(longer.ledger, base.ledger, NOW), verdict('keep', 'behind', longerCheckpoint, longer.ledger));
  assert.deepEqual(await chooseLedger(longer.ledger, base.ledger, NOW, await cacheFor(longer.ledger)), verdict('keep', 'behind', longerCheckpoint, longer.ledger), 'behind (cache)');
  const genesisOnly: Ledger = { genesis: base.ledger.genesis, transitions: [] };
  assert.deepEqual(await chooseLedger(longer.ledger, genesisOnly, NOW), verdict('keep', 'behind', longerCheckpoint, longer.ledger));
  assert.deepEqual(await chooseLedger(genesisOnly, genesisOnly, NOW), verdict('keep', 'same', await verifyLedger(genesisOnly, NOW), genesisOnly));
  assert.deepEqual(await chooseLedger(base.ledger, longer.ledger, NOW), verdict('adopt', 'ahead', longerCheckpoint, longer.ledger));
  assert.deepEqual(await chooseLedger(genesisOnly, longer.ledger, NOW), verdict('adopt', 'ahead', longerCheckpoint, longer.ledger));
  // The candidate's prefix carries other (valid) signature bytes: local's are stored, the candidate's are dropped.
  const resignedLonger: Ledger = { genesis: resigned.genesis, transitions: longer.ledger.transitions };
  assert.deepEqual(await chooseLedger(base.ledger, resignedLonger, NOW, await cacheFor(base.ledger)), verdict('adopt', 'ahead', longerCheckpoint, longer.ledger), 'extension with fresh prefix signatures');
});

test('chooseLedger rejects another account and invalid candidates, and throws for an invalid local', async () => {
  const { a, chain } = await fixture();
  const checkpoint = await verifyLedger(chain.ledger, NOW);
  // Another account is not a relation.
  const unrelated = verdict('reject', null, checkpoint, chain.ledger);
  const other = await fixture();
  assert.deepEqual(await chooseLedger(chain.ledger, other.chain.ledger, NOW), unrelated);
  const sameKeyOtherAccount = await start(a);
  assert.deepEqual(await chooseLedger(chain.ledger, sameKeyOtherAccount.ledger, NOW), unrelated, 'same passkey, different genesis');
  const reject = verdict('reject', 'ahead', checkpoint, chain.ledger);
  const extended = await append(chain, a, { type: 'revoke_bridge', bridgeId: 'studio' });
  const forgedTail = tamper(extended.ledger, copy => { copy.transitions[2].payload.issuedAt += 1; });
  assert.deepEqual(await chooseLedger(chain.ledger, forgedTail, NOW), reject, 'tampered extension');
  assert.deepEqual(await chooseLedger(chain.ledger, (await raw(chain, a, { type: 'revoke_bridge', bridgeId: 'studio' }, { issuedAt: NOW + SKEW + 1 })).ledger, NOW), reject, 'future extension');
  const garbage: unknown = { genesis: null, transitions: 'x' };
  assert.deepEqual(await chooseLedger(chain.ledger, garbage as Ledger, NOW), unrelated, 'garbage');
  await rejects(chooseLedger(forgedTail, chain.ledger, NOW), 'invalid_ledger');
});

test('chooseLedger verifies every new record of an extension, with or without a cache', async () => {
  const { a, chain } = await fixture();
  const stranger = await newPasskey();
  const checkpoint = await verifyLedger(chain.ledger, NOW);
  const reject = verdict('reject', 'ahead', checkpoint, chain.ledger);
  const op: LedgerOperation = { type: 'revoke_bridge', bridgeId: 'studio' };
  const forgedFirst = await raw(chain, stranger, op, { credentialId: a.credentialId });
  const forgeries: [string, Ledger][] = [
    ['stranger key under the authority id', forgedFirst.ledger],
    ['UV unset', (await raw(chain, a, op, {}, { uv: false })).ledger],
    ['valid record after a forged one', (await raw(forgedFirst, a, { type: 'add_device', device: await newDevice(chain.accountId, 'x') })).ledger],
  ];
  for (const [name, forged] of forgeries) {
    assert.deepEqual(await chooseLedger(chain.ledger, forged, NOW), reject, name);
    assert.deepEqual(await chooseLedger(chain.ledger, forged, NOW, await cacheFor(chain.ledger)), reject, `${name} (cache)`);
  }
  // The candidate's copy of the shared prefix carries a corrupted signature: it is never checked and never stored; the new record is.
  const extended = await append(chain, a, op);
  const corruptPrefix = tamper(extended.ledger, copy => { copy.transitions[0].signature = copy.transitions[1].signature; });
  const adopted = verdict('adopt', 'ahead', await verifyLedger(extended.ledger, NOW), extended.ledger);
  assert.deepEqual(await chooseLedger(chain.ledger, corruptPrefix, NOW, await cacheFor(chain.ledger)), adopted, 'corrupted prefix signature');
  assert.deepEqual(await chooseLedger(chain.ledger, corruptPrefix, NOW), adopted, 'corrupted prefix signature (no cache)');
  // An equal chain is decided from heads alone, before any candidate signature is checked.
  const corruptEqual = tamper(chain.ledger, copy => { copy.transitions[0].signature = copy.transitions[1].signature; });
  assert.deepEqual(await chooseLedger(chain.ledger, corruptEqual, NOW), verdict('keep', 'same', checkpoint, chain.ledger));
});

test('chooseLedger: the extension path enforces issuedAt order and tombstones, and keeps local\'s genesis bytes', async () => {
  const { a, chain: base } = await fixture();
  const local = await append(base, a, { type: 'revoke_bridge', bridgeId: 'studio' });
  const reject = verdict('reject', 'ahead', await verifyLedger(local.ledger, NOW), local.ledger);
  const valid = await raw(local, a, { type: 'add_device', device: await newDevice(base.accountId, 'iPad') });
  assert.equal((await chooseLedger(local.ledger, valid.ledger, NOW, await cacheFor(local.ledger))).decision, 'adopt', 'control');
  const corruptGenesis = tamper(valid.ledger, copy => { copy.genesis.signature = copy.transitions[0].signature; });
  const stored = await chooseLedger(local.ledger, corruptGenesis, NOW, await cacheFor(local.ledger));
  assert.equal(stored.decision, 'adopt', 'corrupted genesis signature bytes of the candidate are ignored');
  assert.deepEqual(stored.ledger, valid.ledger, 'and replaced by local\'s');
  const cases: [string, Ledger][] = [
    ['new record issued before the last one', (await raw(local, a, { type: 'add_device', device: await newDevice(base.accountId, 'iPad', T0) }, { issuedAt: local.issuedAt - 1 })).ledger],
    ['revoked bridge re-added', (await raw(local, a, { type: 'add_bridge', bridge: await newBridge(base.accountId, 'studio') })).ledger],
  ];
  for (const [name, candidate] of cases) {
    assert.deepEqual(await chooseLedger(local.ledger, candidate, NOW), reject, name);
    assert.deepEqual(await chooseLedger(local.ledger, candidate, NOW, await cacheFor(local.ledger)), reject, `${name} (cache)`);
  }
});

test('applyRevocations removes sticky ids from the roster and tombstones them, without mutating its inputs', async () => {
  const { a, chain, device, bridge } = await fixture();
  const second = await newDevice(chain.accountId, 'iPad');
  const extended = await append(chain, a, { type: 'add_device', device: second });
  const checkpoint = await verifyLedger((await append(extended, a, { type: 'revoke_device', endpointId: second.endpoint.id })).ledger, NOW);
  const unknownDevice = randomB64(32);
  const sticky = { deviceIds: [device.endpoint.id, unknownDevice, device.endpoint.id, second.endpoint.id], bridgeIds: ['studio', 'gone', 'studio'] };
  const before = structuredClone({ checkpoint, sticky });
  const result = applyRevocations(checkpoint, sticky);
  assert.deepEqual(result, {
    ...checkpoint, devices: [], bridges: [],
    revokedDeviceIds: [second.endpoint.id, device.endpoint.id, unknownDevice], revokedBridgeIds: ['studio', 'gone'],
  });
  assert.deepEqual({ checkpoint, sticky }, before);
  assert.notEqual(result.devices, checkpoint.devices);
  const untouched = applyRevocations(checkpoint, { deviceIds: [], bridgeIds: [] });
  assert.deepEqual(untouched, checkpoint);
  assert.notEqual(untouched, checkpoint);
  assert.deepEqual(applyRevocations(checkpoint, { deviceIds: [], bridgeIds: ['other'] }).bridges, [bridge]);
  assert.deepEqual(applyRevocations(result, sticky), result, 'idempotent');
  throws(() => applyRevocations(checkpoint, { deviceIds: ['not-a-fingerprint'], bridgeIds: [] }), 'invalid_ledger');
  throws(() => applyRevocations(checkpoint, { deviceIds: [], bridgeIds: ['a/b'] }), 'invalid_ledger');
  const extra: unknown = { deviceIds: [], bridgeIds: [], more: [] };
  throws(() => applyRevocations(checkpoint, extra as { deviceIds: string[]; bridgeIds: string[] }), 'invalid_ledger');
  throws(() => applyRevocations({ ...checkpoint, extra: 1 } as LedgerCheckpoint, { deviceIds: [], bridgeIds: [] }), 'invalid_ledger');
});

test('APPEND-ONLY: a LONGER diverged chain is NEVER adopted (the old tie-break adopted it), in both directions, with and without a cache', async () => {
  const { a, chain: base } = await fixture();
  const local = await append(base, a, { type: 'revoke_bridge', bridgeId: 'studio' });
  let longer = base;
  for (let index = 0; index < 12; index += 1) longer = await append(longer, a, { type: 'add_device', device: await newDevice(base.accountId, `Device ${index}`) });
  assert.equal(longer.ledger.transitions.length - local.ledger.transitions.length, 11);
  const localCheckpoint = await verifyLedger(local.ledger, NOW);
  const kept = verdict('keep', 'diverged', localCheckpoint, local.ledger);
  assert.deepEqual(await chooseLedger(local.ledger, longer.ledger, NOW), kept, '11 records longer, still kept');
  assert.deepEqual(await chooseLedger(local.ledger, longer.ledger, NOW, await cacheFor(local.ledger)), kept, 'cache path');
  // Nothing is discarded and nothing becomes sticky: the local revocation is still in the chain the replica holds.
  assert.deepEqual(localCheckpoint.revokedBridgeIds, ['studio']);
  // The other side keeps its own too: neither replica replaces what it holds.
  assert.deepEqual(await chooseLedger(longer.ledger, local.ledger, NOW), verdict('keep', 'diverged', await verifyLedger(longer.ledger, NOW), longer.ledger), 'shorter fork');
  assert.deepEqual(await chooseLedger(longer.ledger, base.ledger, NOW), verdict('keep', 'behind', await verifyLedger(longer.ledger, NOW), longer.ledger), 'prefix');
});

test('APPEND-ONLY: a diverged chain with MORE revocations, or of equal length, is not adopted whatever the heads', async () => {
  const { a, base, A, B, R, S } = await forest();
  for (const [plain, revoking] of [[A, R], [B, R], [A, S], [R, S], [S, R], [A, B], [B, A]]) {
    // Each pair in both directions: no length, revocation count or head order decides.
    for (const [local, candidate] of [[plain, revoking], [revoking, plain]]) {
      const kept = verdict('keep', 'diverged', await verifyLedger(local.ledger, NOW), local.ledger);
      assert.deepEqual(await chooseLedger(local.ledger, candidate.ledger, NOW), kept);
      assert.deepEqual(await chooseLedger(local.ledger, candidate.ledger, NOW, await cacheFor(local.ledger)), kept, 'cache');
    }
  }
  // A revocation deeper in a longer branch does not win either.
  const deep = await append(await append(base, a, { type: 'revoke_bridge', bridgeId: 'studio' }), a, { type: 'add_device', device: await newDevice(base.accountId, 'Late') });
  assert.deepEqual(await chooseLedger(A.ledger, deep.ledger, NOW), verdict('keep', 'diverged', await verifyLedger(A.ledger, NOW), A.ledger));
});

test('chooseLedger: a diverged candidate is verified; an invalid one is rejected, never kept as a valid other history', async () => {
  const { a, A, B } = await forest();
  const reject = verdict('reject', 'diverged', await verifyLedger(A.ledger, NOW), A.ledger);
  const badSignature = (await raw(B, a, { type: 'revoke_bridge', bridgeId: 'studio' }, {}, { uv: false })).ledger;
  const stranger = (await raw(B, await newPasskey(), { type: 'revoke_bridge', bridgeId: 'studio' })).ledger;
  const corruptFork = tamper(B.ledger, copy => { copy.transitions[2].signature = copy.transitions[1].signature; });
  const future = (await raw(B, a, { type: 'revoke_bridge', bridgeId: 'studio' }, { issuedAt: NOW + SKEW + 1 })).ledger;
  for (const [name, candidate] of [['bad signature after the fork', badSignature], ['stranger', stranger], ['corrupt first record of the branch', corruptFork], ['future-dated', future]] as const) {
    assert.deepEqual(await chooseLedger(A.ledger, candidate, NOW), reject, name);
    assert.deepEqual(await chooseLedger(A.ledger, candidate, NOW, await cacheFor(A.ledger)), reject, `${name} (cache)`);
  }
});

test('chooseLedger follows the append-only model in every arrival order, with and without a cache', async () => {
  const { a, base, A, B, C, D, R, S } = await forest();
  const forged = (await raw(C, await newPasskey(), { type: 'revoke_bridge', bridgeId: 'studio' }, { credentialId: a.credentialId })).ledger;
  const sets: [string, Chain[], Ledger[]][] = [
    ['two branches, each extended', [A, B, C, D], []],
    ['prefix, two branches and a forged extension', [base, A, B], [forged]],
    ['one branch extended', [A, B, C], []],
    ['revoking and plain branches', [A, R, B], []],
    ['four branches and their prefix', [R, S, C, base], []],
  ];
  for (const [name, chains, invalid] of sets) {
    for (const useCache of [false, true]) {
      for (const order of permutations([...chains.map(chain => chain.ledger), ...invalid])) {
        let expected: Ledger | null = null;
        for (const candidate of order) {
          if (candidate === forged) continue;
          if (expected === null || extendsChain(expected, candidate)) expected = candidate;
        }
        assert.ok(expected);
        assert.equal(await replicate(order, useCache), await ledgerHead(expected.transitions[expected.transitions.length - 1].payload), `${name}, cache ${useCache}`);
      }
    }
  }
  // A linear history converges whatever the order: every replica ends on its tip.
  for (const order of permutations([base.ledger, A.ledger, C.ledger])) assert.equal(await replicate(order, true), C.head);
});

test('chooseLedger: the cache path decides exactly like the no-cache path', async () => {
  const { a, base, A, B, C, D, R, S } = await forest();
  const other = await fixture();
  const forged = (await raw(A, a, { type: 'revoke_bridge', bridgeId: 'studio' }, {}, { uv: false })).ledger;
  const pairs: [Chain, Ledger][] = [
    [A, A.ledger], [C, A.ledger], [A, C.ledger], [A, B.ledger], [B, A.ledger], [C, B.ledger], [B, C.ledger], [C, D.ledger],
    [D, C.ledger], [base, D.ledger], [A, other.chain.ledger], [A, forged], [A, R.ledger], [R, A.ledger], [R, S.ledger], [S, R.ledger],
    [R, C.ledger], [C, R.ledger],
  ];
  for (const [local, candidate] of pairs) {
    const plain = await chooseLedger(local.ledger, candidate, NOW);
    assert.deepEqual(await chooseLedger(local.ledger, candidate, NOW, await cacheFor(local.ledger)), plain);
    assert.deepEqual(await chooseLedger(local.ledger, candidate, NOW, await cacheFor(B === local ? A.ledger : B.ledger)), plain, 'stale cache is ignored');
  }
});

test('chooseLedger: a vouched local chain that looks future-dated after a clock step back never throws', async () => {
  const { a, A, C } = await forest();
  const earlier = T0 - 600_000;
  const cache = await cacheFor(C.ledger);
  await rejects(chooseLedger(C.ledger, C.ledger, earlier), 'invalid_ledger', 'without a cache the local chain is re-verified');
  assert.deepEqual(await chooseLedger(C.ledger, C.ledger, earlier, cache), verdict('keep', 'same', cache.checkpoint, C.ledger));
  assert.deepEqual(await chooseLedger(C.ledger, A.ledger, earlier, cache), verdict('keep', 'behind', cache.checkpoint, C.ledger));
  const extension = await append(C, a, { type: 'revoke_bridge', bridgeId: 'studio' });
  assert.equal((await chooseLedger(C.ledger, extension.ledger, earlier, cache)).decision, 'reject');
  assert.equal((await chooseLedger(C.ledger, (await fixture()).chain.ledger, earlier, cache)).decision, 'reject');
});

test('chooseLedger: a cache vouches only for the hash-linked chain it was made for', async () => {
  const { A, B, C } = await forest();
  const cache = await cacheFor(C.ledger);
  // Same last record and length as C, but its middle record comes from the other branch.
  const spliced: Ledger = { genesis: C.ledger.genesis, transitions: [...C.ledger.transitions.slice(0, 2), B.ledger.transitions[2], C.ledger.transitions[3]] };
  await rejects(chooseLedger(spliced, A.ledger, NOW, cache), 'invalid_ledger');
  const kept = verdict('keep', 'behind', await verifyLedger(C.ledger, NOW), C.ledger);
  const wrongRevision = { head: cache.head, checkpoint: { ...cache.checkpoint, revision: 3 } };
  assert.deepEqual(await chooseLedger(C.ledger, A.ledger, NOW, wrongRevision), kept, 'inconsistent cache falls back');
  assert.deepEqual(await chooseLedger(C.ledger, A.ledger, NOW, { head: 'x', checkpoint: cache.checkpoint }), kept, 'mismatched cache falls back');
  const malformed: unknown = { head: cache.head, checkpoint: { ...cache.checkpoint, extra: 1 } };
  assert.deepEqual(await chooseLedger(C.ledger, A.ledger, NOW, malformed as LedgerCache), kept, 'malformed cache falls back');
  const otherAccount = await cacheFor((await fixture()).chain.ledger);
  assert.deepEqual(await chooseLedger(C.ledger, A.ledger, NOW, { head: cache.head, checkpoint: { ...otherAccount.checkpoint, head: cache.head, revision: 4 } }), kept, 'cache of another account falls back');
});

test('nextTransition builds the unsigned next record with a monotonic issuedAt', async () => {
  const { a, chain } = await fixture();
  const checkpoint = await verifyLedger(chain.ledger, NOW);
  const before = structuredClone(checkpoint);
  const device = await newDevice(chain.accountId, 'iPad', T0 + 5000);
  const op: LedgerOperation = { type: 'add_device', device };
  const payload = nextTransition(checkpoint, a.credentialId, op, T0 + 5000, ledgerLastIssuedAt(chain.ledger));
  assert.deepEqual(payload, {
    type: 'ftown_account_transition', version: 2, accountId: chain.accountId, revision: 3, previousHead: checkpoint.head,
    issuedAt: T0 + 5000, credentialId: a.credentialId, operation: op,
  });
  assert.notEqual(payload.operation, op);
  assert.deepEqual(checkpoint, before);
  const record = await signed(a, payload);
  assert.equal((await verifyLedger({ genesis: chain.ledger.genesis, transitions: [...chain.ledger.transitions, record] }, NOW)).revision, 3);
  const revoke: LedgerOperation = { type: 'revoke_bridge', bridgeId: 'studio' };
  assert.equal(nextTransition(checkpoint, a.credentialId, revoke, T0 + 10, chain.issuedAt).issuedAt, chain.issuedAt, 'clock behind');
  assert.equal(nextTransition(checkpoint, a.credentialId, revoke, NOW, chain.issuedAt).issuedAt, NOW, 'clock ahead');
  assert.equal(nextTransition(checkpoint, a.credentialId, revoke, NOW).issuedAt, NOW, 'no lastIssuedAt');
});

test('nextTransition refuses invalid operations with the verifier errors', async () => {
  const { a, chain, device } = await fixture();
  const checkpoint = await verifyLedger(chain.ledger, NOW);
  const stranger = await newPasskey();
  const fresh = await newDevice(chain.accountId, 'iPad');
  const foreign = await newDevice(randomB64(32));
  const revoke: LedgerOperation = { type: 'revoke_bridge', bridgeId: 'studio' };
  const at = chain.issuedAt + 1000;
  throws(() => nextTransition(checkpoint, stranger.credentialId, revoke, at), 'invalid_ledger', 'stranger');
  const selfAdded = await addAuthority(stranger, chain.accountId, 'Me', at);
  throws(() => nextTransition(checkpoint, stranger.credentialId, selfAdded, at), 'invalid_ledger', 'stranger adds itself');
  assert.deepEqual(nextTransition(checkpoint, a.credentialId, selfAdded, at).operation, selfAdded, 'consented authority');
  // Sync builder: only the consent's shape is checked here; verifyLedger checks its signature.
  const wrongKeyConsent = { ...selfAdded, consent: await consentFor(a, chain.accountId, selfAdded.authority) };
  assert.equal(nextTransition(checkpoint, a.credentialId, wrongKeyConsent, at).revision, 3);
  await rejects(verifyLedger({ genesis: chain.ledger.genesis, transitions: [...chain.ledger.transitions, await signed(a, nextTransition(checkpoint, a.credentialId, wrongKeyConsent, at))] }, NOW), 'invalid_ledger');
  const noConsent: unknown = { type: 'add_authority', authority: selfAdded.authority };
  throws(() => nextTransition(checkpoint, a.credentialId, noConsent as LedgerOperation, at), 'invalid_ledger', 'consent missing');
  const badConsent: unknown = { ...selfAdded, consent: { ...selfAdded.consent, extra: 1 } };
  throws(() => nextTransition(checkpoint, a.credentialId, badConsent as LedgerOperation, at), 'invalid_ledger', 'consent extra key');
  throws(() => nextTransition(checkpoint, 'not base64url!', revoke, at), 'invalid_ledger', 'malformed credentialId');
  throws(() => nextTransition(checkpoint, a.credentialId, { type: 'add_device', device }, at), 'invalid_ledger', 'duplicate device');
  throws(() => nextTransition(checkpoint, a.credentialId, { type: 'add_device', device: foreign }, at), 'ledger_other_account', 'owner');
  throws(() => nextTransition(checkpoint, a.credentialId, { type: 'add_device', device: { ...fresh, authPublicKey: fresh.endpoint.publicKey } }, at), 'invalid_ledger', 'key reuse');
  throws(() => nextTransition(checkpoint, a.credentialId, { type: 'add_device', device: { ...fresh, approvedAt: at + 1 } }, at), 'invalid_ledger', 'approvedAt');
  assert.equal(nextTransition(checkpoint, a.credentialId, { type: 'revoke_bridge', bridgeId: 'nowhere' }, at).revision, 3, 'an unknown bridge is tombstoned');
  throws(() => nextTransition(checkpoint, a.credentialId, { type: 'revoke_device', endpointId: (checkpoint.bridges[0]).endpoint.id }, at), 'invalid_ledger', 'device revocation of a bridge endpoint');
  const extra: unknown = { ...revoke, extra: 1 };
  throws(() => nextTransition(checkpoint, a.credentialId, extra as LedgerOperation, at), 'invalid_ledger', 'unknown key');
  const removed: unknown = { type: 'revoke_authority', credentialId: a.credentialId };
  throws(() => nextTransition(checkpoint, a.credentialId, removed as LedgerOperation, at), 'invalid_ledger', 'revoke_authority');
  throws(() => nextTransition(checkpoint, a.credentialId, revoke, NOW, NOW + SKEW + 1), 'invalid_ledger', 'lastIssuedAt too far ahead');
  throws(() => nextTransition(checkpoint, a.credentialId, revoke, Number.NaN), 'invalid_ledger', 'invalid now');
  throws(() => nextTransition({ ...checkpoint, extra: 1 } as LedgerCheckpoint, a.credentialId, revoke, at), 'invalid_ledger', 'malformed checkpoint');
  const legacy: unknown = { ...checkpoint, revokedCredentialIds: [] };
  throws(() => nextTransition(legacy as LedgerCheckpoint, a.credentialId, revoke, at), 'invalid_ledger', 'v1-era checkpoint key');
  throws(() => nextTransition({ ...checkpoint, revision: LEDGER_LIMITS.maxTransitions }, a.credentialId, revoke, at), 'ledger_limit', 'maxTransitions');

  const fakeBridge = (index: number): LedgerBridge => ({
    bridgeId: `b${index}`, endpoint: { version: 1, id: randomB64(32), ownerId: chain.accountId, kind: 'bridge', publicKey: offCurvePoint() },
    authPublicKey: offCurvePoint(), label: '', approvedAt: T0,
  });
  const full: LedgerCheckpoint = { ...checkpoint, bridges: Array.from({ length: LEDGER_LIMITS.maxBridges }, (_, index) => fakeBridge(index)) };
  const oneMore = await newBridge(chain.accountId, 'one-more');
  assert.equal(nextTransition(checkpoint, a.credentialId, { type: 'add_bridge', bridge: oneMore }, at).revision, 3);
  throws(() => nextTransition(full, a.credentialId, { type: 'add_bridge', bridge: oneMore }, at), 'ledger_limit', 'maxBridges');

  const revoked = await verifyLedger((await append(chain, a, { type: 'revoke_device', endpointId: device.endpoint.id })).ledger, NOW);
  throws(() => nextTransition(revoked, a.credentialId, { type: 'add_device', device }, NOW), 'ledger_revoked', 'tombstoned device');
  throws(() => nextTransition(revoked, a.credentialId, { type: 'revoke_device', endpointId: device.endpoint.id }, NOW), 'ledger_revoked', 'revoked twice');
});
