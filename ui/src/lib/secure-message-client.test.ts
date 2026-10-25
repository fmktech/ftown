import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Centrifuge } from 'centrifuge';
import type { EndpointIdentity, SecureApplication, SecureEnvelope } from '@security/protocol';
import { generateEndpoint, open, seal } from '@security/crypto';
import { SecureEndpointRuntime } from './secure-endpoint-runtime';
import { SecureMessageClient } from './secure-message-client';

const ownerId = '00000000-0000-4000-8000-000000000001';
const userId = 'owner@example.test';
const channel = `commands:rpc#${userId}`;
afterEach(() => vi.restoreAllMocks());
class RawSubscription {
  state = 'subscribed'; on = vi.fn(); off = vi.fn(); subscribe = vi.fn(); unsubscribe = vi.fn();
  presence = vi.fn(async () => ({ clients: {} }));
}
class RawClient {
  subscriptions = new Map<string, RawSubscription>();
  publish = vi.fn(async (_channel: string, _data: unknown) => {});
  on = vi.fn(); off = vi.fn(); removeSubscription = vi.fn();
  getSubscription(channel: string) { return this.subscriptions.get(channel) ?? null; }
  newSubscription(channel: string) { const sub = new RawSubscription(); this.subscriptions.set(channel, sub); return sub; }
}
async function establish(runtime: SecureEndpointRuntime, bridgeId: string, bridge: EndpointIdentity) {
  await runtime.handshake(bridgeId, channel, async packet => {
    const envelope = packet as SecureEnvelope;
    const hello = JSON.parse(new TextDecoder().decode(await open(bridge, runtime.identity.endpoint, envelope,
      { ownerId, bridgeId, channel, recipientId: bridge.endpoint.id, purpose: 'hello' })));
    const now = Date.now();
    const reply = await seal(bridge, runtime.identity.endpoint, { ...envelope, senderId: bridge.endpoint.id, recipientId: runtime.identity.endpoint.id,
      purpose: 'welcome', createdAt: now, expiresAt: now + 120000 }, new TextEncoder().encode(JSON.stringify({ type: 'welcome', challenge: hello.challenge, receiverEpoch: `boot-${bridgeId}` })));
    await runtime.receive(reply, channel);
  });
}
async function setup(authority?: (bridgeId: string) => void) {
  const browser = await generateEndpoint(ownerId, 'browser'); const a = await generateEndpoint(ownerId, 'bridge'); const b = await generateEndpoint(ownerId, 'bridge');
  const runtime = new SecureEndpointRuntime(browser, [{ bridgeId: 'bridge-a', endpoint: a.endpoint, permissions: ['read', 'control', 'admin'] }, { bridgeId: 'bridge-b', endpoint: b.endpoint, permissions: ['read', 'control', 'admin'] }], authority);
  await establish(runtime, 'bridge-a', a); await establish(runtime, 'bridge-b', b);
  const raw = new RawClient(); const client = new SecureMessageClient(raw as unknown as Centrifuge, userId, runtime);
  client.observe('bridge-a', { type: 'application', route: { kind: 'publication' }, data: { type: 'session_update', session: { id: 'session-one', bridgeId: 'bridge-a' } }, mcp: null });
  return { browser, a, b, runtime, raw, client };
}

describe('secure broker adapter', () => {
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
  it('rechecks account authority immediately before raw publication after awaited encryption', async () => {
    let approved = true;
    const f = await setup(id => { if (id === 'bridge-a' && !approved) throw new Error('Account authority expired'); });
    const original = f.runtime.sealApplication.bind(f.runtime);
    vi.spyOn(f.runtime, 'sealApplication').mockImplementation(async (...args) => {
      const packet = await original(...args); approved = false; return packet;
    });
    await expect(f.client.publish(channel, { type: 'stop_session', requestId: 'expired-after-encrypt', payload: { bridgeId: 'bridge-a' } })).rejects.toThrow('Account authority expired');
    expect(f.raw.publish).not.toHaveBeenCalled();
    approved = true; f.client.dispose(); f.runtime.dispose();
  });

});
