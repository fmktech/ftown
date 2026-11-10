import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { accountIdOf, applyRevocations, ledgerChallenge, ledgerHead, ledgerLastIssuedAt, nextTransition, verifyLedger } from '@security/ledger/ledger';
import type { Ledger, LedgerAuthority, LedgerDevice, LedgerGenesis, LedgerOperation, LedgerTransition, Signed } from '@security/ledger/protocol';
import { createSoftPasskey } from '@security/ledger/testing';
import type { SoftPasskey } from '@security/ledger/testing';
import { CREATION_MAX_BYTES, CREATION_MAX_RECORDS } from './ledger-limits';
import type { OfferLimits } from './account-ledger-store';

/** One joined accounts + account_ledger row. The map key is accounts.account_id (PRIMARY KEY); accounts.handle is UNIQUE. */
interface Row { account_id: string; handle: string; revision: number; head: string; ledger: unknown; sticky: unknown; version: number; checkpoint: unknown }
interface StickyIds { deviceIds: string[]; bridgeIds: string[] }
const verifySpy = vi.hoisted(() => ({ calls: 0 }));
/** orphans: accounts rows with no account_ledger row (the JOINed reads do not see them). reads: which SELECT shape ran. */
const db = vi.hoisted(() => ({ rows: new Map<string, Row>(), orphans: new Set<string>(), writes: 0, inserts: 0, updates: 0, backfills: 0,
  reads: [] as string[], races: [] as Array<() => void | Promise<void>>, registration: true }));
vi.mock('@security/ledger/ledger', async importOriginal => {
  const actual = await importOriginal<typeof import('@security/ledger/ledger')>();
  return { ...actual, verifyLedger: (...args: Parameters<typeof actual.verifyLedger>) => { verifySpy.calls += 1; return actual.verifyLedger(...args); } };
});
vi.mock('@/lib/registration', () => ({ isRegistrationEnabled: () => db.registration }));
const violation = (constraint: string): Error => Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), { code: '23505', constraint });
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    // A tiny interpreter for exactly the statements the store issues, with Postgres' constraint and ON CONFLICT semantics.
    query: async (text: string, params: unknown[]) => {
      if (text.startsWith('SELECT COUNT')) return [{ count: db.rows.size }];
      if (text.startsWith('SELECT')) {
        db.reads.push(text.includes('JOIN accounts') ? 'chain' : 'checkpoint');
        const found = [...db.rows.values()].filter(row => (text.includes('a.handle=$1') ? row.handle : row.account_id) === params[0]);
        return found.map(row => ({ ...row }));
      }
      if (text.startsWith('WITH a AS (INSERT INTO accounts')) {
        const [accountId, handle, revision, head, ledger, sticky, checkpoint] = params as [string, string, number, string, string, string, string];
        await db.races.shift()?.();
        db.inserts += 1;
        // Only an explicit arbiter skips a conflict on its own index; a targetless DO NOTHING skips every unique conflict.
        const arbiter = /ON CONFLICT \(account_id\) DO NOTHING/.test(text) ? 'account_id' : /ON CONFLICT DO NOTHING/.test(text) ? 'any' : 'none';
        if (/NOT EXISTS\s*\(SELECT 1 FROM accounts\)/.test(text) && db.rows.size > 0) return [];
        const idTaken = db.rows.has(accountId) || db.orphans.has(accountId);
        const handleTaken = [...db.rows.values()].some(row => row.handle === handle);
        if ((idTaken && arbiter !== 'none') || (handleTaken && arbiter === 'any')) return [];
        if (idTaken) throw violation('accounts_pkey');
        if (handleTaken) throw violation('accounts_handle_key');
        db.writes += 1;
        db.rows.set(accountId, { account_id: accountId, handle, revision, head, ledger: JSON.parse(ledger), sticky: JSON.parse(sticky),
          version: 0, checkpoint: checkpoint === undefined ? null : JSON.parse(checkpoint) });
        return [{ account_id: accountId }];
      }
      if (text.startsWith('UPDATE account_ledger SET checkpoint=')) {
        const [accountId, checkpoint, expectedVersion] = params as [string, string, number];
        await db.races.shift()?.();
        db.backfills += 1;
        const row = db.rows.get(accountId);
        if (!row || row.version !== expectedVersion || row.checkpoint !== null) return [];
        db.rows.set(accountId, { ...row, checkpoint: JSON.parse(checkpoint) });
        return [];
      }
      if (text.startsWith('UPDATE account_ledger SET revision=')) {
        const [accountId, revision, head, ledger, sticky, expectedVersion, expectedRevision, expectedHead, checkpoint] = params as [string, number, string, string, string, number, number, string, string];
        await db.races.shift()?.();
        db.updates += 1;
        const row = db.rows.get(accountId);
        if (!row || (text.includes('AND version=$6') && row.version !== expectedVersion) || row.revision !== expectedRevision || row.head !== expectedHead) return [];
        db.writes += 1;
        db.rows.set(accountId, { ...row, revision, head, ledger: JSON.parse(ledger), sticky: JSON.parse(sticky), version: row.version + 1,
          checkpoint: text.includes('checkpoint=$9') ? JSON.parse(checkpoint) : row.checkpoint });
        return [{ account_id: accountId }];
      }
      throw new Error(`unexpected statement: ${text}`);
    },
  }),
}));

const { accountCount, offerLedger, readLedger, readTrustedCheckpoint } = await import('./account-ledger-store');
const OPEN: OfferLimits = { admitCreation: async () => true, admitAccountWrite: async () => true };
const offer = (candidate: unknown, limits: OfferLimits = OPEN) => offerLedger(candidate, limits);

