import { INSTRUCTIONS_LOCAL, INSTRUCTIONS_SYNC, INSTRUCTIONS_WIRE } from './instructions.js';
import { TRANSFER_LOCAL, TRANSFER_WIRE, TRANSFER_REQUEST_TTL_MS } from './folder-transfer-protocol.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ApplicationJson, SecureEnvelope } from './security/protocol.js';
import type { LedgerBridge } from './security/ledger/protocol.js';
import { BridgeSecurityError } from './security/bridge/errors.js';
import { applicationJson } from './security/bridge/security.js';
import { MAX_LINK_SDP_CHARS, PeerLinkError } from './peer-link.js';

/**
 * Cross-bridge control.
 *
 * Every bridge of an account is listed, with its endpoint key, in the passkey-signed account ledger, and every bridge already
 * subscribes to the account's commands:rpc relay channel. A peer bridge is therefore reached exactly like a browser reaches a bridge:
 * a hello/welcome handshake (to learn the peer's receiver epoch), then one HPKE-sealed `http` application whose answer is sealed back
 * to this bridge. The peer authorizes this bridge as a read + control principal (see BridgePolicyStore.projectLedger); admin
 * (security) operations are never available across bridges.
 *
 * The relay is the fallback path. The first request to a peer also asks it (one sealed request over the relay) to open a direct
 * bridge-to-bridge link (see peer-link.ts); once that is open, requests to the peer travel on it and the relay is not involved.
 */

export const PEER_HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
export type PeerHttpMethod = typeof PEER_HTTP_METHODS[number];

/** What PeerControl needs from the bridge security service (BridgeSecurityService implements it). */
export interface PeerSecurity {
  readonly bridgeId: string;
  peerBridges(): LedgerBridge[];
  sealToPeer(peer: LedgerBridge, purpose: 'hello' | 'application', body: unknown, channel: string, messageId: string,
    receiverEpoch: string | null, ttlMs?: number): Promise<SecureEnvelope>;
  openFromPeer(peer: LedgerBridge, packet: SecureEnvelope, purpose: 'welcome' | 'application', channel: string): Promise<unknown>;
}

/** What PeerControl needs from the relay client (CentrifugoClient implements it). */
export interface PeerTransport {
  peerChannel(): string | null;
  peerExchange(packet: SecureEnvelope, peerEndpointId: string, timeoutMs: number): Promise<SecureEnvelope>;
}

/** What PeerControl needs from the direct links (PeerLinks implements it). */
export interface PeerDirect {
  sendBinary?(peerBridgeId: string, frame: Buffer, signal: AbortSignal): Promise<void>;
  channel(peerBridgeId: string): string | null;
  exchange(peerBridgeId: string, packet: SecureEnvelope, timeoutMs: number): Promise<SecureEnvelope>;
  ensure(peer: LedgerBridge, signal: (offer: { pairId: string; sdp: string }) => Promise<{ sdp: string }>): Promise<boolean>;
}

/** One way to reach a peer: the channel its envelopes are sealed for, and how they travel. */
interface PeerPath {
  direct: boolean;
  channel: string;
  send(packet: SecureEnvelope, timeoutMs: number): Promise<SecureEnvelope>;
}

export interface PeerSummary {
  bridgeId: string;
  label: string;
  endpointId: string;
  approvedAt: string;
  /** Only when probed: whether the peer answered a handshake in time. */
  online?: boolean;
  /** Whether a direct link to the peer is open right now (requests then bypass the relay). */
  direct?: boolean;
}

export class PeerTargetError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'PeerTargetError'; }
}

const welcomeSchema = (challenge: string) => z.object({ type: z.literal('welcome'), challenge: z.literal(challenge),
  receiverEpoch: z.string().min(1).max(128) }).strict();
const responseSchema = (requestId: string) => z.object({ type: z.literal('application'),
  route: z.object({ kind: z.literal('response'), requestId: z.literal(requestId) }).strict(), data: z.unknown().optional(), mcp: z.null() }).strict();

const DEFAULT_TIMEOUT_MS = 60_000;
const HELLO_TIMEOUT_MS = 15_000;
/** Answer slack past the inner request deadline the peer enforces. */
const ANSWER_SLACK_MS = 5_000;
const LINK_SIGNAL_TIMEOUT_MS = 15_000;
const linkAnswerSchema = z.object({ sdp: z.string().min(1).max(MAX_LINK_SDP_CHARS) }).strict();

export class PeerControl {
  /** Receiver epoch per peer bridgeId, learned by handshake; a peer restart changes it (answered `epoch_changed`, then re-learned). */
  private readonly epochs = new Map<string, string>();
  /** Link attempts in progress, by peer bridgeId. */
  private readonly linking = new Map<string, Promise<boolean>>();

  constructor(private readonly security: PeerSecurity, private readonly transport: PeerTransport, private readonly direct?: PeerDirect) {}

