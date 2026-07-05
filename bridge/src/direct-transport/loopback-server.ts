import { timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  DIRECT_PROTOCOL_VERSION,
  PING_INTERVAL_MS,
  type DirectMessage,
} from './contract.js';

/** WebSocket upgrade path on the loopback local API server. */
const WS_PATH = '/ws';
const MAX_MISSED_PINGS = 2;
/**
 * Max chars per frame `data` field — mirrors peer-manager's discipline so the
 * loopback rung chunks screens/output identically: one `screen` frame (stream
 * reset) followed by `output` continuations, receivers apply them in order.
 */
const MAX_FRAME_DATA_CHARS = 32_000;

function chunkData(data: string): string[] {
  if (data.length <= MAX_FRAME_DATA_CHARS) return [data];
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += MAX_FRAME_DATA_CHARS) {
    chunks.push(data.slice(i, i + MAX_FRAME_DATA_CHARS));
  }
  return chunks;
}

function constantTimeEq(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Same loopback host guard the HTTP handler applies (defense in depth). */
function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

function isLocalhostOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(origin);
}

export interface LoopbackPeerServerOptions {
  /** This bridge's identity (as advertised on bridges:presence). */
  bridgeId: string;
  /** Per-process nonce; upgrade requires `?nonce=` to match this exactly. */
  nonce: string;
  /** Exact non-localhost origins allowed to upgrade (typically the api-url origin). */
  allowedOrigins: string[];
  /** `input` frames feed here (same sink as terminal-input / DataChannel). */
  onInput: (sessionId: string, data: string) => void;
  /** `resize` frames feed here (same sink as terminal-input / DataChannel). */
  onResize: (sessionId: string, cols: number, rows: number) => void;
  /** Returns the current full serialized screen for a session on attach. */
  onAttach: (sessionId: string) => string;
}

/**
 * One browser WebSocket (one tab). Owns hello gating, per-session monotonic seq,
 * attach set, and app-level ping/pong keepalive — mirrors DirectPeer semantics
 * over a `ws` socket instead of a node-datachannel DataChannel.
 */
class LoopbackPeer {
  private readonly server: LoopbackPeerServer;
  private readonly ws: WebSocket;
  private helloOk = false;
  private closed = false;
  private readonly attached = new Set<string>();
  private readonly seq = new Map<string, number>();
  private pingTimer?: ReturnType<typeof setInterval>;
  private missedPings = 0;

