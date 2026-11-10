import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { accountIdOf, applyRevocations, ledgerChallenge, ledgerHead, ledgerLastIssuedAt, nextTransition, resolutionPlan, resolveForkTransition, verifyLedger } from '@security/ledger/ledger';
import type { Ledger, LedgerAuthority, LedgerCheckpoint, LedgerDevice, LedgerGenesis, LedgerOperation, LedgerTransition, PasskeySignature, Signed } from '@security/ledger/protocol';
import { createSoftPasskey, rawToDerSignature } from '@security/ledger/testing';
import { derToRawSignature } from '@security/ledger/webauthn';
import type { SoftPasskey } from '@security/ledger/testing';
import { CREATION_MAX_BYTES, CREATION_MAX_RECORDS } from './ledger-limits';
import { checkpointMac, checkpointMacValid } from './checkpoint-mac';
import type { OfferLimits, OfferResult } from './account-ledger-store';

/** One joined accounts + account_ledger row. The map key is accounts.account_id (PRIMARY KEY); accounts.handle is UNIQUE. */
interface Row { account_id: string; handle: string; revision: number; head: string; ledger: unknown; sticky: unknown; version: number;
  checkpoint: string | null; checkpoint_mac: string | null }
interface StickyIds { deviceIds: string[]; bridgeIds: string[] }
const verifySpy = vi.hoisted(() => ({ calls: 0, caches: [] as unknown[] }));
/** orphans: accounts rows with no account_ledger row (the JOINed reads do not see them). reads: which SELECT shape ran.
 *  sets: the columns each successful UPDATE wrote. */
const db = vi.hoisted(() => ({ rows: new Map<string, Row>(), orphans: new Set<string>(), writes: 0, inserts: 0, updates: 0, heals: 0,
  reads: [] as string[], sets: [] as string[][], races: [] as Array<() => void | Promise<void>>, registration: true }));
vi.mock('@security/ledger/ledger', async importOriginal => {
  const actual = await importOriginal<typeof import('@security/ledger/ledger')>();
  return {
    ...actual,
    verifyLedger: (...args: Parameters<typeof actual.verifyLedger>) => { verifySpy.calls += 1; return actual.verifyLedger(...args); },
    // The cache chooseLedger gets for the stored side: without it, chooseLedger re-verifies the stored chain internally.
    chooseLedger: (...args: Parameters<typeof actual.chooseLedger>) => { verifySpy.caches.push(args[3]); return actual.chooseLedger(...args); },
  };
});
vi.mock('@/lib/registration', () => ({ isRegistrationEnabled: () => db.registration }));
const violation = (constraint: string): Error => Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), { code: '23505', constraint });
/** jsonb's key order (shorter keys first, then bytewise), recursively: what Postgres hands back for a jsonb column. */
const jsonbOrder = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(keys.map(key => [key, jsonbOrder((value as Record<string, unknown>)[key])]));
};
/** A parameter as Postgres stores it: `$n::jsonb` is parsed JSON, a plain `$n` is the text as given. */
const valueOf = (token: string, params: unknown[]): unknown => {
  const match = /^\$(\d+)(::jsonb)?$/.exec(token);
  if (!match) throw new Error(`unexpected value: ${token}`);
  const value = params[Number(match[1]) - 1];
  return match[2] ? JSON.parse(value as string) : value;
};
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    // A tiny interpreter for the statements the store issues: it applies exactly the columns, values and WHERE conditions in the SQL
    // text, with Postgres' constraint and ON CONFLICT semantics.
    query: async (text: string, params: unknown[]) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.startsWith('SELECT COUNT')) return [{ count: db.rows.size }];
      if (sql.startsWith('SELECT')) {
        const chain = sql.includes('JOIN accounts');
        db.reads.push(chain ? 'chain' : 'checkpoint');
        const found = [...db.rows.values()].filter(row => (sql.includes('a.handle=$1') ? row.handle : row.account_id) === params[0]);
        return found.map(row => {
          const out: Record<string, unknown> = { ...row, ledger: jsonbOrder(row.ledger), sticky: jsonbOrder(row.sticky),
            checkpoint: row.checkpoint !== null && typeof row.checkpoint === 'object' ? jsonbOrder(row.checkpoint) : row.checkpoint };
          if (chain) return out;
          // The small read selects no chain, only its length and last payload, as the SQL text says.
          const ledger = row.ledger as { genesis?: { payload?: unknown }; transitions?: Array<{ payload?: unknown }> } | null;
          const transitions = ledger?.transitions;
          if (sql.includes('jsonb_array_length')) {
            out.transition_count = Array.isArray(transitions) ? transitions.length : null;
            out.last_payload = jsonbOrder((Array.isArray(transitions) ? transitions[transitions.length - 1]?.payload : undefined) ?? ledger?.genesis?.payload ?? null);
          }
          delete out.ledger; delete out.handle;
          return out;
        });
      }
      const insert = /^WITH a AS \(INSERT INTO accounts\(account_id,handle\) VALUES \(\$1,\$2\)(.*?)RETURNING account_id\) INSERT INTO account_ledger\((.+?)\) SELECT (.+?) FROM a RETURNING account_id$/.exec(sql);
      if (insert) {
        const [accountId, handle] = params as [string, string];
        await db.races.shift()?.();
        db.inserts += 1;
        // Only an explicit arbiter skips a conflict on its own index; a targetless DO NOTHING skips every unique conflict.
        const arbiter = /ON CONFLICT \(account_id\) DO NOTHING/.test(insert[1]) ? 'account_id' : /ON CONFLICT DO NOTHING/.test(insert[1]) ? 'any' : 'none';
        const idTaken = db.rows.has(accountId) || db.orphans.has(accountId);
        const handleTaken = [...db.rows.values()].some(row => row.handle === handle);
        if ((idTaken && arbiter !== 'none') || (handleTaken && arbiter === 'any')) return [];
        if (idTaken) throw violation('accounts_pkey');
        if (handleTaken) throw violation('accounts_handle_key');
        const columns = insert[2].split(',');
        const values = insert[3].split(',');
        const next: Row = { account_id: accountId, handle, revision: 0, head: '', ledger: null, sticky: { deviceIds: [], bridgeIds: [] }, version: 0, checkpoint: null, checkpoint_mac: null };
        columns.forEach((column, index) => { if (column !== 'account_id') (next as unknown as Record<string, unknown>)[column] = valueOf(values[index], params); });
        db.writes += 1;
        db.rows.set(accountId, next);
        return [{ account_id: accountId }];
      }
      const update = /^UPDATE account_ledger SET (.+) WHERE (.+?) RETURNING account_id$/.exec(sql);
      if (update) {
        const sets = update[1].split(',').map(item => item.trim());
        const where = update[2].split(' AND ').map(item => item.trim());
        const healing = sets[0].startsWith('checkpoint=');
        await db.races.shift()?.();
        if (healing) db.heals += 1; else db.updates += 1;
        const key = where.find(item => item.startsWith('account_id='));
        const row = key ? db.rows.get(valueOf(key.split('=')[1], params) as string) : undefined;
        if (!row) return [];
        for (const condition of where) {
          const [column, token] = condition.split('=');
          if ((row as unknown as Record<string, unknown>)[column] !== valueOf(token, params)) return [];
        }
        const next = { ...row } as unknown as Record<string, unknown>;
        const written: string[] = [];
        for (const assignment of sets) {
          const [column, value] = assignment.split('=');
          written.push(column);
          if (value === 'version+1') next.version = row.version + 1;
          else if (value !== 'NOW()') next[column] = valueOf(value, params);
        }
        db.sets.push(written);
        if (!healing) db.writes += 1;
        db.rows.set(row.account_id, next as unknown as Row);
        return [{ account_id: row.account_id }];
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  }),
}));

const SECRET = 'store-test-auth-secret-0123456789abcdefghij';
vi.stubEnv('AUTH_SECRET', SECRET);
vi.mock('next-auth/providers/credentials', () => ({ default: (config: unknown) => config }));
const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
/** The heal log lines written since the last reset. */
const heals = (): string[] => warn.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('[ledger] checkpoint healed'));
/** The divergent-adoption log lines written since the last reset. */
const adoptions = (): string[] => warn.mock.calls.map(call => String(call[0])).filter(line => line.includes('adopted an owner-chosen history'));
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
/** The owner's choice through the production builder: `chosen` plus a resolve_fork that discards `other` (its tip), signed by `passkey`,
 *  issued after every record of both branches. Throws resolution_incomplete unless `chosen` already carries other's removals (resolveCarrying). */
