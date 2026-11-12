import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { open, seal, parseSecureEnvelope } from '../crypto.js';
import type { ApplicationJson, ApplicationRoute, ApprovedEndpoint, BridgeInvitation, BridgeSecurity, EndpointIdentity, EnrollmentPacket,
  InboundTransportContext, InvitationOptions, LocalRecoveryAuthority,
  SecureApplication, SecureEnvelope, SecurePublication, VerifiedApplication, VerifiedPrincipal } from '../protocol.js';
import { BridgePolicyStore, type LedgerOwnStatus, type PolicyOptions } from './policy.js';
import { BridgeSecurityError } from './errors.js';
import { classifyCommand, classifyHttp, classifyTerminal, type OperationPermission } from './permissions.js';
import { endpointSchema } from './metadata.js';
import { accountIdOf, ledgerHead, ledgerHeads, parseLedger, relateHead } from '../ledger/ledger.js';
import type { LedgerHeadRelation, LedgerRelation } from '../ledger/ledger.js';
import type { Ledger, LedgerCheckpoint } from '../ledger/protocol.js';
import { verifyHeadAnnouncement, type HeadAnnouncement } from '../ledger/announce.js';
import { ledgerRemovesBridge, shortHead } from './ledger-store.js';
import type { BridgeLedgerState, BridgeLedgerStore, LedgerDivergence, LedgerSource, LedgerTip, OwnBridgeKeys } from './ledger-store.js';

const token = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const routeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), requestId: token, command: z.string().min(1).max(100), sessionId: token.nullable() }).strict(),
  z.object({ kind: z.literal('http'), requestId: token, method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']), path: z.string().max(16384) }).strict(),
  z.object({ kind: z.literal('terminal'), sessionId: z.string().max(200), frameType: z.string().max(50), pairId: token.nullable() }).strict(),
  z.object({ kind: z.literal('response'), requestId: token }).strict(), z.object({ kind: z.literal('publication') }).strict(),
]);
const object = (value: ApplicationJson): Record<string, ApplicationJson> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeSecurityError('invalid_envelope');
  return value;
};
export const applicationJson = (value: unknown): ApplicationJson => JSON.parse(JSON.stringify(value)) as ApplicationJson;
/** The policy no longer lets this endpoint receive (revoked, never approved, expired, or refused by the account ledger): its packet is
 *  dropped and the other recipients are unaffected. Any other failure is not about one recipient and must surface. */
export const recipientUnavailable = (error: unknown): boolean => error instanceof BridgeSecurityError
  && (['endpoint_revoked', 'approval_required', 'expired'].includes(error.code) || error.code.startsWith('account_'));
/** Account mode: the local ledger replica is the only source of browser authority. */
export interface BridgeLedgerOptions {
  store: BridgeLedgerStore;
  /** Must equal the service's bridgeId. */
  bridgeId: string;
  /** This bridge's auth key (raw P-256, base64url) as listed in its add_bridge. */
  authPublicKey: string;
  /** The server's copy of the ledger (GET /api/account/ledger), read by startLedger and refreshLedger. Bound it with a timeout. */
  fetchLedger: () => Promise<unknown>;
  /** Wall clock for offline grace and server contact; defaults to the policy clock. */
  now?: () => number;
  /** Monotonic clock for the in-process grace bound; defaults to performance.now(). */
  monotonic?: () => number;
}
export interface BridgeSecurityOptions extends PolicyOptions {
  relayUserId: string; browserOrigin?: string;
  /** Absent for Solo and --local: their devices come only from invitations and the local CLI. */
  ledger?: BridgeLedgerOptions;
}
/** A refused history (the store's divergence entry, server preferred), as the status shows it: heads cut to 8 characters. */
export interface LedgerDivergenceStatus {
  source: LedgerSource; otherHead: string; otherRevision: number; ourRevision: number; firstSeen: number;
  /** The revision both histories last share; null when unknown. */
  forkRevision: number | null;
  /** That history removes this computer (status only: this bridge keeps its own history and is never reset by it). */
  removedOnOtherHistory: boolean;
}
/** What this bridge holds that the server lacks (its records after the fork point, or after the server's revision when the server is
 *  behind): the removals (revoke_device / revoke_bridge) and passkeys (add_authority) among them. */
export interface UniqueHistory { afterRevision: number; records: number; removals: number; passkeys: number }
export interface LedgerStatus {
  accountId: string | null; revision: number | null; head: string | null; own: LedgerOwnStatus;
  /** Another valid history of this account was refused (CONTRACT §5); null when none is recorded. */
  divergence: LedgerDivergenceStatus | null;
  /** The last server chain this bridge evaluated was a strict prefix of its own (the bridge re-offers its chain). */
  serverBehind: boolean;
  /** A refused history (from the server or the relay) removes this computer. Status only. */
  removedOnOtherHistory: boolean;
  /** Head announcements from the ledger channel since start: verified against the trusted checkpoint ('accepted'), or refused ('dropped':
   *  bad signature, unknown or revoked member, other account, stale, or no trusted chain yet). This bridge's own echoes are not counted. */
  announcements: { accepted: number; dropped: number };
}
type OfferDecision = 'adopt' | 'keep' | 'reject';
/** An offer's decision, the candidate's relation to the stored chain (null: none, e.g. malformed) and its tip (null: unparseable). */
export interface LedgerOfferOutcome { decision: OfferDecision; relation: LedgerRelation | null; head: string | null; revision: number | null }
/** readServerLedger: the server's chain was read and offered ('read'), the server does not know the account (404), or the read failed. */
export type ServerLedgerRead =
  | { kind: 'read'; outcome: LedgerOfferOutcome }
  | { kind: 'unknown_account'; reason: string }
  | { kind: 'failed'; reason: string };
