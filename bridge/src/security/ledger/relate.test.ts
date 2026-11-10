import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { EndpointPublic } from '../protocol.js';
import { LEDGER_LIMITS } from './protocol.js';
import type { Ledger, LedgerCheckpoint, LedgerDevice, LedgerGenesis, LedgerOperation, LedgerTransition, Signed } from './protocol.js';
import {
  LedgerError, accountIdOf, authorityConsentChallenge, chooseLedger, describeFork, forkPoint, ledgerChallenge, ledgerHead, ledgerHeads,
  ledgerLastIssuedAt, nextTransition, parseLedger, relate, relateHead, resolveForkTransition, verifyLedger,
} from './ledger.js';
import type { LedgerCache, LedgerChoice, LedgerDiscarded, LedgerErrorCode, LedgerRelation } from './ledger.js';
import { createSoftPasskey } from './testing.js';
import type { SoftPasskey, SoftPasskeySignOptions } from './testing.js';

const rpId = 'ftown.example';
const origin = 'https://ftown.example';
const T0 = 1_750_000_000_000;
const NOW = T0 + 3_600_000;
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
async function addAuthority(passkey: SoftPasskey, accountId: string, addedAt: number): Promise<LedgerOperation> {
  const authority = { credentialId: passkey.credentialId, publicKey: passkey.publicKey, label: 'Second key', addedAt };
  return { type: 'add_authority', authority, consent: await passkey.sign(await authorityConsentChallenge(accountId, authority)) };
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
/** Hand-built record that bypasses every builder check. */
function raw(chain: Chain, passkey: SoftPasskey, operation: LedgerOperation, options?: SoftPasskeySignOptions): Promise<Chain> {
  return grow(chain, passkey, {
    type: 'ftown_account_transition', version: 2, accountId: chain.accountId, revision: chain.ledger.transitions.length + 1,
    previousHead: chain.head, issuedAt: chain.issuedAt + 1000, credentialId: passkey.credentialId, operation,
  }, options);
}
/** The signer's real path: verify, nextTransition, sign. */
async function append(chain: Chain, passkey: SoftPasskey, operation: LedgerOperation): Promise<Chain> {
  return grow(chain, passkey, nextTransition(await verifyLedger(chain.ledger, NOW), passkey.credentialId, operation, chain.issuedAt + 1000, ledgerLastIssuedAt(chain.ledger)));
}
async function addDevice(chain: Chain, passkey: SoftPasskey, label: string): Promise<Chain> {
  return append(chain, passkey, { type: 'add_device', device: await newDevice(chain.accountId, label) });
}
/** The owner's choice through the production builder: keep `chosen`, discard `other`, signed by `passkey`. */
async function resolve(chosen: Chain, other: Chain, passkey: SoftPasskey, options?: SoftPasskeySignOptions): Promise<Chain> {
  return grow(chosen, passkey, await resolveForkTransition(chosen.ledger, other.ledger, passkey.credentialId, chosen.issuedAt + 1000), options);
}
const resolveOp = (forkHead: string, discardedHead: string, discardedRevision: number): ResolveFork => ({ type: 'resolve_fork', forkHead, discardedHead, discardedRevision });
/** genesis (authority a), add_device `device`, add_bridge 'studio'. */
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
async function verdict(decision: LedgerChoice['decision'], relation: LedgerRelation | null, holds: Chain): Promise<LedgerChoice> {
  return { decision, relation, checkpoint: await checkpointOf(holds), discarded: NONE };
}
/** chooseLedger with and without a vouching cache must agree; returns the verdict. */
async function choose(local: Chain, candidate: Chain): Promise<LedgerChoice> {
  const plain = await chooseLedger(local.ledger, candidate.ledger, NOW);
  assert.deepEqual(await chooseLedger(local.ledger, candidate.ledger, NOW, await cacheFor(local)), plain, 'cache path decides like the full path');
  return plain;
}
/** Counts ECDSA verifications (one per passkey assertion) while `run` executes. */
async function verifications<T>(run: () => Promise<T>): Promise<[T, number]> {
  const spy = mock.method(crypto.subtle, 'verify');
  try {
    const result = await run();
    return [result, spy.mock.callCount()];
  } finally {
    spy.mock.restore();
  }
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
  const op = async (label: string): Promise<LedgerOperation> => ({ type: 'add_device', device: await newDevice(base.accountId, label) });
  const lastBad = await raw(await addDevice(local, a, 'Good'), a, await op('Bad'), { uv: false });
  const middleBad = await raw(await raw(await addDevice(local, a, 'Good'), a, await op('Bad'), { origin: 'https://evil.example' }), a, await op('After'));
  const firstBad = await raw(local, a, await op('Bad'), { rpId: 'evil.example' });
  const rejected = await verdict('reject', 'ahead', local);
  for (const [name, candidate] of [['last', lastBad], ['middle', middleBad], ['first', firstBad]] as const) {
    assert.deepEqual(await choose(local, candidate), rejected, name);
  }
  assert.deepEqual(local.ledger, before, 'local input is never mutated');
});

