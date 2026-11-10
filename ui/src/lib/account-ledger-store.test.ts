import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { accountIdOf, ledgerChallenge, ledgerHead, ledgerLastIssuedAt, nextTransition, verifyLedger } from '@security/ledger/ledger';
import type { Ledger, LedgerAuthority, LedgerDevice, LedgerGenesis, LedgerOperation, LedgerTransition, Signed } from '@security/ledger/protocol';
import { createSoftPasskey } from '@security/ledger/testing';
import type { SoftPasskey } from '@security/ledger/testing';
import { CREATION_MAX_BYTES, CREATION_MAX_RECORDS } from './ledger-limits';

/** One joined accounts + account_ledger row. The map key is accounts.account_id (PRIMARY KEY); accounts.handle is UNIQUE. */
interface Row { account_id: string; handle: string; revision: number; head: string; ledger: unknown; sticky: unknown; version: number }
const verifySpy = vi.hoisted(() => ({ calls: 0 }));
/** orphans: accounts rows with no account_ledger row (the JOINed reads do not see them). */
const db = vi.hoisted(() => ({ rows: new Map<string, Row>(), orphans: new Set<string>(), writes: 0, inserts: 0, races: [] as Array<() => void | Promise<void>>, registration: true }));
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
        const found = [...db.rows.values()].filter(row => (text.includes('a.handle=$1') ? row.handle : row.account_id) === params[0]);
        return found.map(row => ({ ...row }));
      }
      if (text.startsWith('WITH a AS (INSERT INTO accounts')) {
        const [accountId, handle, revision, head, ledger, sticky] = params as [string, string, number, string, string, string];
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
        db.rows.set(accountId, { account_id: accountId, handle, revision, head, ledger: JSON.parse(ledger), sticky: JSON.parse(sticky), version: 0 });
        return [{ account_id: accountId }];
      }
      if (text.startsWith('UPDATE')) {
        const [accountId, revision, head, ledger, sticky, expectedVersion, expectedRevision, expectedHead] = params as [string, number, string, string, string, number, number, string];
        await db.races.shift()?.();
        const row = db.rows.get(accountId);
        if (!row || (text.includes('AND version=$6') && row.version !== expectedVersion) || row.revision !== expectedRevision || row.head !== expectedHead) return [];
        db.writes += 1;
        db.rows.set(accountId, { ...row, revision, head, ledger: JSON.parse(ledger), sticky: JSON.parse(sticky), version: row.version + 1 });
        return [{ account_id: accountId }];
      }
      throw new Error(`unexpected statement: ${text}`);
    },
  }),
}));

const { accountCount, offerLedger, readLedger } = await import('./account-ledger-store');
const offer = offerLedger;

const rpId = 'ftown.example';
const origin = 'https://ftown.example';
process.env.FTOWN_PUBLIC_URL = origin;
delete process.env.FTOWN_RP_ID;
const T0 = Date.now() - 3_600_000;
const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64url');
const randomB64 = (length: number): string => b64(crypto.getRandomValues(new Uint8Array(length)));

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

/** A base chain (genesis + device D1), registered in the store, ready for forks. */
async function registered() {
  const passkey = await newPasskey();
  const g = await genesis(passkey);
  const { chain: base, device: d1 } = await addDevice(g, passkey, 'D1');
  expect((await offer(base.ledger)).decision).toBe('created');
  db.writes = 0;
  db.inserts = 0;
  return { passkey, g, base, d1 };
}
const row = (accountId: string): Row => db.rows.get(accountId) as Row;
const storedRow = (chain: Chain): Row => ({ account_id: chain.accountId, handle: chain.ledger.genesis.payload.handle, revision: chain.ledger.transitions.length,
  head: chain.head, ledger: JSON.parse(JSON.stringify(chain.ledger)), sticky: { deviceIds: [], bridgeIds: [] }, version: 0 });
const refused = (reason: string) => ({ decision: 'reject', stored: null, discarded: 0, reason });
/** A creation budget that records how many signature verifications had happened when it was consulted. */
function budget(allow: boolean) {
  const verifiedBefore: number[] = [];
  const admitCreation = vi.fn(async () => { verifiedBefore.push(verifySpy.calls); return allow; });
  return { admitCreation, verifiedBefore };
}

beforeEach(() => {
  db.rows.clear(); db.orphans.clear(); db.writes = 0; db.inserts = 0; db.races = []; db.registration = true; verifySpy.calls = 0;
  delete process.env.FTOWN_MAX_ACCOUNTS;
});

