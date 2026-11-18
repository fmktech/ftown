import { randomUUID } from 'node:crypto';
import { PeerConnection } from 'node-datachannel';
import { STUN_SERVERS } from './direct-transport/contract.js';
import type { InboundTransportContext, SecureEnvelope } from './security/protocol.js';
import type { LedgerBridge } from './security/ledger/protocol.js';
import { parseSecureEnvelope } from './security/crypto.js';

/**
 * Direct bridge-to-bridge links.
 *
 * Two bridges of one account exchange cross-bridge requests over a WebRTC DataChannel instead of the relay. The relay carries only
 * the link setup: ONE sealed request/answer pair (`POST /api/peers/link`, the offer and the answer each with all ICE candidates
 * already gathered), authenticated like any other cross-bridge request. Because both session descriptions travel sealed between the
 * two ledger-listed bridge keys, the DTLS fingerprints are authenticated end to end.
 *
 * The link carries the same HPKE-sealed envelopes the relay would (hello/welcome, application/response); nothing is trusted because
 * of the link itself. Each direction is bound to its own channel name, `direct:bridge-link:<receiving bridgeId>:<pairId>`, so an
 * envelope sealed for the relay is not acceptable on a link and vice versa. Either bridge may send requests on an open link.
 *
 * Nothing here polls: a link is opened on demand by the first request to a peer (which itself still goes through the relay), is torn
 * down on a connection state change or after an idle period, and callers fall back to the relay whenever no link is open.
 */

export const PEER_LINK_LABEL = 'ftown-bridge';
export const PEER_LINK_TRANSPORT = 'bridge-link' as const;
export const peerLinkChannel = (receivingBridgeId: string, pairId: string): string => `direct:${PEER_LINK_TRANSPORT}:${receivingBridgeId}:${pairId}`;

/** Chars of payload per DataChannel message; 4 bytes worst case each keeps a frame well under the ~256 KiB message limit. */
const FRAME_CHARS = 32_000;
/** Largest framed message; a sealed envelope is itself capped (MAX_ENVELOPE_BYTES), this only bounds reassembly. */
const MAX_MESSAGE_CHARS = 640_000;
const MAX_FRAMES = Math.ceil(MAX_MESSAGE_CHARS / FRAME_CHARS);
const MAX_ASSEMBLIES = 32;
const MAX_INBOUND_IN_FLIGHT = 32;
const MAX_PENDING = 256;
const MAX_LINKS = 32;
export const MAX_LINK_SDP_CHARS = 20_000;

export interface PeerLinkTimings {
  /** ICE gathering budget before the description is sent with whatever was gathered. */
  gatherMs: number;
  /** Gathering is taken as finished when no new candidate has appeared for this long. */
  gatherQuietMs: number;
  /** A link that has not opened by then is abandoned. */
  openMs: number;
  /** A link without traffic for this long is closed. */
  idleMs: number;
  /** First retry delay after a failed attempt; doubles up to `backoffMaxMs`. */
  backoffMs: number;
  backoffMaxMs: number;
}
const DEFAULT_TIMINGS: PeerLinkTimings = { gatherMs: 3_000, gatherQuietMs: 300, openMs: 20_000, idleMs: 10 * 60_000, backoffMs: 60_000, backoffMaxMs: 3_600_000 };

export interface LinkDataChannel {
  sendMessage(msg: string): boolean;
  isOpen(): boolean;
  close(): void;
  onOpen(cb: () => void): void;
  onClosed(cb: () => void): void;
  onError(cb: (err: string) => void): void;
  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void;
}
export interface LinkPeerConnection {
  setRemoteDescription(sdp: string, type: string): void;
  localDescription(): { sdp: string; type: string } | null;
  createDataChannel(label: string): LinkDataChannel;
  gatheringState(): string;
  onGatheringStateChange(cb: (state: string) => void): void;
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void;
  onStateChange(cb: (state: string) => void): void;
  onDataChannel(cb: (dc: LinkDataChannel) => void): void;
  close(): void;
}
export type LinkConnectionFactory = (name: string, config: { iceServers: string[] }) => LinkPeerConnection;
const defaultFactory: LinkConnectionFactory = (name, config) => new PeerConnection(name, config) as unknown as LinkPeerConnection;