test('resolve_fork as a record: built by resolveForkTransition, strict shape, changes no membership', async () => {
  const { a, base } = await world();
  const mine = await addDevice(base, a, 'Mine');
  const theirs = await addDevice(base, a, 'Theirs');
  const payload = await resolveForkTransition(theirs.ledger, mine.ledger, a.credentialId, theirs.issuedAt + 1000);
  assert.deepEqual(payload, {
    type: 'ftown_account_transition', version: 2, accountId: base.accountId, revision: 4, previousHead: theirs.head, issuedAt: theirs.issuedAt + 1000,
    credentialId: a.credentialId, operation: resolveOp(base.head, mine.head, 3),
  });
  const resolved = await grow(theirs, a, payload);
  const before = await checkpointOf(theirs);
  const after = await checkpointOf(resolved);
  assert.deepEqual({ ...after, revision: before.revision, head: before.head }, before, 'membership unchanged');
  assert.equal(after.revision, 4);
  const shapes: [string, unknown][] = [
    ['extra key', { ...payload.operation, extra: 1 }],
    ['missing discardedRevision', { type: 'resolve_fork', forkHead: base.head, discardedHead: mine.head }],
    ['forkHead of 31 bytes', { ...payload.operation, forkHead: b64(new Uint8Array(31)) }],
    ['padded discardedHead', { ...payload.operation, discardedHead: `${mine.head}=` }],
    ['discardedRevision 0', { ...payload.operation, discardedRevision: 0 }],
    ['discardedRevision as a string', { ...payload.operation, discardedRevision: '3' }],
    ['fractional discardedRevision', { ...payload.operation, discardedRevision: 3.5 }],
    ['discardedRevision beyond maxTransitions', { ...payload.operation, discardedRevision: LEDGER_LIMITS.maxTransitions + 1 }],
  ];
  for (const [name, operation] of shapes) {
    throws(() => parseLedger(tamper(resolved.ledger, copy => { copy.transitions[3].payload.operation = operation as LedgerOperation; })), 'invalid_ledger', name);
  }
  // The builder: shape and the history-free rules only; it counts against maxTransitions like any record.
  const checkpoint = await checkpointOf(theirs);
  const at = theirs.issuedAt + 1000;
  assert.equal(nextTransition(checkpoint, a.credentialId, resolveOp(base.head, mine.head, 3), at).revision, 4);
  throws(() => nextTransition(checkpoint, a.credentialId, resolveOp(base.head, base.head, 3), at), 'invalid_ledger', 'discardedHead = forkHead');
  throws(() => nextTransition(checkpoint, a.credentialId, resolveOp(base.head, theirs.head, 3), at), 'invalid_ledger', 'discardedHead = own previous head');
  throws(() => nextTransition(checkpoint, a.credentialId, resolveOp(base.head, base.accountId, 3), at), 'invalid_ledger', 'discardedHead = genesis');
  throws(() => nextTransition({ ...checkpoint, revision: LEDGER_LIMITS.maxTransitions }, a.credentialId, resolveOp(base.head, mine.head, 3), at), 'ledger_limit');
  const stranger = await newPasskey();
  throws(() => nextTransition(checkpoint, stranger.credentialId, resolveOp(base.head, mine.head, 3), at), 'invalid_ledger', 'not an authority');
});

