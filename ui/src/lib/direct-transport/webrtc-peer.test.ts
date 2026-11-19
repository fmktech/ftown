import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateEndpoint, open, seal } from '@security/crypto';
import type { SecureApplication, SecureEnvelope } from '@security/protocol';
import { SecureEndpointRuntime } from '../secure-endpoint-runtime';
import { WebRtcPeer, addressedAnswer, addressedPairId, toIceCandidateInit, validPeerAddress } from './webrtc-peer';
import { ADDRESSED_TIMEOUT_MS, ADDRESSED_UFRAG_PREFIX, PAIR_TIMEOUT_MS, PING_INTERVAL_MS, type SignalMessage } from './contract';

const ownerId = '00000000-0000-4000-8000-000000000001';
class Channel {
  readyState = 'connecting'; onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: unknown[] = []; wire: ((packet: SecureEnvelope) => Promise<void>) | null = null;
  send(raw: string) { const packet = JSON.parse(raw) as SecureEnvelope; this.sent.push(packet); void this.wire?.(packet); }
  close() { this.readyState = 'closed'; this.onclose?.(); }
  open() { this.readyState = 'open'; this.onopen?.(); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
class Connection {
  static instances: Connection[] = [];
  channel = new Channel(); iceConnectionState = 'new'; onicecandidate: unknown; oniceconnectionstatechange: unknown;
  remote: unknown; candidates: unknown[] = [];
  constructor() { Connection.instances.push(this); }
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: 'offer', sdp: 'private-sdp' }; }
  async setLocalDescription() {}
  async setRemoteDescription(value: unknown) { this.remote = value; }
  async addIceCandidate(value: unknown) { this.candidates.push(value); }
  close() { this.channel.close(); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
async function fixture() {
  Connection.instances = []; vi.stubGlobal('RTCPeerConnection', Connection);
  const browser = await generateEndpoint(ownerId, 'browser'); const bridge = await generateEndpoint(ownerId, 'bridge');
  const runtime = new SecureEndpointRuntime(browser, [{ bridgeId: 'bridge-one', endpoint: bridge.endpoint, permissions: ['read', 'control', 'admin'] }]);
  const signals: SignalMessage[] = [];
  const peer = new WebRtcPeer({ bridgeId: 'bridge-one', clientId: 'tab', securityRuntime: runtime, sendSignal: message => signals.push(message) });
  const connecting = peer.connect(); await vi.waitFor(() => expect(signals.some(signal => signal.type === 'webrtc_offer')).toBe(true));
  const pairId = signals[0].pairId; const channelName = `direct:webrtc:bridge-one:${pairId}`;
  const connection = Connection.instances[0]; const received: SecureApplication[] = [];
  async function respond(data: unknown, purpose: 'welcome' | 'application', messageId = crypto.randomUUID()) {
    const now = Date.now();
    const packet = await seal(bridge, browser.endpoint, { type: 'ftown_encrypted', version: 1, senderId: bridge.endpoint.id, recipientId: browser.endpoint.id,
      ownerId, bridgeId: 'bridge-one', channel: channelName, purpose, messageId, createdAt: now, expiresAt: now + 120000, receiverEpoch: null }, new TextEncoder().encode(JSON.stringify(data)));
    connection.channel.receive(packet);
  }
  connection.channel.wire = async packet => {
    const plain = JSON.parse(new TextDecoder().decode(await open(bridge, browser.endpoint, packet,
      { ownerId, bridgeId: 'bridge-one', channel: channelName, recipientId: bridge.endpoint.id, purpose: packet.purpose })));
    if (packet.purpose === 'hello') await respond({ type: 'welcome', challenge: plain.challenge, receiverEpoch: 'boot-one' }, 'welcome', packet.messageId);
    else received.push(plain as SecureApplication);
  };
  return { peer, runtime, connecting, connection, signals, pairId, received, respond };
}

describe('encrypted WebRTC peer', () => {
  it('requires an authenticated endpoint welcome after the data channel opens', async () => {
    const f = await fixture(); let connected = false; void f.connecting.then(() => { connected = true; });
    expect(connected).toBe(false); f.connection.channel.open(); await f.connecting; expect(connected).toBe(true);
    expect(f.connection.channel.sent[0]).toMatchObject({ type: 'ftown_encrypted', purpose: 'hello' }); f.peer.close(); f.runtime.dispose();
  });
  it('preserves encrypted terminal ordering and binds output to the negotiated pair', async () => {
    const f = await fixture(); f.connection.channel.open(); await f.connecting;
    const output = vi.fn(); f.peer.attach('session-one', { onOutput: output, onScreen: vi.fn() }); f.peer.sendInput('session-one', 'PRIVATE-INPUT');
    await vi.waitFor(() => expect(f.received).toHaveLength(2));
    expect(f.received.map(value => value.route.kind === 'terminal' && value.route.frameType)).toEqual(['attach', 'input']);
    expect(JSON.stringify(f.connection.channel.sent)).not.toContain('PRIVATE-INPUT');
    await f.respond({ type: 'application', route: { kind: 'terminal', sessionId: 'session-one', frameType: 'output', pairId: 'wrong-pair' }, data: { kind: 'output', sessionId: 'session-one', data: 'wrong' }, mcp: null }, 'application');
    await f.respond({ type: 'application', route: { kind: 'terminal', sessionId: 'session-one', frameType: 'output', pairId: f.pairId }, data: { kind: 'output', sessionId: 'session-one', data: 'right' }, mcp: null }, 'application');
    await vi.waitFor(() => expect(output).toHaveBeenCalledExactlyOnceWith('right')); f.peer.close(); f.runtime.dispose();
  });
  it('rejects a plaintext acknowledgement without enabling terminal controls', async () => {
    const f = await fixture(); f.connection.channel.wire = null; const rejected = expect(f.connecting).rejects.toThrow();
    f.connection.channel.open(); f.connection.channel.receive({ kind: 'hello_ack', protocolVersion: 1 });
    await rejected; expect(f.connection.channel.readyState).toBe('closed'); f.runtime.dispose();
  });
  it('ignores signaling for another bridge or pair', async () => {
    const f = await fixture();
    f.peer.handleSignal({ type: 'webrtc_answer', bridgeId: 'foreign', clientId: 'tab', pairId: f.pairId, payload: 'foreign-sdp' });
    await Promise.resolve(); expect(f.connection.remote).toBeUndefined();
    const rejected = expect(f.connecting).rejects.toThrow(); f.peer.close(); await rejected; f.runtime.dispose();
  });
  it('times out pairing and tears down its data channel', async () => {
    vi.useFakeTimers(); const f = await fixture(); const rejected = expect(f.connecting).rejects.toThrow('pair timeout');
    await vi.advanceTimersByTimeAsync(PAIR_TIMEOUT_MS); await rejected;
    expect(f.connection.channel.readyState).toBe('closed'); expect(f.signals.at(-1)?.type).toBe('webrtc_close'); f.runtime.dispose();
  });
  it('sends its offer and local ICE, queues early ICE until a matching answer, and ignores malformed candidates', async () => {
    const f = await fixture();
    expect(f.signals[0]).toMatchObject({ type: 'webrtc_offer', bridgeId: 'bridge-one', clientId: 'tab', payload: 'private-sdp' });
    const local = { candidate: 'local-ice', sdpMid: '0' };
    (f.connection.onicecandidate as (event: unknown) => void)({ candidate: { toJSON: () => local } });
    expect(f.signals[1]).toMatchObject({ type: 'webrtc_ice', pairId: f.pairId, payload: JSON.stringify(local) });
    const signal = (type: 'webrtc_answer' | 'webrtc_ice', payload: string): SignalMessage => ({ type, bridgeId: 'bridge-one', clientId: 'tab', pairId: f.pairId, payload });
    const early = { candidate: 'early-ice' }; const late = { candidate: 'late-ice' };
    f.peer.handleSignal(signal('webrtc_ice', JSON.stringify(early))); expect(f.connection.candidates).toEqual([]);
    f.peer.handleSignal({ ...signal('webrtc_answer', 'foreign'), pairId: 'foreign-pair' }); expect(f.connection.remote).toBeUndefined();
    f.peer.handleSignal(signal('webrtc_ice', 'not-json'));
    f.peer.handleSignal(signal('webrtc_answer', 'remote-sdp'));
    await vi.waitFor(() => expect(f.connection.candidates).toEqual([{ ...early, sdpMLineIndex: 0 }]));
    expect(f.connection.remote).toEqual({ type: 'answer', sdp: 'remote-sdp' });
    f.peer.handleSignal(signal('webrtc_ice', JSON.stringify(late)));
    await vi.waitFor(() => expect(f.connection.candidates).toEqual([{ ...early, sdpMLineIndex: 0 }, { ...late, sdpMLineIndex: 0 }]));
    const rejected = expect(f.connecting).rejects.toThrow(); f.peer.close(); await rejected; f.runtime.dispose();
  });
  it('accepts the bridge\'s { candidate, mid } ICE shape, which addIceCandidate would otherwise reject', () => {
    expect(toIceCandidateInit({ candidate: 'a=candidate:1 1 UDP 2114977791 192.168.68.70 34034 typ host', mid: '0' }))
      .toEqual({ candidate: 'candidate:1 1 UDP 2114977791 192.168.68.70 34034 typ host', sdpMid: '0' });
    expect(toIceCandidateInit({ candidate: 'candidate:x', mid: '' })).toEqual({ candidate: 'candidate:x', sdpMLineIndex: 0 });
    expect(toIceCandidateInit({ candidate: 'candidate:x', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'u' }))
      .toEqual({ candidate: 'candidate:x', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'u' });
    for (const bad of [null, 'candidate:x', [], {}, { candidate: 7 }]) expect(toIceCandidateInit(bad)).toBeNull();
  });
  it('delivers the screen before output and stops detached sessions without affecting siblings', async () => {
    const f = await fixture(); f.connection.channel.open(); await f.connecting;
    const frames: string[] = []; const other = vi.fn();
    f.peer.attach('one', { onScreen: data => frames.push(`screen:${data}`), onOutput: data => frames.push(`output:${data}`) });
    f.peer.attach('two', { onScreen: other, onOutput: other });
    const terminal = async (sessionId: string, kind: 'screen' | 'output', data: string) => f.respond({ type: 'application', route: { kind: 'terminal', sessionId, frameType: kind, pairId: f.pairId }, data: { kind, sessionId, data, seq: 1 }, mcp: null }, 'application');
    await terminal('one', 'screen', 'snapshot'); await terminal('one', 'output', 'delta'); await terminal('unknown', 'output', 'foreign');
    await vi.waitFor(() => expect(frames).toEqual(['screen:snapshot', 'output:delta'])); expect(other).not.toHaveBeenCalled();
    f.peer.detach('one'); await terminal('one', 'output', 'detached'); await terminal('two', 'output', 'sibling');
    await vi.waitFor(() => expect(other).toHaveBeenCalledExactlyOnceWith('sibling')); expect(frames).toHaveLength(2);
    await vi.waitFor(() => expect(f.received.some(app => app.route.kind === 'terminal' && app.route.frameType === 'detach')).toBe(true));
    f.peer.close(); f.runtime.dispose();
  });
  it('resets missed pongs while closing an unresponsive sibling independently', async () => {
    vi.useFakeTimers(); const f = await fixture(); const sibling = await fixture();
    f.connection.channel.open(); sibling.connection.channel.open(); await Promise.all([f.connecting, sibling.connecting]);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 2);
    await sibling.respond({ type: 'application', route: { kind: 'terminal', sessionId: '', frameType: 'pong', pairId: sibling.pairId }, data: { kind: 'pong' }, mcp: null }, 'application');
    await sibling.respond({ type: 'application', route: { kind: 'terminal', sessionId: '', frameType: 'ping', pairId: sibling.pairId }, data: { kind: 'ping' }, mcp: null }, 'application');
    await vi.waitFor(() => expect(sibling.received.some(app => app.route.kind === 'terminal' && app.route.frameType === 'pong')).toBe(true));
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(f.connection.channel.readyState).toBe('closed'); expect(sibling.connection.channel.readyState).toBe('open');
    sibling.peer.close(); f.runtime.dispose(); sibling.runtime.dispose();
  });
});

describe('connecting to a remembered address with no signaling', () => {
  const FINGERPRINT = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const address = { ip: '192.168.1.20', port: 47001, fingerprint: FINGERPRINT };
  const PWD = 'ABCDEFGHIJKLMNOPQRSTUVWX';
  const OFFER = ['v=0', 'a=ice-ufrag:abcd', `a=ice-pwd:${PWD}`, ''].join('\r\n');

  /** A connection that reports the offer it was given as its local description, as a browser does. */
  class AddressedConnection extends Connection {
    localDescription: { sdp: string } | null = null; channelArgs: unknown[] = []; local: unknown;
    override createDataChannel(...args: unknown[]) { this.channelArgs = args; return this.channel; }
    override async createOffer() { return { type: 'offer', sdp: OFFER }; }
    override async setLocalDescription(value?: unknown) { this.local = value; this.localDescription = { sdp: OFFER }; }
  }
  async function addressed(options: { address?: unknown } = {}) {
    Connection.instances = []; vi.stubGlobal('RTCPeerConnection', AddressedConnection);
    const browser = await generateEndpoint(ownerId, 'browser'); const bridge = await generateEndpoint(ownerId, 'bridge');
    const runtime = new SecureEndpointRuntime(browser, [{ bridgeId: 'bridge-one', endpoint: bridge.endpoint, permissions: ['read', 'control', 'admin'] }]);
    const signals: SignalMessage[] = [];
    const peer = new WebRtcPeer({ bridgeId: 'bridge-one', clientId: 'tab', securityRuntime: runtime, sendSignal: message => signals.push(message),
      address: (options.address ?? address) as typeof address });
    const connecting = peer.connect();
    connecting.catch(() => {});
    return { peer, runtime, connecting, signals, bridge, browser, connection: () => Connection.instances[0] as AddressedConnection };
  }

  it('derives the same pair id as the bridge and writes the bridge\'s answer itself', async () => {
    // The value the bridge's addressed-listener test pins for the same credentials.
    expect(await addressedPairId('abcd', PWD)).toBe('aAH1KfcHwXRj-8L5ykn_qaR_F6l-WA_VYkrhOHl85rRk');
    const lines = addressedAnswer(address, PWD).split('\r\n');
    for (const line of ['a=ice-lite', 'a=setup:passive', 'a=mid:0', `a=ice-ufrag:${ADDRESSED_UFRAG_PREFIX}${PWD}`, `a=ice-pwd:${ADDRESSED_UFRAG_PREFIX}${PWD}`,
      `a=fingerprint:sha-256 ${FINGERPRINT}`, 'c=IN IP4 192.168.1.20', 'm=application 47001 UDP/DTLS/SCTP webrtc-datachannel', 'a=candidate:1 1 UDP 1 192.168.1.20 47001 typ host']) expect(lines).toContain(line);
  });

  it('accepts only an address that can be written into SDP as it is', () => {
    expect(validPeerAddress(address)).toBe(true);
    for (const bad of [null, [], {}, { ...address, ip: '192.168.1.20\r\na=x' }, { ...address, ip: 'example.com' }, { ...address, ip: '999.1.1.1' }, { ...address, ip: 'fd00::1' },
      { ...address, port: 0 }, { ...address, port: 70000 }, { ...address, port: '47001' }, { ...address, fingerprint: 'AA:BB' }, { ...address, fingerprint: FINGERPRINT.toLowerCase() },
      { ...address, fingerprint: `${FINGERPRINT}\r\na=x` }]) expect(validPeerAddress(bad)).toBe(false);
  });

  it('sets its own offer unchanged, then the written answer, on a pre-negotiated channel, and signals nothing', async () => {
    const f = await addressed();
    await vi.waitFor(() => expect(f.connection()?.remote).toBeDefined());
    const connection = f.connection();
    expect(connection.channelArgs).toEqual(['', { negotiated: true, id: 0, ordered: true }]);
    // The offer goes in exactly as the browser made it: no credential is rewritten.
    expect(connection.local).toEqual({ type: 'offer', sdp: OFFER });
    expect(connection.remote).toEqual({ type: 'answer', sdp: addressedAnswer(address, PWD) });
    expect(connection.onicecandidate).toBeUndefined();
    expect(f.signals).toEqual([]);
    // The encrypted channel is bound to the pair id both sides derive from the ICE credentials.
    const pairId = await addressedPairId('abcd', PWD); const channelName = `direct:webrtc:bridge-one:${pairId}`;
    connection.channel.wire = async packet => {
      const plain = JSON.parse(new TextDecoder().decode(await open(f.bridge, f.browser.endpoint, packet,
        { ownerId, bridgeId: 'bridge-one', channel: channelName, recipientId: f.bridge.endpoint.id, purpose: packet.purpose })));
      const now = Date.now();
      connection.channel.receive(await seal(f.bridge, f.browser.endpoint, { type: 'ftown_encrypted', version: 1, senderId: f.bridge.endpoint.id, recipientId: f.browser.endpoint.id,
        ownerId, bridgeId: 'bridge-one', channel: channelName, purpose: 'welcome', messageId: packet.messageId, createdAt: now, expiresAt: now + 120000, receiverEpoch: null },
        new TextEncoder().encode(JSON.stringify({ type: 'welcome', challenge: plain.challenge, receiverEpoch: 'boot-one' }))));
    };
    connection.channel.open();
    await f.connecting;
    // Signals addressed to this peer are not for it, and closing sends none.
    f.peer.handleSignal({ type: 'webrtc_answer', bridgeId: 'bridge-one', clientId: 'tab', pairId, payload: 'other-sdp' });
    expect(connection.remote).toEqual({ type: 'answer', sdp: addressedAnswer(address, PWD) });
    f.peer.close();
    expect(f.signals).toEqual([]);
    f.runtime.dispose();
  });

  it('gives up quickly when the address does not answer', async () => {
    vi.useFakeTimers();
    const f = await addressed();
    const rejected = expect(f.connecting).rejects.toThrow('pair timeout');
    await vi.advanceTimersByTimeAsync(ADDRESSED_TIMEOUT_MS);
    await rejected;
    expect(ADDRESSED_TIMEOUT_MS).toBeLessThan(PAIR_TIMEOUT_MS);
    expect(f.signals).toEqual([]);
    f.runtime.dispose();
  });

  it('refuses a malformed address before opening anything', async () => {
    const f = await addressed({ address: { ...address, ip: '192.168.1.20\r\na=candidate:evil' } });
    await expect(f.connecting).rejects.toThrow('invalid address');
    expect(Connection.instances).toEqual([]);
    f.runtime.dispose();
  });
});
