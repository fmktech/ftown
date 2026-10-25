/**
 * Contract-level tests for LoopbackPeerServer (docs/plans/loopback-transport-addendum.md,
 * rules L1/L3, and the DirectMessage wire contract in contract.ts shared with the WebRTC
 * transport). Written against the FROZEN addendum module surface — the implementation
 * (loopback-server.ts) may not exist yet; this file documents the expected contract and
 * is the gate the implementer's module must satisfy.
 *
 * Module surface assumed (frozen addendum, Bridge section):
 *   new LoopbackPeerServer({ nonce, allowedOrigins, onInput, onResize, onAttach, bridgeId })
 *   server.attach(httpServer)   — binds the /ws upgrade handler onto an existing http.Server
 *                                  (the addendum's constructor fields don't include the
 *                                  http.Server itself, mirroring DirectPeerManager's
 *                                  lazy-connection pattern; `attach` is this test's
 *                                  interpretation of how L1's "EXISTING loopback-only local
 *                                  API server" gets wired — see ambiguity note in the report).
 *   sendOutput(sessionId, data) / sendScreen(sessionId, data) / hasAttachedPeers(sessionId)
 *   closeAll()
 *
 * Real sockets on loopback (127.0.0.1:0, ephemeral port), real `ws` client — same
 * convention as other bridge integration tests (e.g. local-api-server.test.ts uses a real
 * http server + fetch).
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { secureFixture } from '../security/bridge/fixtures.test.js';
import { loadLocalIdentity } from '../security/bridge/identity.js';
import { seal, open } from '../security/crypto.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';

import { LoopbackPeerServer } from './loopback-server.js';
import { DIRECT_PROTOCOL_VERSION } from './contract.js';
import type { DirectMessage } from './contract.js';

const NONCE = 'unit-public-pair-id';
const ALLOWED_ORIGIN = 'http://localhost:5173';
const BRIDGE_ID = 'bridge';
const secureHarnesses = new Map<number, { security: Awaited<ReturnType<typeof secureFixture>>['security']; remote: Awaited<ReturnType<typeof loadLocalIdentity>>; directory: string }>();

/** Private chunking constant mirrored from peer-manager.ts (MAX_FRAME_DATA_CHARS). */
const CHUNK_SIZE = 32_000;

interface Harness {
  httpServer: Server;
  loopback: LoopbackPeerServer;
  port: number;
  onInputCalls: Array<[string, string]>;
  onResizeCalls: Array<[string, number, number]>;
  attachScreens: Map<string, string>;
}

async function startHarness(overrides?: { attachScreens?: Map<string, string> }): Promise<Harness> {
  const httpServer = createServer();
  const directory = await mkdtemp(join(tmpdir(), 'ftown-loopback-unit-'));
  const secure = await secureFixture(directory, async () => new Response('{}'));
  const remote = await loadLocalIdentity(directory, secure.pointer.ownerId!);
  const onInputCalls: Array<[string, string]> = [];
  const onResizeCalls: Array<[string, number, number]> = [];
  const attachScreens = overrides?.attachScreens ?? new Map<string, string>();

  const loopback = new LoopbackPeerServer({
    security: secure.security,
    nonce: NONCE,
    allowedOrigins: [ALLOWED_ORIGIN],
    bridgeId: BRIDGE_ID,
    onInput: (sessionId: string, data: string) => onInputCalls.push([sessionId, data]),
    onResize: (sessionId: string, cols: number, rows: number) => onResizeCalls.push([sessionId, cols, rows]),
    onAttach: (sessionId: string) => attachScreens.get(sessionId) ?? '',
  });
  loopback.attach(httpServer);

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  secureHarnesses.set(port, { security: secure.security, remote, directory });

  return { httpServer, loopback, port, onInputCalls, onResizeCalls, attachScreens };
}

async function stopHarness(h: Harness): Promise<void> {
  h.loopback.closeAll();
  const secure = secureHarnesses.get(h.port); secureHarnesses.delete(h.port);
  if (secure) { await secure.security.close(); await rm(secure.directory, { recursive: true, force: true }); }
  await new Promise<void>((resolve) => h.httpServer.close(() => resolve()));
}

