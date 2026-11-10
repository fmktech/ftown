import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import type { EndpointPublic } from '../protocol.js';
import {
  accountIdOf, ledgerChallenge, ledgerHead, ledgerLastIssuedAt, ledgerRevocations, nextTransition, resolutionPlan, resolveForkTransition, verifyLedger,
} from '../ledger/ledger.js';
import { bridgeFromPairRequest, createBridgePairRequest } from '../ledger/pairing.js';
import type { BridgePairLink } from '../ledger/pairing.js';
import type { Ledger, LedgerDevice, LedgerGenesis, LedgerOperation, LedgerTransition, Signed } from '../ledger/protocol.js';
import { createSoftPasskey } from '../ledger/testing.js';
import type { SoftPasskey } from '../ledger/testing.js';
import { BridgeSecurityError } from './errors.js';
import { readLedgerIdentity } from './ledger-identity.js';
import { BridgeLedgerStore, DIVERGENCE_LAST_SEEN_RESOLUTION_MS, INVALID_CHAIN_LOG_SPACING_MS, LedgerStoreError, reconcileIdentityAndStore } from './ledger-store.js';
import type { LedgerSource } from './ledger-store.js';

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
/** The owner's choice through the production builders: `chosen`, plus the removals/passkeys it must carry from `other`, plus a resolve_fork
 *  discarding `other`, each signed by `passkey`. */
async function resolve(chosen: Chain, other: Chain, passkey: SoftPasskey): Promise<Chain> {
  let chain = chosen;
  for (const operation of (await resolutionPlan(chosen.ledger, other.ledger)).carry) chain = await append(chain, passkey, operation);
  const last = ledgerLastIssuedAt(chain.ledger);
  const payload = await resolveForkTransition(chain.ledger, other.ledger, passkey.credentialId, last + 1000);
  return { ledger: { genesis: chain.ledger.genesis, transitions: [...chain.ledger.transitions, await signed(passkey, payload)] }, accountId: chain.accountId, head: await ledgerHead(payload) };
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

/** laptop: genesis + add_device(laptop). base: laptop + add_bridge(studio, from its pair request). A, B: base + add_device (two histories
 *  that diverge at revision 3, no revocation). C: A + add_device (4). E: C + add_device (5). R: base + revoke_bridge studio (3).
 *  S: base + revoke_device laptop (3). D: laptop + add_device (2): a history without studio. RC: C + revoke_bridge studio (5, ahead of C).
 *  X: another account whose ledger lists studio's public keys under bridgeId studio. `passkey` is the account's authority. */
interface Forest {
  laptop: Chain; base: Chain; A: Chain; B: Chain; C: Chain; E: Chain; R: Chain; S: Chain; D: Chain; RC: Chain; X: Chain; laptopId: string;
  studio: BridgeKeys; kitchen: BridgeKeys; passkey: SoftPasskey;
}
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
  const D = await append(laptop, passkey, { type: 'add_device', device: await newDevice(base.accountId, 'D') });
  const RC = await append(C, passkey, { type: 'revoke_bridge', bridgeId: 'studio' });
  const other = await createSoftPasskey({ rpId, origin });
  const otherGenesis = await start(other);
  const X = await append(otherGenesis, other, { type: 'add_bridge', bridge: await bridgeFromPairRequest(studio.link.request, otherGenesis.accountId, T0) });
  return { laptop, base, A, B, C, E, R, S, D, RC, X, laptopId: device.endpoint.id, studio, kitchen, passkey };
}