/** `unsent`: nothing left this bridge, so the relay may carry the request instead. `lost`: it was sent and no answer arrived. */
export class PeerLinkError extends Error {
  constructor(readonly reason: 'unsent' | 'lost') { super(`Peer link ${reason}`); this.name = 'PeerLinkError'; }
}

export interface PeerLinksOptions {
  bridgeId: string;
  /** This bridge's endpoint id (the recipient of everything arriving on a link). */
  endpointId: string;
  /** The account's other bridges right now; a link exists only with a bridge listed here. */
  peers: () => LedgerBridge[];
  /** Runs one inbound sealed packet (handshake or request) under the bridge's own policy and returns the sealed answer. */
  execute: (packet: SecureEnvelope, route: InboundTransportContext) => Promise<SecureEnvelope>;
  /** Subscribes to endpoint revocations; returns the unsubscribe. */
  onRevoked?: (listener: (endpointId: string) => void) => () => void;
  factory?: LinkConnectionFactory;
  timings?: Partial<PeerLinkTimings>;
  log?: (message: string) => void;
}

/** Splits one message into `id.index.total.payload` frames. */
export function frameMessage(message: string, id: string = randomUUID().replaceAll('-', '').slice(0, 16)): string[] {
  const total = Math.max(1, Math.ceil(message.length / FRAME_CHARS));
  const frames: string[] = [];
  for (let index = 0; index < total; index++) frames.push(`${id}.${index}.${total}.${message.slice(index * FRAME_CHARS, (index + 1) * FRAME_CHARS)}`);
  return frames;
}

/** Reassembles framed messages; throws on anything malformed or over the limits (the caller closes the link). */
export class FrameAssembler {
  private readonly parts = new Map<string, { total: number; next: number; chunks: string[] }>();
  push(frame: string): string | null {
    const match = /^([a-f0-9]{16})\.(\d{1,4})\.(\d{1,4})\./.exec(frame);
    if (!match) throw new Error('Invalid frame');
    const [header, id] = match; const index = Number(match[2]); const total = Number(match[3]);
    const payload = frame.slice(header.length);
    if (total < 1 || total > MAX_FRAMES || index >= total || payload.length > FRAME_CHARS) throw new Error('Invalid frame');
    if (total === 1) { if (this.parts.has(id)) throw new Error('Invalid frame'); return payload; }
    let entry = this.parts.get(id);
    if (!entry) {
      if (index !== 0 || this.parts.size >= MAX_ASSEMBLIES) throw new Error('Invalid frame');
      entry = { total, next: 0, chunks: [] }; this.parts.set(id, entry);
    }
    // The channel is ordered and reliable, so the frames of one message arrive in order.
    if (entry.total !== total || entry.next !== index) throw new Error('Invalid frame');
    entry.chunks.push(payload); entry.next += 1;
    if (entry.next < total) return null;
    this.parts.delete(id);
    return entry.chunks.join('');
  }
}

interface Pending { resolve: (packet: SecureEnvelope) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

class PeerLink {
  readonly pairId: string;
  readonly peer: LedgerBridge;
  private dc?: LinkDataChannel;
  private opened = false;
  private closed = false;
  private readonly assembler = new FrameAssembler();
  private readonly pending = new Map<string, Pending>();
  private inFlight = 0;
  private lastUsed = Date.now();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly openTimer: ReturnType<typeof setTimeout>;
  private readonly openWaiters: Array<(open: boolean) => void> = [];

  constructor(private readonly owner: PeerLinks, readonly pc: LinkPeerConnection, peer: LedgerBridge, pairId: string) {
    this.peer = peer; this.pairId = pairId;
    pc.onStateChange(state => { if (state === 'disconnected' || state === 'failed' || state === 'closed') this.close(); });
    this.openTimer = setTimeout(() => { if (!this.opened) this.close(); }, owner.timings.openMs);
    this.openTimer.unref?.();
  }

