import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { EndpointPublic } from '../protocol.js';
import { LEDGER_LIMITS } from './protocol.js';
import type {
  Ledger, LedgerAuthority, LedgerCheckpoint, LedgerDevice, LedgerGenesis, LedgerOperation, LedgerTransition, PasskeySignature, Signed,
} from './protocol.js';
import {
  LedgerError, accountIdOf, authorityConsentChallenge, chooseLedger, describeFork, forkPoint, ledgerChallenge, ledgerHead, ledgerHeads,
  ledgerLastIssuedAt, nextTransition, parseLedger, relate, relateHead, resolutionPlan, resolveForkTransition, verifyLedger,
} from './ledger.js';
import type { LedgerCache, LedgerChoice, LedgerDiscarded, LedgerErrorCode, LedgerRelation } from './ledger.js';
import { createSoftPasskey, rawToDerSignature } from './testing.js';
import type { SoftPasskey, SoftPasskeySignOptions } from './testing.js';
import { derToRawSignature } from './webauthn.js';

const rpId = 'ftown.example';
const origin = 'https://ftown.example';
const T0 = 1_750_000_000_000;
const NOW = T0 + 3_600_000;
const SKEW = LEDGER_LIMITS.maxFutureSkewMs;
const ORDER = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64url');
const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest());
const randomHead = (): string => b64(crypto.getRandomValues(new Uint8Array(32)));

interface Chain { ledger: Ledger; accountId: string; head: string; issuedAt: number }
type ResolveFork = Extract<LedgerOperation, { type: 'resolve_fork' }>;