const rpId = 'ftown.example';
const origin = 'https://ftown.example';
process.env.FTOWN_PUBLIC_URL = origin;
delete process.env.FTOWN_RP_ID;
const T0 = Date.now() - 3_600_000;
const NONE: StickyIds = { deviceIds: [], bridgeIds: [] };
const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64url');
const randomB64 = (length: number): string => b64(crypto.getRandomValues(new Uint8Array(length)));
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface Chain { ledger: Ledger; accountId: string; head: string; issuedAt: number }
const newPasskey = (): Promise<SoftPasskey> => createSoftPasskey({ rpId, origin });
async function signed<T extends LedgerGenesis | LedgerTransition>(passkey: SoftPasskey, payload: T): Promise<Signed<T>> {
  return { payload, signature: await passkey.sign(await ledgerChallenge(payload)) };
}
const authorityOf = (passkey: SoftPasskey): LedgerAuthority => ({ credentialId: passkey.credentialId, publicKey: passkey.publicKey, label: 'Passkey', addedAt: T0 });
async function newDevice(accountId: string, label: string): Promise<LedgerDevice> {
  const endpointPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', endpointPair.publicKey));
  const authPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const auth = new Uint8Array(await crypto.subtle.exportKey('raw', authPair.publicKey));
  const id = b64(new Uint8Array(createHash('sha256').update(raw).digest()));
  return { endpoint: { version: 1, id, ownerId: accountId, kind: 'browser', publicKey: b64(raw) }, authPublicKey: b64(auth), label, approvedAt: T0 };
}
async function genesis(passkey: SoftPasskey, over: Partial<LedgerGenesis> = {}): Promise<Chain> {
  const payload: LedgerGenesis = { type: 'ftown_account_genesis', version: 2, rpId, origins: [origin], handle: randomB64(32), createdAt: T0, authority: authorityOf(passkey), ...over };
  const record = await signed(passkey, payload);
  const accountId = await accountIdOf(payload);
  return { ledger: { genesis: record, transitions: [] }, accountId, head: accountId, issuedAt: T0 };
}
async function append(chain: Chain, passkey: SoftPasskey, operation: LedgerOperation): Promise<Chain> {
  const payload = nextTransition(await verifyLedger(chain.ledger), passkey.credentialId, operation, chain.issuedAt + 1000, ledgerLastIssuedAt(chain.ledger));
  const record = await signed(passkey, payload);
  return { ledger: { genesis: chain.ledger.genesis, transitions: [...chain.ledger.transitions, record] }, accountId: chain.accountId, head: await ledgerHead(payload), issuedAt: payload.issuedAt };
}
async function addDevice(chain: Chain, passkey: SoftPasskey, label: string): Promise<{ chain: Chain; device: LedgerDevice }> {
  const device = await newDevice(chain.accountId, label);
  return { chain: await append(chain, passkey, { type: 'add_device', device }), device };
}
/** A creatable chain: a new genesis plus one add_device. */
async function fresh(over: Partial<LedgerGenesis> = {}): Promise<{ passkey: SoftPasskey; chain: Chain }> {
  const passkey = await newPasskey();
  const { chain } = await addDevice(await genesis(passkey, over), passkey, 'D1');
  return { passkey, chain };
}
/** genesis + `count` add_device records. */
async function withDevices(count: number): Promise<{ passkey: SoftPasskey; chains: Chain[] }> {
  const passkey = await newPasskey();
  const chains = [await genesis(passkey)];
  for (let index = 0; index < count; index += 1) chains.push((await addDevice(chains[chains.length - 1], passkey, `D${index}`)).chain);
  return { passkey, chains };
}
/** The trusted checkpoint a write must persist for `chain` with `sticky`, recomputed from scratch. */
const recomputed = async (ledger: Ledger, sticky: StickyIds = NONE) => plain(applyRevocations(await verifyLedger(ledger), sticky));
/** The row a correct writer stores for `chain`. */
async function rowFor(chain: Chain, sticky: StickyIds = NONE): Promise<Row> {
  return { account_id: chain.accountId, handle: chain.ledger.genesis.payload.handle, revision: chain.ledger.transitions.length, head: chain.head,
    ledger: plain(chain.ledger), sticky: plain(sticky), version: 0, checkpoint: await recomputed(chain.ledger, sticky) };
}

/** A base chain (genesis + device D1), registered in the store, ready for forks. */
async function registered() {
  const passkey = await newPasskey();
  const g = await genesis(passkey);
  const { chain: base, device: d1 } = await addDevice(g, passkey, 'D1');
  expect((await offer(base.ledger)).decision).toBe('created');
  db.writes = 0; db.inserts = 0; db.updates = 0; db.reads = [];
  return { passkey, g, base, d1 };
}
const row = (accountId: string): Row => db.rows.get(accountId) as Row;
const refused = (reason: string) => ({ decision: 'reject', stored: null, discarded: 0, reason });
/** Spy limits that record how many signature verifications had happened when each was consulted. */
function budget(allowCreation: boolean, allowWrite = true) {
  const verifiedBefore: number[] = [];
  const admitCreation = vi.fn(async () => { verifiedBefore.push(verifySpy.calls); return allowCreation; });
  const admitAccountWrite = vi.fn(async (_accountId: string) => allowWrite);
  return { limits: { admitCreation, admitAccountWrite }, admitCreation, admitAccountWrite, verifiedBefore };
}
const tamper = (chain: Chain, index: number): Ledger => ({ genesis: chain.ledger.genesis, transitions: [...chain.ledger.transitions.slice(0, index),
  { ...chain.ledger.transitions[index], payload: { ...chain.ledger.transitions[index].payload, issuedAt: chain.issuedAt + 7 } }] });

beforeEach(() => {
  db.rows.clear(); db.orphans.clear(); db.writes = 0; db.inserts = 0; db.updates = 0; db.backfills = 0; db.reads = []; db.races = []; db.registration = true;
  verifySpy.calls = 0;
  delete process.env.FTOWN_MAX_ACCOUNTS;
});