async function resolve(chosen: Chain, other: Chain, passkey: SoftPasskey): Promise<Chain> {
  const payload = await resolveForkTransition(chosen.ledger, other.ledger, passkey.credentialId, Math.max(chosen.issuedAt, other.issuedAt) + 1000);
  const record = await signed(passkey, payload);
  return { ledger: { genesis: chosen.ledger.genesis, transitions: [...chosen.ledger.transitions, record] }, accountId: chosen.accountId, head: await ledgerHead(payload), issuedAt: payload.issuedAt };
}
/** The owner's full resolution: `chosen` plus resolutionPlan's carry (other's removals and passkeys, signed as ordinary records), then resolve. */
async function resolveCarrying(chosen: Chain, other: Chain, passkey: SoftPasskey): Promise<{ chain: Chain; carried: Chain }> {
  let carried = chosen;
  for (const operation of (await resolutionPlan(chosen.ledger, other.ledger)).carry) carried = await append(carried, passkey, operation);
  return { chain: await resolve(carried, other, passkey), carried };
}
/** The resolve_fork that resolveForkTransition builds for (carried, other), appended to `bare` (which lacks the carried records). */
async function resolveWithoutCarry(bare: Chain, carried: Chain, other: Chain, passkey: SoftPasskey): Promise<Chain> {
  const { operation } = await resolveForkTransition(carried.ledger, other.ledger, passkey.credentialId, Math.max(carried.issuedAt, other.issuedAt) + 1000);
  return append(bare, passkey, operation);
}
const P256_ORDER = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
/** The other valid encoding of the same ECDSA signature (s -> n - s): payload, head and validity unchanged, bytes different. No key needed. */
function malleate(signature: PasskeySignature): PasskeySignature {
  const raw = derToRawSignature(new Uint8Array(Buffer.from(signature.signature, 'base64url')));
  const s = BigInt(`0x${Buffer.from(raw.subarray(32)).toString('hex')}`);
  const flipped = new Uint8Array(64);
  flipped.set(raw.subarray(0, 32), 0);
  flipped.set(Buffer.from((P256_ORDER - s).toString(16).padStart(64, '0'), 'hex'), 32);
  return { ...signature, signature: b64(rawToDerSignature(flipped)) };
}
/** `ledger` with the genesis and its first `length` records re-encoded. */
const reencoded = (ledger: Ledger, length: number): Ledger => ({
  genesis: { payload: ledger.genesis.payload, signature: malleate(ledger.genesis.signature) },
  transitions: ledger.transitions.map((record, index) => (index < length ? { payload: record.payload, signature: malleate(record.signature) } : record)),
});
/** ECDSA verifications (one per passkey assertion checked) while `run` executes. */
async function signatureChecks<T>(run: () => Promise<T>): Promise<[T, number]> {
  const spy = vi.spyOn(crypto.subtle, 'verify');
  try {
    const result = await run();
    return [result, spy.mock.calls.length];
  } finally {
    spy.mockRestore();
  }
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
/** The raw checkpoint of a chain, recomputed from scratch, and the trusted one for a sticky set. */
const rawOf = async (ledger: Ledger): Promise<LedgerCheckpoint> => plain(await verifyLedger(ledger));
const trustedOf = async (ledger: Ledger, sticky: StickyIds = NONE) => plain(applyRevocations(await verifyLedger(ledger), sticky));
const macOf = (row: Pick<Row, 'account_id' | 'revision' | 'head' | 'sticky'>, checkpoint: string): string =>
  checkpointMac({ accountId: row.account_id, revision: row.revision, head: row.head, sticky: row.sticky as StickyIds, checkpoint });
/** The row a correct writer stores for `chain` with `sticky`: checkpoint = canonical raw JSON, MAC over the row. */
async function sealed(chain: Chain, sticky: StickyIds = NONE, version = 0): Promise<Row> {
  const base = { account_id: chain.accountId, handle: chain.ledger.genesis.payload.handle, revision: chain.ledger.transitions.length, head: chain.head,
    ledger: plain(chain.ledger), sticky: plain(sticky), version };
  const checkpoint = JSON.stringify(await verifyLedger(chain.ledger));
  return { ...base, checkpoint, checkpoint_mac: macOf(base, checkpoint) };
}
const macValid = (row: Row): boolean => typeof row.checkpoint === 'string'
  && checkpointMacValid({ accountId: row.account_id, revision: row.revision, head: row.head, sticky: row.sticky as StickyIds, checkpoint: row.checkpoint }, row.checkpoint_mac);

/** A base chain (genesis + device D1), registered in the store, ready for forks. */
async function registered() {
  const passkey = await newPasskey();
  const g = await genesis(passkey);
  const { chain: base, device: d1 } = await addDevice(g, passkey, 'D1');
  expect((await offer(base.ledger)).decision).toBe('created');
  db.writes = 0; db.inserts = 0; db.updates = 0; db.heals = 0; db.reads = []; db.sets = [];
  return { passkey, g, base, d1 };
}
const row = (accountId: string): Row => db.rows.get(accountId) as Row;
const ids = (list: Array<{ endpoint: { id: string } }> | undefined) => (list ?? []).map(item => item.endpoint.id);
const refused = (reason: string) => ({ decision: 'reject', stored: null, discarded: 0, reason });
/** [decision, reason] of an offer; reason undefined when the result carries none. */
const verdict = (result: OfferResult): [string, string | undefined] => [result.decision, 'reason' in result ? result.reason : undefined];
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
  db.rows.clear(); db.orphans.clear(); db.writes = 0; db.inserts = 0; db.updates = 0; db.heals = 0; db.reads = []; db.sets = []; db.races = [];
  db.registration = true; verifySpy.calls = 0; verifySpy.caches = [];
  vi.stubEnv('AUTH_SECRET', SECRET);
  warn.mockClear();
  delete process.env.FTOWN_MAX_ACCOUNTS;
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('account creation', () => {
  it('creates an account and seals its raw checkpoint in the same statement', async () => {
    const { chain } = await fresh();
    const result = await offer(chain.ledger);
    expect(result).toMatchObject({ decision: 'created', discarded: 0 });
    expect(result.stored?.trusted).toEqual(await trustedOf(chain.ledger));
    expect(db.inserts).toBe(1);
    expect(db.updates + db.heals).toBe(0);
    expect(JSON.parse(row(chain.accountId).checkpoint as string)).toEqual(await rawOf(chain.ledger));
    expect(macValid(row(chain.accountId))).toBe(true);
    expect(await accountCount()).toBe(1);
    expect((await readLedger({ accountId: chain.accountId }))?.trusted.head).toBe(chain.head);
    expect((await readLedger({ handle: chain.ledger.genesis.payload.handle }))?.trusted.accountId).toBe(chain.accountId);
    expect(await readLedger({ accountId: 'A'.repeat(43) })).toBeNull();
    expect(db.heals).toBe(0);
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
    const landed = await sealed(chain);
    db.races = [() => { db.rows.set(chain.accountId, landed); }];
    const result = await offer(chain.ledger);
    expect(result.decision).toBe('keep');
    expect(result.stored?.trusted.head).toBe(chain.head);
    expect(db.inserts).toBe(1);
    expect(db.writes).toBe(0);
  });

  it('a handle violation caused by an identical concurrent creation is not handle_taken', async () => {
    const { chain } = await fresh();
    const landed = await sealed(chain);
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
    const landed = await sealed(chain);
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

  it('a valid diverged chain carrying revocations is not a write: 409 diverged, nothing spent, nothing recorded', async () => {
    const { passkey, base, d1 } = await registered();
    const { chain: s1 } = await addDevice(base, passkey, 'S1');
    const { chain: stored } = await addDevice(s1, passkey, 'S2');
    await offer(stored.ledger);
    const before = plain(row(base.accountId));
    const other = await append(base, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    const { limits, admitAccountWrite } = budget(true);
    expect(await offer(other.ledger, limits)).toMatchObject({ decision: 'reject', reason: 'diverged', discarded: 0 });
    expect(admitAccountWrite).not.toHaveBeenCalled();
    expect(row(base.accountId)).toEqual(before);
  });

  it('junk, older, identical and diverged candidates for an account never spend its budget', async () => {
    const { passkey, d1, base } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    const { chain: longest } = await addDevice(longer, passkey, 'D3');
    await offer(longest.ledger);
    db.updates = 0;
    const { chain: fork } = await addDevice(base, passkey, 'F1');
    const { chain: forkLonger } = await addDevice(fork, passkey, 'F2');
    const { chain: forkLongest } = await addDevice(forkLonger, passkey, 'F3');
    const revoking = await append(base, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    const stranger = await newPasskey();
    const strangerSigned = { genesis: longest.ledger.genesis, transitions: [...longest.ledger.transitions,
      await signed(stranger, nextTransition(await verifyLedger(longest.ledger), passkey.credentialId, { type: 'add_device', device: await newDevice(base.accountId, 'X') }, longest.issuedAt + 1000, ledgerLastIssuedAt(longest.ledger)))] };
    const { limits, admitAccountWrite } = budget(true);
    const candidates: Array<[string, unknown, [string, string | undefined]]> = [
      ['tampered extension', tamper(longest, 2), ['reject', undefined]],
      ['extension signed by a stranger', strangerSigned, ['reject', undefined]],
      ['tampered fork', tamper(fork, 1), ['reject', undefined]],
      ['shorter prefix', longer.ledger, ['keep', undefined]],
      ['identical chain', longest.ledger, ['keep', undefined]],
      ['shorter valid diverged chain', fork.ledger, ['reject', 'diverged']],
      ['LONGER valid diverged chain', forkLongest.ledger, ['reject', 'diverged']],
      ['diverged chain with a revocation', revoking.ledger, ['reject', 'diverged']],
    ];
    for (const [name, candidate, expected] of candidates) expect(verdict(await offer(candidate, limits)), name).toEqual(expected);
    expect(admitAccountWrite).not.toHaveBeenCalled();
    expect(db.updates).toBe(0);
    expect(row(base.accountId).head).toBe(longest.head);
  });

  it('an over-limit sticky set is rejected before the budget is consulted', async () => {
    const { passkey, base, d1 } = await registered();
    db.rows.set(base.accountId, await sealed(base, { deviceIds: Array.from({ length: 8192 }, () => randomB64(32)), bridgeIds: [] }, row(base.accountId).version));
    const before = plain(row(base.accountId));
    // A valid extension whose revocation would be the 8193rd sticky id.
    const revoking = await append(base, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    const { limits, admitAccountWrite } = budget(true);
    expect(await offer(revoking.ledger, limits)).toMatchObject({ decision: 'reject', discarded: 0 });
    expect(admitAccountWrite).not.toHaveBeenCalled();
    expect(row(base.accountId)).toEqual(before);
  });

  it('is consumed at most once when a lost write race is re-run', async () => {
    const { passkey, base } = await registered();
    const { chain: one } = await addDevice(base, passkey, 'D2');
    const { chain: two } = await addDevice(one, passkey, 'D3');
    const landed = await sealed(one);
    db.races = [() => { db.rows.set(base.accountId, { ...landed, version: row(base.accountId).version }); }];
    const { limits, admitAccountWrite } = budget(true);
    expect((await offer(two.ledger, limits)).decision).toBe('adopt');
    expect(db.updates).toBe(2);
    expect(admitAccountWrite).toHaveBeenCalledTimes(1);
  });
});

describe('expectHead (a browser re-offering its chain)', () => {
  it('never creates: no row is account_unknown, with no creation budget, verification or insert', async () => {
    const { chain } = await fresh();
    const { limits, admitCreation, admitAccountWrite } = budget(true);
    verifySpy.calls = 0;
    expect(await offerLedger(chain.ledger, limits, { expectHead: chain.head })).toEqual({ decision: 'reject', stored: null, discarded: 0, reason: 'account_unknown' });
    expect(admitCreation).not.toHaveBeenCalled();
    expect(admitAccountWrite).not.toHaveBeenCalled();
    expect(verifySpy.calls).toBe(0);
    expect(db.inserts).toBe(0);
    expect(db.rows.has(chain.accountId)).toBe(false);
  });

  it('a stored head other than expectHead is head_changed with the stored chain: no chooseLedger, no budget, no write', async () => {
    const { passkey, base } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    const { chain: stale } = await addDevice(base, passkey, 'F1');
    const { limits, admitCreation, admitAccountWrite } = budget(true);
    const caches = verifySpy.caches.length;
    const result = await offerLedger(longer.ledger, limits, { expectHead: stale.head });
    expect(result).toMatchObject({ decision: 'reject', discarded: 0, reason: 'head_changed' });
    expect(result.stored?.ledger).toEqual(base.ledger);
    expect(result.stored?.trusted.head).toBe(base.head);
    expect(verifySpy.caches).toHaveLength(caches);
    expect(admitAccountWrite).not.toHaveBeenCalled();
    expect(admitCreation).not.toHaveBeenCalled();
    expect(db.updates).toBe(0);
    expect(row(base.accountId).head).toBe(base.head);
  });

  it('the stored head equal to expectHead is an ordinary offer: chooseLedger, budget and write as without it', async () => {
    const { passkey, base } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    const { chain: fork } = await addDevice(base, passkey, 'F1');
    const { chain: forkLonger } = await addDevice(fork, passkey, 'F2');
    const { limits, admitAccountWrite } = budget(false, true);
    expect(await offerLedger(longer.ledger, limits, { expectHead: base.head })).toMatchObject({ decision: 'adopt', discarded: 0 });
    expect(admitAccountWrite).toHaveBeenCalledExactlyOnceWith(base.accountId);
    expect(row(base.accountId).head).toBe(longer.head);
    // A chain the stored one extends (behind), against the head it names, is kept, spending nothing.
    expect((await offerLedger(base.ledger, limits, { expectHead: longer.head })).decision).toBe('keep');
    // A longer diverged chain against the right head is still refused as diverged, spending nothing.
    expect(await offerLedger(forkLonger.ledger, limits, { expectHead: longer.head })).toMatchObject({ decision: 'reject', reason: 'diverged' });
    expect(admitAccountWrite).toHaveBeenCalledTimes(1);
    expect(row(base.accountId).head).toBe(longer.head);
  });

  it('a head that moves between the read and the write is head_changed on the re-read, never overwritten', async () => {
    const { passkey, base } = await registered();
    const { chain: one } = await addDevice(base, passkey, 'D2');
    const { chain: fork } = await addDevice(base, passkey, 'F1');
    const { chain: forkLonger } = await addDevice(fork, passkey, 'F2');
    const landed = await sealed(one);
    db.races = [() => { db.rows.set(base.accountId, { ...landed, version: row(base.accountId).version }); }];
    const { limits } = budget(true);
    const result = await offerLedger(forkLonger.ledger, limits, { expectHead: base.head });
    expect(result).toMatchObject({ decision: 'reject', reason: 'head_changed' });
    expect(result.stored?.trusted.head).toBe(one.head);
    expect(row(base.accountId).head).toBe(one.head);
    expect(db.writes).toBe(0);
  });

  it('a row that must be re-sealed first is healed, then compared: the healed head equal to expectHead proceeds, another is head_changed', async () => {
    const { passkey, base } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    const { chain: longest } = await addDevice(longer, passkey, 'D3');
    // A row from before the checkpoint columns, holding `longer`.
    db.rows.set(base.accountId, { ...(await sealed(longer)), checkpoint: null, checkpoint_mac: null });
    const { limits, admitAccountWrite } = budget(true);
    expect(await offerLedger(longest.ledger, limits, { expectHead: base.head })).toMatchObject({ decision: 'reject', reason: 'head_changed' });
    expect(db.heals).toBe(1);
    expect(macValid(row(base.accountId))).toBe(true);
    expect(admitAccountWrite).not.toHaveBeenCalled();
    expect(row(base.accountId).head).toBe(longer.head);
    db.rows.set(base.accountId, { ...row(base.accountId), checkpoint: null, checkpoint_mac: null });
    expect(await offerLedger(longest.ledger, limits, { expectHead: longer.head })).toMatchObject({ decision: 'adopt' });
    expect(db.heals).toBe(2);
    expect(admitAccountWrite).toHaveBeenCalledTimes(1);
    expect(row(base.accountId).head).toBe(longest.head);
    expect(macValid(row(base.accountId))).toBe(true);
  });

  it('refuses an expectHead that is not a string', async () => {
    const { base } = await registered();
    await expect(offerLedger(base.ledger, OPEN, { expectHead: 5 as unknown as string })).rejects.toThrow(TypeError);
  });
});

describe('sealed checkpoint', () => {
  it('auth reads with a valid MAC use one small SELECT: no chain read, no verification', async () => {
    const { base } = await registered();
    verifySpy.calls = 0;
    expect(await readTrustedCheckpoint(base.accountId)).toEqual(await trustedOf(base.ledger));
    expect(db.reads).toEqual(['checkpoint']);
    verifySpy.calls = 0;
    await readTrustedCheckpoint(base.accountId);
    expect(await readTrustedCheckpoint('A'.repeat(43))).toBeNull();
    expect(verifySpy.calls).toBe(0);
    expect(db.heals).toBe(0);
  });

  it('readLedger serves the stored chain as-is, without verifying it', async () => {
    const { base } = await registered();
    verifySpy.calls = 0;
    const read = await readLedger({ accountId: base.accountId });
    expect(read?.ledger).toEqual(base.ledger);
    expect(read?.trusted).toEqual(await trustedOf(base.ledger));
    verifySpy.calls = 0;
    await readLedger({ handle: base.ledger.genesis.payload.handle });
    expect(verifySpy.calls).toBe(0);
  });

  it('a signature altered in the chain column is served as-is (clients verify); auth uses the sealed checkpoint', async () => {
    const { base } = await registered();
    const transition = base.ledger.transitions[0];
    const altered = { genesis: base.ledger.genesis, transitions: [{ ...transition, signature: { ...transition.signature, signature: transition.signature.signature.slice(0, -4) + 'AAAA' } }] };
    db.rows.set(base.accountId, { ...row(base.accountId), ledger: altered });
    expect((await readLedger({ accountId: base.accountId }))?.ledger).toEqual(altered);
    expect(await readTrustedCheckpoint(base.accountId)).toEqual(await trustedOf(base.ledger));
  });

  it('both kinds of adopt (ahead, owner-chosen) write chain, sticky, head, revision, checkpoint and MAC in one statement; a refusal writes nothing', async () => {
    const { passkey, base, d1 } = await registered();
    const { chain: s1 } = await addDevice(base, passkey, 'S1');
    const { chain: s2 } = await addDevice(s1, passkey, 'S2');
    const all = ['revision', 'head', 'ledger', 'sticky', 'checkpoint', 'checkpoint_mac', 'version'];
    expect((await offer(s2.ledger)).decision).toBe('adopt');
    expect(db.sets).toHaveLength(1);
    expect(db.sets[0]).toEqual(expect.arrayContaining(all));
    expect(JSON.parse(row(base.accountId).checkpoint as string)).toEqual(await rawOf(s2.ledger));
    expect(macValid(row(base.accountId))).toBe(true);
    const other = await append(base, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    expect(await offer(other.ledger)).toMatchObject({ decision: 'reject', reason: 'diverged' });
    expect(db.sets).toHaveLength(1);
    const chosen = await resolve(other, s2, passkey);
    expect(await offer(chosen.ledger)).toMatchObject({ decision: 'adopt', discarded: 2 });
    expect(db.sets).toHaveLength(2);
    expect(db.sets[1]).toEqual(expect.arrayContaining(all));
    expect(row(base.accountId).ledger).toEqual(plain(chosen.ledger));
    expect([row(base.accountId).revision, row(base.accountId).head]).toEqual([3, chosen.head]);
    expect(JSON.parse(row(base.accountId).checkpoint as string)).toEqual(await rawOf(chosen.ledger));
    expect(macValid(row(base.accountId))).toBe(true);
    const trusted = await readTrustedCheckpoint(base.accountId);
    expect(trusted).toEqual(await trustedOf(chosen.ledger, { deviceIds: [d1.endpoint.id], bridgeIds: [] }));
    expect(ids(trusted?.devices)).not.toContain(d1.endpoint.id);
    expect(db.heals).toBe(0);
  });

  it('chooseLedger never verifies the stored chain: the sealed RAW checkpoint is its cache, with or without sticky ids', async () => {
    const { passkey, base, d1 } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    const { chain: other } = await addDevice(base, passkey, 'O1');
    const raw = await rawOf(base.ledger);
    const cache = { head: base.head, checkpoint: raw };
    for (const sticky of [NONE, { deviceIds: [d1.endpoint.id], bridgeIds: [] }]) {
      const start = await sealed(base, sticky);
      db.rows.set(base.accountId, start);
      verifySpy.calls = 0; verifySpy.caches = [];
      expect((await offer(base.ledger)).decision).toBe('keep');
      expect((await offer(longer.ledger)).decision).toBe('adopt');
      db.rows.set(base.accountId, start);
      expect(await offer(other.ledger)).toMatchObject({ decision: 'adopt' });
      expect(verifySpy.calls).toBe(0);
      // Never the trusted checkpoint (sticky applied): with a sticky id it would no longer describe the chain.
      expect(plain(verifySpy.caches)).toEqual([cache, cache, cache]);
    }
    db.rows.set(base.accountId, await sealed(longer));
    const longerCache = { head: longer.head, checkpoint: await rawOf(longer.ledger) };
    verifySpy.calls = 0; verifySpy.caches = [];
    expect(await offer(other.ledger)).toMatchObject({ decision: 'reject', reason: 'diverged' });
    expect(verifySpy.calls).toBe(0);
    expect(plain(verifySpy.caches)).toEqual([longerCache]);
    expect(db.heals).toBe(0);
  });

  it('a stored chain vouched for by its sealed checkpoint is not re-checked: a signature altered in the column does not break chooseLedger', async () => {
    const { passkey, base } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    const transition = base.ledger.transitions[0];
    const altered = { genesis: base.ledger.genesis, transitions: [{ ...transition, signature: { ...transition.signature, signature: transition.signature.signature.slice(0, -4) + 'AAAA' } }] };
    db.rows.set(base.accountId, { ...row(base.accountId), ledger: altered });
    expect((await offer(longer.ledger)).decision).toBe('adopt');
  });

  it('NULL (a row from before the columns): healed once, sealed, version unchanged, then read without verifying', async () => {
    const { passkey, base, d1 } = await registered();
    const sticky = { deviceIds: [d1.endpoint.id], bridgeIds: [] };
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    for (const read of [() => readTrustedCheckpoint(base.accountId), async () => (await readLedger({ accountId: base.accountId }))?.trusted]) {
      db.rows.set(base.accountId, { ...(await sealed(longer, sticky, 4)), checkpoint: null, checkpoint_mac: null });
      verifySpy.calls = 0;
      const trusted = await read();
      expect(verifySpy.calls).toBe(1);
      expect(trusted).toEqual(await trustedOf(longer.ledger, sticky));
      expect(JSON.parse(row(base.accountId).checkpoint as string)).toEqual(await rawOf(longer.ledger));
      expect(macValid(row(base.accountId))).toBe(true);
      expect(row(base.accountId).version).toBe(4);
      verifySpy.calls = 0;
      expect(await read()).toEqual(trusted);
      expect(verifySpy.calls).toBe(0);
    }
  });

  it('an older instance advanced the chain without the checkpoint: healed, not corrupt, and offers still reach chooseLedger', async () => {
    const { passkey, base } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    const { chain: longest } = await addDevice(longer, passkey, 'D3');
    const stale = row(base.accountId);
    const oldWrite = (): void => {
      const advanced = { ...stale, revision: 2, head: longer.head, ledger: plain(longer.ledger), version: stale.version + 1 };
      db.rows.set(base.accountId, advanced);
    };
    oldWrite();
    expect(await readTrustedCheckpoint(base.accountId)).toEqual(await trustedOf(longer.ledger));
    expect(db.heals).toBe(1);
    expect(macValid(row(base.accountId))).toBe(true);
    oldWrite();
    expect((await offer(longest.ledger)).decision).toBe('adopt');
    expect(row(base.accountId).head).toBe(longest.head);
    expect(macValid(row(base.accountId))).toBe(true);
  });

  it('a tampered checkpoint (device injected, MAC stale or forged without the key) never authorizes it, and is healed', async () => {
    const { base } = await registered();
    const intruder = await newDevice(base.accountId, 'Intruder');
    for (const forge of [(mac: string) => mac, () => createHash('sha256').update('guess').digest('hex')]) {
      const good = row(base.accountId);
      const injected = JSON.parse(good.checkpoint as string) as LedgerCheckpoint;
      injected.devices.push(intruder);
      db.rows.set(base.accountId, { ...good, checkpoint: JSON.stringify(injected), checkpoint_mac: forge(good.checkpoint_mac as string) });
      const trusted = await readTrustedCheckpoint(base.accountId);
      expect(ids(trusted?.devices)).not.toContain(intruder.endpoint.id);
      expect(trusted).toEqual(await trustedOf(base.ledger));
      expect(JSON.parse(row(base.accountId).checkpoint as string)).toEqual(await rawOf(base.ledger));
      expect(macValid(row(base.accountId))).toBe(true);
    }
    expect(db.heals).toBe(2);
  });

  it('a tampered sticky column (id removed) fails the MAC and is healed AS EDITED; the chain\'s own revocations stay enforced', async () => {
    const { passkey, base, d1 } = await registered();
    const { chain: withD2, device: d2 } = await addDevice(base, passkey, 'D2');
    const revoked = await append(withD2, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    const { chain: stored } = await addDevice(revoked, passkey, 'D3');
    expect((await offer(stored.ledger)).decision).toBe('adopt');
    // d2: a sticky id the stored chain lacks, as a row written by older code holds (a fork lost before resolutions had to carry removals).
    db.rows.set(base.accountId, await sealed(stored, { deviceIds: [d1.endpoint.id, d2.endpoint.id], bridgeIds: [] }, row(base.accountId).version));
    expect(ids((await readTrustedCheckpoint(base.accountId))?.devices)).not.toContain(d2.endpoint.id);
    db.rows.set(base.accountId, { ...row(base.accountId), sticky: { deviceIds: [], bridgeIds: [] } });
    verifySpy.calls = 0;
    const trusted = await readTrustedCheckpoint(base.accountId);
    expect(verifySpy.calls).toBe(1);
    expect(db.heals).toBe(1);
    expect(row(base.accountId).sticky).toEqual({ deviceIds: [], bridgeIds: [] });
    expect(macValid(row(base.accountId))).toBe(true);
    // The chain's own revocation is in the raw checkpoint, so it holds whatever the sticky column says.
    expect(ids(trusted?.devices)).not.toContain(d1.endpoint.id);
    expect(trusted?.revokedDeviceIds).toContain(d1.endpoint.id);
    // Known limit: the sticky set is not passkey-signed, so a sticky-only revocation is lost with the edit.
    expect(ids(trusted?.devices)).toContain(d2.endpoint.id);
  });

  it('a changed AUTH_SECRET makes every row heal once under the new key, never corrupt', async () => {
    const { base } = await registered();
    const expected = await trustedOf(base.ledger);
    vi.stubEnv('AUTH_SECRET', 'rotated-auth-secret-0123456789abcdefghijklmn');
    verifySpy.calls = 0;
    expect(await readTrustedCheckpoint(base.accountId)).toEqual(expected);
    expect(verifySpy.calls).toBe(1);
    expect(db.heals).toBe(1);
    expect(macValid(row(base.accountId))).toBe(true);
    verifySpy.calls = 0;
    await readTrustedCheckpoint(base.accountId);
    expect(verifySpy.calls).toBe(0);
  });

  it('a MAC-valid checkpoint of an equal-length fork (same revision, other head) is not trusted', async () => {
    const { passkey, base } = await registered();
    const { chain: a } = await addDevice(base, passkey, 'A');
    const { chain: b } = await addDevice(base, passkey, 'B');
    const rowA = await sealed(a);
    const forkText = JSON.stringify(await verifyLedger(b.ledger));
    db.rows.set(base.accountId, { ...rowA, checkpoint: forkText, checkpoint_mac: macOf(rowA, forkText) });
    const expected = await trustedOf(a.ledger);
    verifySpy.calls = 0;
    expect(await readTrustedCheckpoint(base.accountId)).toEqual(expected);
    expect(verifySpy.calls).toBe(1);
  });

  it('a MAC-valid checkpoint whose own revision disagrees with the row is not trusted', async () => {
    const { base } = await registered();
    const good = row(base.accountId);
    const wrongRevision = JSON.stringify({ ...(JSON.parse(good.checkpoint as string) as LedgerCheckpoint), revision: 0 });
    db.rows.set(base.accountId, { ...good, checkpoint: wrongRevision, checkpoint_mac: macOf(good, wrongRevision) });
    const expected = await trustedOf(base.ledger);
    verifySpy.calls = 0;
    expect(await readTrustedCheckpoint(base.accountId)).toEqual(expected);
    expect(verifySpy.calls).toBe(1);
  });

  it('a MAC-valid checkpoint that names another head or revision than the row is not trusted', async () => {
    const { passkey, base } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    const row2 = await sealed(longer);
    // A correctly keyed MAC over the row's (longer) head and revision, but a checkpoint text of the shorter chain.
    const shorter = JSON.stringify(await verifyLedger(base.ledger));
    db.rows.set(base.accountId, { ...row2, checkpoint: shorter, checkpoint_mac: macOf(row2, shorter) });
    const expected = await trustedOf(longer.ledger);
    verifySpy.calls = 0;
    expect(await readTrustedCheckpoint(base.accountId)).toEqual(expected);
    expect(verifySpy.calls).toBe(1);
    expect(JSON.parse(row(base.accountId).checkpoint as string)).toEqual(await rawOf(longer.ledger));
  });

  it('the heal UPDATE is version guarded: a concurrent write with the same head is never overwritten', async () => {
    const { base, d1 } = await registered();
    db.rows.set(base.accountId, { ...row(base.accountId), checkpoint: null, checkpoint_mac: null });
    const writer = await sealed(base, { deviceIds: [d1.endpoint.id], bridgeIds: [] }, row(base.accountId).version + 1);
    // Lands between the heal's read and its UPDATE: same head and revision, another sticky set and version.
    db.races = [() => { db.rows.set(base.accountId, writer); }];
    const trusted = await readTrustedCheckpoint(base.accountId);
    expect(db.heals).toBe(1);
    expect(row(base.accountId)).toEqual(writer);
    expect(ids(trusted?.devices)).not.toContain(d1.endpoint.id);
  });

  it('a row that keeps moving under the heal is a conflict after three attempts', async () => {
    const { base } = await registered();
    db.rows.set(base.accountId, { ...row(base.accountId), checkpoint: null, checkpoint_mac: null });
    const bump = (): void => { db.rows.set(base.accountId, { ...row(base.accountId), version: row(base.accountId).version + 1 }); };
    db.races = [bump, bump, bump];
    await expect(readTrustedCheckpoint(base.accountId)).rejects.toThrow('account_ledger_conflict');
    expect(db.heals).toBe(3);
  });

  it('ten concurrent heals converge on one consistent row', async () => {
    const { base } = await registered();
    db.rows.set(base.accountId, { ...row(base.accountId), checkpoint: null, checkpoint_mac: null });
    const results = await Promise.all(Array.from({ length: 10 }, () => readTrustedCheckpoint(base.accountId)));
    const expected = await trustedOf(base.ledger);
    for (const result of results) expect(result).toEqual(expected);
    expect(macValid(row(base.accountId))).toBe(true);
    expect(JSON.parse(row(base.accountId).checkpoint as string)).toEqual(await rawOf(base.ledger));
  });

  it('a trusted checkpoint listing more revoked ids than a chain checkpoint may (chain + sticky) is still read', async () => {
    const { base } = await registered();
    const sticky = { deviceIds: Array.from({ length: 2000 }, () => randomB64(32)), bridgeIds: [] };
    db.rows.set(base.accountId, await sealed(base, sticky, 1));
    expect((await readTrustedCheckpoint(base.accountId))?.revokedDeviceIds).toHaveLength(2000);
    expect((await readLedger({ accountId: base.accountId }))?.trusted.revokedDeviceIds).toHaveLength(2000);
    expect(db.heals).toBe(0);
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
    const { limits, admitAccountWrite } = budget(true);
    for (const shorter of [base, g]) {
      const result = await offer(shorter.ledger, limits);
      expect(result).toMatchObject({ decision: 'keep', discarded: 0 });
      expect(result.stored?.ledger).toEqual(longer.ledger);
      expect(result.stored?.trusted.head).toBe(longer.head);
    }
    expect(row(base.accountId).head).toBe(longer.head);
    expect(db.writes).toBe(0);
    expect(db.sets).toHaveLength(1);
    expect(admitAccountWrite).not.toHaveBeenCalled();
  });

  it('a LONGER diverged chain is not adopted and the stored chain is byte-identical afterwards', async () => {
    const { passkey, base } = await registered();
    const { chain: short } = await addDevice(base, passkey, 'S1');
    const { chain: longA } = await addDevice(base, passkey, 'L1');
    const { chain: longB } = await addDevice(longA, passkey, 'L2');
    const { chain: long } = await addDevice(longB, passkey, 'L3');
    expect((await offer(short.ledger)).decision).toBe('adopt');
    const before = JSON.stringify(row(base.accountId));
    db.writes = 0; db.sets = [];
    const { limits, admitAccountWrite } = budget(true);
    const result = await offer(long.ledger, limits);
    expect(result).toEqual({ decision: 'reject', stored: expect.anything(), discarded: 0, reason: 'diverged' });
    expect(result.stored?.ledger).toEqual(short.ledger);
    expect(result.stored?.trusted).toEqual(await trustedOf(short.ledger));
    expect(JSON.stringify(row(base.accountId))).toBe(before);
    expect([db.writes, db.sets.length, db.heals]).toEqual([0, 0, 0]);
    expect(admitAccountWrite).not.toHaveBeenCalled();
    // The shorter stored chain still extends normally.
    const { chain: next } = await addDevice(short, passkey, 'S2');
    expect((await offer(next.ledger)).decision).toBe('adopt');
    expect(row(base.accountId).head).toBe(next.head);
  });

  it('equal-length forks: whichever was written first stays, whatever its head; the other is diverged', async () => {
    for (const order of ['smaller first', 'larger first']) {
      const { passkey, base } = await registered();
      const { chain: a } = await addDevice(base, passkey, 'A');
      const { chain: b } = await addDevice(base, passkey, 'B');
      const [small, large] = a.head < b.head ? [a, b] : [b, a];
      const [first, second] = order === 'smaller first' ? [small, large] : [large, small];
      expect((await offer(first.ledger)).decision, order).toBe('adopt');
      expect(await offer(second.ledger), order).toMatchObject({ decision: 'reject', reason: 'diverged' });
      expect(row(base.accountId).head, order).toBe(first.head);
    }
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
  it('a diverged chain with more revocations is not adopted and sticky is unchanged', async () => {
    const { passkey, base, d1 } = await registered();
    const { chain: withD2, device: d2 } = await addDevice(base, passkey, 'D2');
    const { chain: stored } = await addDevice(withD2, passkey, 'S1');
    expect((await offer(stored.ledger)).decision).toBe('adopt');
    const before = plain(row(base.accountId));
    expect(before.sticky).toEqual(NONE);
    // Longer, and revoking both devices the stored chain trusts: still another history.
    const revokeOne = await append(withD2, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    const revokeBoth = await append(revokeOne, passkey, { type: 'revoke_device', endpointId: d2.endpoint.id });
    const { limits, admitAccountWrite } = budget(true);
    const result = await offer(revokeBoth.ledger, limits);
    expect(result).toMatchObject({ decision: 'reject', reason: 'diverged', discarded: 0 });
    expect(result.stored?.sticky).toEqual(NONE);
    expect(row(base.accountId)).toEqual(before);
    expect(admitAccountWrite).not.toHaveBeenCalled();
    // Both devices stay trusted: the server records nothing from a history it refuses.
    for (const trusted of [(await readLedger({ accountId: base.accountId }))?.trusted, await readTrustedCheckpoint(base.accountId)]) {
      expect(trusted).toEqual(await trustedOf(stored.ledger));
      expect(ids(trusted?.devices)).toEqual(expect.arrayContaining([d1.endpoint.id, d2.endpoint.id]));
    }
  });

  it("accumulate from an adopted chain; a longer fork that lacks the revocation is refused, an owner-chosen one must carry it", async () => {
    const { passkey, base, d1 } = await registered();
    const revoked = await append(base, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    const adopted = await offer(revoked.ledger);
    expect(adopted.decision).toBe('adopt');
    expect(adopted.stored?.sticky.deviceIds).toEqual([d1.endpoint.id]);
    const { chain: f1 } = await addDevice(base, passkey, 'F1');
    const { chain: f2 } = await addDevice(f1, passkey, 'F2');
    expect(await offer(f2.ledger)).toMatchObject({ decision: 'reject', reason: 'diverged' });
    expect(row(base.accountId).head).toBe(revoked.head);
    const { chain: chosen, carried } = await resolveCarrying(f2, revoked, passkey);
    expect(carried.ledger.transitions).toHaveLength(f2.ledger.transitions.length + 1);
    // Without the carried removal the resolution is refused: it would discard a removal.
    expect(await offer((await resolveWithoutCarry(f2, carried, revoked, passkey)).ledger)).toMatchObject({ decision: 'reject', reason: 'diverged' });
    expect(row(base.accountId).head).toBe(revoked.head);
    const fork = await offer(chosen.ledger);
    expect(fork).toMatchObject({ decision: 'adopt', discarded: 1 });
    // The adopted chain itself revokes d1.
    const raw = await verifyLedger(fork.stored!.ledger);
    expect(ids(raw.devices)).not.toContain(d1.endpoint.id);
    expect(raw.revokedDeviceIds).toContain(d1.endpoint.id);
    expect(ids(fork.stored?.trusted.devices)).not.toContain(d1.endpoint.id);
    expect(fork.stored?.sticky.deviceIds).toEqual([d1.endpoint.id]);
    expect(ids((await readTrustedCheckpoint(base.accountId))?.devices)).not.toContain(d1.endpoint.id);
  });

  it('a bridge removal on the discarded branch must be carried: without it 409 diverged; carried, the adopted chain itself revokes the bridge', async () => {
    const { passkey, base } = await registered();
    const bridgeEndpoint = (await newDevice(base.accountId, 'b')).endpoint;
    const device = await newDevice(base.accountId, 'b');
    const bridge = { bridgeId: 'bridge-1', endpoint: { ...bridgeEndpoint, kind: 'bridge' as const }, authPublicKey: device.authPublicKey, label: 'Bridge', approvedAt: T0 };
    const withBridge = await append(base, passkey, { type: 'add_bridge', bridge });
    const removed = await append(withBridge, passkey, { type: 'revoke_bridge', bridgeId: 'bridge-1' });
    expect((await offer(removed.ledger)).decision).toBe('adopt');
    const { chain: x } = await addDevice(withBridge, passkey, 'X');
    const { chain: other } = await addDevice(x, passkey, 'Y');
    expect(await offer(other.ledger)).toMatchObject({ decision: 'reject', reason: 'diverged' });
    expect((await readTrustedCheckpoint(base.accountId))?.bridges).toHaveLength(0);
    const { chain: chosen, carried } = await resolveCarrying(other, removed, passkey);
    const before = JSON.stringify(row(base.accountId));
    expect(await offer((await resolveWithoutCarry(other, carried, removed, passkey)).ledger)).toMatchObject({ decision: 'reject', reason: 'diverged' });
    expect(JSON.stringify(row(base.accountId))).toBe(before);
    expect(await offer(chosen.ledger)).toMatchObject({ decision: 'adopt', discarded: 1 });
    const read = await readLedger({ accountId: base.accountId });
    expect(read?.ledger).toEqual(chosen.ledger);
    expect(read?.sticky.bridgeIds).toEqual(['bridge-1']);
    for (const trusted of [read?.trusted, await readTrustedCheckpoint(base.accountId)]) {
      expect(trusted?.bridges).toHaveLength(0);
      expect(trusted?.revokedBridgeIds).toEqual(['bridge-1']);
    }
    const stored = JSON.parse(row(base.accountId).checkpoint as string) as LedgerCheckpoint;
    expect(stored.bridges).toHaveLength(0);
    expect(stored.revokedBridgeIds).toEqual(['bridge-1']);
  });
});

describe('append-only decision table', () => {
  it('every relation and validity gets exactly one answer; only an adopt writes or spends the account budget', async () => {
    const { passkey, g, base } = await registered();
    const { chain: s1 } = await addDevice(base, passkey, 'S1');
    // The server's chain: D1, S1, S2 (revisions 1 to 3).
    const { chain: stored } = await addDevice(s1, passkey, 'S2');
    const { chain: ahead } = await addDevice(stored, passkey, 'A1');
    // Another history: forks after S1 (revision 2).
    const { chain: other } = await addDevice(s1, passkey, 'O1');
    const { chain: otherLonger } = await addDevice(other, passkey, 'O2');
    const chosen = await resolve(other, stored, passkey);
    // [name, candidate, [decision, reason], written, discarded]
    const cases: Array<[string, Ledger, [string, string | undefined], boolean, number]> = [
      ['same', stored.ledger, ['keep', undefined], false, 0],
      ['behind', s1.ledger, ['keep', undefined], false, 0],
      ['behind (genesis only)', g.ledger, ['keep', undefined], false, 0],
      ['ahead, valid', ahead.ledger, ['adopt', undefined], true, 0],
      ['ahead, invalid new record', tamper(ahead, 3), ['reject', undefined], false, 0],
      ['diverged, invalid after the fork', tamper(otherLonger, 3), ['reject', undefined], false, 0],
      ['diverged, valid, no resolve_fork', otherLonger.ledger, ['reject', 'diverged'], false, 0],
      ['diverged, valid, applicable resolve_fork', chosen.ledger, ['adopt', undefined], true, 1],
    ];
    for (const [name, candidate, expected, written, discarded] of cases) {
      db.rows.set(base.accountId, await sealed(stored, NONE, 5));
      const before = JSON.stringify(row(base.accountId));
      db.writes = 0;
      const { limits, admitAccountWrite } = budget(false);
      const result = await offer(candidate, limits);
      expect(verdict(result), name).toEqual(expected);
      expect(result.discarded, name).toBe(discarded);
      expect(result.stored?.ledger, name).toEqual(written ? candidate : stored.ledger);
      expect(admitAccountWrite, name).toHaveBeenCalledTimes(written ? 1 : 0);
      expect(db.writes, name).toBe(written ? 1 : 0);
      if (written) expect(row(base.accountId).ledger, name).toEqual(plain(candidate));
      else expect(JSON.stringify(row(base.accountId)), name).toBe(before);
    }
  });
});

describe('owner-chosen history (resolve_fork)', () => {
  it('divergent adoption with resolve_fork writes the chain (the removals carried into it), logs once, consumes the account budget once; without them it stays diverged', async () => {
    const { passkey, base, d1 } = await registered();
    const { chain: withD2, device: d2 } = await addDevice(base, passkey, 'D2');
    const revokeD1 = await append(withD2, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    // The server's branch after the fork (revision 2): revoke d1, revoke d2.
    const serverBranch = await append(revokeD1, passkey, { type: 'revoke_device', endpointId: d2.endpoint.id });
    expect((await offer(serverBranch.ledger)).decision).toBe('adopt');
    const { chain: o1, device: o } = await addDevice(withD2, passkey, 'O1');
    const { chain: chosen, carried } = await resolveCarrying(o1, serverBranch, passkey);
    expect(carried.ledger.transitions.slice(o1.ledger.transitions.length).map(record => record.payload.operation))
      .toEqual([{ type: 'revoke_device', endpointId: d1.endpoint.id }, { type: 'revoke_device', endpointId: d2.endpoint.id }]);
    warn.mockClear();
    const { limits, admitAccountWrite } = budget(false);
    // The same resolution without the carried removals would discard them: refused, nothing written, spent or logged.
    const before = JSON.stringify(row(base.accountId));
    expect(verdict(await offer((await resolveWithoutCarry(o1, carried, serverBranch, passkey)).ledger, limits))).toEqual(['reject', 'diverged']);
    expect(JSON.stringify(row(base.accountId))).toBe(before);
    expect(admitAccountWrite).not.toHaveBeenCalled();
    expect(adoptions()).toEqual([]);
    const result = await offer(chosen.ledger, limits);
    expect(result).toMatchObject({ decision: 'adopt', discarded: 2 });
    expect(result.stored?.ledger).toEqual(chosen.ledger);
    expect(row(base.accountId).ledger).toEqual(plain(chosen.ledger));
    expect([row(base.accountId).revision, row(base.accountId).head]).toEqual([6, chosen.head]);
    expect([...(row(base.accountId).sticky as StickyIds).deviceIds].sort()).toEqual([d1.endpoint.id, d2.endpoint.id].sort());
    expect(JSON.parse(row(base.accountId).checkpoint as string)).toEqual(await rawOf(chosen.ledger));
    expect(macValid(row(base.accountId))).toBe(true);
    for (const trusted of [result.stored?.trusted, await readTrustedCheckpoint(base.accountId)]) {
      expect(ids(trusted?.devices)).toEqual([o.endpoint.id]);
      expect([...(trusted?.revokedDeviceIds ?? [])].sort()).toEqual([d1.endpoint.id, d2.endpoint.id].sort());
    }
    // The adopted chain itself revokes both devices (nothing rests on the sticky set).
    const raw = JSON.parse(row(base.accountId).checkpoint as string) as LedgerCheckpoint;
    expect(ids(raw.devices)).toEqual([o.endpoint.id]);
    expect([...raw.revokedDeviceIds].sort()).toEqual([d1.endpoint.id, d2.endpoint.id].sort());
    expect(admitAccountWrite).toHaveBeenCalledExactlyOnceWith(base.accountId);
    expect(adoptions()).toEqual([`[ledger] account ${base.accountId.slice(0, 8)} adopted an owner-chosen history: fork at revision 2, discarded 2 records`]);
    expect(warn).toHaveBeenCalledTimes(1);
    // Offered again it is the stored chain: kept, no second log, no second spend.
    expect((await offer(chosen.ledger, limits)).decision).toBe('keep');
    expect(adoptions()).toHaveLength(1);
    expect(admitAccountWrite).toHaveBeenCalledTimes(1);
  });

  it('a resolve_fork naming an earlier common record than the fork point is 409 diverged, nothing written', async () => {
    const { passkey, base } = await registered();
    const { chain: s1 } = await addDevice(base, passkey, 'S1');
    const { chain: s2 } = await addDevice(s1, passkey, 'S2');
    // The server: D1, S1, S2. The fork point is revision 1 (D1).
    expect((await offer(s2.ledger)).decision).toBe('adopt');
    const { chain: o1 } = await addDevice(base, passkey, 'O1');
    // The production resolution with forkHead moved to the genesis: shared by both chains, but not the last record they share. It still
    // names S1 as the discarded branch's first record and S2 as its tip, so the chain itself is valid.
    const { operation } = await resolveForkTransition(o1.ledger, s2.ledger, passkey.credentialId, Math.max(o1.issuedAt, s2.issuedAt) + 1000);
    expect(operation).toMatchObject({ type: 'resolve_fork', forkHead: base.head, discardedFirst: s1.head, discardedHead: s2.head, discardedRevision: 3 });
    const early = await append(o1, passkey, { ...operation, forkHead: base.accountId } as LedgerOperation);
    expect((await verifyLedger(early.ledger)).head).toBe(early.head);
    const before = JSON.stringify(row(base.accountId));
    warn.mockClear();
    const { limits, admitAccountWrite } = budget(true);
    expect(verdict(await offer(early.ledger, limits))).toEqual(['reject', 'diverged']);
    expect(JSON.stringify(row(base.accountId))).toBe(before);
    expect(admitAccountWrite).not.toHaveBeenCalled();
    expect(adoptions()).toEqual([]);
    // Control: the same choice naming the true fork point is adopted.
    expect(await offer((await resolve(o1, s2, passkey)).ledger, limits)).toMatchObject({ decision: 'adopt', discarded: 2 });
  });

  it('opposite resolutions do not flip-flop: B over A, signed without seeing A over B, stays diverged', async () => {
    const { passkey, base } = await registered();
    const { chain: a } = await addDevice(base, passkey, 'A');
    const { chain: b } = await addDevice(base, passkey, 'B');
    expect((await offer(b.ledger)).decision).toBe('adopt');
    const aOverB = await resolve(a, b, passkey);
    // Another browser chooses the other way, never having seen aOverB.
    const bOverA = await resolve(b, a, passkey);
    expect(await offer(aOverB.ledger)).toMatchObject({ decision: 'adopt', discarded: 1 });
    const before = JSON.stringify(row(base.accountId));
    const { limits, admitAccountWrite } = budget(true);
    expect(verdict(await offer(bOverA.ledger, limits))).toEqual(['reject', 'diverged']);
    expect(JSON.stringify(row(base.accountId))).toBe(before);
    expect(admitAccountWrite).not.toHaveBeenCalled();
    expect((await offer(aOverB.ledger, limits)).decision).toBe('keep');
    // A choice made after seeing aOverB (it discards aOverB's tip) does override it.
    const informed = await resolve(b, aOverB, passkey);
    expect(await offer(informed.ledger, limits)).toMatchObject({ decision: 'adopt', discarded: 2 });
    expect(row(base.accountId).head).toBe(informed.head);
    expect(admitAccountWrite).toHaveBeenCalledTimes(1);
    expect(adoptions()).toHaveLength(2);
  });

  it('a creation chain carrying a resolve_fork is admitted like any chain; the history it discarded is refused afterwards', async () => {
    const passkey = await newPasskey();
    const g = await genesis(passkey);
    const { chain: a } = await addDevice(g, passkey, 'A');
    const { chain: b } = await addDevice(g, passkey, 'B');
    const chosen = await resolve(a, b, passkey);
    expect(await offer(chosen.ledger)).toMatchObject({ decision: 'created', discarded: 0 });
    expect(row(g.accountId).head).toBe(chosen.head);
    expect(verdict(await offer(b.ledger))).toEqual(['reject', 'diverged']);
    expect(adoptions()).toEqual([]);
  });
});

describe('verification cost (the sealed raw checkpoint is the cache)', () => {
  it('an ahead offer checks only the new records; the stored chain is never re-verified', async () => {
    const { passkey, base } = await registered();
    const { chain: s1 } = await addDevice(base, passkey, 'S1');
    const { chain: s2 } = await addDevice(s1, passkey, 'S2');
    expect((await offer(s2.ledger)).decision).toBe('adopt');
    const { chain: n1 } = await addDevice(s2, passkey, 'N1');
    const { chain: n2 } = await addDevice(n1, passkey, 'N2');
    verifySpy.calls = 0;
    const [result, checks] = await signatureChecks(() => offer(n2.ledger));
    expect(result.decision).toBe('adopt');
    expect(checks).toBe(2);
    expect(verifySpy.calls).toBe(0);
    expect(db.heals).toBe(0);
  });

  it("a diverged offer checks only the candidate's records after the fork, adopted or not; same and behind check nothing", async () => {
    const { passkey, base } = await registered();
    const { chain: s1 } = await addDevice(base, passkey, 'S1');
    const { chain: s2 } = await addDevice(s1, passkey, 'S2');
    const { chain: s3 } = await addDevice(s2, passkey, 'S3');
    // The server: D1, S1, S2, S3. The other history forks after S1 (revision 2).
    expect((await offer(s3.ledger)).decision).toBe('adopt');
    const { chain: o1 } = await addDevice(s1, passkey, 'O1');
    const { chain: o2 } = await addDevice(o1, passkey, 'O2');
    const chosen = await resolve(o2, s3, passkey);
    verifySpy.calls = 0;
    const cases: Array<[string, Ledger, string, number]> = [
      ['same', s3.ledger, 'keep', 0],
      ['behind', s1.ledger, 'keep', 0],
      ['diverged', o2.ledger, 'reject', 2],
      ['diverged with resolve_fork', chosen.ledger, 'adopt', 3],
    ];
    for (const [name, candidate, decision, expected] of cases) {
      const [result, checks] = await signatureChecks(() => offer(candidate));
      expect(result.decision, name).toBe(decision);
      expect(checks, name).toBe(expected);
    }
    expect(verifySpy.calls).toBe(0);
    expect(db.heals).toBe(0);
  });

  it('an ahead chain whose shared prefix has re-encoded (high-S) signatures is adopted with the STORED prefix bytes; one signature checked', async () => {
    const { passkey, base } = await registered();
    const { chain: s1 } = await addDevice(base, passkey, 'S1');
    const { chain: s2 } = await addDevice(s1, passkey, 'S2');
    expect((await offer(s2.ledger)).decision).toBe('adopt');
    const storedBefore = plain(row(base.accountId).ledger) as Ledger;
    const { chain: next } = await addDevice(s2, passkey, 'N1');
    // Genesis and the 3 shared records re-encoded (anyone can do it, no key): same payloads and heads, other valid bytes. N1 as signed.
    const offered = reencoded(next.ledger, 3);
    expect(offered.genesis.signature).not.toEqual(next.ledger.genesis.signature);
    expect(offered.transitions[2].signature).not.toEqual(next.ledger.transitions[2].signature);
    expect((await verifyLedger(offered)).head).toBe(next.head);
    verifySpy.calls = 0;
    const [result, checks] = await signatureChecks(() => offer(offered));
    expect(result).toMatchObject({ decision: 'adopt', discarded: 0 });
    expect(checks).toBe(1);
    expect(verifySpy.calls).toBe(0);
    // Written, answered and published (the route sends stored.ledger): the stored prefix byte-for-byte plus the verified new record.
    const expected = { genesis: storedBefore.genesis, transitions: [...storedBefore.transitions, offered.transitions[3]] };
    expect(row(base.accountId).ledger).toEqual(expected);
    expect(result.stored?.ledger).toEqual(expected);
    expect(JSON.stringify(row(base.accountId).ledger)).not.toBe(JSON.stringify(plain(offered)));
    expect([row(base.accountId).revision, row(base.accountId).head]).toEqual([4, next.head]);
    expect(macValid(row(base.accountId))).toBe(true);
    expect((await readLedger({ accountId: base.accountId }))?.ledger).toEqual(expected);
  });

  it('an owner-chosen history offered with a re-encoded shared prefix is stored with the STORED prefix bytes', async () => {
    const { passkey, base } = await registered();
    const { chain: s1 } = await addDevice(base, passkey, 'S1');
    expect((await offer(s1.ledger)).decision).toBe('adopt');
    const storedBefore = plain(row(base.accountId).ledger) as Ledger;
    const { chain: o1 } = await addDevice(base, passkey, 'O1');
    // Genesis and the shared record (D1) re-encoded; O1 and the resolve_fork as signed.
    const offered = reencoded((await resolve(o1, s1, passkey)).ledger, 1);
    const [result, checks] = await signatureChecks(() => offer(offered));
    expect(result).toMatchObject({ decision: 'adopt', discarded: 1 });
    expect(checks).toBe(2);
    const expected = { genesis: storedBefore.genesis, transitions: [storedBefore.transitions[0], ...offered.transitions.slice(1)] };
    expect(row(base.accountId).ledger).toEqual(expected);
    expect(result.stored?.ledger).toEqual(expected);
  });
});

describe('reads', () => {
  it('throw on a corrupt chain row; checkpoint or revision/head damage is healed from the chain instead', async () => {
    const { passkey, base } = await registered();
    const good = { ...row(base.accountId) };
    const { chain: other } = await fresh();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    const otherRow = await sealed(other);
    // [name, patch, full read, checkpoint read]: 'corrupt' throws, 'ok' returns base's trusted checkpoint (healing if needed).
    const cases: Array<[string, Partial<Row>, 'corrupt' | 'ok', 'corrupt' | 'ok']> = [
      // The revision and head columns follow the chain column: a disagreement is healed from the (verified) chain.
      ['revision', { revision: 5 }, 'ok', 'ok'],
      ['head', { head: 'A'.repeat(43) }, 'ok', 'ok'],
      ['handle', { handle: randomB64(32) }, 'corrupt', 'ok'],
      ['shape', { ledger: { nope: true } }, 'corrupt', 'corrupt'],
      ['chain of another account', { ledger: plain(other.ledger) }, 'corrupt', 'corrupt'],
      ['sticky', { sticky: { deviceIds: [1], bridgeIds: [] } }, 'corrupt', 'corrupt'],
      ['version', { version: 'x' as unknown as number }, 'corrupt', 'corrupt'],
      ['checkpoint shape', { checkpoint: '{"nope":true}' }, 'ok', 'ok'],
      ['checkpoint not JSON', { checkpoint: '{' }, 'ok', 'ok'],
      ['checkpoint of another account (with its MAC)', { checkpoint: otherRow.checkpoint, checkpoint_mac: otherRow.checkpoint_mac }, 'ok', 'ok'],
      ['checkpoint of another head', { checkpoint: JSON.stringify(await verifyLedger(longer.ledger)) }, 'ok', 'ok'],
      ['mac missing', { checkpoint_mac: null }, 'ok', 'ok'],
      ['mac not hex', { checkpoint_mac: 'x'.repeat(64) }, 'ok', 'ok'],
    ];
    const expected = await trustedOf(base.ledger);
    for (const [name, patch, full, small] of cases) {
      for (const [mode, read] of [[full, async () => (await readLedger({ accountId: base.accountId }))?.trusted], [small, () => readTrustedCheckpoint(base.accountId)]] as const) {
        db.rows.set(base.accountId, { ...good, ...patch });
        if (mode === 'corrupt') await expect(read(), name).rejects.toThrow('account_ledger_corrupt');
        else expect(await read(), name).toEqual(expected);
      }
      db.rows.set(base.accountId, { ...good, ...patch });
      if (full === 'corrupt') await expect(offer(base.ledger), name).rejects.toThrow('account_ledger_corrupt');
      if (full === 'ok') {
        // An offer heals too, and the row converges back to exactly what a correct writer stored.
        expect((await offer(base.ledger)).decision, name).toBe('keep');
        expect(row(base.accountId), name).toEqual(good);
      }
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
    const landed = await sealed(one);
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
    const rows = [await sealed(one), await sealed(two)];
    db.races = rows.map(next => (): void => { db.rows.set(base.accountId, { ...next, version: row(base.accountId).version }); });
    await expect(offer(three.ledger)).rejects.toThrow('account_ledger_conflict');
    expect(db.writes).toBe(0);
    expect(row(base.accountId).head).toBe(two.head);
  });

  it('two different valid extensions of one head offered concurrently: exactly one is written, the other is 409 diverged', async () => {
    const { passkey, base, d1 } = await registered();
    const a = await append(base, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    const { chain: b } = await addDevice(base, passkey, 'B');
    const { limits, admitAccountWrite } = budget(true);
    let inner: Awaited<ReturnType<typeof offer>> | null = null;
    // b is offered and written between a's read of `base` and a's guarded UPDATE.
    db.races = [async () => { inner = await offer(b.ledger, limits); }];
    const outer = await offer(a.ledger, limits);
    expect(inner).toMatchObject({ decision: 'adopt', discarded: 0 });
    // a's UPDATE matched nothing; the retry round re-read b and re-ran chooseLedger: a is now diverged by one record.
    expect(outer).toMatchObject({ decision: 'reject', reason: 'diverged', discarded: 0 });
    expect(outer.stored?.ledger).toEqual(b.ledger);
    expect(row(base.accountId).ledger).toEqual(plain(b.ledger));
    expect(row(base.accountId).sticky).toEqual(NONE);
    expect(db.updates).toBe(2);
    expect(db.writes).toBe(1);
    // One unit per offer: a's was spent before it lost the guarded UPDATE (no refund), never a second time on the retry.
    expect(admitAccountWrite).toHaveBeenCalledTimes(2);
    expect(macValid(row(base.accountId))).toBe(true);
  });

  it('the same extension offered concurrently: one adopt writes it, the other is kept', async () => {
    const { passkey, base } = await registered();
    const { chain: next } = await addDevice(base, passkey, 'D2');
    let inner: Awaited<ReturnType<typeof offer>> | null = null;
    db.races = [async () => { inner = await offer(next.ledger); }];
    const outer = await offer(next.ledger);
    expect(inner).toMatchObject({ decision: 'adopt' });
    expect(outer).toMatchObject({ decision: 'keep', discarded: 0 });
    expect(outer.stored?.ledger).toEqual(next.ledger);
    expect(db.writes).toBe(1);
    expect(row(base.accountId).head).toBe(next.head);
  });

  it('concurrent creations of one genesis with different first records: one is created, the other is diverged', async () => {
    const passkey = await newPasskey();
    const g = await genesis(passkey);
    const { chain: a } = await addDevice(g, passkey, 'A');
    const { chain: b } = await addDevice(g, passkey, 'B');
    let inner: Awaited<ReturnType<typeof offer>> | null = null;
    db.races = [async () => { inner = await offer(b.ledger); }];
    const outer = await offer(a.ledger);
    expect(inner).toMatchObject({ decision: 'created' });
    expect(outer).toMatchObject({ decision: 'reject', reason: 'diverged' });
    expect(outer.stored?.ledger).toEqual(b.ledger);
    expect(row(g.accountId).ledger).toEqual(plain(b.ledger));
    expect(db.writes).toBe(1);
  });
});

describe('write safety', () => {
  it('an over-limit sticky set is rejected before any write, also when the removal carried by an owner-chosen history pushes it over', async () => {
    const { passkey, base, d1 } = await registered();
    const revoked = await append(base, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    expect((await offer(revoked.ledger)).decision).toBe('adopt');
    // 8192 sticky ids (the limit), d1 not among them: the adopted chain's own (carried) revocation would be the 8193rd.
    const flood = Array.from({ length: 8192 }, () => randomB64(32));
    db.rows.set(base.accountId, await sealed(revoked, { deviceIds: flood, bridgeIds: [] }, row(base.accountId).version));
    const before = plain(row(base.accountId));
    db.writes = 0;
    const { chain: other } = await addDevice(base, passkey, 'O1');
    const { limits, admitAccountWrite } = budget(true);
    // Rejected as unwritable (no reason), not as diverged: the chain itself was adoptable.
    expect(verdict(await offer((await resolveCarrying(other, revoked, passkey)).chain.ledger, limits))).toEqual(['reject', undefined]);
    expect(db.writes).toBe(0);
    expect(admitAccountWrite).not.toHaveBeenCalled();
    expect(row(base.accountId)).toEqual(before);
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

describe('chain column tied to the seal', () => {
  it("reviewer PoC: an old snapshot's sealed columns over the CURRENT chain: auth follows the chain, full reads and offers work", async () => {
    const { passkey, base, d1 } = await registered();
    const snapshot = { ...row(base.accountId) };
    const revoked = await append(base, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    expect((await offer(revoked.ledger)).decision).toBe('adopt');
    const current = row(base.accountId);
    // The old snapshot's revision/head/sticky/checkpoint/MAC (a valid seal of the OLD state) put back over the current chain.
    db.rows.set(base.accountId, { ...snapshot, ledger: current.ledger, version: current.version });
    const expected = await trustedOf(revoked.ledger, current.sticky as StickyIds);
    const trusted = await readTrustedCheckpoint(base.accountId);
    expect(ids(trusted?.devices)).not.toContain(d1.endpoint.id);
    expect(trusted?.revokedDeviceIds).toContain(d1.endpoint.id);
    expect([row(base.accountId).revision, row(base.accountId).head]).toEqual([2, revoked.head]);
    expect(macValid(row(base.accountId))).toBe(true);
    expect(heals()).toEqual([`[ledger] checkpoint healed: account ${base.accountId.slice(0, 8)} reason chain_mismatch revision 1->2`]);
    expect((await readLedger({ accountId: base.accountId }))?.trusted.head).toBe(revoked.head);
    const { chain: next } = await addDevice(revoked, passkey, 'D3');
    expect((await offer(next.ledger)).decision).toBe('adopt');
    expect(trusted).toEqual({ ...expected, revokedDeviceIds: trusted?.revokedDeviceIds });
  });

  it('an equal-length fork in the chain column under a valid seal of the other fork: both reads follow the column', async () => {
    const { passkey, base } = await registered();
    const { chain: a } = await addDevice(base, passkey, 'A');
    const { chain: b } = await addDevice(base, passkey, 'B');
    for (const read of [() => readTrustedCheckpoint(base.accountId), async () => (await readLedger({ accountId: base.accountId }))?.trusted]) {
      db.rows.set(base.accountId, { ...(await sealed(a)), ledger: plain(b.ledger) });
      const expected = await trustedOf(b.ledger);
      expect(await read()).toEqual(expected);
      expect(row(base.accountId).head).toBe(b.head);
    }
    expect(heals()).toEqual(Array(2).fill(`[ledger] checkpoint healed: account ${base.accountId.slice(0, 8)} reason chain_mismatch revision 2->2`));
  });

  it('a chain column whose tip is the sealed head but whose length is not (a duplicated record) is never trusted: corrupt', async () => {
    const { base } = await registered();
    const doubled = { genesis: base.ledger.genesis, transitions: [base.ledger.transitions[0], base.ledger.transitions[0]] };
    for (const read of [() => readTrustedCheckpoint(base.accountId), () => readLedger({ accountId: base.accountId })]) {
      db.rows.set(base.accountId, { ...(await sealed(base)), ledger: plain(doubled) });
      await expect(read()).rejects.toThrow('account_ledger_corrupt');
    }
  });

  it('a genesis-only chain: revision 0, and its tip is the genesis head (the accountId)', async () => {
    const passkey = await newPasskey();
    const g = await genesis(passkey);
    db.rows.set(g.accountId, await sealed(g));
    verifySpy.calls = 0;
    expect(await readTrustedCheckpoint(g.accountId)).toEqual(await trustedOf(g.ledger));
    expect(db.heals).toBe(0);
  });

  it('DOCUMENTED RESIDUAL RISK: a database-only writer can roll an account back to a signed prefix; the heal re-seals it (logged)', async () => {
    const { passkey, base, d1 } = await registered();
    const revoked = await append(base, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    expect((await offer(revoked.ledger)).decision).toBe('adopt');
    expect(ids((await readTrustedCheckpoint(base.accountId))?.devices)).not.toContain(d1.endpoint.id);
    // Truncate the chain to the signed prefix before the revocation, clear sticky, NULL the seal: no old snapshot needed.
    db.rows.set(base.accountId, { ...row(base.accountId), ledger: plain(base.ledger), revision: 1, head: base.head,
      sticky: { deviceIds: [], bridgeIds: [] }, checkpoint: null, checkpoint_mac: null });
    expect(ids((await readTrustedCheckpoint(base.accountId))?.devices)).toContain(d1.endpoint.id);
    expect(heals()).toEqual([`[ledger] checkpoint healed: account ${base.accountId.slice(0, 8)} reason absent revision 1->1`]);
    // Any offer of a chain that extends the rolled-back one (a client's next write or re-offer) moves the server forward again.
    expect((await offer(revoked.ledger)).decision).toBe('adopt');
    expect(ids((await readTrustedCheckpoint(base.accountId))?.devices)).not.toContain(d1.endpoint.id);
  });
});

describe('heal observability', () => {
  it('each heal logs one line: constant text, account prefix, reason category and old->new revision', async () => {
    const { passkey, base } = await registered();
    const { chain: longer } = await addDevice(base, passkey, 'D2');
    const prefix = base.accountId.slice(0, 8);
    const cases: Array<[string, () => Promise<Row>, string]> = [
      ['absent', async () => ({ ...(await sealed(base)), checkpoint: null, checkpoint_mac: null }), 'absent revision 1->1'],
      ['mac_mismatch', async () => ({ ...(await sealed(base)), checkpoint_mac: '0'.repeat(64) }), 'mac_mismatch revision 1->1'],
      ['stale_head', async () => {
        const old = await sealed(base);
        return { ...old, ledger: plain(longer.ledger), revision: 2, head: longer.head };
      }, 'stale_head revision 2->2'],
      ['chain_mismatch', async () => ({ ...(await sealed(base)), ledger: plain(longer.ledger) }), 'chain_mismatch revision 1->2'],
    ];
    for (const [name, make, tail] of cases) {
      db.rows.set(base.accountId, await make());
      warn.mockClear();
      await readTrustedCheckpoint(base.accountId);
      await readTrustedCheckpoint(base.accountId);
      expect(heals(), name).toEqual([`[ledger] checkpoint healed: account ${prefix} reason ${tail}`]);
      expect(warn, name).toHaveBeenCalledTimes(1);
    }
  });

  it('the log line never carries checkpoint contents, MACs or the secret', async () => {
    const { base } = await registered();
    const good = row(base.accountId);
    db.rows.set(base.accountId, { ...good, checkpoint_mac: 'f'.repeat(64) });
    await readTrustedCheckpoint(base.accountId);
    const line = heals()[0];
    expect(line).toMatch(/^\[ledger\] checkpoint healed: account [A-Za-z0-9_-]{8} reason mac_mismatch revision \d+->\d+$/);
    for (const secret of [SECRET, 'f'.repeat(64), good.checkpoint_mac as string, base.accountId]) expect(line).not.toContain(secret);
  });
});

describe('stored representation', () => {
  it('sticky comes back from jsonb with its keys reordered (bridgeIds first): the MAC still holds, no heal', async () => {
    const { passkey, base, d1 } = await registered();
    const revoking = await append(base, passkey, { type: 'revoke_device', endpointId: d1.endpoint.id });
    const { chain: s1 } = await addDevice(revoking, passkey, 'S1');
    await offer(s1.ledger);
    expect((row(base.accountId).sticky as StickyIds).deviceIds).toEqual([d1.endpoint.id]);
    db.heals = 0; db.reads = [];
    const trusted = await readTrustedCheckpoint(base.accountId);
    expect(ids(trusted?.devices)).not.toContain(d1.endpoint.id);
    expect(db.heals).toBe(0);
    expect(heals()).toEqual([]);
    expect(Object.keys(jsonbOrder(row(base.accountId).sticky) as object)).toEqual(['bridgeIds', 'deviceIds']);
  });

  it('a checkpoint column left as jsonb by an earlier draft of 0012 is never trusted, and stops healing once 0012 made it text', async () => {
    const { base } = await registered();
    const good = row(base.accountId);
    const oldTrusted = await trustedOf(base.ledger);
    // Before the conversion: jsonb values come back as objects. With or without a MAC they are healed, never trusted.
    for (const [mac, reason] of [[null, 'absent'], [good.checkpoint_mac, 'mac_mismatch']] as const) {
      db.rows.set(base.accountId, { ...good, checkpoint: oldTrusted as unknown as string, checkpoint_mac: mac });
      warn.mockClear();
      expect(await readTrustedCheckpoint(base.accountId)).toEqual(oldTrusted);
      expect(heals()[0]).toContain(`reason ${reason}`);
    }
    // After `ALTER COLUMN checkpoint TYPE TEXT USING checkpoint::text`: the old value is jsonb text, with no MAC. One heal, then none.
    db.rows.set(base.accountId, { ...good, checkpoint: JSON.stringify(jsonbOrder(oldTrusted)), checkpoint_mac: null });
    warn.mockClear();
    for (let index = 0; index < 3; index += 1) expect(await readTrustedCheckpoint(base.accountId)).toEqual(oldTrusted);
    expect(heals()).toHaveLength(1);
    expect(typeof row(base.accountId).checkpoint).toBe('string');
    expect(macValid(row(base.accountId))).toBe(true);
  });
});

describe('AUTH_SECRET unusable: fail closed', () => {
  const CENTRIFUGO = 'store-test-centrifugo-secret-0123456789abcdef';
  async function withBridge() {
    const { passkey, base, d1 } = await registered();
    const endpoint = { ...(await newDevice(base.accountId, 'b')).endpoint, kind: 'bridge' as const };
    const bridge = { bridgeId: 'bridge-1', endpoint, authPublicKey: (await newDevice(base.accountId, 'k')).authPublicKey, label: 'Bridge', approvedAt: T0 };
    const chain = await append(base, passkey, { type: 'add_bridge', bridge });
    expect((await offer(chain.ledger)).decision).toBe('adopt');
    return { base, d1, chain };
  }

  it('the store throws before reading, healing or writing anything', async () => {
    const { base } = await registered();
    const { chain } = await fresh();
    for (const value of [undefined, 'short', 'change-me-change-me-change-me-change-me']) {
      for (const sealedRow of [true, false]) {
        vi.stubEnv('AUTH_SECRET', SECRET);
        db.rows.set(base.accountId, sealedRow ? await sealed(base) : { ...(await sealed(base)), checkpoint: null, checkpoint_mac: null });
        const before = { ...row(base.accountId) };
        vi.stubEnv('AUTH_SECRET', value);
        db.reads = []; db.heals = 0; db.writes = 0; db.inserts = 0; verifySpy.calls = 0;
        const { limits, admitCreation, admitAccountWrite } = budget(true);
        await expect(readTrustedCheckpoint(base.accountId)).rejects.toThrow(/AUTH_SECRET/);
        await expect(readLedger({ accountId: base.accountId })).rejects.toThrow(/AUTH_SECRET/);
        await expect(offerLedger(base.ledger, limits)).rejects.toThrow(/AUTH_SECRET/);
        await expect(offerLedger(chain.ledger, limits)).rejects.toThrow(/AUTH_SECRET/);
        expect([db.reads, db.heals, db.writes, db.inserts, verifySpy.calls]).toEqual([[], 0, 0, 0, 0]);
        expect(admitCreation).not.toHaveBeenCalled();
        expect(admitAccountWrite).not.toHaveBeenCalled();
        expect(row(base.accountId)).toEqual(before);
      }
    }
    expect(heals()).toEqual([]);
  });

  it('requireAccount, authorizeLedgerProof and requireBridge do not authorize, heal or write', async () => {
    const { requireAccount, authorizeLedgerProof } = await import('./ledger-auth');
    const { requireBridge } = await import('./relay-auth');
    const jwt = (await import('jsonwebtoken')).default;
    const { base, d1 } = await withBridge();
    vi.stubEnv('CENTRIFUGO_TOKEN_SECRET', CENTRIFUGO);
    const session = async () => ({ user: { id: base.accountId, endpointId: d1.endpoint.id } });
    const token = jwt.sign({ sub: base.accountId, info: { bridgeId: 'bridge-1', ownerId: base.accountId } }, CENTRIFUGO, { algorithm: 'HS256', audience: 'ftown:centrifugo', expiresIn: 60 });
    const bridgeRequest = () => new Request('https://app.test/x', { headers: { authorization: `Bearer ${token}` } });
    // Control: with the secret, both are authorized.
    expect((await requireAccount(session)).endpointId).toBe(d1.endpoint.id);
    expect((await requireBridge(bridgeRequest())).bridgeId).toBe('bridge-1');
    for (const sealedRow of [true, false]) {
      if (!sealedRow) db.rows.set(base.accountId, { ...row(base.accountId), checkpoint: null, checkpoint_mac: null });
      const before = { ...row(base.accountId) };
      vi.stubEnv('AUTH_SECRET', undefined);
      db.reads = []; db.heals = 0; db.writes = 0; verifySpy.calls = 0;
      await expect(requireAccount(session)).rejects.toThrow(/AUTH_SECRET/);
      await expect(requireBridge(bridgeRequest())).rejects.toThrow(/AUTH_SECRET/);
      expect(await authorizeLedgerProof({ nope: true })).toBeNull();
      expect([db.reads, db.heals, db.writes, verifySpy.calls]).toEqual([[], 0, 0, 0]);
      expect(row(base.accountId)).toEqual(before);
      vi.stubEnv('AUTH_SECRET', SECRET);
    }
  });
});