test('resolve_fork history rules: forkHead is an earlier record of the same chain, the signer an authority at it, the discarded record after it', async () => {
  const { a, base } = await world();
  const b = await newPasskey();
  const mine = await addDevice(base, a, 'Mine');
  const theirs = await addDevice(base, a, 'Theirs');
  const later = await addDevice(theirs, a, 'Later');
  const valid = async (chain: Chain, signer: SoftPasskey, operation: ResolveFork): Promise<number> => (await checkpointOf(await raw(chain, signer, operation))).revision;
  const invalid = async (chain: Chain, signer: SoftPasskey, operation: ResolveFork, name: string): Promise<void> => {
    await rejects(checkpointOf(await raw(chain, signer, operation)), 'invalid_ledger', name);
  };
  assert.equal(await valid(theirs, a, resolveOp(base.head, mine.head, 3)), 4, 'the true fork point');
  assert.equal(await valid(theirs, a, resolveOp(base.accountId, mine.head, 3)), 4, 'forkHead may be the genesis');
  assert.equal(await valid(theirs, a, resolveOp(theirs.head, randomHead(), 4)), 4, 'forkHead may be the previous record');
  await invalid(theirs, a, resolveOp(randomHead(), mine.head, 3), 'forkHead not in the chain');
  await invalid(theirs, a, resolveOp(mine.head, randomHead(), 4), 'forkHead of another branch');
  // A record cannot name a head after its own position: `later` is revision 4 of a sibling chain, the record is revision 4 here.
  await invalid(theirs, a, resolveOp(later.head, randomHead(), 5), 'forkHead after its own position');
  await invalid(theirs, a, resolveOp(base.head, mine.head, 2), 'discardedRevision equal to the fork revision');
  await invalid(theirs, a, resolveOp(base.head, mine.head, 1), 'discardedRevision before the fork');
  await invalid(theirs, a, resolveOp(base.accountId, base.head, 2), 'discardedHead is a record of this chain');
  await invalid(theirs, a, resolveOp(base.accountId, theirs.head, 3), 'discardedHead is the previous record (self-reference)');
  await invalid(theirs, a, resolveOp(base.head, base.head, 3), 'discardedHead = forkHead');
  await invalid(theirs, b, resolveOp(base.head, mine.head, 3), 'signer not an authority at all');

  // Authorities are add-only (protocol.ts: no revoke_authority; parseLedger refuses one), so "an authority at forkHead" means "joined at or before it".
  const withB = await append(theirs, a, await addAuthority(b, base.accountId, theirs.issuedAt));
  await invalid(withB, b, resolveOp(base.head, mine.head, 3), 'b joined after forkHead, on this branch only');
  assert.equal(await valid(withB, a, resolveOp(base.head, mine.head, 3)), 5, 'a was an authority at forkHead');
  assert.equal(await valid(withB, b, resolveOp(withB.head, randomHead(), 5)), 5, 'b is an authority at the record that added it');
  assert.equal((await checkpointOf(await raw(withB, b, { type: 'revoke_bridge', bridgeId: 'studio' }))).revision, 5, 'b signs ordinary records');
  const sharedB = await append(base, a, await addAuthority(b, base.accountId, base.issuedAt));
  const sharedMine = await addDevice(sharedB, a, 'Mine');
  const sharedTheirs = await addDevice(sharedB, a, 'Theirs');
  assert.equal(await valid(sharedTheirs, b, resolveOp(sharedB.head, sharedMine.head, 4)), 5, 'an authority added before the fork may resolve it');
});