describe('account creation', () => {
  it('creates an account from a chain with an add_device and exposes it by accountId and handle', async () => {
    const { chain } = await fresh();
    const result = await offer(chain.ledger);
    expect(result).toMatchObject({ decision: 'created', discarded: 0 });
    expect(result.stored?.checkpoint.head).toBe(chain.head);
    expect(await accountCount()).toBe(1);
    expect((await readLedger({ accountId: chain.accountId }))?.checkpoint.head).toBe(chain.head);
    expect((await readLedger({ handle: chain.ledger.genesis.payload.handle }))?.checkpoint.accountId).toBe(chain.accountId);
    expect(await readLedger({ accountId: 'A'.repeat(43) })).toBeNull();
  });

  it('admits a second, different genesis while one account exists, and keeps the accounts apart', async () => {
    const { base } = await registered();
    const { chain: other } = await fresh();
    const result = await offer(other.ledger);
    expect(result.decision).toBe('created');
    expect(result.stored?.checkpoint.accountId).toBe(other.accountId);
    expect(await accountCount()).toBe(2);
    expect((await readLedger({ accountId: base.accountId }))?.checkpoint.head).toBe(base.head);
    expect((await readLedger({ accountId: other.accountId }))?.checkpoint.head).toBe(other.head);
    expect((await readLedger({ handle: other.ledger.genesis.payload.handle }))?.checkpoint.accountId).toBe(other.accountId);
    expect((await readLedger({ handle: base.ledger.genesis.payload.handle }))?.checkpoint.accountId).toBe(base.accountId);
  });

  it('registration closed: registration_closed, nothing verified or written; existing accounts still take replica offers', async () => {
    const { passkey, base } = await registered();
    db.registration = false;
    const { chain } = await fresh();
    const { admitCreation } = budget(true);
    verifySpy.calls = 0;
    expect(await offer(chain.ledger, { admitCreation })).toEqual(refused('registration_closed'));
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
    const forged = { genesis: chain.ledger.genesis, transitions: [{ ...chain.ledger.transitions[0], payload: { ...chain.ledger.transitions[0].payload, issuedAt: chain.issuedAt + 5 } }] };
    expect(await offer(forged)).toEqual(refused('invalid_ledger'));
    expect(await offer({ nonsense: true })).toEqual(refused('invalid_ledger'));
    expect(await offer(undefined)).toEqual(refused('invalid_ledger'));
    expect(db.rows.size).toBe(0);
  });

  it('creation_too_large by record count: 16 records (genesis included) are admitted, 17 are refused unverified', async () => {
    const { chains } = await withDevices(CREATION_MAX_RECORDS);
    const atLimit = chains[CREATION_MAX_RECORDS - 1];
    const overLimit = chains[CREATION_MAX_RECORDS];
    expect(1 + overLimit.ledger.transitions.length).toBe(CREATION_MAX_RECORDS + 1);
    const { admitCreation } = budget(true);
    verifySpy.calls = 0;
    expect(await offer(overLimit.ledger, { admitCreation })).toEqual(refused('creation_too_large'));
    expect(verifySpy.calls).toBe(0);
    expect(admitCreation).not.toHaveBeenCalled();
    expect(db.rows.size).toBe(0);
    expect((await offer(atLimit.ledger)).decision).toBe('created');
  });

  it('creation_too_large by bytes, before any verification; a large-but-allowed chain reaches verification', async () => {
    const { chain } = await fresh();
    const padded = (record: Signed<LedgerTransition>): Signed<LedgerTransition> => ({
      ...record, signature: { ...record.signature, authenticatorData: b64(new Uint8Array(4096)), clientDataJSON: b64(new Uint8Array(4096)) } });
    const big = { genesis: chain.ledger.genesis, transitions: Array.from({ length: 12 }, () => padded(chain.ledger.transitions[0])) };
    expect(1 + big.transitions.length).toBeLessThanOrEqual(CREATION_MAX_RECORDS);
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(CREATION_MAX_BYTES);
    const { admitCreation } = budget(true);
    verifySpy.calls = 0;
    expect(await offer(big, { admitCreation })).toEqual(refused('creation_too_large'));
    expect(verifySpy.calls).toBe(0);
    expect(admitCreation).not.toHaveBeenCalled();
    // Under the byte limit the same padding is only caught by signature verification.
    const under = { genesis: chain.ledger.genesis, transitions: [padded(chain.ledger.transitions[0])] };
    expect(await offer(under, { admitCreation })).toEqual(refused('invalid_ledger'));
    expect(admitCreation).toHaveBeenCalledTimes(1);
    expect(db.rows.size).toBe(0);
  });

  it('the creation size rule does not apply to an existing account: a longer replica is adopted', async () => {
    const { chains } = await withDevices(CREATION_MAX_RECORDS + 4);
    expect((await offer(chains[1].ledger)).decision).toBe('created');
    const large = chains[chains.length - 1];
    expect(1 + large.ledger.transitions.length).toBeGreaterThan(CREATION_MAX_RECORDS);
    const { admitCreation } = budget(false);
    const result = await offer(large.ledger, { admitCreation });
    expect(result.decision).toBe('adopt');
    expect(row(large.accountId).head).toBe(large.head);
    expect(admitCreation).not.toHaveBeenCalled();
  });

  it('server_full at the FTOWN_MAX_ACCOUNTS soft cap, after verification; an unusable value falls back to the default', async () => {
    await registered();
    process.env.FTOWN_MAX_ACCOUNTS = '1';
    const { chain } = await fresh();
    verifySpy.calls = 0;
    expect(await offer(chain.ledger)).toEqual(refused('server_full'));
    expect(verifySpy.calls).toBeGreaterThan(0);
    expect(db.rows.size).toBe(1);
    expect(db.inserts).toBe(0);
    process.env.FTOWN_MAX_ACCOUNTS = '0';
    expect((await offer(chain.ledger)).decision).toBe('created');
    process.env.FTOWN_MAX_ACCOUNTS = '2';
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
    for (const result of results) expect(result.stored?.checkpoint.head).toBe(chain.head);
    expect(db.rows.size).toBe(1);
    expect(db.writes).toBe(1);
  });

  it('an identical creation that lands first makes the insert a no-op, answered as a replica offer', async () => {
    const { chain } = await fresh();
    db.races = [() => { db.rows.set(chain.accountId, storedRow(chain)); }];
    const result = await offer(chain.ledger);
    expect(result.decision).toBe('keep');
    expect(result.stored?.checkpoint.head).toBe(chain.head);
    expect(db.inserts).toBe(1);
    expect(db.writes).toBe(0);
  });

  it('a handle violation caused by an identical concurrent creation is not handle_taken', async () => {
    const { chain } = await fresh();
    // Postgres can raise on the non-arbiter handle index when the identical row commits between the arbiter check and our insert.
    db.races = [() => { db.rows.set(chain.accountId, storedRow(chain)); throw violation('accounts_handle_key'); }];
    const result = await offer(chain.ledger);
    expect(result.decision).toBe('keep');
    expect(result.stored?.checkpoint.head).toBe(chain.head);
  });

  it('other database errors from the insert propagate', async () => {
    const { chain } = await fresh();
    db.races = [() => { throw Object.assign(new Error('connection reset'), { code: '08006' }); }];
    await expect(offer(chain.ledger)).rejects.toThrow('connection reset');
  });
});

