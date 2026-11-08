import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { generateEndpoint, seal } from '../security/crypto.js';
import { createAccountGenesis, generateAccountSigningIdentity, signAccountTransition, verifyAccountHistory } from '../security/account-crypto.js';
import type { AccountSigningIdentity } from '../security/account-protocol.js';
import type { EndpointIdentity } from '../security/protocol.js';
import { BridgeSecurityService, applicationJson } from '../security/bridge/security.js';
import { LOCAL_RECOVERY_AUTHORITY } from '../security/bridge/policy.js';
import { EncryptedPeerChannel } from '../security/bridge/direct.js';
import { createOutboundPipeline } from '../outbound-pipeline.js';
import { claudeProjectSlug, collectSessionUsage, type UsageSessionRef } from '../usage-collector.js';

// Opt-in (FTOWN_PERF=1): keystroke round trip through the real security + peer-channel path while the usage
// collector polls K large, growing Claude transcripts. Uses only APIs present on origin/main so the same file
// runs against the base and the fix.
const RECIPIENT_BROWSERS = 7; // + local-cli = R 8
const SESSIONS = 12;
const TRANSCRIPT_BYTES = 40e6;
const WRITE_EVERY_MS = 100;
const POLL_EVERY_MS = 5_000;
const PUBLICATIONS_PER_SEC = 20;
const KEYS_PER_SEC = 20;
const PROBE_MS = 12_000;
const P50_BUDGET_MS = 50;
const P95_BUDGET_MS = 250;
const owner = '7bac2a7f-c58e-4845-856f-8283fb07ad96';

const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
const quantile = (a: number[], p: number): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const r1 = (x: number): number => Math.round(x * 10) / 10;
const pool = randomBytes(24_000).toString('base64');
const text = (n: number): string => {
  const at = Math.floor(Math.random() * (pool.length - n));
  return pool.slice(at, at + n);
};

function assistantLine(sessionId: string, cwd: string, n: number, bytes: number): string {
  return JSON.stringify({
    parentUuid: randomUUID(), isSidechain: false, userType: 'external', cwd, sessionId, version: '2.0.37', gitBranch: 'main',
    uuid: randomUUID(), timestamp: new Date().toISOString(), type: 'assistant',
    message: {
      id: `msg_${sessionId}_${n}`, model: 'claude-haiku-4-5', role: 'assistant', type: 'message',
      content: [{ type: 'text', text: text(Math.max(100, bytes - 700)) }, { type: 'tool_use', id: `toolu_${n}`, name: 'Bash', input: { command: text(120) } }],
      usage: { input_tokens: 12, output_tokens: 340, cache_read_input_tokens: 41_000, cache_creation_input_tokens: 900 },
    },
  }) + '\n';
}

async function writeTranscript(file: string, sessionId: string, cwd: string): Promise<number> {
  const ws = createWriteStream(file);
  let written = 0;
  let n = 0;
  while (written < TRANSCRIPT_BYTES) {
    let chunk = '';
    while (chunk.length < 1_000_000) chunk += assistantLine(sessionId, cwd, n++, 1_000 + Math.floor(Math.random() * 3_000));
    written += chunk.length;
    if (!ws.write(chunk)) await new Promise<void>(r => ws.once('drain', () => r()));
  }
  await new Promise<void>(r => ws.end(() => r()));
  return n;
}

// R = 8 recipients (7 account browsers + local-cli), same fixture shape as the A3 bench.
async function buildSecurity(dir: string) {
  const bridge = await generateEndpoint(owner, 'bridge');
  const browsers: EndpointIdentity[] = [];
  const signings: AccountSigningIdentity[] = [];
  for (let i = 0; i < RECIPIENT_BROWSERS; i++) { browsers.push(await generateEndpoint(owner, 'browser')); signings.push(await generateAccountSigningIdentity()); }
  let wall = Date.now() - 3_600_000;
  let history = { genesis: await createAccountGenesis(owner, browsers[0].endpoint, signings[0], 'Browser 0', wall), transitions: [] as Awaited<ReturnType<typeof signAccountTransition>>[] };
  let checkpoint = await verifyAccountHistory(history, null, wall);
  const append = async (op: Parameters<typeof signAccountTransition>[3]): Promise<void> => {
    wall += 1000;
    const record = await signAccountTransition(checkpoint, browsers[0].endpoint.id, signings[0], op, wall);
    history = { ...history, transitions: [...history.transitions, record] };
    checkpoint = await verifyAccountHistory(history, checkpoint, wall);
  };
  const iso = (): string => new Date(wall).toISOString();
  await append({ type: 'add_bridge', bridge: { bridgeId: 'bridge', endpoint: bridge.endpoint, label: 'This Mac', approvedAt: iso() } });
  for (const b of ['bridge-2', 'bridge-3']) {
    const other = await generateEndpoint(owner, 'bridge');
    await append({ type: 'add_bridge', bridge: { bridgeId: b, endpoint: other.endpoint, label: b, approvedAt: iso() } });
  }
  for (let i = 1; i < RECIPIENT_BROWSERS; i++) {
    await append({ type: 'add_device', device: { endpoint: browsers[i].endpoint, signingPublicKey: signings[i].publicKey, label: `Browser ${i}`, approvedAt: iso() } });
  }
  for (let i = 0; i < 2; i++) {
    const gone = await generateEndpoint(owner, 'browser');
    const gs = await generateAccountSigningIdentity();
    await append({ type: 'add_device', device: { endpoint: gone.endpoint, signingPublicKey: gs.publicKey, label: `Old ${i}`, approvedAt: iso() } });
    await append({ type: 'revoke_device', endpointId: gone.endpoint.id });
  }
  const security = new BridgeSecurityService(bridge, 'bridge', dir, { relayUserId: 'owner@example.test', readAccountHistory: async () => history });
  const invite = await security.policy.createInvitation(LOCAL_RECOVERY_AUTHORITY, { label: 'Legacy' });
  await security.policy.consumeInvitation({ type: 'enroll', candidate: browsers[0].endpoint, invitationId: invite.invitationId, invitationSecret: invite.secret, label: 'Legacy' });
  const cli = await generateEndpoint(owner, 'local-cli');
  await security.policy.provisionLocalEndpoint(cli.endpoint);
  await security.adoptAccount(await security.policy.principal(browsers[0].endpoint.id), { rootId: checkpoint.rootId, revision: checkpoint.revision, head: checkpoint.head });
  const recipients = await security.policy.recipients();
  return { security, bridge, browser: browsers[0], recipients };
}

