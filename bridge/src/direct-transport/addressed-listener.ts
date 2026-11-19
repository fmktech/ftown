import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { IceUdpMuxListener, PeerConnection } from 'node-datachannel';
import { ADDRESSED_CHANNEL_ID, ADDRESSED_UFRAG_PREFIX } from './contract.js';
import type { DtlsIdentity } from './dtls-identity.js';
import type { DirectDataChannel, DirectPeerConnection } from './peer-manager.js';

/**
 * Accepts browsers that connect to the bridge's fixed UDP port without any signaling.
 *
 * A browser that remembers the bridge's address, port and certificate fingerprint writes both halves of the WebRTC exchange
 * itself and starts sending STUN checks. The first check arrives here for a username nobody is serving yet. It carries everything
 * the bridge needs: the browser's ICE username fragment, and, inside the fragment the browser chose for the bridge, the browser's
 * ICE password (see ADDRESSED_UFRAG_PREFIX). The bridge builds the matching connection and the check succeeds on its retry.
 *
 * Reaching this port proves nothing. The connection is handed to the peer manager, where the encrypted hello decides, as on every
 * other transport, who the peer is and what it may do.
 */

/** One STUN request for a username no connection is serving, as the mux reports it. */
export interface UnhandledStunRequest {
  /** The sender's ICE username fragment. */
  ufrag: string;
  /** The username fragment the sender addressed, which is the one it chose for this bridge. */
  localUfrag: string;
  host: string;
  port: number;
}
export interface AddressedMux {
  onUnhandledStunRequest(cb: (request: UnhandledStunRequest) => void): void;
  stop(): void;
}
/** The part of a node-datachannel PeerConnection an addressed connection uses (injectable for tests). */
export interface AddressedConnection extends DirectPeerConnection {
  setLocalDescription(type: string, init: { iceUfrag: string; icePwd: string }): void;
  createDataChannel(label: string, config: { negotiated: boolean; id: number }): DirectDataChannel;
}
export interface AddressedConnectionConfig {
  iceServers: string[];
  enableIceUdpMux: true;
  portRangeBegin: number;
  portRangeEnd: number;
  disableFingerprintVerification: true;
  disableAutoNegotiation: true;
  certificatePemFile: string;
  keyPemFile: string;
}

export interface AddressedListenerOptions {
  port: number;
  identity: DtlsIdentity;
  /** Takes the connection over; false means it was refused and is closed here. */
  adopt: (pc: DirectPeerConnection, channel: DirectDataChannel, pairId: string) => boolean;
  muxFactory?: (port: number) => AddressedMux;
  connectionFactory?: (name: string, config: AddressedConnectionConfig) => AddressedConnection;
  now?: () => number;
  log?: (message: string) => void;
}

/** RFC 5245 ice-char. */
const ICE_CHARS = /^[A-Za-z0-9+/]+$/;
const MAX_ICE_CHARS = 256;
/** A STUN check is retransmitted until answered; the same one must not start a second connection. */
const SEEN_FOR_MS = 30_000;
const MAX_SEEN = 1_024;
/** New connections one address may start within SEEN_FOR_MS. */
const MAX_PER_HOST = 16;

/**
 * The pair id of an addressed connection. Both sides derive it from the browser's ICE credentials, so the encrypted channel is
 * bound to this very connection without either side having to announce an id first.
 */
export function addressedPairId(clientUfrag: string, clientPwd: string): string {
  return `a${createHash('sha256').update(`${clientUfrag}:${clientPwd}`, 'utf8').digest('base64url')}`;
}