describe('creation budget (admitCreation)', () => {
  it('is consulted once, after the cheap gates and before any signature verification', async () => {
    const { chain } = await fresh();
    const { admitCreation, verifiedBefore } = budget(true);
    verifySpy.calls = 0;
    expect((await offer(chain.ledger, { admitCreation })).decision).toBe('created');
    expect(admitCreation).toHaveBeenCalledTimes(1);
    expect(verifiedBefore).toEqual([0]);
  });

  it('refusal is rate_limited: nothing verified, nothing written', async () => {
    const { chain } = await fresh();
    const { admitCreation } = budget(false);
    verifySpy.calls = 0;
    expect(await offer(chain.ledger, { admitCreation })).toEqual(refused('rate_limited'));
    expect(verifySpy.calls).toBe(0);
    expect(db.rows.size).toBe(0);
  });

  it('is not consumed by requests that an earlier check refuses', async () => {
    const { admitCreation } = budget(true);
    expect(await offer({ nonsense: true }, { admitCreation })).toEqual(refused('invalid_ledger'));
    const passkey = await newPasskey();
    expect(await offer((await genesis(passkey)).ledger, { admitCreation })).toEqual(refused('invalid_ledger'));
    const wrong = await createSoftPasskey({ rpId: 'evil.example', origin: 'https://evil.example' });
    const { chain: foreign } = await addDevice(await genesis(wrong, { rpId: 'evil.example', origins: ['https://evil.example'] }), wrong, 'D1');
    expect(await offer(foreign.ledger, { admitCreation })).toEqual(refused('origin_mismatch'));
    db.registration = false;
    expect(await offer((await fresh()).chain.ledger, { admitCreation })).toEqual(refused('registration_closed'));
    expect(admitCreation).not.toHaveBeenCalled();
  });

  it('is never consulted for an existing account: adopt, keep and reject', async () => {
    const { passkey, base } = await registered();
    const { admitCreation } = budget(false);
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    expect((await offer(longer.ledger, { admitCreation })).decision).toBe('adopt');
    expect((await offer(base.ledger, { admitCreation })).decision).toBe('keep');
    const tampered = { genesis: longer.ledger.genesis, transitions: [{ ...longer.ledger.transitions[1], payload: { ...longer.ledger.transitions[1].payload, issuedAt: longer.issuedAt + 7 } }] };
    expect((await offer(tampered, { admitCreation })).decision).toBe('reject');
    expect(admitCreation).not.toHaveBeenCalled();
  });

  it('is consumed at most once when the creation path runs twice, and a twice-lost insert is a conflict', async () => {
    const { chain } = await fresh();
    const { admitCreation } = budget(true);
    db.orphans.add(chain.accountId);
    await expect(offer(chain.ledger, { admitCreation })).rejects.toThrow('account_ledger_conflict');
    expect(db.inserts).toBe(2);
    expect(admitCreation).toHaveBeenCalledTimes(1);
  });

  it('is consumed at most once when a lost insert is re-run as a replica offer', async () => {
    const { chain } = await fresh();
    const { admitCreation } = budget(true);
    db.races = [() => { db.rows.set(chain.accountId, storedRow(chain)); }];
    expect((await offer(chain.ledger, { admitCreation })).decision).toBe('keep');
    expect(admitCreation).toHaveBeenCalledTimes(1);
  });
});

