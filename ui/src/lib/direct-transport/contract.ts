/**
 * Direct Transport wire contract — FROZEN.
 * Identical copy lives at bridge/src/direct-transport/contract.ts
 * (this file additionally carries the UI-only TerminalTransportApi).
 * See docs/plans/direct-transport-contract.md. Do not modify.
 */

export const DIRECT_PROTOCOL_VERSION = 1;
export const DATA_CHANNEL_LABEL = 'ftown';
export const STUN_SERVERS = ['stun:stun.l.google.com:19302'];

export const PAIR_TIMEOUT_MS = 4_000;
export const PING_INTERVAL_MS = 15_000;
export const WATCH_HEARTBEAT_MS = 20_000;
export const WATCH_TTL_MS = 60_000;

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
  | { kind: 'attach'; sessionId: string }
  | { kind: 'detach'; sessionId: string }
  /** Full serialized screen; resets the output stream for the session. */
  | { kind: 'screen'; sessionId: string; data: string; seq: number }
  | { kind: 'output'; sessionId: string; data: string; seq: number }
  | { kind: 'input'; sessionId: string; data: string }
  | { kind: 'resize'; sessionId: string; cols: number; rows: number }
  | { kind: 'ping' }
  | { kind: 'pong' };

export type TerminalTransportMode = 'direct' | 'centrifugo' | 'connecting';

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
  dispose(): void;
}
