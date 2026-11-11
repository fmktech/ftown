import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EndpointIdentity, EnvelopePurpose, SecureEnvelope } from '@security/protocol';
import { generateEndpoint, open, seal } from '@security/crypto';
import { accountIdOf, ledgerChallenge, ledgerLastIssuedAt, nextTransition, verifyLedger } from '@security/ledger/ledger';
import { generateAuthKey } from '@security/ledger/proof';
import type { Ledger, LedgerCheckpoint, LedgerGenesis, LedgerOperation, LedgerTransition, Signed } from '@security/ledger/protocol';
import { createSoftPasskey, type SoftPasskey } from '@security/ledger/testing';
import { LedgerClient } from './ledger-client';
import { LedgerReplica, memoryReplicaStorage } from './ledger-replica';
import type * as PasskeyModule from './passkey';
import { SecureEndpointRuntime, ledgerStanding, type LedgerBridgeAuthority } from './secure-endpoint-runtime';

const gate = vi.hoisted(() => ({ wait: null as Promise<void> | null }));
vi.mock('@security/crypto', async original => {
  const real = await original<typeof import('@security/crypto')>();
  return { ...real, open: async (...args: Parameters<typeof real.open>) => { if (gate.wait) await gate.wait; return real.open(...args); } };
});
vi.mock('./browser-identity', () => ({ pinApprovedBridge: vi.fn(async () => {}), validatePublicEndpoint: vi.fn(async value => value) }));
const ownerId = '00000000-0000-4000-8000-000000000001';
const channel = 'commands:rpc#owner@example.test';
const text = new TextEncoder();
afterEach(() => { gate.wait = null; });
async function fixture() {
  const browser = await generateEndpoint(ownerId, 'browser'); const bridge = await generateEndpoint(ownerId, 'bridge');
  const runtime = new SecureEndpointRuntime(browser, [{ bridgeId: 'bridge-one', endpoint: bridge.endpoint, permissions: ['read', 'control', 'admin'] }]);
  return { browser, bridge, runtime };
}
async function packet(sender: EndpointIdentity, recipient: EndpointIdentity, purpose: EnvelopePurpose, data: unknown, override: Partial<SecureEnvelope> = {}) {
  const now = Date.now();
  return seal(sender, recipient.endpoint, { type: 'ftown_encrypted', version: 1, senderId: sender.endpoint.id, recipientId: recipient.endpoint.id,
    ownerId, bridgeId: 'bridge-one', channel, purpose, messageId: crypto.randomUUID(), createdAt: now, expiresAt: now + 120000, receiverEpoch: null, ...override }, text.encode(JSON.stringify(data)));
}
async function establish(runtime: SecureEndpointRuntime, bridge: EndpointIdentity, browser: EndpointIdentity, owner = ownerId) {
  await runtime.handshake('bridge-one', channel, async message => {
    const envelope = message as SecureEnvelope;
    const hello = JSON.parse(new TextDecoder().decode(await open(bridge, browser.endpoint, envelope, { ownerId: owner, bridgeId: 'bridge-one', channel, recipientId: bridge.endpoint.id, purpose: 'hello' })));
    await runtime.receive(await packet(bridge, browser, 'welcome', { type: 'welcome', challenge: hello.challenge, receiverEpoch: 'boot-one' }, { ownerId: owner }), channel);
  });
}