  /** The other bridges of this account (ledger order). With `probe`, each is sent a handshake (in parallel) to report reachability. */
  async list(probe = false, probeTimeoutMs = 4_000): Promise<PeerSummary[]> {
    const peers = this.security.peerBridges();
    const summaries = peers.map(peer => ({ bridgeId: peer.bridgeId, label: peer.label, endpointId: peer.endpoint.id,
      approvedAt: new Date(peer.approvedAt).toISOString(), ...(this.direct ? { direct: this.direct.channel(peer.bridgeId) !== null } : {}) } as PeerSummary));
    if (!probe) return summaries;
    const results = await Promise.all(peers.map(peer => this.hello(peer, this.relay(peer), probeTimeoutMs).then(() => true, () => false)));
    return summaries.map((summary, index) => ({ ...summary, online: results[index] }));
  }

  /**
   * Resolves a user-supplied target: an exact bridgeId, a unique bridgeId prefix (4+ characters) or a unique label (case-insensitive).
   * This bridge itself is never a target.
   */
  resolve(target: string): LedgerBridge {
    const wanted = target.trim();
    if (!wanted) throw new PeerTargetError(400, 'Missing bridge');
    if (wanted === this.security.bridgeId) throw new PeerTargetError(400, 'That is this bridge; omit --bridge to control it');
    const peers = this.security.peerBridges();
    const exact = peers.find(peer => peer.bridgeId === wanted);
    if (exact) return exact;
    const lower = wanted.toLowerCase();
    const byLabel = peers.filter(peer => peer.label.toLowerCase() === lower);
    if (byLabel.length === 1) return byLabel[0];
    if (byLabel.length > 1) throw new PeerTargetError(409, `Bridge label "${wanted}" is ambiguous; use a bridge id`);
    const byPrefix = wanted.length >= 4 ? peers.filter(peer => peer.bridgeId.startsWith(wanted)) : [];
    if (byPrefix.length === 1) return byPrefix[0];
    if (byPrefix.length > 1) throw new PeerTargetError(409, `Bridge id prefix "${wanted}" is ambiguous`);
    if (peers.length === 0) throw new PeerTargetError(404, 'No other bridges in this account (cross-bridge control needs an account bridge)');
    throw new PeerTargetError(404, `Unknown bridge "${wanted}"; run ftown bridges to list them`);
  }

  /** Forwards one local-API request to a peer bridge and returns the peer's own HTTP status and JSON body. */
  async http(target: string, method: string, path: string, body?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ status: number; body: ApplicationJson }> {
    if (!(PEER_HTTP_METHODS as readonly string[]).includes(method)) throw new PeerTargetError(400, 'Unsupported method');
    if (typeof path !== 'string' || !path.startsWith('/api/') || path.length > 16_384) throw new PeerTargetError(400, 'Invalid path');
    if ([INSTRUCTIONS_LOCAL, INSTRUCTIONS_SYNC, INSTRUCTIONS_WIRE].includes(path.split('?')[0])) throw new PeerTargetError(400, 'Instructions require a direct link');
    if (path.split('?')[0] === TRANSFER_LOCAL || path.split('?')[0] === TRANSFER_WIRE) {
      throw new PeerTargetError(400, 'Folder transfers use the dedicated direct transfer API');
    }
    // No chaining: a peer's own peers are reached directly from here.
    if (path === '/api/peers' || path.startsWith('/api/peers/') || path.startsWith('/api/peers?')) throw new PeerTargetError(400, 'Cross-bridge requests cannot be chained');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new PeerTargetError(400, 'Invalid timeout');
    const peer = this.resolve(target);
    const linked = this.directPath(peer);
    if (!linked) {
      this.link(peer);
      return this.request(peer, this.relay(peer), method as PeerHttpMethod, path, body, timeoutMs);
    }
    try { return await this.request(peer, linked, method as PeerHttpMethod, path, body, timeoutMs); }
    catch (error) {
      if (!(error instanceof PeerLinkError)) throw error;
      // Nothing left this bridge, or a read went unanswered: the relay can carry it. A lost change is reported, never repeated.
      if (error.reason === 'lost' && method !== 'GET') throw new Error('Direct link lost before the peer answered');
      return this.request(peer, this.relay(peer), method as PeerHttpMethod, path, body, timeoutMs);
    }
  }

  async connectDirect(target: string): Promise<boolean> {
    const peer = this.resolve(target);
    if (!this.directPath(peer)) this.link(peer);
    return this.linked(peer.bridgeId);
  }

  async sendBinary(target: string, frame: Buffer, signal: AbortSignal): Promise<void> {
    if (!this.direct?.sendBinary) throw new PeerTargetError(503, 'Direct binary transfer unavailable');
    await this.direct.sendBinary(target, frame, signal);
  }

  async directHttp(target: string, path: typeof TRANSFER_WIRE | typeof INSTRUCTIONS_SYNC | typeof INSTRUCTIONS_WIRE, body: unknown): Promise<{ status: number; body: ApplicationJson }> {
    const peer = this.resolve(target);
    const route = this.directPath(peer);
    if (!route) throw new PeerTargetError(503, 'Direct bridge link unavailable');
    return this.request(peer, route, 'POST', path, body, TRANSFER_REQUEST_TTL_MS - ANSWER_SLACK_MS);
  }