describe('BridgeLedgerStore', () => {
  let f: Forest;
  let dataDir: string;
  let file: string;
  let identityFile: string;
  let lines: string[];
  const store = (accountId?: string, now: () => number = () => NOW): BridgeLedgerStore => new BridgeLedgerStore(dataDir, { accountId, now, log: line => lines.push(line) });
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
    lines = [];
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
    for (const source of ['relay', 'server'] as const) {
      for (const chain of [f.base, f.C, f.R]) assert.deepEqual(await empty.offer(chain.ledger, source), { decision: 'reject', relation: null, candidate: null, state: null, discarded: [] });
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
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))), ['version', 'ledger', 'checkpoint', 'sticky', 'lastServerReadAt', 'divergences']);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2);
    assert.deepEqual(state.divergences, []);
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
    // Bound store whose sticky set revokes studio (an earlier adopted chain removed it): re-pairing that bridge id is refused as revoked.
    await seed(f.C, { deviceIds: [], bridgeIds: ['studio'] });
    const written = fileState();
    await assert.rejects(store().adoptPaired(f.studio.link, approval(f.C), f.C.ledger), storeError('ledger_store_pairing_revoked'));
    await assert.rejects(store().adoptPaired(f.studio.link, approval(f.X), f.X.ledger), storeError('ledger_store_pairing_rejected'));
    assert.deepEqual(fileState(), written);
  });

  it('adopt/ahead: adopts an extension; keep/same and keep/behind change nothing and write nothing', async () => {
    const replica = await paired(f.base);
    const adopted = await replica.offer(f.C.ledger, 'relay');
    assert.equal(adopted.decision, 'adopt');
    assert.equal(adopted.relation, 'ahead');
    assert.deepEqual(adopted.candidate, { revision: 4, head: f.C.head });
    assert.equal(adopted.state?.checkpoint.head, f.C.head);
    assert.equal(adopted.state?.checkpoint.revision, 4);
    assert.deepEqual(adopted.discarded, []);
    const written = fileState();
    for (const [chain, relation] of [[f.C, 'same'], [f.A, 'behind'], [f.base, 'behind']] as const) {
      const kept = await replica.offer(chain.ledger, 'server');
      assert.equal(kept.decision, 'keep');
      assert.equal(kept.relation, relation);
      assert.equal(kept.candidate?.head, chain.head);
      assert.equal(kept.state?.checkpoint.head, f.C.head);
    }
    assert.deepEqual(fileState(), written);
    assert.equal((await store().read())?.checkpoint.head, f.C.head);
    assert.deepEqual(lines, []);
  });

  it('keep/diverged: a valid other history is refused, recorded per source, logged once, and changes no trust', async () => {
    const replica = await paired(f.A);
    const before = await store().read();
    assert.ok(before);
    const refused = await replica.offer(f.B.ledger, 'relay');
    assert.equal(refused.decision, 'keep');
    assert.equal(refused.relation, 'diverged');
    assert.deepEqual(refused.discarded, []);
    assert.equal(refused.state?.checkpoint.head, f.A.head);
    assert.deepEqual(refused.state?.divergences, [{ source: 'relay', otherHead: f.B.head, otherRevision: 3, firstSeen: NOW, lastSeen: NOW }]);
    assert.deepEqual(lines, [`[ledger] REFUSED a different account history from relay (head ${f.B.head.slice(0, 8)}, revision 3); keeping ours (head ${f.A.head.slice(0, 8)}, revision 3)`]);
    const after = await store().read();
    assert.ok(after);
    assert.deepEqual(after.ledger, before.ledger);
    assert.deepEqual(after.checkpoint, before.checkpoint);
    assert.deepEqual(after.trusted, before.trusted);
    assert.deepEqual(after.sticky, { deviceIds: [], bridgeIds: [] });
    // The same head again, from either source: no second line. The server gets its own entry.
    assert.equal((await replica.offer(f.B.ledger, 'relay')).relation, 'diverged');
    assert.equal((await replica.offer(f.B.ledger, 'server')).relation, 'diverged');
    assert.equal(lines.length, 1);
    assert.deepEqual((await store().read())?.divergences.map(entry => entry.source), ['server', 'relay']);
  });

  it('a LONGER diverged chain from the server is never adopted and our trusted members are unchanged', async () => {
    const replica = await paired(f.B);
    const before = await store().read();
    assert.ok(before);
    // E (A, C, E: revision 5) is longer than B (revision 3) and valid, but it is not an extension of B.
    const result = await replica.offer(f.E.ledger, 'server');
    assert.equal(result.decision, 'keep');
    assert.equal(result.relation, 'diverged');
    const after = await store().read();
    assert.ok(after);
    assert.equal(after.checkpoint.head, f.B.head);
    assert.deepEqual(after.trusted.devices, before.trusted.devices);
    assert.deepEqual(after.trusted.bridges, before.trusted.bridges);
    assert.deepEqual(after.sticky, before.sticky);
    assert.equal(await replica.ownBridgeStatus('studio', f.studio.authPublicKey), 'active');
    assert.deepEqual(after.divergences, [{ source: 'server', otherHead: f.E.head, otherRevision: 5, firstSeen: NOW, lastSeen: NOW }]);
  });

  it('a diverged chain that removes this bridge or a device is not evidence: nothing becomes sticky and nobody is removed', async () => {
    const replica = await paired(f.C);
    for (const [chain, source] of [[f.R, 'server'], [f.S, 'relay']] as const) {
      const result = await replica.offer(chain.ledger, source);
      assert.deepEqual([result.decision, result.relation], ['keep', 'diverged']);
    }
    const state = await store().read();
    assert.ok(state);
    assert.deepEqual(state.sticky, { deviceIds: [], bridgeIds: [] });
    assert.equal(await replica.ownBridgeStatus('studio', f.studio.authPublicKey), 'active');
    assert.ok(state.trusted.devices.some(device => device.endpoint.id === f.laptopId));
    // Across a restart too.
    assert.equal(await store().ownBridgeStatus('studio', f.studio.authPublicKey), 'active');
    // The same removal on a chain AHEAD of ours is evidence.
    const ahead = await replica.offer(f.RC.ledger, 'server');
    assert.deepEqual([ahead.decision, ahead.relation], ['adopt', 'ahead']);
    assert.equal(await replica.ownBridgeStatus('studio', f.studio.authPublicKey), 'revoked');
    assert.deepEqual((await store().read())?.sticky, { deviceIds: [], bridgeIds: ['studio'] });
  });

  it('adopt/diverged: an owner-chosen history replaces ours, our removals stay enforced, and every divergence is cleared', async () => {
    // Ours: S (base + revoke laptop). The owner chose A (base + add_device A) over it, carrying S's removal of laptop.
    await seed(f.S);
    const replica = store();
    assert.equal((await replica.offer(f.A.ledger, 'server')).relation, 'diverged');
    assert.equal((await replica.offer(f.B.ledger, 'relay')).relation, 'diverged');
    assert.equal((await store().read())?.divergences.length, 2);
    lines.length = 0;
    const chosen = await resolve(f.A, f.S, f.passkey);
    const result = await replica.offer(chosen.ledger, 'relay');
    assert.equal(result.decision, 'adopt');
    assert.equal(result.relation, 'diverged');
    assert.deepEqual(result.discarded, [lastRecord(f.S)]);
    assert.deepEqual(lines, ['[ledger] adopted an owner-chosen history: fork at revision 2, discarded 1 of our records']);
    const state = await store().read();
    assert.ok(state);
    assert.equal(state.checkpoint.head, chosen.head);
    assert.deepEqual(state.divergences, []);
    // The stored chain is ours up to the fork, byte for byte, then the chosen records; the removal of laptop is still enforced.
    assert.deepEqual(state.ledger.transitions.slice(0, 2), f.S.ledger.transitions.slice(0, 2));
    assert.deepEqual(state.ledger.transitions.slice(2), chosen.ledger.transitions.slice(2));
    assert.ok(state.checkpoint.revokedDeviceIds.includes(f.laptopId));
    assert.deepEqual(state.sticky, { deviceIds: [f.laptopId], bridgeIds: [] });
    assert.ok(!state.trusted.devices.some(device => device.endpoint.id === f.laptopId));
    assert.equal(await replica.ownBridgeStatus('studio', f.studio.authPublicKey), 'active');
    // From now on the old history is the diverged one, and it is refused like any other.
    const old = await replica.offer(f.S.ledger, 'server');
    assert.deepEqual([old.decision, old.relation], ['keep', 'diverged']);
    assert.deepEqual((await store().read())?.sticky, { deviceIds: [f.laptopId], bridgeIds: [] });
  });

  it('an owner-chosen history that never listed this bridge leaves it absent, not revoked', async () => {
    const replica = await paired(f.base);
    const chosen = await resolve(f.D, f.base, f.passkey);
    const result = await replica.offer(chosen.ledger, 'server');
    assert.deepEqual([result.decision, result.relation], ['adopt', 'diverged']);
    assert.equal(await replica.ownBridgeStatus('studio', f.studio.authPublicKey), 'absent');
    assert.deepEqual((await store().read())?.sticky, { deviceIds: [], bridgeIds: [] });
  });

  it('a resolve_fork that does not apply to our chain is refused like any other divergence', async () => {
    // B + resolve(B over A) discards A; a replica holding C (A + one more) still matches (ancestor rule) ...
    const chosen = await resolve(f.B, f.A, f.passkey);
    const onC = await paired(f.C);
    assert.deepEqual([(await onC.offer(chosen.ledger, 'relay')).decision], ['adopt']);
    // ... but one holding S (another branch from the same fork point) is not the history it discarded.
    rmSync(file);
    await seed(f.S);
    const onS = store();
    const refused = await onS.offer(chosen.ledger, 'relay');
    assert.deepEqual([refused.decision, refused.relation], ['keep', 'diverged']);
    assert.equal((await store().read())?.checkpoint.head, f.S.head);
  });

  it('reject: an invalid chain is ignored and logged at most once per 60 s per source', async () => {
    let now = NOW;
    await paired(f.base);
    const replica = store(undefined, () => now);
    const last = lastRecord(f.C);
    const forged = { genesis: f.C.ledger.genesis, transitions: [...f.A.ledger.transitions, { payload: last.payload, signature: f.A.ledger.transitions[0].signature }] };
    const written = fileState();
    for (const candidate of [forged, { genesis: f.base.ledger.genesis }, f.X.ledger, 'garbage']) {
      assert.equal((await replica.offer(candidate, 'relay')).decision, 'reject');
    }
    assert.equal((await replica.offer(forged, 'relay')).relation, 'ahead');
    assert.deepEqual(lines, ['[ledger] ignored an invalid chain from relay']);
    assert.equal((await replica.offer(forged, 'server')).decision, 'reject');
    assert.deepEqual(lines, ['[ledger] ignored an invalid chain from relay', '[ledger] ignored an invalid chain from server']);
    now += INVALID_CHAIN_LOG_SPACING_MS - 1;
    await replica.offer(forged, 'relay');
    assert.equal(lines.length, 2);
    now += 1;
    await replica.offer(forged, 'relay');
    assert.equal(lines.length, 3);
    assert.deepEqual(fileState(), written);
  });

  it('the divergence survives a restart, is logged once per head, refreshes lastSeen sparingly, and is cleared when histories agree', async () => {
    let now = NOW;
    const at = () => now;
    await paired(f.A);
    assert.equal((await store(undefined, at).offer(f.B.ledger, 'server')).relation, 'diverged');
    assert.equal(lines.length, 1);
    // A restart remembers both the entry and that its head was logged.
    now += 1000;
    const restarted = store(undefined, at);
    assert.equal((await restarted.offer(f.B.ledger, 'server')).relation, 'diverged');
    assert.equal(lines.length, 1);
    const unchanged = fileState();
    now += DIVERGENCE_LAST_SEEN_RESOLUTION_MS - 1000;
    await restarted.offer(f.B.ledger, 'server');
    assert.deepEqual((await store().read())?.divergences, [{ source: 'server', otherHead: f.B.head, otherRevision: 3, firstSeen: NOW, lastSeen: now }]);
    assert.notDeepEqual(fileState(), unchanged);
    // Another head from the same source: one more line, the same entry moves on and keeps firstSeen.
    const B3 = await append(await append(f.B, f.passkey, { type: 'add_device', device: await newDevice(f.B.accountId, 'B2') }), f.passkey, { type: 'add_device', device: await newDevice(f.B.accountId, 'B3') });
    now += 1;
    await restarted.offer(B3.ledger, 'server');
    assert.equal(lines.length, 2);
    assert.deepEqual((await store().read())?.divergences, [{ source: 'server', otherHead: B3.head, otherRevision: 5, firstSeen: NOW, lastSeen: now }]);
    // The relay agreeing with us clears nothing of the server's entry.
    assert.equal((await restarted.offer(f.A.ledger, 'relay')).relation, 'same');
    assert.equal((await store().read())?.divergences.length, 1);
    // The server agreeing again (same, behind, or ahead) clears its entry.
    for (const [chain, relation, decision] of [[f.A, 'same', 'keep'], [f.base, 'behind', 'keep'], [f.C, 'ahead', 'adopt']] as const) {
      assert.equal((await restarted.offer(B3.ledger, 'server')).relation, 'diverged');
      assert.equal((await store().read())?.divergences.length, 1, relation);
      const agreed = await restarted.offer(chain.ledger, 'server');
      assert.deepEqual([agreed.decision, agreed.relation], [decision, relation]);
      assert.deepEqual(agreed.state?.divergences, [], relation);
      assert.deepEqual((await store().read())?.divergences, [], relation);
    }
    assert.equal(lines.length, 4, 'B3 is logged again once its entry was cleared');
  });

  it('reports the own bridge as active, revoked or absent', async () => {
    const replica = await paired(f.base);
    assert.equal(await replica.ownBridgeStatus('studio', f.studio.authPublicKey), 'active');
    assert.equal(await replica.ownBridgeStatus('studio', f.kitchen.authPublicKey), 'absent');
    assert.equal(await replica.ownBridgeStatus('kitchen', f.kitchen.authPublicKey), 'absent');
    assert.equal((await replica.offer(f.R.ledger, 'relay')).decision, 'adopt');
    assert.equal(await replica.ownBridgeStatus('studio', f.studio.authPublicKey), 'revoked');
    // The chain added studio with studio's key, not kitchen's: for a bridge with other keys it is no removal.
    assert.equal(await replica.ownBridgeStatus('studio', f.kitchen.authPublicKey), 'absent');
  });

  it('a tombstone (revoke_bridge of an id never added with our keys) is not a removal: absent, never revoked', async () => {
    // laptop + revoke_bridge studio: studio was never a member of this chain (valid since C1b).
    const T = await append(f.laptop, f.passkey, { type: 'revoke_bridge', bridgeId: 'studio' });
    await seed(T);
    assert.equal(await store().ownBridgeStatus('studio', f.studio.authPublicKey), 'absent');
    // An extension that adds studio cannot exist (a revoked id is never added again), and pairing that id fails as revoked, writing nothing.
    rmSync(file);
    await assert.rejects(store().adoptPaired(f.studio.link, approval(T), T.ledger), storeError('ledger_store_pairing_revoked'));
    assert.equal(existsSync(file), false);
    // The removal of a member right after its approval is reported the same way (the id can never come back).
    await assert.rejects(store().adoptPaired(f.studio.link, approval(f.base), f.R.ledger), storeError('ledger_store_pairing_revoked'));
    // Only a chain that verifies may say so: a forged revocation is a plain rejection.
    const last = lastRecord(f.R);
    const forged = { genesis: f.R.ledger.genesis, transitions: [...f.base.ledger.transitions, { payload: last.payload, signature: f.base.ledger.transitions[0].signature }] };
    await assert.rejects(store().adoptPaired(f.studio.link, approval(f.base), forged), storeError('ledger_store_pairing_rejected'));
    assert.equal(existsSync(file), false);
  });

  it('adopt/ahead stores our own prefix byte for byte, whatever signature bytes the candidate carries for it', async () => {
    const replica = await paired(f.base);
    const ours = (await store().read())!.ledger;
    // The server re-encodes the shared prefix: record 1 re-signed (valid, other bytes), record 2 with another record's signature.
    const resigned = { ...f.C.ledger.transitions[0], signature: await f.passkey.sign(await ledgerChallenge(f.C.ledger.transitions[0].payload)) };
    assert.notDeepEqual(resigned.signature, f.C.ledger.transitions[0].signature);
    const reencoded = { genesis: f.C.ledger.genesis, transitions: [resigned, { ...f.C.ledger.transitions[1], signature: f.C.ledger.transitions[0].signature }, ...f.C.ledger.transitions.slice(2)] };
    const result = await replica.offer(reencoded, 'server');
    assert.deepEqual([result.decision, result.relation], ['adopt', 'ahead']);
    const stored = (await store().read())!.ledger;
    assert.deepEqual(stored.transitions.slice(0, 2), ours.transitions, 'our prefix, byte for byte');
    assert.deepEqual(stored.transitions.slice(2), f.C.ledger.transitions.slice(2), 'then the verified records of the candidate');
    assert.deepEqual(stored.genesis, ours.genesis);
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

  it('reads a version 1 file (no divergences), writes version 2, and treats a malformed divergence entry as corruption', async () => {
    await seed(f.A);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
    assert.deepEqual((await store().read())?.divergences, []);
    await store().offer(f.B.ledger, 'server');
    const valid = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(valid.version, 2);
    assert.deepEqual(valid.divergences, [{ source: 'server', otherHead: f.B.head, otherRevision: 3, firstSeen: NOW, lastSeen: NOW }]);
    const entry = valid.divergences[0];
    const corruptions: unknown[] = [
      { ...valid, divergences: undefined },
      { ...valid, divergences: {} },
      { ...valid, divergences: [entry, entry] },
      { ...valid, divergences: [entry, { ...entry, source: 'relay' }, { ...entry, source: 'relay' }] },
      { ...valid, divergences: [{ ...entry, source: 'pairing' }] },
      { ...valid, divergences: [{ ...entry, otherHead: 'short' }] },
      { ...valid, divergences: [{ ...entry, otherRevision: -1 }] },
      { ...valid, divergences: [{ ...entry, otherRevision: 1025 }] },
      { ...valid, divergences: [{ ...entry, firstSeen: NOW + 1 }] },
      { ...valid, divergences: [{ ...entry, extra: 1 }] },
      { version: 1, ledger: valid.ledger, checkpoint: valid.checkpoint, sticky: valid.sticky, lastServerReadAt: null, divergences: [] },
      { version: 3, ledger: valid.ledger, checkpoint: valid.checkpoint, sticky: valid.sticky, lastServerReadAt: null, divergences: [] },
    ];
    for (const corruption of corruptions) {
      writeFileSync(file, JSON.stringify(corruption));
      await assert.rejects(store().read(), storeError('ledger_store_corrupt'), JSON.stringify(corruption).slice(-120));
    }
  });

  it('serializes concurrent offers, also across store instances', async () => {
    const replica = await paired(f.C);
    const results = await Promise.all([replica.offer(f.R.ledger, 'relay'), store().offer(f.S.ledger, 'server')]);
    assert.deepEqual(results.map(result => [result.decision, result.relation]), [['keep', 'diverged'], ['keep', 'diverged']]);
    assert.deepEqual((await store().read())?.sticky, { deviceIds: [], bridgeIds: [] });
    assert.deepEqual((await store().read())?.divergences.map(entry => entry.source), ['server', 'relay']);

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
    assert.equal(await behind.ownBridgeStatus('studio', f.studio.authPublicKey), 'active');
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