  get isOpen(): boolean { return this.opened && !this.closed && !!this.dc?.isOpen(); }

  bind(dc: LinkDataChannel): void {
    if (this.dc || this.closed) { try { dc.close(); } catch { /* gone */ } return; }
    this.dc = dc;
    dc.onMessage(message => { if (typeof message === 'string') this.receive(message); else this.close(); });
    dc.onClosed(() => this.close());
    dc.onError(() => this.close());
    const open = () => {
      if (this.closed || this.opened) return;
      this.opened = true; clearTimeout(this.openTimer); this.lastUsed = Date.now(); this.armIdle(this.owner.timings.idleMs);
      this.owner.log(`[Peers] Direct link open with ${this.peer.label || this.peer.bridgeId}`);
      for (const waiter of this.openWaiters.splice(0)) waiter(true);
    };
    if (dc.isOpen()) open(); else dc.onOpen(open);
  }

  /** Resolves true once the link is open, false if it closes first. */
  whenOpen(): Promise<boolean> {
    if (this.isOpen) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    return new Promise(resolve => { this.openWaiters.push(resolve); });
  }

  exchange(packet: SecureEnvelope, timeoutMs: number): Promise<SecureEnvelope> {
    if (!this.isOpen || this.pending.has(packet.messageId) || this.pending.size >= MAX_PENDING) return Promise.reject(new PeerLinkError('unsent'));
    return new Promise<SecureEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        // An unanswered request means the link can no longer be relied on.
        if (this.pending.delete(packet.messageId)) { reject(new PeerLinkError('lost')); this.close(); }
      }, timeoutMs);
      this.pending.set(packet.messageId, { resolve, reject, timer });
      if (!this.write(JSON.stringify(packet))) {
        clearTimeout(timer); this.pending.delete(packet.messageId); reject(new PeerLinkError('unsent')); this.close();
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.openTimer); if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const waiter of this.openWaiters.splice(0)) waiter(false);
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new PeerLinkError('lost')); }
    try { this.dc?.close(); } catch { /* gone */ }
    try { this.pc.close(); } catch { /* gone */ }
    if (this.opened) this.owner.log(`[Peers] Direct link closed with ${this.peer.label || this.peer.bridgeId}`);
    this.owner.closed(this);
  }

  private armIdle(delay: number): void {
    this.idleTimer = setTimeout(() => {
      const quiet = Date.now() - this.lastUsed;
      if (quiet >= this.owner.timings.idleMs && this.pending.size === 0 && this.inFlight === 0) this.close();
      else if (!this.closed) this.armIdle(Math.max(1_000, this.owner.timings.idleMs - quiet));
    }, delay);
    this.idleTimer.unref?.();
  }

  /** False when the message could not be handed to the channel in full. */
  private write(message: string): boolean {
    if (!this.isOpen || message.length > MAX_MESSAGE_CHARS) return false;
    this.lastUsed = Date.now();
    try { for (const frame of frameMessage(message)) if (!this.dc!.sendMessage(frame)) return false; }
    catch { return false; }
    return true;
  }

  private receive(frame: string): void {
    if (this.closed) return;
    let packet: SecureEnvelope;
    try {
      const message = this.assembler.push(frame);
      if (message === null) return;
      packet = parseSecureEnvelope(JSON.parse(message));
    } catch { this.close(); return; }
    this.lastUsed = Date.now();
    // The link was set up with exactly one ledger-listed bridge: nothing else may speak on it, in either direction.
    if (packet.senderId !== this.peer.endpoint.id || packet.recipientId !== this.owner.endpointId
      || !this.owner.isPeer(this.peer)) { this.close(); return; }
    const waiting = this.pending.get(packet.messageId);
    if (waiting) { clearTimeout(waiting.timer); this.pending.delete(packet.messageId); waiting.resolve(packet); return; }
    // Only a handshake or a request starts work here; a late or unknown answer is dropped.
    if (packet.purpose !== 'hello' && packet.purpose !== 'application') return;
    if (this.inFlight >= MAX_INBOUND_IN_FLIGHT) return;
    this.inFlight += 1;
    const route: InboundTransportContext = { transport: PEER_LINK_TRANSPORT, channel: peerLinkChannel(this.owner.bridgeId, this.pairId),
      bridgeId: this.owner.bridgeId, pairId: this.pairId };
    void this.owner.execute(packet, route).then(answer => { if (!this.closed) this.write(JSON.stringify(answer)); },
      () => { /* Unauthenticated or tampered: never answered. */ }).finally(() => { this.inFlight -= 1; });
  }
}

