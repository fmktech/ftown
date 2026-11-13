/**
 * Property test for the terminal output path: whatever the interleaving of PTY
 * output, attaches, screen requests, watchers and resizes, a viewer that applies
 * the frames it receives in order (`screen` resets, `output` appends) must end
 * up with exactly the bridge emulator's content — nothing lost, nothing twice.
 *
 * Everything on the bridge side is real: TerminalPump, TerminalManager,
 * PublishRouter, WatchRegistry, LoopbackPeerServer (over a real WebSocket) and
 * DirectPeerManager (over an in-memory data channel). Only the PTY, the relay
 * publisher and the viewers' ends of the encrypted channels are test code.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import xtermHeadless, { type Terminal as TerminalType } from '@xterm/headless';
import WebSocket from 'ws';

import { secureFixture } from './security/bridge/fixtures.test.js';
import { loadLocalIdentity } from './security/bridge/identity.js';
import { seal, open } from './security/crypto.js';
import { DIRECT_PROTOCOL_VERSION } from './direct-transport/contract.js';
import { LoopbackPeerServer } from './direct-transport/loopback-server.js';
import { DirectPeerManager, type DirectDataChannel, type DirectPeerConnection } from './direct-transport/peer-manager.js';
import { PublishRouter } from './direct-transport/publish-router.js';
import { WatchRegistry } from './direct-transport/watch-registry.js';
import { TerminalManager } from './terminal-manager.js';
import { createTerminalOutput, type TerminalOutputDeps } from './terminal-output.js';

const { Terminal } = xtermHeadless;
const BRIDGE_ID = 'bridge';
const SESSION = 'sess-1';
const ORIGIN = 'http://localhost:5173';
const PAIR = 'consistency-pair';

const directory = await mkdtemp(join(tmpdir(), 'ftown-stream-consistency-'));
const secure = await secureFixture(directory, async () => new Response('{}'));
const remote = await loadLocalIdentity(directory, secure.pointer.ownerId!);
after(async () => { await secure.security.close(); await rm(directory, { recursive: true, force: true }); });

type Frame = { kind: string; sessionId?: string; data?: string };

async function sealFrame(channel: string, pairId: string, frame: Frame & Record<string, unknown>): Promise<string> {
  const hello = frame.kind === 'hello';
  const body = hello ? { type: 'hello', challenge: randomUUID() } : { type: 'application', route: { kind: 'terminal',
    sessionId: frame.sessionId ?? '', frameType: frame.kind, pairId }, data: frame, mcp: null };
  return JSON.stringify(await seal(remote, secure.security.endpoint, { type: 'ftown_encrypted', version: 1, senderId: remote.endpoint.id,
    recipientId: secure.security.endpoint.id, ownerId: remote.endpoint.ownerId, bridgeId: BRIDGE_ID, channel,
    purpose: hello ? 'hello' : 'application', messageId: randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + 60000,
    receiverEpoch: hello ? null : secure.security.receiverEpoch }, new TextEncoder().encode(JSON.stringify(body))));
}

async function openFrame(channel: string, raw: string): Promise<Frame> {
  const packet = JSON.parse(raw);
  if (packet.purpose === 'welcome') return { kind: 'hello_ack' };
  const decoded = JSON.parse(new TextDecoder().decode(await open(remote, secure.security.endpoint, packet, {
    ownerId: remote.endpoint.ownerId, bridgeId: BRIDGE_ID, channel, recipientId: remote.endpoint.id, purpose: packet.purpose })));
  return decoded.data as Frame;
}

/** A viewer's terminal: applies frames the way ui/src/components/Terminal.tsx does. */
class Viewer {
  readonly term: TerminalType;
  /** True once a screen arrived and nothing since made the stream incomplete. */
  synced = false;
  frames = 0;
  private applied: Promise<void> = Promise.resolve();
  readonly log: string[] = [];

  constructor(readonly name: string, cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: 50000, allowProposedApi: true });
  }

  apply(frame: Frame): void {
    if (frame.sessionId !== SESSION || (frame.kind !== 'screen' && frame.kind !== 'output')) return;
    this.frames++;
    this.log.push(`${frame.kind}:${JSON.stringify(frame.data).slice(0, 80)}`);
    if (frame.kind === 'screen') {
      this.term.reset();
      this.synced = true;
    }
    const data = frame.data ?? '';
    this.applied = this.applied.then(() => new Promise<void>((resolve) => this.term.write(data, resolve)));
  }

  settled(): Promise<void> { return this.applied; }
}

