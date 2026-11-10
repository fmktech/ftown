import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { generateEndpoint, open, seal } from '../crypto.js';
import { signAuthProof, verifyAuthProof } from '../ledger/proof.js';
import type { LedgerCheckpoint } from '../ledger/protocol.js';
import type { EndpointIdentity, EndpointPublic, EnvelopeHeader } from '../protocol.js';
import { BridgeSecurityError } from './errors.js';
import {
  bindLedgerIdentity, hasLegacyAccountState, inspectIdentityFile, loadOrCreateLedgerIdentity, readLedgerIdentity,
} from './ledger-identity.js';
import type { LedgerBridgeIdentity } from './ledger-identity.js';

const randomId = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const securityError = (code: string) => (error: unknown): boolean => error instanceof BridgeSecurityError && error.code === code;

describe('ledger bridge identity', () => {
  let dataDir: string;
  let file: string;
  const read = (): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8'));
  const writeAt = (path: string, value: unknown): void => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const write = (value: unknown): void => writeAt(file, value);
  async function v1Identity(ownerId: string): Promise<unknown> {
    const v1 = await generateEndpoint(ownerId, 'bridge', true);
    return { version: 1, endpoint: v1.endpoint, privateKey: await crypto.subtle.exportKey('jwk', v1.keyPair.privateKey) };
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ledger-identity-'));
    file = join(dataDir, 'security', 'ledger-identity.json');
  });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('reports an absent file and creates an unbound v2 identity in ledger-identity.json with 0600 mode', async () => {
    assert.deepEqual(await inspectIdentityFile(dataDir), { state: 'absent', accountId: null });
    assert.equal(await readLedgerIdentity(dataDir), null);
    assert.equal(existsSync(file), false);
    const identity = await loadOrCreateLedgerIdentity(dataDir);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(existsSync(join(dataDir, 'security', 'bridge-identity.json')), false);
    const record = read();
    assert.deepEqual(Object.keys(record).sort(), ['authPrivateKey', 'authPublicKey', 'endpointPublicKey', 'privateKey', 'version']);
    assert.equal(record.version, 2);
    assert.equal(record.endpointPublicKey, identity.endpointPublicKey);
    assert.equal(record.authPublicKey, identity.authPublicKey);
    assert.notEqual(identity.endpointPublicKey, identity.authPublicKey);
    assert.equal(identity.endpoint, null);
    assert.equal(identity.accountId, null);
    assert.equal(identity.endpointId, createHash('sha256').update(Buffer.from(identity.endpointPublicKey, 'base64url')).digest('base64url'));
    assert.equal(identity.keyPair.privateKey.extractable, false);
    assert.deepEqual(identity.keyPair.privateKey.usages, ['deriveBits']);
    assert.equal(identity.authPrivateKey.extractable, false);
    assert.deepEqual(identity.authPrivateKey.usages, ['sign']);
    assert.deepEqual(await inspectIdentityFile(dataDir), { state: 'ready', accountId: null });
    assert.equal((await readLedgerIdentity(dataDir))?.authPublicKey, identity.authPublicKey);
  });

  it('reloads the same keys without rewriting the file, also under concurrent loads', async () => {
    const [first, second, third] = await Promise.all([
      loadOrCreateLedgerIdentity(dataDir), loadOrCreateLedgerIdentity(dataDir), loadOrCreateLedgerIdentity(dataDir),
    ]);
    assert.equal(second.endpointPublicKey, first.endpointPublicKey);
    assert.equal(third.authPublicKey, first.authPublicKey);
    const before = readFileSync(file, 'utf8');
    const { ino } = statSync(file);
    const again = await loadOrCreateLedgerIdentity(dataDir);
    assert.equal(again.endpointPublicKey, first.endpointPublicKey);
    assert.equal(again.authPublicKey, first.authPublicKey);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(statSync(file).ino, ino);
  });

  it('binds once to an account; the bound identity signs proofs and opens envelopes', async () => {
    const created = await loadOrCreateLedgerIdentity(dataDir);
    const accountId = randomId();
    const bound = await bindLedgerIdentity(dataDir, accountId);
    const endpoint: EndpointPublic = { version: 1, id: created.endpointId, ownerId: accountId, kind: 'bridge', publicKey: created.endpointPublicKey };
    assert.deepEqual(bound.endpoint, endpoint);
    assert.equal(bound.accountId, accountId);
    assert.equal(bound.authPublicKey, created.authPublicKey);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(read().endpoint, endpoint);
    assert.deepEqual(await inspectIdentityFile(dataDir), { state: 'ready', accountId });

    const reloaded: LedgerBridgeIdentity = await loadOrCreateLedgerIdentity(dataDir);
    assert.deepEqual(reloaded.endpoint, endpoint);
    assert.equal(reloaded.accountId, accountId);
    assert.equal((await readLedgerIdentity(dataDir))?.accountId, accountId);
    const before = readFileSync(file, 'utf8');
    assert.deepEqual((await bindLedgerIdentity(dataDir, accountId)).endpoint, endpoint);
    assert.equal(readFileSync(file, 'utf8'), before);

    // The auth key verifies as this bridge's roster key.
    const checkpoint: LedgerCheckpoint = {
      version: 2, accountId, revision: 1, head: randomId(), authorities: [], devices: [],
      bridges: [{ bridgeId: 'studio', endpoint, authPublicKey: reloaded.authPublicKey, label: 'Studio', approvedAt: 1 }],
      revokedDeviceIds: [], revokedBridgeIds: [],
    };
    const audience = 'https://ftown.example';
    const proof = await signAuthProof(reloaded.authPrivateKey, { accountId, kind: 'bridge', keyId: 'studio', nonce: randomId(), purpose: 'relay', audience });
    assert.equal(await verifyAuthProof(checkpoint, proof, { audience, purpose: 'relay' }), true);

    // The endpoint key opens an HPKE envelope sealed to the bound endpoint.
    if (reloaded.endpoint === null) throw new Error('unbound');
    const own: EndpointIdentity = { endpoint: reloaded.endpoint, keyPair: reloaded.keyPair };
    const browser = await generateEndpoint(accountId, 'browser');
    const header: EnvelopeHeader = {
      type: 'ftown_encrypted', version: 1, senderId: browser.endpoint.id, recipientId: own.endpoint.id, ownerId: accountId,
      bridgeId: 'studio', channel: 'test', purpose: 'application', messageId: randomId(), createdAt: 1, expiresAt: 2, receiverEpoch: null,
    };
    const envelope = await seal(browser, own.endpoint, header, new TextEncoder().encode('hello'));
    const opened = await open(own, browser.endpoint, envelope, { ownerId: accountId, bridgeId: 'studio', channel: 'test', recipientId: own.endpoint.id, purpose: 'application' });
    assert.equal(new TextDecoder().decode(opened), 'hello');
  });

  it('refuses to rebind to another account, a malformed account id, or a missing identity', async () => {
    await assert.rejects(bindLedgerIdentity(dataDir, randomId()), securityError('key_unavailable'));
    assert.equal(existsSync(file), false);
    await loadOrCreateLedgerIdentity(dataDir);
    const unbound = readFileSync(file, 'utf8');
    const accountId = randomId();
    // 43 chars whose last one carries non-zero padding bits: not the canonical encoding of 32 bytes.
    const nonCanonical = `${accountId.slice(0, 42)}${accountId[42] === 'B' ? 'C' : 'B'}`;
    for (const bad of ['', 'solo:studio', accountId.slice(1), `${accountId}A`, nonCanonical, '0f8fad5b-d9cb-469f-a165-70867728950e']) {
      await assert.rejects(bindLedgerIdentity(dataDir, bad), securityError('wrong_context'), bad);
    }
    assert.equal(readFileSync(file, 'utf8'), unbound);
    await bindLedgerIdentity(dataDir, accountId);
    const before = readFileSync(file, 'utf8');
    await assert.rejects(bindLedgerIdentity(dataDir, randomId()), securityError('wrong_context'));
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal((await loadOrCreateLedgerIdentity(dataDir)).accountId, accountId);
  });

  it('lets exactly one of two concurrent binds to different accounts win', async () => {
    await loadOrCreateLedgerIdentity(dataDir);
    const accounts = [randomId(), randomId()];
    const results = await Promise.allSettled(accounts.map(accountId => bindLedgerIdentity(dataDir, accountId)));
    const won = results.flatMap((result, index) => result.status === 'fulfilled' ? [accounts[index]] : []);
    assert.equal(won.length, 1);
    const lost = results.find(result => result.status === 'rejected');
    assert.ok(lost && lost.status === 'rejected' && securityError('wrong_context')(lost.reason));
    assert.equal((read().endpoint as { ownerId: string }).ownerId, won[0]);
    assert.equal((await loadOrCreateLedgerIdentity(dataDir)).accountId, won[0]);
  });

  it("never reads, touches or reports Solo's v1 bridge-identity.json; the v2 identity lives beside it", async () => {
    const soloFile = join(dataDir, 'security', 'bridge-identity.json');
    writeAt(soloFile, await v1Identity('solo:studio'));
    const solo = readFileSync(soloFile, 'utf8');
    assert.equal(hasLegacyAccountState(dataDir), false);
    assert.deepEqual(await inspectIdentityFile(dataDir), { state: 'absent', accountId: null });
    const identity = await loadOrCreateLedgerIdentity(dataDir);
    const accountId = randomId();
    assert.equal((await bindLedgerIdentity(dataDir, accountId)).endpointId, identity.endpointId);
    assert.equal((await readLedgerIdentity(dataDir))?.accountId, accountId);
    assert.equal(readFileSync(soloFile, 'utf8'), solo);
    assert.equal(hasLegacyAccountState(dataDir), false);
    // Unreadable or ownerless: cannot be told apart from Solo's, so not reported.
    for (const unknown of ['not json', { version: 1 }, { version: 1, endpoint: { ownerId: 7 } }, { version: 1, endpoint: { ownerId: '' } }]) {
      writeAt(soloFile, unknown);
      assert.equal(hasLegacyAccountState(dataDir), false);
    }
  });

  it('reports v1 account state: an account-owned bridge-identity.json or any v1 account file', async () => {
    assert.equal(hasLegacyAccountState(dataDir), false);
    writeAt(join(dataDir, 'security', 'bridge-identity.json'), await v1Identity('0f8fad5b-d9cb-469f-a165-70867728950e'));
    assert.equal(hasLegacyAccountState(dataDir), true);
    rmSync(join(dataDir, 'security', 'bridge-identity.json'));
    for (const parts of [['refresh-token'], ['security', 'account-enrollment.json'], ['security', 'pending-approval-status.json'], ['security', 'pending-approval-confirmation.json']]) {
      const path = join(dataDir, ...parts);
      writeAt(path, '{}');
      assert.equal(hasLegacyAccountState(dataDir), true, parts.join('/'));
      rmSync(path);
      assert.equal(hasLegacyAccountState(dataDir), false);
    }
    // A v2 identity alone is not legacy, and the check never modifies anything.
    await loadOrCreateLedgerIdentity(dataDir);
    const before = readFileSync(file, 'utf8');
    assert.equal(hasLegacyAccountState(dataDir), false);
    assert.equal(readFileSync(file, 'utf8'), before);
  });

  it('removes its own stale temporaries on load and leaves every other file alone', async () => {
    const security = join(dataDir, 'security');
    const own = join(security, `ledger-identity.json.${randomUUID()}.tmp`);
    const others = [`bridge-identity.json.${randomUUID()}.tmp`, `policy.json.${randomUUID()}.tmp`, 'ledger-identity.json.tmp', `ledger-identity.json.${randomUUID()}.bak`];
    writeAt(own, 'partial');
    for (const name of others) writeAt(join(security, name), 'other');
    await loadOrCreateLedgerIdentity(dataDir);
    assert.equal(existsSync(own), false);
    for (const name of others) assert.equal(existsSync(join(security, name)), true, name);
  });

  it('throws key_unavailable for a corrupted file and never generates a replacement', async () => {
    await loadOrCreateLedgerIdentity(dataDir);
    const valid = read();
    rmSync(file);
    await loadOrCreateLedgerIdentity(dataDir);
    const foreign = read();
    const raw = Buffer.from(String(valid.endpointPublicKey), 'base64url');
    const id = createHash('sha256').update(raw).digest('base64url');
    const sameKey = await generateEndpoint('solo:studio', 'bridge');
    const corruptions: unknown[] = [
      '{"version":2,',
      '[]',
      await v1Identity('solo:studio'),
      { ...valid, version: 1 },
      { ...valid, extra: true },
      { ...valid, version: 3 },
      { ...valid, privateKey: foreign.privateKey },
      { ...valid, authPrivateKey: foreign.authPrivateKey },
      { ...valid, authPrivateKey: { ...(valid.authPrivateKey as object), d: (foreign.authPrivateKey as { d: string }).d } },
      { ...valid, privateKey: { ...(valid.privateKey as object), d: (foreign.privateKey as { d: string }).d } },
      { ...valid, authPublicKey: valid.endpointPublicKey },
      { ...valid, endpointPublicKey: foreign.endpointPublicKey },
      // A bound endpoint must be the bridge's own key, of kind bridge, owned by an account id.
      { ...valid, endpoint: { version: 1, id: 'x'.repeat(43), ownerId: randomId(), kind: 'bridge', publicKey: valid.endpointPublicKey } },
      { ...valid, endpoint: { ...sameKey.endpoint, ownerId: randomId() } },
      { ...valid, endpoint: { ...sameKey.endpoint, publicKey: valid.endpointPublicKey } },
      { ...valid, endpoint: { version: 1, id, ownerId: 'solo:studio', kind: 'bridge', publicKey: valid.endpointPublicKey } },
      { ...valid, endpoint: { version: 1, id, ownerId: randomId(), kind: 'browser', publicKey: valid.endpointPublicKey } },
    ];
    for (const corruption of corruptions) {
      write(corruption);
      const before = readFileSync(file, 'utf8');
      await assert.rejects(loadOrCreateLedgerIdentity(dataDir), securityError('key_unavailable'), before.slice(0, 80));
      await assert.rejects(readLedgerIdentity(dataDir), securityError('key_unavailable'));
      await assert.rejects(bindLedgerIdentity(dataDir, randomId()), securityError('key_unavailable'));
      assert.equal(readFileSync(file, 'utf8'), before);
    }
    write('not json');
    await assert.rejects(inspectIdentityFile(dataDir), securityError('key_unavailable'));
    write({ ...valid, extra: true });
    await assert.rejects(inspectIdentityFile(dataDir), securityError('key_unavailable'));
  });
});