export class PeerLinks {
  readonly bridgeId: string;
  readonly endpointId: string;
  readonly timings: PeerLinkTimings;
  readonly execute: PeerLinksOptions['execute'];
  readonly log: (message: string) => void;
  private readonly peers: () => LedgerBridge[];
  private readonly factory: LinkConnectionFactory;
  private readonly links = new Set<PeerLink>();
  /** Outbound attempts in progress, by peer bridgeId. */
  private readonly connecting = new Map<string, Promise<boolean>>();
  /** Failed outbound attempts: when the next one is allowed, and the delay after that. */
  private readonly backoff = new Map<string, { until: number; delay: number }>();
  private readonly stopRevocation: () => void;
  private stopped = false;

  constructor(options: PeerLinksOptions) {
    this.bridgeId = options.bridgeId; this.endpointId = options.endpointId; this.peers = options.peers; this.execute = options.execute;
    this.factory = options.factory ?? defaultFactory; this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.log = options.log ?? (message => console.log(message));
    this.stopRevocation = options.onRevoked?.(endpointId => {
      for (const link of [...this.links]) if (link.peer.endpoint.id === endpointId) link.close();
    }) ?? (() => {});
  }

  isPeer(peer: LedgerBridge): boolean {
    return this.peers().some(item => item.bridgeId === peer.bridgeId && item.endpoint.id === peer.endpoint.id);
  }

  private open(peerBridgeId: string): PeerLink | undefined {
    for (const link of this.links) if (link.peer.bridgeId === peerBridgeId && link.isOpen && this.isPeer(link.peer)) return link;
    return undefined;
  }

  /** The channel name requests to `peerBridgeId` must be sealed for, when a link to it is open. */
  channel(peerBridgeId: string): string | null {
    const link = this.open(peerBridgeId);
    return link ? peerLinkChannel(peerBridgeId, link.pairId) : null;
  }

  /** Sends one sealed packet to the peer over the open link named by `packet.channel` and resolves with its sealed answer. */
  exchange(peerBridgeId: string, packet: SecureEnvelope, timeoutMs: number): Promise<SecureEnvelope> {
    for (const link of this.links) {
      if (link.peer.bridgeId === peerBridgeId && link.isOpen && peerLinkChannel(peerBridgeId, link.pairId) === packet.channel) {
        if (packet.recipientId !== link.peer.endpoint.id || !this.isPeer(link.peer)) break;
        return link.exchange(packet, timeoutMs);
      }
    }
    return Promise.reject(new PeerLinkError('unsent'));
  }

  /**
   * Starts opening a link to `peer` unless one is open, being opened, or a recent attempt failed. `signal` delivers our offer to the
   * peer (sealed, over the relay) and resolves with its answer. Never throws; resolves whether a link is open afterwards.
   */
  ensure(peer: LedgerBridge, signal: (offer: { pairId: string; sdp: string }) => Promise<{ sdp: string }>): Promise<boolean> {
    if (this.stopped || !this.isPeer(peer)) return Promise.resolve(false);
    if (this.open(peer.bridgeId)) return Promise.resolve(true);
    const running = this.connecting.get(peer.bridgeId);
    if (running) return running;
    const wait = this.backoff.get(peer.bridgeId);
    if (wait && wait.until > Date.now()) return Promise.resolve(false);
    const attempt = this.dial(peer, signal).then(ok => {
      if (ok) this.backoff.delete(peer.bridgeId);
      else {
        const delay = Math.min(wait ? wait.delay * 2 : this.timings.backoffMs, this.timings.backoffMaxMs);
        this.backoff.set(peer.bridgeId, { until: Date.now() + delay, delay });
      }
      return ok;
    }).finally(() => { this.connecting.delete(peer.bridgeId); });
    this.connecting.set(peer.bridgeId, attempt);
    return attempt;
  }