test('divergent adoption: the owner-signed resolve_fork replaces the other branch, and its removals are returned to stay enforced', async () => {
  const { a, base, device } = await world();
  let local = await append(base, a, { type: 'revoke_bridge', bridgeId: 'studio' });
  local = await append(local, a, { type: 'revoke_device', endpointId: device.endpoint.id });
  local = await addDevice(local, a, 'Only here');
  const other = await addDevice(base, a, 'Phone');
  const chosen = await resolve(other, local, a);
  assert.deepEqual(chosen.ledger.transitions[3].payload.operation, resolveOp(base.head, local.head, 5));
  const result = await choose(local, chosen);
  assert.deepEqual(result, {
    decision: 'adopt', relation: 'diverged', checkpoint: await checkpointOf(chosen),
    discarded: { records: local.ledger.transitions.slice(2), deviceIds: [device.endpoint.id], bridgeIds: ['studio'] },
  });
  assert.deepEqual(result.checkpoint.devices.map(item => item.endpoint.id).indexOf(device.endpoint.id), 0, 'the removed device is a member of the adopted chain: the sticky set must keep it out');
  // The replica that holds the chosen branch sees a plain extension.
  assert.deepEqual(await choose(other, chosen), await verdict('adopt', 'ahead', chosen));
  // Without the resolution the same branch is only a different history; after adoption the old branch is one too.
  assert.deepEqual(await choose(local, other), await verdict('keep', 'diverged', local));
  assert.deepEqual(await choose(chosen, local), await verdict('keep', 'diverged', chosen));
  // The other way round: keeping local's history discards `other`, which revoked nothing.
  const kept = await resolve(local, other, a);
  assert.deepEqual(await choose(other, kept), {
    decision: 'adopt', relation: 'diverged', checkpoint: await checkpointOf(kept), discarded: { records: other.ledger.transitions.slice(2), deviceIds: [], bridgeIds: [] },
  });
  // A revocation that the adopted chain also makes is not returned.
  const alsoRevoked = await resolve(await append(base, a, { type: 'revoke_device', endpointId: device.endpoint.id }), local, a);
  assert.deepEqual((await choose(local, alsoRevoked)).discarded, { records: local.ledger.transitions.slice(2), deviceIds: [], bridgeIds: ['studio'] });
});

test('divergent adoption at the genesis: a fork at the first transition is resolved by the genesis authority', async () => {
  const { a, genesisOnly } = await world();
  const local = await addDevice(genesisOnly, a, 'L1');
  const other = await addDevice(await addDevice(genesisOnly, a, 'O1'), a, 'O2');
  const chosen = await resolve(other, local, a);
  assert.deepEqual(chosen.ledger.transitions[2].payload.operation, resolveOp(genesisOnly.accountId, local.head, 1));
  const result = await choose(local, chosen);
  assert.equal(result.decision, 'adopt');
  assert.deepEqual(result.discarded.records, local.ledger.transitions);
});

test('a resolution names THE fork point of these two chains: one naming an earlier common record does not apply', async () => {
  const { a, base } = await world();
  const common = await addDevice(base, a, 'Common');
  const local = await addDevice(common, a, 'Local');
  const branch = await addDevice(common, a, 'Branch');
  // Valid as a chain (forkHead is an earlier record, the signer an authority there), but the true fork of local and branch is `common`.
  const early = await raw(branch, a, resolveOp(base.head, local.head, 4));
  assert.equal((await checkpointOf(early)).revision, 5);
  assert.deepEqual(await choose(local, early), await verdict('keep', 'diverged', local));
  const genesisFork = await raw(branch, a, resolveOp(base.accountId, local.head, 4));
  assert.deepEqual(await choose(local, genesisFork), await verdict('keep', 'diverged', local), 'genesis as forkHead of a later fork');
  assert.equal((await choose(local, await resolve(branch, local, a))).decision, 'adopt', 'the exact fork point applies');
});