/** The stored chain as a trusted browser may read it (ledger_head / ledger_chain). */
export interface MemberLedger { ledger: Ledger; accountId: string; head: string; revision: number }
/** ledger_head: the stored tip only. */
export interface MemberHead { accountId: string; head: string; revision: number }
/** One offer per source waits behind the one in flight; a newer candidate replaces it and its callers share the newer outcome. */
interface PendingOffer { candidate: unknown; waiters: ((outcome: LedgerOfferOutcome) => void)[] }
/** onApprovalRequired: at most one emission per endpoint per spacing, and at most this many endpoints tracked at once. */
const APPROVAL_SPACING_MS = 2000;
const APPROVAL_TRACKED_LIMIT = 1024;
const REJECTED: LedgerOfferOutcome = { decision: 'reject', relation: null, head: null, revision: null };
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
const httpStatus = (error: unknown): number | null =>
  typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : null;
/** The candidate's last record ({revision, head}), or null when it is not a well-formed chain. One hash, no signature work. */
async function chainTip(candidate: unknown): Promise<LedgerTip | null> {
  try {
    const ledger = parseLedger(candidate);
    const last = ledger.transitions[ledger.transitions.length - 1];
    return { revision: ledger.transitions.length, head: last === undefined ? await accountIdOf(ledger.genesis.payload) : await ledgerHead(last.payload) };
  } catch { return null; }
}

