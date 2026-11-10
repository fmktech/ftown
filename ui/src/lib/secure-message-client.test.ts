import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Centrifuge } from 'centrifuge';
import type { EndpointIdentity, SecureApplication, SecureEnvelope } from '@security/protocol';
import { generateEndpoint, open, seal } from '@security/crypto';
import type { LedgerCheckpoint } from '@security/ledger/protocol';
import { SecureEndpointRuntime, type LedgerBridgeAuthority } from './secure-endpoint-runtime';
import { SecureMessageClient, type ReadyRetryPolicy } from './secure-message-client';

const ownerId = '00000000-0000-4000-8000-000000000001';
const userId = 'owner@example.test';
const channel = `commands:rpc#${userId}`;
afterEach(() => vi.restoreAllMocks());
class RawSubscription {
  state = 'subscribed'; on = vi.fn(); off = vi.fn(); subscribe = vi.fn(); unsubscribe = vi.fn();
  presence = vi.fn(async () => ({ clients: {} }));
}
class RawClient {
  state = 'disconnected';
  subscriptions = new Map<string, RawSubscription>();
  publish = vi.fn(async (_channel: string, _data: unknown) => {});
  on = vi.fn(); off = vi.fn(); removeSubscription = vi.fn();
  getSubscription(channel: string) { return this.subscriptions.get(channel) ?? null; }
  newSubscription(channel: string) { const sub = new RawSubscription(); this.subscriptions.set(channel, sub); return sub; }
}
async function establish(runtime: SecureEndpointRuntime, bridgeId: string, bridge: EndpointIdentity, owner = ownerId) {
  await runtime.handshake(bridgeId, channel, async packet => {
    const envelope = packet as SecureEnvelope;
    const hello = JSON.parse(new TextDecoder().decode(await open(bridge, runtime.identity.endpoint, envelope,
      { ownerId: owner, bridgeId, channel, recipientId: bridge.endpoint.id, purpose: 'hello' })));
    const now = Date.now();
    const reply = await seal(bridge, runtime.identity.endpoint, { ...envelope, senderId: bridge.endpoint.id, recipientId: runtime.identity.endpoint.id,
      purpose: 'welcome', createdAt: now, expiresAt: now + 120000 }, new TextEncoder().encode(JSON.stringify({ type: 'welcome', challenge: hello.challenge, receiverEpoch: `boot-${bridgeId}` })));
    await runtime.receive(reply, channel);
  });
}
async function setup() {
  const browser = await generateEndpoint(ownerId, 'browser'); const a = await generateEndpoint(ownerId, 'bridge'); const b = await generateEndpoint(ownerId, 'bridge');
  const runtime = new SecureEndpointRuntime(browser, [{ bridgeId: 'bridge-a', endpoint: a.endpoint, permissions: ['read', 'control', 'admin'] }, { bridgeId: 'bridge-b', endpoint: b.endpoint, permissions: ['read', 'control', 'admin'] }]);
  await establish(runtime, 'bridge-a', a); await establish(runtime, 'bridge-b', b);
  const raw = new RawClient(); const client = new SecureMessageClient(raw as unknown as Centrifuge, userId, runtime);
  client.observe('bridge-a', { type: 'application', route: { kind: 'publication' }, data: { type: 'session_update', session: { id: 'session-one', bridgeId: 'bridge-a' } }, mcp: null });
  return { browser, a, b, runtime, raw, client };
}