describe('account creation', () => {
  it('creates an account, exposes it by accountId and handle, and persists its trusted checkpoint in the same statement', async () => {
    const { chain } = await fresh();
    const result = await offer(chain.ledger);
    expect(result).toMatchObject({ decision: 'created', discarded: 0 });
    expect(result.stored?.trusted.head).toBe(chain.head);
    expect(db.inserts).toBe(1);
    expect(db.updates + db.backfills).toBe(0);
    expect(row(chain.accountId).checkpoint).toEqual(await recomputed(chain.ledger));
    expect(await accountCount()).toBe(1);
    expect((await readLedger({ accountId: chain.accountId }))?.trusted.head).toBe(chain.head);
    expect((await readLedger({ handle: chain.ledger.genesis.payload.handle }))?.trusted.accountId).toBe(chain.accountId);
    expect(await readLedger({ accountId: 'A'.repeat(43) })).toBeNull();
  });

  it('admits a second, different genesis while one account exists, and keeps the accounts apart', async () => {
    const { base } = await registered();
    const { chain: other } = await fresh();
    const result = await offer(other.ledger);
    expect(result.decision).toBe('created');
    expect(result.stored?.trusted.accountId).toBe(other.accountId);
    expect(await accountCount()).toBe(2);
    expect((await readTrustedCheckpoint(base.accountId))?.head).toBe(base.head);
    expect((await readTrustedCheckpoint(other.accountId))?.head).toBe(other.head);
    expect((await readLedger({ handle: other.ledger.genesis.payload.handle }))?.trusted.accountId).toBe(other.accountId);
    expect((await readLedger({ handle: base.ledger.genesis.payload.handle }))?.trusted.accountId).toBe(base.accountId);
  });

  it('registration closed: registration_closed, nothing verified or written; existing accounts still take replica offers', async () => {
    const { passkey, base } = await registered();
    db.registration = false;
    const { chain } = await fresh();
    const { limits, admitCreation } = budget(true);
    verifySpy.calls = 0;
    expect(await offer(chain.ledger, limits)).toEqual(refused('registration_closed'));
    expect(verifySpy.calls).toBe(0);
    expect(admitCreation).not.toHaveBeenCalled();
    expect(db.rows.size).toBe(1);
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    expect((await offer(longer.ledger)).decision).toBe('adopt');
  });

  it('invalid_ledger: no add_device, a chain that does not verify, or a value that does not parse', async () => {
    const passkey = await newPasskey();
    const g = await genesis(passkey);
    expect(await offer(g.ledger)).toEqual(refused('invalid_ledger'));
    const { chain } = await addDevice(g, passkey, 'D1');
    expect(await offer(tamper(chain, 0))).toEqual(refused('invalid_ledger'));
    expect(await offer({ nonsense: true })).toEqual(refused('invalid_ledger'));
    expect(await offer(undefined)).toEqual(refused('invalid_ledger'));
    expect(db.rows.size).toBe(0);
  });

  it('creation_too_large by record count: 16 records (genesis included) are admitted, 17 are refused unverified', async () => {
    const { chains } = await withDevices(CREATION_MAX_RECORDS);
    const atLimit = chains[CREATION_MAX_RECORDS - 1];
    const overLimit = chains[CREATION_MAX_RECORDS];
    expect(1 + overLimit.ledger.transitions.length).toBe(CREATION_MAX_RECORDS + 1);
    const { limits, admitCreation } = budget(true);
    verifySpy.calls = 0;
    expect(await offer(overLimit.ledger, limits)).toEqual(refused('creation_too_large'));
    expect(verifySpy.calls).toBe(0);
    expect(admitCreation).not.toHaveBeenCalled();
    expect(db.rows.size).toBe(0);
    expect((await offer(atLimit.ledger)).decision).toBe('created');
  });

  it('creation_too_large by bytes, before any verification; under the limit the same junk fails verification and spends nothing', async () => {
    const { chain } = await fresh();
    const padded = (record: Signed<LedgerTransition>): Signed<LedgerTransition> => ({
      ...record, signature: { ...record.signature, authenticatorData: b64(new Uint8Array(4096)), clientDataJSON: b64(new Uint8Array(4096)) } });
    const big = { genesis: chain.ledger.genesis, transitions: Array.from({ length: 12 }, () => padded(chain.ledger.transitions[0])) };
    expect(1 + big.transitions.length).toBeLessThanOrEqual(CREATION_MAX_RECORDS);
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(CREATION_MAX_BYTES);
    const { limits, admitCreation } = budget(true);
    verifySpy.calls = 0;
    expect(await offer(big, limits)).toEqual(refused('creation_too_large'));
    expect(verifySpy.calls).toBe(0);
    const under = { genesis: chain.ledger.genesis, transitions: [padded(chain.ledger.transitions[0])] };
    expect(await offer(under, limits)).toEqual(refused('invalid_ledger'));
    expect(verifySpy.calls).toBe(1);
    expect(admitCreation).not.toHaveBeenCalled();
    expect(db.rows.size).toBe(0);
  });

  it('the creation size rule does not apply to an existing account: a longer replica is adopted', async () => {
    const { chains } = await withDevices(CREATION_MAX_RECORDS + 4);
    expect((await offer(chains[1].ledger)).decision).toBe('created');
    const large = chains[chains.length - 1];
    expect(1 + large.ledger.transitions.length).toBeGreaterThan(CREATION_MAX_RECORDS);
    const { limits, admitCreation, admitAccountWrite } = budget(false);
    const result = await offer(large.ledger, limits);
    expect(result.decision).toBe('adopt');
    expect(row(large.accountId).head).toBe(large.head);
    expect(admitCreation).not.toHaveBeenCalled();
    expect(admitAccountWrite).toHaveBeenCalledTimes(1);
  });

  it('server_full at the FTOWN_MAX_ACCOUNTS soft cap, after verification and the creation budget', async () => {
    await registered();
    process.env.FTOWN_MAX_ACCOUNTS = '1';
    const { chain } = await fresh();
    const { limits, admitCreation } = budget(true);
    verifySpy.calls = 0;
    expect(await offer(chain.ledger, limits)).toEqual(refused('server_full'));
    expect(verifySpy.calls).toBe(1);
    expect(admitCreation).toHaveBeenCalledTimes(1);
    expect(db.rows.size).toBe(1);
    expect(db.inserts).toBe(0);
    process.env.FTOWN_MAX_ACCOUNTS = '2';
    expect((await offer(chain.ledger)).decision).toBe('created');
    expect(await offer((await fresh()).chain.ledger)).toEqual(refused('server_full'));
  });

  it('handle_taken when another account holds the genesis handle, never a conflict', async () => {
    const { base } = await registered();
    const { chain: squatter } = await fresh({ handle: base.ledger.genesis.payload.handle });
    expect(squatter.accountId).not.toBe(base.accountId);
    expect(await offer(squatter.ledger)).toEqual(refused('handle_taken'));
    expect(db.rows.size).toBe(1);
    expect(row(base.accountId).head).toBe(base.head);
    expect(await readLedger({ accountId: squatter.accountId })).toBeNull();
  });

  it('concurrent identical creations both succeed against one stored account', async () => {
    const { chain } = await fresh();
    const results = await Promise.all([offer(chain.ledger), offer(chain.ledger)]);
    expect(results.map(item => item.decision).sort()).toEqual(['created', 'keep']);
    for (const result of results) expect(result.stored?.trusted.head).toBe(chain.head);
    expect(db.rows.size).toBe(1);
    expect(db.writes).toBe(1);
  });

  it('an identical creation that lands first makes the insert a no-op, answered as a replica offer', async () => {
    const { chain } = await fresh();
    const landed = await rowFor(chain);
    db.races = [() => { db.rows.set(chain.accountId, landed); }];
    const result = await offer(chain.ledger);
    expect(result.decision).toBe('keep');
    expect(result.stored?.trusted.head).toBe(chain.head);
    expect(db.inserts).toBe(1);
    expect(db.writes).toBe(0);
  });

  it('a handle violation caused by an identical concurrent creation is not handle_taken', async () => {
    const { chain } = await fresh();
    const landed = await rowFor(chain);
    // Postgres can raise on the non-arbiter handle index when the identical row commits between the arbiter check and our insert.
    db.races = [() => { db.rows.set(chain.accountId, landed); throw violation('accounts_handle_key'); }];
    const result = await offer(chain.ledger);
    expect(result.decision).toBe('keep');
    expect(result.stored?.trusted.head).toBe(chain.head);
  });

  it('other database errors from the insert propagate', async () => {
    const { chain } = await fresh();
    db.races = [() => { throw Object.assign(new Error('connection reset'), { code: '08006' }); }];
    await expect(offer(chain.ledger)).rejects.toThrow('connection reset');
  });
});