function wsUrl(port: number, nonce?: string): string {
  const qs = nonce === undefined ? '' : `?pairId=${encodeURIComponent(nonce)}`;
  return `ws://127.0.0.1:${port}/ws${qs}`;
}

/**
 * Ordered inbound-message queue for one socket. Attached the instant the socket
 * is created (before 'open' even fires) so that a burst of frames arriving in
 * the same read (e.g. a chunked screen: screen + N output continuations, which
 * the server writes back-to-back) can never race a consumer that calls `next()`
 * sequentially with `await` in between — a bare `socket.once('message', ...)`
 * re-armed only after each `await` can miss a message emitted synchronously
 * right after the previous one, before the microtask queue drains.
 */
class MessageQueue {
  private readonly pending: DirectMessage[] = [];
  private readonly waiters: Array<(msg: DirectMessage) => void> = [];

  constructor(socket: WebSocket) {
    let pending = Promise.resolve();
    socket.on('message', raw => {
      pending = pending.then(async () => {
        const location = new URL(socket.url); const state = secureHarnesses.get(Number(location.port))!;
        const packet = JSON.parse(String(raw));
        const decoded = JSON.parse(new TextDecoder().decode(await open(state.remote, state.security.endpoint, packet, {
          ownerId: state.remote.endpoint.ownerId, bridgeId: BRIDGE_ID, channel: `direct:loopback-ws:${BRIDGE_ID}:${location.searchParams.get('pairId')}`,
          recipientId: state.remote.endpoint.id, purpose: packet.purpose })));
        const msg = packet.purpose === 'welcome' ? { kind: 'hello_ack', bridgeId: BRIDGE_ID, protocolVersion: DIRECT_PROTOCOL_VERSION } as DirectMessage : decoded.data as DirectMessage;
        const waiter = this.waiters.shift(); if (waiter) waiter(msg); else this.pending.push(msg);
      });
    });;
  }

  next(): Promise<DirectMessage> {
    const queued = this.pending.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('message timeout')), 2_000);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }
}

const queues = new WeakMap<WebSocket, MessageQueue>();

function queueFor(socket: WebSocket): MessageQueue {
  let queue = queues.get(socket);
  if (!queue) {
    queue = new MessageQueue(socket);
    queues.set(socket, queue);
  }
  return queue;
}

/** Connects and resolves either with the open socket, or rejects with the rejection response. */
function connect(
  port: number,
  opts: { nonce?: string; origin?: string; host?: string } = {},
): Promise<{ socket?: WebSocket; rejected?: { statusCode: number } }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl(port, opts.nonce), {
      headers: {
        ...(opts.origin === undefined ? {} : { Origin: opts.origin }),
        ...(opts.host === undefined ? {} : { Host: opts.host }),
      },
    });
    const nativeSend = socket.send.bind(socket);
    let outgoing = Promise.resolve();
    socket.send = ((data: unknown) => {
      let frame: { kind?: string; sessionId?: string; protocolVersion?: number };
      try { frame = JSON.parse(String(data)); } catch { nativeSend(data as WebSocket.Data); return; }
      outgoing = outgoing.then(async () => {
        const state = secureHarnesses.get(port)!;
        const pairId = new URL(socket.url).searchParams.get('pairId')!;
        const channel = `direct:loopback-ws:${BRIDGE_ID}:${pairId}`;
        const hello = frame.kind === 'hello';
        const body = hello ? { type: 'hello', challenge: randomUUID() } : { type: 'application', route: { kind: 'terminal',
          sessionId: frame.sessionId ?? '', frameType: frame.kind, pairId }, data: frame, mcp: null };
        const packet = await seal(state.remote, state.security.endpoint, { type: 'ftown_encrypted', version: 1, senderId: state.remote.endpoint.id,
          recipientId: state.security.endpoint.id, ownerId: state.remote.endpoint.ownerId, bridgeId: BRIDGE_ID, channel,
          purpose: hello ? 'hello' : 'application', messageId: randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + 60000,
          receiverEpoch: hello ? null : state.security.receiverEpoch }, new TextEncoder().encode(JSON.stringify(body)));
        nativeSend(JSON.stringify(hello && frame.protocolVersion !== DIRECT_PROTOCOL_VERSION ? { ...packet, version: 2 } : packet));
      });
    }) as typeof socket.send;
    // Arm the message queue immediately — before 'open' — so nothing sent by
    // the server the instant the connection opens can be missed.
    queueFor(socket);
    const timer = setTimeout(() => reject(new Error('connect timeout')), 2_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve({ socket });
    });
    socket.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      socket.terminate();
      resolve({ rejected: { statusCode: res.statusCode ?? 0 } });
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForMessage(socket: WebSocket): Promise<DirectMessage> {
  return queueFor(socket).next();
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once('close', (code) => resolve(code));
  });
}