// adoptAccount is v1 (removed from this service); the shared interface drops it in the v1 cleanup.
export class BridgeSecurityService implements Omit<BridgeSecurity, 'adoptAccount'> {
  readonly endpoint;
  readonly receiverEpoch = randomUUID();
  readonly policy: BridgePolicyStore;
  private readonly now: () => number;
  private readonly replay = new Map<string, number>();
  private readonly revoked = new Set<(endpointId: string) => void>();
  private readonly bridgeRevokedListeners = new Set<() => void>();
  private readonly bridgeRevokedNotified = new WeakSet<() => void>();
  private bridgeRevokedEmitted = false;
  private readonly verified = new WeakSet<VerifiedApplication>();
  private closed = false;
  private readonly ledgerNow: () => number;
  /** Ledger offers and their projections run one at a time, so the policy never sees an older view after a newer one. */
  private ledgerTail: Promise<unknown> = Promise.resolve();
  private status: Omit<LedgerStatus, 'announcements'> = {
    accountId: null, revision: null, head: null, own: 'unpaired', divergence: null, serverBehind: false, removedOnOtherHistory: false,
  };
  private readonly announcements = { accepted: 0, dropped: 0 };
  private readonly headListeners = new Set<() => void>();
  private readonly ledgerMonotonic: () => number;
  /** The trusted view of the last projection (null: none yet, or another account's). */
  private trustedView: LedgerCheckpoint | null = null;
  /** The state of the last projection (null: none yet, or an empty store), and the record heads of its chain (null: not computed). */
  private held: BridgeLedgerState | null = null;
  private heads: { of: string; list: string[] } | null = null;
  private readonly approvalListeners = new Set<(endpointId: string) => void>();
  private readonly approvalEmitted = new Map<string, number>();
  private readonly pendingOffers = new Map<LedgerSource, PendingOffer>();
  private serverBehind = false;
  /** The server's revision when it was last seen behind us (null: unknown). */
  private serverRevision: number | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshQueued: Promise<void> | null = null;
  constructor(readonly identity: EndpointIdentity, readonly bridgeId: string, dataDir: string, readonly options: BridgeSecurityOptions) {
    this.endpoint = identity.endpoint; this.now = options.now ?? Date.now;
    this.ledgerNow = options.ledger?.now ?? this.now;
    this.ledgerMonotonic = options.ledger?.monotonic ?? (() => performance.now());
    this.policy = new BridgePolicyStore(dataDir, bridgeId, this.endpoint, options);
    if (options.ledger) {
      if (options.ledger.bridgeId !== bridgeId) throw new BridgeSecurityError('wrong_context');
      this.policy.enableLedger(this.ledgerNow, this.ledgerMonotonic);
    }
  }
  private context(route: InboundTransportContext): void {
    if (this.closed || route.bridgeId !== this.bridgeId) throw new BridgeSecurityError('wrong_context');
    const expected = route.transport === 'local-http' ? `local-http:${this.bridgeId}`
      : route.transport === 'local-events' ? `local-events:${this.bridgeId}`
      : route.transport === 'cloud' ? route.channel
      : `direct:${route.transport}:${this.bridgeId}:${route.pairId}`;
    if (expected !== route.channel || ((route.transport === 'webrtc' || route.transport === 'loopback-ws') && !route.pairId)) {
      throw new BridgeSecurityError('wrong_context');
    }
  }
  private freshness(envelope: SecureEnvelope, executable: boolean): void {
    const now = this.now();
    if (envelope.createdAt > now + 30000 || envelope.expiresAt <= now || envelope.expiresAt - envelope.createdAt > 120000) {
      throw new BridgeSecurityError('expired');
    }
    if (executable && envelope.receiverEpoch !== this.receiverEpoch) throw new BridgeSecurityError('epoch_changed');
  }
  private claim(envelope: SecureEnvelope): void {
    const now = this.now();
    for (const [id, expires] of this.replay) if (expires <= now) this.replay.delete(id);
    const id = `${envelope.senderId}:${envelope.messageId}`;
    if (this.replay.has(id)) throw new BridgeSecurityError('replayed');
    if (this.replay.size >= 10000) throw new BridgeSecurityError('capacity_exceeded');
    this.replay.set(id, envelope.expiresAt);
  }
  private async decode(sender: ApprovedEndpoint['endpoint'], envelope: SecureEnvelope, route: InboundTransportContext): Promise<unknown> {
    this.context(route);
    const bytes = await open(this.identity, sender, envelope, { ownerId: this.endpoint.ownerId, bridgeId: this.bridgeId,
      channel: route.channel, recipientId: this.endpoint.id, purpose: envelope.purpose });
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new BridgeSecurityError('invalid_envelope'); }
  }
  private async reply(recipient: ApprovedEndpoint['endpoint'], purpose: SecureEnvelope['purpose'], data: unknown,
    route: InboundTransportContext, messageId: string = randomUUID()): Promise<SecureEnvelope> {
    return this.replyBytes(recipient, purpose, new TextEncoder().encode(JSON.stringify(data)), route, messageId);
  }
  /** One fresh encapsulation of already serialized content. */
  private async replyBytes(recipient: ApprovedEndpoint['endpoint'], purpose: SecureEnvelope['purpose'], plaintext: Uint8Array,
    route: InboundTransportContext, messageId: string): Promise<SecureEnvelope> {
    this.context(route);
    return seal(this.identity, recipient, { type: 'ftown_encrypted', version: 1, senderId: this.endpoint.id, recipientId: recipient.id,
      ownerId: this.endpoint.ownerId, bridgeId: this.bridgeId, channel: route.channel, purpose, messageId,
      createdAt: this.now(), expiresAt: this.now() + 120000, receiverEpoch: null }, plaintext);
  }
  async handleHandshake(packet: SecureEnvelope | EnrollmentPacket, route: InboundTransportContext): Promise<SecureEnvelope> {
    this.context(route);
    if (packet.type === 'ftown_enrollment') {
      const wrapper = z.object({ type: z.literal('ftown_enrollment'), version: z.literal(1), candidate: endpointSchema, envelope: z.unknown().optional() }).strict().parse(packet);
      const envelope = parseSecureEnvelope(wrapper.envelope);
      if (envelope.purpose !== 'enroll') throw new BridgeSecurityError('wrong_context');
      this.freshness(envelope, false);
      const message = z.object({ type: z.literal('enroll'), candidate: endpointSchema, invitationId: z.string().guid(),
        invitationSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/), label: z.string().max(200) }).strict().parse(await this.decode(wrapper.candidate, envelope, route));
      if (JSON.stringify(message.candidate) !== JSON.stringify(wrapper.candidate)) throw new BridgeSecurityError('wrong_context');
      const approved = await this.policy.consumeInvitation(message);
      return this.reply(approved.endpoint, 'enrolled', { type: 'enrolled', invitationId: message.invitationId, approved, receiverEpoch: this.receiverEpoch }, route, envelope.messageId);
    }
    const envelope = parseSecureEnvelope(packet);
    if (envelope.purpose !== 'hello') throw new BridgeSecurityError('wrong_context');
    this.freshness(envelope, false);
    const principal = await this.senderPrincipal(envelope.senderId);
    const hello = z.object({ type: z.literal('hello'), challenge: token }).strict().parse(await this.decode(principal.endpoint, envelope, route));
    const welcome = await this.reply(principal.endpoint, 'welcome', { type: 'welcome', challenge: hello.challenge, receiverEpoch: this.receiverEpoch }, route, envelope.messageId);
    const current = await this.policy.principal(principal.endpoint.id);
    if (current.endpoint.publicKey !== principal.endpoint.publicKey) throw new BridgeSecurityError('wrong_context');
    return welcome;
  }
  private parseApplication(value: unknown): SecureApplication {
    const parsed = z.object({ type: z.literal('application'), route: routeSchema, data: z.unknown().optional(), mcp: z.null() }).strict().parse(value);
    return { ...parsed, data: applicationJson(parsed.data) };
  }
  private requirement(application: SecureApplication, transport: InboundTransportContext): OperationPermission {
    const route = application.route;
    if ((transport.transport === 'webrtc' || transport.transport === 'loopback-ws') && route.kind !== 'terminal') {
      throw new BridgeSecurityError('wrong_context');
    }
    if (route.kind === 'command') {
      const data = object(application.data);
      if (['terminal_watch', 'terminal_unwatch', 'webrtc_offer', 'webrtc_answer', 'webrtc_ice', 'webrtc_close'].includes(route.command)) {
        if (data.type !== route.command || (data.bridgeId !== undefined && data.bridgeId !== this.bridgeId)
          || (typeof data.sessionId === 'string' ? data.sessionId : null) !== route.sessionId) throw new BridgeSecurityError('wrong_context');
        return classifyCommand(route.command, data);
      }
      const payload = object(data.payload ?? null);
      if (data.type !== route.command || data.requestId !== route.requestId || payload.bridgeId !== this.bridgeId
        || (typeof payload.sessionId === 'string' ? payload.sessionId : null) !== route.sessionId) throw new BridgeSecurityError('wrong_context');
      return classifyCommand(route.command, payload);
    }
    if (route.kind === 'http') {
      const data = object(application.data);
      if (Object.keys(data).some(key => key !== 'body' && key !== 'timeoutMs' && key !== 'callerSessionId')
        || (data.timeoutMs !== undefined && (typeof data.timeoutMs !== 'number' || !Number.isInteger(data.timeoutMs) || data.timeoutMs < 1 || data.timeoutMs > 60000))) throw new BridgeSecurityError('invalid_envelope');
      return classifyHttp(route.method, route.path);
    }
    if (route.kind === 'terminal') {
      const data = object(application.data);
      if (route.pairId !== transport.pairId || data.kind !== route.frameType
        || (typeof data.sessionId === 'string' ? data.sessionId : '') !== route.sessionId) throw new BridgeSecurityError('wrong_context');
      if (route.sessionId && !/^[A-Za-z0-9_-]+$/.test(route.sessionId)) throw new BridgeSecurityError('invalid_envelope');
      return classifyTerminal(route.frameType);
    }
    throw new BridgeSecurityError('permission_denied');
  }
  async acceptApplication(packet: SecureEnvelope, route: InboundTransportContext): Promise<VerifiedApplication> {
    const envelope = parseSecureEnvelope(packet);
    if (envelope.purpose !== 'application') throw new BridgeSecurityError('wrong_context');
    const principal = await this.senderPrincipal(envelope.senderId);
    const app = this.parseApplication(await this.decode(principal.endpoint, envelope, route));
    if (app.route.kind === 'http') {
      const data = object(app.data);
      if (data.callerSessionId !== undefined && (principal.endpoint.kind !== 'local-cli'
        || typeof data.callerSessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(data.callerSessionId))) throw new BridgeSecurityError('permission_denied');
    }
    this.freshness(envelope, true); this.claim(envelope);
    const operation = this.requirement(app, route);
    await this.policy.revalidate(principal, operation.permission);
    const message = { principal, envelope, application: app };
    this.verified.add(message); return message;
  }
  async revalidate(principal: VerifiedPrincipal): Promise<void> { await this.policy.revalidate(principal); }
  /** One non-content receipt, prepared while authorized and released only after durable self-removal. */
  async revokeSelfWithReceipt(message: VerifiedApplication, route: InboundTransportContext): Promise<SecureEnvelope | null> {
    const application = message.application;
    if (application.route.kind !== 'command' || application.route.command !== 'security_revoke') return null;
    const data = object(application.data); const payload = object(data.payload ?? null);
    if (payload.endpointId !== message.principal.endpoint.id) return null;
    if (!this.verified.has(message) || message.envelope.senderId !== message.principal.endpoint.id
      || message.envelope.channel !== route.channel || message.envelope.bridgeId !== route.bridgeId
      || message.envelope.messageId !== application.route.requestId || payload.bridgeId !== this.bridgeId) {
      throw new BridgeSecurityError('wrong_context');
    }
    await this.policy.revalidate(message.principal, 'admin');
    const receipt = await this.reply(message.principal.endpoint, 'application', { type: 'application',
      route: { kind: 'response', requestId: application.route.requestId }, mcp: null,
      data: { type: 'command_response', response: { requestId: application.route.requestId, success: true,
        data: { endpointId: message.principal.endpoint.id, revoked: true } } } }, route, application.route.requestId);
    // No sealed value leaves this method before the durable self-removal has succeeded.
    await this.revokeEndpoint(message.principal, message.principal.endpoint.id);
    this.verified.delete(message);
    return receipt;
  }
  async sealTo(recipientId: string, application: SecureApplication, route: InboundTransportContext): Promise<SecureEnvelope> {
    const principal = await this.policy.principal(recipientId);
    const envelope = await this.reply(principal.endpoint, 'application', application, route,
      application.route.kind === 'response' ? application.route.requestId : randomUUID());
    await this.policy.revalidate(principal);
    return envelope;
  }
  /**
   * Relay publications only (the route is always 'cloud'). The local CLI never connects to the relay: it reads the same publications
   * from the local events ring, sealed to it per poll by sealTo, so no relay envelope is made for it.
   * The readers and their keys come from ONE policy snapshot read, taken when this is called; each reader still gets its own fresh
   * encapsulation and message id. Nothing here re-reads the policy afterwards: the sender re-checks every packet's recipient with
   * policy.principal() right before handing it to the relay (centrifugo-client prepare()), and drops the packet of a recipient that
   * stopped being one (recipientUnavailable).
   */
  async sealPublication(channel: string, application: SecureApplication): Promise<(SecureEnvelope | SecurePublication)[]> {
    const readers = (await this.policy.readers()).filter(reader => reader.endpoint.kind !== 'local-cli');
    const route: InboundTransportContext = { transport: 'cloud', channel, bridgeId: this.bridgeId, pairId: null };
    const plaintext = new TextEncoder().encode(JSON.stringify(application));
    const packets: SecureEnvelope[] = [];
    for (const reader of readers) {
      packets.push(await this.replyBytes(reader.endpoint, 'application', plaintext, route,
        application.route.kind === 'response' ? application.route.requestId : randomUUID()));
    }
    return packets;
  }
  createInvitation(actor: VerifiedPrincipal | LocalRecoveryAuthority, options: InvitationOptions): Promise<BridgeInvitation> { return this.policy.createInvitation(actor, options); }
  listDevices(actor: VerifiedPrincipal): Promise<ApprovedEndpoint[]> { return this.policy.list(actor); }
  async revokeEndpoint(actor: VerifiedPrincipal, endpointId: string): Promise<void> {
    await this.policy.revoke(actor, endpointId);
    for (const listener of this.revoked) listener(endpointId);
  }
  /**
   * Account mode only (no-op without a ledger). Loads the replica, projects it and checks this bridge's own status; a stored chain that
   * already revokes this bridge is signed proof on its own, so it emits and nothing is fetched. Otherwise offers the server's ledger
   * once; a fetch failure is logged, not fatal, and a successful read that is not rejected counts as server contact.
   * Throws when the local replica cannot be read (corrupted, another account's, or unreadable; it is never reset) or the policy
   * cannot be written.
   */
  async startLedger(): Promise<void> {
    const ledger = this.options.ledger;
    if (!ledger) return;
    const own = await this.ledgerTask(async () => {
      if (this.closed) return null;
      const state = await ledger.store.read();
      return state === null ? this.project(null, null) : this.projectState(state);
    });
    if (own === null || own === 'revoked' || this.closed) return;
    await this.refreshLedger();
  }
  /**
   * Reads the server's ledger and offers it ('server') through readServerLedger. A result that is not 'reject' counts as server contact;
   * a fetch failure is logged, never thrown. Single in flight: calls during a read share one trailing read, so a change announced
   * mid-read is not missed. The wiring calls it on every relay (re)subscribe and on a `ledger_head` that differs from ledgerStatus().head,
   * and checks ledgerStatus().serverBehind afterwards.
   */
  refreshLedger(): Promise<void> {
    if (!this.options.ledger || this.closed) return Promise.resolve();
    if (this.refreshing) {
      this.refreshQueued ??= this.refreshing.then(() => { this.refreshQueued = null; return this.refreshLedger(); });
      return this.refreshQueued;
    }
    this.refreshing = this.refreshOnce().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  private async refreshOnce(): Promise<void> {
    const read = await this.readServerLedger();
    if (read.kind !== 'read') console.warn('[Security] Account ledger read failed:', read.reason);
  }
  /**
   * One read of the server's ledger (not coalesced), offered as 'server'; a result that is not 'reject' counts as server contact. Never
   * throws: a 404 is 'unknown_account' (the server does not know this account), any other failure 'failed'. The re-offer runs it right
   * before it posts; refreshLedger runs it for everything else.
   */
  async readServerLedger(): Promise<ServerLedgerRead> {
    const ledger = this.options.ledger;
    if (!ledger || this.closed) return { kind: 'failed', reason: 'Account ledger unavailable' };
    let fetched: unknown;
    try { fetched = await ledger.fetchLedger(); }
    catch (error) { return httpStatus(error) === 404 ? { kind: 'unknown_account', reason: reason(error) } : { kind: 'failed', reason: reason(error) }; }
    const outcome = await this.offerLedgerResult(fetched, 'server');
    if (outcome.decision !== 'reject') this.noteServerContact();
    return { kind: 'read', outcome };
  }
  /** offerLedgerResult(candidate, source).decision. */
  async offerLedger(candidate: unknown, source: LedgerSource): Promise<OfferDecision> {
    return (await this.offerLedgerResult(candidate, source)).decision;
  }
  /**
   * Offers an untrusted chain (the relay, a relay-token response, a server read or answer) to the replica, then projects the result and
   * checks this bridge's own status. Never throws: an invalid candidate, a closed service and a local storage failure all return 'reject'.
   * Per source at most one offer waits behind the one in flight; a newer one replaces it, and the replaced caller gets the newer outcome.
   * A chain equal to the stored one or a prefix of it is answered keep/same or keep/behind from record heads alone (no signature check),
   * unless a divergence is recorded for that source (the store clears it). The outcome of a 'server' chain sets serverBehind. Offers never
   * count as server contact: readServerLedger and noteServerContact decide that.
   */
  offerLedgerResult(candidate: unknown, source: LedgerSource): Promise<LedgerOfferOutcome> {
    if (!this.options.ledger || this.closed) return Promise.resolve(REJECTED);
    return new Promise(resolve => {
      const waiting = this.pendingOffers.get(source);
      if (waiting) {
        waiting.candidate = candidate;
        waiting.waiters.push(resolve);
        return;
      }
      const pending: PendingOffer = { candidate, waiters: [resolve] };
      this.pendingOffers.set(source, pending);
      void this.ledgerTask(async () => {
        if (this.pendingOffers.get(source) === pending) this.pendingOffers.delete(source);
        return this.evaluate(pending.candidate, source);
      }).catch((): LedgerOfferOutcome => REJECTED).then(outcome => { for (const waiter of pending.waiters) waiter({ ...outcome }); });
    });
  }
  private async evaluate(candidate: unknown, source: LedgerSource): Promise<LedgerOfferOutcome> {
    const ledger = this.options.ledger!;
    if (this.closed) return REJECTED;
    const tip = await chainTip(candidate);
    const heads = this.heads;
    if (tip !== null && heads !== null && this.held !== null && heads.of === this.held.checkpoint.head
      && !this.held.divergences.some(entry => entry.source === source)) {
      let known: LedgerHeadRelation = 'unknown';
      try { known = relateHead(heads.list, tip); } catch { /* not a head of ours */ }
      if (known === 'same' || known === 'behind') return this.observed(source, { decision: 'keep', relation: known, head: tip.head, revision: tip.revision });
    }
    let result;
    try { result = await ledger.store.offer(candidate, source); }
    catch (error) {
      console.error('[Security] Account ledger offer failed:', reason(error));
      return REJECTED;
    }
    const outcome: LedgerOfferOutcome = { decision: result.decision, relation: result.relation, head: result.candidate?.head ?? null, revision: result.candidate?.revision ?? null };
    if (result.decision === 'reject' || result.state === null) return { ...outcome, decision: 'reject' };
    try { await this.projectState(result.state); }
    catch (error) { console.error('[Security] Account ledger projection failed:', reason(error)); }
    return this.observed(source, outcome);
  }
  /** Records what a non-rejected 'server' chain says about the server: behind (a strict prefix of ours) or not. */
  private observed(source: LedgerSource, outcome: LedgerOfferOutcome): LedgerOfferOutcome {
    if (source === 'server' && outcome.decision !== 'reject') this.setServerBehind(outcome.relation === 'behind', outcome.revision);
    return outcome;
  }
  private setServerBehind(behind: boolean, revision: number | null): void {
    this.serverBehind = behind;
    this.serverRevision = behind ? revision : null;
    this.status = { ...this.status, serverBehind: behind };
  }
  /**
   * A relay-token answer that carried no chain: the server's head is `head` (at `revision` when the answer named one, else the head the
   * request sent). Classified against the stored chain from record heads alone: 'same', 'behind' (sets serverBehind), or 'unknown'
   * (ahead, diverged, or not a head of ours: the caller reads the server). null without a ledger, a head, or a stored chain.
   */
  noteServerHead(server: { head: string | null; revision: number | null }): LedgerHeadRelation | null {
    const heads = this.heads;
    if (!this.options.ledger || this.closed || server.head === null || heads === null) return null;
    const revision = server.revision ?? heads.list.lastIndexOf(server.head);
    let relation: LedgerHeadRelation = 'unknown';
    if (revision >= 0) {
      try { relation = relateHead(heads.list, { revision, head: server.head }); } catch { return null; }
    }
    if (relation !== 'unknown') this.setServerBehind(relation === 'behind', revision);
    return relation;
  }
  /**
   * What this bridge holds that the server does not (for the startup message when the server refuses our key): our records after the
   * fork point of a recorded server divergence, or after the server's revision when it was seen behind us; null when neither is known.
   */
  uniqueHistory(): UniqueHistory | null {
    const held = this.held;
    if (held === null) return null;
    const fork = held.divergences.find(entry => entry.source === 'server')?.forkRevision ?? null;
    const after = fork ?? (this.serverBehind ? this.serverRevision : null);
    if (after === null || after < 0 || after > held.ledger.transitions.length) return null;
    const records = held.ledger.transitions.slice(after);
    let removals = 0;
    let passkeys = 0;
    for (const record of records) {
      const type = record.payload.operation.type;
      if (type === 'revoke_device' || type === 'revoke_bridge') removals++;
      if (type === 'add_authority') passkeys++;
    }
    return { afterRevision: after, records: records.length, removals, passkeys };
  }
  /**
   * Account mode, read-only (ledger_head / ledger_chain): the stored chain, for a BROWSER that is a member of this bridge's trusted
   * checkpoint (listed with exactly this endpoint key, not revoked; policy access, offline grace and own status included). Throws
   * BridgeSecurityError('permission_denied') for anyone else, Solo, --local and the local CLI.
   */
  async memberLedger(principal: VerifiedPrincipal): Promise<MemberLedger> {
    const held = await this.memberState(principal);
    // Read-only by contract (the ledger_chain pager copies only the records it returns): no copy of the whole chain per request.
    return { ledger: held.ledger, accountId: held.checkpoint.accountId, head: held.checkpoint.head, revision: held.checkpoint.revision };
  }
  /** ledger_head: like memberLedger, but answers the tip only, without touching the chain. */
  async memberHead(principal: VerifiedPrincipal): Promise<MemberHead> {
    const held = await this.memberState(principal);
    return { accountId: held.checkpoint.accountId, head: held.checkpoint.head, revision: held.checkpoint.revision };
  }
  private async memberState(principal: VerifiedPrincipal): Promise<BridgeLedgerState> {
    if (!this.options.ledger || this.closed) throw new BridgeSecurityError('permission_denied');
    await this.policy.revalidate(principal, 'read');
    const held = this.held;
    const endpoint = principal.endpoint;
    // The trusted checkpoint (sticky applied): a browser removed on a refused history is refused here too.
    if (held === null || endpoint.kind !== 'browser' || held.trusted.accountId !== this.endpoint.ownerId
      || held.trusted.revokedDeviceIds.includes(endpoint.id)
      || !held.trusted.devices.some(device => device.endpoint.id === endpoint.id && device.endpoint.publicKey === endpoint.publicKey)) {
      throw new BridgeSecurityError('permission_denied');
    }
    return held;
  }
  /** A successful server contact (the token provider calls this after a relay-token response): re-anchors offline grace at now and
   *  persists it (the replica's lastServerReadAt and the clock high-water). An invalid time is ignored. */
  noteServerContact(now?: number): void {
    const ledger = this.options.ledger;
    if (!ledger || this.closed) return;
    const at = this.policy.noteServerRead(now ?? this.ledgerNow());
    if (at === null) return;
    const failed = (error: unknown) => console.error('[Security] Recording server contact failed:', reason(error));
    ledger.store.markServerRead(at).catch(failed);
    this.policy.persistLedgerClock().catch(failed);
  }
  ledgerStatus(): LedgerStatus {
    return { ...this.status, divergence: this.status.divergence === null ? null : { ...this.status.divergence }, announcements: { ...this.announcements } };
  }
  /**
   * A head announcement from the ledger channel (parsed, from an owner publication), judged against this bridge's TRUSTED checkpoint (sticky
   * revocations applied) and the record heads of its stored chain: its relation ('same', 'behind' or 'unknown': the caller runs a paced server
   * read) when it verifies, else null. This bridge's own announcements (kind bridge, its bridgeId) return null before any work and are not
   * counted; every other null is counted as dropped, every relation as accepted. At most one signature verification, then an O(1) compare.
   * Never throws. An announcement is never proof: nothing here changes the replica.
   */
  async judgeHeadAnnouncement(announcement: HeadAnnouncement): Promise<LedgerHeadRelation | null> {
    if (!this.options.ledger || this.closed) return null;
    let relation: LedgerHeadRelation | null = null;
    try {
      if (announcement.kind === 'bridge' && announcement.keyId === this.bridgeId) return null;
      const trusted = this.trustedView;
      if (trusted !== null && this.heads !== null && this.heads.of === trusted.head
        && await verifyHeadAnnouncement(trusted, announcement, this.ledgerNow())) {
        // The chain may have moved during the verification: compare with the heads held now.
        const heads = this.heads;
        if (heads !== null) relation = relateHead(heads.list, { revision: announcement.revision, head: announcement.head });
      }
    } catch { relation = null; }
    if (relation === null) this.announcements.dropped++;
    else this.announcements.accepted++;
    return relation;
  }
  /** Account mode: fires (synchronously, after the projection) whenever the stored head or this bridge's own status changes, e.g. after an
   *  adopt. Listener errors are logged. */
  onLedgerHead(listener: () => void): () => void {
    this.headListeners.add(listener);
    return () => { this.headListeners.delete(listener); };
  }
  private ledgerTask<T>(run: () => Promise<T>): Promise<T> {
    const next = this.ledgerTail.then(run);
    this.ledgerTail = next.catch(() => undefined);
    return next;
  }
  /** This bridge's keys, exactly as its add_bridge lists them. */
  private ownKeys(): OwnBridgeKeys {
    return { bridgeId: this.bridgeId, endpointId: this.endpoint.id, endpointPublicKey: this.endpoint.publicKey, authPublicKey: this.options.ledger?.authPublicKey ?? '' };
  }
  /**
   * This bridge in `trusted` (applyRevocations of the projected RAW chain `ledger`). 'active' = listed with exactly its keys. 'revoked' =
   * the RAW chain proves the removal of THIS bridge (ledgerRemovesBridge: it added these keys, then revoked the id), the only status that
   * resets the identity, decided exactly like the startup check (store.ownBridgeStatus). A sticky-only id, a removal seen on a refused
   * history (C1c `seen`, never merged for our own id anyway) or a tombstone of our id is 'absent': fail closed, never a reset.
   */
  private ownOf(trusted: LedgerCheckpoint | null, ledger: Ledger | null): LedgerOwnStatus {
    if (trusted === null) return 'unpaired';
    if (trusted.accountId !== this.endpoint.ownerId) return 'absent';
    const own = this.ownKeys();
    if (trusted.bridges.some(item => item.bridgeId === own.bridgeId && item.authPublicKey === own.authPublicKey && item.endpoint.id === own.endpointId
      && item.endpoint.publicKey === own.endpointPublicKey)) return 'active';
    return ledger !== null && ledgerRemovesBridge(ledger, own) ? 'revoked' : 'absent';
  }
  /** `trusted` is always the store's applyRevocations output, never its raw checkpoint. Own status acts before the policy write, so
   *  neither the revocation nor its emission waits on (or is lost to) a policy storage failure. */
  private async projectState(state: BridgeLedgerState): Promise<LedgerOwnStatus> {
    // The stored chain's record heads let an echo of it (or of a prefix) be answered without verification.
    if (this.heads === null || this.heads.of !== state.checkpoint.head) {
      try { this.heads = { of: state.checkpoint.head, list: await ledgerHeads(state.ledger) }; } catch { this.heads = null; }
    }
    this.held = state;
    return this.project(state.trusted, state.lastServerReadAt, state.divergences, state.ledger);
  }
  private async project(trusted: LedgerCheckpoint | null, lastServerReadAt: number | null, divergences: readonly LedgerDivergence[] = [],
    ledger: Ledger | null = null): Promise<LedgerOwnStatus> {
    const own = this.ownOf(trusted, ledger);
    this.trustedView = trusted !== null && trusted.accountId === this.endpoint.ownerId ? trusted : null;
    if (trusted === null) { this.held = null; this.heads = null; }
    const projection = this.policy.projectLedger({ trusted, own, lastServerReadAt });
    const previous = this.status.own;
    const previousHead = this.status.head;
    // Server first: a server holding another history matters more than a relay publisher that does.
    const shown = divergences.find(entry => entry.source === 'server') ?? divergences[0];
    const divergence = shown === undefined || trusted === null ? null : {
      source: shown.source, otherHead: shortHead(shown.otherHead), otherRevision: shown.otherRevision, ourRevision: trusted.revision, firstSeen: shown.firstSeen,
      forkRevision: shown.forkRevision, removedOnOtherHistory: shown.removedOnOtherHistory,
    };
    this.status = {
      accountId: trusted?.accountId ?? null, revision: trusted?.revision ?? null, head: trusted?.head ?? null, own, divergence, serverBehind: this.serverBehind,
      removedOnOtherHistory: trusted !== null && divergences.some(entry => entry.removedOnOtherHistory),
    };
    if (own === 'revoked') this.emitBridgeRevoked();
    // Not listed is not a signed revocation: fail closed and say so, but never reset the identity on it.
    else if (own === 'absent' && previous !== 'absent') console.warn('[Security] This bridge is not in its account ledger; account devices are refused.');
    if (own !== previous || this.status.head !== previousHead) this.emitLedgerHead();
    this.emitRevoked(await projection);
    return own;
  }
  private emitLedgerHead(): void {
    for (const listener of Array.from(this.headListeners)) {
      try { listener(); } catch (error) { console.error('[Security] ledgerHead listener failed:', error); }
    }
  }
  private emitRevoked(endpointIds: string[]): void {
    for (const id of endpointIds) for (const listener of this.revoked) listener(id);
  }
  private emitBridgeRevoked(): void {
    if (this.bridgeRevokedEmitted) return;
    this.bridgeRevokedEmitted = true;
    for (const listener of Array.from(this.bridgeRevokedListeners)) this.notifyBridgeRevoked(listener);
  }
  private notifyBridgeRevoked(listener: () => void): void {
    if (this.bridgeRevokedNotified.has(listener)) return;
    this.bridgeRevokedNotified.add(listener);
    const failed = (error: unknown) => console.error('[Security] bridgeRevoked listener failed:', error);
    try {
      const result: unknown = listener();
      if (result instanceof Promise) result.catch(failed);
    } catch (error) { failed(error); }
  }
  onRevoked(listener: (endpointId: string) => void): () => void { this.revoked.add(listener); return () => this.revoked.delete(listener); }
  /**
   * Account mode only: fires when a request (hello or application) is refused with approval_required for an endpoint the trusted
   * ledger does not know, e.g. a browser whose add_device this replica has not seen yet (the wiring refreshes the ledger). Never for
   * a revoked endpoint, never in Solo/local, never for the provisioned local CLI. At most once per endpoint per 2 s; listener errors
   * are logged; the refusal itself is unchanged.
   */
  onApprovalRequired(listener: (endpointId: string) => void): () => void {
    this.approvalListeners.add(listener);
    return () => { this.approvalListeners.delete(listener); };
  }
  private async senderPrincipal(endpointId: string): Promise<VerifiedPrincipal> {
    try { return await this.policy.principal(endpointId); }
    catch (error) {
      if (error instanceof BridgeSecurityError && error.code === 'approval_required') this.noteApprovalRequired(endpointId);
      throw error;
    }
  }
  private noteApprovalRequired(endpointId: string): void {
    if (!this.options.ledger || this.closed || this.approvalListeners.size === 0) return;
    const trusted = this.trustedView;
    if (trusted !== null && (trusted.revokedDeviceIds.includes(endpointId) || trusted.devices.some(item => item.endpoint.id === endpointId))) return;
    const at = this.ledgerMonotonic();
    for (const [id, emittedAt] of this.approvalEmitted) {
      if (!(at - emittedAt < APPROVAL_SPACING_MS && at >= emittedAt)) this.approvalEmitted.delete(id);
    }
    if (this.approvalEmitted.has(endpointId) || this.approvalEmitted.size >= APPROVAL_TRACKED_LIMIT) return;
    this.approvalEmitted.set(endpointId, at);
    const failed = (error: unknown) => console.error('[Security] approvalRequired listener failed:', error);
    for (const listener of Array.from(this.approvalListeners)) {
      try {
        const result: unknown = listener(endpointId);
        if (result instanceof Promise) result.catch(failed);
      } catch (error) { failed(error); }
    }
  }
  /** Fires at most once per instance, only on signed proof that this bridge was revoked. */
  onBridgeRevoked(listener: () => void): () => void {
    this.bridgeRevokedListeners.add(listener);
    // Startup may emit before the caller subscribes; a late listener still hears it, asynchronously.
    if (this.bridgeRevokedEmitted) queueMicrotask(() => { if (this.bridgeRevokedListeners.has(listener)) this.notifyBridgeRevoked(listener); });
    return () => { this.bridgeRevokedListeners.delete(listener); };
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.ledgerTail.catch(() => undefined);
    this.revoked.clear(); this.bridgeRevokedListeners.clear(); this.approvalListeners.clear(); this.approvalEmitted.clear(); this.replay.clear();
    this.headListeners.clear();
    await this.policy.close();
  }
}
