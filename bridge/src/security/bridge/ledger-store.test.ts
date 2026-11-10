import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import type { EndpointPublic } from '../protocol.js';
import {
  accountIdOf, ledgerChallenge, ledgerHead, ledgerLastIssuedAt, ledgerRevocations, nextTransition, verifyLedger,
} from '../ledger/ledger.js';
import { bridgeFromPairRequest, createBridgePairRequest } from '../ledger/pairing.js';
import type { BridgePairLink } from '../ledger/pairing.js';
import type { Ledger, LedgerDevice, LedgerGenesis, LedgerOperation, LedgerTransition, Signed } from '../ledger/protocol.js';
import { createSoftPasskey } from '../ledger/testing.js';
import type { SoftPasskey } from '../ledger/testing.js';
import { BridgeSecurityError } from './errors.js';
import { readLedgerIdentity } from './ledger-identity.js';
import { BridgeLedgerStore, LedgerStoreError, reconcileIdentityAndStore } from './ledger-store.js';

const rpId = 'ftown.example';
const origin = 'https://ftown.example';
const T0 = 1750000000000;
const NOW = T0 + 3600000;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64url');
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('base64url');
const randomB64 = (length: number): string => b64(crypto.getRandomValues(new Uint8Array(length)));

interface Chain { ledger: Ledger; accountId: string; head: string }

async function signed<T extends LedgerGenesis | LedgerTransition>(passkey: SoftPasskey, payload: T): Promise<Signed<T>> {
  return { payload, signature: await passkey.sign(await ledgerChallenge(payload)) };
}
async function start(passkey: SoftPasskey): Promise<Chain> {
  const genesis = await signed(passkey, {
    type: 'ftown_account_genesis', version: 2, rpId, origins: [origin], handle: randomB64(32), createdAt: T0,
    authority: { credentialId: passkey.credentialId, publicKey: passkey.publicKey, label: 'iCloud Keychain', addedAt: T0 },
  });
  const accountId = await accountIdOf(genesis.payload);
  return { ledger: { genesis, transitions: [] }, accountId, head: accountId };
}
async function append(chain: Chain, passkey: SoftPasskey, operation: LedgerOperation): Promise<Chain> {
  const last = ledgerLastIssuedAt(chain.ledger);
  const payload = nextTransition(await verifyLedger(chain.ledger, NOW), passkey.credentialId, operation, last + 1000, last);
  const record = await signed(passkey, payload);
  return { ledger: { genesis: chain.ledger.genesis, transitions: [...chain.ledger.transitions, record] }, accountId: chain.accountId, head: await ledgerHead(payload) };
}
async function rawPoint(key: CryptoKey): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}
async function newDevice(ownerId: string, label: string): Promise<LedgerDevice> {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const publicKey = await rawPoint(pair.publicKey);
  const endpoint: EndpointPublic = { version: 1, id: sha256(Buffer.from(publicKey, 'base64url')), ownerId, kind: 'browser', publicKey };
  const auth = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  return { endpoint, authPublicKey: await rawPoint(auth.publicKey), label, approvedAt: T0 };
}
/** A bridge's two key pairs, its pairing link, and its v2 identity file (unbound or bound). */
interface BridgeKeys { link: BridgePairLink; endpointId: string; authPublicKey: string; record(accountId: string | null): Promise<string> }
async function bridgeKeys(bridgeId: string): Promise<BridgeKeys> {
  const endpointPair = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const authPair = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const endpointPublicKey = await rawPoint(endpointPair.publicKey);
  const authPublicKey = await rawPoint(authPair.publicKey);
  const endpointId = sha256(Buffer.from(endpointPublicKey, 'base64url'));
  const link = createBridgePairRequest({ bridgeId, endpointPublicKey, authPublicKey, label: `Bridge ${bridgeId}`, now: T0 });
  return {
    link, endpointId, authPublicKey,
    async record(accountId) {
      const endpoint = accountId === null ? {} : { endpoint: { version: 1, id: endpointId, ownerId: accountId, kind: 'bridge', publicKey: endpointPublicKey } };
      return JSON.stringify({
        version: 2, ...endpoint, privateKey: await crypto.subtle.exportKey('jwk', endpointPair.privateKey), endpointPublicKey, authPublicKey,
        authPrivateKey: await crypto.subtle.exportKey('jwk', authPair.privateKey),
      });
    },
  };
}
const lastRecord = (chain: Chain): Signed<LedgerTransition> => chain.ledger.transitions[chain.ledger.transitions.length - 1];
const storeError = (code: string) => (error: unknown): boolean => error instanceof LedgerStoreError && error.code === code;