async function handshake(port: number): Promise<WebSocket> {
  const { socket } = await connect(port, { nonce: NONCE, origin: ALLOWED_ORIGIN });
  assert.ok(socket, 'expected the valid-pair-id/allowed-origin connection to open');
  const hello: DirectMessage = { kind: 'hello', clientId: 'client-1', protocolVersion: DIRECT_PROTOCOL_VERSION };
  socket!.send(JSON.stringify(hello));
  const ack = await waitForMessage(socket!);
  assert.strictEqual(ack.kind, 'hello_ack');
  return socket!;
}

describe('LoopbackPeerServer upgrade auth (L1)', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await stopHarness(h);
  });

  it('rejects a malformed public pair identifier before upgrade', async () => {
    const result = await connect(h.port, { nonce: 'invalid/pair/id', origin: ALLOWED_ORIGIN });
    assert.ok(result.rejected, 'expected the upgrade to be rejected');
    assert.strictEqual(result.rejected!.statusCode, 403);
  });

  it('rejects an upgrade with a missing public pair identifier', async () => {
    const result = await connect(h.port, { origin: ALLOWED_ORIGIN });
    assert.ok(result.rejected, 'expected the upgrade to be rejected');
    assert.strictEqual(result.rejected!.statusCode, 403);
  });

  it('rejects an upgrade from a disallowed Origin', async () => {
    const result = await connect(h.port, { nonce: NONCE, origin: 'http://evil.example.com' });
    assert.ok(result.rejected, 'expected the upgrade to be rejected');
    assert.strictEqual(result.rejected!.statusCode, 403);
  });

  it('accepts an upgrade with the well-formed public pair identifier and an allowed localhost Origin', async () => {
    const result = await connect(h.port, { nonce: NONCE, origin: ALLOWED_ORIGIN });
    assert.ok(result.socket, 'expected the connection to open');
    result.socket!.close();
  });
});

describe('LoopbackPeerServer hello gating (L3)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await stopHarness(h);
  });

  it('closes the socket on a protocol version mismatch', async () => {
    const { socket } = await connect(h.port, { nonce: NONCE, origin: ALLOWED_ORIGIN });
    const hello: DirectMessage = { kind: 'hello', clientId: 'client-1', protocolVersion: DIRECT_PROTOCOL_VERSION + 1 };
    const closed = waitForClose(socket!);
    socket!.send(JSON.stringify(hello));
    await closed;
  });

  it('ignores attach/input/resize sent before hello', async () => {
    const { socket } = await connect(h.port, { nonce: NONCE, origin: ALLOWED_ORIGIN });
    h.attachScreens.set('sess-1', 'SCREEN');

    const attach: DirectMessage = { kind: 'attach', sessionId: 'sess-1' };
    const input: DirectMessage = { kind: 'input', sessionId: 'sess-1', data: 'ls\n' };
    const resize: DirectMessage = { kind: 'resize', sessionId: 'sess-1', cols: 80, rows: 24 };
    socket!.send(JSON.stringify(attach));
    socket!.send(JSON.stringify(input));
    socket!.send(JSON.stringify(resize));

    // Give the server a beat to (not) process these; assert nothing arrived/fired.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepStrictEqual(h.onInputCalls, []);
    assert.deepStrictEqual(h.onResizeCalls, []);
    assert.strictEqual(h.loopback.hasAttachedPeers('sess-1'), false);
    socket!.close();
  });

  it('processes attach/input/resize normally after hello_ack', async () => {
    h.attachScreens.set('sess-1', 'SCREEN');
    const socket = await handshake(h.port);

    const attach: DirectMessage = { kind: 'attach', sessionId: 'sess-1' };
    socket.send(JSON.stringify(attach));
    const screenMsg = await waitForMessage(socket);
    assert.strictEqual(screenMsg.kind, 'screen');

    const input: DirectMessage = { kind: 'input', sessionId: 'sess-1', data: 'ls\n' };
    const resize: DirectMessage = { kind: 'resize', sessionId: 'sess-1', cols: 80, rows: 24 };
    socket.send(JSON.stringify(input));
    socket.send(JSON.stringify(resize));
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.deepStrictEqual(h.onInputCalls, [['sess-1', 'ls\n']]);
    assert.deepStrictEqual(h.onResizeCalls, [['sess-1', 80, 24]]);
    socket.close();
  });
});

