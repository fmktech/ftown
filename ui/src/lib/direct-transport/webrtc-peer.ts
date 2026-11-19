import { applicationJson, type SecureEndpointRuntime } from "../secure-endpoint-runtime";
import type { ApplicationJson, ApplicationRoute } from "@security/protocol";
import { FrameAssembler, isFrame } from "../../../../bridge/src/direct-transport/framing";

export type DirectCommandRoute = Extract<ApplicationRoute, { kind: "command" }>;
import {
  DIRECT_PROTOCOL_VERSION,
  DATA_CHANNEL_LABEL,
  ADDRESSED_CHANNEL_ID,
  ADDRESSED_TIMEOUT_MS,
  ADDRESSED_UFRAG_PREFIX,
  STUN_SERVERS,
  PAIR_TIMEOUT_MS,
  PING_INTERVAL_MS,
  type DirectMessage,
  type SignalMessage,
  type TerminalDataHandlers,
  COMMANDS_ANNOUNCE_MS,
  DirectUnsentError,
  type DirectCommandHandle,
} from './contract';

export interface WebRtcPeerOptions {
  bridgeId: string;
  clientId: string;
  sendSignal: (msg: SignalMessage) => void;
  securityRuntime?: SecureEndpointRuntime;
  /**
   * Connect to the bridge at this address with no signaling: nothing is sent through `sendSignal`, and the bridge's half of the
   * exchange is written here from what is already known about it.
   */
  address?: PeerAddress;
}

/** One place a bridge listens for connections made without signaling. */
export interface PeerAddress {
  ip: string;
  port: number;
  /** SHA-256 of the bridge's DTLS certificate. The browser refuses any other certificate at this address. */
  fingerprint: string;
}

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
/** RFC 5245 ice-char. */
const ICE_CHARS = /^[A-Za-z0-9+/]+$/;

/** Only values that can be written into SDP as they are: anything else could add lines of its own. */
export function validPeerAddress(value: unknown): value is PeerAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { ip, port, fingerprint } = value as Record<string, unknown>;
  return typeof ip === 'string' && IPV4.test(ip) && typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65_536
    && typeof fingerprint === 'string' && FINGERPRINT.test(fingerprint);
}

/**
 * The pair id of an addressed connection, derived on both sides from the browser's ICE credentials (the bridge reads them out of
 * the first STUN request). Must match `addressedPairId` in the bridge's addressed-listener.
 */