describe('creation budget (admitCreation)', () => {
  it('is consulted once, only after the chain fully verified', async () => {
    const { chain } = await fresh();
    const { limits, admitCreation, verifiedBefore } = budget(true);
    verifySpy.calls = 0;
    expect((await offer(chain.ledger, limits)).decision).toBe('created');
    expect(admitCreation).toHaveBeenCalledTimes(1);
    expect(verifiedBefore).toEqual([1]);
  });

  it('refusal is rate_limited: no count, no insert', async () => {
    const { chain } = await fresh();
    const { limits } = budget(false);
    expect(await offer(chain.ledger, limits)).toEqual(refused('rate_limited'));
    expect(db.inserts).toBe(0);
    expect(db.rows.size).toBe(0);
  });

  it('unsigned or badly signed junk never spends it, even with a constant client key', async () => {
    const { chain } = await fresh();
    const { limits, admitCreation } = budget(true);
    for (let index = 0; index < 10; index += 1) expect(await offer(tamper(chain, 0), limits)).toEqual(refused('invalid_ledger'));
    const foreignKey = await newPasskey();
    const forged = { genesis: chain.ledger.genesis, transitions: [{ ...chain.ledger.transitions[0], signature: (await signed(foreignKey, chain.ledger.transitions[0].payload)).signature }] };
    expect(await offer(forged, limits)).toEqual(refused('invalid_ledger'));
    expect(admitCreation).not.toHaveBeenCalled();
    expect((await offer(chain.ledger, limits)).decision).toBe('created');
    expect(admitCreation).toHaveBeenCalledTimes(1);
  });

  it('is not consumed by requests that an earlier check refuses', async () => {
    const { limits, admitCreation } = budget(true);
    expect(await offer({ nonsense: true }, limits)).toEqual(refused('invalid_ledger'));
    const passkey = await newPasskey();
    expect(await offer((await genesis(passkey)).ledger, limits)).toEqual(refused('invalid_ledger'));
    const wrong = await createSoftPasskey({ rpId: 'evil.example', origin: 'https://evil.example' });
    const { chain: foreign } = await addDevice(await genesis(wrong, { rpId: 'evil.example', origins: ['https://evil.example'] }), wrong, 'D1');
    expect(await offer(foreign.ledger, limits)).toEqual(refused('origin_mismatch'));
    db.registration = false;
    expect(await offer((await fresh()).chain.ledger, limits)).toEqual(refused('registration_closed'));
    expect(admitCreation).not.toHaveBeenCalled();
  });

  it('is never consulted for an existing account: adopt, keep and reject', async () => {
    const { passkey, base } = await registered();
    const { limits, admitCreation } = budget(false);
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    expect((await offer(longer.ledger, limits)).decision).toBe('adopt');
    expect((await offer(base.ledger, limits)).decision).toBe('keep');
    expect((await offer(tamper(longer, 1), limits)).decision).toBe('reject');
    expect(admitCreation).not.toHaveBeenCalled();
  });

  it('is consumed at most once when the creation path runs twice, and a twice-lost insert is a conflict', async () => {
    const { chain } = await fresh();
    const { limits, admitCreation } = budget(true);
    db.orphans.add(chain.accountId);
    await expect(offer(chain.ledger, limits)).rejects.toThrow('account_ledger_conflict');
    expect(db.inserts).toBe(2);
    expect(admitCreation).toHaveBeenCalledTimes(1);
  });

  it('is consumed at most once when a lost insert is re-run as a replica offer', async () => {
    const { chain } = await fresh();
    const { limits, admitCreation, admitAccountWrite } = budget(true);
    const landed = await rowFor(chain);
    db.races = [() => { db.rows.set(chain.accountId, landed); }];
    expect((await offer(chain.ledger, limits)).decision).toBe('keep');
    expect(admitCreation).toHaveBeenCalledTimes(1);
    expect(admitAccountWrite).not.toHaveBeenCalled();
  });
});

describe('limits are required', () => {
  it('an offer without both hooks throws before touching anything', async () => {
    const { chain } = await fresh();
    for (const limits of [undefined, {}, { admitCreation: OPEN.admitCreation }, { admitAccountWrite: OPEN.admitAccountWrite }]) {
      await expect(offerLedger(chain.ledger, limits as unknown as OfferLimits), JSON.stringify(limits)).rejects.toThrow(TypeError);
    }
    expect(db.reads).toEqual([]);
    expect(db.rows.size).toBe(0);
    // @ts-expect-error: the type requires the limits too.
    await expect(offerLedger(chain.ledger)).rejects.toThrow(TypeError);
  });
});