describe('LoopbackPeerServer attach ⇒ screen, seq (L3, R7)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await stopHarness(h);
  });

  it('attach yields a screen frame (seq 0) before any output frame', async () => {
    h.attachScreens.set('sess-1', 'INITIAL-SCREEN');
    const socket = await handshake(h.port);

    socket.send(JSON.stringify({ kind: 'attach', sessionId: 'sess-1' } satisfies DirectMessage));
    const screenMsg = await waitForMessage(socket);
    assert.strictEqual(screenMsg.kind, 'screen');
    if (screenMsg.kind === 'screen') {
      assert.strictEqual(screenMsg.data, 'INITIAL-SCREEN');
      assert.strictEqual(screenMsg.seq, 0);
    }

    h.loopback.sendOutput('sess-1', 'out-1');
    const out1 = await waitForMessage(socket);
    assert.strictEqual(out1.kind, 'output');
    if (out1.kind === 'output') assert.strictEqual(out1.seq, 1);

    h.loopback.sendOutput('sess-1', 'out-2');
    const out2 = await waitForMessage(socket);
    if (out2.kind === 'output') assert.strictEqual(out2.seq, 2);

    socket.close();
  });

  it('re-attach resets the seq stream back to 0 on the new screen', async () => {
    h.attachScreens.set('sess-1', 'SCREEN-A');
    const socket = await handshake(h.port);

    socket.send(JSON.stringify({ kind: 'attach', sessionId: 'sess-1' } satisfies DirectMessage));
    await waitForMessage(socket); // screen seq 0
    h.loopback.sendOutput('sess-1', 'x');
    await waitForMessage(socket); // output seq 1

    h.attachScreens.set('sess-1', 'SCREEN-B');
    socket.send(JSON.stringify({ kind: 'attach', sessionId: 'sess-1' } satisfies DirectMessage));
    const rescreen = await waitForMessage(socket);
    assert.strictEqual(rescreen.kind, 'screen');
    if (rescreen.kind === 'screen') {
      assert.strictEqual(rescreen.data, 'SCREEN-B');
      assert.strictEqual(rescreen.seq, 0);
    }
    socket.close();
  });
});

