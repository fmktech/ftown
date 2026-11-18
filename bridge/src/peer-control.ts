import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ApplicationJson, SecureEnvelope } from './security/protocol.js';
import type { LedgerBridge } from './security/ledger/protocol.js';
import { BridgeSecurityError } from './security/bridge/errors.js';
import { applicationJson } from './security/bridge/security.js';

/**
 * Cross-bridge control.
 *
 * Every bridge of an account is listed, with its endpoint key, in the passkey-signed account ledger, and every bridge already
 * subscribes to the account's commands:rpc relay channel. A peer bridge is therefore reached exactly like a browser reaches a bridge:
 * a hello/welcome handshake (to learn the peer's receiver epoch), then one HPKE-sealed `http` application whose answer is sealed back
 * to this bridge. The peer authorizes this bridge as a read + control principal (see BridgePolicyStore.projectLedger); admin
 * (security) operations are never available across bridges.
 */

export const PEER_HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
export type PeerHttpMethod = typeof PEER_HTTP_METHODS[number];

/** What PeerControl needs from the bridge security service (BridgeSecurityService implements it). */
export interface PeerSecurity {
  readonly bridgeId: string;
  peerBridges(): LedgerBridge[];
  sealToPeer(peer: LedgerBridge, purpose: 'hello' | 'application', body: unknown, channel: string, messageId: string,
    receiverEpoch: string | null): Promise<SecureEnvelope>;
  openFromPeer(peer: LedgerBridge, packet: SecureEnvelope, purpose: 'welcome' | 'application', channel: string): Promise<unknown>;
}

/** What PeerControl needs from the relay client (CentrifugoClient implements it). */
export interface PeerTransport {
  peerChannel(): string | null;
  peerExchange(packet: SecureEnvelope, peerEndpointId: string, timeoutMs: number): Promise<SecureEnvelope>;
}

export interface PeerSummary {
  bridgeId: string;
  label: string;
  endpointId: string;
  approvedAt: string;
  /** Only when probed: whether the peer answered a handshake in time. */
  online?: boolean;
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

export class PeerControl {
  /** Receiver epoch per peer bridgeId, learned by handshake; a peer restart changes it (answered `epoch_changed`, then re-learned). */
  private readonly epochs = new Map<string, string>();

  constructor(private readonly security: PeerSecurity, private readonly transport: PeerTransport) {}

  /** The other bridges of this account (ledger order). With `probe`, each is sent a handshake (in parallel) to report reachability. */
  async list(probe = false, probeTimeoutMs = 4_000): Promise<PeerSummary[]> {
    const peers = this.security.peerBridges();
    const summaries = peers.map(peer => ({ bridgeId: peer.bridgeId, label: peer.label, endpointId: peer.endpoint.id,
      approvedAt: new Date(peer.approvedAt).toISOString() } as PeerSummary));
    if (!probe) return summaries;
    const results = await Promise.all(peers.map(peer => this.hello(peer, probeTimeoutMs).then(() => true, () => false)));
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
    // No chaining: a peer's own peers are reached directly from here.
    if (path === '/api/peers' || path.startsWith('/api/peers/') || path.startsWith('/api/peers?')) throw new PeerTargetError(400, 'Cross-bridge requests cannot be chained');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new PeerTargetError(400, 'Invalid timeout');
    const peer = this.resolve(target);
    for (let attempt = 0; ; attempt++) {
      const epoch = this.epochs.get(peer.bridgeId) ?? await this.hello(peer, HELLO_TIMEOUT_MS);
      const result = await this.exchange(peer, epoch, method as PeerHttpMethod, path, body, timeoutMs);
      const answer = result.body;
      const code = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer.code : undefined;
      // The peer restarted since our handshake: it refused before dispatching anything, so one retry with a fresh epoch is safe.
      if (result.status === 403 && code === 'epoch_changed' && attempt === 0) { this.epochs.delete(peer.bridgeId); continue; }
      return result;
    }
  }

  private channel(): string {
    const channel = this.transport.peerChannel();
    if (!channel) throw new PeerTargetError(503, 'Cross-bridge control needs the relay connection (not available in --local/--solo mode)');
    return channel;
  }

  private async hello(peer: LedgerBridge, timeoutMs: number): Promise<string> {
    const channel = this.channel();
    const challenge = randomUUID();
    const messageId = randomUUID();
    const packet = await this.security.sealToPeer(peer, 'hello', { type: 'hello', challenge }, channel, messageId, null);
    const answer = await this.send(peer, packet, timeoutMs);
    const welcome = welcomeSchema(challenge).parse(await this.security.openFromPeer(peer, answer, 'welcome', channel));
    this.epochs.set(peer.bridgeId, welcome.receiverEpoch);
    return welcome.receiverEpoch;
  }

  private async exchange(peer: LedgerBridge, epoch: string, method: PeerHttpMethod, path: string, body: unknown,
    timeoutMs: number): Promise<{ status: number; body: ApplicationJson }> {
    const channel = this.channel();
    const requestId = randomUUID();
    const data: { [key: string]: ApplicationJson } = { timeoutMs };
    if (body !== undefined) data.body = applicationJson(body);
    const application = { type: 'application', route: { kind: 'http', requestId, method, path }, data, mcp: null };
    const packet = await this.security.sealToPeer(peer, 'application', application, channel, requestId, epoch);
    const answer = await this.send(peer, packet, timeoutMs + ANSWER_SLACK_MS);
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

  private async send(peer: LedgerBridge, packet: SecureEnvelope, timeoutMs: number): Promise<SecureEnvelope> {
    try { return await this.transport.peerExchange(packet, peer.endpoint.id, timeoutMs); }
    catch (error) {
      if (error instanceof BridgeSecurityError && error.code === 'bridge_offline') {
        throw new PeerTargetError(504, `Bridge ${peer.label || peer.bridgeId} did not answer (offline, or running an ftown without cross-bridge control)`);
      }
      throw error;
    }
  }
}
