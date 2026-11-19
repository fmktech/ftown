/**
 * Direct Transport wire contract — FROZEN.
 * Identical copy lives at bridge/src/direct-transport/contract.ts
 * (this file additionally carries the UI-only TerminalTransportApi).
 * See docs/plans/direct-transport-contract.md. Do not modify.
 */

export const DIRECT_PROTOCOL_VERSION = 1;
export const DATA_CHANNEL_LABEL = 'ftown';
/**
 * Connecting to a bridge's fixed address with no signaling. The browser never changes its own offer. It writes the bridge's side
 * of the exchange itself, giving the bridge an ICE username fragment (and password) of this prefix followed by the browser's own
 * ICE password. The bridge reads both of the browser's ICE credentials back out of the first STUN request, so nothing has to be
 * exchanged in advance except the bridge's address, port and certificate fingerprint.
 */
export const ADDRESSED_UFRAG_PREFIX = 'ftown+direct+v1/';
/**
 * Where a browser can reach a bridge without signaling, as `get_direct_address` answers it. None of it is a credential: it says
 * where to knock, and the encrypted hello on the connection still decides who the peer is.
 */
export interface DirectAddress {
  port: number;
  /** SHA-256 of the bridge's DTLS certificate, as SDP writes it. */
  fingerprint: string;
  /** The bridge's non-loopback addresses (LAN, VPN) when it answered. */
  addresses: string[];
}
export const MAX_DIRECT_ADDRESSES = 16;

/** The single data channel of an addressed connection: negotiated in advance on both sides, so no in-band open is needed. */
export const ADDRESSED_CHANNEL_ID = 0;
export const STUN_SERVERS = ['stun:stun.l.google.com:19302'];

export const PAIR_TIMEOUT_MS = 4_000;
/** How long a connection to a remembered address may take. The address either answers at once or is not reachable from here. */
export const ADDRESSED_TIMEOUT_MS = 2_500;
export const PING_INTERVAL_MS = 15_000;
export const WATCH_HEARTBEAT_MS = 20_000;
export const WATCH_TTL_MS = 60_000;
/** Loopback WS rung: TCP connect + hello round-trip budget on 127.0.0.1. */
export const LOOPBACK_TIMEOUT_MS = 1_500;

/**
 * Local-rung reachability info a bridge advertises inside its bridges:presence
 * connInfo. Presence visibility is scoped to the owning user's JWT, so nonce
 * possession + loopback reachability proves same user, same machine (L2).
 */
export interface BridgeLocalAdvert {
  localPort: number;
  /** Legacy fixture compatibility; never authorization or transmitted. */
  localNonce?: string;
}

/** Signaling + watch messages, published on the commands:rpc#{userId} channel. */
export type SignalType = 'webrtc_offer' | 'webrtc_answer' | 'webrtc_ice' | 'webrtc_close';

export interface SignalMessage {
  type: SignalType;
  /** Unique per connection attempt. */
  pairId: string;
  bridgeId: string;
  /** Unique per browser tab (uuid). */
  clientId: string;
  /** SDP (offer/answer) or JSON-serialized ICE candidate; empty for webrtc_close. */
  payload: string;
}

export interface WatchMessage {
  type: 'terminal_watch' | 'terminal_unwatch';
  sessionId: string;
  clientId: string;
}

export type DirectCommandMessage = SignalMessage | WatchMessage;

export function isSignalMessage(msg: { type?: string }): msg is SignalMessage {
  return (
    msg.type === 'webrtc_offer' ||
    msg.type === 'webrtc_answer' ||
    msg.type === 'webrtc_ice' ||
    msg.type === 'webrtc_close'
  );
}

export function isWatchMessage(msg: { type?: string }): msg is WatchMessage {
  return msg.type === 'terminal_watch' || msg.type === 'terminal_unwatch';
}

/** JSON text frames on the `ftown` DataChannel (ordered, reliable). */
export type DirectMessage =
  | { kind: 'hello'; clientId: string; protocolVersion: number }
  | { kind: 'hello_ack'; bridgeId: string; protocolVersion: number }
  /** Bridge → client, once the channel is authorized: what this channel offers beyond terminal frames. Unknown to older clients, which ignore it. */
  | { kind: 'capabilities'; commands: boolean }
  | { kind: 'attach'; sessionId: string }
  | { kind: 'detach'; sessionId: string }
  /** Full serialized screen; resets the output stream for the session. */
  | { kind: 'screen'; sessionId: string; data: string; seq: number }
  | { kind: 'output'; sessionId: string; data: string; seq: number }
  | { kind: 'input'; sessionId: string; data: string }
  | { kind: 'resize'; sessionId: string; cols: number; rows: number }
  | { kind: 'ping' }
  | { kind: 'pong' };

export type TerminalTransportMode = 'direct' | 'local' | 'centrifugo' | 'connecting';

/**
 * Why a session ended up on the centrifugo fallback path. `null` when direct
 * (or not yet resolved). UI-only diagnostic — additive extension to the
 * frozen wire contract above (no wire-format change), following the same
 * precedent as `onNewWatcher`.
 */
export type FallbackReason = 'pairing_failed' | 'peer_lost' | null;

export interface TerminalDataHandlers {
  /** Incremental output chunk. */
  onOutput: (data: string) => void;
  /** Full screen resync; replaces terminal contents. */
  onScreen: (data: string) => void;
}

/**
 * The ONLY surface useTerminal may consume. Implemented by HybridTerminalTransport.
 * Enforces R1 (single active path per session, resync on every switch) and R3
 * (direct-attached sessions neither subscribe to terminal:* nor send watch heartbeats).
 */
export interface TerminalTransportApi {
  /** Returns an unsubscribe function. Idempotent per (sessionId, handlers) pair. */
  subscribeTerminal(
    sessionId: string,
    bridgeId: string,
    handlers: TerminalDataHandlers,
  ): () => void;
  sendInput(sessionId: string, data: string): void;
  sendResize(sessionId: string, cols: number, rows: number): void;
  getMode(sessionId: string): TerminalTransportMode;
  onModeChange(cb: (sessionId: string, mode: TerminalTransportMode) => void): () => void;
  /** Bridge ids with a currently attached Local or P2P transport. */
  getDirectlyReachableBridgeIds(): string[];
  /** Fires when a bridge gains or loses its direct Local/P2P path. */
  onBridgeReachabilityChange(cb: (bridgeId: string, reachable: boolean) => void): () => void;
  /** Why the session is on the centrifugo path; `null` for direct/connecting. */
  getFallbackReason(sessionId: string): FallbackReason;
  dispose(): void;
}

/** How long after a direct channel connects the client waits to hear whether the bridge serves commands on it. */
export const COMMANDS_ANNOUNCE_MS = 1_500;

/** A command that never left this client on the direct channel; sending it another way cannot duplicate it. */
export class DirectUnsentError extends Error {
  constructor() { super('Direct command was not sent'); this.name = 'DirectUnsentError'; }
}

/** One command in flight on a direct channel: `sent` settles when it has left (or could not), `answer` with the bridge's reply. */
export interface DirectCommandHandle<T> { sent: Promise<void>; answer: Promise<T> }