describe('LoopbackPeerServer chunking (R7 chunk limits)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await stopHarness(h);
  });

  it('a screen over the chunk limit arrives as screen + output continuations reconstructing the data', async () => {
    const bigScreen = 'A'.repeat(CHUNK_SIZE) + 'B'.repeat(CHUNK_SIZE) + 'C'.repeat(100);
    h.attachScreens.set('sess-1', bigScreen);
    const socket = await handshake(h.port);

    socket.send(JSON.stringify({ kind: 'attach', sessionId: 'sess-1' } satisfies DirectMessage));

    const frames: DirectMessage[] = [];
    for (let i = 0; i < 3; i++) frames.push(await waitForMessage(socket));

    assert.strictEqual(frames[0].kind, 'screen');
    assert.strictEqual(frames[1].kind, 'output');
    assert.strictEqual(frames[2].kind, 'output');

    const reconstructed = frames
      .map((f) => (f.kind === 'screen' || f.kind === 'output' ? f.data : ''))
      .join('');
    assert.strictEqual(reconstructed, bigScreen);
    assert.strictEqual(reconstructed.length, CHUNK_SIZE * 2 + 100);

    socket.close();
  });

  it('a >32,000-char output is split into multiple continuation output frames with monotonic seq', async () => {
    h.attachScreens.set('sess-1', 'SCREEN');
    const socket = await handshake(h.port);
    socket.send(JSON.stringify({ kind: 'attach', sessionId: 'sess-1' } satisfies DirectMessage));
    await waitForMessage(socket); // screen seq 0

    const bigOutput = 'Z'.repeat(CHUNK_SIZE + 500);
    h.loopback.sendOutput('sess-1', bigOutput);

    const chunk1 = await waitForMessage(socket);
    const chunk2 = await waitForMessage(socket);
    assert.strictEqual(chunk1.kind, 'output');
    assert.strictEqual(chunk2.kind, 'output');
    if (chunk1.kind === 'output' && chunk2.kind === 'output') {
      assert.strictEqual(chunk1.seq, 1);
      assert.strictEqual(chunk2.seq, 2);
      assert.strictEqual(chunk1.data + chunk2.data, bigOutput);
    }
    socket.close();
  });
});

describe('LoopbackPeerServer frame handling edge cases', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await stopHarness(h);
  });

  it('ignores frames with an unauthorized unknown kind', async () => {
    const socket = await handshake(h.port);
    socket.send(JSON.stringify({ kind: 'bogus', sessionId: 'sess-1' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepStrictEqual(h.onInputCalls, []);
    assert.deepStrictEqual(h.onResizeCalls, []);
    socket.close();
  });

  it('malformed JSON does not crash the server and does not affect a second concurrent socket', async () => {
    h.attachScreens.set('sess-1', 'SCREEN');
    const socketA = await handshake(h.port);
    const socketB = await handshake(h.port);

    socketA.send('{not valid json');
    // Give the server a beat; it must still be alive and serving socketB.
    await new Promise((resolve) => setTimeout(resolve, 200));

    socketB.send(JSON.stringify({ kind: 'attach', sessionId: 'sess-1' } satisfies DirectMessage));
    const screenMsg = await waitForMessage(socketB);
    assert.strictEqual(screenMsg.kind, 'screen');

    socketA.close();
    socketB.close();
  });
});

describe('LoopbackPeerServer concurrent peers', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await stopHarness(h);
  });

  it('both attached sockets receive fanned-out output', async () => {
    h.attachScreens.set('sess-1', 'SCREEN');
    const socketA = await handshake(h.port);
    const socketB = await handshake(h.port);

    socketA.send(JSON.stringify({ kind: 'attach', sessionId: 'sess-1' } satisfies DirectMessage));
    socketB.send(JSON.stringify({ kind: 'attach', sessionId: 'sess-1' } satisfies DirectMessage));
    await waitForMessage(socketA); // screen
    await waitForMessage(socketB); // screen

    h.loopback.sendOutput('sess-1', 'fanned-out');
    const outA = await waitForMessage(socketA);
    const outB = await waitForMessage(socketB);
    assert.strictEqual(outA.kind, 'output');
    assert.strictEqual(outB.kind, 'output');
    if (outA.kind === 'output') assert.strictEqual(outA.data, 'fanned-out');
    if (outB.kind === 'output') assert.strictEqual(outB.data, 'fanned-out');

    socketA.close();
    socketB.close();
  });

  it('closing one socket does not affect the other, and hasAttachedPeers reflects remaining attach state', async () => {
    h.attachScreens.set('sess-1', 'SCREEN');
    const socketA = await handshake(h.port);
    const socketB = await handshake(h.port);

    socketA.send(JSON.stringify({ kind: 'attach', sessionId: 'sess-1' } satisfies DirectMessage));
    socketB.send(JSON.stringify({ kind: 'attach', sessionId: 'sess-1' } satisfies DirectMessage));
    await waitForMessage(socketA);
    await waitForMessage(socketB);
    assert.strictEqual(h.loopback.hasAttachedPeers('sess-1'), true);

    const closedA = waitForClose(socketA);
    socketA.close();
    await closedA;
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.strictEqual(h.loopback.hasAttachedPeers('sess-1'), true, 'socketB is still attached');

    h.loopback.sendOutput('sess-1', 'still-alive');
    const outB = await waitForMessage(socketB);
    assert.strictEqual(outB.kind, 'output');

    socketB.close();
  });

  it('hasAttachedPeers is false before any attach and closeAll tears down every socket', async () => {
    h.attachScreens.set('sess-1', 'SCREEN');
    assert.strictEqual(h.loopback.hasAttachedPeers('sess-1'), false);

    const socketA = await handshake(h.port);
    const socketB = await handshake(h.port);
    socketA.send(JSON.stringify({ kind: 'attach', sessionId: 'sess-1' } satisfies DirectMessage));
    socketB.send(JSON.stringify({ kind: 'attach', sessionId: 'sess-1' } satisfies DirectMessage));
    await waitForMessage(socketA);
    await waitForMessage(socketB);

    const closedA = waitForClose(socketA);
    const closedB = waitForClose(socketB);
    h.loopback.closeAll();
  const secure = secureHarnesses.get(h.port); secureHarnesses.delete(h.port);
  if (secure) { await secure.security.close(); await rm(secure.directory, { recursive: true, force: true }); }
    await Promise.all([closedA, closedB]);

    assert.strictEqual(h.loopback.hasAttachedPeers('sess-1'), false);
  });
});