describe('account write budget (admitAccountWrite)', () => {
  it('an adopt spends it once, with the accountId, after the candidate verified', async () => {
    const { passkey, base } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    const { limits, admitAccountWrite } = budget(false, true);
    expect((await offer(longer.ledger, limits)).decision).toBe('adopt');
    expect(admitAccountWrite).toHaveBeenCalledTimes(1);
    expect(admitAccountWrite).toHaveBeenCalledWith(base.accountId);
  });

  it('refused: reject with reason rate_limited and the stored chain, nothing written', async () => {
    const { passkey, base } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    const { limits } = budget(true, false);
    const result = await offer(longer.ledger, limits);
    expect(result).toMatchObject({ decision: 'reject', reason: 'rate_limited' });
    expect(result.stored?.trusted.head).toBe(base.head);
    expect(db.updates).toBe(0);
    expect(row(base.accountId).head).toBe(base.head);
  });

  it('a kept chain that only adds sticky revocations is a write and spends it', async () => {
    const { passkey, base, d1 } = await registered();
    const { chain: s1 } = await addDevice(base, passkey, 'S1');
    const { chain: stored } = await addDevice(s1, passkey, 'S2');
    await offer(stored.ledger);
    const losing = await append(base, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    const { limits, admitAccountWrite } = budget(true);
    expect((await offer(losing.ledger, limits)).decision).toBe('keep');
    expect(admitAccountWrite).toHaveBeenCalledTimes(1);
    expect((row(base.accountId).sticky as StickyIds).deviceIds).toEqual([d1.endpoint.id]);
  });

  it('junk and losing candidates for an account never spend its budget', async () => {
    const { passkey, base } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    const { chain: longest } = await addDevice(longer, passkey, 'D3');
    await offer(longest.ledger);
    db.updates = 0;
    const { chain: losingFork } = await addDevice(base, passkey, 'F1');
    const stranger = await newPasskey();
    const strangerSigned = { genesis: longest.ledger.genesis, transitions: [...longest.ledger.transitions,
      await signed(stranger, nextTransition(await verifyLedger(longest.ledger), passkey.credentialId, { type: 'add_device', device: await newDevice(base.accountId, 'X') }, longest.issuedAt + 1000, ledgerLastIssuedAt(longest.ledger)))] };
    const { limits, admitAccountWrite } = budget(true);
    const candidates: Array<[string, unknown, string]> = [
      ['tampered extension', tamper(longest, 2), 'reject'],
      ['extension signed by a stranger', strangerSigned, 'reject'],
      ['tampered fork', tamper(losingFork, 1), 'reject'],
      ['shorter prefix', longer.ledger, 'keep'],
      ['identical chain', longest.ledger, 'keep'],
      ['losing valid fork without revocations', losingFork.ledger, 'keep'],
    ];
    for (const [name, candidate, decision] of candidates) expect((await offer(candidate, limits)).decision, name).toBe(decision);
    expect(admitAccountWrite).not.toHaveBeenCalled();
    expect(db.updates).toBe(0);
    expect(row(base.accountId).head).toBe(longest.head);
  });

  it('an over-limit sticky set is rejected before the budget is consulted', async () => {
    const { passkey, base, d1 } = await registered();
    const { chain: f1 } = await addDevice(base, passkey, 'F1');
    const { chain: f2 } = await addDevice(f1, passkey, 'F2');
    await offer(f2.ledger);
    db.rows.set(base.accountId, { ...row(base.accountId), sticky: { deviceIds: Array.from({ length: 8192 }, () => randomB64(32)), bridgeIds: [] } });
    const losing = await append(base, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    const { limits, admitAccountWrite } = budget(true);
    expect((await offer(losing.ledger, limits)).decision).toBe('reject');
    expect(admitAccountWrite).not.toHaveBeenCalled();
  });

  it('is consumed at most once when a lost write race is re-run', async () => {
    const { passkey, base } = await registered();
    const { chain: one } = await addDevice(base, passkey, 'D2');
    const { chain: two } = await addDevice(one, passkey, 'D3');
    const landed = await rowFor(one);
    db.races = [() => { db.rows.set(base.accountId, { ...landed, version: row(base.accountId).version }); }];
    const { limits, admitAccountWrite } = budget(true);
    expect((await offer(two.ledger, limits)).decision).toBe('adopt');
    expect(db.updates).toBe(2);
    expect(admitAccountWrite).toHaveBeenCalledTimes(1);
  });
});

describe('persisted trusted checkpoint', () => {
  it('auth reads use one small SELECT: no chain read, no verification', async () => {
    const { base } = await registered();
    verifySpy.calls = 0;
    const trusted = await readTrustedCheckpoint(base.accountId);
    expect(trusted).toEqual(await recomputed(base.ledger));
    expect(db.reads).toEqual(['checkpoint']);
    verifySpy.calls = 0;
    await readTrustedCheckpoint(base.accountId);
    expect(await readTrustedCheckpoint('A'.repeat(43))).toBeNull();
    expect(verifySpy.calls).toBe(0);
  });

  it('readLedger serves the stored chain as-is, without verifying it', async () => {
    const { base } = await registered();
    verifySpy.calls = 0;
    const read = await readLedger({ accountId: base.accountId });
    expect(read?.ledger).toEqual(base.ledger);
    expect(read?.trusted).toEqual(await recomputed(base.ledger));
    verifySpy.calls = 0;
    await readLedger({ handle: base.ledger.genesis.payload.handle });
    expect(verifySpy.calls).toBe(0);
  });

  it('a signature altered in the database is not caught on read (rows are only written after verification; clients verify)', async () => {
    const { base } = await registered();
    const transition = base.ledger.transitions[0];
    const altered = { genesis: base.ledger.genesis, transitions: [{ ...transition, signature: { ...transition.signature, signature: transition.signature.signature.slice(0, -4) + 'AAAA' } }] };
    db.rows.set(base.accountId, { ...row(base.accountId), ledger: altered });
    expect((await readLedger({ accountId: base.accountId }))?.ledger).toEqual(altered);
    expect((await readTrustedCheckpoint(base.accountId))?.head).toBe(base.head);
  });

  it('adopt and a sticky-only keep persist the recomputed trusted checkpoint with the chain', async () => {
    const { passkey, base, d1 } = await registered();
    const { chain: s1 } = await addDevice(base, passkey, 'S1');
    const { chain: s2 } = await addDevice(s1, passkey, 'S2');
    expect((await offer(s2.ledger)).decision).toBe('adopt');
    expect(row(base.accountId).checkpoint).toEqual(await recomputed(s2.ledger));
    const losing = await append(base, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    expect((await offer(losing.ledger)).decision).toBe('keep');
    const sticky = { deviceIds: [d1.endpoint.id], bridgeIds: [] };
    expect(row(base.accountId).checkpoint).toEqual(await recomputed(s2.ledger, sticky));
    const trusted = await readTrustedCheckpoint(base.accountId);
    expect(trusted?.devices.map(item => item.endpoint.id)).not.toContain(d1.endpoint.id);
    expect(trusted?.revokedDeviceIds).toContain(d1.endpoint.id);
  });

  it('the row sticky set is applied again on read: a checkpoint that lags behind it never trusts a revoked key', async () => {
    const { base, d1 } = await registered();
    db.rows.set(base.accountId, { ...row(base.accountId), sticky: { deviceIds: [d1.endpoint.id], bridgeIds: [] } });
    for (const trusted of [await readTrustedCheckpoint(base.accountId), (await readLedger({ accountId: base.accountId }))?.trusted]) {
      expect(trusted?.devices.map(item => item.endpoint.id)).not.toContain(d1.endpoint.id);
      expect(trusted?.revokedDeviceIds).toContain(d1.endpoint.id);
    }
  });

  it('NULL (a row from before the column): verified once, backfilled with the exact value, then read without verifying', async () => {
    const { passkey, base, d1 } = await registered();
    const sticky = { deviceIds: [d1.endpoint.id], bridgeIds: [] };
    for (const read of [() => readTrustedCheckpoint(base.accountId), async () => (await readLedger({ accountId: base.accountId }))?.trusted]) {
      // A chain this process never verified, so the memo cannot answer for it.
      const { chain: longer } = await addDevice(base, passkey, 'D2');
      db.rows.set(base.accountId, { ...(await rowFor(longer, sticky)), version: 4, checkpoint: null });
      verifySpy.calls = 0;
      const trusted = await read();
      expect(verifySpy.calls).toBe(1);
      expect(trusted).toEqual(await recomputed(longer.ledger, sticky));
      expect(row(base.accountId).checkpoint).toEqual(await recomputed(longer.ledger, sticky));
      expect(row(base.accountId).version).toBe(4);
      verifySpy.calls = 0;
      expect(await read()).toEqual(trusted);
      expect(verifySpy.calls).toBe(0);
    }
  });

  it('a trusted checkpoint listing more revoked ids than a chain checkpoint may (chain + sticky) is still read', async () => {
    const { base } = await registered();
    const sticky = { deviceIds: Array.from({ length: 2000 }, () => randomB64(32)), bridgeIds: [] };
    db.rows.set(base.accountId, { ...(await rowFor(base, sticky)), version: 1 });
    expect((await readTrustedCheckpoint(base.accountId))?.revokedDeviceIds).toHaveLength(2000);
    expect((await readLedger({ accountId: base.accountId }))?.trusted.revokedDeviceIds).toHaveLength(2000);
  });

  it('the backfill is guarded by version: a concurrent writer is never overwritten', async () => {
    const { passkey, base } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    const writer = { ...(await rowFor(longer)), version: 1 };
    db.rows.set(base.accountId, { ...row(base.accountId), checkpoint: null });
    // The concurrent adopt lands between our read and our backfill.
    db.races = [() => { db.rows.set(base.accountId, writer); }];
    expect((await readTrustedCheckpoint(base.accountId))?.head).toBe(base.head);
    expect(db.backfills).toBe(1);
    expect(row(base.accountId)).toEqual(writer);
  });

  it('fork choice against a row without sticky ids does not verify the stored chain', async () => {
    const { passkey, base } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    verifySpy.calls = 0;
    expect((await offer(base.ledger)).decision).toBe('keep');
    expect((await offer(longer.ledger)).decision).toBe('adopt');
    expect(verifySpy.calls).toBe(0);
  });

  it('the memo for chains that must still be verified is an LRU, refreshed on hit', async () => {
    const chains: Chain[] = [];
    for (let index = 0; index < 33; index += 1) {
      const { chain } = await fresh();
      expect((await offer(chain.ledger)).decision).toBe('created');
      // A sticky id: the trusted checkpoint no longer describes the chain, so fork choice verifies the stored chain (memoised).
      db.rows.set(chain.accountId, { ...row(chain.accountId), sticky: { deviceIds: [randomB64(32)], bridgeIds: [] } });
      chains.push(chain);
    }
    const keep = async (chain: Chain): Promise<number> => {
      verifySpy.calls = 0;
      expect((await offer(chain.ledger)).decision).toBe('keep');
      return verifySpy.calls;
    };
    for (const chain of chains.slice(0, 32)) expect(await keep(chain)).toBe(1);
    expect(await keep(chains[0])).toBe(0);
    expect(await keep(chains[32])).toBe(1);
    // LRU evicted chains[1]; FIFO would have evicted the older but just-used chains[0].
    expect(await keep(chains[0])).toBe(0);
    expect(await keep(chains[1])).toBe(1);
  });
});

describe('replica rule', () => {
  it('adopts an extension and persists it', async () => {
    const { passkey, base } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    const result = await offer(longer.ledger);
    expect(result.decision).toBe('adopt');
    expect(result.stored?.trusted.head).toBe(longer.head);
    expect(row(base.accountId).head).toBe(longer.head);
    expect(row(base.accountId).revision).toBe(2);
    expect(db.writes).toBe(1);
  });

  it('keeps the stored chain when offered a shorter one (no rollback) and writes nothing', async () => {
    const { passkey, g, base } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    await offer(longer.ledger);
    db.writes = 0;
    for (const shorter of [base, g]) {
      const result = await offer(shorter.ledger);
      expect(result.decision).toBe('keep');
      expect(result.stored?.trusted.head).toBe(longer.head);
    }
    expect(row(base.accountId).head).toBe(longer.head);
    expect(db.writes).toBe(0);
  });

  it('a fork follows the order: the longer branch wins and reports discarded records', async () => {
    const { passkey, base } = await registered();
    const { chain: short } = await addDevice(base, passkey, 'S1');
    const { chain: longA } = await addDevice(base, passkey, 'L1');
    const { chain: long } = await addDevice(longA, passkey, 'L2');
    await offer(short.ledger);
    const won = await offer(long.ledger);
    expect(won).toMatchObject({ decision: 'adopt', discarded: 1 });
    expect(row(base.accountId).head).toBe(long.head);
    expect((await offer(short.ledger)).decision).toBe('keep');
    expect(row(base.accountId).head).toBe(long.head);
  });

  it('equal-length forks: the lexicographically smaller head wins, whichever arrives first', async () => {
    const { passkey, base } = await registered();
    const { chain: a } = await addDevice(base, passkey, 'A');
    const { chain: b } = await addDevice(base, passkey, 'B');
    const [small, large] = a.head < b.head ? [a, b] : [b, a];
    await offer(large.ledger);
    expect((await offer(small.ledger)).decision).toBe('adopt');
    expect(row(base.accountId).head).toBe(small.head);
    expect((await offer(large.ledger)).decision).toBe('keep');
    expect(row(base.accountId).head).toBe(small.head);
  });

  it('an invalid fork is rejected with the stored chain and does not write', async () => {
    const { passkey, base } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    await offer(longer.ledger);
    db.writes = 0;
    const result = await offer(tamper(longer, 1));
    expect(result.decision).toBe('reject');
    expect(result.stored?.trusted.head).toBe(longer.head);
    expect('reason' in result).toBe(false);
    expect(db.writes).toBe(0);
    expect(row(base.accountId).head).toBe(longer.head);
  });
});

describe('sticky revocations', () => {
  it('accumulate from a LOSING candidate, and trusted excludes them while the stored chain keeps them', async () => {
    const { passkey, base, d1 } = await registered();
    const { chain: s1 } = await addDevice(base, passkey, 'S1');
    const { chain: stored } = await addDevice(s1, passkey, 'S2');
    await offer(stored.ledger);
    const losing = await append(base, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    const result = await offer(losing.ledger);
    expect(result.decision).toBe('keep');
    expect(result.stored?.sticky.deviceIds).toEqual([d1.endpoint.id]);
    expect(row(base.accountId).sticky).toEqual({ deviceIds: [d1.endpoint.id], bridgeIds: [] });
    expect(row(base.accountId).head).toBe(stored.head);
    const read = await readLedger({ accountId: base.accountId });
    expect((await verifyLedger(read!.ledger)).devices.map(item => item.endpoint.id)).toContain(d1.endpoint.id);
    expect(read?.trusted.devices.map(item => item.endpoint.id)).not.toContain(d1.endpoint.id);
    expect(read?.trusted.revokedDeviceIds).toContain(d1.endpoint.id);
  });

  it('accumulate from the winner and survive a longer fork that lacks the revocation', async () => {
    const { passkey, base, d1 } = await registered();
    const revoked = await append(base, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    const adopted = await offer(revoked.ledger);
    expect(adopted.decision).toBe('adopt');
    expect(adopted.stored?.sticky.deviceIds).toEqual([d1.endpoint.id]);
    const { chain: f1 } = await addDevice(base, passkey, 'F1');
    const { chain: f2 } = await addDevice(f1, passkey, 'F2');
    const fork = await offer(f2.ledger);
    expect(fork.decision).toBe('adopt');
    expect((await verifyLedger(fork.stored!.ledger)).devices.map(item => item.endpoint.id)).toContain(d1.endpoint.id);
    expect(fork.stored?.trusted.devices.map(item => item.endpoint.id)).not.toContain(d1.endpoint.id);
    expect(fork.stored?.sticky.deviceIds).toEqual([d1.endpoint.id]);
    expect((await readTrustedCheckpoint(base.accountId))?.devices.map(item => item.endpoint.id)).not.toContain(d1.endpoint.id);
  });

  it('bridge revocations from a losing chain are sticky too', async () => {
    const { passkey, base } = await registered();
    const bridgeEndpoint = (await newDevice(base.accountId, 'b')).endpoint;
    const device = await newDevice(base.accountId, 'b');
    const bridge = { bridgeId: 'bridge-1', endpoint: { ...bridgeEndpoint, kind: 'bridge' as const }, authPublicKey: device.authPublicKey, label: 'Bridge', approvedAt: T0 };
    const withBridge = await append(base, passkey, { type: 'add_bridge', bridge });
    const { chain: ahead1 } = await addDevice(withBridge, passkey, 'X');
    const { chain: ahead } = await addDevice(ahead1, passkey, 'Y');
    await offer(ahead.ledger);
    const losing = await append(withBridge, passkey, { type: 'revoke_bridge', bridgeId: 'bridge-1' });
    expect((await offer(losing.ledger)).decision).toBe('keep');
    const read = await readLedger({ accountId: base.accountId });
    expect(read?.sticky.bridgeIds).toEqual(['bridge-1']);
    expect(read?.trusted.bridges).toHaveLength(0);
    expect((await readTrustedCheckpoint(base.accountId))?.bridges).toHaveLength(0);
    expect((await verifyLedger(read!.ledger)).bridges).toHaveLength(1);
  });
});

describe('reads', () => {
  it('throw on corruption instead of reporting an absent or valid account', async () => {
    const { passkey, base } = await registered();
    const good = { ...row(base.accountId) };
    const { chain: other } = await fresh();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    // [name, patch, corrupt for the full read, corrupt for the checkpoint read]
    const cases: Array<[string, Partial<Row>, boolean, boolean]> = [
      ['revision', { revision: 5 }, true, true],
      ['head', { head: 'A'.repeat(43) }, true, true],
      ['handle', { handle: randomB64(32) }, true, false],
      ['shape', { ledger: { nope: true } }, true, false],
      ['chain of another account', { ledger: plain(other.ledger) }, true, false],
      ['sticky', { sticky: { deviceIds: [1], bridgeIds: [] } }, true, true],
      ['version', { version: 'x' as unknown as number }, true, true],
      ['checkpoint shape', { checkpoint: { nope: true } }, true, true],
      ['checkpoint of another account', { checkpoint: await recomputed(other.ledger) }, true, true],
      ['checkpoint of another head', { checkpoint: await recomputed(longer.ledger) }, true, true],
    ];
    for (const [name, patch, chainCorrupt, checkpointCorrupt] of cases) {
      db.rows.set(base.accountId, { ...good, ...patch });
      if (chainCorrupt) {
        await expect(readLedger({ accountId: base.accountId }), name).rejects.toThrow('account_ledger_corrupt');
        await expect(offer(base.ledger), name).rejects.toThrow('account_ledger_corrupt');
      }
      if (checkpointCorrupt) await expect(readTrustedCheckpoint(base.accountId), name).rejects.toThrow('account_ledger_corrupt');
      else expect((await readTrustedCheckpoint(base.accountId))?.head, name).toBe(base.head);
    }
    db.rows.set(base.accountId, good);
    expect((await readLedger({ accountId: base.accountId }))?.trusted.head).toBe(base.head);
  });
});

describe('concurrency', () => {
  it('a lost race is re-read and re-run once', async () => {
    const { passkey, base } = await registered();
    const { chain: one } = await addDevice(base, passkey, 'D2');
    const { chain: two } = await addDevice(one, passkey, 'D3');
    // A concurrent writer lands `one` after our read of `base` but before our write.
    const landed = await rowFor(one);
    db.races = [() => { db.rows.set(base.accountId, { ...landed, version: row(base.accountId).version }); }];
    const result = await offer(two.ledger);
    expect(result.decision).toBe('adopt');
    expect(result.stored?.trusted.head).toBe(two.head);
    expect(row(base.accountId).head).toBe(two.head);
    expect(db.writes).toBe(1);
  });

  it('a second lost race throws and never overwrites the concurrent winner', async () => {
    const { passkey, base } = await registered();
    const { chain: one } = await addDevice(base, passkey, 'D2');
    const { chain: two } = await addDevice(one, passkey, 'D3');
    const { chain: three } = await addDevice(two, passkey, 'D4');
    const rows = [await rowFor(one), await rowFor(two)];
    db.races = rows.map(next => (): void => { db.rows.set(base.accountId, { ...next, version: row(base.accountId).version }); });
    await expect(offer(three.ledger)).rejects.toThrow('account_ledger_conflict');
    expect(db.writes).toBe(0);
    expect(row(base.accountId).head).toBe(two.head);
  });
});

describe('write safety', () => {
  it('two concurrent keeps adding different sticky ids both survive via the retry', async () => {
    const { passkey, base, d1 } = await registered();
    const { chain: m, device: d2 } = await addDevice(base, passkey, 'D2');
    const { chain: s1 } = await addDevice(m, passkey, 'S1');
    const { chain: stored } = await addDevice(s1, passkey, 'S2');
    await offer(stored.ledger);
    const a = await append(m, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    const b = await append(m, passkey, { type: 'revoke_device', endpointId: d2.endpoint.id });
    db.races = [async () => { expect((await offer(b.ledger)).decision).toBe('keep'); }];
    expect((await offer(a.ledger)).decision).toBe('keep');
    expect([...(row(base.accountId).sticky as StickyIds).deviceIds].sort()).toEqual([d1.endpoint.id, d2.endpoint.id].sort());
    expect(row(base.accountId).head).toBe(stored.head);
    expect(row(base.accountId).version).toBe(3);
    expect(row(base.accountId).checkpoint).toEqual(await recomputed(stored.ledger, row(base.accountId).sticky as StickyIds));
  });

  it('an over-limit sticky set is rejected before any write', async () => {
    const { passkey, base, d1 } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    await offer(longer.ledger);
    db.writes = 0;
    const flood = Array.from({ length: 8192 }, () => randomB64(32));
    db.rows.set(base.accountId, { ...row(base.accountId), sticky: { deviceIds: flood, bridgeIds: [] } });
    const losing = await append(base, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    expect((await offer(losing.ledger)).decision).toBe('reject');
    expect(db.writes).toBe(0);
  });
});

describe('creation binds origin and rpId', () => {
  it('origin_mismatch for a wrong origin, an extra origin and a wrong rpId; accepts the right values', async () => {
    for (const over of [{ origins: ['https://evil.example'] }, { origins: [origin, 'http://localhost:3000'] }, { rpId: 'evil.example' }]) {
      // The authenticator really signs for the claimed origin/rpId, so only the server-binding check can reject these chains.
      const passkey = await createSoftPasskey({ rpId: over.rpId ?? rpId, origin: over.origins?.[0] ?? origin });
      const { chain } = await addDevice(await genesis(passkey, over), passkey, 'D1');
      expect(await offer(chain.ledger), JSON.stringify(over)).toEqual(refused('origin_mismatch'));
    }
    expect(db.rows.size).toBe(0);
    const { chain } = await fresh();
    expect((await offer(chain.ledger)).decision).toBe('created');
  });

  it('server_misconfigured (and one log line) when the public origin cannot be computed; nothing verified or spent', async () => {
    const { chain } = await fresh();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { limits, admitCreation } = budget(true);
    process.env.FTOWN_PUBLIC_URL = 'https://ftown.example/path';
    try {
      verifySpy.calls = 0;
      expect(await offer(chain.ledger, limits)).toEqual(refused('server_misconfigured'));
      expect(verifySpy.calls).toBe(0);
      expect(admitCreation).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0][0])).toMatch(/^\[ledger\] account creation refused, server misconfigured: FTOWN_PUBLIC_URL/);
    } finally {
      process.env.FTOWN_PUBLIC_URL = origin;
      errors.mockRestore();
    }
    expect(db.rows.size).toBe(0);
  });

  it('honours FTOWN_RP_ID and is not applied to later offers on an existing account', async () => {
    process.env.FTOWN_RP_ID = 'ftown.example';
    const { passkey, base } = await registered();
    delete process.env.FTOWN_RP_ID;
    process.env.FTOWN_PUBLIC_URL = 'https://other.example';
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    expect((await offer(longer.ledger)).decision).toBe('adopt');
    process.env.FTOWN_PUBLIC_URL = origin;
  });
});