  constructor(server: LoopbackPeerServer, ws: WebSocket) {
    this.server = server;
    this.ws = ws;
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      this.handleFrame(this.decode(data));
    });
    ws.on('close', () => this.server.remove(this));
    ws.on('error', () => this.server.remove(this));
    this.startKeepalive();
  }

  hasAttached(sessionId: string): boolean {
    return this.attached.has(sessionId);
  }

  sendScreen(sessionId: string, data: string): void {
    if (!this.attached.has(sessionId)) return;
    const chunks = chunkData(data);
    this.seq.set(sessionId, chunks.length - 1);
    this.send({ kind: 'screen', sessionId, data: chunks[0], seq: 0 });
    for (let i = 1; i < chunks.length; i++) {
      this.send({ kind: 'output', sessionId, data: chunks[i], seq: i });
    }
  }

  sendOutput(sessionId: string, data: string): void {
    if (!this.attached.has(sessionId)) return;
    for (const chunk of chunkData(data)) {
      const next = (this.seq.get(sessionId) ?? 0) + 1;
      this.seq.set(sessionId, next);
      this.send({ kind: 'output', sessionId, data: chunk, seq: next });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.attached.clear();
    this.seq.clear();
    try { this.ws.close(); } catch { /* already gone */ }
    try { this.ws.terminate(); } catch { /* already gone */ }
  }

  private decode(data: RawData): string {
    if (typeof data === 'string') return data;
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf-8');
    return Buffer.from(data as Buffer).toString('utf-8');
  }

  private startKeepalive(): void {
    if (this.pingTimer) return;
    this.missedPings = 0;
    this.pingTimer = setInterval(() => {
      if (this.missedPings >= MAX_MISSED_PINGS) {
        this.server.remove(this);
        return;
      }
      this.missedPings += 1;
      this.send({ kind: 'ping' });
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private handleFrame(raw: string): void {
    let msg: DirectMessage;
    try {
      msg = JSON.parse(raw) as DirectMessage;
    } catch {
      return;
    }
    switch (msg.kind) {
      case 'hello': {
        if (msg.protocolVersion !== DIRECT_PROTOCOL_VERSION) {
          this.server.remove(this);
          return;
        }
        this.helloOk = true;
        this.send({ kind: 'hello_ack', bridgeId: this.server.bridgeId, protocolVersion: DIRECT_PROTOCOL_VERSION });
        return;
      }
      case 'attach': {
        if (!this.helloOk) return;
        this.attached.add(msg.sessionId);
        this.sendScreen(msg.sessionId, this.server.getScreen(msg.sessionId));
        return;
      }
      case 'detach': {
        this.attached.delete(msg.sessionId);
        this.seq.delete(msg.sessionId);
        return;
      }
      case 'input': {
        if (!this.helloOk) return;
        this.server.deliverInput(msg.sessionId, msg.data);
        return;
      }
      case 'resize': {
        if (!this.helloOk) return;
        this.server.deliverResize(msg.sessionId, msg.cols, msg.rows);
        return;
      }
      case 'ping': {
        this.send({ kind: 'pong' });
        return;
      }
      case 'pong': {
        this.missedPings = 0;
        return;
      }
      default:
        // Unknown kind ⇒ ignore.
        return;
    }
  }

  private send(msg: DirectMessage): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // Drop the frame rather than kill the socket; a genuinely dead socket is
      // caught by close/error or missed pings. One socket's failure must never
      // touch another.
    }
  }
}

/**
 * Loopback WebSocket rung. Attaches an `upgrade` handler to the existing
 * 127.0.0.1 local API http.Server, gating upgrades on nonce + Origin + loopback
 * host (L1), then speaks the DirectMessage wire protocol (L3) over each socket.
 * Multiple concurrent sockets (tabs) are allowed; output/screen fan to all
 * attached sockets.
 */
export class LoopbackPeerServer {
  readonly bridgeId: string;
  private readonly nonce: string;
  private readonly allowedOrigins: string[];
  private readonly onInputCb: (sessionId: string, data: string) => void;
  private readonly onResizeCb: (sessionId: string, cols: number, rows: number) => void;
  private readonly onAttachCb: (sessionId: string) => string;
  private readonly wss: WebSocketServer;
  private readonly peers = new Set<LoopbackPeer>();
  private httpServer?: HttpServer;
  private upgradeHandler?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

  constructor(options: LoopbackPeerServerOptions) {
    this.bridgeId = options.bridgeId;
    this.nonce = options.nonce;
    this.allowedOrigins = options.allowedOrigins;
    this.onInputCb = options.onInput;
    this.onResizeCb = options.onResize;
    this.onAttachCb = options.onAttach;
    this.wss = new WebSocketServer({ noServer: true });
  }

  /** Binds the loopback WS upgrade handler onto the running local API server. */
  attach(server: HttpServer): void {
    this.httpServer = server;
    this.upgradeHandler = (req, socket, head) => this.handleUpgrade(req, socket, head);
    server.on('upgrade', this.upgradeHandler);
  }

  sendOutput(sessionId: string, data: string): void {
    for (const peer of this.peers) peer.sendOutput(sessionId, data);
  }

  sendScreen(sessionId: string, data: string): void {
    for (const peer of this.peers) peer.sendScreen(sessionId, data);
  }

  hasAttachedPeers(sessionId: string): boolean {
    for (const peer of this.peers) {
      if (peer.hasAttached(sessionId)) return true;
    }
    return false;
  }

  closeAll(): void {
    if (this.httpServer && this.upgradeHandler) {
      this.httpServer.removeListener('upgrade', this.upgradeHandler);
      this.upgradeHandler = undefined;
    }
    for (const peer of this.peers) peer.close();
    this.peers.clear();
    try { this.wss.close(); } catch { /* already closed */ }
  }

  /** Internal: drops a peer and closes its socket (called on close/error/death). */
  remove(peer: LoopbackPeer): void {
    this.peers.delete(peer);
    peer.close();
  }

  getScreen(sessionId: string): string {
    return this.onAttachCb(sessionId);
  }

  deliverInput(sessionId: string, data: string): void {
    this.onInputCb(sessionId, data);
  }

  deliverResize(sessionId: string, cols: number, rows: number): void {
    this.onResizeCb(sessionId, cols, rows);
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    } catch {
      this.reject(socket, 400, 'Bad Request');
      return;
    }
    // Not our path and no other upgrade listener exists on the local API
    // server: reject rather than leave the socket dangling (fd leak).
    if (url.pathname !== WS_PATH) {
      this.reject(socket, 404, 'Not Found');
      return;
    }

    if (!isLoopbackHost(req.headers.host)) {
      this.reject(socket, 421, 'Misdirected Request');
      return;
    }
    if (!this.originAllowed(req.headers.origin)) {
      this.reject(socket, 403, 'Forbidden');
      return;
    }
    if (!this.nonceMatches(url.searchParams.get('nonce'))) {
      this.reject(socket, 403, 'Forbidden');
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.peers.add(new LoopbackPeer(this, ws));
    });
  }

  private originAllowed(origin: string | undefined): boolean {
    if (typeof origin !== 'string' || origin === '') return false;
    if (isLocalhostOrigin(origin)) return true;
    return this.allowedOrigins.includes(origin);
  }

  private nonceMatches(nonce: string | null): boolean {
    if (typeof nonce !== 'string' || nonce === '') return false;
    return constantTimeEq(nonce, this.nonce);
  }

  private reject(socket: Duplex, code: number, reason: string): void {
    try {
      socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch {
      // Socket already gone; destroy below is still safe.
    }
    socket.destroy();
  }
}