describe('LoopbackPeerServer host-header guard (L1 defense in depth)', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await stopHarness(h);
  });

  it('rejects an upgrade with a non-loopback Host header with 421, even with well-formed public pair identifier + allowed Origin', async () => {
    // DNS-rebinding style request: TCP lands on 127.0.0.1 but the Host header
    // names a foreign authority. Must be refused (421 Misdirected Request)
    // before the Origin/nonce checks even run — correct credentials must not save it.
    const result = await connect(h.port, {
      nonce: NONCE,
      origin: ALLOWED_ORIGIN,
      host: 'evil.com:1234',
    });
    assert.ok(result.rejected, 'expected the upgrade to be rejected');
    assert.strictEqual(result.rejected!.statusCode, 421);
  });

  it('a loopback Host with a port (127.0.0.1:{port}) passes the host guard', async () => {
    // Sanity companion: the guard must strip the port, not string-compare it.
    const result = await connect(h.port, {
      nonce: NONCE,
      origin: ALLOWED_ORIGIN,
      host: `127.0.0.1:${h.port}`,
    });
    assert.ok(result.socket, 'expected the loopback-host connection to open');
    result.socket!.close();
  });
});

describe('LoopbackPeerServer missing Origin header (L1)', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await stopHarness(h);
  });

  it('rejects an upgrade with no Origin header at all, even with the well-formed public pair identifier (403)', async () => {
    // Pinned contract behavior per addendum L1: the upgrade requires the nonce
    // AND "an Origin header that is either the configured api-url origin or a
    // localhost origin" — an ABSENT Origin satisfies neither clause, so it is
    // rejected (the implementation's origin check requires a non-empty string).
    // Consequence: non-browser clients (e.g. Node's `ws`, which sends no Origin
    // by default) must set an explicit localhost Origin to connect.
    const result = await connect(h.port, { nonce: NONCE });
    assert.ok(result.rejected, 'expected the upgrade without an Origin header to be rejected');
    assert.strictEqual(result.rejected!.statusCode, 403);
  });
});

// Keepalive-death coverage gap (reviewed, intentionally not tested here):
// the implementation pings on the imported PING_INTERVAL_MS constant (15_000 ms,
// contract.ts) with MAX_MISSED_PINGS = 2, so a socket that never answers is only
// torn down after ~30-45 s of real time — far over this suite's budget — and
// LoopbackPeerServerOptions exposes no timer/interval injection point (unlike
// WatchRegistry's injectable clock). Making this testable requires the
// implementation to accept an injectable `pingIntervalMs` (or scheduler/clock)
// in its options. Until then, only the ping/pong protocol conformance (server
// answers `ping` with `pong`; `pong` resets the miss counter) is reachable from
// contract tests; the death path runs only in production.
