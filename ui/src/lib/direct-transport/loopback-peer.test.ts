import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateEndpoint, open, seal } from '@security/crypto';
import type { SecureApplication, SecureEnvelope } from '@security/protocol';
import { SecureEndpointRuntime } from '../secure-endpoint-runtime';
import { LoopbackPeer, type WebSocketLike } from './loopback-peer';
import { LOOPBACK_TIMEOUT_MS, PING_INTERVAL_MS } from './contract';

const ownerId = '00000000-0000-4000-8000-000000000001';
class Socket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null; onmessage: WebSocketLike['onmessage'] = null;
  onerror: WebSocketLike['onerror'] = null; onclose: WebSocketLike['onclose'] = null;
  sent: unknown[] = []; wire: ((packet: SecureEnvelope) => Promise<void>) | null = null;
  constructor(readonly url: string) {}
  send(raw: string) { const packet = JSON.parse(raw) as SecureEnvelope; this.sent.push(packet); void this.wire?.(packet); }
  close() { this.readyState = 3; this.onclose?.(undefined); }
  open() { this.readyState = 1; this.onopen?.(undefined); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
afterEach(() => vi.useRealTimers());
async function fixture() {
  const browser = await generateEndpoint(ownerId, 'browser'); const bridge = await generateEndpoint(ownerId, 'bridge');
  const runtime = new SecureEndpointRuntime(browser, [{ bridgeId: 'bridge-one', endpoint: bridge.endpoint, permissions: ['read', 'control', 'admin'] }]);
  let socket!: Socket;
  const peer = new LoopbackPeer({ bridgeId: 'bridge-one', clientId: 'tab', port: 43127, nonce: 'legacy-capability', securityRuntime: runtime,
    wsFactory: url => socket = new Socket(url) });
  const connecting = peer.connect();
  const pairId = new URL(socket.url).searchParams.get('pairId')!;
  const channel = `direct:loopback-ws:bridge-one:${pairId}`;
  const received: SecureApplication[] = [];
  async function respond(data: unknown, purpose: 'welcome' | 'application', messageId = crypto.randomUUID()) {
    const now = Date.now();
    const packet = await seal(bridge, browser.endpoint, { type: 'ftown_encrypted', version: 1, senderId: bridge.endpoint.id, recipientId: browser.endpoint.id,
      ownerId, bridgeId: 'bridge-one', channel, purpose, messageId, createdAt: now, expiresAt: now + 120000, receiverEpoch: null }, new TextEncoder().encode(JSON.stringify(data)));
    socket.receive(packet); return packet;
  }
  socket.wire = async packet => {
    const plain = JSON.parse(new TextDecoder().decode(await open(bridge, browser.endpoint, packet,
      { ownerId, bridgeId: 'bridge-one', channel, recipientId: bridge.endpoint.id, purpose: packet.purpose })));
    if (packet.purpose === 'hello') await respond({ type: 'welcome', challenge: plain.challenge, receiverEpoch: 'boot-one' }, 'welcome', packet.messageId);
    else received.push(plain as SecureApplication);
  };
  return { peer, socket, runtime, connecting, pairId, received, respond };
}

describe('encrypted loopback peer', () => {
  it('uses a discovery pair ID without bearer nonce and gates connection on authenticated welcome', async () => {
    const f = await fixture(); let connected = false; void f.connecting.then(() => { connected = true; });
    expect(f.socket.url).not.toContain('legacy-capability'); expect(f.socket.url).not.toContain('nonce=');
    expect(connected).toBe(false); f.socket.open(); await f.connecting; expect(connected).toBe(true);
    expect(f.socket.sent[0]).toMatchObject({ type: 'ftown_encrypted', purpose: 'hello' }); f.peer.close(); f.runtime.dispose();
  });
  it('encrypts ordered attach/input/resize and authenticates output before delivery', async () => {
    const f = await fixture(); f.socket.open(); await f.connecting;
    const output = vi.fn(); f.peer.attach('session-one', { onOutput: output, onScreen: vi.fn() });
    f.peer.sendInput('session-one', 'PRIVATE-INPUT'); f.peer.sendResize('session-one', 90, 30);
    await vi.waitFor(() => expect(f.received).toHaveLength(3));
    expect(f.received.map(value => value.route.kind === 'terminal' && value.route.frameType)).toEqual(['attach', 'input', 'resize']);
    expect(JSON.stringify(f.socket.sent)).not.toContain('PRIVATE-INPUT');
    const encrypted = await f.respond({ type: 'application', route: { kind: 'terminal', sessionId: 'session-one', frameType: 'output', pairId: f.pairId }, data: { kind: 'output', sessionId: 'session-one', data: 'PRIVATE-OUTPUT' }, mcp: null }, 'application');
    await vi.waitFor(() => expect(output).toHaveBeenCalledExactlyOnceWith('PRIVATE-OUTPUT'));
    f.socket.receive(encrypted); await Promise.resolve(); expect(output).toHaveBeenCalledOnce(); f.peer.close(); f.runtime.dispose();
  });
  it('fails closed on a plaintext hello acknowledgement', async () => {
    const f = await fixture(); f.socket.wire = null; const rejected = expect(f.connecting).rejects.toThrow();
    f.socket.open(); f.socket.receive({ kind: 'hello_ack', protocolVersion: 1 });
    await rejected; expect(f.socket.readyState).toBe(3); f.runtime.dispose();
  });
  it('closes only its own socket if closed before handshake completion', async () => {
    const f = await fixture(); const rejected = expect(f.connecting).rejects.toThrow();
    f.peer.close(); await rejected; expect(f.socket.readyState).toBe(3); f.runtime.dispose();
  });
  it('rejects an unopened socket after the loopback budget and reports factory failures asynchronously', async () => {
    vi.useFakeTimers();
    let socket!: Socket;
    const peer = new LoopbackPeer({ bridgeId: 'bridge-one', clientId: 'tab', port: 43127, wsFactory: url => socket = new Socket(url) });
    const rejected = expect(peer.connect()).rejects.toThrow('loopback timeout');
    await vi.advanceTimersByTimeAsync(LOOPBACK_TIMEOUT_MS); await rejected; expect(socket.readyState).toBe(3);
    const broken = new LoopbackPeer({ bridgeId: 'bridge-one', clientId: 'tab', port: 43127, wsFactory: () => { throw new Error('mixed content'); } });
    await expect(broken.connect()).rejects.toThrow('mixed content');
  });
  it('preserves screen/output ordering and isolates detached sessions', async () => {
    const f = await fixture(); f.socket.open(); await f.connecting;
    const frames: string[] = []; const other = vi.fn();
    f.peer.attach('session-one', { onScreen: data => frames.push(`screen:${data}`), onOutput: data => frames.push(`output:${data}`) });
    f.peer.attach('session-two', { onScreen: other, onOutput: other });
    for (const [kind, sessionId, data] of [['screen', 'session-one', 'snapshot'], ['output', 'session-one', 'delta'], ['output', 'unknown', 'foreign']] as const) {
      await f.respond({ type: 'application', route: { kind: 'terminal', sessionId, frameType: kind, pairId: f.pairId }, data: { kind, sessionId, data, seq: 1 }, mcp: null }, 'application');
    }
    await vi.waitFor(() => expect(frames).toEqual(['screen:snapshot', 'output:delta'])); expect(other).not.toHaveBeenCalled();
    f.peer.detach('session-one');
    await f.respond({ type: 'application', route: { kind: 'terminal', sessionId: 'session-one', frameType: 'output', pairId: f.pairId }, data: { kind: 'output', sessionId: 'session-one', data: 'detached', seq: 2 }, mcp: null }, 'application');
    await f.respond({ type: 'application', route: { kind: 'terminal', sessionId: 'session-two', frameType: 'output', pairId: f.pairId }, data: { kind: 'output', sessionId: 'session-two', data: 'sibling', seq: 1 }, mcp: null }, 'application');
    await vi.waitFor(() => expect(other).toHaveBeenCalledExactlyOnceWith('sibling')); expect(frames).toHaveLength(2);
    await vi.waitFor(() => expect(f.received.some(app => app.route.kind === 'terminal' && app.route.frameType === 'detach')).toBe(true));
    f.peer.close(); f.runtime.dispose();
  });
  it('resets missed pongs and closes only the unresponsive encrypted peer', async () => {
    vi.useFakeTimers(); const f = await fixture(); const sibling = await fixture();
    f.socket.open(); sibling.socket.open(); await Promise.all([f.connecting, sibling.connecting]);
    const closed = vi.fn(); f.peer.onClose(closed);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 2);
    await sibling.respond({ type: 'application', route: { kind: 'terminal', sessionId: '', frameType: 'pong', pairId: sibling.pairId }, data: { kind: 'pong' }, mcp: null }, 'application');
    // A following ping/pong exchange proves the earlier pong was processed in order.
    await sibling.respond({ type: 'application', route: { kind: 'terminal', sessionId: '', frameType: 'ping', pairId: sibling.pairId }, data: { kind: 'ping' }, mcp: null }, 'application');
    await vi.waitFor(() => expect(sibling.received.some(app => app.route.kind === 'terminal' && app.route.frameType === 'pong')).toBe(true));
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(f.socket.readyState).toBe(3); expect(closed).toHaveBeenCalledOnce(); expect(sibling.socket.readyState).toBe(1);
    sibling.peer.close(); f.runtime.dispose(); sibling.runtime.dispose();
  });
});