/** laptop: genesis + add_device(laptop). base: laptop + add_bridge(studio, from its pair request). A, B: base + add_device (tie at 3,
 *  no revocation). C: A + add_device (4). E: C + add_device (5). R: base + revoke_bridge studio (3). S: base + revoke_device laptop (3).
 *  X: another account whose ledger lists studio's public keys under bridgeId studio. */
interface Forest { laptop: Chain; base: Chain; A: Chain; B: Chain; C: Chain; E: Chain; R: Chain; S: Chain; X: Chain; laptopId: string; studio: BridgeKeys; kitchen: BridgeKeys }
async function forest(): Promise<Forest> {
  const passkey = await createSoftPasskey({ rpId, origin });
  const genesis = await start(passkey);
  const device = await newDevice(genesis.accountId, 'Laptop');
  const laptop = await append(genesis, passkey, { type: 'add_device', device });
  const studio = await bridgeKeys('studio');
  const kitchen = await bridgeKeys('kitchen');
  const base = await append(laptop, passkey, { type: 'add_bridge', bridge: await bridgeFromPairRequest(studio.link.request, laptop.accountId, T0) });
  const A = await append(base, passkey, { type: 'add_device', device: await newDevice(base.accountId, 'A') });
  const B = await append(base, passkey, { type: 'add_device', device: await newDevice(base.accountId, 'B') });
  const C = await append(A, passkey, { type: 'add_device', device: await newDevice(base.accountId, 'C') });
  const E = await append(C, passkey, { type: 'add_device', device: await newDevice(base.accountId, 'E') });
  const R = await append(base, passkey, { type: 'revoke_bridge', bridgeId: 'studio' });
  const S = await append(base, passkey, { type: 'revoke_device', endpointId: device.endpoint.id });
  const other = await createSoftPasskey({ rpId, origin });
  const otherGenesis = await start(other);
  const X = await append(otherGenesis, other, { type: 'add_bridge', bridge: await bridgeFromPairRequest(studio.link.request, otherGenesis.accountId, T0) });
  return { laptop, base, A, B, C, E, R, S, X, laptopId: device.endpoint.id, studio, kitchen };
}

