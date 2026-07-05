import {
  DIRECT_PROTOCOL_VERSION,
  LOOPBACK_TIMEOUT_MS,
  PING_INTERVAL_MS,
  type DirectMessage,
  type TerminalDataHandlers,
} from './contract';

/** WebSocket readyState value for an open socket (browser constant WebSocket.OPEN). */
const WS_OPEN = 1;

/**
 * Minimal structural view of a browser WebSocket — only what {@link LoopbackPeer}
 * uses. Kept loose (event args typed `unknown`) so the real global WebSocket is
 * assignable and test fakes stay trivial.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface LoopbackPeerOptions {
  bridgeId: string;
  clientId: string;
  port: number;
  nonce: string;
  /** Injectable for tests; defaults to the browser-native WebSocket. */
  wsFactory?: WebSocketFactory;
}

/**
 * Public surface of {@link LoopbackPeer} — the same shape as WebRtcPeerApi minus
 * signaling (loopback needs no ICE/SDP exchange). Kept structural for test fakes.
 */
export interface LoopbackPeerApi {
  connect(): Promise<void>;
  attach(sessionId: string, handlers: TerminalDataHandlers): void;
  detach(sessionId: string): void;
  sendInput(sessionId: string, data: string): void;
  sendResize(sessionId: string, cols: number, rows: number): void;
  close(): void;
  onClose(cb: () => void): void;
}

export type LoopbackPeerFactory = (opts: LoopbackPeerOptions) => LoopbackPeerApi;

const defaultWebSocketFactory: WebSocketFactory = (url) =>
  // Cast through unknown: the DOM WebSocket's event-handler signatures are not
  // structurally assignable under strictFunctionTypes, but its runtime shape
  // matches WebSocketLike exactly.
  new WebSocket(url) as unknown as WebSocketLike;

/**
 * Same-machine loopback WebSocket rung. Connects to the bridge's local API
 * WS upgrade at ws://127.0.0.1:{port}/ws?nonce=… and speaks the identical
 * DirectMessage JSON protocol as the WebRTC DataChannel (hello/hello_ack gate,
 * ping/pong keepalive). connect() rejects after LOOPBACK_TIMEOUT_MS.
 */
export class LoopbackPeer implements LoopbackPeerApi {
  private readonly clientId: string;
  private readonly port: number;
  private readonly nonce: string;
  private readonly wsFactory: WebSocketFactory;

  private ws: WebSocketLike | null = null;

  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((err: Error) => void) | null = null;
  private settled = false;

  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;

  private closed = false;

  private readonly handlers = new Map<string, TerminalDataHandlers>();
  private readonly closeCbs = new Set<() => void>();

  constructor(opts: LoopbackPeerOptions) {
    this.clientId = opts.clientId;
    this.port = opts.port;
    this.nonce = opts.nonce;
    this.wsFactory = opts.wsFactory ?? defaultWebSocketFactory;
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    this.connectTimer = setTimeout(
      () => this.fail(new Error('loopback timeout')),
      LOOPBACK_TIMEOUT_MS,
    );
    // A synchronous constructor throw (e.g. Safari mixed-content block on
    // ws://127.0.0.1) must become a rejection, never a synchronous throw, so
    // the ladder falls through to WebRTC silently.
    try {
      this.openSocket();
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
    return this.connectPromise;
  }

  private openSocket(): void {
    const url = `ws://127.0.0.1:${this.port}/ws?nonce=${encodeURIComponent(this.nonce)}`;
    const ws = this.wsFactory(url);
    this.ws = ws;
    ws.onopen = () => this.onOpen();
    ws.onmessage = (ev) => this.onFrame(ev.data);
    ws.onerror = () => this.fail(new Error('loopback socket error'));
    ws.onclose = () => this.close();
  }

  private onOpen(): void {
    this.send({ kind: 'hello', clientId: this.clientId, protocolVersion: DIRECT_PROTOCOL_VERSION });
  }

  private onFrame(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: DirectMessage;
    try {
      msg = JSON.parse(raw) as DirectMessage;
    } catch {
      return;
    }
    switch (msg.kind) {
      case 'hello_ack':
        if (msg.protocolVersion !== DIRECT_PROTOCOL_VERSION) {
          this.close();
          return;
        }
        if (this.connectTimer) {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
        this.startPing();
        this.resolve();
        break;
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
    const ws = this.ws;
    if (ws && ws.readyState === WS_OPEN) {
      ws.send(JSON.stringify(msg));
    }
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

    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }

    if (!this.settled) {
      this.reject(new Error('loopback closed'));
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