  private async request(peer: LedgerBridge, route: PeerPath, method: PeerHttpMethod, path: string, body: unknown,
    timeoutMs: number): Promise<{ status: number; body: ApplicationJson }> {
    for (let attempt = 0; ; attempt++) {
      const epoch = this.epochs.get(peer.bridgeId) ?? await this.hello(peer, route, HELLO_TIMEOUT_MS);
      const result = await this.exchange(peer, route, epoch, method, path, body, timeoutMs);
      const answer = result.body;
      const code = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer.code : undefined;
      // The peer restarted since our handshake: it refused before dispatching anything, so one retry with a fresh epoch is safe.
      if (result.status === 403 && code === 'epoch_changed' && attempt === 0) { this.epochs.delete(peer.bridgeId); continue; }
      return result;
    }
  }

  /** The relay path (the account's commands:rpc channel). */
  private relay(peer: LedgerBridge): PeerPath {
    const relayChannel = (): string => {
      const channel = this.transport.peerChannel();
      if (!channel) throw new PeerTargetError(503, 'Cross-bridge control needs the relay connection (not available in --local/--solo mode)');
      return channel;
    };
    return {
      direct: false,
      get channel(): string { return relayChannel(); },
      send: async (packet, timeoutMs) => {
        try { return await this.transport.peerExchange(packet, peer.endpoint.id, timeoutMs); }
        catch (error) {
          if (error instanceof BridgeSecurityError && error.code === 'bridge_offline') {
            throw new PeerTargetError(504, `Bridge ${peer.label || peer.bridgeId} did not answer (offline, or running an ftown without cross-bridge control)`);
          }
          throw error;
        }
      },
    };
  }

  /** The direct link to the peer, when one is open. */
  private directPath(peer: LedgerBridge): PeerPath | null {
    const direct = this.direct;
    const channel = direct?.channel(peer.bridgeId);
    if (!direct || !channel) return null;
    return { direct: true, channel, send: (packet, timeoutMs) => direct.exchange(peer.bridgeId, packet, timeoutMs) };
  }

  /** Asks the peer, over the relay, to open a direct link. Runs beside the request that triggered it and never fails it. */
  private link(peer: LedgerBridge): void {
    if (!this.direct || !this.transport.peerChannel() || this.linking.has(peer.bridgeId)) return;
    const attempt = this.direct.ensure(peer, async offer => {
      const answer = await this.request(peer, this.relay(peer), 'POST', '/api/peers/link', offer, LINK_SIGNAL_TIMEOUT_MS);
      if (answer.status !== 200) throw new Error(`Link refused (${answer.status})`);
      return linkAnswerSchema.parse(answer.body);
    }).catch(() => false).finally(() => { this.linking.delete(peer.bridgeId); });
    this.linking.set(peer.bridgeId, attempt);
  }

  /** Resolves once no link attempt to the target is in progress, with whether a direct link is open. */
  async linked(target: string): Promise<boolean> {
    const peer = this.resolve(target);
    await this.linking.get(peer.bridgeId);
    return (this.direct?.channel(peer.bridgeId) ?? null) !== null;
  }

  private async hello(peer: LedgerBridge, route: PeerPath, timeoutMs: number): Promise<string> {
    const channel = route.channel;
    const challenge = randomUUID();
    const messageId = randomUUID();
    const packet = await this.security.sealToPeer(peer, 'hello', { type: 'hello', challenge }, channel, messageId, null);
    const answer = await route.send(packet, timeoutMs);
    const welcome = welcomeSchema(challenge).parse(await this.security.openFromPeer(peer, answer, 'welcome', channel));
    this.epochs.set(peer.bridgeId, welcome.receiverEpoch);
    return welcome.receiverEpoch;
  }

  private async exchange(peer: LedgerBridge, route: PeerPath, epoch: string, method: PeerHttpMethod, path: string, body: unknown,
    timeoutMs: number): Promise<{ status: number; body: ApplicationJson }> {
    const channel = route.channel;
    const requestId = randomUUID();
    const data: { [key: string]: ApplicationJson } = { timeoutMs };
    if (body !== undefined) data.body = applicationJson(body);
    const application = { type: 'application', route: { kind: 'http', requestId, method, path }, data, mcp: null };
    const packet = await this.security.sealToPeer(peer, 'application', application, channel, requestId, epoch, path === TRANSFER_WIRE ? TRANSFER_REQUEST_TTL_MS : undefined);
    const answer = await route.send(packet, timeoutMs + ANSWER_SLACK_MS);
    const response = responseSchema(requestId).parse(await this.security.openFromPeer(peer, answer, 'application', channel));
    const result = response.data;
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new PeerTargetError(502, 'Invalid answer from peer bridge');
    const record = result as Record<string, unknown>;
    // A command-shaped refusal (e.g. the peer is still starting) instead of an HTTP answer.
    if (typeof record.status !== 'number') {
      const inner = record.response as Record<string, unknown> | undefined;
      const message = inner && typeof inner.error === 'string' ? inner.error : 'Invalid answer from peer bridge';
      return { status: 503, body: { error: message, code: 'peer_unavailable' } };
    }
    return { status: record.status, body: applicationJson(record.body ?? null) };
  }
}