function textOf(term: TerminalType): string[] {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface World {
  terminalManager: TerminalManager;
  runner: EventEmitter;
  registry: WatchRegistry;
  router: PublishRouter;
  loopback: LoopbackPeerServer;
  peers: DirectPeerManager;
  viewers: { relay: Viewer; loopback: Viewer; webrtc: Viewer };
  sendLoopback(frame: Frame & Record<string, unknown>): void;
  sendWebrtc(frame: Frame & Record<string, unknown>): void;
  publishScreenDump(): void;
  resize(cols: number, rows: number): void;
  idle(): Promise<void>;
  close(): Promise<void>;
}

async function makeWorld(cols: number, rows: number): Promise<World> {
  const terminalManager = new TerminalManager(50000, cols);
  const runner = Object.assign(new EventEmitter(), { stopAll: () => undefined });
  const registry = new WatchRegistry({ sweepIntervalMs: 0 });
  const viewers = { relay: new Viewer('relay', cols, rows), loopback: new Viewer('loopback', cols, rows), webrtc: new Viewer('webrtc', cols, rows) };
  let activity = 0;

  // --- WebRTC rung over an in-memory data channel ---------------------------
  const webrtcChannel = `direct:webrtc:${BRIDGE_ID}:${PAIR}`;
  let webrtcInbound: ((msg: string) => unknown) | undefined;
  let webrtcDecode: Promise<void> = Promise.resolve();
  const dc: DirectDataChannel = {
    onMessage: (cb) => { webrtcInbound = cb as (msg: string) => unknown; },
    onOpen: () => undefined,
    onClosed: () => undefined,
    onError: () => undefined,
    isOpen: () => true,
    sendMessage: (payload: string) => {
      activity++;
      webrtcDecode = webrtcDecode.then(async () => { viewers.webrtc.apply(await openFrame(webrtcChannel, payload)); activity++; });
      return true;
    },
    close: () => undefined,
  } as unknown as DirectDataChannel;
  let onDataChannel: ((channel: DirectDataChannel) => void) | undefined;
  let onLocalDescription: ((sdp: string, type: string) => void) | undefined;
  const pc = {
    onLocalDescription: (cb: (sdp: string, type: string) => void) => { onLocalDescription = cb; },
    onLocalCandidate: () => undefined,
    onStateChange: () => undefined,
    setRemoteDescription: () => undefined,
    addRemoteCandidate: () => undefined,
    onDataChannel: (cb: (channel: DirectDataChannel) => void) => { onDataChannel = cb; },
    close: () => undefined,
  } as unknown as DirectPeerConnection;

  let output!: ReturnType<typeof createTerminalOutput>;
  const resize = (c: number, r: number): void => { terminalManager.resize(SESSION, c, r); };
  const peers = new DirectPeerManager({
    bridgeId: BRIDGE_ID,
    security: secure.security,
    sendSignal: () => undefined,
    onInput: () => undefined,
    onResize: (_sid, c, r) => resize(c, r),
    onAttach: (sid, deliver) => output.attachScreen(sid, deliver),
    peerConnectionFactory: () => pc,
  });

  // --- Loopback rung over a real WebSocket ----------------------------------
  const httpServer = createServer();
  const loopback = new LoopbackPeerServer({
    security: secure.security,
    nonce: PAIR,
    allowedOrigins: [ORIGIN],
    bridgeId: BRIDGE_ID,
    onInput: () => undefined,
    onResize: (_sid, c, r) => resize(c, r),
    onAttach: (sid, deliver) => output.attachScreen(sid, deliver),
  });
  loopback.attach(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;

  // --- Relay: frames published to Centrifugo reach the relay viewer ---------
  const router = new PublishRouter({
    registry,
    peerManager: peers,
    loopback,
    userId: 'user',
    centrifugo: {
      publishTerminalData: async (_user, sessionId, data) => { activity++; viewers.relay.apply({ kind: 'output', sessionId, data }); },
      publishTerminalScreen: async (_user, sessionId, data) => { activity++; viewers.relay.apply({ kind: 'screen', sessionId, data }); },
    },
  });

  output = createTerminalOutput({
    store: {
      appendTerminalData: async () => undefined,
      loadSession: async () => null,
      saveSession: async () => undefined,
      loadTerminalLog: async () => '',
      setPendingTerminalFlush: () => undefined,
    },
    terminalManager,
    runner: runner as unknown as TerminalOutputDeps['runner'],
    router,
    watchRegistry: registry,
    lifecycle: { publishSessionUpdate: async () => undefined, publishHookEvent: async () => undefined, unregisterSession: () => undefined },
  });
  // As in index.ts: every new remote watcher gets a full screen resync.
  registry.onNewWatcher((sid) => output.publishScreenDump(sid));

  // Loopback viewer's socket.
  const loopbackChannel = `direct:loopback-ws:${BRIDGE_ID}:${PAIR}`;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?pairId=${PAIR}`, { headers: { Origin: ORIGIN } });
  let loopbackDecode: Promise<void> = Promise.resolve();
  let loopbackHello: (() => void) | undefined;
  const loopbackReady = new Promise<void>((resolve) => { loopbackHello = resolve; });
  socket.on('message', (raw) => {
    activity++;
    loopbackDecode = loopbackDecode.then(async () => {
      const frame = await openFrame(loopbackChannel, String(raw));
      if (frame.kind === 'hello_ack') loopbackHello?.();
      viewers.loopback.apply(frame);
      activity++;
    });
  });
  await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
  let loopbackOut: Promise<void> = Promise.resolve();
  const sendLoopback = (frame: Frame & Record<string, unknown>): void => {
    activity++;
    loopbackOut = loopbackOut.then(async () => { socket.send(await sealFrame(loopbackChannel, PAIR, frame)); activity++; });
  };
  sendLoopback({ kind: 'hello', clientId: 'client-loopback', protocolVersion: DIRECT_PROTOCOL_VERSION });
  await loopbackReady;

  // WebRTC viewer's channel.
  peers.handleSignal({ type: 'webrtc_offer', pairId: PAIR, bridgeId: BRIDGE_ID, clientId: 'client-webrtc', payload: 'OFFER' });
  onLocalDescription?.('ANSWER', 'answer');
  onDataChannel?.(dc);
  let webrtcOut: Promise<void> = Promise.resolve();
  const sendWebrtc = (frame: Frame & Record<string, unknown>): void => {
    activity++;
    webrtcOut = webrtcOut.then(async () => { await webrtcInbound?.(await sealFrame(webrtcChannel, PAIR, frame)); activity++; });
  };
  sendWebrtc({ kind: 'hello', clientId: 'client-webrtc', protocolVersion: DIRECT_PROTOCOL_VERSION });
  await webrtcOut;

  const idle = async (): Promise<void> => {
    // Quiescent once nothing moved for a few consecutive checks.
    let calm = 0;
    let seen = -1;
    while (calm < 3) {
      await sleep(30);
      await Promise.all([loopbackOut, webrtcOut, peers.drain()]);
      await Promise.all([loopbackDecode, webrtcDecode]);
      await new Promise<void>((resolve) => terminalManager.whenParsed(SESSION, resolve));
      if (activity === seen && output.pump.isIdle()) calm++;
      else { calm = 0; seen = activity; }
    }
    await Promise.all(Object.values(viewers).map((viewer) => viewer.settled()));
  };

  return {
    terminalManager, runner, registry, router, loopback, peers, viewers, sendLoopback, sendWebrtc,
    publishScreenDump: () => output.publishScreenDump(SESSION),
    resize: (c, r) => resize(c, r),
    idle,
    close: async () => {
      await output.pump.drain();
      socket.close();
      loopback.closeAll();
      peers.closeAll();
      registry.dispose();
      terminalManager.destroy(SESSION);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/** Shell-like output: numbered lines, prompts, in-place redraws, cursor moves. */
function ptyChunk(random: () => number, counter: { n: number }): string {
  const pick = random();
  if (pick < 0.45) return `line ${counter.n++} ${'x'.repeat(Math.floor(random() * 30))}\r\n`;
  if (pick < 0.6) return `$ echo typed-${counter.n++}`;
  if (pick < 0.7) return `\r\x1b[K$ redrawn-${counter.n++}`;
  if (pick < 0.78) return `\r\n`;
  if (pick < 0.84) return `\x1b[A\r\x1b[Kup-${counter.n++}\r\n`;
  if (pick < 0.9) return `\x1b[7mrev-${counter.n++}\x1b[27m`;
  if (pick < 0.95) return `${'w'.repeat(60 + Math.floor(random() * 120))}-${counter.n++}\r\n`;
  return Array.from({ length: 30 }, () => `burst ${counter.n++}\r\n`).join('');
}

interface RunOptions { seed: number; rounds: number; resize: boolean }

async function runInterleavings(options: RunOptions): Promise<void> {
  const random = rng(options.seed);
  // Same geometry as the bridge emulator's default (TerminalManager: rows 40).
  const world = await makeWorld(80, 40);
  const counter = { n: 0 };
  const history: string[] = [];
  const remoteWatchers = new Set<string>();
  let loopbackAttached = false;
  let webrtcAttached = false;
  try {
    world.runner.emit('data', SESSION, 'boot\r\n');
    for (let round = 0; round < options.rounds; round++) {
      const ops = 4 + Math.floor(random() * 14);
      for (let i = 0; i < ops; i++) {
        const pick = random();
        if (pick < 0.5) {
          const chunk = ptyChunk(random, counter);
          history.push(`chunk ${JSON.stringify(chunk).slice(0, 60)}`);
          world.runner.emit('data', SESSION, chunk);
        } else if (pick < 0.58) {
          history.push('loopback attach');
          loopbackAttached = true;
          world.sendLoopback({ kind: 'attach', sessionId: SESSION });
        } else if (pick < 0.61) {
          history.push('loopback detach');
          loopbackAttached = false;
          world.viewers.loopback.synced = false;
          world.sendLoopback({ kind: 'detach', sessionId: SESSION });
        } else if (pick < 0.69) {
          history.push('webrtc attach');
          webrtcAttached = true;
          world.sendWebrtc({ kind: 'attach', sessionId: SESSION });
        } else if (pick < 0.72) {
          history.push('webrtc detach');
          webrtcAttached = false;
          world.viewers.webrtc.synced = false;
          world.sendWebrtc({ kind: 'detach', sessionId: SESSION });
        } else if (pick < 0.79) {
          const id = `watcher-${Math.floor(random() * 3)}`;
          history.push(`watch ${id}`);
          remoteWatchers.add(id);
          world.registry.watch(SESSION, id);
        } else if (pick < 0.83) {
          const id = `watcher-${Math.floor(random() * 3)}`;
          history.push(`unwatch ${id}`);
          remoteWatchers.delete(id);
          world.registry.unwatch(SESSION, id);
          // Relay frames stop when the last watcher leaves: the relay viewer
          // is incomplete until its next screen.
          if (remoteWatchers.size === 0) world.viewers.relay.synced = false;
        } else if (pick < 0.88) {
          history.push('screen request');
          world.publishScreenDump();
        } else if (pick < 0.91 && options.resize) {
          const cols = 40 + Math.floor(random() * 80);
          const rows = 10 + Math.floor(random() * 30);
          history.push(`resize ${cols}x${rows}`);
          // The viewer refits, then tells the bridge (ui Terminal.tsx).
          for (const viewer of Object.values(world.viewers)) viewer.term.resize(cols, rows);
          world.resize(cols, rows);
        } else {
          const wait = random();
          history.push('wait');
          if (wait < 0.4) await new Promise((resolve) => setImmediate(resolve));
          else if (wait < 0.8) await sleep(1 + Math.floor(random() * 20));
          else if (wait < 0.95) await sleep(40);
          else await sleep(270);
        }
      }
      await world.idle();

      const expected = textOf((world.terminalManager as unknown as { terminals: Map<string, { terminal: TerminalType }> })
        .terminals.get(SESSION)!.terminal);
      const checks: Array<[Viewer, boolean]> = [
        [world.viewers.loopback, loopbackAttached],
        [world.viewers.webrtc, webrtcAttached],
        [world.viewers.relay, remoteWatchers.size > 0],
      ];
      for (const [viewer, receiving] of checks) {
        if (!receiving || !viewer.synced) continue;
        const actual = textOf(viewer.term);
        if (actual.join('\n') !== expected.join('\n')) {
          const firstDiff = expected.findIndex((line, index) => line !== actual[index]);
          assert.fail([
            `seed ${options.seed} round ${round}: ${viewer.name} viewer diverged from the emulator at line ${firstDiff}`,
            `  emulator: ${JSON.stringify(expected.slice(Math.max(0, firstDiff - 2), firstDiff + 3))}`,
            `  viewer:   ${JSON.stringify(actual.slice(Math.max(0, firstDiff - 2), firstDiff + 3))}`,
            `  last ops: ${history.slice(-25).join(' | ')}`,
            `  last frames: ${viewer.log.slice(-8).join(' | ')}`,
          ].join('\n'));
        }
      }
    }
  } finally {
    await world.close();
  }
}

const SEEDS = (process.env.STREAM_CONSISTENCY_SEEDS ?? '1,2,3,4').split(',').map(Number);
const ROUNDS = Number(process.env.STREAM_CONSISTENCY_ROUNDS ?? 60);

for (const seed of SEEDS) {
  test(`viewers stay identical to the emulator under random interleavings (seed ${seed})`, { timeout: 180_000 }, async () => {
    await runInterleavings({ seed, rounds: ROUNDS, resize: true });
  });
}