test('keystroke latency stays low while usage polls large growing transcripts', { skip: process.env.FTOWN_PERF !== '1', timeout: 180_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ftown-keylat-'));
  const cleanups: Array<() => void | Promise<void>> = [];
  try {
    const projectsDir = join(dir, 'projects');
    const workingDir = '/synthetic/project';
    const slugDir = join(projectsDir, claudeProjectSlug(workingDir));
    await mkdir(slugDir, { recursive: true });
    const ids = Array.from({ length: SESSIONS }, () => randomUUID());
    await Promise.all(ids.map(id => writeTranscript(join(slugDir, `${id}.jsonl`), id, workingDir)));
    const sessions = ids.map(id => ({ shellType: 'claude', claudeSessionId: id, workingDir }) as UsageSessionRef);

    const { security, bridge, browser, recipients } = await buildSecurity(join(dir, 'bridge-data'));
    cleanups.push(() => security.close());
    assert.equal(recipients.length, RECIPIENT_BROWSERS + 1, 'fixture recipients');

    // Probe: real accept path (EncryptedPeerChannel.receive) + one echo send to the same peer.
    const pairId = randomUUID();
    const route = { transport: 'webrtc' as const, bridgeId: 'bridge', pairId, channel: `direct:webrtc:bridge:${pairId}` };
    const pending: number[] = []; // arrival times in receive order; the peer outbound chain is FIFO
    const latencies: number[] = [];
    let probing = false;
    let tornDown = false;
    let seq = 0;
    const channel: EncryptedPeerChannel = new EncryptedPeerChannel(
      security, route,
      () => { if (!probing) return; const t0 = pending.shift(); if (t0 !== undefined) latencies.push(performance.now() - t0); },
      frame => { if (frame.kind === 'input') channel.send({ kind: 'output', sessionId: frame.sessionId, data: frame.data, seq: ++seq }); },
      () => {}, () => { tornDown = true; },
    );
    cleanups.push(() => channel.close());
    const hello = await seal(browser, bridge.endpoint, {
      type: 'ftown_encrypted', version: 1, senderId: browser.endpoint.id, recipientId: bridge.endpoint.id, ownerId: owner, bridgeId: 'bridge',
      channel: route.channel, purpose: 'hello', messageId: randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + 60_000, receiverEpoch: null,
    }, enc({ type: 'hello', challenge: randomUUID() }));
    await channel.receive(JSON.stringify(hello));
    assert.ok(!tornDown, 'hello rejected');

    const keys = Math.ceil((PROBE_MS / 1000) * KEYS_PER_SEC);
    const tSeal = Date.now();
    const packets: string[] = [];
    for (let i = 0; i < keys; i++) {
      const app = { type: 'application', route: { kind: 'terminal', sessionId: 's1', frameType: 'input', pairId }, data: { kind: 'input', sessionId: 's1', data: 'a' }, mcp: null };
      packets.push(JSON.stringify(await seal(browser, bridge.endpoint, {
        type: 'ftown_encrypted', version: 1, senderId: browser.endpoint.id, recipientId: bridge.endpoint.id, ownerId: owner, bridgeId: 'bridge',
        channel: route.channel, purpose: 'application', messageId: randomUUID(), createdAt: tSeal, expiresAt: tSeal + 115_000, receiverEpoch: security.receiverEpoch,
      }, enc(app))));
    }

    // Background publications through the real outbound pipeline + sealPublication.
    const pipeline = createOutboundPipeline({ logger: { warn: () => {}, error: () => {} } });
    cleanups.push(() => pipeline.idle());
    let pubSeq = 0;
    let packetsSent = 0;
    let pubsDropped = 0;
    const publish = (): void => {
      const i = pubSeq++;
      const sessionId = `sess${i % 10}`;
      const channelName = `terminal:${sessionId}#owner@example.test`;
      const data = i % 2 === 0
        ? { type: 'hook_event', sessionId, event: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: text(700) }, tool_response: { stdout: text(200) } } }
        : { type: 'output', sessionId, data: text(3900), seq: i };
      if (!pipeline.enqueue({
        label: `terminal/${data.type}`,
        prepare: async () => {
          const out = [];
          for (const packet of await security.sealPublication(channelName, { type: 'application', route: { kind: 'publication' }, data: applicationJson(data), mcp: null })) {
            if (packet.type !== 'ftown_encrypted') continue;
            await security.policy.principal(packet.recipientId);
            out.push({ bytes: Buffer.byteLength(JSON.stringify(packet)), send: () => { packetsSent++; return new Promise<void>(resolve => setTimeout(resolve, 25)); } });
          }
          return out;
        },
      })) pubsDropped++;
    };

    // Usage polls: Promise.all over the sessions with default options, at most one in flight.
    let pollsCompleted = 0;
    let pollFailures = 0;
    let pollInFlight: Promise<void> | null = null;
    const poll = (): void => {
      if (pollInFlight) return;
      pollInFlight = Promise.all(sessions.map(s => collectSessionUsage(s, { claudeProjectsDir: projectsDir })))
        .then(all => { if (all.some(u => !u)) pollFailures++; else pollsCompleted++; }, () => { pollFailures++; })
        .finally(() => { pollInFlight = null; });
    };

    // Writers: one ~1 KB assistant line per session every 100 ms.
    let lineNo = 1_000_000;
    const appends = new Set<Promise<void>>();
    const writers = setInterval(() => {
      for (const id of ids) {
        const a: Promise<void> = appendFile(join(slugDir, `${id}.jsonl`), assistantLine(id, workingDir, lineNo++, 1_000)).catch(() => {}).finally(() => { appends.delete(a); });
        appends.add(a);
      }
    }, WRITE_EVERY_MS);
    cleanups.push(async () => { clearInterval(writers); await Promise.all(appends); });
    cleanups.push(async () => { await pollInFlight; });

    const eld = monitorEventLoopDelay({ resolution: 2 });
    eld.enable();
    cleanups.push(() => { eld.disable(); });
    const t0 = performance.now() + 50;
    const every = (periodMs: number, fn: (i: number) => void, until: number): Promise<void> => new Promise(resolve => {
      let i = 0;
      const tick = (): void => {
        if (performance.now() - t0 >= until) { resolve(); return; }
        fn(i++);
        setTimeout(tick, Math.max(0, t0 + i * periodMs - performance.now()));
      };
      setTimeout(tick, Math.max(0, t0 - performance.now()));
    });
    probing = true;
    const loops = [
      every(POLL_EVERY_MS, () => poll(), PROBE_MS),
      every(1000 / PUBLICATIONS_PER_SEC, () => publish(), PROBE_MS),
      every(1000 / KEYS_PER_SEC, i => { pending.push(t0 + i * (1000 / KEYS_PER_SEC)); void channel.receive(packets[i]); }, PROBE_MS - 1),
    ];
    await Promise.all(loops);
    eld.disable();
    clearInterval(writers);

    const deadline = performance.now() + 60_000;
    while (latencies.length < keys && performance.now() < deadline && !tornDown) await new Promise(r => setTimeout(r, 20));
    probing = false;
    await pollInFlight;
    await channel.drain();
    const tornDuringRun = tornDown;
    await pipeline.idle();

    const summary = {
      keys, measured: latencies.length, p50: r1(quantile(latencies, 0.5)), p95: r1(quantile(latencies, 0.95)), max: r1(Math.max(...latencies)),
      pollsCompleted, pollFailures, packetsSent, pubsDropped, loopDelayP99: r1(eld.percentile(99) / 1e6), sessions: SESSIONS, recipients: recipients.length,
    };
    console.log(JSON.stringify({ keystrokeLatencyMs: summary }));
    assert.ok(!tornDuringRun, 'channel torn down');
    assert.equal(pollFailures, 0, 'usage polls failed');
    assert.ok(pollsCompleted >= 2, `only ${pollsCompleted} polls completed`);
    assert.equal(pubsDropped, 0, 'publications dropped');
    assert.ok(packetsSent >= pubSeq * (recipients.length - 1), `packets sent ${packetsSent} < ${pubSeq * (recipients.length - 1)}`);
    assert.equal(latencies.length, keys, 'every key echoed');
    assert.ok(summary.p50 <= P50_BUDGET_MS, `p50 ${summary.p50} ms > ${P50_BUDGET_MS} ms`);
    assert.ok(summary.p95 <= P95_BUDGET_MS, `p95 ${summary.p95} ms > ${P95_BUDGET_MS} ms`);
  } finally {
    for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