/** Account mode: a ledger authority that trusts this browser and 'bridge-a' with exactly its endpoint while `allowed()` holds. */
async function ledgerSetup(allowed: () => boolean) {
  const accountId = 'a'.repeat(43);
  const browser = await generateEndpoint(accountId, 'browser'); const a = await generateEndpoint(accountId, 'bridge');
  const checkpoint: LedgerCheckpoint = { version: 2, accountId, revision: 2, head: 'h'.repeat(43), authorities: [],
    devices: [{ endpoint: browser.endpoint, authPublicKey: 'device-key', label: 'Laptop', approvedAt: 0 }],
    bridges: [{ bridgeId: 'bridge-a', endpoint: a.endpoint, authPublicKey: 'bridge-key', label: 'Desk', approvedAt: 0 }], revokedDeviceIds: [], revokedBridgeIds: [] };
  const ledger: LedgerBridgeAuthority = { snapshot: () => ({ status: 'ready', checkpoint }), subscribe: () => () => {},
    assertBridgeAccess: (bridgeId, endpointId) => { if (!allowed() || bridgeId !== 'bridge-a' || endpointId !== a.endpoint.id) throw new Error('account_bridge_revoked'); } };
  const runtime = new SecureEndpointRuntime(browser, { ledger });
  await establish(runtime, 'bridge-a', a, accountId);
  const raw = new RawClient(); const client = new SecureMessageClient(raw as unknown as Centrifuge, userId, runtime);
  return { runtime, raw, client };
}