describe('browser secure runtime', () => {
  it('keeps request IDs equal across encrypted header and route, and authenticates a boot epoch', async () => {
    const { browser, bridge, runtime } = await fixture(); await establish(runtime, bridge, browser);
    const requestId = crypto.randomUUID();
    const envelope = await runtime.sealApplication('bridge-one', channel, { type: 'application', route: { kind: 'command', requestId, command: 'list_sessions', sessionId: null }, data: {}, mcp: null });
    expect(envelope.messageId).toBe(requestId); expect(envelope.receiverEpoch).toBe('boot-one');
    const value = JSON.parse(new TextDecoder().decode(await open(bridge, browser.endpoint, envelope, { ownerId, bridgeId: 'bridge-one', channel, recipientId: bridge.endpoint.id, purpose: 'application' })));
    expect(value.route.requestId).toBe(requestId); runtime.dispose();
  });

  it('deduplicates authenticated publication recovery and rejects expired fresh responses', async () => {
    const { browser, bridge, runtime } = await fixture();
    const old = { createdAt: Date.now() - 300000, expiresAt: Date.now() - 180000 };
    const history = await packet(bridge, browser, 'application', { type: 'application', route: { kind: 'publication' }, data: { type: 'session_update' }, mcp: null }, old);
    expect(await runtime.receive(history, channel)).toHaveLength(1);
    expect(await runtime.receive(history, channel)).toHaveLength(0);
    const response = await packet(bridge, browser, 'application', { type: 'application', route: { kind: 'response', requestId: 'stale' }, data: {}, mcp: null }, old);
    expect(await runtime.receive(response, channel)).toHaveLength(0); runtime.dispose();
  });

  it('cannot deliver plaintext after disposal while authenticated decryption was awaiting', async () => {
    const { browser, bridge, runtime } = await fixture();
    const message = await packet(bridge, browser, 'application', { type: 'application', route: { kind: 'publication' }, data: { private: 'old-account-content' }, mcp: null });
    let release!: () => void; gate.wait = new Promise<void>(resolve => { release = resolve; });
    const receiving = runtime.receive(message, channel);
    runtime.dispose(); release();
    expect(await receiving).toEqual([]);
  });

  it('allows a fresh explicitly approved invitation to replace a changed key', async () => {
    const { browser, runtime } = await fixture(); const replacement = await generateEndpoint(ownerId, 'bridge');
    runtime.discover('bridge-one', replacement.endpoint); expect(runtime.state('bridge-one').status).toBe('key_changed');
    const invitation = { version: 1 as const, invitationId: 'invite-one', ownerId, bridgeId: 'bridge-one', bridge: replacement.endpoint,
      secret: 'a'.repeat(43), expiresAt: new Date(Date.now() + 300000).toISOString(), relayUrl: null, localOrigin: null };
    await runtime.enroll(invitation, 'Browser', channel, async message => {
      if (!('candidate' in message)) throw new Error('Enrollment packet required');
      const bytes = await open(replacement, browser.endpoint, message.envelope, { ownerId, bridgeId: 'bridge-one', channel, recipientId: replacement.endpoint.id, purpose: 'enroll' });
      const enrollment = JSON.parse(new TextDecoder().decode(bytes)); expect(enrollment.invitationSecret).toBe(invitation.secret);
      await runtime.receive(await packet(replacement, browser, 'enrolled', { type: 'enrolled', invitationId: invitation.invitationId,
        approved: { endpoint: browser.endpoint, label: 'Browser', permissions: ['read', 'control', 'admin'], approvedAt: new Date().toISOString(), grantId: null, expiresAt: null }, receiverEpoch: 'boot-new' }), channel);
    });
    expect(runtime.state('bridge-one')).toMatchObject({ status: 'ready', endpoint: replacement.endpoint }); runtime.dispose();
  });
  it('learns only caller-verified roster pins and drops a removed bridge even during decrypt', async () => {
    const { browser, bridge, runtime } = await fixture();
    const another = await generateEndpoint(ownerId, 'bridge');
    runtime.replacePins([{ bridgeId: 'bridge-one', endpoint: bridge.endpoint, permissions: ['read', 'control', 'admin'] },
      { bridgeId: 'bridge-two', endpoint: another.endpoint, permissions: ['read', 'control', 'admin'] }]);
    expect(runtime.state('bridge-two').status).toBe('offline');
    const message = await packet(bridge, browser, 'application', { type: 'application', route: { kind: 'publication' }, data: { private: 'removed-computer' }, mcp: null });
    let release!: () => void; gate.wait = new Promise<void>(resolve => { release = resolve; });
    const receiving = runtime.receive(message, channel);
    runtime.replacePins([{ bridgeId: 'bridge-two', endpoint: another.endpoint, permissions: ['read', 'control', 'admin'] }]);
    release(); expect(await receiving).toEqual([]); expect(runtime.state('bridge-one').status).toBe('revoked');
    expect(runtime.state('bridge-two').status).toBe('offline'); runtime.dispose();
  });

});