  private async dial(peer: LedgerBridge, signal: (offer: { pairId: string; sdp: string }) => Promise<{ sdp: string }>): Promise<boolean> {
    if (this.links.size >= MAX_LINKS) return false;
    const pairId = randomUUID();
    let link: PeerLink | undefined;
    try {
      const pc = this.factory(`ftown-link-${pairId}`, { iceServers: [...STUN_SERVERS] });
      link = new PeerLink(this, pc, peer, pairId);
      this.links.add(link);
      const gathered = this.gathered(pc);
      link.bind(pc.createDataChannel(PEER_LINK_LABEL));
      const offer = await gathered;
      if (!offer || offer.type !== 'offer') throw new Error('No offer');
      const answer = await signal({ pairId, sdp: offer.sdp });
      if (typeof answer?.sdp !== 'string' || !answer.sdp || answer.sdp.length > MAX_LINK_SDP_CHARS) throw new Error('Invalid answer');
      pc.setRemoteDescription(answer.sdp, 'answer');
      return await link.whenOpen();
    } catch {
      link?.close();
      return false;
    }
  }

  /** Answers a peer bridge's offer. The caller has already authenticated the request as coming from `peer`. */
  async accept(peer: LedgerBridge, pairId: string, sdp: string): Promise<{ sdp: string }> {
    if (this.stopped || !this.isPeer(peer)) throw new Error('Unknown peer');
    // A repeated pairId replaces its earlier attempt. Other links with this peer stay until they close or go idle.
    for (const link of [...this.links]) if (link.pairId === pairId) link.close();
    if (this.links.size >= MAX_LINKS) throw new Error('Too many links');
    const pc = this.factory(`ftown-link-${pairId}`, { iceServers: [...STUN_SERVERS] });
    const link = new PeerLink(this, pc, peer, pairId);
    this.links.add(link);
    try {
      pc.onDataChannel(dc => link.bind(dc));
      const gathered = this.gathered(pc);
      pc.setRemoteDescription(sdp, 'offer');
      const answer = await gathered;
      if (!answer || answer.type !== 'answer' || answer.sdp.length > MAX_LINK_SDP_CHARS) throw new Error('No answer');
      return { sdp: answer.sdp };
    } catch (error) {
      link.close();
      throw error;
    }
  }

  /**
   * The local description with its ICE candidates, so one message carries everything (no trickle). Gathering is finished when the
   * library says so, when candidates stop appearing (with a STUN server configured it may never report completion), or when the
   * budget runs out.
   */
  private gathered(pc: LinkPeerConnection): Promise<{ sdp: string; type: string } | null> {
    return new Promise(resolve => {
      let done = false;
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const finish = () => { if (done) return; done = true; clearTimeout(budget); clearTimeout(quiet); resolve(pc.localDescription()); };
      const budget = setTimeout(finish, this.timings.gatherMs);
      pc.onGatheringStateChange(state => { if (state === 'complete') finish(); });
      pc.onLocalCandidate(() => { if (done) return; clearTimeout(quiet); quiet = setTimeout(finish, this.timings.gatherQuietMs); });
    });
  }

  /** @internal */
  closed(link: PeerLink): void { this.links.delete(link); }

  /** Open links, for diagnostics. */
  status(): { bridgeId: string; pairId: string }[] {
    return [...this.links].filter(link => link.isOpen).map(link => ({ bridgeId: link.peer.bridgeId, pairId: link.pairId }));
  }

  closeAll(): void {
    this.stopped = true; this.stopRevocation();
    for (const link of [...this.links]) link.close();
  }
}