export async function addressedPairId(clientUfrag: string, clientPwd: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${clientUfrag}:${clientPwd}`)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `a${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/**
 * The answer the bridge would have sent, written by the browser. The bridge's ICE username fragment and password are both the
 * prefix followed by the browser's own ICE password, which is how the bridge learns that password from the first STUN request.
 */
export function addressedAnswer(address: PeerAddress, clientPwd: string): string {
  const serverUfrag = `${ADDRESSED_UFRAG_PREFIX}${clientPwd}`;
  return ['v=0', `o=- 0 0 IN IP4 ${address.ip}`, 's=-', 't=0 0', 'a=ice-lite',
    `m=application ${address.port} UDP/DTLS/SCTP webrtc-datachannel`, `c=IN IP4 ${address.ip}`, 'a=mid:0', 'a=setup:passive',
    `a=ice-ufrag:${serverUfrag}`, `a=ice-pwd:${serverUfrag}`, `a=fingerprint:sha-256 ${address.fingerprint}`, 'a=sctp-port:5000',
    'a=max-message-size:262144', `a=candidate:1 1 UDP 1 ${address.ip} ${address.port} typ host`, 'a=end-of-candidates', ''].join('\r\n');
}

/** Public surface of {@link WebRtcPeer}; kept structural so tests can inject a fake. */
export interface WebRtcPeerApi {
  connect(): Promise<void>;
  attach(sessionId: string, handlers: TerminalDataHandlers): void;
  detach(sessionId: string): void;
  sendInput(sessionId: string, data: string): void;
  sendResize(sessionId: string, cols: number, rows: number): void;
  handleSignal(msg: SignalMessage): void;
  close(): void;
  onClose(cb: () => void): void;
  /** Whether the bridge announced that this channel answers dashboard commands. */
  canCommand?(): boolean;
  whenCommandsKnown?(): Promise<boolean>;
  command?(route: DirectCommandRoute, data: unknown): DirectCommandHandle<ApplicationJson>;
}

export type WebRtcPeerFactory = (opts: WebRtcPeerOptions) => WebRtcPeerApi;

/**
 * Browser-native RTCPeerConnection wrapper implementing the client side of the
 * direct-transport DataChannel protocol and signaling. No npm deps.
 */
export class WebRtcPeer implements WebRtcPeerApi {
  private readonly bridgeId: string;
  private readonly clientId: string;
  private readonly sendSignal: (msg: SignalMessage) => void;
  /** Random for a signaled connection; for an addressed one, derived from the ICE credentials once the offer exists. */
  private pairId: string;
  private readonly address: PeerAddress | null;
  private readonly securityRuntime?: SecureEndpointRuntime;
  private incoming: Promise<void> = Promise.resolve();
  private readonly assembler = new FrameAssembler();
  /** Set when the bridge announces that this channel answers dashboard commands. */
  private commandsOffered = false;
  private settleCommands!: (offered: boolean) => void;
  private readonly commandsKnown = new Promise<boolean>(resolve => { this.settleCommands = resolve; });
  private commandsTimer: ReturnType<typeof setTimeout> | null = null;
  private outgoing: Promise<void> = Promise.resolve();

  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;

  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((err: Error) => void) | null = null;
  private settled = false;

  private pairTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;

  private remoteSet = false;
  private readonly pendingIce: RTCIceCandidateInit[] = [];

  private closed = false;

  private readonly handlers = new Map<string, TerminalDataHandlers>();
  private readonly closeCbs = new Set<() => void>();

  constructor(opts: WebRtcPeerOptions) {
    this.bridgeId = opts.bridgeId;
    this.securityRuntime = opts.securityRuntime;
    this.clientId = opts.clientId;
    this.sendSignal = opts.sendSignal;
    this.pairId = crypto.randomUUID();
    this.address = opts.address ?? null;
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    this.pairTimer = setTimeout(() => this.fail(new Error('pair timeout')), this.address ? ADDRESSED_TIMEOUT_MS : PAIR_TIMEOUT_MS);
    void (this.address ? this.startAddressed(this.address) : this.startPairing()).catch((err) => this.fail(err instanceof Error ? err : new Error(String(err))));
    return this.connectPromise;
  }

  private async startPairing(): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_SERVERS }] });
    this.pc = pc;

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.sendSignal({
          type: 'webrtc_ice',
          pairId: this.pairId,
          bridgeId: this.bridgeId,
          clientId: this.clientId,
          payload: JSON.stringify(ev.candidate.toJSON()),
        });
      }
    };
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === 'failed' || state === 'closed') {
        this.fail(new Error(`ice ${state}`));
      }
    };

    const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
    this.channel = channel;
    channel.onopen = () => this.onChannelOpen();
    channel.onmessage = (ev) => this.onFrame(ev.data);
    channel.onclose = () => this.close();
    channel.onerror = () => this.fail(new Error('datachannel error'));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.sendSignal({
      type: 'webrtc_offer',
      pairId: this.pairId,
      bridgeId: this.bridgeId,
      clientId: this.clientId,
      payload: offer.sdp ?? '',
    });
  }

  /** Connects with no signaling: an unmodified offer, then the bridge's answer written here (see ADDRESSED_UFRAG_PREFIX). */
  private async startAddressed(address: PeerAddress): Promise<void> {
    if (!validPeerAddress(address)) throw new Error('invalid address');
    const pc = new RTCPeerConnection();
    this.pc = pc;
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === 'failed' || state === 'closed') this.fail(new Error(`ice ${state}`));
    };
    // Negotiated in advance on both sides: the bridge creates the same channel when it accepts the connection.
    const channel = pc.createDataChannel('', { negotiated: true, id: ADDRESSED_CHANNEL_ID, ordered: true });
    this.channel = channel;
    channel.onopen = () => this.onChannelOpen();
    channel.onmessage = (ev) => this.onFrame(ev.data);
    channel.onclose = () => this.close();
    channel.onerror = () => this.fail(new Error('datachannel error'));

    await pc.setLocalDescription(await pc.createOffer());
    const sdp = pc.localDescription?.sdp ?? '';
    const ufrag = /^a=ice-ufrag:(\S+)\s*$/m.exec(sdp)?.[1];
    const pwd = /^a=ice-pwd:(\S+)\s*$/m.exec(sdp)?.[1];
    if (!ufrag || !pwd || !ICE_CHARS.test(ufrag) || !ICE_CHARS.test(pwd) || pwd.length < 22 || pwd.length > 200) throw new Error('unusable ICE credentials');
    this.pairId = await addressedPairId(ufrag, pwd);
    if (this.closed) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: addressedAnswer(address, pwd) });
  }

  private onChannelOpen(): void {
    if (!this.securityRuntime) { this.fail(new Error('Encrypted bridge approval is required')); return; }
    void this.securityRuntime.handshake(this.bridgeId, this.secureChannel(), async packet => {
      if (!this.channel || this.channel.readyState !== 'open' || this.closed) throw new Error('datachannel closed');
      this.channel.send(JSON.stringify(packet));
    }).then(() => {
      if (this.closed) return;
      if (this.pairTimer) clearTimeout(this.pairTimer);
      this.pairTimer = null; this.startPing(); this.resolve();
      // An older bridge never announces commands; stop waiting for it shortly after connecting.
      this.commandsTimer = setTimeout(() => this.settleCommands(false), COMMANDS_ANNOUNCE_MS);
    }).catch(() => this.fail(new Error('Encrypted peer handshake failed')));
  }

  private secureChannel(): string { return `direct:webrtc:${this.bridgeId}:${this.pairId}`; }

  private onFrame(raw: unknown): void {
    this.incoming = this.incoming.then(async () => {
      if (this.closed || !this.securityRuntime || typeof raw !== 'string') return;
      // Large answers arrive as frames; anything else is one JSON envelope.
      const whole = isFrame(raw) ? this.assembler.push(raw) : raw;
      if (whole === null) return;
      const packet: unknown = JSON.parse(whole);
      for (const delivered of await this.securityRuntime.receive(packet, this.secureChannel())) {
        if (this.closed) return;
        const app = delivered.application;
        if (delivered.bridgeId !== this.bridgeId || app.route.kind !== 'terminal' || app.route.pairId !== this.pairId
          || !app.data || typeof app.data !== 'object' || Array.isArray(app.data) || typeof app.data.kind !== 'string'
          || app.route.frameType !== app.data.kind || app.route.sessionId !== ('sessionId' in app.data ? app.data.sessionId : '')) continue;
        this.handleMessage(app.data as unknown as DirectMessage);
      }
    }).catch(() => this.fail(new Error('Encrypted peer frame rejected')));
  }

  private handleMessage(msg: DirectMessage): void {
    switch (msg.kind) {
      case 'screen':
        this.handlers.get(msg.sessionId)?.onScreen(msg.data);
        break;
      case 'output':
        this.handlers.get(msg.sessionId)?.onOutput(msg.data);
        break;
      case 'ping':
        this.send({ kind: 'pong' });
        break;
      case 'pong':
        this.missedPongs = 0;
        break;
      case 'capabilities':
        this.commandsOffered = msg.commands === true;
        this.settleCommands(this.commandsOffered);
        break;
      default:
        break;
    }
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.missedPongs >= 2) {
        this.close();
        return;
      }
      this.missedPongs++;
      this.send({ kind: 'ping' });
    }, PING_INTERVAL_MS);
  }

  handleSignal(msg: SignalMessage): void {
    // An addressed connection takes no part in signaling.
    if (this.closed || this.address) return;
    if (msg.clientId !== this.clientId || msg.pairId !== this.pairId || msg.bridgeId !== this.bridgeId) {
      return;
    }
    switch (msg.type) {
      case 'webrtc_answer':
        void this.applyAnswer(msg.payload);
        break;
      case 'webrtc_ice':
        this.addIce(msg.payload);
        break;
      case 'webrtc_close':
        this.close();
        break;
      default:
        break;
    }
  }

  private async applyAnswer(sdp: string): Promise<void> {
    if (!this.pc) return;
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
      this.remoteSet = true;
      for (const candidate of this.pendingIce.splice(0)) {
        void this.pc.addIceCandidate(candidate).catch(() => {});
      }
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error('setRemoteDescription failed'));
    }
  }

  private addIce(payload: string): void {
    let candidate: RTCIceCandidateInit | null;
    try {
      candidate = toIceCandidateInit(JSON.parse(payload));
    } catch {
      return;
    }
    if (!candidate) return;
    if (!this.pc || !this.remoteSet) {
      this.pendingIce.push(candidate);
      return;
    }
    void this.pc.addIceCandidate(candidate).catch(() => {});
  }

  attach(sessionId: string, handlers: TerminalDataHandlers): void {
    this.handlers.set(sessionId, handlers);
    this.send({ kind: 'attach', sessionId });
  }

  detach(sessionId: string): void {
    this.handlers.delete(sessionId);
    this.send({ kind: 'detach', sessionId });
  }

  sendInput(sessionId: string, data: string): void {
    this.send({ kind: 'input', sessionId, data });
  }

  sendResize(sessionId: string, cols: number, rows: number): void {
    this.send({ kind: 'resize', sessionId, cols, rows });
  }

  private send(msg: DirectMessage): void {
    this.outgoing = this.outgoing.then(async () => {
      if (this.closed || !this.securityRuntime) return;
      const packet = await this.securityRuntime.sealApplication(this.bridgeId, this.secureChannel(), { type: 'application',
        route: { kind: 'terminal', sessionId: 'sessionId' in msg ? msg.sessionId : '', frameType: msg.kind, pairId: this.pairId },
        data: applicationJson(msg), mcp: null });
      if (!this.closed && this.channel && this.channel.readyState === 'open') this.channel.send(JSON.stringify(packet));
    }).catch(() => this.fail(new Error('Encrypted peer send failed')));
  }

  canCommand(): boolean { return this.commandsOffered && !this.closed; }

  /** Resolves once it is known whether the bridge serves commands here: its announcement, a short wait after connecting, or close. */
  whenCommandsKnown(): Promise<boolean> { return this.commandsKnown; }

  /**
   * Sends one dashboard command on this channel, in call order with other commands and terminal frames. `sent` settles once the
   * command has left; `answer` settles with the bridge's reply, or rejects with DirectUnsentError when it never left.
   */
  command(route: DirectCommandRoute, data: unknown): DirectCommandHandle<ApplicationJson> {
    let markSent!: () => void;
    const sent = new Promise<void>(resolve => { markSent = resolve; });
    const answer = new Promise<ApplicationJson>((resolve, reject) => {
      this.outgoing = this.outgoing.then(async () => {
        if (this.closed || !this.securityRuntime) { reject(new DirectUnsentError()); markSent(); return; }
        let transmitted = false;
        this.securityRuntime.request(this.bridgeId, this.secureChannel(), route, data, async packet => {
          if (!this.channel || this.channel.readyState !== 'open' || this.closed) throw new Error('Direct channel closed');
          this.channel.send(JSON.stringify(packet));
          transmitted = true; markSent();
        }).then(resolve, (error: unknown) => { reject(transmitted ? error : new DirectUnsentError()); markSent(); });
        await sent;
      });
    });
    return { sent, answer };
  }

  onClose(cb: () => void): void {
    if (this.closed) {
      cb();
      return;
    }
    this.closeCbs.add(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.commandsTimer) clearTimeout(this.commandsTimer);
    this.settleCommands(false);

    if (this.pairTimer) {
      clearTimeout(this.pairTimer);
      this.pairTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        // ignore
      }
      this.channel = null;
    }
    if (this.pc) {
      // Best-effort notify the bridge to tear down its peer. An addressed connection has no signaling: closing it is the notice.
      if (!this.address) this.sendSignal({
        type: 'webrtc_close',
        pairId: this.pairId,
        bridgeId: this.bridgeId,
        clientId: this.clientId,
        payload: '',
      });
      try {
        this.pc.close();
      } catch {
        // ignore
      }
      this.pc = null;
    }

    if (!this.settled) {
      this.reject(new Error('peer closed'));
    }

    for (const cb of this.closeCbs) cb();
    this.closeCbs.clear();
    this.handlers.clear();
  }

  private fail(err: Error): void {
    if (!this.settled) this.reject(err);
    this.close();
  }

  private resolve(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveConnect?.();
  }

  private reject(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectConnect?.(err);
  }
}