describe('secure broker adapter', () => {
  it('coordinates reentrant recoveries per bridge and ignores stale completion after disconnect', async () => {
    const raw = new RawClient(); raw.state = 'connected';
    const states = new Map([['a', 'offline'], ['b', 'ready']]);
    const pending: Array<{ bridge: string; resolve: () => void; reject: (error: Error) => void }> = [];
    let changed = () => {};
    const runtime = {
      onChange: (callback: () => void) => { changed = callback; return () => {}; },
      pinnedBridges: () => [{ bridgeId: 'a' }, { bridgeId: 'b' }],
      state: (id: string) => ({ status: states.get(id) }),
      disconnected: () => { states.set('a', 'offline'); changed(); },
      handshake: (bridge: string) => {
        states.set(bridge, 'connecting'); changed();
        return new Promise<void>((resolve, reject) => pending.push({ bridge, resolve, reject }));
      },
    } as unknown as SecureEndpointRuntime;
    const client = new SecureMessageClient(raw as unknown as Centrifuge, userId, runtime);
    let refreshes = 0;
    client.getSubscription(channel)!.on('subscribed', () => { refreshes++; });
    changed();
    expect(pending.map(item => item.bridge)).toEqual(['a']);
    states.set('a', 'offline'); changed(); changed();
    expect(pending).toHaveLength(1);
    states.set('b', 'offline'); changed();
    expect(pending.map(item => item.bridge)).toEqual(['a', 'b']);
    states.set('b', 'ready'); pending[1].resolve();
    await vi.waitFor(() => expect(refreshes).toBe(1));

    raw.state = 'disconnected';
    raw.on.mock.calls.find(([event]) => event === 'disconnected')![1]();
    raw.state = 'connected'; changed();
    expect(pending.map(item => item.bridge)).toEqual(['a', 'b', 'a']);
    pending[0].resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(refreshes).toBe(1);
    states.set('a', 'offline'); changed();
    expect(pending).toHaveLength(3); // old completion cannot clear the new cycle
    states.set('a', 'ready'); pending[2].resolve();
    await vi.waitFor(() => expect(refreshes).toBe(2));

    states.set('a', 'offline'); changed();
    expect(pending).toHaveLength(4);
    pending[3].reject(new Error('offline'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(refreshes).toBe(2);
    states.set('a', 'offline'); changed();
    expect(pending).toHaveLength(5);
    states.set('a', 'revoked'); pending[4].resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(refreshes).toBe(2);
    states.set('a', 'offline'); changed();
    expect(pending).toHaveLength(6);
    client.dispose(); states.set('a', 'ready'); pending[5].resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(refreshes).toBe(2);
  });

  it('does not let an offline fanout target delay ready-bridge control and never publishes an expired queued mutation', async () => {
    const f = await setup(); f.runtime.disconnected('bridge-a');
    const list = f.client.publish(channel, { type: 'list_sessions', requestId: 'fanout', payload: {} });
    await vi.waitFor(() => expect(f.raw.publish.mock.calls.some(([, value]) => (value as SecureEnvelope).purpose === 'hello')).toBe(true));
    await f.client.publish(channel, { type: 'stop_session', requestId: 'ready-stop', payload: { bridgeId: 'bridge-b', sessionId: 'other' } });
    expect(f.raw.publish.mock.calls.some(([, value]) => (value as SecureEnvelope).messageId === 'ready-stop')).toBe(true);
    const now = Date.now();
    const stale = f.client.publish(channel, { type: 'stop_session', requestId: 'stale-stop', payload: { bridgeId: 'bridge-a', sessionId: 'session-one' } }, { deadline: now + 100 });
    const rejected = expect(stale).rejects.toMatchObject({ code: 'expired' });
    vi.spyOn(Date, 'now').mockReturnValue(now + 200);
    const helloPacket = f.raw.publish.mock.calls.map(([, value]) => value as SecureEnvelope).find(value => value.purpose === 'hello' && value.bridgeId === 'bridge-a')!;
    const hello = JSON.parse(new TextDecoder().decode(await open(f.a, f.browser.endpoint, helloPacket,
      { ownerId, bridgeId: 'bridge-a', channel, recipientId: f.a.endpoint.id, purpose: 'hello' })));
    const welcome = await seal(f.a, f.browser.endpoint, { ...helloPacket, senderId: f.a.endpoint.id, recipientId: f.browser.endpoint.id, purpose: 'welcome', createdAt: now + 200, expiresAt: now + 120000 },
      new TextEncoder().encode(JSON.stringify({ type: 'welcome', challenge: hello.challenge, receiverEpoch: 'new-boot-a' })));
    await f.runtime.receive(welcome, channel); await list; await rejected;
    expect(f.raw.publish.mock.calls.some(([, value]) => (value as SecureEnvelope).messageId === 'stale-stop')).toBe(false);
    f.client.dispose(); f.runtime.dispose();
  });

  it('cancels a caller-aborted request and invalidates queued sends on disposal', async () => {
    const f = await setup(); const cancellation = new AbortController();
    let release!: () => void;
    f.raw.publish.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const first = f.client.publish(channel, { type: 'list_sessions', requestId: 'blocking', payload: { bridgeId: 'bridge-a' } });
    await vi.waitFor(() => expect(f.raw.publish).toHaveBeenCalledOnce());
    const aborted = f.client.publish(channel, { type: 'stop_session', requestId: 'aborted', payload: { bridgeId: 'bridge-a' } }, { signal: cancellation.signal });
    const disposed = f.client.publish(channel, { type: 'stop_session', requestId: 'disposed', payload: { bridgeId: 'bridge-a' } });
    const rejected = Promise.all([expect(aborted).rejects.toMatchObject({ code: 'expired' }), expect(disposed).rejects.toMatchObject({ code: 'expired' })]);
    cancellation.abort(); f.client.dispose(); release(); await first; await rejected;
    expect(f.raw.publish).toHaveBeenCalledOnce(); f.runtime.dispose();
  });

  it('rechecks cancellation after asynchronous sealing and before broker publication', async () => {
    const f = await setup(); const cancellation = new AbortController();
    const sealApplication = f.runtime.sealApplication.bind(f.runtime);
    vi.spyOn(f.runtime, 'sealApplication').mockImplementation(async (...args) => {
      const packet = await sealApplication(...args); cancellation.abort(); return packet;
    });
    await expect(f.client.publish(channel, { type: 'stop_session', requestId: 'cancel-during-seal', payload: { bridgeId: 'bridge-a' } }, { signal: cancellation.signal })).rejects.toMatchObject({ code: 'expired' });
    expect(f.raw.publish).not.toHaveBeenCalled(); f.client.dispose(); f.runtime.dispose();
  });

  it('recovers only the restarted bridge with a fresh hello and snapshot signal without replaying its rejected mutation', async () => {
    const f = await setup(); const sub = f.raw.subscriptions.get(channel)!; let readRefresh = 0;
    f.raw.state = 'connected';
    f.client.getSubscription(channel)!.on('subscribed', () => { readRefresh++; });
    const emit = (packet: SecureEnvelope) => { const listener = sub.on.mock.calls.find(([event]) => event === 'publication')![1]; listener({ data: packet }); };
    f.raw.publish.mockImplementation(async (_channel, value) => {
      const packet = value as SecureEnvelope;
      const app = JSON.parse(new TextDecoder().decode(await open(f.a, f.browser.endpoint, packet,
        { ownerId, bridgeId: 'bridge-a', channel, recipientId: f.a.endpoint.id, purpose: packet.purpose })));
      const welcome = packet.purpose === 'hello';
      const body = welcome ? { type: 'welcome', challenge: app.challenge, receiverEpoch: 'restarted-boot' }
        : { type: 'application', route: { kind: 'response', requestId: packet.messageId }, data: { status: 403, body: { code: 'epoch_changed', outcomeUnknown: false } }, mcp: null };
      const now = Date.now();
      emit(await seal(f.a, f.browser.endpoint, { ...packet, senderId: f.a.endpoint.id, recipientId: f.browser.endpoint.id, purpose: welcome ? 'welcome' : 'application', createdAt: now, expiresAt: now + 120000 }, new TextEncoder().encode(JSON.stringify(body))));
    });
    await expect(f.client.request({ type: 'stop_session', requestId: 'rejected-once', payload: { bridgeId: 'bridge-a' } })).resolves.toMatchObject({ success: false, data: { code: 'epoch_changed' } });
    await vi.waitFor(() => expect(readRefresh).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(readRefresh).toBe(1);
    expect(f.runtime.state('bridge-a').status).toBe('ready'); expect(f.runtime.state('bridge-b').status).toBe('ready');
    expect(f.raw.publish.mock.calls.map(([, value]) => (value as SecureEnvelope).purpose)).toEqual(['application', 'hello']);
    const next = await f.runtime.sealApplication('bridge-a', channel, { type: 'application', route: { kind: 'command', command: 'list_sessions', requestId: 'fresh-read', sessionId: null }, data: {}, mcp: null });
    expect(next.receiverEpoch).toBe('restarted-boot');
    f.client.dispose(); f.runtime.dispose();
  });
  it('injects per-recipient bridge IDs for session-list fanout and keeps payloads opaque', async () => {
    const { browser, a, b, runtime, raw, client } = await setup();
    await client.publish(channel, { type: 'list_sessions', requestId: 'list-one', payload: {} });
    expect(raw.publish).toHaveBeenCalledTimes(2);
    for (const [, packet] of raw.publish.mock.calls) {
      const envelope = packet as SecureEnvelope; const bridge = envelope.bridgeId === 'bridge-a' ? a : b;
      const app = JSON.parse(new TextDecoder().decode(await open(bridge, browser.endpoint, envelope,
        { ownerId, bridgeId: envelope.bridgeId, channel, recipientId: bridge.endpoint.id, purpose: 'application' })));
      expect(app.data.payload.bridgeId).toBe(envelope.bridgeId); expect(envelope.messageId).toBe(app.route.requestId);
    }
    expect(JSON.stringify(raw.publish.mock.calls)).not.toContain('list_sessions'); client.dispose(); runtime.dispose();
  });

  it('normalizes terminal frames and never broadcasts unresolved targeted mutations', async () => {
    const { browser, a, runtime, raw, client } = await setup();
    const terminalChannel = `terminal-input:session-one#${userId}`;
    await client.publish(terminalChannel, { type: 'input', data: 'PRIVATE-MARKER' });
    const envelope = raw.publish.mock.calls[0][1] as SecureEnvelope;
    const app = JSON.parse(new TextDecoder().decode(await open(a, browser.endpoint, envelope,
      { ownerId, bridgeId: 'bridge-a', channel: terminalChannel, recipientId: a.endpoint.id, purpose: 'application' })));
    expect(app.route).toMatchObject({ kind: 'terminal', sessionId: 'session-one', frameType: 'input' });
    expect(app.data).toEqual({ kind: 'input', sessionId: 'session-one', data: 'PRIVATE-MARKER' });
    expect(JSON.stringify(raw.publish.mock.calls)).not.toContain('PRIVATE-MARKER');
    await expect(client.publish(channel, { type: 'stop_session', requestId: 'stop', payload: { sessionId: 'unmapped' } })).rejects.toMatchObject({ code: 'approval_required' });
    expect(raw.publish).toHaveBeenCalledTimes(1); client.dispose(); runtime.dispose();
  });

  it('binds pending completion to the targeted bridge and matching inner/outer request IDs', async () => {
    const { runtime, raw, client } = await setup();
    let resolved = false;
    const pending = client.request({ type: 'stop_session', requestId: 'stop-one', payload: { sessionId: 'session-one' } }).then(value => { resolved = true; return value; });
    await vi.waitFor(() => expect(raw.publish).toHaveBeenCalledTimes(1));
    const response = (requestId = 'stop-one'): SecureApplication => ({ type: 'application', route: { kind: 'response', requestId: 'stop-one' }, data: { type: 'command_response', response: { requestId, success: true } }, mcp: null });
    expect(client.observe('bridge-b', response())).toBe(false);
    expect(client.observe('bridge-a', response('different'))).toBe(false);
    await Promise.resolve(); expect(resolved).toBe(false);
    expect(client.observe('bridge-a', response())).toBe(true);
    await expect(pending).resolves.toMatchObject({ requestId: 'stop-one', success: true });
    client.dispose(); runtime.dispose();
  });
  it('rechecks the account ledger immediately before raw publication after awaited encryption', async () => {
    let approved = true;
    const f = await ledgerSetup(() => approved);
    const original = f.runtime.sealApplication.bind(f.runtime);
    vi.spyOn(f.runtime, 'sealApplication').mockImplementation(async (...args) => {
      const packet = await original(...args); approved = false; return packet;
    });
    await expect(f.client.publish(channel, { type: 'stop_session', requestId: 'expired-after-encrypt', payload: { bridgeId: 'bridge-a' } })).rejects.toMatchObject({ code: 'endpoint_revoked' });
    expect(f.raw.publish).not.toHaveBeenCalled();
    approved = true; f.client.dispose(); f.runtime.dispose();
  });

});

// ---- Account mode: a trusted computer that has not applied the newest ledger yet silently drops this browser's hello. ----
const FAST: ReadyRetryPolicy = { delaysMs: [5, 10, 20, 40], everyMs: 50, windowMs: 400, helloTimeoutMs: 30 };
async function waitingComputer(options: { knows: () => boolean; revoked?: () => boolean }) {
  const accountId = 'a'.repeat(43);
  const browser = await generateEndpoint(accountId, 'browser'); const a = await generateEndpoint(accountId, 'bridge');
  const checkpoint: LedgerCheckpoint = { version: 2, accountId, revision: 2, head: 'h'.repeat(43), authorities: [],
    devices: [{ endpoint: browser.endpoint, authPublicKey: 'device-key', label: 'Laptop', approvedAt: 0 }],
    bridges: [{ bridgeId: 'bridge-a', endpoint: a.endpoint, authPublicKey: 'bridge-key', label: 'Desk', approvedAt: 0 }], revokedDeviceIds: [], revokedBridgeIds: [] };
  const listeners = new Set<() => void>();
  const ledger: LedgerBridgeAuthority = { snapshot: () => ({ status: 'ready', checkpoint }), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    assertBridgeAccess: (bridgeId, endpointId) => { if (options.revoked?.() || bridgeId !== 'bridge-a' || endpointId !== a.endpoint.id) throw new Error('account_bridge_revoked'); } };
  const runtime = new SecureEndpointRuntime(browser, { ledger });
  const raw = new RawClient(); raw.state = 'connected';
  let hellos = 0;
  raw.publish.mockImplementation(async (_channel: string, packet: unknown) => {
    const envelope = packet as SecureEnvelope;
    if (envelope.purpose !== 'hello') return;
    hellos++;
    if (!options.knows()) return; // an unknown endpoint gets no answer at all
    const hello = JSON.parse(new TextDecoder().decode(await open(a, browser.endpoint, envelope,
      { ownerId: accountId, bridgeId: 'bridge-a', channel: envelope.channel, recipientId: a.endpoint.id, purpose: 'hello' })));
    const now = Date.now();
    await runtime.receive(await seal(a, browser.endpoint, { ...envelope, senderId: a.endpoint.id, recipientId: browser.endpoint.id, purpose: 'welcome', createdAt: now,
      expiresAt: now + 120000 }, new TextEncoder().encode(JSON.stringify({ type: 'welcome', challenge: hello.challenge, receiverEpoch: 'boot-a' }))), envelope.channel);
  });
  const handshake = vi.spyOn(runtime, 'handshake');
  const client = new SecureMessageClient(raw as unknown as Centrifuge, userId, runtime, { retry: FAST });
  const ledgerChanged = () => { for (const listener of [...listeners]) listener(); };
  return { runtime, raw, client, handshake, hellos: () => hellos, ledgerChanged };
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('account computer readiness after a new browser enrolls', () => {
  it('retries a trusted computer that answered nothing until it applies the ledger, then re-lists sessions', async () => {
    let knows = false;
    const f = await waitingComputer({ knows: () => knows });
    const subscribed = vi.fn(); f.client.getSubscription(channel)?.on('subscribed', subscribed);
    await expect(f.client.ensureReady('bridge-a')).rejects.toMatchObject({ code: 'bridge_offline' });
    expect(f.runtime.state('bridge-a').status).toBe('offline');
    await vi.waitFor(() => expect(f.hellos()).toBeGreaterThanOrEqual(2));
    knows = true;
    await vi.waitFor(() => expect(f.runtime.state('bridge-a').status).toBe('ready'), { timeout: 2000 });
    await vi.waitFor(() => expect(subscribed).toHaveBeenCalled());
    const settled = f.hellos(); await pause(150); expect(f.hellos()).toBe(settled);
    f.client.dispose(); f.runtime.dispose();
  });

  it('gives up after the window (the computer stays offline), and a ledger change re-evaluates it', async () => {
    let knows = false;
    const f = await waitingComputer({ knows: () => knows });
    await expect(f.client.ensureReady('bridge-a')).rejects.toBeTruthy();
    await pause(FAST.windowMs + 300);
    const spent = f.hellos(); expect(spent).toBeGreaterThan(4);
    await pause(200); expect(f.hellos()).toBe(spent); expect(f.runtime.state('bridge-a').status).toBe('offline');
    knows = true; f.ledgerChanged();
    await vi.waitFor(() => expect(f.runtime.state('bridge-a').status).toBe('ready'), { timeout: 2000 });
    f.client.dispose(); f.runtime.dispose();
  });

  it('never retries a computer whose access was revoked', async () => {
    let revoked = false;
    const f = await waitingComputer({ knows: () => false, revoked: () => revoked });
    await expect(f.client.ensureReady('bridge-a')).rejects.toBeTruthy();
    revoked = true;
    await pause(200);
    expect(f.handshake).toHaveBeenCalledTimes(2); // the first retry meets the revocation and stops
    await expect(f.handshake.mock.results[1].value).rejects.toMatchObject({ code: 'endpoint_revoked' });
    f.client.dispose(); f.runtime.dispose();
  });
});
