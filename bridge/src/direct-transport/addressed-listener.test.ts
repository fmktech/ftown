import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createSocket } from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeerConnection, cleanup } from 'node-datachannel';
import { ADDRESSED_CHANNEL_ID, ADDRESSED_UFRAG_PREFIX } from './contract.js';
import { loadOrCreateDtlsIdentity } from './dtls-identity.js';
import { AddressedListener, addressedPairId, inferredOffer, parseAddressedRequest, type AddressedConnection, type AddressedConnectionConfig, type AddressedMux, type UnhandledStunRequest } from './addressed-listener.js';
import type { DirectDataChannel } from './peer-manager.js';

// The library keeps worker threads alive until told to stop; without this the test process never exits.
after(() => { cleanup(); });

const PWD = 'abcdefghijklmnopqrstuvwx';
const request = (overrides: Partial<UnhandledStunRequest> = {}): UnhandledStunRequest =>
  ({ ufrag: 'uFr+', localUfrag: `${ADDRESSED_UFRAG_PREFIX}${PWD}`, host: '192.168.1.20', port: 50123, ...overrides });

test('the browser credentials are read back out of the STUN request', () => {
  assert.deepEqual(parseAddressedRequest(request()), { clientUfrag: 'uFr+', clientPwd: PWD, serverUfrag: `${ADDRESSED_UFRAG_PREFIX}${PWD}`, host: '192.168.1.20', port: 50123 });
  assert.equal(parseAddressedRequest(request({ host: 'fe80::1' }))?.host, 'fe80::1');
});

test('anything that is not a well-formed request of ours is ignored', () => {
  for (const bad of [
    request({ localUfrag: PWD }),                                           // not addressed to us
    request({ localUfrag: `ftown+direct+v2/${PWD}` }),                      // another version
    request({ localUfrag: `${ADDRESSED_UFRAG_PREFIX}short` }),              // password too short
    request({ localUfrag: `${ADDRESSED_UFRAG_PREFIX}${'a'.repeat(300)}` }), // too long
    request({ localUfrag: `${ADDRESSED_UFRAG_PREFIX}${PWD.slice(0, 20)}\r\na=x` }), // not ice-chars: would inject SDP lines
    request({ ufrag: 'abc' }),
    request({ ufrag: 'ab:c\r\n' }),
    request({ host: 'example.com' }),
    request({ host: '192.168.1.20\r\na=x' }),
    request({ port: 0 }),
    request({ port: 70_000 }),
    request({ port: 1.5 }),
  ]) assert.equal(parseAddressedRequest(bad), null, JSON.stringify(bad));
});

test('the pair id is derived from the browser credentials and is a valid channel token', () => {
  const id = addressedPairId('uFr+', PWD);
  assert.match(id, /^a[A-Za-z0-9_-]{43}$/);
  assert.equal(addressedPairId('uFr+', PWD), id);
  assert.notEqual(addressedPairId('uFr/', PWD), id);
  // The browser computes the same value with Web Crypto; this pins the exact encoding it has to reproduce.
  assert.equal(addressedPairId('abcd', 'ABCDEFGHIJKLMNOPQRSTUVWX'), 'aAH1KfcHwXRj-8L5ykn_qaR_F6l-WA_VYkrhOHl85rRk');
});

test('the inferred offer carries the browser credentials and its address', () => {
  const sdp = inferredOffer({ clientUfrag: 'uFr+', clientPwd: PWD, host: '10.0.0.7', port: 50123 });
  for (const line of ['a=ice-ufrag:uFr+', `a=ice-pwd:${PWD}`, 'c=IN IP4 10.0.0.7', 'a=setup:active', 'a=mid:0', 'a=candidate:1 1 UDP 1 10.0.0.7 50123 typ host']) assert.ok(sdp.split('\r\n').includes(line), line);
  assert.ok(inferredOffer({ clientUfrag: 'uFr+', clientPwd: PWD, host: 'fd00::7', port: 1 }).includes('c=IN IP6 fd00::7'));
});

class FakeChannel implements DirectDataChannel {
  sendMessage(): boolean { return true; } isOpen(): boolean { return false; } close(): void {}
  onOpen(): void {} onClosed(): void {} onError(): void {} onMessage(): void {}
}
class FakeConnection implements AddressedConnection {
  calls: unknown[][] = []; closed = false; channel = new FakeChannel();
  constructor(readonly name: string, readonly config: AddressedConnectionConfig) {}
  setRemoteDescription(sdp: string, type: string): void { this.calls.push(['remote', type, sdp]); }
  setLocalDescription(type: string, init: { iceUfrag: string; icePwd: string }): void { this.calls.push(['local', type, init]); }
  createDataChannel(label: string, config: { negotiated: boolean; id: number }): DirectDataChannel { this.calls.push(['channel', label, config]); return this.channel; }
  addRemoteCandidate(): void {} onLocalDescription(): void {} onLocalCandidate(): void {} onStateChange(): void {} onDataChannel(): void {}
  close(): void { this.closed = true; }
}
function fakeListener(adopt: (pairId: string) => boolean = () => true) {
  let deliver: (request: UnhandledStunRequest) => void = () => {};
  let stopped = false;
  const mux: AddressedMux = { onUnhandledStunRequest: cb => { deliver = cb; }, stop: () => { stopped = true; } };
  const connections: FakeConnection[] = [];
  const adopted: { pc: unknown; channel: unknown; pairId: string }[] = [];
  let now = 1_000_000;
  const listener = new AddressedListener({ port: 47000, identity: { certPath: '/id/cert.pem', keyPath: '/id/key.pem', fingerprint: 'AA' }, log: () => {},
    muxFactory: () => mux, now: () => now,
    connectionFactory: (name, config) => { const connection = new FakeConnection(name, config); connections.push(connection); return connection; },
    adopt: (pc, channel, pairId) => { adopted.push({ pc, channel, pairId }); return adopt(pairId); } });
  return { listener, connections, adopted, send: (r: UnhandledStunRequest) => deliver(r), advance: (ms: number) => { now += ms; }, stopped: () => stopped };
}