const newPasskey = (): Promise<SoftPasskey> => createSoftPasskey({ rpId, origin });
async function signed<T extends LedgerGenesis | LedgerTransition>(passkey: SoftPasskey, payload: T, options?: SoftPasskeySignOptions): Promise<Signed<T>> {
  return { payload, signature: await passkey.sign(await ledgerChallenge(payload), options) };
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
async function newDevice(ownerId: string, label: string): Promise<LedgerDevice> {
  return { endpoint: await endpointFor(ownerId, 'browser'), authPublicKey: await authKey(), label, approvedAt: T0 };
}
/** `signer` consents to `authority` (by default its own credential and key) joining the account. */
async function addAuthority(passkey: SoftPasskey, accountId: string, addedAt: number, authority?: Pick<LedgerAuthority, 'credentialId' | 'publicKey'>): Promise<LedgerOperation> {
  const added = { credentialId: (authority ?? passkey).credentialId, publicKey: (authority ?? passkey).publicKey, label: 'Second key', addedAt };
  return { type: 'add_authority', authority: added, consent: await passkey.sign(await authorityConsentChallenge(accountId, added)) };
}
async function start(passkey: SoftPasskey): Promise<Chain> {
  const genesis = await signed(passkey, {
    type: 'ftown_account_genesis', version: 2, rpId, origins: [origin], handle: randomHead(), createdAt: T0,
    authority: { credentialId: passkey.credentialId, publicKey: passkey.publicKey, label: 'iCloud Keychain', addedAt: T0 },
  });
  const accountId = await accountIdOf(genesis.payload);
  return { ledger: { genesis, transitions: [] }, accountId, head: accountId, issuedAt: T0 };
}
async function grow(chain: Chain, passkey: SoftPasskey, payload: LedgerTransition, options?: SoftPasskeySignOptions): Promise<Chain> {
  const record = await signed(passkey, payload, options);
  return { ledger: { genesis: chain.ledger.genesis, transitions: [...chain.ledger.transitions, record] }, accountId: chain.accountId, head: await ledgerHead(payload), issuedAt: payload.issuedAt };
}
/** Hand-built record that bypasses every builder check; issued one second after the chain's last record unless `issuedAt` is given. */
function raw(chain: Chain, passkey: SoftPasskey, operation: LedgerOperation, options?: SoftPasskeySignOptions, issuedAt = chain.issuedAt + 1000): Promise<Chain> {
  return grow(chain, passkey, {
    type: 'ftown_account_transition', version: 2, accountId: chain.accountId, revision: chain.ledger.transitions.length + 1,
    previousHead: chain.head, issuedAt, credentialId: passkey.credentialId, operation,
  }, options);
}
/** The signer's real path: verify, nextTransition, sign. */
async function append(chain: Chain, passkey: SoftPasskey, operation: LedgerOperation): Promise<Chain> {
  return grow(chain, passkey, nextTransition(await verifyLedger(chain.ledger, NOW), passkey.credentialId, operation, chain.issuedAt + 1000, ledgerLastIssuedAt(chain.ledger)));
}
const deviceOp = async (accountId: string, label: string): Promise<LedgerOperation> => ({ type: 'add_device', device: await newDevice(accountId, label) });
async function addDevice(chain: Chain, passkey: SoftPasskey, label: string): Promise<Chain> {
  return append(chain, passkey, await deviceOp(chain.accountId, label));
}
/** A security-relevant record: the revocation (tombstone) of an id that was never a member. */
const tombstone = (chain: Chain, passkey: SoftPasskey): Promise<Chain> => append(chain, passkey, { type: 'revoke_device', endpointId: randomHead() });
/** The owner's choice through the production builders, all signed by `passkey`: carry what resolutionPlan lists, then the resolve_fork. */
async function resolve(chosen: Chain, other: Chain, passkey: SoftPasskey, options?: SoftPasskeySignOptions): Promise<Chain> {
  let chain = chosen;
  for (const operation of (await resolutionPlan(chosen.ledger, other.ledger)).carry) chain = await append(chain, passkey, operation);
  return grow(chain, passkey, await resolveForkTransition(chain.ledger, other.ledger, passkey.credentialId, chain.issuedAt + 1000), options);
}
const resolveOp = (forkHead: string, discardedFirst: string, discardedHead: string, discardedRevision: number): ResolveFork => ({
  type: 'resolve_fork', forkHead, discardedFirst, discardedHead, discardedRevision,
});
const headAt = (chain: Chain, revision: number): Promise<string> => ledgerHead(chain.ledger.transitions[revision - 1].payload);
/** genesis (authority a), add_device `device`, add_bridge 'studio': revision 2. */
async function world() {
  const a = await newPasskey();
  let base = await start(a);
  const device = await newDevice(base.accountId, 'MacBook');
  base = await append(base, a, { type: 'add_device', device });
  const bridgeEndpoint = await endpointFor(base.accountId, 'bridge');
  base = await append(base, a, { type: 'add_bridge', bridge: { bridgeId: 'studio', endpoint: bridgeEndpoint, authPublicKey: await authKey(), label: 'Studio', approvedAt: T0 } });
  const genesisOnly: Chain = { ledger: { genesis: base.ledger.genesis, transitions: [] }, accountId: base.accountId, head: base.accountId, issuedAt: T0 };
  return { a, base, device, genesisOnly };
}
const checkpointOf = (chain: Chain): Promise<LedgerCheckpoint> => verifyLedger(chain.ledger, NOW);
async function cacheFor(chain: Chain): Promise<LedgerCache> {
  const checkpoint = await checkpointOf(chain);
  return { head: checkpoint.head, checkpoint };
}
const NONE: LedgerDiscarded = { records: [], deviceIds: [], bridgeIds: [] };
/** The verdict with nothing discarded, where `holds` is the chain the caller stores afterwards. */
async function verdict(decision: LedgerChoice['decision'], relation: LedgerRelation | null, holds: Chain): Promise<LedgerChoice> {
  return { decision, relation, checkpoint: await checkpointOf(holds), discarded: NONE, ledger: holds.ledger };
}
/** The verdict of a divergent adoption of `candidate` by a replica holding `local`, forked at `fork`. */
async function resolved(local: Chain, candidate: Chain, fork: number): Promise<LedgerChoice> {
  return {
    decision: 'adopt', relation: 'diverged', checkpoint: await checkpointOf(candidate), ledger: candidate.ledger,
    discarded: { records: local.ledger.transitions.slice(fork), deviceIds: [], bridgeIds: [] },
  };
}
/** chooseLedger with and without a vouching cache must agree; returns the verdict. */
async function choose(local: Chain, candidate: Chain): Promise<LedgerChoice> {
  const plain = await chooseLedger(local.ledger, candidate.ledger, NOW);
  assert.deepEqual(await chooseLedger(local.ledger, candidate.ledger, NOW, await cacheFor(local)), plain, 'cache path decides like the full path');
  return plain;
}
const decisionOf = async (local: Chain, candidate: Chain): Promise<LedgerChoice['decision']> => (await choose(local, candidate)).decision;
/** Counts ECDSA verifications (one per passkey assertion that reaches the signature check) while `run` executes. */
async function verifications<T>(run: () => Promise<T>): Promise<[T, number]> {
  const spy = mock.method(crypto.subtle, 'verify');
  try {
    const result = await run();
    return [result, spy.mock.callCount()];
  } finally {
    spy.mock.restore();
  }
}
/** The other valid encoding of the same ECDSA signature (s -> n - s): payload, head and validity unchanged, bytes different. No key needed. */
function malleate(signature: PasskeySignature): PasskeySignature {
  const rawSignature = derToRawSignature(new Uint8Array(Buffer.from(signature.signature, 'base64url')));
  const s = BigInt(`0x${Buffer.from(rawSignature.subarray(32)).toString('hex')}`);
  const flipped = new Uint8Array(64);
  flipped.set(rawSignature.subarray(0, 32), 0);
  flipped.set(Buffer.from((ORDER - s).toString(16).padStart(64, '0'), 'hex'), 32);
  return { ...signature, signature: b64(rawToDerSignature(flipped)) };
}
/** `ledger` with the genesis and its first `length` records re-encoded. */
function reencoded(ledger: Ledger, length: number): Ledger {
  return {
    genesis: { payload: ledger.genesis.payload, signature: malleate(ledger.genesis.signature) },
    transitions: ledger.transitions.map((record, index) => index < length ? { payload: record.payload, signature: malleate(record.signature) } : record),
  };
}
const isCode = (code: LedgerErrorCode) => (error: unknown): boolean => error instanceof LedgerError && error.code === code;
async function rejects(promise: Promise<unknown>, code: LedgerErrorCode, message?: string): Promise<void> {
  await assert.rejects(promise, isCode(code), message);
}
function throws(run: () => unknown, code: LedgerErrorCode, message?: string): void {
  assert.throws(run, isCode(code), message);
}
function tamper(ledger: Ledger, edit: (copy: Ledger) => void): Ledger {
  const copy = structuredClone(ledger);
  edit(copy);
  return copy;
}

test('ledgerHeads lists every head by revision, genesis first, with no signature work', async () => {
  const { base, genesisOnly } = await world();
  const [heads, count] = await verifications(() => ledgerHeads(base.ledger));
  assert.equal(count, 0);
  assert.deepEqual(heads, [base.accountId, await ledgerHead(base.ledger.transitions[0].payload), base.head]);
  assert.equal(heads[0], await accountIdOf(base.ledger.genesis.payload));
  assert.deepEqual(await ledgerHeads(genesisOnly.ledger), [base.accountId]);
  const extra: unknown = { ...base.ledger, extra: 1 };
  await rejects(ledgerHeads(extra as Ledger), 'invalid_ledger');
});

test('relate and forkPoint classify every shape of two chains of one account, symmetrically', async () => {
  const { a, base, genesisOnly } = await world();
  const ext1 = await addDevice(base, a, 'E3');
  let ext5 = ext1;
  for (const label of ['E4', 'E5', 'E6', 'E7']) ext5 = await addDevice(ext5, a, label);
  const p1 = await addDevice(genesisOnly, a, 'P1');
  const q1 = await addDevice(genesisOnly, a, 'Q1');
  const q3 = await addDevice(await addDevice(q1, a, 'Q2'), a, 'Q3');
  const y3 = await addDevice(base, a, 'Y3');
  const z3 = await addDevice(base, a, 'Z3');
  const z5 = await addDevice(await addDevice(z3, a, 'Z4'), a, 'Z5');
  const cases: [string, Chain, Chain, LedgerRelation, number][] = [
    ['same chain', base, base, 'same', 2],
    ['same genesis-only chain', genesisOnly, genesisOnly, 'same', 0],
    ['ahead by one', base, ext1, 'ahead', 2],
    ['ahead by many', base, ext5, 'ahead', 2],
    ['ahead of a genesis-only chain', genesisOnly, ext5, 'ahead', 0],
    ['behind by one', ext1, base, 'behind', 2],
    ['behind by many', ext5, base, 'behind', 2],
    ['a genesis-only candidate is behind', ext5, genesisOnly, 'behind', 0],
    ['diverged at the first transition', p1, q1, 'diverged', 0],
    ['diverged at the first transition, longer candidate', p1, q3, 'diverged', 0],
    ['diverged at the first transition, longer local', q3, p1, 'diverged', 0],
    ['diverged at the last record, equal lengths', y3, z3, 'diverged', 2],
    ['diverged, candidate longer', y3, z5, 'diverged', 2],
    ['diverged, local longer', z5, y3, 'diverged', 2],
    ['diverged against a longer extension of the prefix', ext5, z5, 'diverged', 2],
  ];
  const mirror: { readonly [relation in LedgerRelation]: LedgerRelation } = { same: 'same', ahead: 'behind', behind: 'ahead', diverged: 'diverged' };
  for (const [name, local, candidate, relation, revision] of cases) {
    const mine = await ledgerHeads(local.ledger);
    const theirs = await ledgerHeads(candidate.ledger);
    assert.equal(relate(mine, theirs), relation, name);
    assert.equal(relate(theirs, mine), mirror[relation], `${name} (mirror)`);
    assert.deepEqual(forkPoint(mine, theirs), { revision, head: mine[revision] }, name);
    assert.deepEqual(forkPoint(theirs, mine), forkPoint(mine, theirs), `${name} (mirror fork point)`);
    assert.equal(forkPoint(mine, theirs)?.head, revision === 0 ? base.accountId : revision === 2 ? base.head : undefined, `${name} fork head`);
  }
  // Another account is not a relation.
  const other = await world();
  const baseHeads = await ledgerHeads(base.ledger);
  const otherHeads = await ledgerHeads(other.base.ledger);
  throws(() => relate(baseHeads, otherHeads), 'ledger_other_account');
  assert.equal(forkPoint(baseHeads, otherHeads), null);
  const mineGenesis = await ledgerHeads(genesisOnly.ledger);
  const otherGenesis = await ledgerHeads(other.genesisOnly.ledger);
  throws(() => relate(mineGenesis, otherGenesis), 'ledger_other_account', 'genesis-only, other account');
});

test('relate is pure: every shared head is compared, not only the one at the local tip', () => {
  assert.equal(relate(['g', 'a', 'b'], ['g', 'a', 'b', 'c']), 'ahead');
  assert.equal(relate(['g', 'a', 'b'], ['g', 'a']), 'behind');
  // A list whose head at the local revision matches but whose middle differs is not an extension.
  assert.equal(relate(['g', 'a', 'b'], ['g', 'x', 'b', 'c']), 'diverged');
  assert.deepEqual(forkPoint(['g', 'a', 'b'], ['g', 'x', 'b', 'c']), { revision: 0, head: 'g' });
  assert.equal(relate(['g', 'a', 'b', 'c'], ['g', 'x', 'b']), 'diverged');
  assert.equal(relate(['g'], ['g']), 'same');
  throws(() => relate(['g'], ['h']), 'ledger_other_account');
  assert.equal(forkPoint(['g'], ['h']), null);
  const malformed: unknown[] = [[], 'g', null, [1], Array.from({ length: LEDGER_LIMITS.maxTransitions + 2 }, () => 'g')];
  for (const value of malformed) {
    throws(() => relate(value as string[], ['g']), 'invalid_ledger', JSON.stringify(value).slice(0, 20));
    throws(() => forkPoint(['g'], value as string[]), 'invalid_ledger', JSON.stringify(value).slice(0, 20));
  }
});

test('relateHead classifies a bare {revision, head}: same, behind, or unknown (fetch the chain)', async () => {
  const { a, base } = await world();
  let chain = base;
  for (const label of ['A', 'B']) chain = await addDevice(chain, a, label);
  const heads = await ledgerHeads(chain.ledger);
  const branch = await addDevice(base, a, 'Branch');
  const ahead = await addDevice(chain, a, 'Ahead');
  const other = await world();
  assert.equal(relateHead(heads, { revision: 4, head: chain.head }), 'same');
  assert.equal(relateHead(heads, { revision: 2, head: base.head }), 'behind');
  assert.equal(relateHead(heads, { revision: 0, head: base.accountId }), 'behind');
  assert.equal(relateHead(heads, { revision: 5, head: ahead.head }), 'unknown', 'ahead');
  assert.equal(relateHead(heads, { revision: 3, head: branch.head }), 'unknown', 'diverged');
  assert.equal(relateHead(heads, { revision: 4, head: randomHead() }), 'unknown', 'diverged at the tip');
  assert.equal(relateHead(heads, { revision: 0, head: other.base.accountId }), 'unknown', 'another account');
  assert.equal(relateHead(heads, { revision: LEDGER_LIMITS.maxTransitions, head: randomHead() }), 'unknown');
  const announcement: unknown = { accountId: base.accountId, kind: 'bridge', head: chain.head, revision: 4, at: NOW };
  assert.equal(relateHead(heads, announcement as { revision: number; head: string }), 'same', 'other fields are ignored');
  const bad: unknown[] = [{ revision: -1, head: chain.head }, { revision: 1.5, head: chain.head }, { revision: '4', head: chain.head },
    { revision: LEDGER_LIMITS.maxTransitions + 1, head: chain.head }, { revision: 4, head: 'short' }, { revision: 4 }, null];
  for (const value of bad) throws(() => relateHead(heads, value as { revision: number; head: string }), 'invalid_ledger', JSON.stringify(value));
});

test('ahead: only the new records are verified when the cache vouches for local; a cache for another head forces full verification', async () => {
  const { a, base } = await world();
  let local = base;
  for (const label of ['L3', 'L4', 'L5', 'L6', 'L7']) local = await addDevice(local, a, label);
  let ahead = local;
  for (const label of ['N8', 'N9', 'N10']) ahead = await addDevice(ahead, a, label);
  const cache = await cacheFor(local);
  const adopted = await verdict('adopt', 'ahead', ahead);
  const [cheap, cheapCount] = await verifications(() => chooseLedger(local.ledger, ahead.ledger, NOW, cache));
  assert.deepEqual(cheap, adopted);
  assert.equal(cheapCount, 3, 'the genesis and the 7 shared records are not re-verified');
  const [full, fullCount] = await verifications(() => chooseLedger(local.ledger, ahead.ledger, NOW));
  assert.deepEqual(full, adopted);
  assert.equal(fullCount, 1 + 7 + 3, 'no cache: local from genesis, then only the new records');
  for (const [name, stale] of [
    ['cache of a prefix', await cacheFor(base)],
    ['cache of the candidate', await cacheFor(ahead)],
    ['cache head that does not match its checkpoint', { head: local.head, checkpoint: (await cacheFor(base)).checkpoint }],
  ] as const) {
    const [result, count] = await verifications(() => chooseLedger(local.ledger, ahead.ledger, NOW, stale));
    assert.deepEqual(result, adopted, name);
    assert.equal(count, 1 + 7 + 3, `${name}: local is verified from genesis`);
  }
  // 'same' and 'behind' are decided from heads: no signature work at all.
  assert.equal((await verifications(() => chooseLedger(local.ledger, local.ledger, NOW, cache)))[1], 0, 'same');
  assert.equal((await verifications(() => chooseLedger(local.ledger, base.ledger, NOW, cache)))[1], 0, 'behind');
  // 'diverged': only the candidate's records after the fork point.
  const branch = await addDevice(await addDevice(base, a, 'B3'), a, 'B4');
  const [kept, divergedCount] = await verifications(() => chooseLedger(local.ledger, branch.ledger, NOW, cache));
  assert.deepEqual(kept, await verdict('keep', 'diverged', local));
  assert.equal(divergedCount, 2, 'the shared prefix is replayed, not re-verified');
});

test('ahead: one bad signature anywhere in the new part rejects the candidate and leaves local untouched', async () => {
  const { a, base } = await world();
  const local = await addDevice(base, a, 'L3');
  const before = structuredClone(local.ledger);
  const lastBad = await raw(await addDevice(local, a, 'Good'), a, await deviceOp(base.accountId, 'Bad'), { uv: false });
  const middleBad = await raw(await raw(await addDevice(local, a, 'Good'), a, await deviceOp(base.accountId, 'Bad'), { origin: 'https://evil.example' }), a, await deviceOp(base.accountId, 'After'));
  const firstBad = await raw(local, a, await deviceOp(base.accountId, 'Bad'), { rpId: 'evil.example' });
  const rejected = await verdict('reject', 'ahead', local);
  for (const [name, candidate] of [['last', lastBad], ['middle', middleBad], ['first', firstBad]] as const) {
    assert.deepEqual(await choose(local, candidate), rejected, name);
  }
  assert.deepEqual(local.ledger, before, 'local input is never mutated');
});

test('re-encoded prefix signatures cost nothing: only records after local\'s tip or the fork are verified, and local\'s bytes are stored', async () => {
  const { a, base } = await world();
  let local = base;
  for (const label of ['L3', 'L4', 'L5']) local = await addDevice(local, a, label);
  const ahead = await addDevice(local, a, 'N6');
  const prefix = local.ledger.transitions.length;
  const attack = reencoded(ahead.ledger, prefix);
  // The re-encodings are genuine (anyone can make them, no key): the chain still verifies, heads are unchanged, bytes differ.
  assert.deepEqual(await verifyLedger(attack, NOW), await checkpointOf(ahead));
  assert.deepEqual(await ledgerHeads(attack), await ledgerHeads(ahead.ledger));
  assert.notDeepEqual(attack.genesis.signature, ahead.ledger.genesis.signature);
  const cache = await cacheFor(local);
  const [adopted, count] = await verifications(() => chooseLedger(local.ledger, attack, NOW, cache));
  assert.equal(count, 1, 'only the new record');
  assert.deepEqual(adopted, await verdict('adopt', 'ahead', ahead), 'stored: local\'s prefix bytes, then the new record');
  assert.deepEqual(adopted.ledger.transitions[0].signature, local.ledger.transitions[0].signature);
  // The same prefix plus one junk record (valid client data, wrong ECDSA bytes): rejected after a single verification.
  const good = await addDevice(local, a, 'Good');
  const donor = await addDevice(local, a, 'Donor');
  const junk = reencoded(tamper(good.ledger, copy => { copy.transitions[prefix].signature.signature = donor.ledger.transitions[prefix].signature.signature; }), prefix);
  const [rejected, junkCount] = await verifications(() => chooseLedger(local.ledger, junk, NOW, cache));
  assert.deepEqual(rejected, await verdict('reject', 'ahead', local));
  assert.equal(junkCount, 1);
  // Diverged: only the candidate's records after the fork point.
  const branch = await addDevice(await addDevice(base, a, 'B3'), a, 'B4');
  const [kept, keptCount] = await verifications(() => chooseLedger(local.ledger, reencoded(branch.ledger, 2), NOW, cache));
  assert.deepEqual(kept, await verdict('keep', 'diverged', local));
  assert.equal(keptCount, 2);
  // A resolution adopted through a re-encoded prefix also stores local's prefix bytes.
  const chosen = await resolve(branch, local, a);
  const [result, resolvedCount] = await verifications(() => chooseLedger(local.ledger, reencoded(chosen.ledger, 2), NOW, cache));
  assert.equal(resolvedCount, 3, 'B3, B4 and the resolution');
  assert.deepEqual(result, await resolved(local, chosen, 2));
  assert.deepEqual(result.ledger.genesis.signature, local.ledger.genesis.signature);
});

test('resolve_fork as a record: built by resolveForkTransition, strict shape, changes no membership', async () => {
  const { a, base } = await world();
  const mine = await addDevice(base, a, 'Mine');
  const theirs = await addDevice(base, a, 'Theirs');
  const payload = await resolveForkTransition(theirs.ledger, mine.ledger, a.credentialId, theirs.issuedAt + 1000);
  assert.deepEqual(payload, {
    type: 'ftown_account_transition', version: 2, accountId: base.accountId, revision: 4, previousHead: theirs.head, issuedAt: theirs.issuedAt + 1000,
    credentialId: a.credentialId, operation: resolveOp(base.head, mine.head, mine.head, 3),
  });
  const longer = await addDevice(mine, a, 'Mine 2');
  assert.deepEqual((await resolveForkTransition(theirs.ledger, longer.ledger, a.credentialId, NOW)).operation, resolveOp(base.head, mine.head, longer.head, 4));
  const resolvedChain = await grow(theirs, a, payload);
  const before = await checkpointOf(theirs);
  const after = await checkpointOf(resolvedChain);
  assert.deepEqual({ ...after, revision: before.revision, head: before.head }, before, 'membership unchanged');
  assert.equal(after.revision, 4);
  const shapes: [string, unknown][] = [
    ['extra key', { ...payload.operation, extra: 1 }],
    ['missing discardedFirst', { type: 'resolve_fork', forkHead: base.head, discardedHead: mine.head, discardedRevision: 3 }],
    ['missing discardedRevision', { type: 'resolve_fork', forkHead: base.head, discardedFirst: mine.head, discardedHead: mine.head }],
    ['forkHead of 31 bytes', { ...payload.operation, forkHead: b64(new Uint8Array(31)) }],
    ['discardedFirst of 33 bytes', { ...payload.operation, discardedFirst: b64(new Uint8Array(33)) }],
    ['padded discardedHead', { ...payload.operation, discardedHead: `${mine.head}=` }],
    ['discardedRevision 0', { ...payload.operation, discardedRevision: 0 }],
    ['discardedRevision as a string', { ...payload.operation, discardedRevision: '3' }],
    ['fractional discardedRevision', { ...payload.operation, discardedRevision: 3.5 }],
    ['discardedRevision beyond maxTransitions', { ...payload.operation, discardedRevision: LEDGER_LIMITS.maxTransitions + 1 }],
  ];
  for (const [name, operation] of shapes) {
    throws(() => parseLedger(tamper(resolvedChain.ledger, copy => { copy.transitions[3].payload.operation = operation as LedgerOperation; })), 'invalid_ledger', name);
  }
  // The builder: shape and the history-free rules only; it counts against maxTransitions like any record.
  const checkpoint = await checkpointOf(theirs);
  const at = theirs.issuedAt + 1000;
  assert.equal(nextTransition(checkpoint, a.credentialId, resolveOp(base.head, mine.head, mine.head, 3), at).revision, 4);
  for (const [name, own] of [['forkHead', base.head], ['own previous head', theirs.head], ['genesis', base.accountId]] as const) {
    throws(() => nextTransition(checkpoint, a.credentialId, resolveOp(base.head, own, mine.head, 4), at), 'invalid_ledger', `discardedFirst = ${name}`);
    throws(() => nextTransition(checkpoint, a.credentialId, resolveOp(base.head, mine.head, own, 4), at), 'invalid_ledger', `discardedHead = ${name}`);
  }
  throws(() => nextTransition({ ...checkpoint, revision: LEDGER_LIMITS.maxTransitions }, a.credentialId, resolveOp(base.head, mine.head, mine.head, 3), at), 'ledger_limit');
  const stranger = await newPasskey();
  throws(() => nextTransition(checkpoint, stranger.credentialId, resolveOp(base.head, mine.head, mine.head, 3), at), 'invalid_ledger', 'not an authority');
});

test('resolve_fork history rules: forkHead is an earlier record of the same chain, the signer an authority at it, the discarded branch after it and not in it', async () => {
  const { a, base } = await world();
  const b = await newPasskey();
  const mine = await addDevice(base, a, 'Mine');
  const theirs = await addDevice(base, a, 'Theirs');
  const later = await addDevice(theirs, a, 'Later');
  const valid = async (chain: Chain, signer: SoftPasskey, operation: ResolveFork): Promise<number> => (await checkpointOf(await raw(chain, signer, operation))).revision;
  const invalid = async (chain: Chain, signer: SoftPasskey, operation: ResolveFork, name: string): Promise<void> => {
    await rejects(checkpointOf(await raw(chain, signer, operation)), 'invalid_ledger', name);
  };
  const theirsFirst = await headAt(theirs, 3);
  assert.equal(await valid(theirs, a, resolveOp(base.head, mine.head, mine.head, 3)), 4, 'the true fork point');
  assert.equal(await valid(theirs, a, resolveOp(base.accountId, randomHead(), mine.head, 3)), 4, 'forkHead may be the genesis');
  const single = randomHead();
  assert.equal(await valid(theirs, a, resolveOp(theirs.head, single, single, 4)), 4, 'forkHead may be the previous record');
  await invalid(theirs, a, resolveOp(randomHead(), mine.head, mine.head, 3), 'forkHead not in the chain');
  await invalid(theirs, a, resolveOp(mine.head, single, single, 4), 'forkHead of another branch');
  // A record cannot name a head after its own position: `later` is revision 4 of a sibling chain, the record is revision 4 here.
  await invalid(theirs, a, resolveOp(later.head, single, single, 5), 'forkHead after its own position');
  await invalid(theirs, a, resolveOp(base.head, mine.head, mine.head, 2), 'discardedRevision equal to the fork revision');
  await invalid(theirs, a, resolveOp(base.head, mine.head, mine.head, 1), 'discardedRevision before the fork');
  await invalid(theirs, a, resolveOp(base.accountId, randomHead(), base.head, 2), 'discardedHead is a record of this chain');
  await invalid(theirs, a, resolveOp(base.accountId, randomHead(), theirs.head, 3), 'discardedHead is the previous record (self-reference)');
  await invalid(theirs, a, resolveOp(base.head, mine.head, base.head, 3), 'discardedHead = forkHead');
  await invalid(theirs, a, resolveOp(base.accountId, base.head, mine.head, 3), 'discardedFirst is a record of this chain');
  await invalid(theirs, a, resolveOp(base.head, theirsFirst, mine.head, 4), 'discardedFirst is this branch\'s own first record');
  await invalid(theirs, a, resolveOp(base.head, base.head, mine.head, 4), 'discardedFirst = forkHead');
  await invalid(theirs, a, resolveOp(base.head, randomHead(), mine.head, 3), 'one-record branch whose tip is not its first record');
  await invalid(theirs, a, resolveOp(base.head, mine.head, mine.head, 4), 'longer branch whose tip is its first record');
  await invalid(theirs, b, resolveOp(base.head, mine.head, mine.head, 3), 'signer not an authority at all');

  // Authorities are add-only (protocol.ts: no revoke_authority; parseLedger refuses one), so "an authority at forkHead" means "joined at or before it".
  const withB = await append(theirs, a, await addAuthority(b, base.accountId, theirs.issuedAt));
  await invalid(withB, b, resolveOp(base.head, mine.head, mine.head, 3), 'b joined after forkHead, on this branch only');
  assert.equal(await valid(withB, a, resolveOp(base.head, mine.head, mine.head, 3)), 5, 'a was an authority at forkHead');
  assert.equal(await valid(withB, b, resolveOp(withB.head, single, single, 5)), 5, 'b is an authority at the record that added it');
  assert.equal((await checkpointOf(await raw(withB, b, { type: 'revoke_bridge', bridgeId: 'studio' }))).revision, 5, 'b signs ordinary records');
  const sharedB = await append(base, a, await addAuthority(b, base.accountId, base.issuedAt));
  const sharedMine = await addDevice(sharedB, a, 'Mine');
  const sharedTheirs = await addDevice(sharedB, a, 'Theirs');
  assert.equal(await valid(sharedTheirs, b, resolveOp(sharedB.head, sharedMine.head, sharedMine.head, 4)), 5, 'an authority added before the fork may resolve it');
});

test('resolutionPlan lists, in the other branch\'s order, the removals and passkeys to carry; a removal of a non-member is carried as a tombstone', async () => {
  const { a, base, device } = await world();
  const b = await newPasskey();
  const c = await newPasskey();
  const chosen = await addDevice(base, a, 'Chosen');
  const ghost = await newDevice(base.accountId, 'Ghost');
  let other = await append(base, a, { type: 'revoke_bridge', bridgeId: 'studio' });
  other = await append(other, a, await addAuthority(b, base.accountId, other.issuedAt));
  other = await append(other, a, { type: 'add_device', device: ghost });
  other = await append(other, a, { type: 'revoke_device', endpointId: ghost.endpoint.id });
  other = await append(other, b, { type: 'revoke_device', endpointId: device.endpoint.id });
  other = await append(other, a, await addAuthority(c, base.accountId, other.issuedAt));
  const addB = other.ledger.transitions[3].payload.operation;
  const addC = other.ledger.transitions[7].payload.operation;
  const plan = await resolutionPlan(chosen.ledger, other.ledger);
  assert.deepEqual(plan, {
    fork: { revision: 2, head: base.head },
    carry: [{ type: 'revoke_bridge', bridgeId: 'studio' }, addB, { type: 'revoke_device', endpointId: ghost.endpoint.id }, { type: 'revoke_device', endpointId: device.endpoint.id }, addC],
  }, 'other\'s chain order; additions of devices are not carried');
  assert.deepEqual(await resolutionPlan(chosen.ledger, other.ledger), plan, 'deterministic');
  const [, count] = await verifications(() => resolutionPlan(chosen.ledger, other.ledger));
  assert.equal(count, 0, 'no signature work');
  // add_authority is carried with its ORIGINAL consent: the consent binds accountId, credentialId and key, not a chain position.
  assert.deepEqual(plan.carry[1], addB);
  await rejects(resolveForkTransition(chosen.ledger, other.ledger, a.credentialId, NOW), 'resolution_incomplete');
  const partial = await append(chosen, a, { type: 'revoke_bridge', bridgeId: 'studio' });
  assert.deepEqual((await resolutionPlan(partial.ledger, other.ledger)).carry, plan.carry.slice(1), 'only what is still missing');
  await rejects(resolveForkTransition(partial.ledger, other.ledger, a.credentialId, NOW), 'resolution_incomplete');
  let carried = chosen;
  for (const operation of plan.carry) carried = await append(carried, a, operation);
  assert.deepEqual(await resolutionPlan(carried.ledger, other.ledger), { fork: plan.fork, carry: [] });
  const checkpoint = await checkpointOf(carried);
  assert.deepEqual(checkpoint.revokedDeviceIds, [ghost.endpoint.id, device.endpoint.id]);
  assert.deepEqual(checkpoint.revokedBridgeIds, ['studio']);
  assert.deepEqual(checkpoint.authorities.map(item => item.credentialId), [a.credentialId, b.credentialId, c.credentialId]);
  assert.ok(checkpoint.devices.every(item => item.endpoint.id !== ghost.endpoint.id), 'the ghost was never a member here');
  await rejects(checkpointOf(await raw(carried, a, { type: 'add_device', device: ghost })), 'ledger_revoked', 'the tombstoned id can never be added on the chosen chain');
  const final = await grow(carried, a, await resolveForkTransition(carried.ledger, other.ledger, a.credentialId, carried.issuedAt + 1000));
  assert.deepEqual(await choose(other, final), await resolved(other, final, 2));
  // Not diverged, or another account.
  for (const [name, left, right] of [['same', chosen, chosen], ['ahead', base, chosen], ['behind', chosen, base]] as const) {
    await rejects(resolutionPlan(left.ledger, right.ledger), 'invalid_ledger', name);
  }
  await rejects(resolutionPlan(chosen.ledger, (await world()).base.ledger), 'ledger_other_account');
});

test('divergent adoption never discards a revocation or a passkey: missing ones keep the chains diverged, carried ones are adopted', async () => {
  const { a, base } = await world();
  const b = await newPasskey();
  let local = await append(base, a, { type: 'revoke_bridge', bridgeId: 'studio' });
  local = await append(local, a, await addAuthority(b, base.accountId, local.issuedAt));
  local = await addDevice(local, a, 'Only here');
  const localFirst = await headAt(local, 3);
  const other = await addDevice(base, a, 'Phone');
  const resolution = resolveOp(base.head, localFirst, local.head, 5);
  const keep = await verdict('keep', 'diverged', local);
  assert.equal((await checkpointOf(await raw(other, a, resolution))).revision, 4, 'a valid chain');
  assert.deepEqual(await choose(local, await raw(other, a, resolution)), keep, 'neither carried');
  const onlyRevocation = await append(other, a, { type: 'revoke_bridge', bridgeId: 'studio' });
  assert.deepEqual(await choose(local, await raw(onlyRevocation, a, resolution)), keep, 'passkey missing');
  const onlyPasskey = await append(other, a, local.ledger.transitions[3].payload.operation);
  assert.deepEqual(await choose(local, await raw(onlyPasskey, a, resolution)), keep, 'revocation missing');
  // The same credentialId under another key is not the passkey local's branch added.
  const impostorKey = await newPasskey();
  const impostor = await append(onlyRevocation, a, await addAuthority(impostorKey, base.accountId, onlyRevocation.issuedAt, { credentialId: b.credentialId, publicKey: impostorKey.publicKey }));
  assert.deepEqual(await choose(local, await raw(impostor, a, resolution)), keep, 'same credentialId, other key');
  // Through the builders (carry, then resolve): adopted, and the revocation and the passkey are in the adopted chain.
  const chosen = await resolve(other, local, a);
  assert.deepEqual(chosen.ledger.transitions.slice(3).map(record => record.payload.operation.type), ['revoke_bridge', 'add_authority', 'resolve_fork']);
  const result = await choose(local, chosen);
  assert.deepEqual(result, await resolved(local, chosen, 2));
  assert.deepEqual(result.discarded.deviceIds, [], 'nothing to make sticky: the adopted chain revokes it itself');
  assert.deepEqual(result.checkpoint.revokedBridgeIds, ['studio']);
  assert.ok(result.checkpoint.authorities.some(item => item.credentialId === b.credentialId && item.publicKey === b.publicKey));
  // The replica holding the chosen branch's prefix sees a plain extension; after adoption the old branch is only a different history.
  assert.deepEqual(await choose(other, chosen), await verdict('adopt', 'ahead', chosen));
  assert.deepEqual(await choose(chosen, local), await verdict('keep', 'diverged', chosen));
  // The other way round: `other` made no security-relevant record, so keeping local's history carries nothing.
  assert.deepEqual((await resolutionPlan(local.ledger, other.ledger)).carry, []);
  const kept = await resolve(local, other, a);
  assert.deepEqual(await choose(other, kept), await resolved(other, kept, 2));
});

test('P2: a compromised pre-fork authority cannot rewind the account with one record; carrying what matters leaves only benign records to discard', async () => {
  const owner = await newPasskey();
  const stolen = await newPasskey(); // legitimately added second passkey, later compromised
  const replacement = await newPasskey();
  let shared = await start(owner);
  const attackerDevice = await newDevice(shared.accountId, 'Attacker laptop');
  shared = await append(shared, owner, { type: 'add_device', device: attackerDevice });
  shared = await append(shared, owner, await addAuthority(stolen, shared.accountId, shared.issuedAt));
  // The honest owner later revokes the attacker's device and adds a new passkey.
  let honest = await append(shared, owner, { type: 'revoke_device', endpointId: attackerDevice.endpoint.id });
  honest = await append(honest, owner, await addAuthority(replacement, honest.accountId, honest.issuedAt));
  honest = await addDevice(honest, owner, 'Owner phone');
  // Without resolve_fork the stolen key cannot reinstate the device: revoked ids are permanent.
  await rejects(append(honest, stolen, { type: 'add_device', device: attackerDevice }), 'ledger_revoked');
  // One record directly on the shared prefix, naming the honest branch: valid, never adopted.
  const rewound = await raw(shared, stolen, resolveOp(shared.head, await headAt(honest, 3), honest.head, 5));
  assert.equal((await checkpointOf(rewound)).revision, 3);
  assert.deepEqual(await choose(honest, rewound), await verdict('keep', 'diverged', honest));
  await rejects(resolveForkTransition(shared.ledger, honest.ledger, stolen.credentialId, NOW), 'invalid_ledger', 'the builder refuses: no divergence');
  // Carrying the removal and the passkey makes a rewind adoptable, but then the device stays revoked and the passkey stays.
  const carried = await resolve(await addDevice(shared, stolen, 'Attacker branch'), honest, stolen);
  const result = await choose(honest, carried);
  assert.deepEqual(result, await resolved(honest, carried, 2));
  assert.deepEqual(result.checkpoint.revokedDeviceIds, [attackerDevice.endpoint.id]);
  assert.ok(result.checkpoint.devices.every(item => item.endpoint.id !== attackerDevice.endpoint.id));
  assert.ok(result.checkpoint.authorities.some(item => item.credentialId === replacement.credentialId));
});

test('divergent adoption at the genesis: a fork at the first transition is resolved by the genesis authority', async () => {
  const { a, genesisOnly } = await world();
  const local = await addDevice(genesisOnly, a, 'L1');
  const other = await addDevice(await addDevice(genesisOnly, a, 'O1'), a, 'O2');
  const chosen = await resolve(other, local, a);
  assert.deepEqual(chosen.ledger.transitions[2].payload.operation, resolveOp(genesisOnly.accountId, local.head, local.head, 1));
  assert.deepEqual(await choose(local, chosen), await resolved(local, chosen, 0));
});

test('a resolution names THE fork point of these two chains: one naming an earlier common record does not apply', async () => {
  const { a, base } = await world();
  const common = await addDevice(base, a, 'Common');
  const local = await addDevice(common, a, 'Local');
  const branch = await addDevice(common, a, 'Branch');
  // Valid as a chain (forkHead is an earlier record, the signer an authority there, Local is no record of it), but the true fork is `common`.
  const early = await raw(branch, a, resolveOp(base.head, local.head, local.head, 3));
  assert.equal((await checkpointOf(early)).revision, 5);
  assert.deepEqual(await choose(local, early), await verdict('keep', 'diverged', local));
  const genesisFork = await raw(branch, a, resolveOp(base.accountId, local.head, local.head, 1));
  assert.deepEqual(await choose(local, genesisFork), await verdict('keep', 'diverged', local), 'genesis as forkHead of a later fork');
  const exact = await resolve(branch, local, a);
  assert.deepEqual(await choose(local, exact), await resolved(local, exact, 3), 'the exact fork point applies');
});

test('a resolution never discards a branch it does not name: third branches and later forks are kept', async () => {
  const { a, base } = await world();
  const x = await addDevice(base, a, 'X');
  const y = await addDevice(base, a, 'Y');
  const z = await addDevice(base, a, 'Z');
  const yr = await resolve(y, x, a);
  assert.deepEqual(await choose(x, yr), await resolved(x, yr, 2), 'the named branch');
  assert.deepEqual(await choose(z, yr), await verdict('keep', 'diverged', z), 'replayed against a third branch');
  assert.deepEqual(await choose(x, await raw(y, a, resolveOp(base.head, z.head, z.head, 3))), await verdict('keep', 'diverged', x), 'discardedFirst of another branch');
  assert.deepEqual(await choose(x, await raw(y, a, resolveOp(base.head, randomHead(), randomHead(), 4))), await verdict('keep', 'diverged', x), 'unknown discardedFirst');
  // Every replica converges on yr and extends it; a later fork whose branch still carries the old resolution discards nothing.
  const s = await addDevice(yr, a, 'S');
  const u = await addDevice(s, a, 'U');
  const v = await addDevice(s, a, 'V');
  assert.deepEqual(await choose(u, v), await verdict('keep', 'diverged', u), 'an old resolution does not decide a later fork');
  // A replica still on x converges through the old resolution, whatever came after it.
  assert.deepEqual(await choose(x, v), await resolved(x, v, 2));
});

test('nested resolutions: a chain carrying two resolutions converges every replica it discarded, each from its own fork', async () => {
  const { a, base } = await world();
  const x = await addDevice(base, a, 'X');
  const y = await addDevice(base, a, 'Y');
  const z = await addDevice(base, a, 'Z');
  const s = await addDevice(await resolve(y, x, a), a, 'S');
  const u = await addDevice(s, a, 'U');
  const v = await addDevice(s, a, 'V');
  const final = await resolve(v, u, a);
  assert.deepEqual(final.ledger.transitions.filter(record => record.payload.operation.type === 'resolve_fork').map(record => record.payload.revision), [4, 7]);
  assert.deepEqual(await choose(u, final), await resolved(u, final, 5));
  assert.deepEqual(await choose(x, final), await resolved(x, final, 2));
  assert.deepEqual(await choose(s, final), await verdict('adopt', 'ahead', final));
  assert.deepEqual(await choose(z, final), await verdict('keep', 'diverged', z), 'a branch neither resolution names');
});

test('an authority added only on its own branch cannot discard the other branch', async () => {
  const { a, base } = await world();
  const b = await newPasskey();
  const legit = await addDevice(base, a, 'Legit');
  const attacker = await append(base, a, await addAuthority(b, base.accountId, base.issuedAt));
  const forged = await raw(attacker, b, resolveOp(base.head, legit.head, legit.head, 3));
  await rejects(checkpointOf(forged), 'invalid_ledger');
  assert.deepEqual(await choose(legit, forged), await verdict('reject', 'diverged', legit), 'invalid chain: rejected, never adopted');
  await rejects(resolveForkTransition(attacker.ledger, legit.ledger, b.credentialId, NOW), 'invalid_ledger', 'the builder refuses it too');
  const proper = await raw(attacker, a, resolveOp(base.head, legit.head, legit.head, 3));
  assert.deepEqual(await choose(legit, proper), await resolved(legit, proper, 2), 'the same resolution by an authority at the fork');
});

test('P3: a resolution cannot discard records newer than itself (withheld resolutions); the allowance is maxFutureSkewMs', async () => {
  const { a, base } = await world();
  const x = await addDevice(base, a, 'X');
  const yr = await resolve(await addDevice(base, a, 'Y'), x, a);
  const signedAt = yr.issuedAt;
  const atBound = await raw(x, a, await deviceOp(base.accountId, 'At the bound'), undefined, signedAt + SKEW);
  assert.deepEqual(await choose(atBound, yr), await resolved(atBound, yr, 2), 'issuedAt = R.issuedAt + maxFutureSkewMs: discardable');
  const beyond = await raw(x, a, await deviceOp(base.accountId, 'Beyond'), undefined, signedAt + SKEW + 1);
  assert.deepEqual(await choose(beyond, yr), await verdict('keep', 'diverged', beyond), 'one millisecond later: kept');
  const deeper = await addDevice(beyond, a, 'After that');
  assert.deepEqual(await choose(deeper, yr), await verdict('keep', 'diverged', deeper), 'a newer record anywhere on the branch');
  // The probe: the owner kept working on x after signing yr (withheld by the server) and revoked a lost iPad.
  const lost = await newDevice(base.accountId, 'Lost iPad');
  const withDevice = await append(base, a, { type: 'add_device', device: lost });
  const px = await addDevice(withDevice, a, 'X');
  const pyr = await resolve(await addDevice(withDevice, a, 'Y'), px, a);
  const laterWork = await raw(await raw(px, a, await deviceOp(base.accountId, 'New Mac'), undefined, pyr.issuedAt + SKEW + 1), a,
    { type: 'revoke_device', endpointId: lost.endpoint.id }, undefined, pyr.issuedAt + SKEW + 2);
  assert.deepEqual(await choose(laterWork, pyr), await verdict('keep', 'diverged', laterWork));
});

test('P4: an authority shared only after a resolution can roll it back, but only by discarding records that do not matter', async () => {
  const owner = await newPasskey();
  const late = await newPasskey();
  const base = await addDevice(await start(owner), owner, 'Base');
  const a1 = await append(base, owner, await addAuthority(late, base.accountId, base.issuedAt));
  const b1 = await addDevice(base, owner, 'B');
  await rejects(resolveForkTransition(a1.ledger, b1.ledger, late.credentialId, NOW), 'invalid_ledger', 'late was no authority at the fork');
  const rewind = async (target: Chain): Promise<Chain> => raw(a1, late, resolveOp(a1.head, await headAt(target, 3), target.head, target.ledger.transitions.length));
  const settled = await resolve(await addDevice(a1, owner, 'A2'), b1, owner);
  const rewound = await rewind(settled);
  const result = await choose(settled, rewound);
  assert.deepEqual(result, await resolved(settled, rewound, 2));
  assert.deepEqual(result.discarded.records.map(record => record.payload.operation.type), ['add_device', 'resolve_fork'], 'benign records only');
  assert.equal(await decisionOf(b1, rewound), 'keep', 'b1 holders are not rewound: forkHead is not their fork point');
  // Had the settled branch removed anything (or added a passkey), the same rewind would not apply.
  const guardedBranch = await resolve(await tombstone(await addDevice(a1, owner, 'A2'), owner), b1, owner);
  assert.deepEqual(await choose(guardedBranch, await rewind(guardedBranch)), await verdict('keep', 'diverged', guardedBranch));
});

test('L1/P5: replicas of the losing branch converge by its first record (laggards, extended and sibling replicas) unless they hold something newer or security-relevant', async () => {
  const { a, base } = await world();
  const x = await addDevice(base, a, 'X');
  const y1 = await addDevice(base, a, 'Y1');
  const y2 = await addDevice(y1, a, 'Y2');
  const xr = await resolve(x, y2, a);
  assert.deepEqual(xr.ledger.transitions[3].payload.operation, resolveOp(base.head, y1.head, y2.head, 4));
  assert.deepEqual(await choose(y2, xr), await resolved(y2, xr, 2), 'up-to-date loser');
  assert.deepEqual(await choose(y1, xr), await resolved(y1, xr, 2), 'laggard: holds fewer records than discardedRevision');
  const older = await raw(y2, a, await deviceOp(base.accountId, 'Y3'), undefined, xr.issuedAt + SKEW);
  assert.deepEqual(await choose(older, xr), await resolved(older, xr, 2), 'extended with an older-dated benign record');
  const newer = await raw(y2, a, await deviceOp(base.accountId, 'Y3'), undefined, xr.issuedAt + SKEW + 1);
  assert.deepEqual(await choose(newer, xr), await verdict('keep', 'diverged', newer), 'extended with a newer record');
  const revoked = await tombstone(y2, a);
  assert.deepEqual(await choose(revoked, xr), await verdict('keep', 'diverged', revoked), 'extended with a revocation');
  const sibling = await addDevice(y1, a, 'Y2 sibling');
  assert.deepEqual(await choose(sibling, xr), await resolved(sibling, xr, 2), 'sibling sub-branch sharing the first record');
  const siblingNewer = await raw(sibling, a, await deviceOp(base.accountId, 'S3'), undefined, xr.issuedAt + SKEW + 1);
  assert.deepEqual(await choose(siblingNewer, xr), await verdict('keep', 'diverged', siblingNewer), 'sibling with a newer record');
  const siblingRevoked = await tombstone(sibling, a);
  assert.deepEqual(await choose(siblingRevoked, xr), await verdict('keep', 'diverged', siblingRevoked), 'sibling with a revocation');
  const z = await addDevice(base, a, 'Z');
  assert.deepEqual(await choose(z, xr), await verdict('keep', 'diverged', z), 'a branch with another first record');
});

test('"saw it" with first-record matching: a replica holding its own resolution is discarded only by one naming its own record at or after it', async () => {
  const { a, base } = await world();
  const y = await addDevice(base, a, 'Y1');
  const yResolved = await resolve(y, await addDevice(base, a, 'W'), a);
  const yUp = await addDevice(yResolved, a, 'Y3');
  const x = await addDevice(base, a, 'X');
  const xr = await resolve(x, yUp, a);
  assert.deepEqual(xr.ledger.transitions[3].payload.operation, resolveOp(base.head, y.head, yUp.head, 5));
  assert.deepEqual(await choose(yUp, xr), await resolved(yUp, xr, 2), 'names Y3, after this replica\'s resolution (revision 4)');
  assert.deepEqual(await choose(y, xr), await resolved(y, xr, 2), 'a laggard from before that resolution has nothing to have seen');
  // A laggard that holds the resolution but not Y3: revision 5 >= 4 alone does not prove the signer saw it, so the replica waits.
  assert.deepEqual(await choose(yResolved, xr), await verdict('keep', 'diverged', yResolved));
  const again = await resolve(x, yResolved, a);
  assert.deepEqual(await choose(yResolved, again), await resolved(yResolved, again, 2), 'a resolution naming its own tip');
});

test('two resolutions that each saw only a sibling of the other branch never flip replicas: a revision number is not proof of having seen', async () => {
  const { a, base } = await world();
  const y1 = await addDevice(base, a, 'Y1');
  const x1 = await addDevice(base, a, 'X1');
  const ys = await addDevice(await addDevice(y1, a, 'Y2'), a, 'Y3');
  const xs = await addDevice(await addDevice(x1, a, 'X2'), a, 'X3');
  const keepY = await resolve(y1, xs, a);
  const keepX = await resolve(x1, ys, a);
  assert.deepEqual(keepX.ledger.transitions[3].payload.operation, resolveOp(base.head, y1.head, ys.head, 5));
  assert.deepEqual(await choose(keepY, keepX), await verdict('keep', 'diverged', keepY));
  assert.deepEqual(await choose(keepX, keepY), await verdict('keep', 'diverged', keepX));
  assert.deepEqual(await choose(ys, keepX), await resolved(ys, keepX, 2));
  assert.deepEqual(await choose(y1, keepX), await resolved(y1, keepX, 2));
  assert.deepEqual(await choose(xs, keepY), await resolved(xs, keepY, 2));
  const final = await resolve(keepY, keepX, a);
  assert.deepEqual(await choose(keepX, final), await resolved(keepX, final, 2));
  assert.deepEqual(await choose(keepY, final), await verdict('adopt', 'ahead', final));
  for (const stale of [keepX, ys, xs, y1, x1]) assert.notEqual(await decisionOf(final, stale), 'adopt');
});

test('conflicting resolutions never flip replicas back and forth; a later choice that saw both wins', async () => {
  const { a, base } = await world();
  const p = await addDevice(base, a, 'P');
  const q = await addDevice(base, a, 'Q');
  const pr = await resolve(p, q, a);
  const qr = await resolve(q, p, a);
  assert.deepEqual(await choose(pr, qr), await verdict('keep', 'diverged', pr));
  assert.deepEqual(await choose(qr, pr), await verdict('keep', 'diverged', qr));
  assert.equal(await decisionOf(p, qr), 'adopt', 'a replica that never resolved follows whichever resolution reaches it');
  assert.equal(await decisionOf(q, pr), 'adopt');
  const final = await resolve(pr, qr, a);
  assert.deepEqual(await choose(qr, final), await resolved(qr, final, 2));
  assert.deepEqual(await choose(pr, final), await verdict('adopt', 'ahead', final));
  for (const stale of [qr, q, p, pr]) assert.notEqual(await decisionOf(final, stale), 'adopt');
});

test('P1: resolutions in a cycle (3 and 4 branches) never make a replica rotate; one informed resolution converges every replica', async () => {
  for (const size of [3, 4]) {
    const { a, base } = await world();
    const branches: Chain[] = [];
    for (let index = 0; index < size; index += 1) branches.push(await addDevice(base, a, `B${index}`));
    // Concurrent owner choices with stale views: each keeps branch i over branch i + 1 (mod size).
    const cycle: Chain[] = [];
    for (let index = 0; index < size; index += 1) cycle.push(await resolve(branches[index], branches[(index + 1) % size], a));
    // The probe's rotation: a replica on cycle[0] offered cycle[size - 1], ..., cycle[0], twice.
    let held = cycle[0];
    for (let round = 0; round < 2; round += 1) {
      for (let index = size - 1; index >= 0; index -= 1) {
        const result = await choose(held, cycle[index]);
        assert.notEqual(result.decision, 'adopt', `size ${size}: no rotation`);
        held = { ...held, ledger: result.ledger };
      }
    }
    for (const local of cycle) {
      for (const candidate of cycle) if (local !== candidate) assert.deepEqual(await choose(local, candidate), await verdict('keep', 'diverged', local), `size ${size}`);
    }
    for (let index = 0; index < size; index += 1) assert.equal(await decisionOf(branches[(index + 1) % size], cycle[index]), 'adopt', 'unresolved replicas still follow');
    let fixed = cycle[0];
    for (let index = 1; index < size; index += 1) fixed = await resolve(fixed, cycle[index], a);
    for (const stale of [...cycle, ...branches]) {
      assert.equal(await decisionOf(stale, fixed), 'adopt', `size ${size}: converges`);
      assert.notEqual(await decisionOf(fixed, stale), 'adopt', `size ${size}: never undone`);
    }
  }
});

test('a candidate ahead of local that carries a resolve_fork takes the normal ahead path', async () => {
  const { a, base } = await world();
  const x = await addDevice(base, a, 'X');
  const y = await addDevice(base, a, 'Y');
  const yr = await resolve(y, x, a);
  const later = await addDevice(await addDevice(yr, a, 'L1'), a, 'L2');
  const yCache = await cacheFor(y);
  const [first, firstCount] = await verifications(() => chooseLedger(y.ledger, later.ledger, NOW, yCache));
  assert.deepEqual(first, await verdict('adopt', 'ahead', later));
  assert.equal(firstCount, 3, 'the resolution is in the new part: checked against local\'s history');
  const yrCache = await cacheFor(yr);
  const [second, secondCount] = await verifications(() => chooseLedger(yr.ledger, later.ledger, NOW, yrCache));
  assert.deepEqual(second, await verdict('adopt', 'ahead', later));
  assert.equal(secondCount, 2, 'the resolution is in the shared prefix: never re-examined');
  assert.deepEqual(await choose(later, yr), await verdict('keep', 'behind', later));
});

test('a diverged candidate with a matching resolution is still verified after the fork: invalid means reject', async () => {
  const { a, base } = await world();
  const x = await addDevice(base, a, 'X');
  const y = await addDevice(base, a, 'Y');
  assert.deepEqual(await choose(x, await resolve(y, x, a, { uv: false })), await verdict('reject', 'diverged', x), 'bad resolution signature');
  const yr = await resolve(y, x, a);
  const corruptBranch = tamper(yr.ledger, copy => { copy.transitions[2].signature = copy.transitions[3].signature; });
  assert.deepEqual(await chooseLedger(x.ledger, corruptBranch, NOW, await cacheFor(x)), await verdict('reject', 'diverged', x), 'bad branch record before it');
});

test('resolveForkTransition refuses chains that do not diverge, another account, signers that were not authorities at the fork, and incomplete carries', async () => {
  const { a, base } = await world();
  const b = await newPasskey();
  const x = await addDevice(base, a, 'X');
  const ahead = await addDevice(x, a, 'X4');
  const y = await append(await addDevice(base, a, 'Y'), a, await addAuthority(b, base.accountId, base.issuedAt));
  for (const [name, chosen, other] of [['same', x, x], ['ahead', x, ahead], ['behind', ahead, x]] as const) {
    await rejects(resolveForkTransition(chosen.ledger, other.ledger, a.credentialId, NOW), 'invalid_ledger', name);
  }
  await rejects(resolveForkTransition(x.ledger, (await world()).base.ledger, a.credentialId, NOW), 'ledger_other_account');
  await rejects(resolveForkTransition(y.ledger, x.ledger, b.credentialId, NOW), 'invalid_ledger', 'joined after the fork');
  await rejects(resolveForkTransition(y.ledger, x.ledger, (await newPasskey()).credentialId, NOW), 'invalid_ledger', 'stranger');
  await rejects(resolveForkTransition(y.ledger, x.ledger, 'not base64url!', NOW), 'invalid_ledger', 'malformed credentialId');
  await rejects(resolveForkTransition(tamper(y.ledger, copy => { copy.transitions[2].signature = copy.transitions[3].signature; }), x.ledger, a.credentialId, NOW), 'invalid_ledger', 'chosen is invalid');
  // Keeping x over y would discard the passkey y added: first carry it.
  await rejects(resolveForkTransition(x.ledger, y.ledger, a.credentialId, NOW), 'resolution_incomplete');
  // A vouching cache skips re-verifying the chosen chain; the payload is the same.
  const yCacheLocal = await cacheFor(y);
  const [cached, count] = await verifications(() => resolveForkTransition(y.ledger, x.ledger, a.credentialId, NOW, yCacheLocal));
  assert.equal(count, 0);
  assert.deepEqual(cached, await resolveForkTransition(y.ledger, x.ledger, a.credentialId, NOW));
  assert.deepEqual(cached.operation, resolveOp(base.head, x.head, x.head, 3));
  assert.equal(cached.issuedAt, NOW, 'issuedAt = max(now, last issuedAt)');
});

test('describeFork lists both sides after the fork point as payloads, for every relation', async () => {
  const { a, base, genesisOnly } = await world();
  const local = await addDevice(await append(base, a, { type: 'revoke_bridge', bridgeId: 'studio' }), a, 'Mine');
  const other = await addDevice(base, a, 'Theirs');
  const [fork, count] = await verifications(() => describeFork(local.ledger, other.ledger));
  assert.equal(count, 0, 'no signature work');
  assert.deepEqual(fork, {
    relation: 'diverged', fork: { revision: 2, head: base.head },
    mine: local.ledger.transitions.slice(2).map(record => record.payload), theirs: other.ledger.transitions.slice(2).map(record => record.payload),
  });
  assert.ok(!JSON.stringify(fork).includes('clientDataJSON'), 'payloads only');
  assert.deepEqual(await describeFork(other.ledger, local.ledger), { relation: 'diverged', fork: fork.fork, mine: fork.theirs, theirs: fork.mine });
  assert.deepEqual(await describeFork(local.ledger, local.ledger), { relation: 'same', fork: { revision: 4, head: local.head }, mine: [], theirs: [] });
  assert.deepEqual(await describeFork(base.ledger, local.ledger), { relation: 'ahead', fork: { revision: 2, head: base.head }, mine: [], theirs: fork.mine });
  assert.deepEqual(await describeFork(local.ledger, genesisOnly.ledger), {
    relation: 'behind', fork: { revision: 0, head: base.accountId }, mine: local.ledger.transitions.map(record => record.payload), theirs: [],
  });
  await rejects(describeFork(local.ledger, (await world()).base.ledger), 'ledger_other_account');
});