test('a resolution never discards a branch it does not name: third branches, later branches and wrong revisions are kept', async () => {
  const { a, base } = await world();
  const x = await addDevice(base, a, 'X');
  const y = await addDevice(base, a, 'Y');
  const z = await addDevice(base, a, 'Z');
  const yr = await resolve(y, x, a);
  assert.equal((await choose(x, yr)).decision, 'adopt', 'the named branch');
  assert.deepEqual(await choose(z, yr), await verdict('keep', 'diverged', z), 'replayed against a third branch');
  const againstZ = await raw(y, a, resolveOp(base.head, z.head, 3));
  assert.deepEqual(await choose(x, againstZ), await verdict('keep', 'diverged', x), 'discardedHead on another branch');
  const x4 = await addDevice(x, a, 'X4');
  assert.deepEqual(await choose(x4, await raw(y, a, resolveOp(base.head, x.head, 4))), await verdict('keep', 'diverged', x4), 'discardedHead at the wrong revision');
  assert.deepEqual(await choose(x4, await raw(y, a, resolveOp(base.head, randomHead(), 3))), await verdict('keep', 'diverged', x4), 'unknown discardedHead');
  assert.deepEqual(await choose(x, await raw(y, a, resolveOp(base.head, x.head, 9))), await verdict('keep', 'diverged', x), 'discardedRevision beyond local');
  // Every replica converges on yr and extends it; a later fork whose branch still carries the old resolution discards nothing.
  const s = await addDevice(yr, a, 'S');
  const u = await addDevice(s, a, 'U');
  const v = await addDevice(s, a, 'V');
  assert.deepEqual(await choose(u, v), await verdict('keep', 'diverged', u), 'an old resolution does not decide a later fork');
  // A replica still on x converges through the old resolution, whatever came after it.
  const stale = await choose(x, v);
  assert.equal(stale.decision, 'adopt');
  assert.deepEqual(stale.discarded.records, x.ledger.transitions.slice(2));
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
  const fromU = await choose(u, final);
  assert.deepEqual([fromU.decision, fromU.relation, fromU.discarded.records], ['adopt', 'diverged', u.ledger.transitions.slice(5)]);
  const fromX = await choose(x, final);
  assert.deepEqual([fromX.decision, fromX.relation, fromX.discarded.records], ['adopt', 'diverged', x.ledger.transitions.slice(2)]);
  assert.deepEqual(await choose(s, final), await verdict('adopt', 'ahead', final));
  assert.deepEqual(await choose(z, final), await verdict('keep', 'diverged', z), 'a branch neither resolution names');
});

test('an authority added only on its own branch cannot discard the other branch', async () => {
  const { a, base } = await world();
  const b = await newPasskey();
  const legit = await addDevice(base, a, 'Legit');
  const attacker = await append(base, a, await addAuthority(b, base.accountId, base.issuedAt));
  const forged = await raw(attacker, b, resolveOp(base.head, legit.head, 3));
  await rejects(checkpointOf(forged), 'invalid_ledger');
  assert.deepEqual(await choose(legit, forged), await verdict('reject', 'diverged', legit), 'invalid chain: rejected, never adopted');
  await rejects(resolveForkTransition(attacker.ledger, legit.ledger, b.credentialId, NOW), 'invalid_ledger', 'the builder refuses it too');
  const proper = await raw(attacker, a, resolveOp(base.head, legit.head, 3));
  assert.equal((await choose(legit, proper)).decision, 'adopt', 'the same resolution by an authority at the fork');
});

test('ancestor rule: a replica that extended its branch after the resolution was signed still converges', async () => {
  const { a, base } = await world();
  const x = await addDevice(base, a, 'X');
  const yr = await resolve(await addDevice(base, a, 'Y'), x, a);
  const extended = await append(await addDevice(x, a, 'X4'), a, { type: 'revoke_bridge', bridgeId: 'studio' });
  const result = await choose(extended, yr);
  assert.deepEqual(result, {
    decision: 'adopt', relation: 'diverged', checkpoint: await checkpointOf(yr),
    discarded: { records: extended.ledger.transitions.slice(2), deviceIds: [], bridgeIds: ['studio'] },
  });
});