describe('replica rule', () => {
  it('adopts an extension and persists it', async () => {
    const { passkey, base } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    const result = await offer(longer.ledger);
    expect(result.decision).toBe('adopt');
    expect(result.stored?.checkpoint.head).toBe(longer.head);
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
      expect(result.stored?.checkpoint.head).toBe(longer.head);
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
    const tampered = { genesis: longer.ledger.genesis, transitions: [{ ...longer.ledger.transitions[1], payload: { ...longer.ledger.transitions[1].payload, issuedAt: longer.issuedAt + 7 } }] };
    const result = await offer(tampered);
    expect(result.decision).toBe('reject');
    expect(result.stored?.checkpoint.head).toBe(longer.head);
    expect('reason' in result).toBe(false);
    expect(db.writes).toBe(0);
    expect(row(base.accountId).head).toBe(longer.head);
  });
});

describe('sticky revocations', () => {
  it('accumulate from a LOSING candidate, and trusted excludes them while the raw checkpoint keeps them', async () => {
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
    expect(read?.checkpoint.devices.map(item => item.endpoint.id)).toContain(d1.endpoint.id);
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
    expect(fork.stored?.checkpoint.devices.map(item => item.endpoint.id)).toContain(d1.endpoint.id);
    expect(fork.stored?.trusted.devices.map(item => item.endpoint.id)).not.toContain(d1.endpoint.id);
    expect(fork.stored?.sticky.deviceIds).toEqual([d1.endpoint.id]);
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
    expect(read?.checkpoint.bridges).toHaveLength(1);
  });
});

