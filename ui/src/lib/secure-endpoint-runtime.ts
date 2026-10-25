import { open, seal, parseSecureEnvelope, parseSecurePublication, SecurityError } from "@security/crypto";
import type { ApplicationJson, ApplicationRoute, ApprovedBridge, BridgeInvitation, BridgeSecurityState, EndpointIdentity,
  EndpointPublic, EnrollmentPacket, EnrollmentReceipt, EnvelopeHeader, EnvelopePurpose, SecureApplication, SecureEnvelope,
  SecurityCommand, SecurityCommandResults } from "@security/protocol";
import { pinApprovedBridge, validatePublicEndpoint } from "./browser-identity";

export type SecureTransmit = (packet: SecureEnvelope | EnrollmentPacket) => Promise<void>;
interface Pending<T> { resolve: (value: T) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout>; bridgeId: string; channel: string }
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export function applicationJson(value: unknown): ApplicationJson { return JSON.parse(JSON.stringify(value)) as ApplicationJson; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function decoded(bytes: Uint8Array): unknown {
  try { return JSON.parse(decoder.decode(bytes)); } catch { throw new SecurityError("invalid_envelope", "Invalid encrypted content"); }
}
function application(value: unknown): SecureApplication {
  if (!record(value) || value.type !== "application" || !record(value.route) || !["command", "http", "terminal", "response", "publication"].includes(String(value.route.kind))
    || !("data" in value) || value.mcp !== null) throw new SecurityError("invalid_envelope", "Invalid encrypted application content");
  return value as unknown as SecureApplication;
}

/** Account-scoped endpoint state; never shares mutable identity between accounts. */
export class SecureEndpointRuntime {
  readonly identity: EndpointIdentity;
  private bridges = new Map<string, ApprovedBridge>();
  private candidates = new Map<string, EndpointPublic>();
  private epochs = new Map<string, string>();
  private states = new Map<string, BridgeSecurityState>();
  private listeners = new Set<() => void>();
  private welcomes = new Map<string, Pending<string>>();
  private enrollments = new Map<string, Pending<EnrollmentReceipt>>();
  private responses = new Map<string, Pending<ApplicationJson>>();
  private seen = new Map<string, number>();
  private requestAliases = new Map<string, { requestId: string; expiresAt: number }>();
  private closed = false;

  constructor(identity: EndpointIdentity, pins: ApprovedBridge[], private accountAuthority?: (bridgeId: string) => void) {
    this.identity = identity;
    for (const pin of pins) {
      if (pin.endpoint.ownerId !== identity.endpoint.ownerId || pin.endpoint.kind !== "bridge") throw new SecurityError("wrong_context", "Bridge approval belongs to another identity");
      this.bridges.set(pin.bridgeId, pin); this.setState(pin.bridgeId, "offline", pin.endpoint);
    }
  }
  get ownerId(): string { return this.identity.endpoint.ownerId; }
  /** Caller supplies only locally verified roster pins plus independent legacy pins. */
  replacePins(pins: ApprovedBridge[]): void {
    if (this.closed) return;
    const next = new Map(pins.map(pin => [pin.bridgeId, pin]));
    for (const [id] of this.bridges) if (!next.has(id)) {
      this.bridges.delete(id); this.epochs.delete(id); this.setState(id, "revoked", null);
      for (const [key, pending] of this.responses) if (pending.bridgeId === id) this.rejectPending(this.responses, key, new SecurityError("endpoint_revoked", "Computer access changed"));
    }
    for (const pin of pins) {
      if (pin.endpoint.ownerId !== this.ownerId || pin.endpoint.kind !== "bridge") throw new SecurityError("wrong_context", "Invalid computer trust");
      const previous = this.bridges.get(pin.bridgeId);
      if (previous && previous.endpoint.id !== pin.endpoint.id) { this.epochs.delete(pin.bridgeId); this.setState(pin.bridgeId, "key_changed"); continue; }
      this.bridges.set(pin.bridgeId, pin);
      if (!previous) this.setState(pin.bridgeId, "offline", pin.endpoint);
    }
    for (const listener of this.listeners) listener();
  }
  pinnedBridges(): ApprovedBridge[] { return [...this.bridges.values()]; }
  bridge(bridgeId: string): ApprovedBridge | null { return this.bridges.get(bridgeId) ?? null; }
  state(bridgeId: string): BridgeSecurityState { return this.states.get(bridgeId) ?? { bridgeId, status: "unpaired", endpoint: null }; }
  snapshot(): BridgeSecurityState[] { return [...this.states.values()]; }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private setState(bridgeId: string, status: BridgeSecurityState["status"], endpoint: EndpointPublic | null = this.bridges.get(bridgeId)?.endpoint ?? null): void {
    this.states.set(bridgeId, { bridgeId, status, endpoint }); for (const listener of this.listeners) listener();
  }
  discover(bridgeId: string, endpoint?: EndpointPublic): void {
    const pin = this.bridges.get(bridgeId);
    if (pin && endpoint && pin.endpoint.id !== endpoint.id) { this.epochs.delete(bridgeId); this.setState(bridgeId, "key_changed"); return; }
    if (!pin) this.setState(bridgeId, "unpaired", endpoint ?? null);
  }
  disconnected(bridgeId?: string): void {
    for (const id of bridgeId ? [bridgeId] : this.bridges.keys()) {
      if (!["key_changed", "revoked"].includes(this.state(id).status)) this.setState(id, "offline");
    }
  }
  /** A queued transport must recheck immediately before its actual publication. */
  assertCanSend(bridgeId: string): void { this.usable(bridgeId); }
  private usable(bridgeId: string): EndpointPublic {
    this.accountAuthority?.(bridgeId);
    if (this.closed) throw new SecurityError("endpoint_revoked", "Encrypted connection is closed");
    const state = this.state(bridgeId);
    if (state.status === "revoked") throw new SecurityError("endpoint_revoked", "Bridge access was revoked");
    if (state.status === "key_changed") throw new SecurityError("key_changed", "Verify the changed bridge key");
    const peer = this.bridges.get(bridgeId)?.endpoint;
    if (!peer) throw new SecurityError("approval_required", "Approve this browser with a bridge invitation");
    return peer;
  }
  private header(bridgeId: string, peer: EndpointPublic, channel: string, purpose: EnvelopePurpose, epoch: string | null): EnvelopeHeader {
    const now = Date.now();
    return { type: "ftown_encrypted", version: 1, senderId: this.identity.endpoint.id, recipientId: peer.id, ownerId: this.ownerId,
      bridgeId, channel, purpose, messageId: crypto.randomUUID(), createdAt: now, expiresAt: now + 120_000, receiverEpoch: epoch };
  }
  private pending<T>(map: Map<string, Pending<T>>, key: string, bridgeId: string, channel: string, timeout = 30_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { map.delete(key); reject(new SecurityError("bridge_offline", "Encrypted bridge response timed out", true)); }, timeout);
      map.set(key, { resolve, reject, timer, bridgeId, channel });
    });
  }
  private settle<T>(map: Map<string, Pending<T>>, key: string, value: T, envelope: SecureEnvelope): void {
    const pending = map.get(key);
    if (!pending || pending.bridgeId !== envelope.bridgeId || pending.channel !== envelope.channel) return;
    clearTimeout(pending.timer); map.delete(key); pending.resolve(value);
  }
  private rejectPending<T>(map: Map<string, Pending<T>>, key: string, error: unknown): void {
    const pending = map.get(key); if (!pending) return;
    clearTimeout(pending.timer); map.delete(key); pending.reject(error);
  }
  async handshake(bridgeId: string, channel: string, transmit: SecureTransmit): Promise<void> {
    const peer = this.usable(bridgeId);
    const challenge = crypto.randomUUID();
    const waiting = this.pending(this.welcomes, challenge, bridgeId, channel);
    this.setState(bridgeId, "connecting");
    void seal(this.identity, peer, this.header(bridgeId, peer, channel, "hello", null), encoder.encode(JSON.stringify({ type: "hello", challenge })))
      .then(packet => { this.usable(bridgeId); return transmit(packet); }).catch(error => this.rejectPending(this.welcomes, challenge, error));
    try { const epoch = await waiting; this.usable(bridgeId); this.epochs.set(bridgeId, epoch); this.setState(bridgeId, "ready"); }
    catch (error) { this.disconnected(bridgeId); throw error; }
  }
  async enroll(invitation: BridgeInvitation, label: string, channel: string, transmit: SecureTransmit): Promise<ApprovedBridge> {
    if (invitation.ownerId !== this.ownerId || invitation.bridge.ownerId !== this.ownerId) throw new SecurityError("wrong_context", "Sign in to the account named by this invitation");
    await validatePublicEndpoint(invitation.bridge);
    if (Date.parse(invitation.expiresAt) <= Date.now()) throw new SecurityError("invitation_expired", "Create a fresh bridge invitation");
    this.candidates.set(invitation.bridgeId, invitation.bridge);
    const waiting = this.pending(this.enrollments, invitation.invitationId, invitation.bridgeId, channel);
    const message = { type: "enroll", candidate: this.identity.endpoint, invitationId: invitation.invitationId, invitationSecret: invitation.secret, label: label.slice(0, 80) };
    void seal(this.identity, invitation.bridge, this.header(invitation.bridgeId, invitation.bridge, channel, "enroll", null), encoder.encode(JSON.stringify(message)))
      .then(envelope => transmit({ type: "ftown_enrollment", version: 1, candidate: this.identity.endpoint, envelope }))
      .catch(error => this.rejectPending(this.enrollments, invitation.invitationId, error));
    try {
      const receipt = await waiting;
      if (receipt.approved.endpoint.id !== this.identity.endpoint.id || receipt.approved.endpoint.ownerId !== this.ownerId || !receipt.approved.permissions.includes("admin")) {
        throw new SecurityError("authentication_failed", "Bridge approval did not match this browser");
      }
      const pin: ApprovedBridge = { bridgeId: invitation.bridgeId, endpoint: invitation.bridge, permissions: receipt.approved.permissions };
      await pinApprovedBridge(this.ownerId, pin, true);
      this.bridges.set(pin.bridgeId, pin); this.epochs.set(pin.bridgeId, receipt.receiverEpoch); this.setState(pin.bridgeId, "ready");
      return pin;
    } finally { this.candidates.delete(invitation.bridgeId); }
  }
  async sealApplication(bridgeId: string, channel: string, value: SecureApplication): Promise<SecureEnvelope> {
    const peer = this.usable(bridgeId); const epoch = this.epochs.get(bridgeId);
    if (!epoch) throw new SecurityError("approval_required", "Establish an encrypted bridge handshake first");
    const header = this.header(bridgeId, peer, channel, "application", epoch);
    if (value.route.kind === "command" || value.route.kind === "http") header.messageId = value.route.requestId;
    const packet = await seal(this.identity, peer, header, encoder.encode(JSON.stringify(value)));
    if (this.closed) throw new SecurityError("endpoint_revoked", "Encrypted connection closed");
    this.usable(bridgeId);
    for (const [id, alias] of this.requestAliases) if (alias.expiresAt <= Date.now()) this.requestAliases.delete(id);
    if (value.route.kind === "command" || value.route.kind === "http") this.requestAliases.set(packet.messageId, { requestId: value.route.requestId, expiresAt: packet.expiresAt });
    return packet;
  }
  async receive(packet: unknown, channel: string): Promise<{ bridgeId: string; application: SecureApplication }[]> {
    if (this.closed) return [];
    const batch = record(packet) && packet.type === "ftown_encrypted_batch" ? parseSecurePublication(packet).envelopes : [parseSecureEnvelope(packet)];
    const delivered: { bridgeId: string; application: SecureApplication }[] = [];
    for (const envelope of batch) {
      if (envelope.recipientId !== this.identity.endpoint.id) continue;
      const sender = envelope.purpose === "enrolled" ? this.candidates.get(envelope.bridgeId) : this.bridges.get(envelope.bridgeId)?.endpoint;
      if (!sender || sender.id !== envelope.senderId) continue;
      if (envelope.purpose !== "enrolled") { try { this.accountAuthority?.(envelope.bridgeId); } catch { continue; } }
      if (envelope.purpose !== "enrolled" && (this.state(envelope.bridgeId).status === "revoked" || this.state(envelope.bridgeId).status === "key_changed")) continue;
      const value = decoded(await open(this.identity, sender, envelope, { ownerId: this.ownerId, bridgeId: envelope.bridgeId,
        recipientId: this.identity.endpoint.id, channel, purpose: envelope.purpose }));
      if (this.closed) return [];
      if (envelope.purpose !== "enrolled") { try { this.accountAuthority?.(envelope.bridgeId); } catch { continue; } }
      if (envelope.purpose !== "enrolled" && (!this.bridges.has(envelope.bridgeId) || ["revoked", "key_changed"].includes(this.state(envelope.bridgeId).status))) continue;
      if (envelope.purpose === "welcome") {
        if (!record(value) || value.type !== "welcome" || typeof value.challenge !== "string" || typeof value.receiverEpoch !== "string"
          || envelope.expiresAt < Date.now() || envelope.createdAt > Date.now() + 30_000) continue;
        this.settle(this.welcomes, value.challenge, value.receiverEpoch, envelope); continue;
      }
      if (envelope.purpose === "enrolled") {
        if (!record(value) || value.type !== "enrolled" || typeof value.invitationId !== "string" || typeof value.receiverEpoch !== "string"
          || !record(value.approved) || envelope.expiresAt < Date.now()) continue;
        this.settle(this.enrollments, value.invitationId, value as unknown as EnrollmentReceipt, envelope); continue;
      }
      if (envelope.purpose !== "application") continue;
      const now = Date.now();
      for (const [id, expiry] of this.seen) if (expiry <= now) this.seen.delete(id);
      const key = `${envelope.senderId}:${envelope.messageId}`;
      if (this.seen.has(key)) continue;
      if (this.seen.size >= 10_000) throw new SecurityError("capacity_exceeded", "Encrypted message replay window is full");
      this.seen.set(key, now + 120_000);
      const app = application(value);
      if (envelope.createdAt > now + 30_000 || (app.route.kind !== "publication" && (envelope.expiresAt <= now || envelope.expiresAt - envelope.createdAt > 120_000))) continue;
      if (app.route.kind === "response" && record(app.data) && typeof app.data.status === "number" && app.data.status >= 400
        && record(app.data.body) && app.data.body.code === "epoch_changed") {
        this.epochs.delete(envelope.bridgeId); this.disconnected(envelope.bridgeId);
      }
      if (app.route.kind === "response") {
        const alias = this.requestAliases.get(app.route.requestId);
        if (alias) { this.requestAliases.delete(app.route.requestId); app.route = { kind: "response", requestId: alias.requestId }; }
      }
      if (app.route.kind === "response") this.settle(this.responses, app.route.requestId, app.data, envelope);
      delivered.push({ bridgeId: envelope.bridgeId, application: app });
    }
    return this.closed ? [] : delivered.filter(value => {
      try { this.accountAuthority?.(value.bridgeId); return true; } catch { return false; }
    });
  }
  async request(bridgeId: string, channel: string, route: Extract<ApplicationRoute, { kind: "http" | "command" }>, data: unknown, transmit: SecureTransmit): Promise<ApplicationJson> {
    const waiting = this.pending(this.responses, route.requestId, bridgeId, channel, 40_000);
    void this.sealApplication(bridgeId, channel, { type: "application", route, data: applicationJson(data), mcp: null })
      .then(packet => { this.usable(bridgeId); return transmit(packet); }).catch(error => this.rejectPending(this.responses, route.requestId, error));
    return waiting;
  }
  async command<C extends SecurityCommand>(command: C, send: (value: unknown) => Promise<unknown>): Promise<SecurityCommandResults[C["type"]]> {
    const { type, ...payload } = command;
    const response = await send({ type, payload, requestId: crypto.randomUUID() });
    if (!record(response) || response.success !== true) throw new SecurityError(record(response) && record(response.data) && typeof response.data.code === "string" ? response.data.code as "permission_denied" : "permission_denied", "Security action was rejected");
    if (type === "security_revoke" && "endpointId" in command && command.endpointId === this.identity.endpoint.id) {
      this.epochs.delete(command.bridgeId); this.setState(command.bridgeId, "revoked");
    }
    return response.data as SecurityCommandResults[C["type"]];
  }
  dispose(): void {
    this.closed = true; this.epochs.clear(); this.seen.clear(); this.candidates.clear(); this.requestAliases.clear();
    for (const map of [this.welcomes, this.enrollments, this.responses]) for (const pending of map.values()) {
      clearTimeout(pending.timer); pending.reject(new SecurityError("endpoint_revoked", "Encrypted connection was closed"));
    }
    this.welcomes.clear(); this.enrollments.clear(); this.responses.clear(); this.listeners.clear();
  }
}