test('a candidate ahead of local that carries a resolve_fork takes the normal ahead path', async () => {
  const { a, base } = await world();
  const x = await addDevice(base, a, 'X');
  const y = await addDevice(base, a, 'Y');
  const yr = await resolve(y, x, a);
  const later = await addDevice(await addDevice(yr, a, 'L1'), a, 'L2');
  // The resolution is in the new part: checked against local's history, one verification per new record.
  const yCache = await cacheFor(y);
  const [first, firstCount] = await verifications(() => chooseLedger(y.ledger, later.ledger, NOW, yCache));
  assert.deepEqual(first, await verdict('adopt', 'ahead', later));
  assert.equal(firstCount, 3);
  // The resolution is in the shared prefix: never re-examined.
  const yrCache = await cacheFor(yr);
  const [second, secondCount] = await verifications(() => chooseLedger(yr.ledger, later.ledger, NOW, yrCache));
  assert.deepEqual(second, await verdict('adopt', 'ahead', later));
  assert.equal(secondCount, 2);
  assert.deepEqual(await choose(later, yr), await verdict('keep', 'behind', later));
});

test('conflicting resolutions never flip replicas back and forth; a later choice that saw both wins', async () => {
  const { a, base } = await world();
  const p = await addDevice(base, a, 'P');
  const q = await addDevice(base, a, 'Q');
  // Two concurrent, opposite choices: neither saw the other.
  const pr = await resolve(p, q, a);
  const qr = await resolve(q, p, a);
  assert.deepEqual(await choose(pr, qr), await verdict('keep', 'diverged', pr));
  assert.deepEqual(await choose(qr, pr), await verdict('keep', 'diverged', qr));
  // A replica that never resolved follows whichever resolution reaches it.
  assert.equal((await choose(p, qr)).decision, 'adopt');
  assert.equal((await choose(q, pr)).decision, 'adopt');
  // The owner chooses again with both in view.
  const final = await resolve(pr, qr, a);
  const fromQr = await choose(qr, final);
  assert.deepEqual([fromQr.decision, fromQr.relation, fromQr.discarded.records], ['adopt', 'diverged', qr.ledger.transitions.slice(2)]);
  assert.deepEqual(await choose(pr, final), await verdict('adopt', 'ahead', final));
  // And nothing flips back.
  for (const stale of [qr, q, p, pr]) assert.notEqual((await choose(final, stale)).decision, 'adopt');
});

test('a diverged candidate with a matching resolution is still verified: invalid means reject; other prefix bytes mean full verification', async () => {
  const { a, base } = await world();
  const x = await addDevice(base, a, 'X');
  const y = await addDevice(base, a, 'Y');
  assert.deepEqual(await choose(x, await resolve(y, x, a, { uv: false })), await verdict('reject', 'diverged', x), 'bad resolution signature');
  const yr = await resolve(y, x, a);
  const corruptY = tamper(yr.ledger, copy => { copy.transitions[2].signature = copy.transitions[3].signature; });
  assert.deepEqual(await chooseLedger(x.ledger, corruptY, NOW, await cacheFor(x)), await verdict('reject', 'diverged', x), 'bad branch record before it');
  // The candidate's copy of the shared prefix has fresh (valid) signature bytes: verified from genesis, then adopted.
  const resigned: Ledger = { genesis: await signed(a, yr.ledger.genesis.payload), transitions: yr.ledger.transitions };
  const xCache = await cacheFor(x);
  const [result, count] = await verifications(() => chooseLedger(x.ledger, resigned, NOW, xCache));
  assert.equal(result.decision, 'adopt');
  assert.equal(count, 1 + 4, 'genesis and every record');
  const tamperedPrefix = tamper(yr.ledger, copy => { copy.genesis.signature = copy.transitions[0].signature; });
  assert.deepEqual(await chooseLedger(x.ledger, tamperedPrefix, NOW, xCache), await verdict('reject', 'diverged', x), 'corrupt prefix copy');
});

test('resolveForkTransition refuses chains that do not diverge, another account, and signers that were not authorities at the fork', async () => {
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
  // A vouching cache skips re-verifying the chosen chain; the payload is the same.
  const yCacheLocal = await cacheFor(y);
  const [cached, count] = await verifications(() => resolveForkTransition(y.ledger, x.ledger, a.credentialId, NOW, yCacheLocal));
  assert.equal(count, 0);
  assert.deepEqual(cached, await resolveForkTransition(y.ledger, x.ledger, a.credentialId, NOW));
  assert.deepEqual(cached.operation, resolveOp(base.head, x.head, 3));
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