/**
 * The bridge (node-datachannel) trickles `{ candidate: 'a=candidate:…', mid }`, while addIceCandidate needs an RTCIceCandidateInit
 * with `sdpMid` or `sdpMLineIndex`: with neither it throws, which silently dropped every bridge candidate. Without the bridge's own
 * addresses ICE then only worked when the bridge could reach the browser first (it had to resolve Chrome's mDNS `.local` candidate),
 * so a Linux bridge on the same LAN never paired. Accepts both shapes; null for anything that is not a candidate.
 */
export function toIceCandidateInit(value: unknown): RTCIceCandidateInit | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.candidate !== 'string') return null;
  const init: RTCIceCandidateInit = { candidate: input.candidate.startsWith('a=') ? input.candidate.slice(2) : input.candidate };
  const mid = typeof input.sdpMid === 'string' ? input.sdpMid : typeof input.mid === 'string' && input.mid ? input.mid : null;
  if (mid !== null) init.sdpMid = mid;
  if (typeof input.sdpMLineIndex === 'number') init.sdpMLineIndex = input.sdpMLineIndex;
  // The direct transport negotiates exactly one m-line (the data channel).
  if (init.sdpMid === undefined && init.sdpMLineIndex === undefined) init.sdpMLineIndex = 0;
  if (typeof input.usernameFragment === 'string') init.usernameFragment = input.usernameFragment;
  return init;
}