describe('BridgeLedgerStore', () => {
  let f: Forest;
  let dataDir: string;
  let file: string;
  let identityFile: string;
  const store = (accountId?: string, now: () => number = () => NOW): BridgeLedgerStore => new BridgeLedgerStore(dataDir, { accountId, now });
  const approval = (chain: Chain) => ({ accountId: chain.accountId, head: chain.head });
  async function paired(chain: Chain): Promise<BridgeLedgerStore> {
    const trusted = await store().adoptPaired(f.studio.link, approval(chain), chain.ledger);
    assert.equal(trusted.head, chain.head);
    return store();
  }
  /** Writes a valid ledger.json directly (for chains that cannot be paired, such as one revoking the bridge). */
  async function seed(chain: Chain, sticky = ledgerRevocations(chain.ledger)): Promise<void> {
    mkdirSync(join(dataDir, 'security'), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, ledger: chain.ledger, checkpoint: await verifyLedger(chain.ledger, NOW), sticky, lastServerReadAt: null }));
  }
  async function writeIdentity(keys: BridgeKeys, accountId: string | null): Promise<void> {
    mkdirSync(join(dataDir, 'security'), { recursive: true });
    writeFileSync(identityFile, await keys.record(accountId));
  }
  const fileState = (): { text: string; ino: number } => ({ text: readFileSync(file, 'utf8'), ino: statSync(file).ino });

  before(async () => { f = await forest(); });
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ledger-store-'));
    file = join(dataDir, 'security', 'ledger.json');
    identityFile = join(dataDir, 'security', 'ledger-identity.json');
  });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('starts empty, and offer() never binds an empty store', async () => {
    const empty = store();
    assert.equal(await empty.read(), null);
    assert.equal(await empty.trusted(), null);
    assert.equal(await empty.ownBridgeStatus('studio', f.studio.authPublicKey), 'absent');
    assert.equal(await empty.ownBridgeRevoked('studio'), false);
    for (const source of ['relay', 'server'] as const) {
      for (const chain of [f.base, f.C, f.R]) assert.deepEqual(await empty.offer(chain.ledger, source), { decision: 'reject', state: null, discarded: [] });
    }
    assert.equal((await empty.offer(f.base.ledger, 'pairing' as 'server')).decision, 'reject');
    assert.equal(existsSync(file), false);
  });

  it('adoptPaired binds an empty store only after confirmPairedLedger', async () => {
    const trusted = await store().adoptPaired(f.studio.link, approval(f.base), f.base.ledger);
    assert.deepEqual(trusted, await verifyLedger(f.base.ledger, NOW));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const state = await store().read();
    assert.ok(state);
    assert.deepEqual(state.ledger, f.base.ledger);
    assert.deepEqual(state.checkpoint, trusted);
    assert.deepEqual(state.sticky, { deviceIds: [], bridgeIds: [] });
    assert.equal(state.lastServerReadAt, null);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))), ['version', 'ledger', 'checkpoint', 'sticky', 'lastServerReadAt']);
    assert.equal(await store().ownBridgeStatus('studio', f.studio.authPublicKey), 'active');
    // A later approval head on a grown chain also pairs (fresh store).
    rmSync(file);
    assert.equal((await store().adoptPaired(f.studio.link, approval(f.C), f.C.ledger)).head, f.C.head);
  });

  it('adoptPaired rejects every unconfirmed pairing and writes nothing', async () => {
    const cases: [string, BridgePairLink, { accountId: string; head: string }, unknown][] = [
      ['approval of another account', f.studio.link, approval(f.X), f.base.ledger],
      ['approved head not in the chain', f.studio.link, { accountId: f.base.accountId, head: f.X.head }, f.base.ledger],
      ['approved before the add_bridge', f.studio.link, approval(f.laptop), f.base.ledger],
      ['another request', f.kitchen.link, approval(f.base), f.base.ledger],
      ['bridge revoked in the chain', f.studio.link, approval(f.base), f.R.ledger],
      ['chain without the bridge', f.studio.link, approval(f.laptop), f.laptop.ledger],
      ['malformed ledger', f.studio.link, approval(f.base), { genesis: f.base.ledger.genesis }],
    ];
    for (const [name, link, approved, ledger] of cases) {
      await assert.rejects(store().adoptPaired(link, approved, ledger), storeError('ledger_store_pairing_rejected'), name);
      assert.equal(existsSync(file), false, name);
    }
    // Pinned to an account: a valid pairing of another account (X lists studio's keys) is refused.
    await assert.rejects(store(f.base.accountId).adoptPaired(f.studio.link, approval(f.X), f.X.ledger), storeError('ledger_store_pairing_rejected'));
    assert.equal(existsSync(file), false);
    // Bound store whose sticky set revoked studio (seen on a losing fork): re-pairing that bridge is refused.
    await seed(f.C, { deviceIds: [], bridgeIds: ['studio'] });
    const written = fileState();
    await assert.rejects(store().adoptPaired(f.studio.link, approval(f.C), f.C.ledger), storeError('ledger_store_pairing_rejected'));
    await assert.rejects(store().adoptPaired(f.studio.link, approval(f.X), f.X.ledger), storeError('ledger_store_pairing_rejected'));
    assert.deepEqual(fileState(), written);
  });

  it('adopts an extension and keeps an equal or shorter chain without writing', async () => {
    const replica = await paired(f.base);
    const adopted = await replica.offer(f.C.ledger, 'relay');
    assert.equal(adopted.decision, 'adopt');
    assert.equal(adopted.state?.checkpoint.head, f.C.head);
    assert.equal(adopted.state?.checkpoint.revision, 4);
    assert.deepEqual(adopted.discarded, []);
    const written = fileState();
    for (const chain of [f.C, f.A, f.base]) {
      const kept = await replica.offer(chain.ledger, 'server');
      assert.equal(kept.decision, 'keep');
      assert.equal(kept.state?.checkpoint.head, f.C.head);
    }
    assert.deepEqual(fileState(), written);
    assert.equal((await store().read())?.checkpoint.head, f.C.head);
  });

  it('follows the fork order: longer, then more revocations, then the smaller head', async () => {
    const replica = await paired(f.A);
    const tie = await replica.offer(f.B.ledger, 'relay');
    assert.equal(tie.decision, f.B.head < f.A.head ? 'adopt' : 'keep');
    const winner = f.B.head < f.A.head ? f.B : f.A;
    assert.deepEqual(tie.discarded, tie.decision === 'adopt' ? [lastRecord(f.A)] : []);
    assert.equal(tie.state?.checkpoint.head, winner.head);

    const revoking = await replica.offer(f.R.ledger, 'relay');
    assert.equal(revoking.decision, 'adopt');
    assert.deepEqual(revoking.discarded, [lastRecord(winner)]);
    assert.equal(revoking.state?.checkpoint.head, f.R.head);
    assert.equal((await replica.offer(f.B.ledger, 'relay')).decision, 'keep');

    const longer = await replica.offer(f.C.ledger, 'relay');
    assert.equal(longer.decision, 'adopt');
    assert.deepEqual(longer.discarded, [lastRecord(f.R)]);
    const state = await store().read();
    assert.ok(state);
    assert.equal(state.checkpoint.head, f.C.head);
    // The adopted chain still lists studio; the revocation seen on the discarded branch stays sticky.
    assert.ok(state.checkpoint.bridges.some(bridge => bridge.bridgeId === 'studio'));
    assert.deepEqual(state.sticky, { deviceIds: [], bridgeIds: ['studio'] });
    assert.ok(!state.trusted.bridges.some(bridge => bridge.bridgeId === 'studio'));
    assert.ok(state.trusted.revokedBridgeIds.includes('studio'));
    assert.equal(await replica.ownBridgeRevoked('studio'), true);
    assert.equal(await replica.ownBridgeStatus('studio', f.studio.authPublicKey), 'revoked');
  });

  it('makes the revocations of a losing chain sticky, in trusted() and across a restart', async () => {
    const replica = await paired(f.C);
    assert.equal(await replica.ownBridgeRevoked('studio'), false);
    const kept = await replica.offer(f.R.ledger, 'relay');
    assert.equal(kept.decision, 'keep');
    assert.deepEqual(kept.discarded, []);
    assert.equal(kept.state?.checkpoint.head, f.C.head);
    assert.deepEqual(kept.state?.sticky, { deviceIds: [], bridgeIds: ['studio'] });
    assert.equal(await replica.ownBridgeRevoked('studio'), true);
    assert.equal((await replica.offer(f.S.ledger, 'server')).decision, 'keep');

    const restarted = store();
    const state = await restarted.read();
    assert.ok(state);
    assert.equal(state.checkpoint.head, f.C.head);
    assert.ok(state.checkpoint.bridges.some(bridge => bridge.bridgeId === 'studio'));
    assert.ok(state.checkpoint.devices.some(device => device.endpoint.id === f.laptopId));
    assert.deepEqual(state.sticky, { deviceIds: [f.laptopId], bridgeIds: ['studio'] });
    const trusted = await restarted.trusted();
    assert.ok(trusted);
    assert.deepEqual(trusted, state.trusted);
    assert.ok(!trusted.bridges.some(bridge => bridge.bridgeId === 'studio'));
    assert.ok(!trusted.devices.some(device => device.endpoint.id === f.laptopId));
    assert.deepEqual(trusted.revokedBridgeIds, ['studio']);
    assert.deepEqual(trusted.revokedDeviceIds, [f.laptopId]);
    assert.equal(await restarted.ownBridgeRevoked('studio'), true);
    assert.equal(await restarted.ownBridgeStatus('studio', f.studio.authPublicKey), 'revoked');
    assert.equal(await restarted.ownBridgeRevoked('kitchen'), false);

    // An extension adopted on top of sticky ids keeps the raw checkpoint of the chain itself, and reloads as valid.
    assert.equal((await restarted.offer(f.E.ledger, 'relay')).decision, 'adopt');
    const extended = await store().read();
    assert.ok(extended);
    assert.deepEqual(extended.checkpoint, await verifyLedger(f.E.ledger, NOW));
    assert.deepEqual(extended.sticky, { deviceIds: [f.laptopId], bridgeIds: ['studio'] });
    assert.ok(!extended.trusted.bridges.some(bridge => bridge.bridgeId === 'studio'));
    assert.equal(await store().ownBridgeRevoked('studio'), true);
  });

  it('reports the own bridge as active, revoked or absent', async () => {
    const replica = await paired(f.base);
    assert.equal(await replica.ownBridgeStatus('studio', f.studio.authPublicKey), 'active');
    assert.equal(await replica.ownBridgeStatus('studio', f.kitchen.authPublicKey), 'absent');
    assert.equal(await replica.ownBridgeStatus('kitchen', f.kitchen.authPublicKey), 'absent');
    assert.equal(await replica.ownBridgeRevoked('studio'), false);
    assert.equal((await replica.offer(f.R.ledger, 'relay')).decision, 'adopt');
    assert.equal(await replica.ownBridgeStatus('studio', f.studio.authPublicKey), 'revoked');
    assert.equal(await replica.ownBridgeStatus('studio', f.kitchen.authPublicKey), 'revoked');
    assert.equal(await replica.ownBridgeRevoked('studio'), true);
  });

  it('rejects another account once bound, by a stored ledger or by the identity binding', async () => {
    const replica = await paired(f.base);
    const written = fileState();
    for (const source of ['relay', 'server'] as const) {
      const result = await replica.offer(f.X.ledger, source);
      assert.equal(result.decision, 'reject');
      assert.equal(result.state?.checkpoint.head, f.base.head);
    }
    await assert.rejects(replica.adoptPaired(f.studio.link, approval(f.X), f.X.ledger), storeError('ledger_store_pairing_rejected'));
    assert.deepEqual(fileState(), written);
    await assert.rejects(store(f.X.accountId).read(), storeError('ledger_store_wrong_account'));
    await assert.rejects(store(f.X.accountId).offer(f.base.ledger, 'relay'), storeError('ledger_store_wrong_account'));
    assert.throws(() => store('solo:studio'), (error: unknown) => error instanceof BridgeSecurityError && error.code === 'wrong_context');
  });

  it('adoptBound accepts only the bound account with this bridge listed, and writes nothing otherwise', async () => {
    const rejectedBound = storeError('ledger_store_bound_rejected');
    await assert.rejects(store().adoptBound(f.C.ledger), rejectedBound);
    await writeIdentity(f.studio, null);
    await assert.rejects(store().adoptBound(f.C.ledger), rejectedBound);
    await writeIdentity(f.studio, f.base.accountId);
    // X lists studio's public keys, but is another account: a server cannot rebind the bridge with it.
    for (const ledger of [f.X.ledger, f.laptop.ledger, f.R.ledger, { genesis: f.C.ledger.genesis }]) {
      await assert.rejects(store().adoptBound(ledger), rejectedBound);
      assert.equal(existsSync(file), false);
    }
    await writeIdentity(f.kitchen, f.base.accountId);
    await assert.rejects(store().adoptBound(f.C.ledger), rejectedBound);
    assert.equal(existsSync(file), false);

    await writeIdentity(f.studio, f.base.accountId);
    const trusted = await store().adoptBound(f.C.ledger);
    assert.equal(trusted.head, f.C.head);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(await store().ownBridgeStatus('studio', f.studio.authPublicKey), 'active');
    // Once bound, an extension is admitted under the same rules, and another account still is not.
    assert.equal((await store().adoptBound(f.E.ledger)).head, f.E.head);
    await assert.rejects(store().adoptBound(f.X.ledger), rejectedBound);
    assert.equal((await store().read())?.checkpoint.head, f.E.head);
  });

  it('reconciles the identity and the store at startup', async () => {
    assert.equal(await reconcileIdentityAndStore(dataDir), 'unpaired');
    await writeIdentity(f.studio, null);
    assert.equal(await reconcileIdentityAndStore(dataDir), 'unpaired');

    // Paired but crashed before binding: the store lists this bridge's keys, so the identity is bound to its account.
    await seed(f.C);
    assert.equal(await reconcileIdentityAndStore(dataDir), 'ok');
    assert.equal((await readLedgerIdentity(dataDir))?.accountId, f.C.accountId);
    assert.equal((await store().read())?.checkpoint.head, f.C.head);
    assert.equal(await reconcileIdentityAndStore(dataDir), 'ok');

    // Bound identity, lost store: never unbound; the wiring fetches the ledger and calls adoptBound.
    rmSync(file);
    const bound = readFileSync(identityFile, 'utf8');
    assert.equal(await reconcileIdentityAndStore(dataDir), 'needs_ledger');
    assert.equal(readFileSync(identityFile, 'utf8'), bound);
    await store().adoptBound(f.C.ledger);
    assert.equal(await reconcileIdentityAndStore(dataDir), 'ok');

    // Bound identity, store of another account: an error, nothing changed.
    await seed(f.X);
    const foreign = fileState();
    await assert.rejects(reconcileIdentityAndStore(dataDir), storeError('ledger_store_wrong_account'));
    assert.deepEqual(fileState(), foreign);
    assert.equal(readFileSync(identityFile, 'utf8'), bound);

    // Unbound identity whose keys are not trusted by the stored chain (revoked): the stale ledger is deleted.
    await writeIdentity(f.studio, null);
    const unbound = readFileSync(identityFile, 'utf8');
    await seed(f.R);
    assert.equal(await reconcileIdentityAndStore(dataDir), 'unpaired');
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(identityFile, 'utf8'), unbound);
    await seed(f.C, { deviceIds: [], bridgeIds: ['studio'] });
    assert.equal(await reconcileIdentityAndStore(dataDir), 'unpaired');
    assert.equal(existsSync(file), false);
    await writeIdentity(f.kitchen, null);
    await seed(f.C);
    assert.equal(await reconcileIdentityAndStore(dataDir), 'unpaired');
    assert.equal(existsSync(file), false);

    // No identity at all: a stored ledger cannot be this bridge's.
    rmSync(identityFile);
    await seed(f.C);
    assert.equal(await reconcileIdentityAndStore(dataDir), 'unpaired');
    assert.equal(existsSync(file), false);

    // Corrupted store: thrown, never reset.
    await writeIdentity(f.studio, null);
    mkdirSync(join(dataDir, 'security'), { recursive: true });
    writeFileSync(file, '{"version":1,');
    await assert.rejects(reconcileIdentityAndStore(dataDir), storeError('ledger_store_corrupt'));
    assert.equal(readFileSync(file, 'utf8'), '{"version":1,');
  });

  it('throws a typed error for a corrupted file and never resets it', async () => {
    await seed(f.R);
    assert.equal((await store().read())?.checkpoint.head, f.R.head);
    const valid = JSON.parse(readFileSync(file, 'utf8'));
    const flip = (text: string): string => `${text[0] === 'A' ? 'B' : 'A'}${text.slice(1)}`;
    const corruptions: unknown[] = [
      '{"version":1,',
      '[]',
      { ...valid, version: 2 },
      { ...valid, extra: true },
      { ...valid, lastServerReadAt: -1 },
      { ...valid, checkpoint: { ...valid.checkpoint, devices: [] } },
      { ...valid, checkpoint: { ...valid.checkpoint, revokedBridgeIds: [] } },
      { ...valid, checkpoint: await verifyLedger(f.base.ledger, NOW) },
      { ...valid, ledger: f.base.ledger },
      { ...valid, ledger: { ...valid.ledger, genesis: { ...valid.ledger.genesis, signature: { ...valid.ledger.genesis.signature, signature: flip(valid.ledger.genesis.signature.signature) } } } },
      { ...valid, sticky: { deviceIds: [], bridgeIds: [] } },
      { ...valid, sticky: { deviceIds: [], bridgeIds: ['studio', 'studio'] } },
      { ...valid, sticky: { deviceIds: ['not-a-fingerprint'], bridgeIds: ['studio'] } },
      { ...valid, sticky: { bridgeIds: ['studio'] } },
    ];
    for (const corruption of corruptions) {
      writeFileSync(file, typeof corruption === 'string' ? corruption : JSON.stringify(corruption));
      const written = fileState();
      const replica = store();
      await assert.rejects(replica.read(), storeError('ledger_store_corrupt'), written.text.slice(0, 60));
      await assert.rejects(replica.trusted(), storeError('ledger_store_corrupt'));
      await assert.rejects(replica.ownBridgeStatus('studio', f.studio.authPublicKey), storeError('ledger_store_corrupt'));
      await assert.rejects(replica.offer(f.C.ledger, 'relay'), storeError('ledger_store_corrupt'));
      await assert.rejects(replica.adoptPaired(f.studio.link, approval(f.C), f.C.ledger), storeError('ledger_store_corrupt'));
      await assert.rejects(replica.markServerRead(NOW), storeError('ledger_store_corrupt'));
      assert.deepEqual(fileState(), written);
    }
  });

  it('serializes concurrent offers, also across store instances', async () => {
    const replica = await paired(f.C);
    const results = await Promise.all([replica.offer(f.R.ledger, 'relay'), store().offer(f.S.ledger, 'relay')]);
    assert.deepEqual(results.map(result => result.decision), ['keep', 'keep']);
    assert.deepEqual((await store().read())?.sticky, { deviceIds: [f.laptopId], bridgeIds: ['studio'] });

    rmSync(file);
    const fresh = await paired(f.base);
    const raced = await Promise.all([fresh.offer(f.C.ledger, 'relay'), fresh.offer(f.A.ledger, 'relay')]);
    assert.deepEqual(raced.map(result => result.decision), ['adopt', 'keep']);
    assert.equal((await store().read())?.checkpoint.head, f.C.head);
  });

  it('records the last server read, keeps it across adoption, and ignores it while empty', async () => {
    await store().markServerRead(NOW);
    assert.equal(existsSync(file), false);
    const replica = await paired(f.base);
    await replica.markServerRead(NOW - 5);
    assert.equal((await store().read())?.lastServerReadAt, NOW - 5);
    assert.equal((await replica.offer(f.C.ledger, 'server')).decision, 'adopt');
    assert.equal((await store().read())?.lastServerReadAt, NOW - 5);
    await assert.rejects(replica.markServerRead(-1), TypeError);
    await assert.rejects(replica.markServerRead(1.5), TypeError);
  });

  it('still loads an accepted chain after the clock moved back', async () => {
    await paired(f.C);
    const behind = store(undefined, () => T0 - 86400000);
    assert.equal((await behind.read())?.checkpoint.head, f.C.head);
    assert.equal((await behind.offer(f.A.ledger, 'relay')).decision, 'keep');
    assert.equal(await behind.ownBridgeRevoked('studio'), false);
  });

  it('removes its own stale temporaries on the first load and leaves every other file alone', async () => {
    await seed(f.base);
    const security = join(dataDir, 'security');
    const own = join(security, `ledger.json.${randomUUID()}.tmp`);
    const others = [`ledger-identity.json.${randomUUID()}.tmp`, `policy.json.${randomUUID()}.tmp`, 'ledger.json.tmp', `ledger.json.${randomUUID()}.bak`];
    writeFileSync(own, 'partial');
    for (const name of others) writeFileSync(join(security, name), 'other');
    assert.equal((await store().read())?.checkpoint.head, f.base.head);
    assert.equal(existsSync(own), false);
    for (const name of others) assert.equal(existsSync(join(security, name)), true, name);
  });
});