// ---- Account mode: the passkey ledger is the only bridge authority (real signed chains, real replica and client). ----
const ORIGIN = 'https://ftown.example';
const RP_ID = 'ftown.example';
const APP = { type: 'application' as const, route: { kind: 'terminal' as const, sessionId: 'session', frameType: 'input', pairId: null }, data: {}, mcp: null };
const b64url = (data: Uint8Array): string => Buffer.from(data).toString('base64url');
async function signedRecord<T extends LedgerGenesis | LedgerTransition>(passkey: SoftPasskey, payload: T): Promise<Signed<T>> {
  return { payload, signature: await passkey.sign(await ledgerChallenge(payload)) };
}
async function appended(ledger: Ledger, passkey: SoftPasskey, operation: LedgerOperation): Promise<Ledger> {
  const payload = nextTransition(await verifyLedger(ledger), passkey.credentialId, operation, Date.now(), ledgerLastIssuedAt(ledger));
  return { genesis: ledger.genesis, transitions: [...ledger.transitions, await signedRecord(passkey, payload)] };
}
async function otherDevice(accountId: string): Promise<LedgerOperation> {
  const endpoint = await generateEndpoint(accountId, 'browser', false);
  return { type: 'add_device', device: { endpoint: endpoint.endpoint, authPublicKey: (await generateAuthKey(false)).publicKey, label: 'Other', approvedAt: Date.now() - 1000 } };
}
/** genesis -> add_device(this browser) -> add_bridge('bridge-one'), bound in a real replica behind a real LedgerClient. */
async function account(options: { load?: boolean } = {}) {
  const passkey = await createSoftPasskey({ rpId: RP_ID, origin: ORIGIN });
  const createdAt = Date.now() - 60_000;
  const genesis: LedgerGenesis = { type: 'ftown_account_genesis', version: 2, rpId: RP_ID, origins: [ORIGIN], handle: b64url(crypto.getRandomValues(new Uint8Array(32))),
    createdAt, authority: { credentialId: passkey.credentialId, publicKey: passkey.publicKey, label: 'Mac', addedAt: createdAt } };
  const accountId = await accountIdOf(genesis);
  const browser = await generateEndpoint(accountId, 'browser', false); const bridge = await generateEndpoint(accountId, 'bridge', false);
  let ledger: Ledger = { genesis: await signedRecord(passkey, genesis), transitions: [] };
  ledger = await appended(ledger, passkey, { type: 'add_device', device: { endpoint: browser.endpoint, authPublicKey: (await generateAuthKey(false)).publicKey, label: 'Laptop', approvedAt: Date.now() - 1000 } });
  ledger = await appended(ledger, passkey, { type: 'add_bridge', bridge: { bridgeId: 'bridge-one', endpoint: bridge.endpoint, authPublicKey: (await generateAuthKey(false)).publicKey, label: 'Desk', approvedAt: Date.now() - 1000 } });
  const replica = new LedgerReplica(memoryReplicaStorage());
  expect((await replica.offer(ledger, { bind: true, expectAccountId: accountId })).decision).toBe('adopt');
  const deviceKey = await generateAuthKey(false);
  const client = new LedgerClient({ origin: ORIGIN, pageOrigin: ORIGIN, publicOrigin: ORIGIN, rpId: RP_ID, replica, passkey: {} as typeof PasskeyModule,
    deviceKey: async () => deviceKey, endpoint: async () => browser, resetDeviceIdentity: async () => {}, signIn: async () => false,
    fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch });
  if (options.load !== false) await client.load();
  return { passkey, accountId, browser, bridge, ledger, replica, client };
}
type Account = Awaited<ReturnType<typeof account>>;
const accountRuntime = (f: Account) => new SecureEndpointRuntime(f.browser, { ledger: f.client });
const received = async (f: Account, runtime: SecureEndpointRuntime, data: unknown) =>
  runtime.receive(await packet(f.bridge, f.browser, 'application', { type: 'application', route: { kind: 'publication' }, data, mcp: null }, { ownerId: f.accountId }), channel);