/** The browser's credentials from one unhandled STUN request, or null when the request is not a well-formed one of ours. */
export function parseAddressedRequest(request: UnhandledStunRequest): { clientUfrag: string; clientPwd: string; serverUfrag: string; host: string; port: number } | null {
  const { ufrag: clientUfrag, localUfrag: serverUfrag, host, port } = request;
  if (typeof clientUfrag !== 'string' || typeof serverUfrag !== 'string' || typeof host !== 'string') return null;
  if (!serverUfrag.startsWith(ADDRESSED_UFRAG_PREFIX) || serverUfrag.length > MAX_ICE_CHARS || !ICE_CHARS.test(serverUfrag)) return null;
  if (clientUfrag.length < 4 || clientUfrag.length > MAX_ICE_CHARS || !ICE_CHARS.test(clientUfrag)) return null;
  const clientPwd = serverUfrag.slice(ADDRESSED_UFRAG_PREFIX.length);
  if (clientPwd.length < 22) return null;
  if (!isIP(host) || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { clientUfrag, clientPwd, serverUfrag, host, port };
}

/**
 * The offer the browser would have sent, rebuilt from its STUN request. The fingerprint is a placeholder: the bridge does not
 * verify the browser's certificate (it cannot know it), and relies on the encrypted hello instead.
 */
export function inferredOffer(peer: { clientUfrag: string; clientPwd: string; host: string; port: number }): string {
  const family = isIP(peer.host) === 6 ? 'IP6' : 'IP4';
  return ['v=0', `o=- 0 0 IN ${family} ${peer.host}`, 's=-', 't=0 0',
    `m=application ${peer.port} UDP/DTLS/SCTP webrtc-datachannel`, `c=IN ${family} ${peer.host}`,
    'a=mid:0', 'a=setup:active', `a=ice-ufrag:${peer.clientUfrag}`, `a=ice-pwd:${peer.clientPwd}`,
    `a=fingerprint:sha-256 ${Array<string>(32).fill('00').join(':')}`, 'a=sctp-port:5000', 'a=max-message-size:262144',
    `a=candidate:1 1 UDP 1 ${peer.host} ${peer.port} typ host`, 'a=end-of-candidates', ''].join('\r\n');
}

export class AddressedListener {
  readonly port: number;
  private readonly identity: DtlsIdentity;
  private readonly adopt: AddressedListenerOptions['adopt'];
  private readonly connectionFactory: NonNullable<AddressedListenerOptions['connectionFactory']>;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly mux: AddressedMux;
  /** Requests already acted on, by browser credentials, with when and from where. */
  private readonly seen = new Map<string, { at: number; host: string }>();
  private stopped = false;

  constructor(options: AddressedListenerOptions) {
    this.port = options.port;
    this.identity = options.identity;
    this.adopt = options.adopt;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (message => console.log(message));
    this.connectionFactory = options.connectionFactory ?? ((name, config) => new PeerConnection(name, config) as unknown as AddressedConnection);
    this.mux = (options.muxFactory ?? (port => new IceUdpMuxListener(port, '0.0.0.0') as unknown as AddressedMux))(options.port);
    this.mux.onUnhandledStunRequest(request => { try { this.accept(request); } catch (error) { this.log(`[DirectTransport] Addressed connection failed: ${error instanceof Error ? error.message : String(error)}`); } });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try { this.mux.stop(); } catch { /* already stopped */ }
  }

  private accept(request: UnhandledStunRequest): void {
    if (this.stopped) return;
    const peer = parseAddressedRequest(request);
    if (!peer) return;
    const now = this.now();
    for (const [key, entry] of this.seen) if (now - entry.at >= SEEN_FOR_MS) this.seen.delete(key);
    const key = `${peer.clientUfrag}:${peer.clientPwd}`;
    if (this.seen.has(key)) return;
    let fromHost = 0;
    for (const entry of this.seen.values()) if (entry.host === peer.host) fromHost++;
    if (fromHost >= MAX_PER_HOST || this.seen.size >= MAX_SEEN) return;
    this.seen.set(key, { at: now, host: peer.host });

    const pairId = addressedPairId(peer.clientUfrag, peer.clientPwd);
    const pc = this.connectionFactory(`ftown-addressed-${pairId.slice(0, 12)}`, { iceServers: [], enableIceUdpMux: true, portRangeBegin: this.port, portRangeEnd: this.port,
      disableFingerprintVerification: true, disableAutoNegotiation: true, certificatePemFile: this.identity.certPath, keyPemFile: this.identity.keyPath });
    try {
      const channel = pc.createDataChannel('', { negotiated: true, id: ADDRESSED_CHANNEL_ID });
      pc.setRemoteDescription(inferredOffer(peer), 'offer');
      // The bridge answers under the name the browser gave it; that name is also its password.
      pc.setLocalDescription('answer', { iceUfrag: peer.serverUfrag, icePwd: peer.serverUfrag });
      if (!this.adopt(pc, channel, pairId)) pc.close();
    } catch (error) {
      try { pc.close(); } catch { /* already gone */ }
      throw error;
    }
  }
}