test('a first STUN request builds the matching connection and hands it over once, however often it is retransmitted', () => {
  const f = fakeListener();
  f.send(request()); f.send(request()); f.send(request({ port: 50124 }));
  assert.equal(f.connections.length, 1);
  const connection = f.connections[0];
  assert.deepEqual(connection.config, { iceServers: [], enableIceUdpMux: true, portRangeBegin: 47000, portRangeEnd: 47000,
    disableFingerprintVerification: true, disableAutoNegotiation: true, certificatePemFile: '/id/cert.pem', keyPemFile: '/id/key.pem' });
  assert.deepEqual(connection.calls[0], ['channel', '', { negotiated: true, id: ADDRESSED_CHANNEL_ID }]);
  assert.deepEqual(connection.calls[1], ['remote', 'offer', inferredOffer({ clientUfrag: 'uFr+', clientPwd: PWD, host: '192.168.1.20', port: 50123 })]);
  // The bridge answers under the name the browser chose for it, which doubles as its password.
  assert.deepEqual(connection.calls[2], ['local', 'answer', { iceUfrag: `${ADDRESSED_UFRAG_PREFIX}${PWD}`, icePwd: `${ADDRESSED_UFRAG_PREFIX}${PWD}` }]);
  assert.deepEqual(f.adopted, [{ pc: connection, channel: connection.channel, pairId: addressedPairId('uFr+', PWD) }]);
  assert.equal(connection.closed, false);
  // Long after the retransmissions have stopped, the same credentials may connect again.
  f.advance(31_000); f.send(request());
  assert.equal(f.connections.length, 2);
});

test('a connection the peer manager refuses is closed, and malformed requests build nothing', () => {
  const f = fakeListener(() => false);
  f.send(request());
  assert.equal(f.connections[0].closed, true);
  f.send(request({ localUfrag: 'someone-else' })); f.send(request({ host: 'nope' }));
  assert.equal(f.connections.length, 1);
});

test('one address can only start so many connections at a time, without affecting other addresses', () => {
  const f = fakeListener();
  const pwd = (n: number) => `${ADDRESSED_UFRAG_PREFIX}${PWD.slice(0, 20)}${String(n).padStart(4, '0')}`;
  for (let n = 0; n < 40; n++) f.send(request({ localUfrag: pwd(n) }));
  assert.equal(f.connections.length, 16);
  f.send(request({ localUfrag: pwd(99), host: '192.168.1.21' }));
  assert.equal(f.connections.length, 17);
  f.advance(31_000); f.send(request({ localUfrag: pwd(100) }));
  assert.equal(f.connections.length, 18);
});

test('stopping the listener stops the port and ignores later requests', () => {
  const f = fakeListener();
  f.listener.stop(); f.listener.stop();
  assert.equal(f.stopped(), true);
  f.send(request());
  assert.equal(f.connections.length, 0);
});

/** A UDP port that was free a moment ago. */
async function freePort(): Promise<number> {
  const socket = createSocket('udp4');
  await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return port;
}

test('a real connection opens with no signaling: the client knows only the address, port and fingerprint', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-addressed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const identity = loadOrCreateDtlsIdentity(dir);
  const port = await freePort();
  const received: string[] = [];
  const pairIds: string[] = [];
  const kept: unknown[] = [];
  const listener = new AddressedListener({ port, identity, log: () => {}, adopt: (pc, channel, pairId) => {
    kept.push(pc); pairIds.push(pairId);
    channel.onMessage(message => { received.push(String(message)); channel.sendMessage(`echo:${String(message)}`); });
    return true;
  } });
  t.after(() => listener.stop());

  // The client side, as a browser does it: an unmodified offer, then an answer it writes itself.
  const client = new PeerConnection('client', { iceServers: [], disableAutoNegotiation: true });
  t.after(() => client.close());
  const channel = client.createDataChannel('', { negotiated: true, id: ADDRESSED_CHANNEL_ID });
  const offer = await new Promise<string>(resolve => { client.onLocalDescription(sdp => resolve(sdp)); client.setLocalDescription('offer'); });
  const clientUfrag = /a=ice-ufrag:(\S+)/.exec(offer)![1];
  const clientPwd = /a=ice-pwd:(\S+)/.exec(offer)![1];
  const serverUfrag = `${ADDRESSED_UFRAG_PREFIX}${clientPwd}`;
  const answer = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=ice-lite', `m=application ${port} UDP/DTLS/SCTP webrtc-datachannel`, 'c=IN IP4 127.0.0.1',
    'a=mid:0', 'a=setup:passive', `a=ice-ufrag:${serverUfrag}`, `a=ice-pwd:${serverUfrag}`, `a=fingerprint:sha-256 ${identity.fingerprint}`,
    'a=sctp-port:5000', 'a=max-message-size:262144', `a=candidate:1 1 UDP 1 127.0.0.1 ${port} typ host`, 'a=end-of-candidates', ''].join('\r\n');
  const reply = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no reply over the addressed connection')), 15_000);
    channel.onMessage(message => { clearTimeout(timer); resolve(String(message)); });
    channel.onOpen(() => { channel.sendMessage('hello'); });
  });
  client.setRemoteDescription(answer, 'answer');
  assert.equal(await reply, 'echo:hello');
  assert.deepEqual(received, ['hello']);
  // Both ends derive the same pair id from the client's credentials alone.
  assert.deepEqual(pairIds, [addressedPairId(clientUfrag, clientPwd)]);
});