describe('reads', () => {
  it('throw on corruption instead of reporting an absent or valid account', async () => {
    const { base } = await registered();
    const good = { ...row(base.accountId) };
    const cases: Array<[string, Partial<Row>]> = [
      ['revision', { revision: 5 }],
      ['head', { head: 'A'.repeat(43) }],
      ['handle', { handle: randomB64(32) }],
      ['ledger', { ledger: { genesis: base.ledger.genesis, transitions: [{ ...base.ledger.transitions[0], signature: { ...base.ledger.transitions[0].signature, signature: base.ledger.transitions[0].signature.signature.slice(0, -4) + 'AAAA' } }] } }],
      ['shape', { ledger: { nope: true } }],
      ['sticky', { sticky: { deviceIds: [1], bridgeIds: [] } }],
    ];
    for (const [name, patch] of cases) {
      db.rows.set(base.accountId, { ...good, ...patch });
      await expect(readLedger({ accountId: base.accountId }), name).rejects.toThrow('account_ledger_corrupt');
      await expect(offer(base.ledger), name).rejects.toThrow('account_ledger_corrupt');
    }
    db.rows.set(base.accountId, good);
    expect((await readLedger({ accountId: base.accountId }))?.checkpoint.head).toBe(base.head);
  });

  it('a row whose ledger belongs to another account is corruption, never a cross-account read', async () => {
    const { base } = await registered();
    const { chain: other } = await fresh();
    expect((await offer(other.ledger)).decision).toBe('created');
    db.rows.set(base.accountId, { ...row(base.accountId), ledger: row(other.accountId).ledger, head: other.head });
    await expect(readLedger({ accountId: base.accountId })).rejects.toThrow('account_ledger_corrupt');
    expect((await readLedger({ accountId: other.accountId }))?.checkpoint.head).toBe(other.head);
  });

  it('the verification memo holds 32 chains, least recently used evicted first', async () => {
    const chains: Chain[] = [];
    for (let index = 0; index < 33; index += 1) {
      const { chain } = await fresh();
      expect((await offer(chain.ledger)).decision).toBe('created');
      chains.push(chain);
    }
    for (const chain of chains) await readLedger({ accountId: chain.accountId });
    verifySpy.calls = 0;
    for (const chain of chains.slice(1)) await readLedger({ accountId: chain.accountId });
    expect(verifySpy.calls).toBe(0);
    await readLedger({ accountId: chains[0].accountId });
    expect(verifySpy.calls).toBe(1);
  });
});

describe('concurrency', () => {
  it('a lost race is re-read and re-run once', async () => {
    const { passkey, base } = await registered();
    const { chain: one } = await addDevice(base, passkey, 'D2');
    const { chain: two } = await addDevice(one, passkey, 'D3');
    // A concurrent writer lands `one` after our read of `base` but before our write.
    db.races = [() => { db.rows.set(base.accountId, { ...row(base.accountId), revision: 2, head: one.head, ledger: one.ledger }); }];
    const result = await offer(two.ledger);
    expect(result.decision).toBe('adopt');
    expect(result.stored?.checkpoint.head).toBe(two.head);
    expect(row(base.accountId).head).toBe(two.head);
    expect(db.writes).toBe(1);
  });

  it('a second lost race throws and never overwrites the concurrent winner', async () => {
    const { passkey, base } = await registered();
    const { chain: one } = await addDevice(base, passkey, 'D2');
    const { chain: two } = await addDevice(one, passkey, 'D3');
    const { chain: three } = await addDevice(two, passkey, 'D4');
    const land = (chain: Chain) => (): void => { db.rows.set(base.accountId, { ...row(base.accountId), revision: chain.ledger.transitions.length, head: chain.head, ledger: chain.ledger }); };
    db.races = [land(one), land(two)];
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
    expect((row(base.accountId).sticky as { deviceIds: string[] }).deviceIds.sort()).toEqual([d1.endpoint.id, d2.endpoint.id].sort());
    expect(row(base.accountId).head).toBe(stored.head);
    expect(row(base.accountId).version).toBe(3);
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

  it('a memo hit still cross-checks revision and head against the row', async () => {
    const { base } = await registered();
    expect((await readLedger({ accountId: base.accountId }))?.checkpoint.head).toBe(base.head);
    verifySpy.calls = 0;
    await readLedger({ accountId: base.accountId });
    expect(verifySpy.calls).toBe(0);
    db.rows.set(base.accountId, { ...row(base.accountId), revision: 9 });
    await expect(readLedger({ accountId: base.accountId })).rejects.toThrow('account_ledger_corrupt');
    db.rows.set(base.accountId, { ...row(base.accountId), revision: 1, head: 'A'.repeat(43) });
    await expect(readLedger({ accountId: base.accountId })).rejects.toThrow('account_ledger_corrupt');
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

  it('origin_mismatch when the server public origin is misconfigured (publicOrigin throws)', async () => {
    const { chain } = await fresh();
    process.env.FTOWN_PUBLIC_URL = 'https://ftown.example/path';
    try {
      expect(await offer(chain.ledger)).toEqual(refused('origin_mismatch'));
    } finally { process.env.FTOWN_PUBLIC_URL = origin; }
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