describe('account runtime (passkey ledger authority)', () => {
  it('takes its bridges only from the trusted checkpoint and refuses pins and invitations', async () => {
    const f = await account(); const runtime = accountRuntime(f);
    expect(runtime.accountManaged).toBe(true);
    expect(runtime.pinnedBridges()).toEqual([{ bridgeId: 'bridge-one', endpoint: f.bridge.endpoint, permissions: ['read', 'control', 'admin'] }]);
    await establish(runtime, f.bridge, f.browser, f.accountId);
    const envelope = await runtime.sealApplication('bridge-one', channel, APP);
    expect(envelope.recipientId).toBe(f.bridge.endpoint.id); expect(envelope.ownerId).toBe(f.accountId);
    expect(await received(f, runtime, { private: 'ok' })).toHaveLength(1);
    const legacy = await generateEndpoint(f.accountId, 'bridge');
    expect(() => runtime.replacePins([{ bridgeId: 'legacy', endpoint: legacy.endpoint, permissions: ['read', 'control', 'admin'] }])).toThrow(expect.objectContaining({ code: 'wrong_context' }));
    const invitation = { version: 1 as const, invitationId: 'invite-one', ownerId: f.accountId, bridgeId: 'legacy', bridge: legacy.endpoint,
      secret: 'a'.repeat(43), expiresAt: new Date(Date.now() + 300000).toISOString(), relayUrl: null, localOrigin: null };
    await expect(runtime.enroll(invitation, 'Browser', channel, async () => {})).rejects.toMatchObject({ code: 'wrong_context' });
    expect(runtime.bridge('legacy')).toBeNull(); runtime.dispose();
  });

  it('a signed computer removal stops sealing and drops content already being decrypted', async () => {
    const f = await account(); const runtime = accountRuntime(f); await establish(runtime, f.bridge, f.browser, f.accountId);
    const message = await packet(f.bridge, f.browser, 'application', { type: 'application', route: { kind: 'publication' }, data: { private: 'removed-computer' }, mcp: null }, { ownerId: f.accountId });
    let release!: () => void; gate.wait = new Promise<void>(resolve => { release = resolve; });
    const receiving = runtime.receive(message, channel);
    await f.client.offer({ type: 'ledger', ledger: await appended(f.ledger, f.passkey, { type: 'revoke_bridge', bridgeId: 'bridge-one' }) });
    release(); expect(await receiving).toEqual([]);
    expect(runtime.state('bridge-one').status).toBe('revoked'); expect(runtime.bridge('bridge-one')).toBeNull();
    await expect(runtime.sealApplication('bridge-one', channel, APP)).rejects.toMatchObject({ code: 'endpoint_revoked' }); runtime.dispose();
  });

  it('gates every seal and accept with assertBridgeAccess, even before the ledger change is published', async () => {
    const f = await account(); const runtime = accountRuntime(f); await establish(runtime, f.bridge, f.browser, f.accountId);
    // The replica learns the removal; the client has not published a new snapshot, so the runtime still lists the computer.
    await f.replica.offer(await appended(f.ledger, f.passkey, { type: 'revoke_bridge', bridgeId: 'bridge-one' }), { expectAccountId: f.accountId });
    expect(runtime.bridge('bridge-one')).not.toBeNull();
    expect(() => f.client.assertBridgeAccess('bridge-one', f.bridge.endpoint.id)).toThrow('account_bridge_revoked');
    await expect(runtime.sealApplication('bridge-one', channel, APP)).rejects.toMatchObject({ code: 'endpoint_revoked' });
    expect(() => runtime.assertCanSend('bridge-one')).toThrow(expect.objectContaining({ code: 'endpoint_revoked' }));
    expect(await received(f, runtime, { private: 'must-not-deliver' })).toEqual([]); runtime.dispose();
  });

  it('asks the ledger about exactly the endpoint it seals to and accepts from', async () => {
    const f = await account(); const checkpoint = f.client.snapshot().checkpoint as LedgerCheckpoint;
    let trusted = f.bridge.endpoint.id; const calls: string[] = [];
    const authority: LedgerBridgeAuthority = { snapshot: () => ({ status: 'ready', checkpoint }), subscribe: () => () => {},
      assertBridgeAccess: (bridgeId, endpointId) => { calls.push(`${bridgeId}/${endpointId}`); if (endpointId !== trusted) throw new Error('account_bridge_revoked'); } };
    const runtime = new SecureEndpointRuntime(f.browser, { ledger: authority }); await establish(runtime, f.bridge, f.browser, f.accountId);
    await runtime.sealApplication('bridge-one', channel, APP);
    expect(await received(f, runtime, { private: 'ok' })).toHaveLength(1);
    expect(new Set(calls)).toEqual(new Set([`bridge-one/${f.bridge.endpoint.id}`]));
    trusted = (await generateEndpoint(f.accountId, 'bridge')).endpoint.id;
    await expect(runtime.sealApplication('bridge-one', channel, APP)).rejects.toMatchObject({ code: 'endpoint_revoked' });
    expect(await received(f, runtime, { private: 'stale-key' })).toEqual([]); runtime.dispose();
  });

  it('a signed computer removal waiting for the server already stops sealing and accepting (enforced here, not in the chain)', async () => {
    const f = await account(); const runtime = accountRuntime(f); await establish(runtime, f.bridge, f.browser, f.accountId);
    const record = (await appended(f.ledger, f.passkey, { type: 'revoke_bridge', bridgeId: 'bridge-one' })).transitions[2];
    expect(await f.replica.setPendingWrite({ version: 1, record, since: Date.now() }, null)).toBe(true);
    expect(f.replica.raw()?.checkpoint.bridges.map(item => item.bridgeId)).toEqual(['bridge-one']);
    expect(() => f.client.assertBridgeAccess('bridge-one', f.bridge.endpoint.id)).toThrow('account_bridge_revoked');
    await expect(runtime.sealApplication('bridge-one', channel, APP)).rejects.toMatchObject({ code: 'endpoint_revoked' });
    expect(await received(f, runtime, { private: 'must-not-deliver' })).toEqual([]);
    // Published: the runtime drops it from its pins too.
    await f.client.dismissDiscarded();
    expect(runtime.bridge('bridge-one')).toBeNull(); runtime.dispose();
  });

  it('this browser\'s own signed removal waiting for the server already stops it sealing and accepting', async () => {
    const f = await account(); const runtime = accountRuntime(f); await establish(runtime, f.bridge, f.browser, f.accountId);
    const record = (await appended(f.ledger, f.passkey, { type: 'revoke_device', endpointId: f.browser.endpoint.id })).transitions[2];
    expect(await f.replica.setPendingWrite({ version: 1, record, since: Date.now() }, null)).toBe(true);
    await f.client.dismissDiscarded();
    expect(f.client.snapshot().checkpoint?.revokedDeviceIds).toEqual([f.browser.endpoint.id]);
    expect(ledgerStanding(f.client.snapshot(), f.browser.endpoint)).toBe('revoked');
    await expect(runtime.sealApplication('bridge-one', channel, APP)).rejects.toMatchObject({ code: 'endpoint_revoked' });
    expect(await received(f, runtime, { private: 'after-own-removal' })).toEqual([]); runtime.dispose();
  });

  it('a computer removed on a valid other history stays untrusted here (seen), though the local chain lists it', async () => {
    const f = await account(); const runtime = accountRuntime(f);
    const losing = await appended(f.ledger, f.passkey, { type: 'revoke_bridge', bridgeId: 'bridge-one' });
    const winning = await appended(await appended(f.ledger, f.passkey, await otherDevice(f.accountId)), f.passkey, await otherDevice(f.accountId));
    await f.client.offer(winning); expect(runtime.bridge('bridge-one')).not.toBeNull();
    await f.client.offer(losing);
    expect(f.replica.raw()?.checkpoint.bridges.map(item => item.bridgeId)).toEqual(['bridge-one']);
    expect(runtime.bridge('bridge-one')).toBeNull(); expect(runtime.state('bridge-one').status).toBe('revoked');
    expect(() => runtime.assertCanSend('bridge-one')).toThrow(); runtime.dispose();
  });

  it('this browser removed from the ledger stops sealing and accepting immediately, for good', async () => {
    const f = await account(); const runtime = accountRuntime(f); await establish(runtime, f.bridge, f.browser, f.accountId);
    const waiting = runtime.request('bridge-one', channel, { kind: 'command', requestId: 'in-flight', command: 'list_sessions', sessionId: null }, {}, async () => {});
    const settled = waiting.then(() => 'resolved', (error: { code?: string }) => error.code);
    await f.client.offer({ type: 'ledger', ledger: await appended(f.ledger, f.passkey, { type: 'revoke_device', endpointId: f.browser.endpoint.id }) });
    expect(await settled).toBe('endpoint_revoked');
    expect(runtime.state('bridge-one').status).toBe('revoked'); expect(runtime.pinnedBridges()).toEqual([]);
    await expect(runtime.sealApplication('bridge-one', channel, APP)).rejects.toMatchObject({ code: 'endpoint_revoked' });
    expect(await received(f, runtime, { private: 'after-removal' })).toEqual([]);
    runtime.discover('bridge-one', f.bridge.endpoint); expect(runtime.state('bridge-one').status).toBe('revoked'); runtime.dispose();
  });

  it('an unauthenticated endpoint hint (directory, presence) never replaces or blocks the ledger key', async () => {
    const f = await account(); const runtime = accountRuntime(f); await establish(runtime, f.bridge, f.browser, f.accountId);
    const other = await generateEndpoint(f.accountId, 'bridge');
    runtime.discover('bridge-one', other.endpoint);
    expect(runtime.state('bridge-one').status).toBe('ready'); expect(runtime.bridge('bridge-one')?.endpoint).toEqual(f.bridge.endpoint);
    expect((await runtime.sealApplication('bridge-one', channel, APP)).recipientId).toBe(f.bridge.endpoint.id);
    runtime.discover('bridge-new', other.endpoint); expect(runtime.state('bridge-new').status).toBe('unpaired');
    expect(() => runtime.assertCanSend('bridge-new')).toThrow(expect.objectContaining({ code: 'approval_required' })); runtime.dispose();
  });

  it('trusts nothing until the replica is loaded, then exactly the ledger bridges', async () => {
    const f = await account({ load: false }); const runtime = accountRuntime(f);
    expect(runtime.pinnedBridges()).toEqual([]);
    expect(() => runtime.assertCanSend('bridge-one')).toThrow(expect.objectContaining({ code: 'approval_required' }));
    await f.client.load();
    expect(runtime.pinnedBridges().map(pin => pin.bridgeId)).toEqual(['bridge-one']); runtime.dispose();
  });

  it('classifies this browser against a snapshot and refuses a non-account identity', async () => {
    const f = await account(); const checkpoint = f.client.snapshot().checkpoint as LedgerCheckpoint;
    expect(ledgerStanding({ status: 'ready', checkpoint }, f.browser.endpoint)).toBe('member');
    expect(ledgerStanding({ status: 'device_revoked', checkpoint }, f.browser.endpoint)).toBe('revoked');
    expect(ledgerStanding({ status: 'ready', checkpoint: { ...checkpoint, revokedDeviceIds: [f.browser.endpoint.id] } }, f.browser.endpoint)).toBe('revoked');
    expect(ledgerStanding({ status: 'ready', checkpoint: { ...checkpoint, devices: [] } }, f.browser.endpoint)).toBe('absent');
    expect(ledgerStanding({ status: 'signed_out', checkpoint: null }, f.browser.endpoint)).toBe('absent');
    const replaced = await generateEndpoint(f.accountId, 'browser');
    expect(ledgerStanding({ status: 'ready', checkpoint }, { ...replaced.endpoint, id: f.browser.endpoint.id })).toBe('absent');
    const solo = await generateEndpoint('solo:bridge-one', 'browser');
    expect(() => new SecureEndpointRuntime(solo, { ledger: f.client })).toThrow(expect.objectContaining({ code: 'wrong_context' }));
  });
});
